import type {
  ScalpBacktestEquityPoint,
  ScalpBacktestStats,
} from "@/features/scalping/backtest";
import type { BacktestInterval } from "@/features/scalping/backtest-intervals";
import type { StrategyScoreBreakdown } from "@/features/scalping/strategy-score";
import type { ScalpStrategyId } from "@/features/scalping/types";
import type { SymbolId } from "@/types/market";

/**
 * Wire format returned by `GET /api/scalper/backtest?detail=summary`.
 *
 * The route file can only export HTTP method handlers (Next.js convention),
 * so the shared response shape lives here. Both the server route and the
 * client context import from this module.
 */
export interface ScalperBacktestSummary {
  generatedAt: number;
  /** Bar interval the backtest ran on (e.g. `5m`, `4h`). */
  interval: BacktestInterval;
  /** Human-friendly label for the lookback window (e.g. `30 days`, `5 years`). */
  periodLabel: string;
  /** Lookback window in milliseconds. */
  periodMs: number;
  /** Legacy — approximate years of history for display. */
  periodYears: number;
  startEquity: number;
  notional: number;
  symbols: SymbolId[];
  /** Whether candles came from the active broker, the Binance fallback, or both. */
  candleSource: "active-broker" | "binance-fallback" | "mixed" | "none";
  /** Per-symbol candle source metadata so the UI can explain shortfalls. */
  candleMeta: Array<{
    symbol: SymbolId;
    source: "active-broker" | "binance-fallback" | "none";
    bars: number;
    fromMs: number;
    toMs: number;
  }>;
  reports: ScalperBacktestReport[];
}

export interface ScalperBacktestReport {
  strategyId: ScalpStrategyId;
  score: StrategyScoreBreakdown;
  aggregate: ScalpBacktestStats;
  perSymbol: ScalperBacktestPerSymbol[];
}

export interface ScalperBacktestPerSymbol {
  symbol: SymbolId;
  stats: ScalpBacktestStats;
  equityCurve: ScalpBacktestEquityPoint[];
  /** Number of trades that fired for this (strategy × symbol). */
  tradeCount: number;
}
