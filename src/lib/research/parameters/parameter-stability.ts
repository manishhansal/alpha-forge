/**
 * Phase 12 — Parameter Stability Testing
 *
 * Strategies must not depend on a single "magical" parameter value.
 * For every optimised parameter, we test a symmetric neighbourhood of
 * ±N steps and check whether performance is stable across the region.
 *
 * A ROBUST strategy has a flat performance region around the optimal value.
 * An OVERFIT strategy has a sharp spike at the optimal value surrounded
 * by losses — the so-called "knife edge" pattern.
 *
 * Mark OVERFIT_SUSPECTED when:
 *   - Any neighbor Sharpe < optimal × 0.3 (>70% drop)
 *   - OR range of neighborhood Sharpes > 3.0 (extreme sensitivity)
 *   - OR optimal value is a local maximum (all direct neighbors below)
 */

import type {
  ParameterNeighbor,
  ParameterStabilityResult,
  ParameterStabilityScore,
} from "../types";

// ─── Parameter Definition ─────────────────────────────────────────────────────

export interface ParameterSpec {
  parameterName: string;
  description: string;
  canonicalValue: number;
  /** Step size for neighbourhood generation */
  step: number;
  /** Number of steps in each direction */
  neighborSteps: number;
  /** Minimum valid value */
  min?: number;
  /** Maximum valid value */
  max?: number;
}

/**
 * Generate the neighbour values for a parameter.
 */
export function generateNeighborValues(spec: ParameterSpec): number[] {
  const values: number[] = [];
  const { canonicalValue, step, neighborSteps, min, max } = spec;

  for (let i = -neighborSteps; i <= neighborSteps; i++) {
    const v = canonicalValue + i * step;
    if ((min === undefined || v >= min) && (max === undefined || v <= max)) {
      values.push(v);
    }
  }
  return values;
}

// ─── Stability Analysis ───────────────────────────────────────────────────────

/**
 * Analyse parameter stability from a set of per-parameter-value results.
 *
 * @param spec        Parameter specification
 * @param neighbors   Performance at each parameter value
 */
export function analyseParameterStability(
  spec: ParameterSpec,
  neighbors: ParameterNeighbor[],
): ParameterStabilityResult {
  if (neighbors.length === 0) {
    return {
      parameterName: spec.parameterName,
      canonicalValue: spec.canonicalValue,
      neighborhood: [],
      stabilityScore: 0,
      overfitSuspected: true,
      peakIsolated: false,
    };
  }

  // Find canonical value entry
  const canonical = neighbors.find((n) => n.parameterValue === spec.canonicalValue);
  const canonicalSharpe = canonical?.sharpe ?? 0;

  // Stability score: coefficient of variation of Sharpes across neighbors
  // Lower CV = more stable
  const sharpes = neighbors.map((n) => n.sharpe);
  const meanSharpe = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
  const stdSharpe = Math.sqrt(
    sharpes.reduce((s, v) => s + (v - meanSharpe) ** 2, 0) / Math.max(sharpes.length - 1, 1),
  );

  // Normalise CV: 0 = perfectly stable, 1 = very unstable
  const cv = meanSharpe !== 0 ? Math.abs(stdSharpe / meanSharpe) : 1;
  const stabilityScore = Math.max(0, Math.min(1, 1 - cv));

  // OVERFIT_SUSPECTED checks
  const sharpeRange = Math.max(...sharpes) - Math.min(...sharpes);
  const worstNeighborSharpe = Math.min(...sharpes);

  const severeNeighborDrop =
    canonicalSharpe > 0 && worstNeighborSharpe < canonicalSharpe * 0.3;
  const extremeSensitivity = sharpeRange > 3.0;

  // Peak isolated: canonical is local maximum (both direct neighbours below)
  const canonicalIdx = neighbors.findIndex((n) => n.parameterValue === spec.canonicalValue);
  const leftNeighborSharpe = canonicalIdx > 0 ? neighbors[canonicalIdx - 1].sharpe : -Infinity;
  const rightNeighborSharpe =
    canonicalIdx < neighbors.length - 1 ? neighbors[canonicalIdx + 1].sharpe : -Infinity;
  const peakIsolated =
    canonicalIdx > 0 &&
    canonicalIdx < neighbors.length - 1 &&
    canonicalSharpe > leftNeighborSharpe &&
    canonicalSharpe > rightNeighborSharpe &&
    (leftNeighborSharpe < 0 || rightNeighborSharpe < 0);

  const overfitSuspected = severeNeighborDrop || extremeSensitivity || peakIsolated;

  return {
    parameterName: spec.parameterName,
    canonicalValue: spec.canonicalValue,
    neighborhood: neighbors,
    stabilityScore,
    overfitSuspected,
    peakIsolated,
  };
}

// ─── Score Aggregation ────────────────────────────────────────────────────────

/**
 * Aggregate multiple parameter stability results into an overall score.
 */
export function buildParameterStabilityScore(
  strategyId: string,
  results: ParameterStabilityResult[],
): ParameterStabilityScore {
  if (results.length === 0) {
    return {
      strategyId,
      overallStabilityScore: 0,
      parameters: [],
      label: "OVERFIT_SUSPECTED",
      computedAt: new Date().toISOString(),
    };
  }

  const avgStabilityScore =
    results.reduce((s, r) => s + r.stabilityScore, 0) / results.length;
  const overallScore = Math.round(avgStabilityScore * 100);

  const anyOverfit = results.some((r) => r.overfitSuspected);

  const label: ParameterStabilityScore["label"] = anyOverfit
    ? "OVERFIT_SUSPECTED"
    : overallScore >= 70
      ? "STABLE"
      : "MODERATE";

  return {
    strategyId,
    overallStabilityScore: overallScore,
    parameters: results,
    label,
    computedAt: new Date().toISOString(),
  };
}
