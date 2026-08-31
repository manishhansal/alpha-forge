/**
 * liquidity.ts — Instrument Liquidity Score
 *
 * Scores an instrument on [0, 1] using five sub-dimensions:
 *
 *   1. Volume score    — normalised daily/intraday volume vs tier benchmarks.
 *   2. Depth score     — total qty at the top-5 bid + ask levels vs benchmark.
 *   3. Spread score    — tighter spread → higher score (inverse of pctSpread).
 *   4. OI score        — open interest (F&O only; 1.0 for equity spot).
 *   5. Trade freq      — inferred from volume ÷ average trade size or provided.
 *
 * Final score = weighted average of sub-scores.
 * Score thresholds map to a named LiquidityTier label.
 *
 * All monetary values in INR.
 */

import type { OrderBookSnapshot } from "./order-book";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LiquidityInputs {
  snapshot: OrderBookSnapshot;

  /** Current bar / tick volume (shares or contracts). */
  volume: number;

  /**
   * Open interest (contracts). Pass 0 for equity spot instruments
   * — the OI sub-score will default to 1.0 for those.
   */
  openInterest: number;

  /**
   * Whether this is a futures/options instrument (true) or equity spot (false).
   * Controls whether OI contributes to the score.
   */
  isFnO: boolean;

  /**
   * Optional estimate of average trade size in contracts/shares.
   * If omitted, trade-frequency score falls back to a volume-based heuristic.
   */
  avgTradeSize?: number;

  /** Current percentage spread (fraction, e.g. 0.001 = 10 bps). */
  pctSpread: number;
}

export interface LiquidityScore {
  /** Overall liquidity score [0, 1]. */
  score: number;

  /** Sub-scores [0, 1]. */
  volumeScore: number;
  depthScore: number;
  spreadScore: number;
  oiScore: number;
  tradeFreqScore: number;

  /** Named tier based on overall score. */
  tier: LiquidityTier;
}

export type LiquidityTier =
  | "VERY_HIGH"   // ≥ 0.80 — NIFTY50 stocks, NIFTY/BANKNIFTY futures, ATM options
  | "HIGH"        // ≥ 0.60 — NIFTY100 stocks, liquid stock futures
  | "MEDIUM"      // ≥ 0.40 — NIFTY500, liquid mid-cap F&O
  | "LOW"         // ≥ 0.20 — thinly-traded F&O, small-cap
  | "VERY_LOW";   // < 0.20 — illiquid / near-expiry deep OTM

// ── Config ────────────────────────────────────────────────────────────────────

export interface LiquidityConfig {
  /**
   * Weights for each sub-dimension (must sum to 1.0).
   */
  weights: {
    volume: number;
    depth: number;
    spread: number;
    oi: number;
    tradeFreq: number;
  };

  /**
   * Volume benchmark (shares/contracts per tick interval) at which the
   * volume score reaches 1.0. Lower volume is scored proportionally.
   * Default: 10_000 contracts (typical NSE liquid futures tick).
   */
  volumeBenchmark: number;

  /**
   * Total depth quantity (sum of top-5 bid + ask qty) at which the depth
   * score reaches 1.0. Default: 50_000.
   */
  depthBenchmark: number;

  /**
   * Spread fraction at which spread score = 0 (worst).
   * Spreads tighter than this score proportionally up to 1.0.
   * Default: 0.02 (200 bps — deep OTM options).
   */
  worstSpreadFraction: number;

  /**
   * OI benchmark (contracts) at which OI score = 1.0. Default: 100_000.
   */
  oiBenchmark: number;

  /**
   * Trade frequency benchmark (trades per tick interval) at which
   * tradeFreq score = 1.0. Default: 500.
   */
  tradeFreqBenchmark: number;
}

export const DEFAULT_LIQUIDITY_CONFIG: LiquidityConfig = {
  weights: {
    volume:    0.25,
    depth:     0.25,
    spread:    0.25,
    oi:        0.15,
    tradeFreq: 0.10,
  },
  volumeBenchmark:     10_000,
  depthBenchmark:      50_000,
  worstSpreadFraction: 0.02,
  oiBenchmark:         100_000,
  tradeFreqBenchmark:  500,
};

// ── Sub-score helpers ─────────────────────────────────────────────────────────

/** Linear cap at 1.0, floor at 0.0. */
function normScore(value: number, benchmark: number): number {
  if (benchmark <= 0) return 0;
  return Math.max(0, Math.min(1, value / benchmark));
}

/** Inverse spread score: 0 bps = 1.0, worstSpread = 0.0. */
function spreadScore(pctSpread: number, worst: number): number {
  if (worst <= 0) return 1;
  return Math.max(0, 1 - pctSpread / worst);
}

// ── Master scorer ─────────────────────────────────────────────────────────────

/**
 * Compute a multi-dimensional liquidity score for a single tick.
 */
export function computeLiquidityScore(
  inputs: LiquidityInputs,
  config: LiquidityConfig = DEFAULT_LIQUIDITY_CONFIG,
): LiquidityScore {
  const { snapshot, volume, openInterest, isFnO, avgTradeSize, pctSpread } = inputs;

  // 1. Volume
  const vs = normScore(volume, config.volumeBenchmark);

  // 2. Depth — total top-5 bid + ask qty
  const totalDepthQty = snapshot.totalBidQty + snapshot.totalAskQty;
  const ds = normScore(totalDepthQty, config.depthBenchmark);

  // 3. Spread
  const ss = spreadScore(pctSpread, config.worstSpreadFraction);

  // 4. OI — 1.0 for equity spot (OI is meaningless there)
  const os = isFnO ? normScore(openInterest, config.oiBenchmark) : 1.0;

  // 5. Trade frequency — inferred from volume ÷ avgTradeSize or volume proxy
  const inferredFreq = avgTradeSize && avgTradeSize > 0
    ? volume / avgTradeSize
    : volume / 50; // heuristic: assume ~50 shares per trade when unknown
  const tfs = normScore(inferredFreq, config.tradeFreqBenchmark);

  const { weights: w } = config;
  const score =
    vs * w.volume +
    ds * w.depth +
    ss * w.spread +
    os * w.oi +
    tfs * w.tradeFreq;

  return {
    score,
    volumeScore:    vs,
    depthScore:     ds,
    spreadScore:    ss,
    oiScore:        os,
    tradeFreqScore: tfs,
    tier: classifyLiquidityTier(score),
  };
}

// ── Tier classifier ───────────────────────────────────────────────────────────

export function classifyLiquidityTier(score: number): LiquidityTier {
  if (score >= 0.80) return "VERY_HIGH";
  if (score >= 0.60) return "HIGH";
  if (score >= 0.40) return "MEDIUM";
  if (score >= 0.20) return "LOW";
  return "VERY_LOW";
}

// ── Position-size multiplier ──────────────────────────────────────────────────

/**
 * Return a sizing multiplier based on liquidity tier.
 *
 * Very low liquidity instruments should never receive full position size —
 * the impact and slippage costs make a nominal-size position economically
 * equivalent to a large order elsewhere.
 *
 *   VERY_HIGH → 1.00
 *   HIGH      → 0.85
 *   MEDIUM    → 0.65
 *   LOW       → 0.40
 *   VERY_LOW  → 0.20
 */
export function liquiditySizingMultiplier(tier: LiquidityTier): number {
  switch (tier) {
    case "VERY_HIGH": return 1.00;
    case "HIGH":      return 0.85;
    case "MEDIUM":    return 0.65;
    case "LOW":       return 0.40;
    case "VERY_LOW":  return 0.20;
  }
}
