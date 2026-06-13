import type { SymbolId } from "@/types/market";

export type ScalpDirection = "LONG" | "SHORT";
export type ScalpTimeframe = "1m" | "5m" | "15m";

/**
 * Stable id of a scalping strategy. New strategies must add a value here so
 * the type system catches missing UI mappings (label, color, badge variant).
 *
 * Persisted in `PaperTrade.source` as `"${ScalpStrategyId}:${ScalpTimeframe}"`,
 * so renaming an id is a breaking change for historical rows.
 */
export const SCALP_STRATEGY_IDS = [
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
] as const;
export type ScalpStrategyId = (typeof SCALP_STRATEGY_IDS)[number];

export interface ScalpSignal {
  /** The strategy module that produced this signal. */
  strategyId: ScalpStrategyId;
  symbol: SymbolId;
  timeframe: ScalpTimeframe;
  direction: ScalpDirection;
  /** Last close price the signal fired on. */
  price: number;
  /**
   * UT Bot trailing-stop level the close just crossed. Kept for the original
   * UT_SMC strategy; other strategies set this to the closest reference
   * level they used (VWAP, EMA, range mid). Display-only.
   */
  trail: number;
  /** ATR(period) at signal time — used for SL/TP sizing. */
  atr: number;
  /** SMC structure bias at signal time (-1 / 0 / +1). 0 when N/A. */
  smcBias: -1 | 0 | 1;
  /** Whether the strategy considers the signal "confirmed" (filter passed). */
  confirmed: boolean;
  /** Suggested entry / stop / target. */
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  /** Confidence in [0, 1]. Higher = more aligned signals. */
  confidence: number;
  rationale: string[];
  /** Bar close time of the trigger (ms epoch). */
  triggeredAt: number;
  /** Free-form strategy-specific metadata for the journal / replay. */
  extras?: Record<string, number | string | boolean | null>;
}

export interface ScalpSignalsResponse {
  generatedAt: number;
  timeframe: ScalpTimeframe;
  signals: ScalpSignal[];
}

export const PAPER_TRADE_STATUSES = [
  "OPEN",
  "WIN",
  "LOSS",
  "EXPIRED",
  "CANCELLED",
] as const;
export type PaperTradeStatus = (typeof PAPER_TRADE_STATUSES)[number];

export interface PaperTradeMeta {
  /** Cents-of-truth on what fired the trade — replayable. */
  trail: number;
  smcBias: -1 | 0 | 1;
  confirmed: boolean;
  utKey: number;
  atrPeriod: number;
  triggeredAt: number;
  confidence: number;
  triggeredAtPrice: number;
  strategyId?: ScalpStrategyId;
  extras?: Record<string, number | string | boolean | null>;
}

/**
 * Parse a `PaperTrade.source` string back into its parts. Returns null when
 * the source predates the strategy-aware format (treat as `UT_SMC`).
 */
export function parseTradeSource(
  source: string,
): { strategyId: ScalpStrategyId; timeframe: ScalpTimeframe } | null {
  const [idPart, tfPart] = source.split(":");
  if (!idPart || !tfPart) return null;
  // Legacy rows used `SMC_UTBOT:5m` — alias to the new id.
  const id = (idPart === "SMC_UTBOT" ? "UT_SMC" : idPart) as ScalpStrategyId;
  if (!SCALP_STRATEGY_IDS.includes(id)) return null;
  if (!["1m", "5m", "15m"].includes(tfPart)) return null;
  return { strategyId: id, timeframe: tfPart as ScalpTimeframe };
}

/** Build the `source` string written into PaperTrade rows. */
export function buildTradeSource(
  strategyId: ScalpStrategyId,
  timeframe: ScalpTimeframe,
): string {
  return `${strategyId}:${timeframe}`;
}
