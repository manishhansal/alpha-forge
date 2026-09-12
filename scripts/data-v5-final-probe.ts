import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
async function main() {
  const p = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const byInterval = await p.candleBar.groupBy({ by: ["intervalStr"], _count: { _all: true }, _min: { time: true }, _max: { time: true } });
  const byProvider = await p.candleBar.groupBy({ by: ["provider"], _count: { _all: true } });
  const intradayInstr = await p.candleBar.findMany({ where: { intervalStr: { in: ["1m","5m","15m","30m","1h"] } }, distinct: ["instrumentId"], select: { instrumentId: true } });
  const [gap, inc, obs, corr, oc, ocs] = await Promise.all([
    p.dataGap.count(), p.dataQualityIncident.count(), p.providerObservation.count(), p.dataCorrection.count(),
    p.optionChainSnapshot.count(), p.optionChainStrike.count(),
  ]);
  const ocsByU = await p.optionChainStrike.groupBy({ by: ["underlying"], _count: { _all: true } });
  console.log(JSON.stringify({
    queriedAt: new Date().toISOString(),
    candlesByInterval: byInterval.map(g => ({ interval: g.intervalStr, rows: g._count._all, first: g._min.time ? new Date(g._min.time*1000).toISOString() : null, last: g._max.time ? new Date(g._max.time*1000).toISOString() : null })),
    candlesByProvider: byProvider.map(g => ({ provider: g.provider ?? "NULL", rows: g._count._all })),
    intradayDistinctInstruments: intradayInstr.length,
    durable: { dataGap: gap, dataQualityIncident: inc, providerObservation: obs, dataCorrection: corr, optionChainSnapshot: oc, optionChainStrike: ocs },
    optionChainStrikeByUnderlying: ocsByU.map(g => ({ underlying: g.underlying, rows: g._count._all })),
  }, null, 2));
  await p.$disconnect(); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
