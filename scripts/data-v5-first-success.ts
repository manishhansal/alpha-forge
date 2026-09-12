/**
 * data-v5-first-success.ts — §36 FIRST SUCCESS CRITERION (the make-or-break test).
 *
 * 1. Loads broker credentials into the process override (worker-style, no session).
 * 2. Performs a REAL Angel One authenticated request:
 *    - resolveAngelWsSession() does a real SmartAPI login (TOTP→JWT) and surfaces
 *      the true error if auth fails (honest AUTH evidence, §7).
 *    - angel.getHistorical(RELIANCE, 5m, strict) fetches REAL candles.
 * 3. Persists the candles to CandleBar with provenance.
 * 4. Re-queries Postgres and reports provider-count vs DB-count.
 *
 * NEVER logs secrets. If auth genuinely fails, reports AUTH_FAILED honestly with
 * HTTP/code/safe-message — does NOT fabricate candles.
 *
 * Run: npx tsx --conditions=react-server --env-file=.env.local scripts/data-v5-first-success.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

function safeErr(msg: string): string {
  // Redact anything that looks like a token/JWT/long secret.
  return msg.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 300);
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const out: Record<string, unknown> = { queriedAt: new Date().toISOString() };

  // 1. Load worker credentials.
  const { loadWorkerCredentialsFromDb, workerCredentialStatus } = await import(
    "../src/lib/market-data/worker-credentials"
  );
  const loaded = await loadWorkerCredentialsFromDb({ prisma });
  out.credentialLoad = { ...loaded, userId: loaded.userId ? loaded.userId.slice(0, 6) + "…" : null };
  out.workerCredentialStatus = workerCredentialStatus();

  // 2a. Real Angel authentication (honest — surfaces the true error).
  const { resolveAngelWsSession, angel } = await import("../src/services/india/angelone");
  const authResult: Record<string, unknown> = {};
  try {
    const ws = await resolveAngelWsSession();
    authResult.angelAuthenticated = !!ws?.jwt;
    authResult.hasFeedToken = !!ws?.feedToken;
  } catch (e) {
    authResult.angelAuthenticated = false;
    authResult.error = safeErr((e as Error).message);
  }
  out.angelAuth = authResult;

  // 2b. Real historical candle fetch (strict — no Yahoo fallback, so a non-empty
  //     result is genuinely Angel data).
  const fetchResult: Record<string, unknown> = {};
  let candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }> = [];
  try {
    candles = await angel.getHistorical(
      { symbol: "RELIANCE", interval: "5m", range: "5d" } as never,
      { allowFallback: false },
    );
    fetchResult.provider = "angel_one";
    fetchResult.candleCount = candles.length;
    if (candles.length > 0) {
      fetchResult.first = { time: candles[0]!.time, iso: new Date(candles[0]!.time * 1000).toISOString(), o: candles[0]!.open, c: candles[0]!.close };
      fetchResult.last = { time: candles[candles.length - 1]!.time, iso: new Date(candles[candles.length - 1]!.time * 1000).toISOString() };
    }
  } catch (e) {
    fetchResult.error = safeErr((e as Error).message);
  }
  out.angelHistorical_RELIANCE_5m = fetchResult;

  // 3. Persist (with provenance) if we got real candles.
  if (candles.length > 0) {
    const { persistCandles } = await import("../src/lib/market-data/services/candle-persist.service");
    const { datasetVersion } = await import("../src/lib/market-data/dataset-version");
    const dv = datasetVersion(new Date().toISOString().slice(0, 10), { kind: "provider", provider: "angel_one" });
    const pr = await persistCandles(candles as never, "RELIANCE", "NSE", "5m", {
      provider: "angel_one", datasetVersion: dv, recordIncidentOnFailure: true, strictOhlc: true, prisma: prisma as never,
    });
    out.persist = { upserted: pr.upserted, errors: pr.errors };

    // 4. Re-query DB.
    const dbCount = await prisma.candleBar.count({ where: { instrumentId: "RELIANCE", exchange: "NSE", intervalStr: "5m" } });
    out.dbVerification = { provider_count: candles.length, db_count_5m_RELIANCE: dbCount, match: dbCount >= pr.upserted && pr.upserted > 0 };
  } else {
    out.persist = { skipped: "no candles returned — nothing persisted (no fabrication)" };
  }

  // Overall verdict.
  const authed = out.angelAuth && (out.angelAuth as Record<string, unknown>).angelAuthenticated === true;
  const gotData = candles.length > 0;
  out.FIRST_SUCCESS = authed && gotData ? "PASS" : authed ? "AUTH_OK_BUT_NO_DATA" : "AUTH_FAILED_OR_UNAVAILABLE";

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0); // force exit — provider clients may leave keep-alive sockets open
}
// Hard overall timeout so a hanging provider call cannot block indefinitely.
const overallTimeout = setTimeout(() => {
  console.error("FIRST_SUCCESS_TIMEOUT after 90s — a provider call likely hung (scrip-master download or SmartAPI gateway).");
  process.exit(2);
}, 90_000);
overallTimeout.unref?.();

main()
  .then(() => clearTimeout(overallTimeout))
  .catch((e) => { console.error("FIRST_SUCCESS_FAILED", safeErr((e as Error).message)); process.exit(1); });
