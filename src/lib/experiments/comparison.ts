/**
 * comparison.ts — A/B Experiment Comparison Engine
 *
 * Compares performance across experiment arms (control vs one or more
 * experiment variants) and against external benchmarks (production strategy,
 * paper trading, index buy-hold).
 *
 * Metrics computed per arm
 * ────────────────────────
 *   • Total / average net P&L (INR and %)
 *   • Win rate
 *   • Profit factor
 *   • Sharpe ratio (annualised, excess over India risk-free rate)
 *   • Sortino ratio
 *   • Max drawdown
 *   • Average bars held
 *   • Signal count & fill rate
 *
 * Statistical significance
 * ────────────────────────
 * Two-sample Welch's t-test on per-trade returns gives a p-value for the
 * null hypothesis "arm A and arm B have the same mean return". A p-value
 * below `significanceLevel` (default 0.05) means the difference is
 * statistically significant at the chosen level.
 *
 * Confidence interval
 * ───────────────────
 * 95% CI on the difference in mean returns using a normal approximation
 * (valid when n > 30 per arm, per central limit theorem).
 *
 * All monetary values in INR.
 */

import type { ShadowTrade, ShadowSummary } from "./shadow-trader";
import type { ExperimentSignal } from "./experiment-manager";

// ── Per-arm metrics ────────────────────────────────────────────────────────────

export interface ArmMetrics {
  armId: string;
  label: string;
  /** Total closed trades. */
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Gross wins / |gross losses|. */
  profitFactor: number;
  /** Annualised Sharpe using per-trade fractional returns. */
  sharpe: number;
  /** Annualised Sortino. */
  sortino: number;
  /** Maximum peak-to-trough drawdown (0..1). */
  maxDrawdown: number;
  /** Average drawdown across all equity curve points (0..1). */
  avgDrawdown: number;
  totalNetPnlINR: number;
  avgNetPnlINR: number;
  avgReturnPct: number;
  totalReturnPct: number;
  /** Average bars held per trade. */
  avgBarsHeld: number;
  /** Total signals generated (including those not filled). */
  signalCount: number;
  /** Fraction of signals that resulted in a fill. */
  fillRate: number;
  /** Average signal confidence [0,1]. */
  avgConfidence: number;
  /** Total commission paid (INR). */
  totalCommissionINR: number;
  /** Commission as fraction of gross P&L. */
  commissionDragPct: number;
  /** Expectancy per trade (INR). */
  expectancyINR: number;
  /** Payoff ratio: avg win / avg loss. */
  payoffRatio: number;
  /** System Quality Number (Van Tharp). */
  sqn: number;
}

// ── Pairwise comparison ────────────────────────────────────────────────────────

export interface PairwiseComparison {
  /** Reference arm (typically CONTROL). */
  baseArmId: string;
  /** Arm being compared against the base. */
  compareArmId: string;
  /** Difference in mean per-trade return: compare − base. */
  meanReturnDiff: number;
  /** Difference in Sharpe: compare − base. */
  sharpeDiff: number;
  /** Difference in win rate: compare − base (e.g. 0.05 = +5pp). */
  winRateDiff: number;
  /** Difference in max drawdown: compare − base (negative = better for compare). */
  maxDrawdownDiff: number;
  /** Difference in profit factor. */
  profitFactorDiff: number;
  /** Difference in total net P&L (INR). */
  totalPnlDiff: number;

  // ── Statistical significance ────────────────────────────────────────
  /** Two-sample Welch's t-statistic. */
  tStatistic: number;
  /** Approximate p-value (two-tailed). Null when sample size is insufficient. */
  pValue: number | null;
  /** True when pValue < significanceLevel (default 0.05). */
  isSignificant: boolean;
  /** 95% confidence interval on the mean return difference [low, high]. */
  ciLow: number;
  ciHigh: number;
  /** Number of trades in the base arm. */
  nBase: number;
  /** Number of trades in the compare arm. */
  nCompare: number;
  /** Minimum recommended sample size (per arm) for 80% power at alpha=0.05. */
  minRecommendedSampleSize: number;
}

// ── Benchmark comparison ───────────────────────────────────────────────────────

export interface BenchmarkComparison {
  armId: string;
  benchmarkSource: string;
  /** Arm's total return % over the period. */
  armReturnPct: number;
  /** Benchmark's total return % over the same period. */
  benchmarkReturnPct: number;
  /** Alpha = arm return − benchmark return (percentage points). */
  alphaPct: number;
  /** Arm Sharpe. */
  armSharpe: number;
  /** Information ratio: alpha / tracking error. */
  informationRatio: number | null;
}

// ── Full comparison report ─────────────────────────────────────────────────────

export interface ComparisonReport {
  experimentId: string;
  generatedAtMs: number;
  /** Number of bars processed across the observation window. */
  observationBars: number;
  /** Per-arm metrics (all arms). */
  arms: ArmMetrics[];
  /** All pairwise comparisons (base = CONTROL arm, or first arm if no CONTROL). */
  pairwise: PairwiseComparison[];
  /** Benchmark comparisons for each arm (if benchmarks were provided). */
  benchmarks: BenchmarkComparison[];
  /** The arm with the best risk-adjusted return (highest Sharpe). */
  bestArmId: string | null;
  /** Overall winner confidence (fraction, 0–1) based on statistical tests. */
  winnerConfidence: number;
  /** Statistical significance level used. */
  significanceLevel: number;
}

// ── Input shape ────────────────────────────────────────────────────────────────

export interface ArmComparisonInput {
  armId: string;
  label: string;
  role: "CONTROL" | "EXPERIMENT";
  trades: ShadowTrade[];
  signals: ExperimentSignal[];
  summary: ShadowSummary;
  /** Equity curve values in time order (for drawdown and correlation). */
  equityValues: number[];
}

export interface BenchmarkComparisonInput {
  armId: string;
  source: string;
  /** Arm's equity curve values aligned in time with benchmark. */
  armEquityValues: number[];
  /** Benchmark values (same length as armEquityValues). */
  benchmarkValues: number[];
}

export interface ComparisonInput {
  experimentId: string;
  arms: ArmComparisonInput[];
  benchmarks?: BenchmarkComparisonInput[];
  /** Observation window in bars. */
  observationBars?: number;
  /** Statistical significance threshold. Default 0.05. */
  significanceLevel?: number;
}

// ── Engine ─────────────────────────────────────────────────────────────────────

export class ComparisonEngine {
  private readonly _significanceLevel: number;

  constructor(significanceLevel = 0.05) {
    this._significanceLevel = significanceLevel;
  }

  /**
   * Build a full comparison report from the provided arm data.
   */
  compare(input: ComparisonInput): ComparisonReport {
    const sigLevel = input.significanceLevel ?? this._significanceLevel;

    // Compute per-arm metrics
    const armMetrics: ArmMetrics[] = input.arms.map((arm) =>
      this._computeArmMetrics(arm),
    );

    // Identify control arm (fallback to first)
    const controlIdx = input.arms.findIndex((a) => a.role === "CONTROL");
    const baseIdx = controlIdx >= 0 ? controlIdx : 0;

    // Pairwise comparisons: base vs every other arm
    const pairwise: PairwiseComparison[] = [];
    for (let i = 0; i < input.arms.length; i++) {
      if (i === baseIdx) continue;
      pairwise.push(
        this._pairwise(
          input.arms[baseIdx],
          input.arms[i],
          armMetrics[baseIdx],
          armMetrics[i],
          sigLevel,
        ),
      );
    }

    // Benchmark comparisons
    const benchmarks: BenchmarkComparison[] = (input.benchmarks ?? []).map((b) =>
      this._benchmarkComparison(b, armMetrics),
    );

    // Best arm by Sharpe
    const bestArm = armMetrics.reduce<ArmMetrics | null>(
      (best, arm) => (!best || arm.sharpe > best.sharpe ? arm : best),
      null,
    );

    // Winner confidence: fraction of pairwise comparisons that are significant
    // and favour the best arm
    let winnerConfidence = 0;
    if (pairwise.length > 0 && bestArm) {
      const significantWins = pairwise.filter(
        (p) =>
          p.isSignificant &&
          (p.compareArmId === bestArm.armId
            ? p.sharpeDiff > 0
            : p.sharpeDiff < 0),
      ).length;
      winnerConfidence = significantWins / pairwise.length;
    }

    return {
      experimentId: input.experimentId,
      generatedAtMs: Date.now(),
      observationBars: input.observationBars ?? 0,
      arms: armMetrics,
      pairwise,
      benchmarks,
      bestArmId: bestArm?.armId ?? null,
      winnerConfidence,
      significanceLevel: sigLevel,
    };
  }

  // ── Per-arm metrics ──────────────────────────────────────────────────

  private _computeArmMetrics(arm: ArmComparisonInput): ArmMetrics {
    const { trades, signals, summary } = arm;
    const pnls = trades.map((t) => t.netPnl);
    const returns = trades.map((t) => t.pnlPct); // fractional
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);

    const winRate = trades.length > 0 ? wins.length / trades.length : 0;

    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const profitFactor =
      grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

    const avgPnl =
      pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    const avgReturn =
      returns.length > 0
        ? returns.reduce((a, b) => a + b, 0) / returns.length
        : 0;

    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss =
      losses.length > 0
        ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
        : 0;

    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

    const expectancyINR =
      winRate * avgWin - (1 - winRate) * avgLoss;

    const sharpe = calcSharpe(returns);
    const sortino = calcSortino(returns);

    // Drawdown from equity curve
    const maxDrawdown = calcMaxDrawdown(arm.equityValues);
    const avgDrawdown = calcAvgDrawdown(arm.equityValues);

    const avgBarsHeld =
      trades.length > 0
        ? trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length
        : 0;

    const signalCount = signals.length;
    const fillCount = trades.length; // each trade = one filled signal
    const fillRate = signalCount > 0 ? fillCount / signalCount : 0;

    const avgConfidence =
      signals.length > 0
        ? signals.reduce((a, s) => a + s.confidence, 0) / signals.length
        : 0;

    const totalCommission = trades.reduce((a, t) => a + t.commission, 0);
    const totalGrossPnl = trades.reduce((a, t) => a + t.grossPnl, 0);
    const commissionDragPct =
      totalGrossPnl !== 0 ? (totalCommission / Math.abs(totalGrossPnl)) * 100 : 0;

    // SQN: (mean / stddev) × sqrt(N), using R-multiples (pnlPct as R proxy)
    const sqn = calcSQN(returns);

    const totalNetPnl = pnls.reduce((a, b) => a + b, 0);
    const totalReturnPct =
      summary.initialCapital > 0
        ? ((summary.currentEquity - summary.initialCapital) /
            summary.initialCapital) *
          100
        : 0;

    return {
      armId: arm.armId,
      label: arm.label,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      profitFactor,
      sharpe,
      sortino,
      maxDrawdown,
      avgDrawdown,
      totalNetPnlINR: totalNetPnl,
      avgNetPnlINR: avgPnl,
      avgReturnPct: avgReturn * 100,
      totalReturnPct,
      avgBarsHeld,
      signalCount,
      fillRate,
      avgConfidence,
      totalCommissionINR: totalCommission,
      commissionDragPct,
      expectancyINR,
      payoffRatio,
      sqn,
    };
  }

  // ── Pairwise ─────────────────────────────────────────────────────────

  private _pairwise(
    base: ArmComparisonInput,
    compare: ArmComparisonInput,
    baseMet: ArmMetrics,
    compMet: ArmMetrics,
    sigLevel: number,
  ): PairwiseComparison {
    const baseReturns = base.trades.map((t) => t.pnlPct);
    const compareReturns = compare.trades.map((t) => t.pnlPct);

    const nBase = baseReturns.length;
    const nCompare = compareReturns.length;

    const meanReturnDiff = compMet.avgReturnPct / 100 - baseMet.avgReturnPct / 100;
    const sharpeDiff = compMet.sharpe - baseMet.sharpe;
    const winRateDiff = compMet.winRate - baseMet.winRate;
    const maxDrawdownDiff = compMet.maxDrawdown - baseMet.maxDrawdown;
    const profitFactorDiff =
      isFinite(compMet.profitFactor) && isFinite(baseMet.profitFactor)
        ? compMet.profitFactor - baseMet.profitFactor
        : 0;
    const totalPnlDiff = compMet.totalNetPnlINR - baseMet.totalNetPnlINR;

    // Welch's t-test
    let tStatistic = 0;
    let pValue: number | null = null;
    let ciLow = 0;
    let ciHigh = 0;

    if (nBase >= 2 && nCompare >= 2) {
      const baseMean = mean(baseReturns);
      const compareMean = mean(compareReturns);
      const baseVar = variance(baseReturns);
      const compareVar = variance(compareReturns);

      const se = Math.sqrt(baseVar / nBase + compareVar / nCompare);
      if (se > 0) {
        tStatistic = (compareMean - baseMean) / se;

        // Welch–Satterthwaite degrees of freedom
        const df = welchDF(baseVar, nBase, compareVar, nCompare);
        pValue = twoTailedPValue(tStatistic, df);

        // 95% CI on mean difference (z-approximation when df > 30)
        const zCrit = df > 30 ? 1.96 : tCritical(df, 0.05);
        ciLow = compareMean - baseMean - zCrit * se;
        ciHigh = compareMean - baseMean + zCrit * se;
      }
    }

    const isSignificant =
      pValue !== null ? pValue < sigLevel : false;

    // Min recommended sample size for 80% power, alpha=0.05 (heuristic)
    const minRecommendedSampleSize = estimateMinSampleSize(
      baseMet.avgReturnPct / 100,
      compMet.avgReturnPct / 100,
      baseMet.sharpe,
    );

    return {
      baseArmId: base.armId,
      compareArmId: compare.armId,
      meanReturnDiff,
      sharpeDiff,
      winRateDiff,
      maxDrawdownDiff,
      profitFactorDiff,
      totalPnlDiff,
      tStatistic,
      pValue,
      isSignificant,
      ciLow,
      ciHigh,
      nBase,
      nCompare,
      minRecommendedSampleSize,
    };
  }

  // ── Benchmark ─────────────────────────────────────────────────────────

  private _benchmarkComparison(
    b: BenchmarkComparisonInput,
    armMetrics: ArmMetrics[],
  ): BenchmarkComparison {
    const arm = armMetrics.find((m) => m.armId === b.armId);
    const armSharpe = arm?.sharpe ?? 0;

    const armReturn = totalReturn(b.armEquityValues);
    const benchReturn = totalReturn(b.benchmarkValues);
    const alphaPct = armReturn - benchReturn;

    // Information ratio: alpha / tracking error
    let informationRatio: number | null = null;
    if (b.armEquityValues.length >= 2 && b.benchmarkValues.length >= 2) {
      const minLen = Math.min(b.armEquityValues.length, b.benchmarkValues.length);
      const armRets = periodReturns(b.armEquityValues.slice(0, minLen));
      const benchRets = periodReturns(b.benchmarkValues.slice(0, minLen));
      const activeDiffs = armRets.map((r, i) => r - (benchRets[i] ?? 0));
      const te = stddev(activeDiffs);
      const activeMean = mean(activeDiffs);
      informationRatio = te > 0 ? activeMean / te : null;
    }

    return {
      armId: b.armId,
      benchmarkSource: b.source,
      armReturnPct: armReturn * 100,
      benchmarkReturnPct: benchReturn * 100,
      alphaPct: alphaPct * 100,
      armSharpe,
      informationRatio,
    };
  }
}

// ── Pure metric helpers ────────────────────────────────────────────────────────

const TRADING_DAYS = 252;
const RF_RATE = 0.065; // India 10Y G-Sec

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
}

function stddev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const rfPerTrade = RF_RATE / TRADING_DAYS;
  const excess = returns.map((r) => r - rfPerTrade);
  const m = mean(excess);
  const s = stddev(excess);
  return s === 0 ? 0 : (m / s) * Math.sqrt(TRADING_DAYS);
}

function calcSortino(returns: number[]): number {
  if (returns.length < 2) return 0;
  const rfPerTrade = RF_RATE / TRADING_DAYS;
  const excess = returns.map((r) => r - rfPerTrade);
  const m = mean(excess);
  const neg = excess.filter((r) => r < 0);
  const downsideVar = neg.length > 0
    ? neg.reduce((acc, r) => acc + r ** 2, 0) / neg.length
    : 0;
  const downsideStd = Math.sqrt(downsideVar);
  return downsideStd === 0 ? (m > 0 ? Infinity : 0) : (m / downsideStd) * Math.sqrt(TRADING_DAYS);
}

function calcMaxDrawdown(equityValues: number[]): number {
  if (equityValues.length === 0) return 0;
  let peak = equityValues[0];
  let maxDD = 0;
  for (const v of equityValues) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function calcAvgDrawdown(equityValues: number[]): number {
  if (equityValues.length === 0) return 0;
  let peak = equityValues[0];
  const dds: number[] = [];
  for (const v of equityValues) {
    if (v > peak) peak = v;
    dds.push(peak > 0 ? (peak - v) / peak : 0);
  }
  return mean(dds);
}

function calcSQN(returns: number[]): number {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const s = stddev(returns);
  return s === 0 ? 0 : (m / s) * Math.sqrt(returns.length);
}

function totalReturn(equityValues: number[]): number {
  if (equityValues.length < 2) return 0;
  const start = equityValues[0];
  const end = equityValues[equityValues.length - 1];
  return start > 0 ? (end - start) / start : 0;
}

function periodReturns(equityValues: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < equityValues.length; i++) {
    const prev = equityValues[i - 1];
    rets.push(prev > 0 ? (equityValues[i] - prev) / prev : 0);
  }
  return rets;
}

// ── Statistical helpers ────────────────────────────────────────────────────────

/** Welch–Satterthwaite degrees of freedom. */
function welchDF(v1: number, n1: number, v2: number, n2: number): number {
  const num = (v1 / n1 + v2 / n2) ** 2;
  const den = (v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1);
  return den > 0 ? num / den : 1;
}

/**
 * Two-tailed p-value approximation from t-statistic and degrees of freedom.
 * Uses a rational approximation of the normal CDF for df > 30,
 * otherwise a lookup-table approximation for small samples.
 */
function twoTailedPValue(t: number, df: number): number {
  const absT = Math.abs(t);

  if (df > 30) {
    // Normal approximation
    return 2 * (1 - normalCDF(absT));
  }

  // Simple t-distribution approximation (Cornish-Fisher style)
  // Accurate to ±0.01 for df >= 5
  const x = df / (df + absT * absT);
  const p = incompleteBeta(df / 2, 0.5, x);
  return Math.min(1, Math.max(0, p));
}

/** Standard normal CDF via rational approximation (Abramowitz & Stegun 26.2.17). */
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
  return z >= 0 ? 1 - phi : phi;
}

/**
 * Regularised incomplete beta function approximation for p-value from t-dist.
 * Uses continued fraction expansion (Lentz method, truncated at 50 iterations).
 */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use symmetry relation when x > (a+1)/(a+b+2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(b, a, 1 - x);
  }

  // Lentz continued fraction
  const lnBeta =
    lgamma(a) + lgamma(b) - lgamma(a + b);
  const front =
    Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  let f = 1;
  let C = 1;
  let D = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(D) < 1e-30) D = 1e-30;
  D = 1 / D;
  f = D;

  for (let m = 1; m <= 50; m++) {
    // Even step
    let numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    D = 1 + numerator * D;
    if (Math.abs(D) < 1e-30) D = 1e-30;
    C = 1 + numerator / C;
    if (Math.abs(C) < 1e-30) C = 1e-30;
    D = 1 / D;
    f *= C * D;

    // Odd step
    numerator =
      -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    D = 1 + numerator * D;
    if (Math.abs(D) < 1e-30) D = 1e-30;
    C = 1 + numerator / C;
    if (Math.abs(C) < 1e-30) C = 1e-30;
    D = 1 / D;
    const delta = C * D;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-7) break;
  }

  return front * f;
}

/** Log-gamma approximation (Stirling series, good to < 1e-9 for a > 5). */
function lgamma(a: number): number {
  if (a < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * a)) - lgamma(1 - a);
  a -= 1;
  let x =
    0.99999999999980993 +
    676.5203681218851 / (a + 1) -
    1259.1392167224028 / (a + 2) +
    771.32342877765313 / (a + 3) -
    176.61502916214059 / (a + 4) +
    12.507343278686905 / (a + 5) -
    0.13857109526572012 / (a + 6) +
    9.9843695780195716e-6 / (a + 7) +
    1.5056327351493116e-7 / (a + 8);
  const t = a + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (a + 0.5) * Math.log(t) -
    t +
    Math.log(x)
  );
}

/** Critical t-value for two-tailed test at given alpha and df (lookup table). */
function tCritical(df: number, alpha: number): number {
  // Common critical values for alpha=0.05 two-tailed
  if (alpha === 0.05) {
    const table: Record<number, number> = {
      1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
      6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
      15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042,
    };
    const rounded = Math.round(df);
    if (table[rounded]) return table[rounded];
    if (df > 30) return 1.96;
  }
  return 1.96; // fallback
}

/**
 * Heuristic minimum sample size per arm for 80% power at alpha=0.05.
 * Based on Cohen's d effect size using the expected Sharpe difference.
 */
function estimateMinSampleSize(
  baseMean: number,
  compareMean: number,
  baseSharpe: number,
): number {
  const effectSize = Math.abs(compareMean - baseMean);
  if (effectSize < 1e-9) return 200; // underpowered by default

  // σ ≈ mean / Sharpe (very rough approximation)
  const approxSd = baseSharpe > 0 ? Math.abs(baseMean) / (baseSharpe / Math.sqrt(TRADING_DAYS)) : 0.02;
  const cohenD = approxSd > 0 ? effectSize / approxSd : 0;

  // n ≈ 2 × ((z_α + z_β) / d)² — Cohen (1988)
  // z_α/2 = 1.96 (two-tailed α=0.05), z_β = 0.84 (80% power)
  if (cohenD < 1e-6) return 200;
  const n = 2 * ((1.96 + 0.84) / cohenD) ** 2;
  return Math.max(30, Math.ceil(n));
}

// ── Singleton engine ───────────────────────────────────────────────────────────

export const comparisonEngine = new ComparisonEngine();
