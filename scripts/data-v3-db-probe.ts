/**
 * Data Foundation V3 — read-only DB probe.
 *
 * Queries the REAL Postgres (via the Prisma adapter, the canonical path) and
 * prints a machine + human readable snapshot of the current data state:
 *   - CandleBar counts by interval / exchange
 *   - daily span + provenance coverage
 *   - OptionChainSnapshot coverage
 *   - the four V2 durable-table row counts
 *
 * NOTHING is written or mutated. Run with:
 *   npx tsx --env-file=.env.local scripts/data-v3-db-probe.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

function getPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

async function main() {
  const prisma = getPrisma();
  const queriedAt = new Date().toISOString();
  const out: Record<string, unknown> = { queriedAt, database: process.env.DATABASE_URL?.replace(/:[^:@/]*@/, ":****@") };

  // 1. Candle counts by interval.
  const byInterval = await prisma.candleBar.groupBy({
    by: ["intervalStr"],
    _count: { _all: true },
    _min: { time: true },
    _max: { time: true },
  });
  out.candlesByInterval = byInterval
    .map((g) => ({
      interval: g.intervalStr,
      rows: g._count._all,
      firstIso: g._min.time ? new Date(g._min.time * 1000).toISOString() : null,
      lastIso: g._max.time ? new Date(g._max.time * 1000).toISOString() : null,
    }))
    .sort((a, b) => b.rows - a.rows);

  // 2. Candle counts by exchange.
  const byExchange = await prisma.candleBar.groupBy({
    by: ["exchange"],
    _count: { _all: true },
  });
  out.candlesByExchange = byExchange.map((g) => ({ exchange: g.exchange, rows: g._count._all }));

  // 3. Distinct instruments + total rows.
  const totalCandles = await prisma.candleBar.count();
  const distinctInstr = await prisma.candleBar.findMany({
    distinct: ["instrumentId"],
    select: { instrumentId: true },
  });
  out.totalCandles = totalCandles;
  out.distinctInstruments = distinctInstr.length;

  // 4. Provenance coverage (how many rows carry a provider).
  const withProvider = await prisma.candleBar.count({ where: { NOT: { provider: null } } });
  const withDatasetVersion = await prisma.candleBar.count({ where: { NOT: { datasetVersion: null } } });
  const withReceivedAt = await prisma.candleBar.count({ where: { NOT: { receivedAt: null } } });
  const volumeUnavailable = await prisma.candleBar.count({ where: { volumeUnavailable: true } });
  out.provenance = {
    candlesWithProvider: withProvider,
    candlesWithDatasetVersion: withDatasetVersion,
    candlesWithReceivedAt: withReceivedAt,
    volumeUnavailableRows: volumeUnavailable,
    totalCandles,
  };

  // 5. Provider breakdown (only meaningful once provenance is populated).
  const byProvider = await prisma.candleBar.groupBy({
    by: ["provider"],
    _count: { _all: true },
  });
  out.candlesByProvider = byProvider.map((g) => ({ provider: g.provider ?? "NULL", rows: g._count._all }));

  // 6. Option-chain coverage.
  const ocByUnderlying = await prisma.optionChainSnapshot.groupBy({
    by: ["underlying"],
    _count: { _all: true },
    _min: { capturedAt: true },
    _max: { capturedAt: true },
  });
  out.optionChainByUnderlying = ocByUnderlying.map((g) => ({
    underlying: g.underlying,
    snapshots: g._count._all,
    first: g._min.capturedAt?.toISOString() ?? null,
    last: g._max.capturedAt?.toISOString() ?? null,
  }));

  // 7. The four V2 durable tables.
  const [dataGap, incidents, observations, corrections] = await Promise.all([
    prisma.dataGap.count(),
    prisma.dataQualityIncident.count(),
    prisma.providerObservation.count(),
    prisma.dataCorrection.count(),
  ]);
  out.durableTables = { dataGap, dataQualityIncident: incidents, providerObservation: observations, dataCorrection: corrections };

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("PROBE_FAILED", err);
  process.exit(1);
});
