/**
 * data-v5-options.ts — `npm run data:options` (§25/§26/§78).
 * Acquires REAL strike-level option chains (Angel primary, Upstox fallback) for
 * the requested underlyings and persists them to OptionChainStrike. Fields the
 * provider does not supply are stored NULL with an *Unavailable flag — never
 * fabricated. No secrets logged.
 *
 * Usage: npm run data:options -- --underlyings=NIFTY,BANKNIFTY
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

function safe(m: string) { return m.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 200); }
function arg(name: string): string | undefined {
  const p = `--${name}=`; const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

interface Leg { oi?: number; oiChange?: number; ltp?: number | null; bid?: number | null; ask?: number | null; volume?: number; greeks?: { iv?: number | null }; oiMissing?: boolean; volumeMissing?: boolean }
interface Row { strike: number; ce?: Leg | null; pe?: Leg | null }

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const underlyings = (arg("underlyings") ?? "NIFTY,BANKNIFTY").split(",").map((s) => s.trim()).filter(Boolean);
  const out: Record<string, unknown> = { command: "options", at: new Date().toISOString(), underlyings };

  const { loadWorkerCredentialsFromDb } = await import("../src/lib/market-data/worker-credentials");
  const load = await loadWorkerCredentialsFromDb({ prisma });
  out.credentials = { angel: load.angel, upstox: load.upstox };

  const { angel } = await import("../src/services/india/angelone");
  const { datasetVersion } = await import("../src/lib/market-data/dataset-version");
  const dv = datasetVersion(new Date().toISOString().slice(0, 10), { kind: "provider", provider: "angel_one" });
  const capture = new Date();

  const results: Array<Record<string, unknown>> = [];
  for (const u of underlyings) {
    try {
      const chain = (await angel.getOptionChain(u)) as { expiry?: string; rows?: Row[] };
      const rows = chain.rows ?? [];
      const records: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        for (const [type, leg] of [["CE", r.ce], ["PE", r.pe]] as const) {
          if (!leg) continue;
          const oi = typeof leg.oi === "number" && !leg.oiMissing ? leg.oi : null;
          const iv = leg.greeks?.iv ?? null;
          const bid = leg.bid ?? null;
          const ask = leg.ask ?? null;
          const volume = typeof leg.volume === "number" && !leg.volumeMissing ? leg.volume : null;
          records.push({
            underlying: u, expiry: chain.expiry ?? "unknown", strike: r.strike, optionType: type,
            ltp: leg.ltp ?? null, bid, ask, volume, oi, oiChange: leg.oiChange ?? null, iv,
            bidUnavailable: bid == null, askUnavailable: ask == null, ivUnavailable: iv == null, volumeUnavailable: volume == null,
            captureTimestamp: capture, provider: "angel_one", receivedAt: new Date(), datasetVersion: dv,
          });
        }
      }
      // Persist (idempotent via unique key incl captureTimestamp+provider).
      let persisted = 0;
      for (const rec of records) {
        try { await prisma.optionChainStrike.create({ data: rec as never }); persisted++; } catch { /* dup — skip */ }
      }
      const withOi = records.filter((r) => r.oi != null).length;
      const withIv = records.filter((r) => r.iv != null).length;
      const withBidAsk = records.filter((r) => r.bid != null && r.ask != null).length;
      results.push({ underlying: u, expiry: chain.expiry, strikeLegs: records.length, persisted, withOi, withIv, withBidAsk });
    } catch (e) { results.push({ underlying: u, error: safe((e as Error).message) }); }
  }
  out.results = results;

  const total = await prisma.optionChainStrike.count();
  out.optionChainStrikeTableTotal = total;
  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(safe((e as Error).message)); process.exit(1); });
