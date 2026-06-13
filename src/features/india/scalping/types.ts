/**
 * Types for the India F&O strategies + paper-trading surface — the
 * structural mirror of `src/features/scalping/types.ts` on the crypto
 * side. Kept fully isolated so cross-market bugs cannot leak from one
 * domain to the other (per the no-cross-imports rule in AGENTS.md).
 *
 * Persisted contract:
 *   `PaperTrade.source` for India rows is `in:${strategyId}:${timeframe}`.
 *   The `in:` prefix segregates India trades from the crypto lane in the
 *   same Postgres table — the journal query layer filters on it so the
 *   two markets never collide in the UI.
 */

import type { IndiaScalpStrategyId } from "@/features/india/scalping/strategies/catalog";

export type IndiaScalpDirection = "LONG" | "SHORT";

/**
 * Bar timeframe the strategy was evaluated on. We keep the crypto trio
 * (1m / 5m / 15m) for visual parity in the picker — but for the scanners
 * we wrap today, the timeframe is largely cosmetic because the underlying
 * scans run on daily / 15m option-chain snapshots. When the proper F&O
 * paper-trader lands it'll use these as the actual bar interval.
 */
export type IndiaScalpTimeframe = "1m" | "5m" | "15m";

export const INDIA_SCALP_TIMEFRAMES: ReadonlyArray<IndiaScalpTimeframe> = [
  "1m",
  "5m",
  "15m",
];

/** Re-exported here so consumers can import everything from one place. */
export type { IndiaScalpStrategyId } from "@/features/india/scalping/strategies/catalog";

/**
 * Mirror of the crypto `ScalpSignal` shape, scoped to India. We keep the
 * field set near-identical so the journal-shared / signal-card components
 * stay structurally consistent across markets — only the labels (₹ vs $,
 * NSE vs Binance) differ in the renderers.
 */
export interface IndiaScalpSignal {
  strategyId: IndiaScalpStrategyId;
  /** NSE ticker WITHOUT the `.NS` suffix (e.g. "RELIANCE", "NIFTY"). */
  symbol: string;
  /** Pretty name for display (e.g. "NIFTY 50") — falls back to `symbol`. */
  symbolName: string;
  /** Bar timeframe the signal was generated against. */
  timeframe: IndiaScalpTimeframe;
  direction: IndiaScalpDirection;
  /** Last traded price the signal fired on (₹). */
  price: number;
  /**
   * Reference level the strategy uses for context — for momentum it's the
   * day's open, for volume-breakout it's the 20-bar average volume, for
   * OI build-up it's the previous OI snapshot. Display-only.
   */
  reference: number;
  /**
   * ATR(period) at signal time — used for SL/TP sizing in the future
   * paper-trader. Today most scanners don't compute it, so this defaults
   * to a fraction of price as a placeholder. UI surfaces it as "—" when 0.
   */
  atr: number;
  /** Whether the strategy's confirmation filter passed. */
  confirmed: boolean;
  /** Suggested entry / stop / target derived by the strategy. */
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  /** Confidence in [0, 1] — currently a strategy-specific scoring. */
  confidence: number;
  rationale: string[];
  /** Wall-clock time the signal fired (ms epoch). */
  triggeredAt: number;
  /** Free-form strategy-specific metadata for the journal / replay. */
  extras?: Record<string, number | string | boolean | null>;
}

export interface IndiaScalpSignalsResponse {
  generatedAt: number;
  timeframe: IndiaScalpTimeframe;
  signals: IndiaScalpSignal[];
}

export const INDIA_PAPER_TRADE_STATUSES = [
  "OPEN",
  "WIN",
  "LOSS",
  "EXPIRED",
  "CANCELLED",
] as const;
export type IndiaPaperTradeStatus = (typeof INDIA_PAPER_TRADE_STATUSES)[number];

/**
 * Build the `source` string written into `PaperTrade.source` for India
 * trades. The `in:` prefix is the canonical segregation marker —
 * `src/features/india/scalping/journal.ts` filters on it so India and
 * crypto never collide in the same view.
 */
export function buildIndiaTradeSource(
  strategyId: IndiaScalpStrategyId,
  timeframe: IndiaScalpTimeframe,
): string {
  return `in:${strategyId}:${timeframe}`;
}

/**
 * Parse the `PaperTrade.source` string back into its India parts. Returns
 * null for sources that don't carry the `in:` prefix (i.e. crypto rows)
 * OR have a malformed payload — the caller decides whether to skip or
 * surface a warning. The crypto journal layer has its own parser; the
 * two never blur.
 */
export function parseIndiaTradeSource(
  source: string,
):
  | { strategyId: IndiaScalpStrategyId; timeframe: IndiaScalpTimeframe }
  | null {
  if (!source.startsWith("in:")) return null;
  const [, idPart, tfPart] = source.split(":");
  if (!idPart || !tfPart) return null;
  if (!INDIA_SCALP_TIMEFRAMES.includes(tfPart as IndiaScalpTimeframe)) {
    return null;
  }
  return {
    // The id is validated downstream against the catalog; we keep this
    // parse step lenient so the journal still surfaces a row even if a
    // strategy id was renamed (the row gets a fallback label).
    strategyId: idPart as IndiaScalpStrategyId,
    timeframe: tfPart as IndiaScalpTimeframe,
  };
}
