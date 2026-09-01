/**
 * Core performance metrics.
 *
 * All functions are pure — given a trade list and/or equity curve they
 * return a number with no side-effects. This keeps them independently
 * testable and reusable across performance.ts and attribution.ts.
 *
 * Annualisation convention
 * ────────────────────────
 * NSE cash equity: 252 trading days.
 * NSE F&O intraday: annualise per-trade returns at 252 days when barsHeld
 * represents daily bars, or scale by actual calendar days when timestamps
 * are available.
 */

export const TRADING_DAYS_PER_YEAR = 252;
export const RISK_FREE_RATE_ANNUAL = 0.065; // 6.5% — approximate India 10Y G-Sec

// ── Return series helpers ─────────────────────────────────────────────────────

/** Simple return for a single trade (net P&L / entry notional). */
export function tradeReturn(pnl: number, entryNotional: number): number {
  if (entryNotional <= 0) return 0;
  return pnl / entryNotional;
}

/** Mean of an array. Returns 0 for empty arrays. */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population variance. */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
}

/** Population standard deviation. */
export function stddev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

/** Downside standard deviation (semi-deviation) — only negative returns. */
export function downsideStddev(xs: number[], threshold = 0): number {
  const neg = xs.filter((x) => x < threshold).map((x) => (x - threshold) ** 2);
  if (neg.length === 0) return 0;
  return Math.sqrt(neg.reduce((a, b) => a + b, 0) / neg.length);
}

// ── Equity-curve drawdown ─────────────────────────────────────────────────────

export interface DrawdownResult {
  /** Maximum peak-to-trough drawdown (0..1). */
  maxDrawdown: number;
  /** Sum of all drawdown periods as fraction of total. */
  avgDrawdown: number;
  /** Peak equity value. */
  peak: number;
  /** Trough equity value during max drawdown. */
  trough: number;
  /** Index of peak. */
  peakIndex: number;
  /** Index of trough. */
  troughIndex: number;
}

export function calcDrawdown(equityValues: number[]): DrawdownResult {
  if (equityValues.length === 0) {
    return { maxDrawdown: 0, avgDrawdown: 0, peak: 0, trough: 0, peakIndex: 0, troughIndex: 0 };
  }

  let peak = equityValues[0];
  let peakIdx = 0;
  let maxDD = 0;
  let maxPeak = equityValues[0];
  let maxTrough = equityValues[0];
  let maxPeakIdx = 0;
  let maxTroughIdx = 0;
  const dds: number[] = [];

  for (let i = 1; i < equityValues.length; i++) {
    const v = equityValues[i];
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
    const dd = peak > 0 ? (peak - v) / peak : 0;
    dds.push(dd);
    if (dd > maxDD) {
      maxDD = dd;
      maxPeak = peak;
      maxTrough = v;
      maxPeakIdx = peakIdx;
      maxTroughIdx = i;
    }
  }

  return {
    maxDrawdown: maxDD,
    avgDrawdown: mean(dds),
    peak: maxPeak,
    trough: maxTrough,
    peakIndex: maxPeakIdx,
    troughIndex: maxTroughIdx,
  };
}

// ── Core metrics ──────────────────────────────────────────────────────────────

/**
 * CAGR — Compound Annual Growth Rate.
 * @param startEquity   Starting portfolio value
 * @param endEquity     Ending portfolio value
 * @param tradingDays   Number of trading days elapsed
 */
export function cagr(startEquity: number, endEquity: number, tradingDays: number): number {
  if (startEquity <= 0 || tradingDays <= 0) return 0;
  const years = tradingDays / TRADING_DAYS_PER_YEAR;
  if (years <= 0) return 0;
  return (endEquity / startEquity) ** (1 / years) - 1;
}

/**
 * Sharpe Ratio — annualised, using per-trade returns.
 * @param returns       Array of per-trade fractional returns
 * @param riskFreeRate  Annual risk-free rate (default: India 6.5%)
 */
export function sharpeRatio(
  returns: number[],
  riskFreeRate = RISK_FREE_RATE_ANNUAL,
): number {
  if (returns.length < 2) return 0;
  const rfPerTrade = riskFreeRate / TRADING_DAYS_PER_YEAR;
  const excessReturns = returns.map((r) => r - rfPerTrade);
  const m = mean(excessReturns);
  const s = stddev(excessReturns);
  if (s === 0) return 0;
  return (m / s) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Sortino Ratio — like Sharpe but uses downside deviation.
 */
export function sortinoRatio(
  returns: number[],
  riskFreeRate = RISK_FREE_RATE_ANNUAL,
): number {
  if (returns.length < 2) return 0;
  const rfPerTrade = riskFreeRate / TRADING_DAYS_PER_YEAR;
  const excessReturns = returns.map((r) => r - rfPerTrade);
  const m = mean(excessReturns);
  const ds = downsideStddev(excessReturns);
  if (ds === 0) return m > 0 ? Infinity : 0;
  return (m / ds) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Calmar Ratio — CAGR / Max Drawdown.
 */
export function calmarRatio(cagrValue: number, maxDrawdown: number): number {
  if (maxDrawdown <= 0) return cagrValue > 0 ? Infinity : 0;
  return cagrValue / maxDrawdown;
}

/**
 * Profit Factor — gross wins / |gross losses|.
 * Returns Infinity when there are no losses.
 */
export function profitFactor(pnls: number[]): number {
  let grossWin = 0;
  let grossLoss = 0;
  for (const p of pnls) {
    if (p > 0) grossWin += p;
    else if (p < 0) grossLoss += Math.abs(p);
  }
  if (grossLoss === 0) return grossWin > 0 ? Infinity : 0;
  return grossWin / grossLoss;
}

/**
 * Expectancy per trade = WinRate × AvgWin − LossRate × AvgLoss.
 */
export function expectancy(pnls: number[]): number {
  if (pnls.length === 0) return 0;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const winRate = wins.length / pnls.length;
  const lossRate = losses.length / pnls.length;
  const avgWin = wins.length > 0 ? mean(wins) : 0;
  const avgLoss = losses.length > 0 ? mean(losses.map(Math.abs)) : 0;
  return winRate * avgWin - lossRate * avgLoss;
}

/**
 * Payoff Ratio — average win / average loss.
 */
export function payoffRatio(pnls: number[]): number {
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const avgWin = wins.length > 0 ? mean(wins) : 0;
  const avgLoss = losses.length > 0 ? mean(losses.map(Math.abs)) : 0;
  if (avgLoss === 0) return avgWin > 0 ? Infinity : 0;
  return avgWin / avgLoss;
}

/**
 * System Quality Number (SQN) — Van Tharp.
 * SQN = (mean(R) / stddev(R)) × sqrt(N)
 * R = trade P&L as multiples of initial risk.
 */
export function sqn(rMultiples: number[]): number {
  if (rMultiples.length < 2) return 0;
  const m = mean(rMultiples);
  const s = stddev(rMultiples);
  if (s === 0) return 0;
  return (m / s) * Math.sqrt(rMultiples.length);
}

/**
 * Ulcer Index — RMS of percentage drawdowns from rolling peak.
 * Lower is better. Measures how "ulcer-inducing" the equity curve is.
 */
export function ulcerIndex(equityValues: number[]): number {
  if (equityValues.length < 2) return 0;
  let peak = equityValues[0];
  const ddPctSq: number[] = [];
  for (const v of equityValues) {
    if (v > peak) peak = v;
    const ddPct = peak > 0 ? ((peak - v) / peak) * 100 : 0;
    ddPctSq.push(ddPct ** 2);
  }
  return Math.sqrt(mean(ddPctSq));
}

/**
 * Value at Risk (historical, non-parametric).
 * @param returns    Per-trade fractional returns
 * @param confidence Confidence level (default: 0.95 → 95% VaR)
 * @returns          VaR as a positive number (loss at confidence level)
 */
export function historicalVaR(returns: number[], confidence = 0.95): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor((1 - confidence) * sorted.length);
  return -Math.min(sorted[Math.max(0, idx)], 0);
}

/**
 * Conditional VaR (Expected Shortfall) — average of returns below VaR.
 */
export function cvar(returns: number[], confidence = 0.95): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = Math.floor((1 - confidence) * sorted.length);
  if (cutoff === 0) return -sorted[0] > 0 ? -sorted[0] : 0;
  const tail = sorted.slice(0, cutoff);
  return -mean(tail);
}

/**
 * Win rate — fraction of trades with positive net P&L.
 */
export function winRate(pnls: number[]): number {
  if (pnls.length === 0) return 0;
  return pnls.filter((p) => p > 0).length / pnls.length;
}

/**
 * Maximum consecutive wins / losses — useful for detecting streaks.
 */
export function maxConsecutive(wins: boolean[]): { maxWinStreak: number; maxLossStreak: number } {
  let maxW = 0, maxL = 0, curW = 0, curL = 0;
  for (const w of wins) {
    if (w) { curW++; curL = 0; } else { curL++; curW = 0; }
    if (curW > maxW) maxW = curW;
    if (curL > maxL) maxL = curL;
  }
  return { maxWinStreak: maxW, maxLossStreak: maxL };
}
