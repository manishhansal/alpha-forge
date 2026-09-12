/**
 * data-v5-gap-recovery.ts — §40/§41 REAL gap recovery via a credentialed provider.
 * Wires a REAL Angel/Upstox fetcher into the V3 gap-recovery service
 * (verify-before-resolve; DataCorrection on material diff; never resolve on 200
 * alone). Bounded batch by default. No fabrication.
 *
 * Usage: npx tsx --conditions=react-server --env-file=.env.local scripts/data-v5-gap-recovery.ts --limit=5
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
function safe(m: string) { return m.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 200); }
function arg(n: string) { const p = `--${n}=`; const h = process.argv.find(a => a.startsWith(p)); return h ? h.slice(p.length) : undefined; }

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const limit = Number(arg("limit") ?? 5);
  const { loadWorkerCredentialsFromDb } = await import("../src/lib/market-data/worker-credentials");
  await loadWorkerCredentialsFromDb({ prisma });

  const { angel } = await import("../src/services/india/angelone");
  const { UpstoxProvider } = await import("../src/lib/market-data/providers/upstox");
  const upstox = new UpstoxProvider();
  const { recoverPendingGaps } = await import("../src/lib/market-data/services/gap-recovery.service");

  const INDICES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]);

  // Real fetcher: route indices→Upstox V3, equities→Angel (falling back).
  const fetcher = async (a: { instrumentId: string; exchange: string; interval: string; fromSec: number; toSec: number }) => {
    const fromIso = new Date(a.fromSec * 1000).toISOString();
    const toIso = new Date((a.toSec + 86_400) * 1000).toISOString();
    try {
      let candles;
      if (INDICES.has(a.instrumentId.toUpperCase())) {
        candles = await upstox.getHistoricalCandlesV3({ symbol: a.instrumentId, exchange: "NSE", interval: a.interval, from: fromIso, to: toIso } as never);
      } else {
        candles = await angel.getHistorical({ symbol: a.instrumentId, interval: a.interval, range: "1mo" } as never, { allowFallback: false });
      }
      return { candles: candles as never[], outcome: (candles.length > 0 ? "SUCCESS" : "EMPTY") as never, httpStatus: 200 };
    } catch (e) {
      return { candles: [] as never[], outcome: "UNAVAILABLE" as never, errorClass: safe((e as Error).message) };
    }
  };

  const results = await recoverPendingGaps(fetcher as never, { limit, prisma: prisma as never });
  const summary = { attempted: results.length, recovered: results.filter(r => r.status === "RECOVERED").length, unresolved: results.filter(r => r.status === "UNRESOLVED").length, corrections: results.reduce((s, r) => s + r.corrections, 0) };
  const gapTotal = await prisma.dataGap.count();
  const byStatus = await prisma.dataGap.groupBy({ by: ["recoveryStatus"], _count: { _all: true } });
  console.log(JSON.stringify({ summary, sample: results.slice(0, 5), dataGapTotal: gapTotal, byStatus: byStatus.map(g => ({ status: g.recoveryStatus, count: g._count._all })) }, null, 2));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch(e => { console.error(safe((e as Error).message)); process.exit(1); });
