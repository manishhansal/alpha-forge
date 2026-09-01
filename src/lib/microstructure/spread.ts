/**
 * spread.ts — Bid/Ask Spread Analysis
 *
 * Tracks:
 *   • Absolute spread     — bestAsk - bestBid  (INR)
 *   • Percentage spread   — spread / midPrice  (fraction)
 *   • Spread percentile   — rank of current spread within a rolling window
 *
 * The SpreadTracker maintains a rolling window of recent spread observations
 * and computes live percentile ranks so callers can detect "wide spread"
 * conditions dynamically without hard-coded thresholds.
 *
 * All prices in INR.
 */

import type { OrderBookSnapshot } from "./order-book";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpreadSample {
  /** Absolute spread in INR. */
  absolute: number;
  /** Spread as fraction of mid-price.  0.001 = 10 bps. */
  fraction: number;
  /** Mid-price at sample time. */
  midPrice: number;
  /** UTC epoch milliseconds. */
  timestampMs: number;
}

export interface SpreadResult {
  /** Current absolute spread (INR). */
  absoluteSpread: number;
  /** Current percentage spread as a fraction (not %). */
  pctSpread: number;
  /**
   * Percentile rank of the current spread within the rolling window.
   * 0.0 = tightest ever seen; 1.0 = widest ever seen.
   * null when the window has fewer than 2 observations.
   */
  spreadPercentile: number | null;
  /**
   * True when the spread is in the top-quartile of the rolling window
   * (spreadPercentile ≥ 0.75) — a meaningful signal of stressed conditions.
   */
  isWide: boolean;
  /** Current mid-price. */
  midPrice: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface SpreadConfig {
  /**
   * Number of spread samples to retain for percentile computation.
   * Default: 200 (≈ a full trading day at 5-second ticks).
   */
  windowSize: number;
  /**
   * Percentile threshold above which a spread is considered "wide".
   * Default: 0.75 (top quartile).
   */
  widePercentileThreshold: number;
}

export const DEFAULT_SPREAD_CONFIG: SpreadConfig = {
  windowSize: 200,
  widePercentileThreshold: 0.75,
};

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Extract a SpreadSample from an OrderBookSnapshot.
 */
export function sampleSpread(snapshot: OrderBookSnapshot): SpreadSample {
  return {
    absolute: snapshot.spread,
    fraction: snapshot.spreadFraction,
    midPrice: snapshot.midPrice,
    timestampMs: snapshot.timestampMs,
  };
}

/**
 * Compute the percentile rank of `value` within a sorted ascending array.
 *
 * Returns the fraction of values in the array that are ≤ `value`.
 * Returns null when the array has fewer than 2 elements.
 */
export function percentileRank(sortedValues: number[], value: number): number | null {
  if (sortedValues.length < 2) return null;
  let count = 0;
  for (const v of sortedValues) {
    if (v <= value) count++;
  }
  return count / sortedValues.length;
}

/**
 * Insert a value into a sorted array (ascending), maintaining sort order.
 * Mutates the array in-place.
 */
export function insertSorted(arr: number[], value: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

// ── Stateful tracker ──────────────────────────────────────────────────────────

/**
 * SpreadTracker maintains a rolling window of spread fractions and
 * computes real-time percentile ranks.
 *
 * Usage:
 *   const tracker = new SpreadTracker();
 *   const result  = tracker.update(snapshot);
 */
export class SpreadTracker {
  private readonly _window: SpreadSample[] = [];
  /** Sorted copy of fraction values for efficient percentile look-ups. */
  private readonly _sortedFractions: number[] = [];
  readonly config: SpreadConfig;

  constructor(config: SpreadConfig = DEFAULT_SPREAD_CONFIG) {
    this.config = config;
  }

  /**
   * Ingest a new snapshot and return the current spread analysis.
   */
  update(snapshot: OrderBookSnapshot): SpreadResult {
    const sample = sampleSpread(snapshot);

    // Evict oldest entry when window is full
    if (this._window.length >= this.config.windowSize) {
      const evicted = this._window.shift()!;
      const idx = this._sortedFractions.indexOf(evicted.fraction);
      if (idx !== -1) this._sortedFractions.splice(idx, 1);
    }

    this._window.push(sample);
    insertSorted(this._sortedFractions, sample.fraction);

    const spreadPercentile = percentileRank(this._sortedFractions, sample.fraction);
    const isWide =
      spreadPercentile !== null &&
      spreadPercentile >= this.config.widePercentileThreshold;

    return {
      absoluteSpread: sample.absolute,
      pctSpread: sample.fraction,
      spreadPercentile,
      isWide,
      midPrice: sample.midPrice,
    };
  }

  /** Recent samples ordered oldest → newest. */
  get history(): readonly SpreadSample[] {
    return this._window;
  }

  /** Number of samples in the window. */
  get windowLength(): number {
    return this._window.length;
  }

  /** Reset the tracker — clears history. */
  reset(): void {
    this._window.length = 0;
    this._sortedFractions.length = 0;
  }
}
