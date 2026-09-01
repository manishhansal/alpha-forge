/**
 * Model Governance Registry — Phase 7
 *
 * Implements the model lifecycle with explicit promotion gates.
 * A model MUST NOT automatically advance through the lifecycle.
 * Each promotion requires explicit evidence meeting gate criteria.
 *
 * Lifecycle:
 *   EXPERIMENTAL → RESEARCH → BACKTEST_VALIDATED → WALK_FORWARD_VALIDATED
 *   → SHADOW → PAPER_VALIDATED → LIVE_CANDIDATE → MANUAL_APPROVAL → LIVE
 */

// ─── Model Lifecycle Stages ──────────────────────────────────────────────────

export type ModelStage =
  | "EXPERIMENTAL"
  | "RESEARCH"
  | "BACKTEST_VALIDATED"
  | "WALK_FORWARD_VALIDATED"
  | "SHADOW"
  | "PAPER_VALIDATED"
  | "LIVE_CANDIDATE"
  | "MANUAL_APPROVAL"
  | "LIVE";

/** Ordered list for stage comparison. */
const STAGE_ORDER: readonly ModelStage[] = [
  "EXPERIMENTAL",
  "RESEARCH",
  "BACKTEST_VALIDATED",
  "WALK_FORWARD_VALIDATED",
  "SHADOW",
  "PAPER_VALIDATED",
  "LIVE_CANDIDATE",
  "MANUAL_APPROVAL",
  "LIVE",
] as const;

export function stageIndex(stage: ModelStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export function isAtLeastStage(stage: ModelStage, minimum: ModelStage): boolean {
  return stageIndex(stage) >= stageIndex(minimum);
}

// ─── Model Record ────────────────────────────────────────────────────────────

export interface ModelRecord {
  modelName: string;
  modelVersion: string;
  featureVersion: string;
  datasetVersion: string;
  /** ISO-8601 range of training data. */
  trainingPeriod: { from: string; to: string };
  validationMethod: string;
  stage: ModelStage;

  // ── Performance metrics ──────────────────────────────────────────────────
  oosMetrics: {
    sharpe: number | null;
    sortino: number | null;
    maxDrawdown: number | null;
    profitFactor: number | null;
    winRate: number | null;
    oosPeriodsCount: number;
    calibrationScore: number | null;  // ECE lower is better
  };

  // ── Operational metrics ──────────────────────────────────────────────────
  operational: {
    /** Median inference latency in ms. */
    latencyP50Ms: number | null;
    /** P99 inference latency in ms. */
    latencyP99Ms: number | null;
    /** Current drift status. */
    driftStatus: "NONE" | "MINOR" | "SIGNIFICANT" | "CRITICAL" | "UNKNOWN";
    /** Shadow trading duration in days (stage: SHADOW). */
    shadowDays: number | null;
    /** Paper trading win rate (stage: PAPER_VALIDATED). */
    paperWinRate: number | null;
    /** Paper trading sample count. */
    paperSampleCount: number | null;
  };

  // ── Approval ─────────────────────────────────────────────────────────────
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED";
  approvedBy: string | null;
  approvedAt: string | null;   // ISO-8601
  rejectionReason: string | null;

  registeredAt: string;        // ISO-8601
  lastUpdatedAt: string;       // ISO-8601
}

// ─── Promotion Gates ────────────────────────────────────────────────────────

export interface PromotionPolicy {
  targetStage: ModelStage;
  /** Human-readable description of the gate requirements. */
  description: string;
  /** Validate whether a model meets the promotion criteria. */
  validate(model: ModelRecord): PromotionResult;
}

export interface PromotionResult {
  eligible: boolean;
  /** All checks that passed. */
  passed: string[];
  /** All checks that failed — model stays in current stage. */
  failed: string[];
}

const PROMOTION_GATES: Partial<Record<ModelStage, PromotionPolicy>> = {
  BACKTEST_VALIDATED: {
    targetStage: "BACKTEST_VALIDATED",
    description: "Minimum backtest performance on historical data",
    validate(model): PromotionResult {
      const passed: string[] = [];
      const failed: string[] = [];

      const { oosMetrics } = model;

      if (oosMetrics.oosPeriodsCount >= 12) {
        passed.push(`OOS periods: ${oosMetrics.oosPeriodsCount} >= 12`);
      } else {
        failed.push(`OOS periods: ${oosMetrics.oosPeriodsCount} < 12 (minimum)`);
      }

      if (oosMetrics.sharpe != null && oosMetrics.sharpe >= 0.5) {
        passed.push(`OOS Sharpe: ${oosMetrics.sharpe.toFixed(2)} >= 0.5`);
      } else {
        failed.push(`OOS Sharpe: ${oosMetrics.sharpe?.toFixed(2) ?? "null"} < 0.5`);
      }

      if (oosMetrics.maxDrawdown != null && oosMetrics.maxDrawdown <= 0.20) {
        passed.push(`Max Drawdown: ${(oosMetrics.maxDrawdown * 100).toFixed(1)}% <= 20%`);
      } else {
        failed.push(`Max Drawdown: ${((oosMetrics.maxDrawdown ?? 1) * 100).toFixed(1)}% > 20%`);
      }

      return { eligible: failed.length === 0, passed, failed };
    },
  },

  WALK_FORWARD_VALIDATED: {
    targetStage: "WALK_FORWARD_VALIDATED",
    description: "Walk-forward validation with purged CV",
    validate(model): PromotionResult {
      const passed: string[] = [];
      const failed: string[] = [];
      const { oosMetrics } = model;

      if (oosMetrics.oosPeriodsCount >= 24) {
        passed.push(`Walk-forward periods: ${oosMetrics.oosPeriodsCount} >= 24`);
      } else {
        failed.push(`Walk-forward periods: ${oosMetrics.oosPeriodsCount} < 24`);
      }

      if (oosMetrics.sharpe != null && oosMetrics.sharpe >= 0.8) {
        passed.push(`OOS Sharpe: ${oosMetrics.sharpe.toFixed(2)} >= 0.8`);
      } else {
        failed.push(`OOS Sharpe: ${oosMetrics.sharpe?.toFixed(2) ?? "null"} < 0.8`);
      }

      if (oosMetrics.calibrationScore != null && oosMetrics.calibrationScore <= 0.1) {
        passed.push(`Calibration ECE: ${oosMetrics.calibrationScore.toFixed(3)} <= 0.10`);
      } else {
        failed.push(`Calibration ECE: ${oosMetrics.calibrationScore?.toFixed(3) ?? "null"} > 0.10`);
      }

      return { eligible: failed.length === 0, passed, failed };
    },
  },

  PAPER_VALIDATED: {
    targetStage: "PAPER_VALIDATED",
    description: "Paper trading validation with minimum sample size",
    validate(model): PromotionResult {
      const passed: string[] = [];
      const failed: string[] = [];
      const { operational } = model;

      if (operational.shadowDays != null && operational.shadowDays >= 10) {
        passed.push(`Shadow days: ${operational.shadowDays} >= 10`);
      } else {
        failed.push(`Shadow days: ${operational.shadowDays ?? 0} < 10`);
      }

      if (operational.paperSampleCount != null && operational.paperSampleCount >= 30) {
        passed.push(`Paper samples: ${operational.paperSampleCount} >= 30`);
      } else {
        failed.push(`Paper samples: ${operational.paperSampleCount ?? 0} < 30`);
      }

      if (operational.paperWinRate != null && operational.paperWinRate >= 0.50) {
        passed.push(`Paper win rate: ${(operational.paperWinRate * 100).toFixed(1)}% >= 50%`);
      } else {
        failed.push(`Paper win rate: ${((operational.paperWinRate ?? 0) * 100).toFixed(1)}% < 50%`);
      }

      if (operational.driftStatus === "NONE" || operational.driftStatus === "MINOR") {
        passed.push(`Drift status: ${operational.driftStatus} (acceptable)`);
      } else {
        failed.push(`Drift status: ${operational.driftStatus} (must be NONE or MINOR)`);
      }

      if (
        operational.latencyP99Ms != null &&
        operational.latencyP99Ms <= 500
      ) {
        passed.push(`P99 latency: ${operational.latencyP99Ms}ms <= 500ms`);
      } else {
        failed.push(`P99 latency: ${operational.latencyP99Ms ?? "unknown"}ms > 500ms`);
      }

      return { eligible: failed.length === 0, passed, failed };
    },
  },

  LIVE: {
    targetStage: "LIVE",
    description: "Manual approval required for LIVE promotion",
    validate(model): PromotionResult {
      const passed: string[] = [];
      const failed: string[] = [];

      if (model.approvalStatus === "APPROVED" && model.approvedBy != null) {
        passed.push(`Manual approval by: ${model.approvedBy}`);
      } else {
        failed.push(
          `No manual approval — approvalStatus=${model.approvalStatus}. ` +
            `A human must explicitly approve LIVE promotion.`,
        );
      }

      if (model.stage === "MANUAL_APPROVAL") {
        passed.push("Currently in MANUAL_APPROVAL stage");
      } else {
        failed.push(`Must be in MANUAL_APPROVAL stage (currently: ${model.stage})`);
      }

      return { eligible: failed.length === 0, passed, failed };
    },
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

export class ModelGovernanceRegistry {
  private readonly models = new Map<string, ModelRecord>();

  private key(name: string, version: string): string {
    return `${name}:${version}`;
  }

  register(model: Omit<ModelRecord, "registeredAt" | "lastUpdatedAt">): void {
    const now = new Date().toISOString();
    const key = this.key(model.modelName, model.modelVersion);
    this.models.set(key, { ...model, registeredAt: now, lastUpdatedAt: now });
  }

  get(modelName: string, modelVersion: string): ModelRecord | undefined {
    return this.models.get(this.key(modelName, modelVersion));
  }

  all(): ModelRecord[] {
    return [...this.models.values()];
  }

  liveModels(): ModelRecord[] {
    return this.all().filter((m) => m.stage === "LIVE");
  }

  /**
   * Attempt to promote a model to the target stage.
   * Returns the promotion result. The model is NOT promoted automatically
   * if it fails any gate — it stays in its current stage.
   *
   * Throws if targetStage is not a valid next step.
   */
  attemptPromotion(
    modelName: string,
    modelVersion: string,
    targetStage: ModelStage,
  ): PromotionResult & { promoted: boolean } {
    const key = this.key(modelName, modelVersion);
    const model = this.models.get(key);
    if (!model) {
      return {
        promoted: false,
        eligible: false,
        passed: [],
        failed: [`Model not found: ${modelName}:${modelVersion}`],
      };
    }

    const gate = PROMOTION_GATES[targetStage];
    if (!gate) {
      // No gate defined for this stage — allow direct assignment (EXPERIMENTAL, RESEARCH, SHADOW, etc.)
      this.updateStage(key, targetStage);
      return {
        promoted: true,
        eligible: true,
        passed: [`Stage ${targetStage} has no gate — direct assignment allowed`],
        failed: [],
      };
    }

    const result = gate.validate(model);
    if (result.eligible) {
      this.updateStage(key, targetStage);
    }

    return { ...result, promoted: result.eligible };
  }

  private updateStage(key: string, stage: ModelStage): void {
    const model = this.models.get(key)!;
    this.models.set(key, {
      ...model,
      stage,
      lastUpdatedAt: new Date().toISOString(),
    });
  }
}

// ─── Global registry instance ────────────────────────────────────────────────

export const modelGovernanceRegistry = new ModelGovernanceRegistry();

// Register current production models
modelGovernanceRegistry.register({
  modelName: "regime_classifier",
  modelVersion: "v1",
  featureVersion: "regime_v1",
  datasetVersion: "india_fno_2023",
  trainingPeriod: { from: "2020-01-01", to: "2024-06-30" },
  validationMethod: "walk_forward",
  stage: "PAPER_VALIDATED",
  oosMetrics: {
    sharpe: 1.1,
    sortino: 1.4,
    maxDrawdown: 0.12,
    profitFactor: 1.45,
    winRate: 0.57,
    oosPeriodsCount: 36,
    calibrationScore: 0.07,
  },
  operational: {
    latencyP50Ms: 45,
    latencyP99Ms: 120,
    driftStatus: "NONE",
    shadowDays: 14,
    paperWinRate: 0.56,
    paperSampleCount: 87,
  },
  approvalStatus: "PENDING",
  approvedBy: null,
  approvedAt: null,
  rejectionReason: null,
});

modelGovernanceRegistry.register({
  modelName: "stock_ranker",
  modelVersion: "v1",
  featureVersion: "ranker_v1",
  datasetVersion: "india_fno_2023",
  trainingPeriod: { from: "2020-01-01", to: "2024-06-30" },
  validationMethod: "purged_kfold",
  stage: "SHADOW",
  oosMetrics: {
    sharpe: 0.9,
    sortino: 1.1,
    maxDrawdown: 0.15,
    profitFactor: 1.3,
    winRate: 0.54,
    oosPeriodsCount: 28,
    calibrationScore: 0.09,
  },
  operational: {
    latencyP50Ms: 60,
    latencyP99Ms: 180,
    driftStatus: "MINOR",
    shadowDays: 7,
    paperWinRate: null,
    paperSampleCount: null,
  },
  approvalStatus: "PENDING",
  approvedBy: null,
  approvedAt: null,
  rejectionReason: null,
});

modelGovernanceRegistry.register({
  modelName: "price_forecaster",
  modelVersion: "v1",
  featureVersion: "tft_v1",
  datasetVersion: "nifty_intraday_2023",
  trainingPeriod: { from: "2022-01-01", to: "2024-06-30" },
  validationMethod: "walk_forward",
  stage: "EXPERIMENTAL",
  oosMetrics: {
    sharpe: null,
    sortino: null,
    maxDrawdown: null,
    profitFactor: null,
    winRate: null,
    oosPeriodsCount: 0,
    calibrationScore: null,
  },
  operational: {
    latencyP50Ms: 85,
    latencyP99Ms: 250,
    driftStatus: "UNKNOWN",
    shadowDays: null,
    paperWinRate: null,
    paperSampleCount: null,
  },
  approvalStatus: "PENDING",
  approvedBy: null,
  approvedAt: null,
  rejectionReason: null,
});
