/**
 * data-v4-option-coverage.ts — read-only F&O coverage measurement (§24-29).
 *
 * Measures what option data actually exists: index-option snapshot cadence +
 * whether the `analytics` JSON blob carries strike-level OI/IV/bid/ask (so we
 * can report real completeness), and confirms stock-option snapshots = 0.
 * Also inventories the F&O stock universe from the instrument-master if present.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const out: Record<string, unknown> = { queriedAt: new Date().toISOString() };

  const byUnderlying = await prisma.optionChainSnapshot.groupBy({
    by: ["underlying"], _count: { _all: true }, _min: { capturedAt: true }, _max: { capturedAt: true },
  });
  out.indexOptions = byUnderlying.map((g) => ({ underlying: g.underlying, snapshots: g._count._all, first: g._min.capturedAt?.toISOString(), last: g._max.capturedAt?.toISOString() }));

  // Inspect a recent snapshot's analytics blob to see if strike-level data exists.
  const sample = await prisma.optionChainSnapshot.findFirst({
    where: { underlying: "NIFTY" }, orderBy: { capturedAt: "desc" },
    select: { underlying: true, expiry: true, spot: true, atmIv: true, pcrOi: true, totalCeOi: true, totalPeOi: true, analytics: true },
  });
  let strikeLevel: unknown = null;
  if (sample) {
    const a = sample.analytics as Record<string, unknown> | null;
    const keys = a ? Object.keys(a) : [];
    // Look for arrays that resemble per-strike rows.
    const arrayKeys = a ? keys.filter((k) => Array.isArray((a as Record<string, unknown>)[k])) : [];
    const strikeArray = arrayKeys.map((k) => {
      const arr = (a as Record<string, unknown>)[k] as unknown[];
      const first = arr[0] as Record<string, unknown> | undefined;
      return { key: k, length: arr.length, sampleFields: first ? Object.keys(first) : [] };
    });
    strikeLevel = {
      topLevelKeys: keys,
      arrayCandidatesForStrikes: strikeArray,
      hasAggregate: { atmIv: sample.atmIv, pcrOi: sample.pcrOi, totalCeOi: sample.totalCeOi, totalPeOi: sample.totalPeOi },
    };
  }
  out.niftySnapshotStructure = strikeLevel;

  // Stock options — anything not in the 4 indices.
  const indices = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]);
  const stockUnderlyings = byUnderlying.filter((g) => !indices.has(g.underlying));
  out.stockOptions = { underlyings: stockUnderlyings.length, snapshots: stockUnderlyings.reduce((s, g) => s + g._count._all, 0) };

  // F&O universe hint from CandleBar instruments (equities that are also F&O underlyings).
  const instruments = await prisma.candleBar.findMany({ where: { intervalStr: "1d" }, distinct: ["instrumentId"], select: { instrumentId: true } });
  out.equityUniverse = { distinctInstruments: instruments.length, note: "These are the persisted daily-equity instruments; the true F&O stock universe requires the instrument master (provider-sourced), which needs credentials to refresh." };

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
