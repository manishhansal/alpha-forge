/**
 * Phase 14 — Signal Quality Analysis & Calibration
 *
 * A signal that claims 70% win probability should win approximately 70%
 * of the time.  Miscalibrated confidence is dangerous because it leads
 * to over/under-sizing.
 *
 * Metrics:
 *   - Brier Score: mean squared error between predicted probability and outcome
 *     0 = perfect, 0.25 = no-skill (constant 0.5 prediction), 1 = perfect inverse
 *   - ECE (Expected Calibration Error): weighted mean absolute deviation of
 *     predicted probability from actual win rate within bins
 *   - Calibration curve: reliability diagram data
 *   - Well-calibrated: ECE < 0.05
 */

import type { SignalCalibrationBin, SignalCalibrationResult } from "../types";

// ─── Signal Outcome Record ────────────────────────────────────────────────────

export interface SignalOutcome {
  /** Predicted win probability at signal time [0, 1] */
  predictedWinProb: number;
  /** 1 if trade won (hit target), 0 if lost (hit stop or expired) */
  actualOutcome: 0 | 1;
}

// ─── Brier Score ──────────────────────────────────────────────────────────────

/**
 * Compute the Brier Score for a set of probabilistic predictions.
 * Lower is better; 0.25 = no-skill baseline (predicting 0.5 always).
 */
export function brierScore(outcomes: SignalOutcome[]): number {
  if (outcomes.length === 0) return 0.25;
  const sumSqErr = outcomes.reduce(
    (s, o) => s + (o.predictedWinProb - o.actualOutcome) ** 2,
    0,
  );
  return sumSqErr / outcomes.length;
}

// ─── Calibration Binning ──────────────────────────────────────────────────────

/**
 * Bin signals by predicted probability and compute actual win rate in each bin.
 * Default 10 equal-width bins from 0 to 1.
 */
export function computeCalibrationBins(
  outcomes: SignalOutcome[],
  nBins: number = 10,
): SignalCalibrationBin[] {
  const bins: SignalCalibrationBin[] = [];
  const binWidth = 1 / nBins;

  for (let i = 0; i < nBins; i++) {
    const lower = i * binWidth;
    const upper = lower + binWidth;
    const inBin = outcomes.filter(
      (o) => o.predictedWinProb >= lower && o.predictedWinProb < upper,
    );
    const wins = inBin.filter((o) => o.actualOutcome === 1).length;
    const meanPredicted =
      inBin.length > 0
        ? inBin.reduce((s, o) => s + o.predictedWinProb, 0) / inBin.length
        : (lower + upper) / 2;

    bins.push({
      lowerBound: lower,
      upperBound: upper,
      predictedWinProb: meanPredicted,
      actualWinRate: inBin.length > 0 ? wins / inBin.length : 0,
      sampleCount: inBin.length,
    });
  }

  return bins;
}

// ─── Expected Calibration Error ───────────────────────────────────────────────

/**
 * Compute ECE: weighted mean absolute error between predicted and actual.
 * Weights each bin by its sample fraction.
 */
export function expectedCalibrationError(
  bins: SignalCalibrationBin[],
  totalSamples: number,
): number {
  if (totalSamples === 0) return 0;
  const weightedErr = bins.reduce(
    (s, bin) =>
      s + (bin.sampleCount / totalSamples) * Math.abs(bin.predictedWinProb - bin.actualWinRate),
    0,
  );
  return weightedErr;
}

// ─── Full Calibration Report ──────────────────────────────────────────────────

export function computeSignalCalibration(
  strategyId: string,
  outcomes: SignalOutcome[],
  nBins: number = 10,
): SignalCalibrationResult {
  if (outcomes.length < 20) {
    // Insufficient data — return zero-filled result
    return {
      strategyId,
      brierScore: 0.25,
      expectedCalibrationError: 1,
      calibrationBins: [],
      wellCalibrated: false,
      computedAt: new Date().toISOString(),
    };
  }

  const bs = brierScore(outcomes);
  const bins = computeCalibrationBins(outcomes, nBins);
  const ece = expectedCalibrationError(bins, outcomes.length);
  const wellCalibrated = ece < 0.05;

  return {
    strategyId,
    brierScore: bs,
    expectedCalibrationError: ece,
    calibrationBins: bins,
    wellCalibrated,
    computedAt: new Date().toISOString(),
  };
}
