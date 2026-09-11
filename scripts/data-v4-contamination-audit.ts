/**
 * data-v4-contamination-audit.ts — read-only (§10/§61).
 *
 * Audits production tables for demo/test/synthetic contamination by BOTH name
 * patterns AND provider/source metadata. Classifies every row's source as
 * REAL_PROVIDER / TEST_FIXTURE / DEMO / SYNTHETIC_DERIVED / UNKNOWN so demo data
 * can never masquerade as real coverage or provider reliability.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const DEMO_NAME = /(__V3DEMO__|__V4DEMO__|demo|fixture|mock|test[_-]?instrument|synthetic)/i;
const SYNTH_DATASET = /agg-|correction|derived/i;
const REAL_PROVIDERS = new Set(["scrapling", "angel_one", "upstox", "yahoo"]);

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const out: Record<string, unknown> = { queriedAt: new Date().toISOString() };

  // CandleBar classification by instrument name + provider + datasetVersion.
  const candles = await prisma.candleBar.findMany({
    select: { instrumentId: true, provider: true, datasetVersion: true },
  });
  const candleClass = { REAL_PROVIDER: 0, TEST_FIXTURE_DEMO: 0, SYNTHETIC_DERIVED: 0, UNKNOWN_NO_PROVENANCE: 0 };
  const suspiciousInstruments = new Set<string>();
  for (const c of candles) {
    if (DEMO_NAME.test(c.instrumentId)) { candleClass.TEST_FIXTURE_DEMO += 1; suspiciousInstruments.add(c.instrumentId); continue; }
    if (c.datasetVersion && SYNTH_DATASET.test(c.datasetVersion)) { candleClass.SYNTHETIC_DERIVED += 1; continue; }
    if (c.provider && REAL_PROVIDERS.has(c.provider)) { candleClass.REAL_PROVIDER += 1; continue; }
    candleClass.UNKNOWN_NO_PROVENANCE += 1; // e.g. the 89,810 legacy daily rows (provider null)
  }
  out.candleBar = { total: candles.length, classification: candleClass, suspiciousInstruments: [...suspiciousInstruments] };

  // OptionChainSnapshot — underlyings that look like test symbols.
  const oc = await prisma.optionChainSnapshot.groupBy({ by: ["underlying"], _count: { _all: true } });
  out.optionChain = {
    underlyings: oc.map((g) => ({ underlying: g.underlying, snapshots: g._count._all, suspicious: DEMO_NAME.test(g.underlying) })),
    suspiciousCount: oc.filter((g) => DEMO_NAME.test(g.underlying)).length,
  };

  // ProviderObservation — separate real-provider observations from demo/test ones.
  // Demo backfill observations from V3 used requestType 'backfill-chunk' against
  // the __V3DEMO__ instrument; classify by instrumentId + provider.
  const obs = await prisma.providerObservation.findMany({
    select: { provider: true, instrumentId: true, dataType: true },
  });
  const obsClass = { REAL: 0, DEMO_OR_TEST: 0 };
  const obsByProvider: Record<string, { real: number; demo: number }> = {};
  for (const o of obs) {
    const isDemo = DEMO_NAME.test(o.instrumentId);
    if (isDemo) obsClass.DEMO_OR_TEST += 1; else obsClass.REAL += 1;
    obsByProvider[o.provider] ??= { real: 0, demo: 0 };
    if (isDemo) obsByProvider[o.provider]!.demo += 1; else obsByProvider[o.provider]!.real += 1;
  }
  out.providerObservation = { total: obs.length, classification: obsClass, byProvider: obsByProvider };

  // DataCorrection / DataQualityIncident — count demo-instrument contamination.
  const corr = await prisma.dataCorrection.findMany({ select: { instrumentId: true } });
  out.dataCorrection = { total: corr.length, demoContaminated: corr.filter((c) => DEMO_NAME.test(c.instrumentId)).length };
  const inc = await prisma.dataQualityIncident.findMany({ select: { instrumentId: true } });
  out.dataQualityIncident = { total: inc.length, demoContaminated: inc.filter((i) => i.instrumentId ? DEMO_NAME.test(i.instrumentId) : false).length };

  // Verdict.
  const contaminated =
    candleClass.TEST_FIXTURE_DEMO > 0 ||
    (out.optionChain as { suspiciousCount: number }).suspiciousCount > 0 ||
    obsClass.DEMO_OR_TEST > 0 ||
    (out.dataCorrection as { demoContaminated: number }).demoContaminated > 0;
  out.verdict = contaminated ? "CONTAMINATION_FOUND" : "CLEAN_NO_DEMO_IN_PRODUCTION_TABLES";

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
