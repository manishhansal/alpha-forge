/**
 * Phase 16 — Strategy Promotion Engine
 * Phase 17 — Strategy Demotion Engine
 *
 * CRITICAL RULES:
 *   1. A strategy can NEVER be automatically promoted to LIVE.
 *   2. LIVE promotion ALWAYS requires a human approval token.
 *   3. Demotion can be automatic.
 *   4. Every promotion/demotion is recorded with metrics snapshot.
 *
 * Lifecycle:
 *   EXPERIMENTAL → RESEARCH → BACKTEST_VALIDATED → WALK_FORWARD_VALIDATED
 *   → SHADOW → PAPER → LIVE_CANDIDATE → MANUAL_APPROVAL → LIVE
 *
 * Each stage has explicit evidence gates.
 */

import type {
  StrategyLifecycleStatus,
  PromotionGate,
  StrategyPromotionRecord,
  StrategyDemotionRecord,
  DemotionTrigger,
  PerformanceMetrics,
  MonteCarloRobustnessScore,
  ParameterStabilityScore,
  CostAttributionReport,
  DecayMonitorState,
  PaperPerformanceComparison,
} from "../types";
import { StrategyRegistry } from "../registry/strategy-registry";

// ─── Promotion Gate Definitions ───────────────────────────────────────────────

export interface PromotionInput {
  strategyId: string;
  fromStatus: StrategyLifecycleStatus;
  inSampleMetrics?: PerformanceMetrics;
  validationMetrics?: PerformanceMetrics;
  finalOosMetrics?: PerformanceMetrics;
  paperMetrics?: PerformanceMetrics;
  shadowMetrics?: PerformanceMetrics;
  monteCarlo?: MonteCarloRobustnessScore;
  parameterStability?: ParameterStabilityScore;
  costReport?: CostAttributionReport;
  decayMonitor?: DecayMonitorState;
  paperComparison?: PaperPerformanceComparison;
  hypothesisDefined?: boolean;
  paperSessionCount?: number;
  /** Only required for LIVE_CANDIDATE → LIVE */
  approvalToken?: string;
  approvedBy?: string;
}

// ─── Gate Evaluators ──────────────────────────────────────────────────────────

function gate(
  name: string,
  description: string,
  required: number,
  actual: number,
  passed: boolean,
): PromotionGate {
  return { gateName: name, passed, requiredValue: required, actualValue: actual, description };
}

function checkResearch(input: PromotionInput): PromotionGate[] {
  return [
    gate(
      "HYPOTHESIS_DEFINED",
      "Strategy must have a declared hypothesis",
      1,
      input.hypothesisDefined ? 1 : 0,
      input.hypothesisDefined === true,
    ),
  ];
}

function checkBacktestValidated(input: PromotionInput): PromotionGate[] {
  const m = input.finalOosMetrics ?? input.validationMetrics;
  const cost = input.costReport;
  return [
    gate("MIN_TRADE_COUNT", "≥30 OOS trades required", 30, m?.tradeCount ?? 0, (m?.tradeCount ?? 0) >= 30),
    gate("POSITIVE_EXPECTANCY", "OOS expectancy > 0", 0, m?.expectancy ?? -1, (m?.expectancy ?? -1) > 0),
    gate("MAX_DRAWDOWN_LIMIT", "OOS max drawdown < 30%", 0.30, m?.maxDrawdown ?? 1, (m?.maxDrawdown ?? 1) < 0.30),
    gate("COST_ADJUSTED_PROFITABLE", "Net PnL after costs > 0", 0, cost?.baseline.netPnl ?? -1, (cost?.baseline.netPnl ?? -1) > 0),
    gate("SHARPE_MINIMUM", "OOS Sharpe ≥ 0.3", 0.3, m?.sharpe ?? -1, (m?.sharpe ?? -1) >= 0.3),
    gate("HYPOTHESIS_DEFINED", "Hypothesis must be defined", 1, input.hypothesisDefined ? 1 : 0, input.hypothesisDefined === true),
  ];
}

function checkWalkForwardValidated(input: PromotionInput): PromotionGate[] {
  const m = input.finalOosMetrics;
  const ps = input.parameterStability;
  const mc = input.monteCarlo;
  return [
    gate("OOS_SHARPE_STABLE", "OOS Sharpe ≥ 0.5", 0.5, m?.sharpe ?? -1, (m?.sharpe ?? -1) >= 0.5),
    gate("PARAMETER_NOT_OVERFIT", "Parameter stability not OVERFIT_SUSPECTED", 1, ps?.label === "OVERFIT_SUSPECTED" ? 0 : 1, ps?.label !== "OVERFIT_SUSPECTED"),
    gate("MONTE_CARLO_NOT_FRAGILE", "Monte Carlo robustness not FRAGILE", 1, mc?.robustLabel === "FRAGILE" ? 0 : 1, mc?.robustLabel !== "FRAGILE"),
    gate("MIN_TRADE_COUNT_OOS", "≥50 OOS trades", 50, m?.tradeCount ?? 0, (m?.tradeCount ?? 0) >= 50),
    gate("NOT_COST_FRAGILE", "Not COST_FRAGILE (survives 2× costs)", 1, input.costReport?.costFragile ? 0 : 1, !(input.costReport?.costFragile)),
  ];
}

function checkShadow(input: PromotionInput): PromotionGate[] {
  const shadowM = input.shadowMetrics;
  return [
    gate("SHADOW_PERIOD_MIN", "≥10 shadow trades observed", 10, shadowM?.tradeCount ?? 0, (shadowM?.tradeCount ?? 0) >= 10),
    gate("SHADOW_SHARPE", "Shadow Sharpe ≥ 0.3", 0.3, shadowM?.sharpe ?? -1, (shadowM?.sharpe ?? -1) >= 0.3),
    gate("DECAY_STATE_OK", "Decay state not CRITICAL or DISABLED", 1, (input.decayMonitor?.state === "CRITICAL" || input.decayMonitor?.state === "DISABLED") ? 0 : 1, input.decayMonitor?.state !== "CRITICAL" && input.decayMonitor?.state !== "DISABLED"),
  ];
}

function checkPaper(input: PromotionInput): PromotionGate[] {
  const paperM = input.paperMetrics;
  const comp = input.paperComparison;
  return [
    gate("PAPER_MIN_TRADES", "≥20 paper trades", 20, paperM?.tradeCount ?? 0, (paperM?.tradeCount ?? 0) >= 20),
    gate("PAPER_POSITIVE_EXPECTANCY", "Paper expectancy > 0", 0, paperM?.expectancy ?? -1, (paperM?.expectancy ?? -1) > 0),
    gate("PAPER_MAX_DRAWDOWN", "Paper max drawdown < 25%", 0.25, paperM?.maxDrawdown ?? 1, (paperM?.maxDrawdown ?? 1) < 0.25),
    gate("NO_MATERIAL_BACKTEST_DRIFT", "Paper vs backtest drift not material", 1, comp?.requiresInvestigation ? 0 : 1, !(comp?.requiresInvestigation)),
    gate("DECAY_STATE_OK", "Decay state HEALTHY or WARNING", 1, (input.decayMonitor?.state === "DEGRADED" || input.decayMonitor?.state === "CRITICAL" || input.decayMonitor?.state === "DISABLED") ? 0 : 1, input.decayMonitor?.state === "HEALTHY" || input.decayMonitor?.state === "WARNING"),
  ];
}

function checkLiveCandidate(input: PromotionInput): PromotionGate[] {
  const paperM = input.paperMetrics;
  const sessions = input.paperSessionCount ?? 0;
  return [
    gate("PAPER_SESSIONS_MIN", "≥20 paper trading sessions", 20, sessions, sessions >= 20),
    gate("PAPER_SESSIONS_PREFERRED", "≥40 paper trading sessions (preferred)", 40, sessions, sessions >= 40),
    gate("PAPER_SHARPE", "Paper Sharpe ≥ 0.6", 0.6, paperM?.sharpe ?? -1, (paperM?.sharpe ?? -1) >= 0.6),
    gate("PAPER_PROFIT_FACTOR", "Paper profit factor ≥ 1.2", 1.2, paperM?.profitFactor ?? 0, (paperM?.profitFactor ?? 0) >= 1.2),
    gate("DECAY_STATE_HEALTHY", "Decay state HEALTHY", 1, input.decayMonitor?.state === "HEALTHY" ? 1 : 0, input.decayMonitor?.state === "HEALTHY"),
    gate("COST_NOT_FRAGILE", "Strategy survives 2× cost stress", 1, input.costReport?.costFragile ? 0 : 1, !(input.costReport?.costFragile)),
  ];
}

function checkLive(input: PromotionInput): PromotionGate[] {
  // LIVE requires manual human approval — no automatic gate can pass this
  const hasToken = Boolean(input.approvalToken && input.approvedBy);
  return [
    gate(
      "MANUAL_HUMAN_APPROVAL",
      "Explicit human approval required — LIVE cannot be auto-promoted",
      1,
      hasToken ? 1 : 0,
      hasToken,
    ),
  ];
}

// ─── Promotion Engine ─────────────────────────────────────────────────────────

const PROMOTION_FLOW: Record<StrategyLifecycleStatus, StrategyLifecycleStatus> = {
  EXPERIMENTAL: "RESEARCH",
  RESEARCH: "BACKTEST_VALIDATED",
  BACKTEST_VALIDATED: "WALK_FORWARD_VALIDATED",
  WALK_FORWARD_VALIDATED: "SHADOW",
  SHADOW: "PAPER",
  PAPER: "LIVE_CANDIDATE",
  LIVE_CANDIDATE: "MANUAL_APPROVAL",
  MANUAL_APPROVAL: "LIVE",
  LIVE: "LIVE",
  WARNING: "LIVE",
  DEGRADED: "PAPER",
  DISABLED: "DISABLED",
};

/**
 * Evaluate promotion eligibility for a strategy.
 * Does NOT automatically update the registry.
 *
 * Returns the promotion record. Caller must call
 * StrategyRegistry.updateStatus() if they want to apply the promotion.
 *
 * IMPORTANT: LIVE promotion is ALWAYS blocked unless approvalToken is provided.
 */
export function evaluatePromotion(input: PromotionInput): StrategyPromotionRecord {
  const { fromStatus } = input;
  const toStatus = PROMOTION_FLOW[fromStatus] ?? fromStatus;

  let gates: PromotionGate[] = [];

  switch (toStatus) {
    case "RESEARCH":
      gates = checkResearch(input);
      break;
    case "BACKTEST_VALIDATED":
      gates = checkBacktestValidated(input);
      break;
    case "WALK_FORWARD_VALIDATED":
      gates = checkWalkForwardValidated(input);
      break;
    case "SHADOW":
      gates = checkShadow(input);
      break;
    case "PAPER":
      gates = checkPaper(input);
      break;
    case "LIVE_CANDIDATE":
      gates = checkLiveCandidate(input);
      break;
    case "LIVE":
      gates = checkLive(input);
      break;
    default:
      gates = [];
  }

  const allGatesPassed = gates.length > 0 && gates.every((g) => g.passed);

  return {
    strategyId: input.strategyId,
    fromStatus,
    toStatus: allGatesPassed ? toStatus : fromStatus,
    gates,
    allGatesPassed,
    promotedAt: allGatesPassed ? new Date().toISOString() : null,
    promotedBy: allGatesPassed
      ? toStatus === "LIVE"
        ? (input.approvedBy ?? "UNKNOWN")
        : "AUTO"
      : "NONE",
    notes: allGatesPassed
      ? `All ${gates.length} gates passed. Promoted ${fromStatus} → ${toStatus}.`
      : `${gates.filter((g) => !g.passed).length} gate(s) failed. Promotion blocked.`,
  };
}

/**
 * Apply a promotion if all gates pass.
 * Mutates the StrategyRegistry status.
 */
export function applyPromotion(input: PromotionInput): StrategyPromotionRecord {
  const record = evaluatePromotion(input);
  if (record.allGatesPassed && record.toStatus !== record.fromStatus) {
    StrategyRegistry.updateStatus(input.strategyId, record.toStatus);
  }
  return record;
}

// ─── Demotion Engine ──────────────────────────────────────────────────────────

const DEMOTION_FLOW: Partial<Record<StrategyLifecycleStatus, StrategyLifecycleStatus>> = {
  LIVE: "DEGRADED",
  DEGRADED: "PAPER",
  PAPER: "SHADOW",
  SHADOW: "RESEARCH",
  WARNING: "DEGRADED",
  LIVE_CANDIDATE: "PAPER",
  MANUAL_APPROVAL: "PAPER",
  WALK_FORWARD_VALIDATED: "RESEARCH",
  BACKTEST_VALIDATED: "RESEARCH",
};

export interface DemotionInput {
  strategyId: string;
  currentStatus: StrategyLifecycleStatus;
  trigger: DemotionTrigger;
  reason: string;
  metricsSnapshot?: Partial<PerformanceMetrics>;
  demotedBy?: string;
  /** If true, demote directly to DISABLED regardless of normal flow */
  forceDisable?: boolean;
}

/**
 * Evaluate and apply a demotion.
 * Demotion can be automatic (demotedBy = "AUTO").
 * Mutates the StrategyRegistry status.
 */
export function applyDemotion(input: DemotionInput): StrategyDemotionRecord {
  const toStatus: StrategyLifecycleStatus = input.forceDisable
    ? "DISABLED"
    : (DEMOTION_FLOW[input.currentStatus] ?? "RESEARCH");

  StrategyRegistry.updateStatus(input.strategyId, toStatus);

  return {
    strategyId: input.strategyId,
    fromStatus: input.currentStatus,
    toStatus,
    trigger: input.trigger,
    demotionReason: input.reason,
    metricsSnapshot: input.metricsSnapshot ?? {},
    demotedAt: new Date().toISOString(),
    demotedBy: input.demotedBy ?? "AUTO",
  };
}

/**
 * Check if a strategy should be automatically demoted based on its
 * current monitoring state.
 */
export function checkAutoDemotion(
  strategyId: string,
  currentStatus: StrategyLifecycleStatus,
  decayState: DecayMonitorState | undefined,
  costReport: CostAttributionReport | undefined,
  paperMetrics: PerformanceMetrics | undefined,
): DemotionInput | null {
  // DISABLED — no further action
  if (currentStatus === "DISABLED") return null;

  // Critical alpha decay
  if (decayState?.state === "CRITICAL" && currentStatus !== "RESEARCH") {
    return {
      strategyId,
      currentStatus,
      trigger: "ALPHA_DECAY",
      reason: `Alpha decay reached CRITICAL state. Latest Sharpe: ${decayState.latestMetrics?.sharpe?.toFixed(2) ?? "N/A"} vs baseline ${decayState.historicalBaseline.sharpe?.toFixed(2) ?? "N/A"}`,
      metricsSnapshot: decayState.latestMetrics ? { sharpe: decayState.latestMetrics.sharpe } : {},
    };
  }

  // Excessive drawdown in live paper
  if (
    paperMetrics &&
    paperMetrics.maxDrawdown > 0.40 &&
    (currentStatus === "LIVE" || currentStatus === "PAPER" || currentStatus === "LIVE_CANDIDATE")
  ) {
    return {
      strategyId,
      currentStatus,
      trigger: "EXCESSIVE_DRAWDOWN",
      reason: `Paper trading max drawdown exceeded 40%: ${(paperMetrics.maxDrawdown * 100).toFixed(1)}%`,
      metricsSnapshot: { maxDrawdown: paperMetrics.maxDrawdown },
    };
  }

  // Cost deterioration
  if (costReport?.costFragile && currentStatus !== "EXPERIMENTAL" && currentStatus !== "RESEARCH") {
    return {
      strategyId,
      currentStatus,
      trigger: "COST_DETERIORATION",
      reason: `Strategy is COST_FRAGILE. Becomes unprofitable at 2× cost stress.`,
    };
  }

  return null;
}
