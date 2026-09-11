/**
 * data-v5-index-diag.ts — diagnose why NIFTY/BANKNIFTY historical returns 0.
 * Read-only (no persist). Surfaces the real token resolution + fetch outcome.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
function safeErr(m: string) { return m.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 300); }

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const { loadWorkerCredentialsFromDb } = await import("../src/lib/market-data/worker-credentials");
  await loadWorkerCredentialsFromDb({ prisma });

  const { angel, resolveAngelToken, INDEX_TOKENS } = await import("../src/services/india/angelone");
  const out: Record<string, unknown> = {};
  out.indexTokens = INDEX_TOKENS;
  try {
    // resolveAngelToken needs the eq map; indices resolve via SYMBOL_TO_INDEX regardless.
    out.niftyResolves = resolveAngelToken("NIFTY", new Map());
    out.bnResolves = resolveAngelToken("BANKNIFTY", new Map());
  } catch (e) { out.resolveErr = safeErr((e as Error).message); }

  for (const sym of ["NIFTY", "BANKNIFTY"]) {
    for (const iv of ["5m", "1d"]) {
      try {
        const c = await angel.getHistorical({ symbol: sym, interval: iv, range: "5d" } as never, { allowFallback: false });
        out[`${sym}_${iv}`] = { count: c.length, first: c[0] ?? null };
      } catch (e) { out[`${sym}_${iv}`] = { error: safeErr((e as Error).message) }; }
    }
  }
  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(safeErr((e as Error).message)); process.exit(1); });
