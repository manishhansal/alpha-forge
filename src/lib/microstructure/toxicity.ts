/**
 * toxicity.ts — Order Flow Toxicity Score
 *
 * Estimates whether current market microstructure conditions are unfavourable
 * for new order placement ("toxic flow").  High toxicity signals informed
 * order flow — adverse selection risk that degrades realised execution quality.
 *
 * Toxicity is scored on [0, 1]:
 *   0.0 = benign / clean order flow
 *   1.0 = maximally toxic / strongly informed flow
 *
 * Three inputs drive the composite toxicity score:
 *
 *   1. VPIN score          — Volume-synchronised Probability of Informed
 *                            Trading, computed from OHLCV bars using the same
 *                            tick-rule bucket algorithm as the Python service.
 *                            This module OWNS the TypeScript VPIN computation
 *                            so that nothing is duplicated with the Python
 *                            version (which is used for off-line ML feature
 *                            generation, not real-time scoring).
 *
 *   2. Imbalance extremity — how far the weighted order-book imbalance deviates
 *                            from 0.5; extreme imbalance (either direction)
 *                            raises toxicity because it often precedes a price
 *                            move that disadvantages passive participants.
 *
 *   3. Spread elevation    — a wide spread (high spreadPercentile) signals
 *                            informed traders are demanding extra compensation,
 *                            which is itself a toxicity signal.
 *
 * High toxicity reduces:
 *   • signal confidence (via `adjustConfidenceForToxicity`)
 *   • position size     (via `toxicitySizingMultiplier`)
 *
 * NOTE on Python VPIN:
 *   ml-service/src/features/volume.py::compute_vpin() is used for historical
 *   feature generation and model training ONLY.  This TypeScript port is used
 *   for real-time intraday scoring.  The algorithm is identical; the
 *   implementation is not shared by design (different runtime targets).
 */

import type { OHLCVCandle } from "@/lib/market-data/types";

// ── VPIN (TypeScript port) ─────────────────────────────────────────────────────
//
// Algorithm mirrors ml-service/src/features/volume.py::compute_vpin() exactly.
// Tick rule: close > prevClose → 85% buy; close < prevClose → 15% buy; flat → 50%.
// Volume accumulates into fixed-size buckets.
// bucket_vpin = |buy_vol - sell_vol| / bucket_size.
// Current VPIN = mean of the last n_buckets completed buckets.

export interface VpinResult {
  /** Completed bucket VPIN values, oldest first. */
  vpinSeries: number[];
  /** Mean of the last `nBuckets` completed buckets. [0, 1]. */
  currentVpin: number;
}

export interface VpinConfig {
  /**
   * Volume units per bucket.  Choose ~1/50 of average daily volume.
   * Default: 50.
   */
  bucketSize: number;
  /**
   * Number of recent buckets used to compute current_vpin.
   * Default: 50.
   */
  nBuckets: number;
}

export const DEFAULT_VPIN_CONFIG: VpinConfig = {
  bucketSize: 50,
  nBuckets:   50,
};

/**
 * Compute VPIN from a sequence of OHLCV candles.
 *
 * @param candles    Array of OHLCV candles (any interval; 5m is typical).
 * @param config     Bucket-size / window config.
 */
export function computeVpin(
  candles: readonly OHLCVCandle[],
  config: VpinConfig = DEFAULT_VPIN_CONFIG,
): VpinResult {
  const { bucketSize, nBuckets } = config;
  if (bucketSize <= 0) return { vpinSeries: [], currentVpin: 0 };

  const buckets: number[] = [];
  let currentBuyVol   = 0;
  let currentSellVol  = 0;
  let currentTotal    = 0;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const prevClose = i === 0
      ? (bar.open ?? bar.close)  // first bar: use open as reference
      : candles[i - 1].close;

    let buyFraction: number;
    if (bar.close > prevClose)      buyFraction = 0.85;
    else if (bar.close < prevClose) buyFraction = 0.15;
    else                            buyFraction = 0.5;

    let remaining = bar.volume;

    while (remaining > 0) {
      const space = bucketSize - currentTotal;

      if (remaining < space) {
        currentBuyVol  += remaining * buyFraction;
        currentSellVol += remaining * (1 - buyFraction);
        currentTotal   += remaining;
        remaining       = 0;
      } else {
        currentBuyVol  += space * buyFraction;
        currentSellVol += space * (1 - buyFraction);
        currentTotal   += space;
        remaining      -= space;

        const bucketVpin = Math.abs(currentBuyVol - currentSellVol) / bucketSize;
        buckets.push(bucketVpin);

        currentBuyVol  = 0;
        currentSellVol = 0;
        currentTotal   = 0;
      }
    }
  }

  if (buckets.length === 0) return { vpinSeries: [], currentVpin: 0 };

  const recent = buckets.slice(-nBuckets);
  const currentVpin = recent.reduce((s, v) => s + v, 0) / recent.length;

  return { vpinSeries: buckets, currentVpin };
}

// ── Toxicity score ─────────────────────────────────────────────────────────────

export interface ToxicityInputs {
  /**
   * Current VPIN score [0, 1].  Pass the `currentVpin` field from
   * `computeVpin()` or the value returned by the Python service.
   */
  vpin: number;

  /**
   * Weighted order-book imbalance [0, 1] from imbalance.ts.
   * 0.5 = balanced; extremes (near 0 or 1) indicate one-sided pressure.
   */
  weightedImbalance: number;

  /**
   * Spread percentile rank [0, 1] from spread.ts.
   * null → treated as 0.5 (neutral) when unavailable.
   */
  spreadPercentile: number | null;
}

export interface ToxicityScore {
  /** Composite toxicity score [0, 1]. */
  score: number;

  /** Sub-component scores [0, 1]. */
  vpinComponent:      number;
  imbalanceComponent: number;
  spreadComponent:    number;

  /** Qualitative tier. */
  tier: ToxicityTier;
}

export type ToxicityTier =
  | "BENIGN"   // score < 0.25 — clean flow, favourable conditions
  | "MODERATE" // score < 0.50 — some adversity; proceed with caution
  | "HIGH"     // score < 0.75 — informed flow likely; reduce size
  | "EXTREME"; // score ≥ 0.75 — strongly toxic; strongly reduce or skip

// ── Config ────────────────────────────────────────────────────────────────────

export interface ToxicityConfig {
  /** Weight of VPIN component (default 0.50). */
  vpinWeight: number;
  /** Weight of imbalance extremity component (default 0.30). */
  imbalanceWeight: number;
  /** Weight of spread elevation component (default 0.20). */
  spreadWeight: number;
}

export const DEFAULT_TOXICITY_CONFIG: ToxicityConfig = {
  vpinWeight:       0.50,
  imbalanceWeight:  0.30,
  spreadWeight:     0.20,
};

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Convert an imbalance value [0, 1] to an imbalance-extremity score [0, 1].
 * A perfectly balanced book (0.5) scores 0; extreme imbalance (0 or 1) scores 1.
 */
export function imbalanceExtremity(imbalance: number): number {
  return Math.abs(imbalance - 0.5) * 2;
}

/**
 * Compute the composite toxicity score.
 */
export function computeToxicityScore(
  inputs: ToxicityInputs,
  config: ToxicityConfig = DEFAULT_TOXICITY_CONFIG,
): ToxicityScore {
  const vpinComp      = Math.max(0, Math.min(1, inputs.vpin));
  const imbalComp     = imbalanceExtremity(inputs.weightedImbalance);
  const spreadPerc    = inputs.spreadPercentile ?? 0.5;
  const spreadComp    = Math.max(0, Math.min(1, spreadPerc));

  const score =
    vpinComp   * config.vpinWeight +
    imbalComp  * config.imbalanceWeight +
    spreadComp * config.spreadWeight;

  return {
    score: Math.max(0, Math.min(1, score)),
    vpinComponent:      vpinComp,
    imbalanceComponent: imbalComp,
    spreadComponent:    spreadComp,
    tier: classifyToxicity(score),
  };
}

export function classifyToxicity(score: number): ToxicityTier {
  if (score >= 0.75) return "EXTREME";
  if (score >= 0.50) return "HIGH";
  if (score >= 0.25) return "MODERATE";
  return "BENIGN";
}

// ── Impact on confidence and position sizing ───────────────────────────────────

/**
 * Reduce signal confidence as a function of toxicity score.
 *
 * The adjustment is:
 *   adjustedConfidence = confidence × (1 - toxicity.score × reductionFactor)
 *
 * Defaults to a maximum 40% confidence reduction at full toxicity.
 */
export function adjustConfidenceForToxicity(
  confidence: number,
  toxicity: ToxicityScore,
  maxReductionFactor = 0.40,
): number {
  const reduction = toxicity.score * maxReductionFactor;
  return Math.max(0, confidence * (1 - reduction));
}

/**
 * Return a position-sizing multiplier [0, 1] based on toxicity tier.
 *
 *   BENIGN   → 1.00
 *   MODERATE → 0.80
 *   HIGH     → 0.55
 *   EXTREME  → 0.30
 */
export function toxicitySizingMultiplier(tier: ToxicityTier): number {
  switch (tier) {
    case "BENIGN":   return 1.00;
    case "MODERATE": return 0.80;
    case "HIGH":     return 0.55;
    case "EXTREME":  return 0.30;
  }
}
