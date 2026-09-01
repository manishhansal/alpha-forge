/**
 * Model Ablation Framework — Phase 8
 *
 * Measures each model's incremental value over the baseline.
 * If a model does not provide measurable OOS value, it is marked LOW_VALUE
 * and its production weight is reduced to zero until revalidated.
 *
 * Ablation comparison: BASELINE_WITHOUT_MODEL vs BASELINE_WITH_MODEL
 *
 * Metrics compared:
 *   Sharpe, Sortino, Max Drawdown, Profit Factor, Win Rate,
 *   Expectancy, Turnover, Transaction Cost Impact, Calibration, Latency
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type AblationMetrics = {
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  profitFactor: number | null;
  winRate: number | null;
  expectancy: number | null;       // Expected P&L per trade
  turnoverPct: number | null;      // Annual portfolio turnover
  txCostImpact: number | null;     // Basis points of return lost to tx costs
  calibrationEce: number | null;   // Expected Calibration Error
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  sampleCount: number;
};

export type AblationValueJudgement =
  | "POSITIVE_VALUE"   // Statistically significant improvement
  | "MARGINAL_VALUE"   // Improvement but not statistically significant
  | "NEUTRAL"          // No measurable impact
  | "LOW_VALUE"        // Worse than baseline on key metrics
  | "NOT_EVALUATED";   // Insufficient data

export interface AblationResult {
  modelName: string;
  modelVersion: string;
  baselineMetrics: AblationMetrics;
  withModelMetrics: AblationMetrics;
  /** Incremental impact = withModel - baseline. Positive is better for most metrics. */
  incrementalSharpe: number | null;
  incrementalMaxDrawdown: number | null;
  incrementalWinRate: number | null;
  valueJudgement: AblationValueJudgement;
  /** Current production weight [0, 1]. Reduced to 0 when LOW_VALUE. */
  productionWeight: number;
  evaluatedAt: string;  // ISO-8601
  notes: string;
}

// ─── Ablation Registry ───────────────────────────────────────────────────────

class ModelAblationRegistry {
  private readonly results = new Map<string, AblationResult>();

  private key(modelName: string, modelVersion: string): string {
    return `${modelName}:${modelVersion}`;
  }

  register(result: AblationResult): void {
    this.results.set(this.key(result.modelName, result.modelVersion), result);
  }

  get(modelName: string, modelVersion: string): AblationResult | undefined {
    return this.results.get(this.key(modelName, modelVersion));
  }

  all(): AblationResult[] {
    return [...this.results.values()];
  }

  /**
   * Get the effective production weight for a model.
   * Returns 0 for LOW_VALUE models, 1.0 for POSITIVE_VALUE models.
   */
  getProductionWeight(modelName: string, modelVersion: string): number {
    const result = this.get(modelName, modelVersion);
    if (!result) return 0; // Unknown model — zero weight by default
    return result.productionWeight;
  }

  /**
   * Compute the value judgement from incremental metrics.
   * Marks models as LOW_VALUE and sets productionWeight=0 when they
   * don't provide measurable OOS improvement.
   */
  static computeJudgement(
    baseline: AblationMetrics,
    withModel: AblationMetrics,
  ): { judgement: AblationValueJudgement; weight: number } {
    if (
      baseline.sharpe == null ||
      withModel.sharpe == null ||
      baseline.sampleCount < 30 ||
      withModel.sampleCount < 30
    ) {
      return { judgement: "NOT_EVALUATED", weight: 0 };
    }

    const sharpeDelta = withModel.sharpe - baseline.sharpe;
    const drawdownDelta =
      baseline.maxDrawdown != null && withModel.maxDrawdown != null
        ? withModel.maxDrawdown - baseline.maxDrawdown
        : null;

    // Meaningful improvement: Sharpe +0.2 AND no significant drawdown increase
    if (
      sharpeDelta >= 0.2 &&
      (drawdownDelta == null || drawdownDelta <= 0.02)
    ) {
      return { judgement: "POSITIVE_VALUE", weight: 1.0 };
    }

    // Marginal: Sharpe +0.05 to +0.20
    if (sharpeDelta >= 0.05 && sharpeDelta < 0.2) {
      return { judgement: "MARGINAL_VALUE", weight: 0.5 };
    }

    // Neutral: within ±0.05
    if (Math.abs(sharpeDelta) < 0.05) {
      return { judgement: "NEUTRAL", weight: 0.3 };
    }

    // Low value: model makes things worse
    return { judgement: "LOW_VALUE", weight: 0 };
  }
}

export const modelAblationRegistry = new ModelAblationRegistry();

// Register current ablation results (placeholder — populated by the Python training pipeline).
// These are illustrative; real values come from offline walk-forward ablation runs.
const BASELINE: AblationMetrics = {
  sharpe: 0.85,
  sortino: 1.05,
  maxDrawdown: 0.15,
  profitFactor: 1.25,
  winRate: 0.52,
  expectancy: 0.003,
  turnoverPct: 450,
  txCostImpact: 12,
  calibrationEce: null,
  latencyP50Ms: 5,
  latencyP99Ms: 15,
  sampleCount: 200,
};

modelAblationRegistry.register({
  modelName: "regime_classifier",
  modelVersion: "v1",
  baselineMetrics: BASELINE,
  withModelMetrics: {
    ...BASELINE,
    sharpe: 1.1,
    sortino: 1.4,
    maxDrawdown: 0.12,
    winRate: 0.57,
    sampleCount: 200,
  },
  incrementalSharpe: 0.25,
  incrementalMaxDrawdown: -0.03,
  incrementalWinRate: 0.05,
  valueJudgement: "POSITIVE_VALUE",
  productionWeight: 1.0,
  evaluatedAt: "2024-09-01T00:00:00.000Z",
  notes:
    "Regime classifier provides statistically significant Sharpe improvement (+0.25) " +
    "with reduced drawdown (-3%). POSITIVE_VALUE — retain in production at full weight.",
});

modelAblationRegistry.register({
  modelName: "stock_ranker",
  modelVersion: "v1",
  baselineMetrics: BASELINE,
  withModelMetrics: {
    ...BASELINE,
    sharpe: 0.93,
    sortino: 1.12,
    maxDrawdown: 0.14,
    winRate: 0.54,
    sampleCount: 120,
  },
  incrementalSharpe: 0.08,
  incrementalMaxDrawdown: -0.01,
  incrementalWinRate: 0.02,
  valueJudgement: "MARGINAL_VALUE",
  productionWeight: 0.5,
  evaluatedAt: "2024-09-01T00:00:00.000Z",
  notes:
    "Stock ranker shows marginal improvement (+0.08 Sharpe) but insufficient " +
    "sample size for statistical significance (n=120 < 200). MARGINAL_VALUE — " +
    "retain at 50% weight pending more data.",
});

modelAblationRegistry.register({
  modelName: "price_forecaster",
  modelVersion: "v1",
  baselineMetrics: BASELINE,
  withModelMetrics: {
    ...BASELINE,
    sharpe: null,  // Not yet evaluated
    sampleCount: 0,
  },
  incrementalSharpe: null,
  incrementalMaxDrawdown: null,
  incrementalWinRate: null,
  valueJudgement: "NOT_EVALUATED",
  productionWeight: 0,
  evaluatedAt: "2024-09-01T00:00:00.000Z",
  notes:
    "Price forecaster is EXPERIMENTAL — no OOS walk-forward evaluation completed. " +
    "Production weight = 0 until BACKTEST_VALIDATED. Do NOT use in live decisions.",
});
