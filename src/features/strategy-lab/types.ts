import type { SymbolId } from "@/types/market";

/**
 * Strategy Lab — conversational backtesting feature.
 *
 * A user writes a strategy in plain English ("Buy BTC when RSI drops below
 * 30 and sell when RSI crosses above 70 with a 5% stop loss"). The parser
 * compiles that into a `ParsedStrategy` AST which the backtest engine and
 * the worker's live paper-trader can execute deterministically.
 *
 * The grammar is intentionally tiny — it covers the indicator combos a
 * retail trader would actually try (RSI / MACD / EMA cross / price
 * breakouts / volume spikes), with explicit risk parameters. Anything we
 * don't understand is reported back to the user as a parse warning so they
 * can rephrase rather than silently being ignored.
 */

export type StrategyPeriod = "1W" | "1M" | "6M" | "1Y" | "5Y";

export const STRATEGY_PERIODS: readonly StrategyPeriod[] = ["1W", "1M", "6M", "1Y", "5Y"] as const;

export const PERIOD_LABEL: Record<StrategyPeriod, string> = {
  "1W": "1 week",
  "1M": "1 month",
  "6M": "6 months",
  "1Y": "1 year",
  "5Y": "5 years",
};

/**
 * Mapping of UI period → DB enum literal. Keep in sync with
 * `StrategyBacktestPeriodEnum` in `prisma/schema.prisma`.
 */
export const PERIOD_TO_DB: Record<StrategyPeriod, "WEEK_1" | "MONTH_1" | "MONTH_6" | "YEAR_1" | "YEAR_5"> = {
  "1W": "WEEK_1",
  "1M": "MONTH_1",
  "6M": "MONTH_6",
  "1Y": "YEAR_1",
  "5Y": "YEAR_5",
};

export const PERIOD_FROM_DB: Record<"WEEK_1" | "MONTH_1" | "MONTH_6" | "YEAR_1" | "YEAR_5", StrategyPeriod> = {
  WEEK_1: "1W",
  MONTH_1: "1M",
  MONTH_6: "6M",
  YEAR_1: "1Y",
  YEAR_5: "5Y",
};

/**
 * Per-period kline interval choice. We keep total candle count under ~5000
 * so a single backtest stays fast and the Binance API doesn't get hammered
 * (each request is capped at 1000 candles). 5 years on 1d ≈ 1825 candles.
 */
export const PERIOD_INTERVAL: Record<StrategyPeriod, "15m" | "1h" | "4h" | "1d"> = {
  "1W": "15m",
  "1M": "1h",
  "6M": "4h",
  "1Y": "4h",
  "5Y": "1d",
};

export const PERIOD_DURATION_MS: Record<StrategyPeriod, number> = {
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
  "6M": 182 * 24 * 60 * 60 * 1000,
  "1Y": 365 * 24 * 60 * 60 * 1000,
  "5Y": 5 * 365 * 24 * 60 * 60 * 1000,
};

// ───────────────────────────────────────────────────────────────────────────
// Indicator references — the small whitelist of operands the DSL recognises.
// The backtest engine pre-computes a matching `Series` per ref and indexes
// into them by bar.
// ───────────────────────────────────────────────────────────────────────────
export type IndicatorKind =
  | "PRICE"
  | "CLOSE"
  | "RSI"
  | "MACD_LINE"
  | "MACD_SIGNAL"
  | "MACD_HIST"
  | "EMA"
  | "SMA"
  | "ATR"
  | "VOLUME"
  | "VOLUME_AVG"
  | "PCT_CHANGE"; // % change over N bars

export interface IndicatorRef {
  kind: IndicatorKind;
  /** Lookback period (e.g. RSI 14, EMA 20). Optional for kinds without one. */
  period?: number;
  /** For PCT_CHANGE: bars to look back. */
  lookback?: number;
}

export type Comparator = "<" | "<=" | ">" | ">=" | "==" | "CROSS_ABOVE" | "CROSS_BELOW";

export interface NumberLiteral {
  kind: "NUMBER";
  value: number;
}

export type Operand = { kind: "INDICATOR"; ref: IndicatorRef } | NumberLiteral;

/** A single comparison rule, e.g. "RSI(14) < 30" or "EMA(20) crossAbove EMA(50)". */
export interface Condition {
  left: Operand;
  comparator: Comparator;
  right: Operand;
}

export type LogicOp = "AND" | "OR";

/** Group of conditions joined by AND/OR. We keep it flat (no nesting) for
 *  the V1 — every rule combines its conditions with one logical operator. */
export interface Rule {
  conditions: Condition[];
  logic: LogicOp;
}

export type Side = "LONG" | "SHORT";

export interface RiskParams {
  /** Stop-loss as a percent of entry (`0.02` = 2%). */
  stopLossPct?: number;
  /** Take-profit as a percent of entry. */
  takeProfitPct?: number;
  /** Stop-loss as a multiple of ATR(14). */
  stopAtrMult?: number;
  /** Take-profit as a multiple of ATR(14). */
  targetAtrMult?: number;
  /** Hold-for-N-bars exit (covers "exit after 5 days"). */
  maxHoldBars?: number;
}

export interface ParsedStrategy {
  /** Echo of the original prompt (lowercased + trimmed). */
  prompt: string;
  side: Side;
  /** Conditions that open a position. */
  entry: Rule;
  /** Optional explicit exit conditions. If omitted, the position is closed
   *  only by stop / target / max-hold. */
  exit: Rule | null;
  risk: RiskParams;
  /** Notional (USD) per trade. Defaults to `1000`. */
  notional: number;
  /** Bullets explaining how we interpreted the prompt — surfaced in the UI. */
  summary: string[];
  /** Phrases we couldn't understand. */
  warnings: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Backtest result shapes — persisted as JSON in `StrategyBacktest`.
// ───────────────────────────────────────────────────────────────────────────
export interface BacktestTrade {
  side: Side;
  entry: number;
  exit: number;
  /** Reason: TARGET, STOP, EXIT_RULE, MAX_HOLD, EOD. */
  reason: string;
  openedAt: number;
  closedAt: number;
  pnlPct: number;
  pnlUsd: number;
  /** Bars held. */
  bars: number;
}

export interface EquityPoint {
  ts: number;
  equity: number;
}

export interface BacktestStats {
  symbol: SymbolId;
  period: StrategyPeriod;
  interval: string;
  startTs: number;
  endTs: number;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  largestWinPct: number;
  largestLossPct: number;
  /** Σ wins / |Σ losses|. Infinity when no losses. */
  profitFactor: number;
  /** Max peak-to-trough drawdown of equity curve (0..1). */
  maxDrawdownPct: number;
  /** Annualised Sharpe approximation using bar-level returns. */
  sharpe: number;
  /** Average trade duration in bars. */
  avgBarsHeld: number;
  /** Final cumulative P&L in USD on the configured notional. */
  totalPnlUsd: number;
}

export interface BacktestResult {
  stats: BacktestStats;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  parsed: ParsedStrategy;
}
