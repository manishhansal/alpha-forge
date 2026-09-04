/**
 * Diagnose why INDICES_SCALP is empty: show every index candidate's gate
 * status and the live option-chain readability. One-shot — run after a
 * `clear-india-daily-picks` if Indices Scalping won't populate.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/diagnose-indices-scalp.ts
 */
import { registry, bootstrapRegistry } from "@/lib/market-data/registry";
import { getIndiaDailyPickCandidates } from "@/features/ai-signals/india-builder";
import {
  passesBucketGate,
  passesTapeFilter,
} from "@/features/india/daily-picks/engine";
import {
  projectIndexScalpToOption,
} from "@/features/india/daily-picks/option-projection";
import { FNO_INDEX_UNDERLYINGS } from "@/lib/india/fno-symbols";

async function main(): Promise<void> {
  await bootstrapRegistry();

  console.log("[diagnose] fetching candidate universe...");
  const { signals, context } = await getIndiaDailyPickCandidates();
  console.log(
    `[diagnose] universe size: ${signals.length} | regimeScore=${context.regimeScore?.toFixed(3)}`,
  );

  const idxSignals = signals.filter((s) => FNO_INDEX_UNDERLYINGS.has(s.symbol));
  console.log(`[diagnose] ${idxSignals.length} index signals\n`);
  for (const s of idxSignals) {
    const gateOk = passesBucketGate(s, "INDICES_SCALP");
    const tapeOk = passesTapeFilter(s, context.regimeScore ?? 0);
    console.log(
      `  ${s.symbol.padEnd(12)} dir=${s.direction.padEnd(8)} action=${s.action.padEnd(5)} conf=${s.confidenceScore.toString().padStart(3)} grade=${s.grade} gate=${gateOk ? "PASS" : "FAIL"} tape=${tapeOk ? "PASS" : "FAIL"}`,
    );
  }

  console.log("\n[diagnose] fetching index option chains...");
  for (const sym of ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]) {
    try {
      // Route through ProviderRegistry (DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO)
      const chain = await registry.getOptionChain(sym);
      const atmRow =
        chain.rows.find(
          (r) =>
            Math.abs(r.strike - (chain.spot ?? 0)) ===
            Math.min(
              ...chain.rows.map((rr) => Math.abs(rr.strike - (chain.spot ?? 0))),
            ),
        ) ?? null;
      console.log(
        `  ${sym.padEnd(12)} spot=${chain.spot} expiry=${chain.expiry} rows=${chain.rows.length} ATM=${atmRow?.strike} CE.ltp=${atmRow?.ce?.ltp ?? "—"} PE.ltp=${atmRow?.pe?.ltp ?? "—"}`,
      );
    } catch (err) {
      console.log(`  ${sym.padEnd(12)} CHAIN ERROR: ${(err as Error).message}`);
    }
  }

  console.log("\n[diagnose] attempting projection for each passing index signal...");
  for (const s of idxSignals) {
    if (!passesBucketGate(s, "INDICES_SCALP")) {
      console.log(`  ${s.symbol}: skipped (gate fail)`);
      continue;
    }
    try {
      const chain = await registry.getOptionChain(s.symbol);
      // Convert canonical OptionChain to legacy shape for projectIndexScalpToOption
      const legacyChain = {
        ...chain,
        // Map canonical rows to legacy row shape
        rows: chain.rows.map((r) => ({
          strike: r.strike,
          ce: r.ce ? { ltp: r.ce.ltp, oi: r.ce.oi, volume: r.ce.volume, iv: r.ce.greeks?.iv, changeInOi: r.ce.oiChange } : null,
          pe: r.pe ? { ltp: r.pe.ltp, oi: r.pe.oi, volume: r.pe.volume, iv: r.pe.greeks?.iv, changeInOi: r.pe.oiChange } : null,
        })),
        analytics: chain.analytics,
      };
      const proj = projectIndexScalpToOption(s, legacyChain as never, s.symbol);
      if (!proj) {
        console.log(`  ${s.symbol}: projection returned null`);
      } else {
        console.log(
          `  ${s.symbol}: ${proj.contract.contractSymbol} entry=${proj.entryPremium.toFixed(2)} target=${proj.targetPremium.toFixed(2)} stop=${proj.stopPremium.toFixed(2)} RR=${proj.riskReward.toFixed(2)}`,
        );
      }
    } catch (err) {
      console.log(`  ${s.symbol}: chain error during projection: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error("[diagnose] failed:", err);
  process.exitCode = 1;
});
