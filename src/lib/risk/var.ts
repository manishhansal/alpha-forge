/**
 * var.ts — Value at Risk (VaR) and Conditional VaR (CVaR / ES)
 *
 * Implements three measures:
 *
 *   1. Historical VaR     — percentile of the empirical P&L distribution.
 *   2. Parametric VaR     — Gaussian approximation (μ − z·σ).
 *   3. CVaR / ES          — Expected Shortfall: mean loss beyond the VaR cut-off.
 *
 * All figures are expressed as a POSITIVE number representing potential LOSS
 * (i.e. VaR of ₹50,000 means "we expect to lose at most ₹50k at the given
 * confidence level").
 *
 * Inputs:
 *   - A time-series of daily portfolio P&L (INR) — newest last.
 *   - Confidence level (e.g. 0.95 or 0.99).
 *   - For parametric VaR, the current portfolio notional value is needed.
 *
 * References:
 *   Hull, J. (2018). Risk Management and Financial Institutions, 5th ed.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface VaRResult {
  /** Confidence level used (e.g. 0.95). */
  confidence: number;
  /** Historical VaR (INR loss, positive). */
  historicalVaR: number;
  /** Parametric (Gaussian) VaR (INR loss, positive). */
  parametricVaR: number;
  /** Conditional VaR / Expected Shortfall (INR loss, positive). */
  cVar: number;
  /** Number of P&L observations used. */
  observations: number;
  /** Daily P&L mean. */
  mean: number;
  /** Daily P&L standard deviation. */
  stdDev: number;
}

export interface VaRConfig {
  /** Confidence level for VaR calculation. Default 0.95. */
  confidence: number;
  /** Minimum number of observations required. Default 20. */
  minObservations: number;
  /**
   * Maximum rolling window (days) for the historical P&L series.
   * Older data is dropped. Default 252 (1 trading year).
   */
  maxWindow: number;
  /** VaR breach: block new trades when portfolio VaR exceeds this fraction of equity. */
  varLimitFraction: number;
}

export const DEFAULT_VAR_CONFIG: VaRConfig = {
  confidence: 0.95,
  minObservations: 20,
  maxWindow: 252,
  varLimitFraction: 0.05,  // 5% of equity
};

// ── Statistics helpers ───────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[], avg?: number): number {
  if (arr.length < 2) return 0;
  const mu = avg ?? mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Inverse normal CDF (Abramowitz & Stegun approximation, error < 4.5e-4).
 * Returns the z-score for a given one-tailed probability p (0 < p < 1).
 */
function invNorm(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [0, -3.969683028665376e1, 2.209460984245205e2,
    -2.759285104469687e2, 1.383577518672690e2,
    -3.066479806614716e1, 2.506628277459239];

  const b = [0, -5.447609879822406e1, 1.615858368580409e2,
    -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];

  const c = [-7.784894002430293e-3, -3.223964580411365e-1,
    -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783];

  const d = [7.784695709041462e-3, 3.224671290700398e-1,
    2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[1] * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * r + a[6]) * q /
      (((((b[1] * r + b[2]) * r + b[3]) * r + b[4]) * r + b[5]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

// ── VaR calculations ─────────────────────────────────────────────────────────

/**
 * Historical VaR at the given confidence level.
 * Sorts P&L observations and reads the (1 - confidence) percentile.
 *
 * @param pnlSeries  Daily P&L values (INR), positive = profit, negative = loss.
 * @param confidence  e.g. 0.95 → 95th percentile worst loss
 * @returns Positive number representing the VaR loss.
 */
export function historicalVaR(pnlSeries: number[], confidence: number): number {
  if (pnlSeries.length === 0) return 0;

  // Sort ascending (worst losses first)
  const sorted = [...pnlSeries].sort((a, b) => a - b);

  // Standard percentile: the (1-confidence) quantile of the loss distribution.
  // Using Math.round avoids floating-point edge cases (e.g. (1-0.95)*20 = 1.0...009).
  // e.g. n=20, conf=0.95: round(0.05*20)-1 = round(1)-1 = 0 → sorted[0] = worst loss.
  const alpha = 1 - confidence;
  const index = Math.max(0, Math.round(alpha * sorted.length) - 1);

  // VaR is the loss at the quantile boundary — negate so it's a positive number
  return -Math.min(sorted[index], 0);
}

/**
 * Parametric (Gaussian) VaR.
 *
 * @param pnlSeries  Daily P&L time series.
 * @param confidence  e.g. 0.95
 * @returns Positive VaR loss in INR.
 */
export function parametricVaR(pnlSeries: number[], confidence: number): number {
  if (pnlSeries.length < 2) return 0;
  const mu = mean(pnlSeries);
  const sigma = stdDev(pnlSeries, mu);
  const z = invNorm(confidence);
  return Math.max(0, -(mu - z * sigma));
}

/**
 * Conditional VaR (CVaR / Expected Shortfall).
 * Mean of all losses that exceed the VaR cut-off.
 *
 * @param pnlSeries  Daily P&L time series.
 * @param confidence  e.g. 0.95
 * @returns Positive CVaR loss in INR.
 */
export function conditionalVaR(pnlSeries: number[], confidence: number): number {
  if (pnlSeries.length === 0) return 0;

  const sorted = [...pnlSeries].sort((a, b) => a - b);
  const alpha = 1 - confidence;
  // Tail count: at least 1 observation, consistent with historicalVaR index convention
  const tailCount = Math.max(1, Math.round(alpha * sorted.length));
  const tailLosses = sorted.slice(0, tailCount);

  if (tailLosses.length === 0) return 0;
  const avgTailLoss = mean(tailLosses);
  return -Math.min(avgTailLoss, 0);
}

// ── Composite VaR result ──────────────────────────────────────────────────────

/**
 * Compute all three VaR measures in one call.
 *
 * @param pnlSeries  Daily P&L values (INR), recent history, oldest first.
 * @param config     VaR configuration.
 */
export function computeVaR(
  pnlSeries: number[],
  config: VaRConfig = DEFAULT_VAR_CONFIG,
): VaRResult {
  // Take the rolling window
  const window =
    pnlSeries.length > config.maxWindow
      ? pnlSeries.slice(pnlSeries.length - config.maxWindow)
      : pnlSeries;

  if (window.length < config.minObservations) {
    return {
      confidence: config.confidence,
      historicalVaR: 0,
      parametricVaR: 0,
      cVar: 0,
      observations: window.length,
      mean: 0,
      stdDev: 0,
    };
  }

  const mu = mean(window);
  const sigma = stdDev(window, mu);

  return {
    confidence: config.confidence,
    historicalVaR: historicalVaR(window, config.confidence),
    parametricVaR: parametricVaR(window, config.confidence),
    cVar: conditionalVaR(window, config.confidence),
    observations: window.length,
    mean: mu,
    stdDev: sigma,
  };
}

// ── VaR breach check ─────────────────────────────────────────────────────────

export interface VaRBreachCheck {
  breached: boolean;
  reason?: string;
  /** Portfolio VaR as fraction of equity. */
  varFraction: number;
  /** The VaR figure used (historical VaR, INR). */
  varAmount: number;
  limit: number;
}

/**
 * Check whether the current portfolio VaR exceeds the configured limit.
 * Uses historical VaR as the primary measure.
 */
export function checkVaRBreach(
  result: VaRResult,
  equity: number,
  config: VaRConfig = DEFAULT_VAR_CONFIG,
): VaRBreachCheck {
  if (equity <= 0 || result.observations < config.minObservations) {
    return {
      breached: false,
      varFraction: 0,
      varAmount: 0,
      limit: config.varLimitFraction,
    };
  }

  const varAmount = result.historicalVaR;
  const varFraction = varAmount / equity;
  const breached = varFraction > config.varLimitFraction;

  return {
    breached,
    reason: breached
      ? `Historical VaR ₹${varAmount.toFixed(0)} is ${(varFraction * 100).toFixed(1)}% of equity — exceeds ${(config.varLimitFraction * 100).toFixed(0)}% limit`
      : undefined,
    varFraction,
    varAmount,
    limit: config.varLimitFraction,
  };
}

// ── Portfolio-level volatility (annualised) ───────────────────────────────────

/**
 * Daily volatility of the P&L series (standard deviation of daily returns as
 * fraction of equity). Useful for position sizing.
 *
 * @param pnlSeries  Daily P&L values (INR).
 * @param equity     Current portfolio equity (INR).
 * @param windowBars Rolling window.
 */
export function portfolioDailyVol(
  pnlSeries: number[],
  equity: number,
  windowBars: number = 20,
): number {
  if (equity <= 0 || pnlSeries.length < 2) return 0;
  const window =
    pnlSeries.length > windowBars
      ? pnlSeries.slice(pnlSeries.length - windowBars)
      : pnlSeries;
  const dailyReturns = window.map((pnl) => pnl / equity);
  return stdDev(dailyReturns);
}

/**
 * Annualised volatility (252 trading days).
 */
export function portfolioAnnualisedVol(
  pnlSeries: number[],
  equity: number,
  windowBars: number = 20,
): number {
  return portfolioDailyVol(pnlSeries, equity, windowBars) * Math.sqrt(252);
}
