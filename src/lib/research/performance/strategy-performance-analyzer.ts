/**
 * Phase 5 — Strategy Performance Analyzer
 *
 * Computes the full canonical scorecard for every strategy.
 * All metrics must be computed separately for each performance period
 * (IN_SAMPLE, VALIDATION, FINAL_OOS, PAPER, SHADOW).
 *
 * Critical: NEVER pass in-sample data as OOS. The caller is responsible
 * for ensuring the trade list corresponds to the correct period.
 */

import type {
  PerformanceMetrics,
  StrategyPerformanceReport,
  PerformancePeriod,
} from "../types";

// ─── Trade record expected by the analyzer ───────────────────────────────────

export interface AnalyzerTrade {
  /** Fractional return of the trade (0.02 = +2%, -0.01 = -1%) */
  returnPct: number;
  /** Duration in bars */
  holdBars: number;
  /** Notional value of the trade */
  notionalValue: number;
}

// ─── Core Statistics ──────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[], ddof = 1): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - ddof);
  return Math.sqrt(variance);
}

function skewness(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  const s = stdDev(arr);
  if (s === 0) return 0;
  const n = arr.length;
  const sum3 = arr.reduce((a, v) => a + ((v - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum3;
}

function kurtosis(arr: number[]): number {
  if (arr.length < 4) return 0;
  const m = mean(arr);
  const s = stdDev(arr);
  if (s === 0) return 0;
  const n = arr.length;
  const sum4 = arr.reduce((a, v) => a + ((v - m) / s) ** 4, 0);
  const raw = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum4;
  const correction = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return raw - correction; // excess kurtosis
}

/**
 * Convert a series of trade returns to an equity curve.
 * Equity starts at 1.0 and compounds multiplicatively.
 */
function buildEquityCurve(tradeReturns: number[]): number[] {
  const curve: number[] = [1.0];
  for (const r of tradeReturns) {
    curve.push(curve[curve.length - 1] * (1 + r));
  }
  return curve;
}

/**
 * Compute maximum drawdown from an equity curve.
 * Returns the maximum percentage decline from any peak.
 */
function maxDrawdownFromCurve(curve: number[]): { maxDrawdown: number; duration: number } {
  let peak = curve[0];
  let maxDd = 0;
  let ddStart = 0;
  let maxDuration = 0;
  let currentDuration = 0;

  for (let i = 1; i < curve.length; i++) {
    if (curve[i] > peak) {
      peak = curve[i];
      ddStart = i;
      currentDuration = 0;
    } else {
      currentDuration++;
      const dd = (peak - curve[i]) / peak;
      if (dd > maxDd) {
        maxDd = dd;
        maxDuration = currentDuration;
      }
    }
  }
  return { maxDrawdown: maxDd, duration: maxDuration };
}

/**
 * Ulcer Index — root mean square of percentage drawdowns.
 * Penalises both depth and duration of drawdowns.
 */
function ulcerIndex(curve: number[]): number {
  let peak = curve[0];
  const ddSquared: number[] = [];
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0;
    ddSquared.push(dd * dd);
  }
  return Math.sqrt(mean(ddSquared));
}

/**
 * System Quality Number (Van Tharp).
 * SQN = (mean_trade_return / std_trade_return) × sqrt(trade_count)
 * > 2.0 = good, > 3.0 = excellent, > 5.0 = superb
 */
function sqn(tradeReturns: number[]): number {
  if (tradeReturns.length < 10) return 0;
  const m = mean(tradeReturns);
  const s = stdDev(tradeReturns);
  if (s === 0) return 0;
  return (m / s) * Math.sqrt(tradeReturns.length);
}

/**
 * Two-tailed t-test: H₀ = mean return = 0.
 * Returns { tStat, pValue }.
 */
function tTest(tradeReturns: number[]): { tStatistic: number; pValue: number } {
  const n = tradeReturns.length;
  if (n < 5) return { tStatistic: 0, pValue: 1 };
  const m = mean(tradeReturns);
  const s = stdDev(tradeReturns);
  if (s === 0) return { tStatistic: 0, pValue: 1 };
  const tStat = m / (s / Math.sqrt(n));
  // Approximate p-value using normal distribution for large n;
  // for small n this is an approximation
  const pValue = 2 * (1 - normalCdf(Math.abs(tStat)));
  return { tStatistic: tStat, pValue };
}

/** Standard normal CDF approximation (Abramowitz & Stegun 26.2.17) */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-0.5 * x * x);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x >= 0 ? 1 - p : p;
}

// ─── Main Metrics Computation ─────────────────────────────────────────────────

/**
 * Compute the full PerformanceMetrics scorecard for a list of trades.
 *
 * @param trades        List of trades for this period
 * @param period        Which research period these trades belong to
 * @param annualFactor  Number of trading periods per year (252 for daily, 52 for weekly, 12 for monthly)
 * @param riskFreeRate  Annual risk-free rate (default 0.065 = 6.5% Indian G-Sec)
 */
export function computePerformanceMetrics(
  trades: AnalyzerTrade[],
  period: PerformancePeriod,
  annualFactor: number = 252,
  riskFreeRate: number = 0.065,
): PerformanceMetrics {
  if (trades.length === 0) {
    return zeroMetrics(period);
  }

  const returns = trades.map((t) => t.returnPct);
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct < 0);

  const tradeCount = trades.length;
  const winRate = tradeCount > 0 ? wins.length / tradeCount : 0;
  const lossRate = tradeCount > 0 ? losses.length / tradeCount : 0;

  const avgWin = wins.length > 0 ? mean(wins.map((t) => t.returnPct)) : 0;
  const avgLoss = losses.length > 0 ? mean(losses.map((t) => t.returnPct)) : 0;
  const payoffRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  const grossWins = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  const expectancy = winRate * avgWin + lossRate * avgLoss;

  const curve = buildEquityCurve(returns);
  const totalReturn = curve[curve.length - 1] - 1;
  const { maxDrawdown, duration: drawdownDuration } = maxDrawdownFromCurve(curve);

  // CAGR: annualised from total return using trade count as proxy for duration
  const yearsEquiv = tradeCount / annualFactor;
  const cagr = yearsEquiv > 0 ? Math.pow(1 + totalReturn, 1 / yearsEquiv) - 1 : 0;

  const vol = stdDev(returns) * Math.sqrt(annualFactor);
  const rfPerTrade = riskFreeRate / annualFactor;

  const sharpe = vol > 0 ? ((cagr - riskFreeRate) / vol) : 0;

  const downsideReturns = returns.filter((r) => r < rfPerTrade);
  const downsideVol =
    downsideReturns.length > 0
      ? stdDev(downsideReturns) * Math.sqrt(annualFactor)
      : 0;
  const sortino = downsideVol > 0 ? (cagr - riskFreeRate) / downsideVol : 0;

  const calmar = maxDrawdown > 0 ? cagr / maxDrawdown : 0;

  // Average drawdown
  let peak = curve[0];
  const dds: number[] = [];
  for (const v of curve) {
    if (v > peak) peak = v;
    dds.push(peak > 0 ? (peak - v) / peak : 0);
  }
  const averageDrawdown = mean(dds);

  const ui = ulcerIndex(curve);
  const sqnScore = sqn(returns);

  // Turnover: average notional per trade / estimated portfolio size
  // Approximated as trades per year (no portfolio size reference here)
  const avgHoldBars = mean(trades.map((t) => t.holdBars));
  const tradesPerMonth = annualFactor > 0 ? (tradeCount / annualFactor) * (annualFactor / 12) : 0;
  const turnover = tradeCount;

  // Exposure time: fraction of bars in market (rough, requires total bar count from caller)
  const exposureTime = 0; // populated by integration layer that knows total bars

  const sortedReturns = [...returns].sort((a, b) => a - b);
  const tailLossIdx = Math.floor(returns.length * 0.05);
  const tailLoss = sortedReturns[tailLossIdx] ?? sortedReturns[0] ?? 0;

  const sk = skewness(returns);
  const kurt = kurtosis(returns);

  const { tStatistic, pValue } = tTest(returns);

  return {
    period,
    totalReturn,
    cagr,
    volatility: vol,
    sharpe,
    sortino,
    calmar,
    profitFactor,
    winRate,
    lossRate,
    expectancy,
    averageWin: avgWin,
    averageLoss: avgLoss,
    payoffRatio,
    maxDrawdown,
    averageDrawdown,
    drawdownDuration,
    ulcerIndex: ui,
    sqn: sqnScore,
    turnover,
    averageHoldTime: avgHoldBars,
    tradeCount,
    tradesPerMonth,
    exposureTime,
    bestTrade: Math.max(...returns),
    worstTrade: Math.min(...returns),
    tailLoss,
    skewness: sk,
    kurtosis: kurt,
    tStatistic,
    pValue,
    statisticallySignificant: pValue < 0.05,
  };
}

function zeroMetrics(period: PerformancePeriod): PerformanceMetrics {
  return {
    period,
    totalReturn: 0,
    cagr: 0,
    volatility: 0,
    sharpe: 0,
    sortino: 0,
    calmar: 0,
    profitFactor: 0,
    winRate: 0,
    lossRate: 0,
    expectancy: 0,
    averageWin: 0,
    averageLoss: 0,
    payoffRatio: 0,
    maxDrawdown: 0,
    averageDrawdown: 0,
    drawdownDuration: 0,
    ulcerIndex: 0,
    sqn: 0,
    turnover: 0,
    averageHoldTime: 0,
    tradeCount: 0,
    tradesPerMonth: 0,
    exposureTime: 0,
    bestTrade: 0,
    worstTrade: 0,
    tailLoss: 0,
    skewness: 0,
    kurtosis: 0,
    tStatistic: 0,
    pValue: 1,
    statisticallySignificant: false,
  };
}

// ─── Report Builder ───────────────────────────────────────────────────────────

export interface PerformanceInput {
  inSampleTrades?: AnalyzerTrade[];
  validationTrades?: AnalyzerTrade[];
  finalOosTrades?: AnalyzerTrade[];
  paperTrades?: AnalyzerTrade[];
  shadowTrades?: AnalyzerTrade[];
  annualFactor?: number;
  riskFreeRate?: number;
}

export function buildPerformanceReport(
  strategyId: string,
  datasetVersion: string,
  input: PerformanceInput,
): StrategyPerformanceReport {
  const { annualFactor = 252, riskFreeRate = 0.065 } = input;
  return {
    strategyId,
    datasetVersion,
    computedAt: new Date().toISOString(),
    inSample: input.inSampleTrades?.length
      ? computePerformanceMetrics(input.inSampleTrades, "IN_SAMPLE", annualFactor, riskFreeRate)
      : null,
    validation: input.validationTrades?.length
      ? computePerformanceMetrics(input.validationTrades, "VALIDATION", annualFactor, riskFreeRate)
      : null,
    finalOos: input.finalOosTrades?.length
      ? computePerformanceMetrics(input.finalOosTrades, "FINAL_OOS", annualFactor, riskFreeRate)
      : null,
    paper: input.paperTrades?.length
      ? computePerformanceMetrics(input.paperTrades, "PAPER", annualFactor, riskFreeRate)
      : null,
    shadow: input.shadowTrades?.length
      ? computePerformanceMetrics(input.shadowTrades, "SHADOW", annualFactor, riskFreeRate)
      : null,
  };
}
