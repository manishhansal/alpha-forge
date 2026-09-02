/**
 * Strategy Scorecard & Production Guard — Phases 44–45
 *
 * Produces the definitive per-strategy scorecard and enforces
 * production promotion gates.
 *
 * Phase 44: Strategy Scorecard with all required metrics.
 * Phase 45: Production Guard — a strategy cannot reach LIVE_CANDIDATE
 *           from backtest P&L alone. Requires OOS + walk-forward +
 *           cost sensitivity + regime coverage + calibration + paper
 *           + execution evidence.
 */

import { OFFICIAL_INDIA_STRATEGY_IDS } from "./types";
import type { OfficialIndiaStrategyId } from "./types";

// ─── Strategy Status ──────────────────────────────────────────────────────────

export type StrategyScorecardStatus =
  | "RESEARCH"             // Conceptual / under development
  | "PROMISING"            // Shows positive signals but insufficient evidence
  | "VALIDATED"            // OOS validated with sufficient sample
  | "PAPER_CANDIDATE"      // Ready for extended paper trading
  | "LIVE_CANDIDATE"       // Passed all gates — ready for live evaluation
  | "DEGRADED"             // Previously working, now declining
  | "DISABLED"             // Turned off due to decay or evidence failure
  | "INSUFFICIENT_EVIDENCE"; // Not enough trades to evaluate

// ─── Production Promotion Gates ──────────────────────────────────────────────

export interface ProductionGate {
  name: string;
  passed: boolean;
  required: string;
  actual: string;
  description: string;
}

/**
 * Phase 45 Production Guard:
 * A strategy MUST pass ALL gates to reach LIVE_CANDIDATE.
 * Positive backtest P&L alone is NOT sufficient.
 */
export function evaluateProductionGates(params: {
  sampleSize: number;
  oosValidated: boolean;
  walkForwardPassed: boolean;
  profitableAtTwiceCost: boolean;
  regimesCovered: string[];
  brierScore: number | null;
  paperSessionsCompleted: number;
  executionQualityScore: number;
  minSampleRequired?: number;
  minRegimesRequired?: number;
}): {
  gates: ProductionGate[];
  allPassed: boolean;
  blockedBy: string[];
} {
  const minSample = params.minSampleRequired ?? 30;
  const minRegimes = params.minRegimesRequired ?? 3;

  const gates: ProductionGate[] = [
    {
      name: "MINIMUM_SAMPLE_SIZE",
      passed: params.sampleSize >= minSample,
      required: `≥ ${minSample} resolved trades`,
      actual: `${params.sampleSize} trades`,
      description: "Statistical significance requires at least 30 resolved trades",
    },
    {
      name: "OUT_OF_SAMPLE_VALIDATION",
      passed: params.oosValidated,
      required: "OOS period validated",
      actual: params.oosValidated ? "PASSED" : "NOT_VALIDATED",
      description: "Strategy must show positive expectancy on held-out OOS data",
    },
    {
      name: "WALK_FORWARD_VALIDATION",
      passed: params.walkForwardPassed,
      required: "Walk-forward stable",
      actual: params.walkForwardPassed ? "PASSED" : "NOT_RUN",
      description: "Walk-forward test confirms no time-specific overfitting",
    },
    {
      name: "COST_SENSITIVITY",
      passed: params.profitableAtTwiceCost,
      required: "Profitable at 2× base cost",
      actual: params.profitableAtTwiceCost ? "ROBUST" : "COST_FRAGILE",
      description: "Strategy must remain profitable when costs are doubled (transaction cost stress test)",
    },
    {
      name: "REGIME_COVERAGE",
      passed: params.regimesCovered.length >= minRegimes,
      required: `≥ ${minRegimes} distinct market regimes evaluated`,
      actual: `${params.regimesCovered.length} regimes: [${params.regimesCovered.join(", ")}]`,
      description: "Strategy must be evaluated across multiple market regimes to detect regime-specific overfitting",
    },
    {
      name: "CALIBRATION",
      passed: params.brierScore !== null && params.brierScore < 0.25,
      required: "Brier score < 0.25",
      actual: params.brierScore !== null ? `Brier=${params.brierScore.toFixed(3)}` : "NOT_MEASURED",
      description: "Confidence scores must be calibrated — uncalibrated confidence cannot be trusted for position sizing",
    },
    {
      name: "PAPER_TRADING_EVIDENCE",
      passed: params.paperSessionsCompleted >= 10,
      required: "≥ 10 paper trading sessions",
      actual: `${params.paperSessionsCompleted} paper sessions`,
      description: "Strategy must demonstrate consistent paper performance before live promotion",
    },
    {
      name: "EXECUTION_QUALITY",
      passed: params.executionQualityScore >= 0.70,
      required: "Execution quality ≥ 0.70",
      actual: `${(params.executionQualityScore * 100).toFixed(0)}%`,
      description: "Estimated slippage and fill quality must be acceptable in paper trading",
    },
  ];

  const failedGates = gates.filter((g) => !g.passed);
  return {
    gates,
    allPassed: failedGates.length === 0,
    blockedBy: failedGates.map((g) => g.name),
  };
}

// ─── Strategy Scorecard Entry ─────────────────────────────────────────────────

export interface StrategyScorecardEntry {
  strategyId: string;
  strategyName: string;
  // Evidence counts
  sampleSize: number;
  // Precision / Recall
  precision: number | null;
  recall: number | null;
  f1: number | null;
  // Profitability
  expectancy: number | null;          // % per trade
  profitFactor: number | null;
  netPnlPct: number | null;
  maxDrawdownPct: number | null;
  // Risk sensitivity
  profitableAtTwiceCost: boolean;
  // Regime and time fitness
  bestRegime: string | null;
  worstRegime: string | null;
  regimesCovered: string[];
  bestTimeOfDay: string | null;
  // Calibration
  brierScore: number | null;
  confidenceCalibration: "WELL_CALIBRATED" | "ACCEPTABLE" | "POORLY_CALIBRATED" | "NOT_MEASURED";
  // Paper fidelity
  paperWinRate: number | null;
  paperPnlPct: number | null;
  paperSessionsCompleted: number;
  // Signal stability
  signalStability: "STABLE" | "DECLINING" | "VOLATILE" | "UNKNOWN";
  // Alpha decay
  alphaDecayState: "HEALTHY" | "WATCH" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
  // Production readiness
  productionGates: ProductionGate[];
  allGatesPassed: boolean;
  blockedByGates: string[];
  // Final verdict
  status: StrategyScorecardStatus;
  strategyConfidenceScore: number;  // [0, 100]
  justification: string;
}

// Strategy display names
const STRATEGY_NAMES: Record<OfficialIndiaStrategyId, string> = {
  RANGE_EXPANSION: "Range Expansion (WR8)",
  MOMENTUM: "Momentum",
  VOLUME_BREAKOUT: "Volume Breakout",
  OI_BUILDUP: "OI Build-up",
  PCR_EXTREME: "PCR Extreme",
  IV_SPIKE: "IV Spike",
  LIQUIDITY_EDGE: "India Liquidity Edge",
  MAX_PAIN_GRAVITY: "Max-Pain Gravity",
  OPENING_BREAKOUT: "Opening Breakout (ORB)",
};

/**
 * Determine strategy status from gates and sample size.
 */
function determineStatus(
  sampleSize: number,
  allGatesPassed: boolean,
  precision: number | null,
  expectancy: number | null,
  alphaDecayState: string,
): StrategyScorecardStatus {
  if (alphaDecayState === "CRITICAL") return "DEGRADED";
  if (alphaDecayState === "DEGRADED") return "DEGRADED";
  if (sampleSize < 10) return "INSUFFICIENT_EVIDENCE";
  if (allGatesPassed) return "LIVE_CANDIDATE";
  if (sampleSize >= 20 && precision !== null && precision >= 0.55 && expectancy !== null && expectancy > 0) {
    return "PAPER_CANDIDATE";
  }
  if (sampleSize >= 10 && precision !== null && precision >= 0.45) {
    return "PROMISING";
  }
  return "RESEARCH";
}

/**
 * Compute a strategy confidence score [0, 100].
 * This is NOT just win rate. It incorporates evidence quality.
 */
function computeStrategyConfidenceScore(entry: Partial<StrategyScorecardEntry>): number {
  let score = 0;

  // Sample size (max 20 points)
  const n = entry.sampleSize ?? 0;
  score += Math.min(20, (n / 50) * 20);

  // Precision (max 25 points)
  const prec = entry.precision ?? 0;
  score += Math.min(25, prec * 30);

  // Expectancy (max 20 points)
  const exp = entry.expectancy ?? 0;
  score += Math.min(20, Math.max(0, exp / 2) * 10);

  // Calibration (max 10 points)
  if (entry.confidenceCalibration === "WELL_CALIBRATED") score += 10;
  else if (entry.confidenceCalibration === "ACCEPTABLE") score += 6;

  // Normalize P&L to per-trade average
  const paperWinRateVal: number | null = entry.paperWinRate ?? null;
  score += Math.min(15, (paperWinRateVal ?? 0) * 20);

  // Cost robustness (max 5 points)
  if (entry.profitableAtTwiceCost) score += 5;

  // Alpha decay penalty
  if (entry.alphaDecayState === "WATCH") score -= 5;
  if (entry.alphaDecayState === "DEGRADED") score -= 15;
  if (entry.alphaDecayState === "CRITICAL") score -= 25;

  return Math.max(0, Math.min(100, score));
}

/**
 * Build a strategy scorecard entry from performance data.
 */
export function buildScorecardEntry(params: {
  strategyId: OfficialIndiaStrategyId;
  sampleSize: number;
  precision: number | null;
  recall: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  netPnlPct: number | null;
  maxDrawdownPct: number | null;
  profitableAtTwiceCost: boolean;
  bestRegime: string | null;
  worstRegime: string | null;
  regimesCovered: string[];
  bestTimeOfDay: string | null;
  brierScore: number | null;
  paperWinRate: number | null;
  paperPnlPct: number | null;
  paperSessionsCompleted: number;
  signalStability: StrategyScorecardEntry["signalStability"];
  alphaDecayState: StrategyScorecardEntry["alphaDecayState"];
  oosValidated: boolean;
  walkForwardPassed: boolean;
  executionQualityScore: number;
}): StrategyScorecardEntry {
  const f1 =
    params.precision !== null && params.recall !== null && params.precision + params.recall > 0
      ? (2 * params.precision * params.recall) / (params.precision + params.recall)
      : null;

  const calibration: StrategyScorecardEntry["confidenceCalibration"] =
    params.brierScore === null ? "NOT_MEASURED" :
    params.brierScore < 0.15 ? "WELL_CALIBRATED" :
    params.brierScore < 0.25 ? "ACCEPTABLE" : "POORLY_CALIBRATED";

  const { gates, allPassed, blockedBy } = evaluateProductionGates({
    sampleSize: params.sampleSize,
    oosValidated: params.oosValidated,
    walkForwardPassed: params.walkForwardPassed,
    profitableAtTwiceCost: params.profitableAtTwiceCost,
    regimesCovered: params.regimesCovered,
    brierScore: params.brierScore,
    paperSessionsCompleted: params.paperSessionsCompleted,
    executionQualityScore: params.executionQualityScore,
  });

  const status = determineStatus(
    params.sampleSize,
    allPassed,
    params.precision,
    params.expectancy,
    params.alphaDecayState,
  );

  const partial: Partial<StrategyScorecardEntry> = {
    sampleSize: params.sampleSize,
    precision: params.precision,
    expectancy: params.expectancy,
    confidenceCalibration: calibration,
    paperWinRate: params.paperWinRate,
    profitableAtTwiceCost: params.profitableAtTwiceCost,
    alphaDecayState: params.alphaDecayState,
  };
  const confidenceScore = computeStrategyConfidenceScore(partial);

  const justification =
    allPassed
      ? `All ${gates.length} production gates passed — LIVE_CANDIDATE`
      : blockedBy.length > 0
      ? `Blocked by: ${blockedBy.slice(0, 3).join(", ")}${blockedBy.length > 3 ? ` +${blockedBy.length - 3}` : ""}`
      : status === "INSUFFICIENT_EVIDENCE"
      ? `Only ${params.sampleSize} trades — need ≥ 30 for meaningful evaluation`
      : `Score ${confidenceScore.toFixed(0)}/100 — ${status}`;

  return {
    strategyId: params.strategyId,
    strategyName: STRATEGY_NAMES[params.strategyId],
    sampleSize: params.sampleSize,
    precision: params.precision,
    recall: params.recall,
    f1,
    expectancy: params.expectancy,
    profitFactor: params.profitFactor,
    netPnlPct: params.netPnlPct,
    maxDrawdownPct: params.maxDrawdownPct,
    profitableAtTwiceCost: params.profitableAtTwiceCost,
    bestRegime: params.bestRegime,
    worstRegime: params.worstRegime,
    regimesCovered: params.regimesCovered,
    bestTimeOfDay: params.bestTimeOfDay,
    brierScore: params.brierScore,
    confidenceCalibration: calibration,
    paperWinRate: params.paperWinRate,
    paperPnlPct: params.paperPnlPct,
    paperSessionsCompleted: params.paperSessionsCompleted,
    signalStability: params.signalStability,
    alphaDecayState: params.alphaDecayState,
    productionGates: gates,
    allGatesPassed: allPassed,
    blockedByGates: blockedBy,
    status,
    strategyConfidenceScore: confidenceScore,
    justification,
  };
}
