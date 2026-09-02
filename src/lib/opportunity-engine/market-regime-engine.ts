/**
 * MarketRegimeEngine — Formal Regime Classification
 *
 * Replaces the inline heuristic in india-builder.ts with a proper
 * multi-factor regime classifier producing one of 9 canonical states.
 *
 * Regime states:
 *   STRONG_BULL_TREND  — ADX > 30, price > SMA20 > SMA50 > SMA200, positive breadth
 *   WEAK_BULL          — Positive bias, insufficient conviction (ADX 20–30)
 *   RANGE              — ADX < 20, price oscillating within channel
 *   HIGH_VOLATILITY_RANGE — Range + elevated ATR/VIX
 *   STRONG_BEAR_TREND  — ADX > 30, price < SMA20 < SMA50 < SMA200, negative breadth
 *   WEAK_BEAR          — Negative bias, insufficient conviction
 *   PANIC              — VIX spike > 25, gap-down, circuit territory
 *   TRANSITION         — Conflicting regime signals, change in progress
 *   UNKNOWN            — Insufficient data
 *
 * Strategy × Regime matrix:
 *   Determines whether a strategy's historical expectancy supports trading
 *   in the current regime. This is the primary conditional signal optimizer.
 *
 * This module is I/O-free (pure computation). The caller provides all data.
 */

import type { MarketRegimeState } from "./types";
import type { OHLCVCandle } from "@/lib/market-data/types";

// ─── Regime Input ─────────────────────────────────────────────────────────────

export interface RegimeInput {
  /** NIFTY daily candles (at least 50) */
  niftyDailyCandles: OHLCVCandle[];
  /** NIFTY intraday % change today */
  niftyChangePct: number | null;
  /** BANKNIFTY % change */
  bankniftyChangePct: number | null;
  /** India VIX value */
  indiaVix: number | null;
  /** India VIX previous close */
  indiaVixPrevClose: number | null;
  /** Advancing / declining counts in F&O universe */
  advancingCount: number | null;
  decliningCount: number | null;
  /** Whether today is the opening few minutes (first 15m) */
  isOpeningPeriod: boolean;
  /** UTC ms */
  nowMs: number;
}

// ─── Regime Output ────────────────────────────────────────────────────────────

export interface RegimeEvaluation {
  regime: MarketRegimeState;
  /** Directional bias [-1, 1]; positive = bullish */
  directionScore: number;
  /** Regime confidence [0, 1] */
  confidence: number;
  /** ADX value computed */
  adx: number | null;
  /** ATR percentile [0, 100] */
  atrPercentile: number | null;
  /** Breadth: advancing / (advancing + declining) */
  breadthRatio: number | null;
  /** India VIX regime label */
  vixRegime: "VERY_LOW" | "LOW" | "NORMAL" | "HIGH" | "EXTREME";
  /** NIFTY trend relative to SMAs */
  niftyTrendLabel: "ABOVE_ALL" | "ABOVE_SMA20" | "BELOW_SMA20" | "BELOW_ALL";
  /** Whether the regime supports the given strategy type */
  strategyCompatibility: Map<string, RegimeCompatibility>;
  reasons: string[];
}

export interface RegimeCompatibility {
  strategy: string;
  compatible: boolean;
  compatibility: "STRONGLY_SUPPORTED" | "SUPPORTED" | "NEUTRAL" | "ADVERSE" | "STRONGLY_ADVERSE";
  expectedEdgeMultiplier: number; // multiply base expectancy by this factor
  reason: string;
}

// ─── Strategy × Regime Matrix ─────────────────────────────────────────────────

/**
 * Baseline Strategy × Regime compatibility matrix.
 * Values represent expected edge multipliers based on strategy behavior in each regime.
 * 1.0 = neutral (base expectancy), > 1.0 = edge enhanced, < 1.0 = edge reduced.
 *
 * These are PRIORS — actual values should be overridden with OOS data once available.
 * Until then, these conservative estimates guide conditional trading.
 */
export const STRATEGY_REGIME_MATRIX: Record<string, Record<MarketRegimeState, number>> = {
  // Breakout strategies work well in trending markets, poorly in tight ranges
  RANGE_EXPANSION: {
    STRONG_BULL_TREND: 1.4,
    WEAK_BULL: 1.1,
    RANGE: 0.5,
    HIGH_VOLATILITY_RANGE: 0.7,
    STRONG_BEAR_TREND: 1.3,
    WEAK_BEAR: 1.0,
    PANIC: 0.4,
    TRANSITION: 0.7,
    UNKNOWN: 0.6,
  },
  VOLUME_BREAKOUT: {
    STRONG_BULL_TREND: 1.5,
    WEAK_BULL: 1.2,
    RANGE: 0.4,
    HIGH_VOLATILITY_RANGE: 0.6,
    STRONG_BEAR_TREND: 1.4,
    WEAK_BEAR: 1.1,
    PANIC: 0.3,
    TRANSITION: 0.6,
    UNKNOWN: 0.5,
  },
  OPENING_BREAKOUT: {
    STRONG_BULL_TREND: 1.5,
    WEAK_BULL: 1.2,
    RANGE: 0.6,
    HIGH_VOLATILITY_RANGE: 0.8,
    STRONG_BEAR_TREND: 1.4,
    WEAK_BEAR: 1.0,
    PANIC: 0.5,
    TRANSITION: 0.8,
    UNKNOWN: 0.7,
  },

  // Momentum strategies thrive in trends
  MOMENTUM: {
    STRONG_BULL_TREND: 1.6,
    WEAK_BULL: 1.2,
    RANGE: 0.3,
    HIGH_VOLATILITY_RANGE: 0.5,
    STRONG_BEAR_TREND: 1.5,
    WEAK_BEAR: 1.0,
    PANIC: 0.4,
    TRANSITION: 0.5,
    UNKNOWN: 0.5,
  },

  // Mean-reversion / options strategies prefer ranges
  PCR_EXTREME: {
    STRONG_BULL_TREND: 0.5,
    WEAK_BULL: 0.8,
    RANGE: 1.5,
    HIGH_VOLATILITY_RANGE: 1.3,
    STRONG_BEAR_TREND: 0.5,
    WEAK_BEAR: 0.9,
    PANIC: 0.6,
    TRANSITION: 1.0,
    UNKNOWN: 0.7,
  },
  IV_SPIKE: {
    STRONG_BULL_TREND: 0.6,
    WEAK_BULL: 0.8,
    RANGE: 1.2,
    HIGH_VOLATILITY_RANGE: 1.6,
    STRONG_BEAR_TREND: 0.7,
    WEAK_BEAR: 0.9,
    PANIC: 1.4,
    TRANSITION: 1.1,
    UNKNOWN: 0.8,
  },
  LIQUIDITY_EDGE: {
    STRONG_BULL_TREND: 0.8,
    WEAK_BULL: 1.0,
    RANGE: 1.4,
    HIGH_VOLATILITY_RANGE: 1.2,
    STRONG_BEAR_TREND: 0.8,
    WEAK_BEAR: 1.0,
    PANIC: 0.5,
    TRANSITION: 0.9,
    UNKNOWN: 0.7,
  },
  MAX_PAIN_GRAVITY: {
    STRONG_BULL_TREND: 0.5,
    WEAK_BULL: 0.7,
    RANGE: 1.6,
    HIGH_VOLATILITY_RANGE: 0.8,
    STRONG_BEAR_TREND: 0.5,
    WEAK_BEAR: 0.7,
    PANIC: 0.3,
    TRANSITION: 0.8,
    UNKNOWN: 0.6,
  },

  // OI strategies work across regimes but prefer clear directional moves
  OI_BUILDUP: {
    STRONG_BULL_TREND: 1.4,
    WEAK_BULL: 1.1,
    RANGE: 0.8,
    HIGH_VOLATILITY_RANGE: 0.7,
    STRONG_BEAR_TREND: 1.4,
    WEAK_BEAR: 1.0,
    PANIC: 0.5,
    TRANSITION: 0.7,
    UNKNOWN: 0.6,
  },

  // AI multi-factor is regime-aware internally, moderate across all
  INDIA_AI_SIGNALS: {
    STRONG_BULL_TREND: 1.3,
    WEAK_BULL: 1.1,
    RANGE: 0.8,
    HIGH_VOLATILITY_RANGE: 0.7,
    STRONG_BEAR_TREND: 1.2,
    WEAK_BEAR: 1.0,
    PANIC: 0.4,
    TRANSITION: 0.7,
    UNKNOWN: 0.5,
  },
};

// ─── Indicator Helpers ────────────────────────────────────────────────────────

function smaFromCandles(candles: OHLCVCandle[], period: number): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((s, c) => s + c.close, 0) / period;
}

function computeAdx(candles: OHLCVCandle[], period = 14): number | null {
  if (candles.length < period * 2 + 1) return null;
  const slice = candles.slice(-(period * 2 + 1));
  let smoothTR = 0, smoothDMp = 0, smoothDMm = 0;
  for (let i = 1; i <= period; i++) {
    const c = slice[i], p = slice[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, down = p.low - c.low;
    smoothTR += tr;
    smoothDMp += up > down && up > 0 ? up : 0;
    smoothDMm += down > up && down > 0 ? down : 0;
  }
  let prevAdx = 0;
  for (let i = period + 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, down = p.low - c.low;
    smoothTR = smoothTR - smoothTR / period + tr;
    smoothDMp = smoothDMp - smoothDMp / period + (up > down && up > 0 ? up : 0);
    smoothDMm = smoothDMm - smoothDMm / period + (down > up && down > 0 ? down : 0);
    const dP = smoothTR > 0 ? (smoothDMp / smoothTR) * 100 : 0;
    const dM = smoothTR > 0 ? (smoothDMm / smoothTR) * 100 : 0;
    const dx = dP + dM > 0 ? (Math.abs(dP - dM) / (dP + dM)) * 100 : 0;
    prevAdx = i === period + 1 ? dx : (prevAdx * (period - 1) + dx) / period;
  }
  return prevAdx;
}

function computeAtrPercentile(candles: OHLCVCandle[], period = 14): number | null {
  if (candles.length < period + 5) return null;
  const atrs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    atrs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const current = atrs[atrs.length - 1];
  const below = atrs.filter(v => v < current).length;
  return (below / atrs.length) * 100;
}

// ─── Core Classifier ──────────────────────────────────────────────────────────

/**
 * Classify the current market regime from NIFTY data and breadth indicators.
 *
 * The classifier uses a priority cascade:
 *   1. PANIC     — VIX spike + gap-down (override everything)
 *   2. TRANSITION — conflicting strong signals
 *   3. STRONG_BULL / STRONG_BEAR — ADX > 30 + SMA stack
 *   4. HIGH_VOLATILITY_RANGE — ATR elevated + ADX low
 *   5. RANGE     — ADX < 20 + neutral breadth
 *   6. WEAK_BULL / WEAK_BEAR — moderate bias without strong trend
 *   7. UNKNOWN   — insufficient data
 */
export function classifyMarketRegime(input: RegimeInput): RegimeEvaluation {
  const reasons: string[] = [];
  const candles = input.niftyDailyCandles;

  if (candles.length < 20) {
    return {
      regime: "UNKNOWN",
      directionScore: 0,
      confidence: 0,
      adx: null,
      atrPercentile: null,
      breadthRatio: null,
      vixRegime: "NORMAL",
      niftyTrendLabel: "ABOVE_SMA20",
      strategyCompatibility: new Map(),
      reasons: ["Insufficient candle history (< 20 bars)"],
    };
  }

  // ── Indicator computation ──────────────────────────────────────────────
  const adx = computeAdx(candles, 14);
  const atrPercentile = computeAtrPercentile(candles, 14);
  const sma20 = smaFromCandles(candles, 20);
  const sma50 = smaFromCandles(candles, 50);
  const sma200 = smaFromCandles(candles, 200);
  const lastClose = candles[candles.length - 1].close;

  // Breadth
  const adv = input.advancingCount ?? 0;
  const dec = input.decliningCount ?? 0;
  const breadthRatio = adv + dec > 0 ? adv / (adv + dec) : null;

  // VIX regime
  const vix = input.indiaVix;
  const vixPrev = input.indiaVixPrevClose;
  const vixChange = vix !== null && vixPrev !== null && vixPrev > 0
    ? ((vix - vixPrev) / vixPrev) * 100 : null;

  const vixRegime: RegimeEvaluation["vixRegime"] =
    vix === null ? "NORMAL" :
    vix >= 25 ? "EXTREME" :
    vix >= 18 ? "HIGH" :
    vix >= 12 ? "NORMAL" :
    vix >= 8 ? "LOW" : "VERY_LOW";

  // NIFTY vs SMAs
  let niftyTrendLabel: RegimeEvaluation["niftyTrendLabel"] = "ABOVE_SMA20";
  if (sma20 !== null && sma50 !== null && sma200 !== null) {
    const aboveSma20 = lastClose > sma20;
    const aboveSma50 = lastClose > sma50;
    const aboveSma200 = lastClose > sma200;
    if (aboveSma20 && aboveSma50 && aboveSma200) niftyTrendLabel = "ABOVE_ALL";
    else if (!aboveSma20 && !aboveSma50 && !aboveSma200) niftyTrendLabel = "BELOW_ALL";
    else if (aboveSma20) niftyTrendLabel = "ABOVE_SMA20";
    else niftyTrendLabel = "BELOW_SMA20";
  }

  // SMA slope (trend direction)
  const sma20Slope = sma20 !== null && candles.length >= 25
    ? (lastClose - candles[candles.length - 6].close) / candles[candles.length - 6].close
    : null;

  // Market change
  const niftyChange = input.niftyChangePct ?? 0;
  const bnChange = input.bankniftyChangePct ?? 0;
  const avgChange = (niftyChange + bnChange) / 2;

  // ── Direction score ────────────────────────────────────────────────────
  let directionScore = 0;
  if (avgChange > 0.5) directionScore += 0.3;
  else if (avgChange > 0) directionScore += 0.1;
  else if (avgChange < -0.5) directionScore -= 0.3;
  else directionScore -= 0.1;

  if (niftyTrendLabel === "ABOVE_ALL") directionScore += 0.4;
  else if (niftyTrendLabel === "ABOVE_SMA20") directionScore += 0.2;
  else if (niftyTrendLabel === "BELOW_SMA20") directionScore -= 0.2;
  else if (niftyTrendLabel === "BELOW_ALL") directionScore -= 0.4;

  if (breadthRatio !== null) {
    directionScore += (breadthRatio - 0.5) * 0.6;
  }
  directionScore = Math.max(-1, Math.min(1, directionScore));

  // ── Regime classification ─────────────────────────────────────────────

  let regime: MarketRegimeState = "UNKNOWN";
  let confidence = 0.5;

  // 1. PANIC: VIX spike + aggressive gap-down
  if (vixRegime === "EXTREME" && niftyChange < -2.0) {
    regime = "PANIC";
    confidence = 0.9;
    reasons.push(`PANIC: VIX=${vix?.toFixed(1)}, NIFTY ${niftyChange.toFixed(2)}%`);
  }
  // 2. PANIC (secondary): very large single-day move
  else if (Math.abs(niftyChange) > 3.5) {
    regime = "PANIC";
    confidence = 0.8;
    reasons.push(`PANIC: extreme single-day move ${niftyChange.toFixed(2)}%`);
  }
  // 3. STRONG BULL: trending up with conviction
  else if (
    adx !== null && adx > 28 &&
    niftyTrendLabel === "ABOVE_ALL" &&
    (breadthRatio === null || breadthRatio > 0.55) &&
    vixRegime !== "EXTREME"
  ) {
    regime = "STRONG_BULL_TREND";
    confidence = Math.min(0.95, 0.6 + (adx - 28) / 50 + (breadthRatio ?? 0.5) * 0.3);
    reasons.push(`STRONG_BULL: ADX=${adx?.toFixed(0)}, NIFTY above all SMAs, breadth ${(breadthRatio ?? 0).toFixed(2)}`);
  }
  // 4. STRONG BEAR: trending down with conviction
  else if (
    adx !== null && adx > 28 &&
    niftyTrendLabel === "BELOW_ALL" &&
    (breadthRatio === null || breadthRatio < 0.45) &&
    vixRegime !== "EXTREME"
  ) {
    regime = "STRONG_BEAR_TREND";
    confidence = Math.min(0.95, 0.6 + (adx - 28) / 50 + (1 - (breadthRatio ?? 0.5)) * 0.3);
    reasons.push(`STRONG_BEAR: ADX=${adx?.toFixed(0)}, NIFTY below all SMAs`);
  }
  // 5. HIGH_VOLATILITY_RANGE: ranging but with high vol
  else if (
    (adx === null || adx < 22) &&
    (atrPercentile !== null && atrPercentile > 70) &&
    vixRegime !== "VERY_LOW"
  ) {
    regime = "HIGH_VOLATILITY_RANGE";
    confidence = 0.75;
    reasons.push(`HIGH_VOL_RANGE: ADX=${adx?.toFixed(0)}, ATR pct=${atrPercentile?.toFixed(0)}`);
  }
  // 6. RANGE: low ADX, neither trending nor panicking
  else if (adx !== null && adx < 20) {
    regime = "RANGE";
    confidence = 0.7 + (20 - adx) / 40;
    reasons.push(`RANGE: ADX=${adx.toFixed(0)} — no trend`);
  }
  // 7. WEAK_BULL: positive bias but lacking conviction
  else if (directionScore > 0.2) {
    regime = "WEAK_BULL";
    confidence = 0.55 + directionScore * 0.2;
    reasons.push(`WEAK_BULL: directionScore=${directionScore.toFixed(2)}, ADX=${adx?.toFixed(0)}`);
  }
  // 8. WEAK_BEAR: negative bias but lacking conviction
  else if (directionScore < -0.2) {
    regime = "WEAK_BEAR";
    confidence = 0.55 + Math.abs(directionScore) * 0.2;
    reasons.push(`WEAK_BEAR: directionScore=${directionScore.toFixed(2)}`);
  }
  // 9. TRANSITION: conflicting signals
  else if (adx !== null && adx > 20 && Math.abs(directionScore) < 0.15) {
    regime = "TRANSITION";
    confidence = 0.55;
    reasons.push(`TRANSITION: ADX=${adx.toFixed(0)} but direction neutral`);
  }
  // 10. UNKNOWN fallback
  else {
    regime = "UNKNOWN";
    confidence = 0.3;
    reasons.push("Cannot classify regime: insufficient signal strength");
  }

  // VIX addendum
  if (vixRegime === "HIGH" && regime !== "PANIC") {
    reasons.push(`Elevated VIX ${vix?.toFixed(1)} — reduce confidence`);
    confidence *= 0.85;
  }
  if (vixChange !== null && vixChange > 15) {
    reasons.push(`VIX rising rapidly (+${vixChange.toFixed(0)}%) — regime unstable`);
    confidence *= 0.80;
  }

  // ── Strategy compatibility ────────────────────────────────────────────
  const strategyCompatibility = new Map<string, RegimeCompatibility>();
  for (const [stratId, regimeMatrix] of Object.entries(STRATEGY_REGIME_MATRIX)) {
    const multiplier = regimeMatrix[regime] ?? 0.7;
    let compatibility: RegimeCompatibility["compatibility"];
    if (multiplier >= 1.4) compatibility = "STRONGLY_SUPPORTED";
    else if (multiplier >= 1.0) compatibility = "SUPPORTED";
    else if (multiplier >= 0.8) compatibility = "NEUTRAL";
    else if (multiplier >= 0.5) compatibility = "ADVERSE";
    else compatibility = "STRONGLY_ADVERSE";

    strategyCompatibility.set(stratId, {
      strategy: stratId,
      compatible: multiplier >= 0.8,
      compatibility,
      expectedEdgeMultiplier: multiplier,
      reason: `${stratId} in ${regime}: edge multiplier ${multiplier.toFixed(1)}×`,
    });
  }

  return {
    regime,
    directionScore,
    confidence: Math.max(0, Math.min(1, confidence)),
    adx,
    atrPercentile,
    breadthRatio,
    vixRegime,
    niftyTrendLabel,
    strategyCompatibility,
    reasons,
  };
}

// ─── Regime Score for Strategy ────────────────────────────────────────────────

/**
 * Compute a [0, 1] regime compatibility score for a strategy.
 * Used as the `regimeScore` in the OpportunityScoreVector.
 */
export function computeRegimeScore(
  strategyId: string,
  regime: MarketRegimeState,
): number {
  const matrix = STRATEGY_REGIME_MATRIX[strategyId];
  if (!matrix) return 0.5; // neutral if strategy not in matrix
  const multiplier = matrix[regime] ?? 0.7;
  // Convert multiplier to [0, 1] score: 1.6 → 1.0, 0.3 → 0.0
  return Math.max(0, Math.min(1, (multiplier - 0.3) / (1.6 - 0.3)));
}
