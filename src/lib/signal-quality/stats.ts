/**
 * Statistical utilities for signal quality evaluation.
 *
 * Phase 19 — Statistical Significance helpers.
 * All confidence intervals use bootstrap resampling (10,000 draws).
 * Do NOT make strong claims with tiny samples.
 */

import type { StatisticalSignificance } from "./types";

// ─── Basic statistics ─────────────────────────────────────────────────────────

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

export function stdDev(arr: number[], ddof = 1): number {
  if (arr.length < 2) return 0;
  const mu = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - ddof);
  return Math.sqrt(variance);
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (idx - lo) * (s[hi] - s[lo]);
}

/** Safe division: returns 0 when denominator is 0 */
export function safeDiv(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

// ─── Confusion matrix metrics ─────────────────────────────────────────────────

export function precision(tp: number, fp: number): number {
  return safeDiv(tp, tp + fp);
}

export function recall(tp: number, fn: number): number {
  return safeDiv(tp, tp + fn);
}

export function f1(prec: number, rec: number): number {
  return safeDiv(2 * prec * rec, prec + rec);
}

export function specificity(tn: number, fp: number): number {
  return safeDiv(tn, tn + fp);
}

// ─── Profit factor ────────────────────────────────────────────────────────────

/** Profit Factor = sum of winning R / |sum of losing R|  (returns ∞ for zero losses) */
export function profitFactor(returns: number[]): number {
  const wins = returns.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const losses = Math.abs(returns.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  if (losses === 0) return wins > 0 ? Infinity : 0;
  return safeDiv(wins, losses);
}

// ─── Expectancy ───────────────────────────────────────────────────────────────

/**
 * Expectancy = (winRate × avgWin) - ((1-winRate) × |avgLoss|)
 * Expressed as R-multiple when returns are already in R units.
 */
export function expectancy(returns: number[]): number {
  if (returns.length === 0) return 0;
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const wr = safeDiv(wins.length, returns.length);
  const avgW = wins.length > 0 ? mean(wins) : 0;
  const avgL = losses.length > 0 ? Math.abs(mean(losses)) : 0;
  return wr * avgW - (1 - wr) * avgL;
}

// ─── Drawdown ─────────────────────────────────────────────────────────────────

/** Max drawdown from a cumulative P&L series */
export function maxDrawdown(equityCurve: number[]): number {
  let peak = -Infinity;
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = safeDiv(peak - v, Math.abs(peak));
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ─── Bootstrap confidence intervals ──────────────────────────────────────────

const BOOTSTRAP_DRAWS = 10_000;

/**
 * Bootstrap 95% confidence interval for the mean of an array.
 * Uses `Math.random()` — deterministic for a given seed is not required here.
 */
export function bootstrapMeanCI(
  arr: number[],
  draws = BOOTSTRAP_DRAWS,
): { mean: number; lower: number; upper: number; std: number } {
  if (arr.length < 2) {
    const v = arr[0] ?? 0;
    return { mean: v, lower: v, upper: v, std: 0 };
  }

  const means: number[] = [];
  for (let i = 0; i < draws; i++) {
    let s = 0;
    for (let j = 0; j < arr.length; j++) {
      s += arr[Math.floor(Math.random() * arr.length)];
    }
    means.push(s / arr.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: mean(means),
    lower: means[Math.floor(0.025 * draws)],
    upper: means[Math.floor(0.975 * draws)],
    std: stdDev(means),
  };
}

/**
 * Bootstrap 95% confidence interval for win rate (Bernoulli proportion).
 */
export function bootstrapWinRateCI(
  outcomes: boolean[],
  draws = BOOTSTRAP_DRAWS,
): { mean: number; lower: number; upper: number; std: number } {
  const numeric = outcomes.map((o) => (o ? 1 : 0));
  return bootstrapMeanCI(numeric, draws);
}

// ─── Statistical significance level ──────────────────────────────────────────

/**
 * Assess statistical significance based on sample size and CI width.
 * Per Phase 19 rules: do NOT make strong claims with tiny samples.
 */
export function assessSignificance(
  n: number,
  ciLow: number,
  ciHigh: number,
): StatisticalSignificance {
  const ciWidth = ciHigh - ciLow;
  if (n >= 30 && ciWidth < 0.15) return "STATISTICALLY_MEANINGFUL";
  if (n >= 15) return "MARGINAL";
  return "INSUFFICIENT_EVIDENCE";
}

// ─── Brier Score ──────────────────────────────────────────────────────────────

/**
 * Brier Score = mean((p_predicted - outcome)²).
 * Lower is better (perfect calibration = 0).
 *
 * @param predictions Array of predicted probabilities [0,1]
 * @param actuals Array of binary outcomes (1=win, 0=loss)
 */
export function brierScore(predictions: number[], actuals: number[]): number {
  if (predictions.length === 0) return 1; // worst case if no data
  const n = Math.min(predictions.length, actuals.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (predictions[i] - actuals[i]) ** 2;
  }
  return sum / n;
}

// ─── Expected Calibration Error ───────────────────────────────────────────────

/**
 * Expected Calibration Error (ECE) — weighted average of per-bucket calibration errors.
 * Each bucket weight = bucket_n / total_n.
 *
 * @param buckets Array of { predictedRate, actualRate, count }
 */
export function expectedCalibrationError(
  buckets: Array<{ predictedRate: number; actualRate: number; count: number }>,
): number {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) return 0;
  return buckets.reduce((s, b) => {
    return s + (b.count / total) * Math.abs(b.predictedRate - b.actualRate);
  }, 0);
}

// ─── R-multiple conversion ────────────────────────────────────────────────────

/**
 * Convert a raw pnlPct to an R-multiple.
 * R = pnlPct / riskPct (where riskPct = |entry - stopLoss| / entry × 100).
 * A WIN at target would be close to the configured riskReward (e.g. 2.0R).
 */
export function toRMultiple(pnlPct: number, riskPct: number): number {
  if (riskPct === 0) return 0;
  return pnlPct / riskPct;
}

// ─── Cost adjustment ──────────────────────────────────────────────────────────

/** BASE cost: NSE F&O round-trip in basis points (STT + brokerage + exchange) */
export const BASE_COST_BPS = 5;

/**
 * Adjust a return by subtracting transaction costs.
 * @param returnPct   Raw return in %
 * @param costBps     Round-trip cost in basis points (1 bps = 0.01%)
 */
export function costAdjust(returnPct: number, costBps: number): number {
  return returnPct - costBps / 100;
}

// ─── Sample size requirements ─────────────────────────────────────────────────

/** Minimum sample needed for a meaningful precision estimate at ±10% CI */
export const MIN_SAMPLE_FOR_PRECISION = 30;
/** Minimum to separate NEEDS_MORE_DATA from a performance verdict */
export const MIN_SAMPLE_FOR_VERDICT = 15;
