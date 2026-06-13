import {
  runStrategies as runStrategiesCore,
  type ScalpStrategyContext,
} from "@/features/scalping/strategies";
import type { ScalpSignal, ScalpStrategyId } from "@/features/scalping/types";

/**
 * Thin facade around the per-strategy modules. Kept as `engine.ts` so the
 * historical name still resolves — internally all the trading logic lives in
 * `strategies/*.ts` and the registry in `strategies/index.ts`.
 */

export interface ScalpEngineInput extends ScalpStrategyContext {
  /** Strategies to run, in evaluation order. Defaults to ALL registered. */
  strategies?: ReadonlyArray<ScalpStrategyId>;
}

/**
 * Run the requested strategies against `input.candles` and return every
 * signal that fired (one bar's worth — strategies look back at most
 * `input.lookback` bars). Callers should pass closed candles only.
 */
export function runScalpEngine(input: ScalpEngineInput): ScalpSignal[] {
  const ids = input.strategies && input.strategies.length > 0
    ? input.strategies
    : DEFAULT_STRATEGY_IDS;
  return runStrategiesCore(
    {
      symbol: input.symbol,
      timeframe: input.timeframe,
      candles: input.candles,
      lookback: input.lookback,
    },
    ids,
  );
}

/**
 * Default set of strategies executed when no explicit list is supplied. We
 * run all registered strategies so the journal accumulates every variant
 * concurrently; clients filter what they want to see.
 */
export const DEFAULT_STRATEGY_IDS: ReadonlyArray<ScalpStrategyId> = [
  "UT_SMC",
  "VWAP_SWEEP_TREND",
  "NEWS_MOMENTUM",
  "RANGE_SCALP",
  "EMA_PULLBACK",
  "VWAP_REVERSION",
  "ORDERFLOW_SWEEP",
  "FIB_PULLBACK",
  "INSTITUTIONAL_SMC",
  "AI_INSTITUTIONAL_PRO",
];
