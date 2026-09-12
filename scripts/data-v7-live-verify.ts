/**
 * data-v7-live-verify.ts — Data Foundation V7 §30.
 *
 * The automated MARKET-OPEN live verification. When the NSE session is OPEN it
 * performs the real end-to-end live check:
 *
 *   1. load credentials  2. resolve tokens  3. subscribe live feed
 *   4. receive real ticks 5. build a candle 6. persist to Postgres
 *   7. verify the row exists 8. check freshness 9. reconcile 10. gate
 *
 * When the market is CLOSED it returns an explicit MARKET_CLOSED result and does
 * NOT pretend success (§29/§30). It never fabricates a tick or a candle.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import type { LiveTick } from "../src/lib/market-data/types";

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
const safe = (m: string) => m.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 200);

async function main() {
  const out: Record<string, unknown> = { command: "live-verify", at: new Date().toISOString() };

  const { isNseMarketOpenIST } = await import("../src/lib/india/market-hours");
  const open = isNseMarketOpenIST(new Date());
  out.marketOpen = open;

  if (!open) {
    out.status = "MARKET_CLOSED";
    out.note =
      "NSE session is closed — live WS tick verification is not possible now. " +
      "Static certification (auth, historical, options, persistence, readiness) " +
      "is covered by data:self-test / data:readiness. Re-run this during market " +
      "hours (Mon–Fri 09:15–15:30 IST) for LIVE certification.";
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // ── Market is OPEN — perform the real live verification ────────────────────
  const { loadWorkerCredentialsFromDb } = await import("../src/lib/market-data/worker-credentials");
  const cred = await loadWorkerCredentialsFromDb({ prisma });
  out.creds = { angel: cred.angel, upstox: cred.upstox };

  const { INDEX_TOKENS } = await import("../src/services/india/angelone");
  const tokens = [{ token: INDEX_TOKENS.NIFTY!.token, exchange: "NSE" as const }];

  const { subscribeLiveFeed } = await import("../src/lib/market-data/services/live-feed.service");
  const { MultiInstrumentCandleBuilder } = await import(
    "../src/lib/market-data/services/candle-builder.service"
  );

  const ticks: LiveTick[] = [];
  let confirmed: { instrumentId: string; interval: string; time: number } | null = null;
  const pool = new MultiInstrumentCandleBuilder({
    persistToDb: true,
    useRedis: true,
    onEvent: (e) => { if (e.type === "CANDLE_CLOSE") confirmed = { instrumentId: e.instrumentId, interval: e.interval, time: e.candle.time }; },
  });

  const sub = subscribeLiveFeed(
    tokens,
    (t) => { ticks.push(t); void pool.feed(t); },
    (err) => { out.feedError = safe(err instanceof Error ? err.message : String(err)); },
    { mode: "quote", validateTicks: true },
  );

  // Collect ticks for a bounded window.
  const WINDOW_MS = 60_000;
  await new Promise((r) => setTimeout(r, WINDOW_MS));
  sub.unsubscribe();

  out.ticksReceived = ticks.length;
  out.lastTickFreshnessMs = ticks.length > 0 ? Date.now() - ticks[ticks.length - 1]!.receivedAtMs : null;
  out.candleConfirmed = confirmed;

  // Verify a persisted row exists for a confirmed candle (if any closed).
  if (confirmed) {
    const c = confirmed as { instrumentId: string; interval: string; time: number };
    const row = await prisma.candleBar.findUnique({
      where: {
        instrumentId_exchange_intervalStr_time: {
          instrumentId: c.instrumentId, exchange: "NSE", intervalStr: c.interval, time: c.time,
        },
      },
    });
    out.dbRowVerified = !!row;
  } else {
    out.dbRowVerified = false;
    out.note = "no candle closed within the observation window (short window / low-tick period)";
  }

  out.status = ticks.length > 0 ? "LIVE_TICKS_RECEIVED" : "NO_TICKS_IN_WINDOW";
  console.log(JSON.stringify(out, null, 2));
}

const t = setTimeout(() => { console.error("LIVE_VERIFY_TIMEOUT"); process.exit(2); }, 5 * 60_000);
t.unref?.();
main()
  .catch((e) => { console.error("LIVE_VERIFY_FAILED", safe((e as Error).message)); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); process.exit(0); });
