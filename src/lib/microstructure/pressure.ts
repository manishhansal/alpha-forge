/**
 * pressure.ts — Buy/Sell Pressure Analysis
 *
 * Measures directional order-flow pressure by tracking changes in the order
 * book between consecutive snapshots:
 *
 *   1. Bid replenishment  — how quickly bid-side depth is being refilled
 *                           after being consumed (positive bid pressure).
 *   2. Ask replenishment  — same for the ask side.
 *   3. Depth change       — absolute change in total bid/ask quantity.
 *   4. Price response     — mid-price move associated with depth change.
 *
 * Together these form a net pressure score [-1, 1]:
 *   +1.0 = maximum buy pressure  (bids growing, asks thinning, price rising)
 *   −1.0 = maximum sell pressure (asks growing, bids thinning, price falling)
 *
 * The PressureTracker maintains a short rolling window to smooth tick-level noise.
 */

import type { OrderBookSnapshot } from "./order-book";
import { midPriceDelta } from "./order-book";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PressureFrame {
  /**
   * Bid replenishment rate: change in total bid qty vs previous frame.
   * Positive = bids were added (market-makers stepping up / buyers queuing).
   * Negative = bids were consumed (sell orders hitting the bid).
   */
  bidReplenishment: number;

  /**
   * Ask replenishment rate: change in total ask qty vs previous frame.
   * Positive = asks were added (sellers queuing).
   * Negative = asks were consumed (buy orders lifting the offer).
   */
  askReplenishment: number;

  /**
   * Net depth change = bidReplenishment - askReplenishment.
   * Positive → bid-side growing relative to ask-side.
   */
  netDepthChange: number;

  /**
   * Mid-price change (INR) between this snapshot and the previous one.
   * Positive = price moved up.
   */
  priceResponse: number;

  /**
   * Instantaneous pressure score for this frame [-1, 1].
   * Blends net depth change and price response.
   */
  framePressure: number;

  timestampMs: number;
}

export interface PressureResult {
  /** Smoothed net pressure [-1, 1] over the rolling window. */
  netPressure: number;

  /**
   * Buy strength [0, 1] — share of net positive bid-side frames.
   */
  buyStrength: number;

  /**
   * Sell strength [0, 1] — share of net negative bid-side frames.
   */
  sellStrength: number;

  /** Most recent per-frame detail. */
  latestFrame: PressureFrame | null;

  /** Pressure regime. */
  regime: PressureRegime;
}

export type PressureRegime =
  | "STRONG_BUY"   // netPressure ≥  0.60
  | "MILD_BUY"     // netPressure ≥  0.20
  | "NEUTRAL"      // −0.20 < netPressure < 0.20
  | "MILD_SELL"    // netPressure ≤ −0.20
  | "STRONG_SELL"; // netPressure ≤ −0.60

// ── Config ────────────────────────────────────────────────────────────────────

export interface PressureConfig {
  /**
   * Rolling window length (frames) for smoothing.
   * Default: 20 (≈ 20 ticks / depth updates).
   */
  windowSize: number;

  /**
   * Benchmark total depth qty for normalising depth changes.
   * Changes are expressed as fractions of this value so the score is
   * invariant to absolute book size. Default: 20_000.
   */
  depthNormBenchmark: number;

  /**
   * Benchmark price move (INR) for normalising price response.
   * Typically set to ≈ 1–2 ticks of the instrument. Default: 1.0.
   */
  priceNormBenchmark: number;

  /**
   * Weight given to the depth signal vs the price signal in the frame
   * pressure calculation.  depth + price weights must sum to 1.
   * Default: 0.60 / 0.40.
   */
  depthWeight: number;
  priceWeight: number;
}

export const DEFAULT_PRESSURE_CONFIG: PressureConfig = {
  windowSize:         20,
  depthNormBenchmark: 20_000,
  priceNormBenchmark: 1.0,
  depthWeight:        0.60,
  priceWeight:        0.40,
};

// ── Pure frame computation ─────────────────────────────────────────────────────

/**
 * Compute a pressure frame from two consecutive book snapshots.
 */
export function computePressureFrame(
  prev: OrderBookSnapshot,
  curr: OrderBookSnapshot,
  config: PressureConfig = DEFAULT_PRESSURE_CONFIG,
): PressureFrame {
  const bidReplenishment = curr.totalBidQty - prev.totalBidQty;
  const askReplenishment = curr.totalAskQty - prev.totalAskQty;
  const netDepthChange   = bidReplenishment - askReplenishment;
  const priceResponse    = midPriceDelta(prev, curr);

  // Normalise both signals to [-1, 1]
  const normDepth = config.depthNormBenchmark > 0
    ? Math.max(-1, Math.min(1, netDepthChange / config.depthNormBenchmark))
    : 0;

  const normPrice = config.priceNormBenchmark > 0
    ? Math.max(-1, Math.min(1, priceResponse / config.priceNormBenchmark))
    : 0;

  const framePressure =
    normDepth * config.depthWeight +
    normPrice * config.priceWeight;

  return {
    bidReplenishment,
    askReplenishment,
    netDepthChange,
    priceResponse,
    framePressure: Math.max(-1, Math.min(1, framePressure)),
    timestampMs: curr.timestampMs,
  };
}

// ── Stateful tracker ──────────────────────────────────────────────────────────

/**
 * PressureTracker maintains a rolling window of pressure frames and
 * exposes smoothed buy/sell pressure metrics.
 *
 * Usage:
 *   const tracker = new PressureTracker();
 *   tracker.push(snapshotA);  // prime with first observation
 *   const result = tracker.push(snapshotB);  // first result after two snapshots
 */
export class PressureTracker {
  private _prev: OrderBookSnapshot | null = null;
  private readonly _frames: PressureFrame[] = [];
  readonly config: PressureConfig;

  constructor(config: PressureConfig = DEFAULT_PRESSURE_CONFIG) {
    this.config = config;
  }

  /**
   * Ingest a new snapshot. Returns null on the very first call (no previous
   * snapshot to compute a frame against), then returns PressureResult on
   * every subsequent call.
   */
  push(snapshot: OrderBookSnapshot): PressureResult | null {
    if (this._prev === null) {
      this._prev = snapshot;
      return null;
    }

    const frame = computePressureFrame(this._prev, snapshot, this.config);
    this._prev = snapshot;

    // Evict oldest frame when window is full
    if (this._frames.length >= this.config.windowSize) {
      this._frames.shift();
    }
    this._frames.push(frame);

    return this._buildResult(frame);
  }

  private _buildResult(latestFrame: PressureFrame): PressureResult {
    const n = this._frames.length;
    if (n === 0) {
      return {
        netPressure: 0,
        buyStrength: 0.5,
        sellStrength: 0.5,
        latestFrame,
        regime: "NEUTRAL",
      };
    }

    const netPressure =
      this._frames.reduce((s, f) => s + f.framePressure, 0) / n;

    const posFrames = this._frames.filter(f => f.framePressure > 0).length;
    const negFrames = this._frames.filter(f => f.framePressure < 0).length;
    const buyStrength  = posFrames / n;
    const sellStrength = negFrames / n;

    return {
      netPressure: Math.max(-1, Math.min(1, netPressure)),
      buyStrength,
      sellStrength,
      latestFrame,
      regime: classifyPressureRegime(netPressure),
    };
  }

  /** Reset the tracker state. */
  reset(): void {
    this._prev = null;
    this._frames.length = 0;
  }

  /** Number of frames currently in the window. */
  get windowLength(): number {
    return this._frames.length;
  }
}

// ── Regime classifier ─────────────────────────────────────────────────────────

export function classifyPressureRegime(netPressure: number): PressureRegime {
  if (netPressure >=  0.60) return "STRONG_BUY";
  if (netPressure >=  0.20) return "MILD_BUY";
  if (netPressure <= -0.60) return "STRONG_SELL";
  if (netPressure <= -0.20) return "MILD_SELL";
  return "NEUTRAL";
}
