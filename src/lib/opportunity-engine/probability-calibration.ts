/**
 * Probability Calibration Engine
 *
 * Validates that predicted probabilities match observed outcome frequencies.
 * A system predicting 70% win rate should actually win ~70% of the time.
 *
 * Methods:
 *   1. Reliability curve: bin predictions into 10 buckets, compare to actuals
 *   2. Platt scaling: logistic regression to recalibrate
 *   3. Isotonic regression: monotone step function
 *   4. Brier score: mean squared error of probability predictions
 *   5. Expected Calibration Error (ECE): weighted avg bin calibration error
 *
 * Sample-size awareness:
 *   Calibration with < 50 trades is unreliable. The system must display
 *   confidence intervals and avoid over-trusting small samples.
 *
 * Signal quality tier grading:
 *   A+ / A / B / C / D / REJECT thresholds must be validated against
 *   observed outcomes to confirm score monotonicity.
 *
 * This module is I/O-free.
 */

import type { QualityTier } from "./types";

// ─── Calibration Bin ──────────────────────────────────────────────────────────

export interface CalibrationBin {
  lowerBound: number;
  upperBound: number;
  midpoint: number;
  predictedProbMean: number;   // avg predicted probability in this bin
  actualWinRate: number;       // observed fraction that won
  sampleCount: number;
  confidence95: [number, number]; // 95% CI on actual win rate
  isReliable: boolean;         // true if sampleCount >= 20
}

// ─── Calibration Report ───────────────────────────────────────────────────────

export interface CalibrationReport {
  strategyId: string;
  totalTrades: number;
  brierScore: number;          // lower = better, perfect = 0, baseline = 0.25
  ece: number;                 // Expected Calibration Error, lower = better
  maxCalibrationError: number; // MCE — worst single bin error
  bins: CalibrationBin[];
  wellCalibrated: boolean;     // ECE < 0.07 AND at least 50 trades
  overconfident: boolean;      // predicted probs systematically > actual rates
  underconfident: boolean;
  monotonic: boolean;          // higher bins have higher actual win rates
  sampleSizeAdequate: boolean; // >= 50 resolved trades
  computedAt: number;

  // Score monotonicity: does higher predicted score → higher actual win rate?
  scoreBuckets: ScoreBucketStats[];
}

export interface ScoreBucketStats {
  bucketLabel: string;         // e.g. "0–20", "20–40", etc.
  scoreMin: number;
  scoreMax: number;
  count: number;
  winRate: number;
  avgR: number;                // average R-multiple
  expectancy: number;          // avg P&L %
  profitFactor: number;
  isMonotonicWithPrev: boolean; // true if win rate >= previous bucket
}

// ─── Sample-Size Aware Confidence Interval ────────────────────────────────────

/**
 * Wilson confidence interval for a proportion.
 * More accurate than normal approximation for small samples.
 */
function wilsonInterval(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ─── Calibration Computation ──────────────────────────────────────────────────

export interface TradeOutcome {
  predictedProbability: number;  // [0, 1] predicted win probability
  score: number;                  // [0, 100] quality score
  won: boolean;                   // did the trade win?
  pnlPct: number | null;          // realized P&L %
}

/**
 * Compute a full calibration report from a set of resolved trade outcomes.
 */
export function computeCalibrationReport(
  strategyId: string,
  outcomes: TradeOutcome[],
  numBins = 10,
): CalibrationReport {
  const now = Date.now();
  const N = outcomes.length;

  if (N === 0) {
    return emptyCalibrationReport(strategyId, now);
  }

  // ── Probability calibration bins ────────────────────────────────────────
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < numBins; b++) {
    const lower = b / numBins;
    const upper = (b + 1) / numBins;
    const inBin = outcomes.filter(o => o.predictedProbability >= lower && o.predictedProbability < upper);

    if (inBin.length === 0) {
      bins.push({
        lowerBound: lower, upperBound: upper, midpoint: (lower + upper) / 2,
        predictedProbMean: (lower + upper) / 2, actualWinRate: 0,
        sampleCount: 0, confidence95: [0, 1], isReliable: false,
      });
      continue;
    }

    const wins = inBin.filter(o => o.won).length;
    const actualWinRate = wins / inBin.length;
    const predictedProbMean = inBin.reduce((s, o) => s + o.predictedProbability, 0) / inBin.length;
    const ci = wilsonInterval(wins, inBin.length);

    bins.push({
      lowerBound: lower, upperBound: upper, midpoint: (lower + upper) / 2,
      predictedProbMean, actualWinRate, sampleCount: inBin.length,
      confidence95: ci, isReliable: inBin.length >= 20,
    });
  }

  // ── Brier Score ──────────────────────────────────────────────────────────
  const brierScore = outcomes.reduce((s, o) => {
    const y = o.won ? 1 : 0;
    return s + (o.predictedProbability - y) ** 2;
  }, 0) / N;

  // ── ECE ──────────────────────────────────────────────────────────────────
  const ece = bins.reduce((s, bin) => {
    if (bin.sampleCount === 0) return s;
    return s + (bin.sampleCount / N) * Math.abs(bin.predictedProbMean - bin.actualWinRate);
  }, 0);

  // ── MCE ──────────────────────────────────────────────────────────────────
  const maxCalibrationError = Math.max(...bins.map(b => b.sampleCount > 0 ? Math.abs(b.predictedProbMean - b.actualWinRate) : 0));

  // ── Overconfidence/underconfidence ────────────────────────────────────────
  const reliableBins = bins.filter(b => b.isReliable);
  const avgPredicted = reliableBins.reduce((s, b) => s + b.predictedProbMean, 0) / Math.max(1, reliableBins.length);
  const avgActual = reliableBins.reduce((s, b) => s + b.actualWinRate, 0) / Math.max(1, reliableBins.length);
  const overconfident = avgPredicted > avgActual + 0.05;
  const underconfident = avgActual > avgPredicted + 0.05;

  // ── Monotonicity ─────────────────────────────────────────────────────────
  const filledBins = bins.filter(b => b.sampleCount > 0);
  let monotonic = true;
  for (let i = 1; i < filledBins.length; i++) {
    if (filledBins[i].actualWinRate < filledBins[i - 1].actualWinRate - 0.05) {
      monotonic = false;
      break;
    }
  }

  // ── Score bucket analysis (0-20, 20-40, 40-60, 60-70, 70-80, 80-90, 90-100) ──
  const scoreBucketDefs = [
    [0, 20], [20, 40], [40, 60], [60, 70], [70, 80], [80, 90], [90, 100],
  ];
  const scoreBuckets: ScoreBucketStats[] = scoreBucketDefs.map(([min, max], idx) => {
    const inBucket = outcomes.filter(o => o.score >= min && o.score < max);
    const wins = inBucket.filter(o => o.won).length;
    const losses = inBucket.length - wins;
    const pnls = inBucket.filter(o => o.pnlPct !== null).map(o => o.pnlPct!);
    const avgR = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    const winPnls = inBucket.filter(o => o.won && o.pnlPct !== null).map(o => o.pnlPct!);
    const lossPnls = inBucket.filter(o => !o.won && o.pnlPct !== null).map(o => o.pnlPct!);
    const avgWinPnl = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
    const avgLossPnl = lossPnls.length > 0 ? Math.abs(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length) : 0;
    const profitFactor = avgLossPnl > 0 && wins > 0 ? (avgWinPnl * wins) / (avgLossPnl * losses) : 0;
    const expectancy = inBucket.length > 0 ? avgR : 0;

    return {
      bucketLabel: `${min}–${max}`,
      scoreMin: min, scoreMax: max,
      count: inBucket.length,
      winRate: inBucket.length > 0 ? wins / inBucket.length : 0,
      avgR,
      expectancy,
      profitFactor,
      isMonotonicWithPrev: true, // filled in below
    };
  });

  // Fill in monotonicity with respect to previous non-empty bucket
  let prevWinRate = 0;
  for (const bucket of scoreBuckets) {
    if (bucket.count >= 5) {
      bucket.isMonotonicWithPrev = bucket.winRate >= prevWinRate - 0.05;
      prevWinRate = bucket.winRate;
    }
  }

  return {
    strategyId,
    totalTrades: N,
    brierScore,
    ece,
    maxCalibrationError,
    bins,
    wellCalibrated: ece < 0.07 && N >= 50,
    overconfident,
    underconfident,
    monotonic,
    sampleSizeAdequate: N >= 50,
    computedAt: now,
    scoreBuckets,
  };
}

function emptyCalibrationReport(strategyId: string, now: number): CalibrationReport {
  return {
    strategyId, totalTrades: 0, brierScore: 0.25, ece: 1, maxCalibrationError: 1,
    bins: [], wellCalibrated: false, overconfident: false, underconfident: false,
    monotonic: false, sampleSizeAdequate: false, computedAt: now, scoreBuckets: [],
  };
}

// ─── Quality Tier Grading (Evidence-Based) ────────────────────────────────────

export interface QualityTierThresholds {
  minQualityScore: number;
  minNetEV: number;
  minLiquidityScore: number;
  requireNoHardRejections: boolean;
  requirePositiveRegimeFit: boolean;
}

/**
 * Grade a signal into quality tiers based on EV and quality vector.
 * These thresholds are evidence-based — derived from the calibration report
 * once sufficient data is available. Until then, conservative priors are used.
 */
export function gradeOpportunityTier(
  qualityScore: number,     // [0, 1] composite quality
  netEV: number,            // net expected value %
  liquidityScore: number,   // [0, 1]
  hasHardRejection: boolean,
  regimeScore: number,      // [0, 1]
  calibrationReport: CalibrationReport | null,
): QualityTier {
  // Hard rejection always overrides
  if (hasHardRejection) return "REJECT";

  // Use calibration data if available and adequate
  if (calibrationReport && calibrationReport.sampleSizeAdequate && calibrationReport.monotonic) {
    // Find the score bucket with this quality score
    const scoreBucket = calibrationReport.scoreBuckets.find(
      b => qualityScore * 100 >= b.scoreMin && qualityScore * 100 < b.scoreMax
    );
    if (scoreBucket && scoreBucket.count >= 10) {
      // Use observed win rate from calibration data
      const obsWinRate = scoreBucket.winRate;
      const obsExpectancy = scoreBucket.expectancy;
      if (obsWinRate < 0.35 || obsExpectancy < -0.5) return "REJECT";
      if (obsWinRate < 0.40) return "D";
      if (obsWinRate < 0.48) return "C";
      if (obsWinRate < 0.55) return "B";
      if (obsWinRate < 0.62) return "A";
      return "A_PLUS";
    }
  }

  // Fall back to prior thresholds (conservative)
  if (liquidityScore < 0.25 || netEV < -0.1) return "REJECT";
  if (netEV < 0 && qualityScore < 0.45) return "REJECT";

  if (netEV > 0.5 && qualityScore > 0.75 && liquidityScore > 0.7 && regimeScore > 0.6) return "A_PLUS";
  if (netEV > 0.2 && qualityScore > 0.65 && liquidityScore > 0.55) return "A";
  if (netEV > 0.0 && qualityScore > 0.50 && liquidityScore > 0.40) return "B";
  if (netEV > -0.05 && qualityScore > 0.40) return "C";
  if (qualityScore > 0.30) return "D";
  return "REJECT";
}

// ─── Sample-Size Aware Performance Metric ────────────────────────────────────

export interface SampleAwareMetric {
  value: number;
  lowerCI: number;      // 95% confidence interval lower bound
  upperCI: number;      // 95% CI upper bound
  sampleSize: number;
  reliable: boolean;    // true if sample >= 30
  effectiveShrinkage: number; // how much the value was shrunk toward prior
}

/**
 * Compute a Bayesian-shrunk win rate with confidence interval.
 * Shrinks toward a conservative prior (50%) when sample is small.
 */
export function computeShrunkenWinRate(
  wins: number,
  total: number,
  prior: number = 0.50,
  priorStrength: number = 10, // pseudo-counts
): SampleAwareMetric {
  if (total === 0) {
    return { value: prior, lowerCI: 0.20, upperCI: 0.80, sampleSize: 0, reliable: false, effectiveShrinkage: 1 };
  }

  // Bayesian shrinkage: weight(prior × priorStrength + observed wins) / (priorStrength + total)
  const shrunkWins = priorStrength * prior + wins;
  const shrunkTotal = priorStrength + total;
  const value = shrunkWins / shrunkTotal;

  const ci = wilsonInterval(Math.round(value * total), total);
  const rawWinRate = wins / total;
  const effectiveShrinkage = Math.abs(value - rawWinRate) / Math.max(Math.abs(prior - rawWinRate), 0.001);

  return {
    value,
    lowerCI: ci[0],
    upperCI: ci[1],
    sampleSize: total,
    reliable: total >= 30,
    effectiveShrinkage: Math.min(1, effectiveShrinkage),
  };
}
