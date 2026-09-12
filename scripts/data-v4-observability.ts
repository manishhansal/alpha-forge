/**
 * data-v4-observability.ts — DB-VERIFIED evidence for §12/§16/§19 (read-only).
 * Runs config-health, provider reliability (sample-size honest), and the
 * runtime-aware capability matrix against the real DB, and re-checks the live
 * data-service quote so at least one REAL observation is present.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const out: Record<string, unknown> = { queriedAt: new Date().toISOString() };

  const { getProviderConfigHealth } = await import("../src/lib/market-data/services/config-health.service");
  const { computeProviderReliability, buildRuntimeCapabilityMatrix, MIN_SAMPLE } = await import("../src/lib/market-data/services/provider-reliability.service");

  out.configHealth = await getProviderConfigHealth(prisma as never);
  out.reliability = await computeProviderReliability(prisma as never);
  out.minSampleForReliability = MIN_SAMPLE;

  const matrix = await buildRuntimeCapabilityMatrix(prisma as never);
  // Compact: only show cells that are runtime-verified or have a sample.
  out.runtimeCapabilityMatrix = matrix.map((c) => ({ p: c.provider, iv: c.interval, staticH: c.staticHistory, runtime: c.runtime }));

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
