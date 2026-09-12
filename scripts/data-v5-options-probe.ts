/**
 * data-v5-options-probe.ts — REAL strike-level option chain probe (§25/§26).
 * Tries Angel (primary for options) then Upstox, reports strike count + which
 * fields are actually populated. No persist.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
function safe(m: string) { return m.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 200); }

async function auditChain(chain: { provider?: string; expiry?: string; rows?: unknown[] } | null) {
  const rows = (chain?.rows ?? []) as Array<{ strike: number; ce?: { oi: number; bid: number | null; ask: number | null; greeks?: { iv: number | null } }; pe?: { oi: number } }>;
  let ceWithOi = 0, ceWithIv = 0, ceWithBidAsk = 0, peWithOi = 0;
  for (const r of rows) {
    if (r.ce && r.ce.oi > 0) ceWithOi++;
    if (r.ce && r.ce.greeks?.iv != null && r.ce.greeks.iv > 0) ceWithIv++;
    if (r.ce && r.ce.bid != null && r.ce.ask != null) ceWithBidAsk++;
    if (r.pe && r.pe.oi > 0) peWithOi++;
  }
  const mid = rows[Math.floor(rows.length / 2)];
  return {
    provider: chain?.provider ?? null, expiry: chain?.expiry ?? null, strikeRows: rows.length,
    ceWithOi, ceWithIv, ceWithBidAsk, peWithOi,
    sample: mid ? { strike: mid.strike, ceOi: mid.ce?.oi ?? null, ceIv: mid.ce?.greeks?.iv ?? null, ceBid: mid.ce?.bid ?? null, ceAsk: mid.ce?.ask ?? null } : null,
  };
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const { loadWorkerCredentialsFromDb } = await import("../src/lib/market-data/worker-credentials");
  await loadWorkerCredentialsFromDb({ prisma });
  const out: Record<string, unknown> = {};

  const { angel } = await import("../src/services/india/angelone");
  for (const u of ["NIFTY", "BANKNIFTY"]) {
    try {
      const chain = await angel.getOptionChain(u);
      out[`angel_${u}`] = await auditChain(chain as never);
    } catch (e) { out[`angel_${u}`] = { error: safe((e as Error).message) }; }
  }

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(safe((e as Error).message)); process.exit(1); });
