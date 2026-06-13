import type { ScalpStrategyId } from "@/features/scalping/types";

/**
 * UI-facing metadata for every scalping strategy. The trading engine lives in
 * the per-strategy modules and is wired up via `index.ts` — this catalog is
 * pure data so it can be safely imported from client components (no `server-
 * only` files in its transitive deps).
 */

export type ScalpStrategyCategory =
  | "trend"
  | "mean-reversion"
  | "momentum"
  | "orderflow"
  | "range";

export type BadgeVariant =
  | "neutral"
  | "bull"
  | "bear"
  | "warning"
  | "info"
  | "outline";

export interface ScalpStrategyMeta {
  id: ScalpStrategyId;
  /** Short label rendered on chips/badges (≤ 22 chars). */
  label: string;
  /** Long-form description rendered in the picker. */
  description: string;
  category: ScalpStrategyCategory;
  /** Tags surfaced to the user in the picker — indicators, regimes, etc. */
  tags: string[];
  /** Badge variant used to colour the chip in lists. */
  badge: BadgeVariant;
  /** One-letter monogram for compact chips. */
  monogram: string;
}

export const SCALP_STRATEGY_CATALOG: ReadonlyArray<ScalpStrategyMeta> = [
  {
    id: "UT_SMC",
    label: "UT Bot + SMC",
    description:
      "ATR trailing-stop flips confirmed by Smart Money Concepts structure (BOS / CHoCH). The original engine — fires whenever close crosses the trail in line with the prevailing pivot structure.",
    category: "trend",
    tags: ["UT Bot", "ATR", "SMC", "BOS/CHoCH"],
    badge: "info",
    monogram: "U",
  },
  {
    id: "VWAP_SWEEP_TREND",
    label: "VWAP Sweep + Trend",
    description:
      "Higher-timeframe trend filter, then waits for a liquidity sweep of the prior swing high/low while price is stretched away from VWAP. Enters on the rejection candle and exits at the VWAP mean.",
    category: "trend",
    tags: ["VWAP", "Liquidity sweep", "Trend filter", "Mean reversion"],
    badge: "bull",
    monogram: "V",
  },
  {
    id: "NEWS_MOMENTUM",
    label: "News Momentum",
    description:
      "Aggressive breakout scalper. Detects explosive moves via outsized volume + wide-range candles — the kind of impulse caused by ETF news, Fed prints, liquidation cascades, or exchange listings — and rides the impulse direction.",
    category: "momentum",
    tags: ["Volume spike", "Range expansion", "Breakout"],
    badge: "warning",
    monogram: "N",
  },
  {
    id: "RANGE_SCALP",
    label: "Range Scalp",
    description:
      "Trades between support and resistance while volatility is contracting. Uses Bollinger Bands, RSI extremes, and a flat-mid filter to avoid trending markets. Targets the middle band.",
    category: "range",
    tags: ["Bollinger", "RSI", "Support / resistance"],
    badge: "neutral",
    monogram: "R",
  },
  {
    id: "EMA_PULLBACK",
    label: "EMA Pullback",
    description:
      "9 / 20 / 50 EMA stack defines trend. Waits for price to pull back into the 9-20 EMA zone and fires on a confirmation candle in the trend direction. Beginner-friendly trend-following scalp.",
    category: "trend",
    tags: ["9 EMA", "20 EMA", "50 EMA", "Pullback"],
    badge: "info",
    monogram: "E",
  },
  {
    id: "VWAP_REVERSION",
    label: "VWAP Reversion",
    description:
      "Pure mean-reversion to VWAP. Fires when price is overextended (≥ 2σ from VWAP) and momentum weakens (RSI extreme reversing). Target is VWAP itself, stop is 1× ATR beyond entry.",
    category: "mean-reversion",
    tags: ["VWAP", "RSI", "Mean reversion"],
    badge: "bull",
    monogram: "M",
  },
  {
    id: "ORDERFLOW_SWEEP",
    label: "Orderflow Sweep",
    description:
      "Pro-style stop hunt. Looks for equal highs/lows being swept on a high-volume wick followed by an immediate rejection back inside the range — a proxy for the order-flow / delta flip used by liquidity-engineering desks.",
    category: "orderflow",
    tags: ["Equal highs/lows", "Volume spike", "Rejection"],
    badge: "bear",
    monogram: "O",
  },
  {
    id: "FIB_PULLBACK",
    label: "Fib Pullback (1m)",
    description:
      "1-minute Fibonacci impulse-pullback scalp. Detects a strong impulse move (≥ 3× ATR within the last few bars), then waits for price to retrace to the 0.5-0.618 Fib zone of that impulse. A confirmation candle that pierces the 0.5-0.6 zone and closes back through the 0.5 fib triggers a continuation entry — long after an up impulse, short after a down impulse. Stop sits past the deepest pullback wick; target is the impulse extreme (0.0 fib).",
    category: "trend",
    tags: ["Fibonacci", "1m only", "Impulse", "Pullback"],
    badge: "warning",
    monogram: "F",
  },
  {
    id: "INSTITUTIONAL_SMC",
    label: "Institutional AI SMC",
    description:
      "Port of the Ultimate Institutional AI SMC indicator. Aggregates 9 components — EMA20/50 trend, HTF EMA200 bias, VWAP, BOS, SSL/BSL liquidity sweep, FVG, volume spike, candle delta, London/NY kill zone — into a 0-9 AI score. Fires only when the score reaches 7 AND all four institutional preconditions (trend + VWAP + recent sweep + recent BOS) are satisfied, so signals always come after a stop hunt and structure break — never on a fresh impulse candle.",
    category: "orderflow",
    tags: ["VWAP", "BOS", "Liquidity sweep", "FVG", "Kill zone", "AI score"],
    badge: "info",
    monogram: "I",
  },
  {
    id: "AI_INSTITUTIONAL_PRO",
    label: "AI Institutional Pro v5",
    description:
      "Port of the AI Institutional Buy/Sell System [Pro v5] Pine indicator. Two-stage gating — hard gates (EMA20/50 trend + HTF EMA bias + RSI gate + per-direction cooldown) must all pass, then an 8-factor confluence score (VWAP, BOS, SSL/BSL sweep, FVG, order block, volume spike, kill zone, RSI side of 50) needs to clear the mode-preset threshold. Mode preset adapts to the timeframe (1m/5m → Scalping; 15m → Intraday) with ATR-multiple TP/SL and a cooldown rate-limiter that prevents rapid-fire same-direction entries.",
    category: "orderflow",
    tags: [
      "EMA trend",
      "HTF gate",
      "RSI gate",
      "BOS",
      "Liquidity sweep",
      "FVG",
      "Order block",
      "Kill zone",
      "Cooldown",
    ],
    badge: "warning",
    monogram: "A",
  },
] as const;

export const SCALP_STRATEGY_META: Record<ScalpStrategyId, ScalpStrategyMeta> =
  SCALP_STRATEGY_CATALOG.reduce(
    (acc, s) => {
      acc[s.id] = s;
      return acc;
    },
    {} as Record<ScalpStrategyId, ScalpStrategyMeta>,
  );

export function getStrategyMeta(id: ScalpStrategyId): ScalpStrategyMeta {
  return SCALP_STRATEGY_META[id];
}

/** All strategy IDs in their canonical display order. */
export const ALL_STRATEGY_IDS: ReadonlyArray<ScalpStrategyId> = SCALP_STRATEGY_CATALOG.map(
  (s) => s.id,
);
