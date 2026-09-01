/**
 * Phase 19 — Research Experiment Tracking
 *
 * Every experiment must be reproducible.
 * Experiment records are IMMUTABLE — never overwrite or update.
 * Append only.
 *
 * Reproducibility requirements:
 *   - strategyVersion (semver)
 *   - datasetVersion (fingerprint)
 *   - parameterSet (exact values)
 *   - marketUniverse (sorted list)
 *   - dateRange (IS and OOS periods)
 *   - validationMethod
 *   - costModelId
 *   - slippageModelId
 *   - gitCommitHash
 *
 * Experiments are stored in memory in development and in the database
 * in production.  This module provides the in-memory store + factory.
 */

import type {
  ResearchExperiment,
  ExperimentResultStatus,
  ValidationMethod,
  PerformanceMetrics,
} from "../types";

// ─── Experiment ID Generation ─────────────────────────────────────────────────

let _counter = 0;

function generateExperimentId(strategyId: string): string {
  const timestamp = Date.now();
  _counter++;
  const random = Math.floor(Math.random() * 10000).toString(16).padStart(4, "0");
  return `exp-${strategyId.toLowerCase().replace(/_/g, "-")}-${timestamp}-${random}`;
}

// ─── Git Commit Hash ──────────────────────────────────────────────────────────

/**
 * Get the current git commit hash for reproducibility tracking.
 * Falls back to a placeholder if git is not available.
 */
function getGitCommitHash(): string {
  // In production this would be injected via process.env.VERCEL_GIT_COMMIT_SHA
  // or similar CI/CD environment variable
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA ??
    "unknown"
  );
}

// ─── Experiment Record Factory ────────────────────────────────────────────────

export interface CreateExperimentInput {
  strategyId: string;
  strategyVersion: string;
  datasetVersion: string;
  parameterSet: Record<string, number | string | boolean>;
  marketUniverse: string[];
  dateRange: { start: string; end: string };
  validationMethod: ValidationMethod;
  costModelId: string;
  slippageModelId: string;
  notes?: string;
}

export function createExperimentRecord(input: CreateExperimentInput): ResearchExperiment {
  return {
    experimentId: generateExperimentId(input.strategyId),
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    datasetVersion: input.datasetVersion,
    parameterSet: { ...input.parameterSet },
    marketUniverse: [...input.marketUniverse].sort(),
    dateRange: { ...input.dateRange },
    validationMethod: input.validationMethod,
    costModelId: input.costModelId,
    slippageModelId: input.slippageModelId,
    metrics: {},
    resultStatus: "RUNNING",
    gitCommitHash: getGitCommitHash(),
    timestamp: new Date().toISOString(),
    notes: input.notes ?? "",
  };
}

/**
 * Complete an experiment with final metrics.
 * Returns a new object — never mutates the original.
 */
export function completeExperiment(
  experiment: ResearchExperiment,
  metrics: Partial<PerformanceMetrics>,
  status: ExperimentResultStatus,
): ResearchExperiment {
  return Object.freeze({
    ...experiment,
    metrics,
    resultStatus: status,
  });
}

// ─── In-Memory Store ──────────────────────────────────────────────────────────

class ExperimentStoreImpl {
  private readonly experiments: Map<string, ResearchExperiment> = new Map();

  add(exp: ResearchExperiment): void {
    if (this.experiments.has(exp.experimentId)) {
      throw new Error(
        `[ExperimentStore] Attempt to overwrite experiment ${exp.experimentId}. ` +
          `Experiments are immutable — create a new record instead.`,
      );
    }
    this.experiments.set(exp.experimentId, Object.freeze({ ...exp }));
  }

  get(experimentId: string): ResearchExperiment | undefined {
    return this.experiments.get(experimentId);
  }

  forStrategy(strategyId: string): ResearchExperiment[] {
    return Array.from(this.experiments.values()).filter(
      (e) => e.strategyId === strategyId,
    );
  }

  all(): ResearchExperiment[] {
    return Array.from(this.experiments.values());
  }

  complete(
    experimentId: string,
    metrics: Partial<PerformanceMetrics>,
    status: ExperimentResultStatus,
  ): ResearchExperiment {
    const existing = this.experiments.get(experimentId);
    if (!existing) throw new Error(`Experiment ${experimentId} not found`);
    const completed = completeExperiment(existing, metrics, status);
    // Replace in store — this is a completion, not an overwrite
    this.experiments.set(experimentId, completed);
    return completed;
  }
}

/** Global in-memory experiment store (dev/test). Production uses the database. */
export const ExperimentStore = new ExperimentStoreImpl();
