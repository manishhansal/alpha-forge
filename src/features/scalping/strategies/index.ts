import { aiInstitutionalProStrategy } from "./ai-institutional-pro";
import { emaPullbackStrategy } from "./ema-pullback";
import { fibPullbackStrategy } from "./fib-pullback";
import { institutionalSmcStrategy } from "./institutional-smc";
import { newsMomentumStrategy } from "./news-momentum";
import { orderflowSweepStrategy } from "./orderflow-sweep";
import { rangeScalpStrategy } from "./range-scalp";
import type { ScalpStrategyContext, ScalpStrategyModule } from "./types";
import { utSmcStrategy } from "./ut-smc";
import { vwapReversionStrategy } from "./vwap-reversion";
import { vwapSweepTrendStrategy } from "./vwap-sweep-trend";

import type { ScalpSignal, ScalpStrategyId } from "@/features/scalping/types";

/**
 * Registry of all scalping strategy modules, keyed by id. Order here drives
 * the order in which strategies are evaluated for each symbol — keep this
 * matching the UI catalog order so the API response is predictable.
 */
export const SCALP_STRATEGY_MODULES: Record<ScalpStrategyId, ScalpStrategyModule> = {
  UT_SMC: utSmcStrategy,
  VWAP_SWEEP_TREND: vwapSweepTrendStrategy,
  NEWS_MOMENTUM: newsMomentumStrategy,
  RANGE_SCALP: rangeScalpStrategy,
  EMA_PULLBACK: emaPullbackStrategy,
  VWAP_REVERSION: vwapReversionStrategy,
  ORDERFLOW_SWEEP: orderflowSweepStrategy,
  FIB_PULLBACK: fibPullbackStrategy,
  INSTITUTIONAL_SMC: institutionalSmcStrategy,
  AI_INSTITUTIONAL_PRO: aiInstitutionalProStrategy,
};

export const ALL_STRATEGY_MODULES: ScalpStrategyModule[] = Object.values(
  SCALP_STRATEGY_MODULES,
);

/**
 * Run every requested strategy against `ctx.candles` and return the signals
 * that fired. Unknown ids are silently ignored.
 */
export function runStrategies(
  ctx: ScalpStrategyContext,
  ids: ReadonlyArray<ScalpStrategyId>,
): ScalpSignal[] {
  const out: ScalpSignal[] = [];
  for (const id of ids) {
    const mod = SCALP_STRATEGY_MODULES[id];
    if (!mod) continue;
    try {
      const sig = mod.run(ctx);
      if (sig) out.push(sig);
    } catch (err) {
      console.warn(`[scalper] strategy ${id} threw:`, (err as Error).message);
    }
  }
  return out;
}

export type { ScalpStrategyContext, ScalpStrategyModule } from "./types";
export { SCALP_STRATEGY_CATALOG, getStrategyMeta } from "./catalog";
