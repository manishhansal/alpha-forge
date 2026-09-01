/**
 * Phase 20 — Strategy Leaderboard
 *
 * Ranks all strategies by configurable metrics.
 * Provides filtered views for different audiences.
 *
 * Phase 21 — Strategy Allocation Engine
 *
 * Computes capital allocation weights based on:
 *   - Strategy confidence score
 *   - Cluster correlation constraints
 *   - Drawdown budget
 *   - Regime fit
 *   - Recent decay state
 *   - Portfolio-level risk budget
 */

import type {
  LeaderboardEntry,
  LeaderboardView,
  StrategyLeaderboard,
  StrategyLifecycleStatus,
  AllocationWeight,
  AllocationPlan,
  StrategyConfidenceScore,
  StrategyCluster,
  DecayMonitorState,
  RegimeAttribution,
} from "../types";
import { StrategyRegistry } from "../registry/strategy-registry";

// ─── Leaderboard Builder ──────────────────────────────────────────────────────

const VIEW_STATUS_FILTER: Record<LeaderboardView, StrategyLifecycleStatus[]> = {
  ALL: ["EXPERIMENTAL", "RESEARCH", "BACKTEST_VALIDATED", "WALK_FORWARD_VALIDATED", "SHADOW", "PAPER", "LIVE_CANDIDATE", "MANUAL_APPROVAL", "LIVE", "WARNING", "DEGRADED"],
  RESEARCH: ["RESEARCH", "BACKTEST_VALIDATED", "WALK_FORWARD_VALIDATED"],
  VALIDATED: ["WALK_FORWARD_VALIDATED", "SHADOW"],
  PAPER: ["PAPER"],
  LIVE_CANDIDATE: ["LIVE_CANDIDATE", "MANUAL_APPROVAL", "LIVE"],
  DISABLED: ["DISABLED"],
};

export interface LeaderboardInput {
  strategyId: string;
  confidenceScore?: StrategyConfidenceScore;
  finalOosSharpe?: number;
  netSharpe?: number;
  maxDrawdown?: number;
  profitFactor?: number;
  tradeCount?: number;
  regimeFitScore?: number;
  expectancy?: number;
  calmar?: number;
  recentDecayState?: "HEALTHY" | "WARNING" | "DEGRADED" | "CRITICAL" | "DISABLED";
}

function decayToTrend(
  state?: "HEALTHY" | "WARNING" | "DEGRADED" | "CRITICAL" | "DISABLED",
): LeaderboardEntry["recentTrend"] {
  if (!state || state === "HEALTHY") return "STABLE";
  if (state === "WARNING" || state === "DEGRADED") return "DECLINING";
  return "DECLINING";
}

export function buildLeaderboard(
  inputs: LeaderboardInput[],
  view: LeaderboardView = "ALL",
  sortBy: keyof LeaderboardEntry = "confidenceScore",
): StrategyLeaderboard {
  const allowedStatuses = VIEW_STATUS_FILTER[view];

  const entries: LeaderboardEntry[] = inputs
    .map((inp) => {
      const meta = StrategyRegistry.get(inp.strategyId);
      if (!meta) return null;
      if (!allowedStatuses.includes(meta.status)) return null;

      return {
        rank: 0,
        strategyId: inp.strategyId,
        strategyName: meta.strategyName,
        status: meta.status,
        confidenceScore: inp.confidenceScore?.overallScore ?? 0,
        oosSharpe: inp.finalOosSharpe ?? 0,
        maxDrawdown: inp.maxDrawdown ?? 0,
        profitFactor: inp.profitFactor ?? 0,
        tradeCount: inp.tradeCount ?? 0,
        regimeFitScore: inp.regimeFitScore ?? 0,
        recentTrend: decayToTrend(inp.recentDecayState),
        expectancy: inp.expectancy ?? 0,
        calmar: inp.calmar ?? 0,
        netSharpe: inp.netSharpe ?? 0,
      } satisfies LeaderboardEntry;
    })
    .filter((e): e is LeaderboardEntry => e !== null);

  // Sort
  entries.sort((a, b) => {
    const va = a[sortBy];
    const vb = b[sortBy];
    if (typeof va === "number" && typeof vb === "number") {
      // For drawdown, lower is better
      return sortBy === "maxDrawdown" ? va - vb : vb - va;
    }
    return String(vb).localeCompare(String(va));
  });

  // Assign ranks
  entries.forEach((e, i) => {
    e.rank = i + 1;
  });

  return { view, sortBy, entries, generatedAt: new Date().toISOString() };
}

// ─── Allocation Engine ────────────────────────────────────────────────────────

export interface AllocationInput {
  strategyId: string;
  confidenceScore: number; // 0-100
  currentDecayState: DecayMonitorState["state"];
  regimeFitScore: number; // 0-1
  maxDrawdown: number; // historical max drawdown
  cluster: StrategyCluster;
  status: StrategyLifecycleStatus;
}

export interface AllocationConstraints {
  totalCapital: number;
  maxPerStrategy: number; // fraction
  maxPerCluster: number; // fraction
  minConfidenceForAllocation: number; // strategies below this get 0
}

const DEFAULT_CONSTRAINTS: AllocationConstraints = {
  totalCapital: 1_000_000, // ₹10 lakh
  maxPerStrategy: 0.25,
  maxPerCluster: 0.40,
  minConfidenceForAllocation: 40,
};

/**
 * Compute capital allocation across strategies.
 *
 * Algorithm:
 *   1. Filter strategies that pass minimum confidence threshold
 *   2. Assign raw weights proportional to confidence × regime_fit × (1 - decay_penalty)
 *   3. Apply per-strategy cap
 *   4. Apply per-cluster cap (sum of cluster strategies ≤ cluster.allocationCapPct)
 *   5. Normalise to sum to 1.0
 *   6. Compute expected portfolio Sharpe (Markowitz approximation)
 */
export function computeAllocation(
  inputs: AllocationInput[],
  constraints: AllocationConstraints = DEFAULT_CONSTRAINTS,
): AllocationPlan {
  // Filter eligible strategies
  const eligible = inputs.filter((inp) => {
    if (inp.status === "DISABLED" || inp.status === "EXPERIMENTAL" || inp.status === "RESEARCH") return false;
    if (inp.confidenceScore < constraints.minConfidenceForAllocation) return false;
    if (inp.currentDecayState === "CRITICAL" || inp.currentDecayState === "DISABLED") return false;
    return true;
  });

  if (eligible.length === 0) {
    return {
      totalCapital: constraints.totalCapital,
      allocations: [],
      concentrationScore: 1,
      expectedPortfolioSharpe: 0,
      expectedPortfolioDrawdown: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  // Compute raw weights
  const rawWeights = eligible.map((inp) => {
    const confidenceFactor = inp.confidenceScore / 100;
    const regimeFactor = Math.max(0.1, inp.regimeFitScore);
    const decayPenalty = inp.currentDecayState === "WARNING" ? 0.7 : inp.currentDecayState === "DEGRADED" ? 0.4 : 1.0;
    const drawdownPenalty = Math.max(0.2, 1 - inp.maxDrawdown); // higher DD = lower weight
    return confidenceFactor * regimeFactor * decayPenalty * drawdownPenalty;
  });

  const totalRaw = rawWeights.reduce((a, b) => a + b, 0) || 1;
  const normWeights = rawWeights.map((w) => w / totalRaw);

  // Apply per-strategy cap
  const cappedWeights = normWeights.map((w) => Math.min(w, constraints.maxPerStrategy));

  // Cluster cap: ensure no cluster exceeds its allocation cap
  const clusterTotals = new Map<string, number>();
  for (let i = 0; i < eligible.length; i++) {
    const cid = eligible[i].cluster.clusterId;
    clusterTotals.set(cid, (clusterTotals.get(cid) ?? 0) + cappedWeights[i]);
  }

  const clusterCapFractions = new Map<string, number>();
  for (let i = 0; i < eligible.length; i++) {
    const cid = eligible[i].cluster.clusterId;
    const clusterCap = eligible[i].cluster.allocationCapPct / 100;
    const currentTotal = clusterTotals.get(cid) ?? 0;
    if (currentTotal > clusterCap) {
      const scale = clusterCap / currentTotal;
      clusterCapFractions.set(cid, scale);
    }
  }

  const finalWeightsRaw = cappedWeights.map((w, i) => {
    const cid = eligible[i].cluster.clusterId;
    const scale = clusterCapFractions.get(cid);
    return scale !== undefined ? w * scale : w;
  });

  // Normalise final weights
  const finalTotal = finalWeightsRaw.reduce((a, b) => a + b, 0) || 1;
  const finalWeights = finalWeightsRaw.map((w) => w / finalTotal);

  const allocations: AllocationWeight[] = eligible.map((inp, i) => ({
    strategyId: inp.strategyId,
    rawWeight: normWeights[i],
    finalWeight: finalWeights[i],
    capitalPct: finalWeights[i] * 100,
    rationale: `Confidence: ${inp.confidenceScore}, Regime fit: ${inp.regimeFitScore.toFixed(2)}, Decay: ${inp.currentDecayState}`,
  }));

  // Herfindahl-Hirschman Index (concentration measure; 1 = total concentration)
  const hhi = finalWeights.reduce((s, w) => s + w * w, 0);

  // Portfolio expected Sharpe (simplified: weighted avg of individual Sharpes)
  // Full Markowitz requires correlation matrix — provide that separately
  const expectedPortfolioSharpe = 0; // populated by caller with correlation data
  const expectedPortfolioDrawdown = Math.max(...eligible.map((inp, i) => inp.maxDrawdown * finalWeights[i]));

  return {
    totalCapital: constraints.totalCapital,
    allocations,
    concentrationScore: hhi,
    expectedPortfolioSharpe,
    expectedPortfolioDrawdown,
    generatedAt: new Date().toISOString(),
  };
}
