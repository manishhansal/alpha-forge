import type {
  ScalpSignal,
  ScalpStrategyId,
  ScalpTimeframe,
} from "@/features/scalping/types";
import type { KlineCandle, SymbolId } from "@/types/market";

/**
 * Shared shape every scalping strategy module exports.
 *
 * Strategies are pure functions over closed candles. They do NOT touch the
 * database, broker, or Redis — that's the engine's job. The strategy returns
 * a fully populated `ScalpSignal` (with `strategyId` set) or `null` when no
 * trigger fired on the supplied lookback window.
 */
export interface ScalpStrategyContext {
  symbol: SymbolId;
  timeframe: ScalpTimeframe;
  /** Closed candles only — the engine slices off the in-progress bar. */
  candles: KlineCandle[];
  /** Optional override of how many trailing bars to scan for a trigger. */
  lookback?: number;
}

export interface ScalpStrategyModule {
  id: ScalpStrategyId;
  /**
   * Minimum number of bars required for the strategy to run. The engine
   * returns null when `candles.length < warmup`.
   */
  warmup: number;
  run(ctx: ScalpStrategyContext): ScalpSignal | null;
}
