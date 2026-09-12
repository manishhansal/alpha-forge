/**
 * data-v7-gaps.ts — Data Foundation V7 §7/§8.
 *
 * Two operations, both REAL (no fabrication, verify-before-resolve):
 *
 *   recover  → recover PENDING/RECOVERING DataGap rows via a capability-aware
 *              GapFetcher (indices→Upstox, equities→Angel→Upstox), validate,
 *              persist with provenance, and resolve ONLY when the DB actually
 *              holds the bars afterward. Gaps a provider genuinely cannot supply
 *              stay UNRESOLVED (never deleted, never faked).
 *
 *   detect   → re-run NSE-calendar-aware gap detection for the now-populated
 *              intraday universe and persist newly-found gaps as PENDING.
 *
 * Usage:
 *   tsx … scripts/data-v7-gaps.ts recover [--limit=200]
 *   tsx … scripts/data-v7-gaps.ts detect  [--intervals=5m,15m] [--symbols=…]
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import type { Interval, OHLCVCandle, ProviderId } from "../src/lib/market-data/types";

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
const safe = (m: string) => m.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 200);
function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  return hit ? hit.slice(pfx.length) : undefined;
}

async function loadCreds() {
  const { loadWorkerCredentialsFromDb } = await import(
    "../src/lib/market-data/worker-credentials"
  );
  return loadWorkerCredentialsFromDb({ prisma });
}

/**
 * A capability-aware GapFetcher backed by the real providers. Converts the
 * gap's [fromSec,toSec] UTC window into provider requests and honours
 * index-never-Angel routing.
 */
async function makeGapFetcher() {
  const { angel } = await import("../src/services/india/angelone");
  const { UpstoxProvider } = await import("../src/lib/market-data/providers/upstox");
  const { isIndexSymbol } = await import(
    "../src/lib/market-data/provider-capability-matrix"
  );
  const upstox = new UpstoxProvider();

  const { SESSION_OPEN_MINUTES, IST_OFFSET_MS } = await import(
    "../src/lib/india/nse-trading-calendar"
  );

  /**
   * Canonical NSE session-open epoch (UTC sec) for the IST date a candle
   * belongs to. Daily gap detection anchors expected daily bars at 09:15 IST;
   * providers return daily candles at their own anchor (often 00:00). To let a
   * recovered daily candle land inside the gap window and match the canonical
   * (instrument,exchange,sessionDate) identity, re-anchor daily candle `time`
   * to the SAME session-open epoch the detector uses. This is a timestamp
   * NORMALIZATION (same trading day, canonical anchor) — NOT a value change:
   * OHLCV is untouched.
   */
  function canonicalDailyTime(timeSec: number): number {
    // Providers use different daily anchors. Upstox stamps a daily bar at
    // 18:30 UTC (= 00:00 IST) of the session day, which after +IST lands on the
    // NEXT IST calendar date; Angel/Yahoo/scrapling use ~00:00 IST of the
    // session day. To recover the TRUE session date robustly, nudge the epoch
    // back by 6 hours before taking the IST calendar date — this pulls a
    // midnight/late-evening anchor firmly inside the intended session day
    // without affecting a mid-session (09:15–15:30) timestamp.
    const ist = new Date(timeSec * 1000 - 6 * 3600 * 1000 + IST_OFFSET_MS);
    const istMidnightUtcSec =
      Math.floor(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) / 1000) -
      Math.floor(IST_OFFSET_MS / 1000);
    return istMidnightUtcSec + SESSION_OPEN_MINUTES * 60;
  }

  return async (args: {
    instrumentId: string;
    exchange: string;
    interval: Interval;
    fromSec: number;
    toSec: number;
    provider: ProviderId;
  }): Promise<{
    candles: OHLCVCandle[];
    outcome: "SUCCESS" | "EMPTY" | "UNAVAILABLE";
    httpStatus: number | null;
    errorClass?: string | null;
  }> => {
    // Never send an index to Angel.
    const provider: ProviderId =
      isIndexSymbol(args.instrumentId) && args.provider === "angel_one"
        ? "upstox"
        : args.provider;

    // Pad the window by one interval on each side so boundary bars are included.
    const fromIso = new Date((args.fromSec - 86_400) * 1000).toISOString();
    const toIso = new Date((args.toSec + 86_400) * 1000).toISOString();
    try {
      let candles: OHLCVCandle[];
      if (provider === "angel_one") {
        const days = Math.max(
          1,
          Math.ceil((args.toSec - args.fromSec) / 86_400) + 2,
        );
        candles = (await angel.getHistorical(
          { symbol: args.instrumentId, interval: args.interval, range: `${days}d` } as never,
          { allowFallback: false },
        )) as OHLCVCandle[];
      } else {
        candles = (await upstox.getHistoricalCandlesV3({
          symbol: args.instrumentId,
          exchange: "NSE",
          interval: args.interval as never,
          from: fromIso,
          to: toIso,
        } as never)) as OHLCVCandle[];
      }
      // Re-anchor DAILY candles to the canonical session-open epoch so they
      // match the gap window + the (instrument,exchange,sessionDate) identity.
      const normalized =
        args.interval === "1d"
          ? candles.map((c) => ({ ...c, time: canonicalDailyTime(c.time) }))
          : candles;
      return {
        candles: normalized,
        outcome: normalized.length > 0 ? "SUCCESS" : "EMPTY",
        httpStatus: 200,
      };
    } catch (e) {
      return { candles: [], outcome: "UNAVAILABLE", httpStatus: null, errorClass: safe((e as Error).message) };
    }
  };
}

async function recover() {
  const out: Record<string, unknown> = { command: "gaps:recover", at: new Date().toISOString() };
  const cred = await loadCreds();
  out.creds = { angel: cred.angel, upstox: cred.upstox };

  const before = await prisma.dataGap.groupBy({ by: ["recoveryStatus"], _count: { _all: true } });
  out.before = Object.fromEntries(before.map((b) => [b.recoveryStatus, b._count._all]));

  const fetcher = await makeGapFetcher();
  const { recoverPendingGaps } = await import(
    "../src/lib/market-data/services/gap-recovery.service"
  );
  const limit = Number(arg("limit") ?? "200");
  const results = await recoverPendingGaps(fetcher as never, { limit, prisma: prisma as never });

  const summary = { RECOVERED: 0, PARTIALLY_RECOVERED: 0, UNRESOLVED: 0, INVALID_DATA: 0 } as Record<string, number>;
  let barsRecovered = 0;
  for (const r of results) {
    summary[r.status] = (summary[r.status] ?? 0) + 1;
    barsRecovered += r.barsRecovered;
  }
  out.attempted = results.length;
  out.resultSummary = summary;
  out.barsRecovered = barsRecovered;

  const after = await prisma.dataGap.groupBy({ by: ["recoveryStatus"], _count: { _all: true } });
  out.after = Object.fromEntries(after.map((b) => [b.recoveryStatus, b._count._all]));
  console.log(JSON.stringify(out, null, 2));
}

async function detect() {
  const out: Record<string, unknown> = { command: "gaps:detect", at: new Date().toISOString() };
  await loadCreds();
  const intervals = (arg("intervals") ?? "5m,15m,30m,1h").split(",").map((s) => s.trim()) as Interval[];

  // Universe = the intraday instruments we actually populated.
  let symbols: string[];
  const explicit = arg("symbols");
  if (explicit) symbols = explicit.split(",").map((s) => s.trim());
  else {
    const rows = await prisma.candleBar.findMany({
      where: { intervalStr: { in: intervals } },
      select: { instrumentId: true },
      distinct: ["instrumentId"],
    });
    symbols = rows.map((r) => r.instrumentId);
  }
  out.symbolCount = symbols.length;
  out.intervals = intervals;

  const { detectAndPersistGaps } = await import(
    "../src/lib/market-data/services/gap-detection.service"
  );
  const { requiredSessionsForTimeframe } = await import(
    "../src/lib/market-data/services/feature-lookback.service"
  );

  const IST = 5.5 * 3600 * 1000;
  const toIst = new Date(Date.now() + IST);
  const toIstDate = toIst.toISOString().slice(0, 10);

  let totalWritten = 0;
  const perInterval: Record<string, { detected: number; written: number }> = {};
  for (const interval of intervals) {
    const days = Math.max(10, requiredSessionsForTimeframe(interval) * 2);
    const fromIst = new Date(Date.now() + IST - days * 86_400_000);
    const fromIstDate = fromIst.toISOString().slice(0, 10);
    let detected = 0;
    let written = 0;
    for (const symbol of symbols) {
      try {
        const { result, written: w } = await detectAndPersistGaps({
          instrumentId: symbol,
          exchange: "NSE",
          interval,
          fromIstDate,
          toIstDate,
          prisma: prisma as never,
        });
        detected += result.gaps.length;
        written += w;
      } catch (e) {
        void e; // detection errors are non-fatal per symbol
      }
    }
    perInterval[interval] = { detected, written };
    totalWritten += written;
  }
  out.perInterval = perInterval;
  out.totalWritten = totalWritten;
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "recover") await recover();
    else if (cmd === "detect") await detect();
    else console.log(JSON.stringify({ error: "unknown", usage: "recover | detect" }));
  } finally {
    await prisma.$disconnect();
  }
  process.exit(0);
}
const t = setTimeout(() => { console.error("GAPS_TIMEOUT"); process.exit(2); }, 25 * 60_000);
t.unref?.();
main().catch((e) => { console.error("GAPS_FAILED", safe((e as Error).message)); process.exit(1); });
