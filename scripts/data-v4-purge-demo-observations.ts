/**
 * data-v4-purge-demo-observations.ts — removes DEMO/TEST provider observations
 * that would contaminate provider reliability (§10/§61). Targets ONLY rows whose
 * instrumentId matches the demo/test pattern — never real-provider observations.
 * DRY-RUN by default; --apply to delete. Low-risk (test fixtures, not market data).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const DEMO_NAME = /(__V3DEMO__|__V4DEMO__|demo|fixture|mock|test[_-]?instrument|synthetic)/i;

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const all = await prisma.providerObservation.findMany({ select: { id: true, instrumentId: true, provider: true } });
  const demo = all.filter((o) => DEMO_NAME.test(o.instrumentId));
  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    totalObservations: all.length,
    demoObservations: demo.length,
    byProvider: demo.reduce<Record<string, number>>((m, o) => ((m[o.provider] = (m[o.provider] ?? 0) + 1), m), {}),
    sampleIds: demo.slice(0, 5).map((o) => o.id),
  }, null, 2));
  if (!apply) { await prisma.$disconnect(); return; }
  const del = await prisma.providerObservation.deleteMany({ where: { id: { in: demo.map((o) => o.id) } } });
  const remaining = await prisma.providerObservation.count();
  console.log(JSON.stringify({ deleted: del.count, remainingObservations: remaining }, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
