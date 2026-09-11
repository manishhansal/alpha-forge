/**
 * data-v5-upstox-test.ts — REAL Upstox auth + V2-vs-V3 historical audit (§4/§8/§11).
 * Loads worker Upstox token, then makes REAL requests to compare:
 *   - V2 /v2/historical-candle/{key}/{1minute|30minute|day}/{to}/{from}
 *   - V3 /v3/historical-candle/{key}/{minutes}/{5}/{to}/{from}   (per-minute)
 *   - V3 intraday /v3/historical-candle/intraday/{key}/{minutes}/{5}
 * for RELIANCE (equity) and NIFTY (index). Reports HTTP + candle counts.
 * No persist. No secrets logged.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
function safe(m: string) { return m.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 200); }

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const { loadWorkerCredentialsFromDb, getWorkerUpstoxToken } = await import("../src/lib/market-data/worker-credentials");
  await loadWorkerCredentialsFromDb({ prisma });
  const token = getWorkerUpstoxToken();
  const out: Record<string, unknown> = { tokenLoaded: !!token };
  if (!token) { console.log(JSON.stringify(out, null, 2)); await prisma.$disconnect(); process.exit(0); }

  const BASE = "https://api.upstox.com";
  const RELIANCE = "NSE_EQ|INE002A01018"; // RELIANCE ISIN key
  const NIFTY = "NSE_INDEX|Nifty 50";
  const to = "2026-09-11", from = "2026-09-08";

  async function probe(label: string, path: string) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Api-Version": "2.0" },
        signal: AbortSignal.timeout(15000),
      });
      const status = res.status;
      let count: number | string = "-";
      let err: string | undefined;
      try {
        const j = (await res.json()) as { status?: string; data?: { candles?: unknown[] }; errors?: unknown };
        count = j?.data?.candles?.length ?? 0;
        if (j?.status !== "success") err = safe(JSON.stringify(j?.errors ?? j?.status ?? "?"));
      } catch { /* non-json */ }
      out[label] = { http: status, candles: count, ...(err ? { err } : {}) };
    } catch (e) { out[label] = { error: safe((e as Error).message) }; }
  }

  // V2 (current impl) — equity, minute + day.
  await probe("v2_RELIANCE_1minute", `/v2/historical-candle/${encodeURIComponent(RELIANCE)}/1minute/${to}/${from}`);
  await probe("v2_RELIANCE_day", `/v2/historical-candle/${encodeURIComponent(RELIANCE)}/day/${to}/${from}`);
  // V3 per-minute — equity 5m + 1m, and index 5m.
  await probe("v3_RELIANCE_5min", `/v3/historical-candle/${encodeURIComponent(RELIANCE)}/minutes/5/${to}/${from}`);
  await probe("v3_RELIANCE_1min", `/v3/historical-candle/${encodeURIComponent(RELIANCE)}/minutes/1/${to}/${from}`);
  await probe("v3_NIFTY_5min", `/v3/historical-candle/${encodeURIComponent(NIFTY)}/minutes/5/${to}/${from}`);
  await probe("v3_NIFTY_day", `/v3/historical-candle/${encodeURIComponent(NIFTY)}/days/1/${to}/${from}`);

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(safe((e as Error).message)); process.exit(1); });
