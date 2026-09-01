/**
 * Phase 18 — Strategy Confidence Score
 *
 * A unified 0-100 score summarising ALL available evidence about a strategy.
 * This is NOT a simple average — each component has a documented weight
 * reflecting its empirical importance for predicting live performance.
 *
 * Component weights (sum to 1.0):
 *   OOS Performance          0.25  — the most important; OOS Sharpe × normalisation
 *   Walk-Forward Stability   0.15  — OOS validation period Sharpe
 *   Monte Carlo Robustness   0.15  — MC overall score / 100
 *   Parameter Stability      0.10  — parameter stability score / 100
 *   Cost Robustness          0.10  — 1 if survives 2×, 0 if COST_FRAGILE
 *   Regime Consistency       0.10  — regime fit score (0-1)
 *   Paper Performance        0.10  — paper Sharpe vs OOS Sharpe ratio
 *   Statistical Confidence   0.05  — (1 - p_value) of OOS t-test
 *
 * If a component is unavailable, its weight is distributed proportionally
 * among available components.
 *
 * Score bands:
 *   90-100 HIGH_CONFIDENCE
 *   75-89  VALIDATED
 *   60-74  WATCH
 *   40-59  DEGRADED
 *   0-39   DISABLED
 */

import type {
  ConfidenceComponent,
  StrategyConfidenceScore,
  ConfidenceBand,
  PerformanceMetrics,
  MonteCarloRobustnessScore,
  ParameterStabilityScore,
  CostAttributionReport,
  RegimeAttribution,
  PaperPerformanceComparison,
} from "../types";

// ─── Component Weights ────────────────────────────────────────────────────────

const COMPONENT_WEIGHTS: Record<string, number> = {
  oos_performance: 0.25,
  walk_forward_stability: 0.15,
  monte_carlo_robustness: 0.15,
  parameter_stability: 0.10,
  cost_robustness: 0.10,
  regime_consistency: 0.10,
  paper_performance: 0.10,
  statistical_confidence: 0.05,
};

// ─── Score Input ──────────────────────────────────────────────────────────────

export interface ConfidenceScoreInput {
  strategyId: string;
  finalOosMetrics?: PerformanceMetrics;
  validationMetrics?: PerformanceMetrics;
  monteCarlo?: MonteCarloRobustnessScore;
  parameterStability?: ParameterStabilityScore;
  costReport?: CostAttributionReport;
  regimeAttribution?: RegimeAttribution;
  paperMetrics?: PerformanceMetrics;
}

// ─── Band Classifier ──────────────────────────────────────────────────────────

function scoreToBand(score: number): ConfidenceBand {
  if (score >= 90) return "HIGH_CONFIDENCE";
  if (score >= 75) return "VALIDATED";
  if (score >= 60) return "WATCH";
  if (score >= 40) return "DEGRADED";
  return "DISABLED";
}

// ─── Score Builder ────────────────────────────────────────────────────────────

/**
 * Normalise a Sharpe ratio to a 0-100 score.
 * Sharpe ≥ 2.0 → 100, Sharpe = 1.0 → ~75, Sharpe = 0 → 25, Sharpe < 0 → 0
 */
function normaliseSharpeTo100(sharpe: number): number {
  // Logistic curve: score = 100 × sigmoid((sharpe - 0) / 1.0)
  const sigmoid = 1 / (1 + Math.exp(-sharpe));
  return Math.max(0, Math.min(100, sigmoid * 100));
}

export function computeStrategyConfidenceScore(
  input: ConfidenceScoreInput,
): StrategyConfidenceScore {
  const components: ConfidenceComponent[] = [];

  // ── OOS Performance (0.25) ──────────────────────────────────────────────
  {
    const m = input.finalOosMetrics;
    const available = m !== undefined && m.tradeCount >= 20;
    let raw = 0;
    if (available) {
      raw = normaliseSharpeTo100(m!.sharpe);
      // Bonus for positive expectancy, high profit factor
      if (m!.expectancy > 0) raw = Math.min(100, raw + 5);
      if (m!.profitFactor > 1.5) raw = Math.min(100, raw + 5);
      // Penalty for low trade count
      if (m!.tradeCount < 50) raw *= 0.85;
    }
    const weight = COMPONENT_WEIGHTS.oos_performance;
    components.push({
      name: "oos_performance",
      weight,
      rawScore: raw,
      weightedScore: raw * weight,
      available,
      description: "OOS Sharpe ratio and expectancy (weight 0.25)",
    });
  }

  // ── Walk-Forward Stability (0.15) ──────────────────────────────────────
  {
    const m = input.validationMetrics;
    const available = m !== undefined && m.tradeCount >= 10;
    let raw = 0;
    if (available) {
      raw = normaliseSharpeTo100(m!.sharpe);
    }
    const weight = COMPONENT_WEIGHTS.walk_forward_stability;
    components.push({
      name: "walk_forward_stability",
      weight,
      rawScore: raw,
      weightedScore: raw * weight,
      available,
      description: "Validation period Sharpe ratio (weight 0.15)",
    });
  }

  // ── Monte Carlo Robustness (0.15) ─────────────────────────────────────
  {
    const mc = input.monteCarlo;
    const available = mc !== undefined;
    let raw = 0;
    if (available) {
      raw = mc!.overallScore;
    }
    const weight = COMPONENT_WEIGHTS.monte_carlo_robustness;
    components.push({
      name: "monte_carlo_robustness",
      weight,
      rawScore: raw,
      weightedScore: raw * weight,
      available,
      description: "Monte Carlo simulation robustness score (weight 0.15)",
    });
  }

  // ── Parameter Stability (0.10) ────────────────────────────────────────
  {
    const ps = input.parameterStability;
    const available = ps !== undefined;
    let raw = 0;
    if (available) {
      raw = ps!.label === "OVERFIT_SUSPECTED" ? 10 : ps!.overallStabilityScore;
    }
    const weight = COMPONENT_WEIGHTS.parameter_stability;
    components.push({
      name: "parameter_stability",
      weight,
      rawScore: raw,
      weightedScore: raw * weight,
      available,
      description: "Parameter neighborhood stability score (weight 0.10)",
    });
  }

  // ── Cost Robustness (0.10) ────────────────────────────────────────────
  {
    const cr = input.costReport;
    const available = cr !== undefined;
    let raw = 0;
    if (available) {
      if (!cr!.costFragile) {
        // Survives at least 2× costs
        const multiplier = cr!.breakEvenCostMultiple;
        // 3× = 100, 2× = 60, 1× = 0
        raw = Math.min(100, (multiplier - 1) / 2 * 100);
      } else {
        raw = 5; // COST_FRAGILE — very low score
      }
    }
    const weight = COMPONENT_WEIGHTS.cost_robustness;
    components.push({
      name: "cost_robustness",
      weight,
      rawScore: raw,
      weightedScore: raw * weight,
      available,
      description: "Cost stress test robustness (break-even multiplier; weight 0.10)",
    });
  }

  // ── Regime Consistency (0.10) ─────────────────────────────────────────
  {
    const ra = input.regimeAttribution;
    const available = ra !== undefined && ra.regimeStats.length > 0;
    let raw = 0;
    if (available) {
      raw = Math.min(100, ra!.regimeFitScore * 100);
    }
    const weight = COMPONENT_WEIGHTS.regime_consistency;
    components.push({
      name: "regime_consistency",
      weight,
      rawScore: raw,
      weightedScore: raw * weight,
      available,
      description: "Weighted performance across regimes (weight 0.10)",
    });
  }

  // ── Paper Performance (0.10) ──────────────────────────────────────────
  {
    const pm = input.paperMetrics;
    const oosM = input.finalOosMetrics;
    const available = pm !== undefined && pm.tradeCount >= 10;
    let raw = 0;
    if (available) {
      raw = normaliseSharpeTo100(pm!.sharpe);
      // Cross-validate: paper vs OOS ratio
      if (oosM && oosM.sharpe > 0) {
        const ratio = pm!.sharpe / oosM.sharpe;
        // Paper > OOS by >20% is suspicious (could mean small sample luck)
        if (ratio > 1.2) raw *= 0.9;
        // Paper far below OOS suggests execution issues
        if (ratio < 0.5) raw *= ratio;
      }
    }
    const weight = COMPONENT_WEIGHTS.paper_performance;
    components.push({
      name: "paper_performance",
      weight,
      rawScore: raw,
      weightedScore: raw * weight,
      available,
      description: "Paper trading Sharpe cross-validated against OOS (weight 0.10)",
    });
  }

  // ── Statistical Confidence (0.05) ────────────────────────────────────
  {
    const m = input.finalOosMetrics;
    const available = m !== undefined && m.tradeCount >= 10;
    let raw = 0;
    if (available) {
      raw = (1 - m!.pValue) * 100;
      if (!m!.statisticallySignificant) raw = Math.min(raw, 40);
    }
    const weight = COMPONENT_WEIGHTS.statistical_confidence;
    components.push({
      name: "statistical_confidence",
      weight,
      rawScore: raw,
      weightedScore: raw * weight,
      available,
      description: "Statistical significance of OOS returns (weight 0.05)",
    });
  }

  // ── Aggregate with weight redistribution ────────────────────────────
  const availableComponents = components.filter((c) => c.available);
  const unavailableWeight = components
    .filter((c) => !c.available)
    .reduce((s, c) => s + c.weight, 0);

  let totalWeightedScore = 0;

  if (availableComponents.length === 0) {
    // No data at all
    const overallScore = 0;
    return {
      strategyId: input.strategyId,
      overallScore,
      band: "DISABLED",
      components,
      computedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  const availableWeight = availableComponents.reduce((s, c) => s + c.weight, 0);
  const redistributionMultiplier = availableWeight > 0 ? 1 + unavailableWeight / availableWeight : 1;

  for (const c of availableComponents) {
    totalWeightedScore += c.rawScore * c.weight * redistributionMultiplier;
  }

  const overallScore = Math.round(Math.max(0, Math.min(100, totalWeightedScore)));
  const band = scoreToBand(overallScore);

  return {
    strategyId: input.strategyId,
    overallScore,
    band,
    components,
    computedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}
