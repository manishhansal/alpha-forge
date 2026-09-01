/**
 * imbalance.ts — Order Book Imbalance
 *
 * Calculates bid/ask imbalance at three granularities:
 *
 *   L1  — top-of-book only (best bid vs best ask)
 *   L5  — top 5 levels combined
 *   WD  — price-weighted depth (levels closer to mid carry more weight)
 *
 * All imbalance values are in [0, 1]:
 *   0.0 = fully ask-side (only ask volume)
 *   0.5 = perfectly balanced
 *   1.0 = fully bid-side (only bid volume)
 *
 * Formula: bidQty / (bidQty + askQty)
 *
 * A value > 0.5 indicates net buy-side pressure; < 0.5 indicates sell-side.
 */

import type { OrderBookSnapshot } from "./order-book";
import { bidQtyTopN, askQtyTopN } from "./order-book";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImbalanceResult {
  /**
   * L1 imbalance — best bid qty vs best ask qty.
   * Most reactive to short-term order flow; most susceptible to spoofing.
   */
  l1: number;

  /**
   * L5 imbalance — sum of top-5 bid qty vs sum of top-5 ask qty.
   * Captures the broader queue. More robust than L1 alone.
   */
  l5: number;

  /**
   * Weighted-depth imbalance — each level is weighted by 1/(rank+1)
   * so the best level has weight 1, level 2 has weight 0.5, etc.
   * Smooths out thin book noise while still emphasising the top.
   */
  weighted: number;

  /** Net direction: >0 = bid-heavy, <0 = ask-heavy. Range [-1, 1]. */
  netPressure: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ImbalanceConfig {
  /**
   * Number of depth levels to use for L5 and weighted calculations.
   * NSE provides up to 5; set lower for instruments with thinner books.
   * Default: 5.
   */
  levels: number;
}

export const DEFAULT_IMBALANCE_CONFIG: ImbalanceConfig = {
  levels: 5,
};

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Compute L1 imbalance from a snapshot.
 *
 * Returns 0.5 when both sides are empty (balanced / no data).
 */
export function computeL1Imbalance(snapshot: OrderBookSnapshot): number {
  const bidQty = snapshot.bids.length > 0 ? snapshot.bids[0].quantity : 0;
  const askQty = snapshot.asks.length > 0 ? snapshot.asks[0].quantity : 0;
  const total = bidQty + askQty;
  return total > 0 ? bidQty / total : 0.5;
}

/**
 * Compute L5 imbalance from a snapshot.
 */
export function computeL5Imbalance(
  snapshot: OrderBookSnapshot,
  levels = DEFAULT_IMBALANCE_CONFIG.levels,
): number {
  const bidQty = bidQtyTopN(snapshot, levels);
  const askQty = askQtyTopN(snapshot, levels);
  const total = bidQty + askQty;
  return total > 0 ? bidQty / total : 0.5;
}

/**
 * Compute weighted-depth imbalance.
 *
 * Weight for level i (0-indexed) = 1 / (i + 1)
 * Gives best-level weight 1.0, second level 0.5, third 0.333 …
 */
export function computeWeightedImbalance(
  snapshot: OrderBookSnapshot,
  levels = DEFAULT_IMBALANCE_CONFIG.levels,
): number {
  let weightedBid = 0;
  let weightedAsk = 0;

  const n = Math.min(
    levels,
    Math.max(snapshot.bids.length, snapshot.asks.length),
  );

  for (let i = 0; i < n; i++) {
    const w = 1 / (i + 1);
    if (i < snapshot.bids.length) weightedBid += snapshot.bids[i].quantity * w;
    if (i < snapshot.asks.length) weightedAsk += snapshot.asks[i].quantity * w;
  }

  const total = weightedBid + weightedAsk;
  return total > 0 ? weightedBid / total : 0.5;
}

/**
 * Compute all three imbalance variants in a single call.
 */
export function computeImbalance(
  snapshot: OrderBookSnapshot,
  config: ImbalanceConfig = DEFAULT_IMBALANCE_CONFIG,
): ImbalanceResult {
  const l1 = computeL1Imbalance(snapshot);
  const l5 = computeL5Imbalance(snapshot, config.levels);
  const weighted = computeWeightedImbalance(snapshot, config.levels);

  // Net pressure: blend all three, normalise to [-1, 1]
  // (uses the same bid/(bid+ask) - 0.5) × 2 → [-1, 1] transform on the average)
  const avgImbalance = (l1 + l5 + weighted) / 3;
  const netPressure = (avgImbalance - 0.5) * 2;

  return { l1, l5, weighted, netPressure };
}

// ── Interpretation helpers ────────────────────────────────────────────────────

/**
 * Classify the imbalance regime.
 *
 *   STRONG_BID  — heavily bid-side (> 0.65)
 *   MILD_BID    — moderately bid-side (> 0.55)
 *   BALANCED    — near-neutral (0.45 – 0.55)
 *   MILD_ASK    — moderately ask-side (< 0.45)
 *   STRONG_ASK  — heavily ask-side (< 0.35)
 */
export type ImbalanceRegime =
  | "STRONG_BID"
  | "MILD_BID"
  | "BALANCED"
  | "MILD_ASK"
  | "STRONG_ASK";

export function classifyImbalance(weightedImbalance: number): ImbalanceRegime {
  if (weightedImbalance > 0.65) return "STRONG_BID";
  if (weightedImbalance > 0.55) return "MILD_BID";
  if (weightedImbalance < 0.35) return "STRONG_ASK";
  if (weightedImbalance < 0.45) return "MILD_ASK";
  return "BALANCED";
}
