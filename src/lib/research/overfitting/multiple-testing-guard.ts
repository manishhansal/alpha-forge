/**
 * Phase 13 — Combinatorial Backtest Overfitting Control
 *
 * AlphaForge contains many strategies developed through iterative
 * research.  Some strategies will appear profitable purely by chance
 * when hundreds of parameter combinations are tested.
 *
 * This module implements:
 *   1. Probability of Backtest Overfitting (PBO) via CPCV ratio
 *   2. Deflated Sharpe Ratio (DSR) — Sharpe adjusted for multiple testing
 *   3. Bonferroni correction (family-wise error rate)
 *   4. Benjamini-Hochberg FDR correction
 *
 * References:
 *   - Bailey & López de Prado (2014), "The Probability of Backtest Overfitting"
 *   - Harvey & Liu (2015), "Backtesting"
 *   - Lo (2002), "The Statistics of Sharpe Ratios"
 */

import type { MultipleTestingGuard } from "../types";

// ─── Deflated Sharpe Ratio ────────────────────────────────────────────────────

/**
 * Compute the Deflated Sharpe Ratio per Bailey & López de Prado (2014).
 *
 * DSR accounts for:
 *   - Number of trials (strategies/parameter sets tested)
 *   - Non-normality (skewness, kurtosis)
 *   - Variance of Sharpe ratio estimates
 *
 * DSR < 1 means the strategy likely owes its Sharpe to selection bias.
 *
 * @param observedSharpe   Observed Sharpe ratio
 * @param nTrials          Number of strategies/configurations tested
 * @param nObservations    Number of independent observations (trades or bars)
 * @param skewness         Skewness of returns
 * @param kurtosis         Excess kurtosis of returns
 * @returns deflatedSharpe in same units as observedSharpe
 */
export function computeDeflatedSharpe(
  observedSharpe: number,
  nTrials: number,
  nObservations: number,
  skewness: number,
  kurtosis: number,
): number {
  if (nTrials <= 1 || nObservations < 5) return observedSharpe;

  // Expected maximum Sharpe ratio from N iid trials (Theorem 1, BLP 2014)
  const eulerMascheroni = 0.5772156649;
  const maxSharpeExpected =
    (1 - eulerMascheroni) * normInv(1 - 1 / nTrials) +
    eulerMascheroni * normInv(1 - 1 / (nTrials * Math.E));

  // Variance of the Sharpe ratio (Lo 2002)
  const sharpeVariance =
    (1 / nObservations) *
    (1 + (observedSharpe ** 2 / 2) * (1 - skewness * observedSharpe + ((kurtosis - 3) / 4) * observedSharpe ** 2));

  const sharpeStdDev = Math.sqrt(Math.max(sharpeVariance, 0));

  // DSR: observed Sharpe deflated by selection bias
  const deflated = observedSharpe - sharpeStdDev * maxSharpeExpected;
  return deflated;
}

/**
 * Approximate inverse normal CDF (Beasley-Springer-Moro algorithm).
 */
function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [2.515517, 0.802853, 0.010328];
  const b = [1.432788, 0.189269, 0.001308];
  const t = p < 0.5 ? Math.sqrt(-2 * Math.log(p)) : Math.sqrt(-2 * Math.log(1 - p));
  const num = a[0] + t * (a[1] + t * a[2]);
  const den = 1 + t * (b[0] + t * (b[1] + t * b[2]));
  const z = t - num / den;
  return p < 0.5 ? -z : z;
}

// ─── Probability of Backtest Overfitting (PBO) ───────────────────────────────

/**
 * Estimate the Probability of Backtest Overfitting from CPCV results.
 *
 * In CPCV with N paths, PBO is estimated as:
 *   P(OOS rank < IS rank) = fraction of paths where the best IS strategy
 *   underperforms the median on OOS data.
 *
 * Here we provide a simplified estimator based on the ratio of
 * in-sample best Sharpe to out-of-sample Sharpe.
 *
 * @param isSharpes    Array of in-sample Sharpe ratios from all parameter sets
 * @param oosSharpes   Array of corresponding OOS Sharpe ratios
 * @returns probability in [0, 1]; > 0.5 suggests overfitting
 */
export function estimatePBO(isSharpes: number[], oosSharpes: number[]): number {
  if (isSharpes.length !== oosSharpes.length || isSharpes.length === 0) return 0.5;

  // Find the best IS strategy
  const bestIsIdx = isSharpes.indexOf(Math.max(...isSharpes));
  const oosOfBestIs = oosSharpes[bestIsIdx];
  const medianOos = median(oosSharpes);

  // PBO increases as the best IS strategy underperforms on OOS
  // Logistic transformation of the relative OOS rank
  const relativePerf = oosOfBestIs / Math.max(Math.abs(medianOos), 0.01);
  const pbo = 1 / (1 + Math.exp(2 * (relativePerf - 1)));
  return Math.max(0, Math.min(1, pbo));
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Multiple Testing P-Value Adjustments ────────────────────────────────────

/**
 * Bonferroni correction: familywise error rate.
 * Returns the adjusted α threshold (tests must achieve p < result to be significant).
 *
 * Conservative: all tests must be significant at α/n.
 */
export function bonferroniThreshold(alpha: number, nTests: number): number {
  return alpha / Math.max(nTests, 1);
}

/**
 * Benjamini-Hochberg FDR correction.
 * Returns adjusted p-values for each test (lower is more significant).
 *
 * Less conservative than Bonferroni; controls false discovery rate at `alpha`.
 *
 * @param pValues   Raw p-values for each test
 * @param alpha     Target FDR level (default 0.05)
 * @returns adjusted p-values in same order as input
 */
export function bhFdrAdjust(pValues: number[], alpha: number = 0.05): number[] {
  const n = pValues.length;
  if (n === 0) return [];

  // Sort with original indices
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array(n).fill(1);

  // BH procedure
  let minAdjusted = 1;
  for (let k = n - 1; k >= 0; k--) {
    const bhAdjusted = (indexed[k].p * n) / (k + 1);
    minAdjusted = Math.min(minAdjusted, Math.min(bhAdjusted, 1));
    adjusted[indexed[k].i] = minAdjusted;
  }

  return adjusted;
}

// ─── Guard Builder ────────────────────────────────────────────────────────────

export interface MultipleTestingInput {
  strategyId: string;
  numberOfExperiments: number;
  parameterCombinations: number;
  strategyVariants: number;
  modelVariants: number;
  observedSharpe: number;
  nObservations: number;
  returnsSkewness: number;
  returnsKurtosis: number;
  isSharpes: number[];
  oosSharpes: number[];
  pValuesFromExperiments: number[];
}

export function buildMultipleTestingGuard(
  input: MultipleTestingInput,
): MultipleTestingGuard {
  const nTrials =
    input.numberOfExperiments +
    input.parameterCombinations +
    input.strategyVariants +
    input.modelVariants;

  const deflatedSharpe = computeDeflatedSharpe(
    input.observedSharpe,
    Math.max(nTrials, 1),
    input.nObservations,
    input.returnsSkewness,
    input.returnsKurtosis,
  );

  const probabilityOfOverfitting = estimatePBO(input.isSharpes, input.oosSharpes);

  const bonferroniAlpha = bonferroniThreshold(0.05, Math.max(nTrials, 1));

  const bhAdjusted = bhFdrAdjust(input.pValuesFromExperiments);
  const bhAdjustedPValue =
    bhAdjusted.length > 0 ? Math.min(...bhAdjusted) : 1;

  // Verdict
  let verdict: "PASS" | "WARN" | "FAIL";
  if (probabilityOfOverfitting > 0.6 || deflatedSharpe < 0) {
    verdict = "FAIL";
  } else if (probabilityOfOverfitting > 0.4 || deflatedSharpe < 0.5) {
    verdict = "WARN";
  } else {
    verdict = "PASS";
  }

  return {
    strategyId: input.strategyId,
    numberOfExperiments: input.numberOfExperiments,
    parameterCombinations: input.parameterCombinations,
    strategyVariants: input.strategyVariants,
    modelVariants: input.modelVariants,
    deflatedSharpeRatio: deflatedSharpe,
    probabilityOfOverfitting,
    familywiseErrorRate: bonferroniAlpha,
    bhAdjustedPValue,
    verdict,
    computedAt: new Date().toISOString(),
  };
}
