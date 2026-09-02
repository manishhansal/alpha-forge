/**
 * Signal Conflict Resolver & Opportunity Clustering — Phases 25–26
 *
 * Resolves conflicts when multiple signals disagree, and clusters
 * correlated signals into a single OpportunityCluster to prevent
 * double-counting.
 *
 * Key rules:
 *   1. Correlated strategies (ORB + Momentum + VolumeBreakout on same breakout)
 *      represent ONE opportunity, not three independent confirmations.
 *   2. Signal conflicts are explicitly resolved — not averaged.
 *   3. Every resolved decision is explained.
 *   4. The cluster's representative signal is the highest-scoring APPROVED signal.
 */

import type { SignalDirection } from "./types";
import type { OpportunityCluster } from "./types";

// ─── Conflict Resolution ──────────────────────────────────────────────────────

export type ConflictResolutionOutcome = "BUY" | "SELL" | "WAIT" | "NO_TRADE";

export interface SignalVote {
  strategyId: string;
  direction: SignalDirection;
  score: number;
  confidence: number;
  source: "STRATEGY" | "ML" | "DERIVATIVES";
}

export interface ConflictResolutionResult {
  outcome: ConflictResolutionOutcome;
  direction: SignalDirection;
  resolvedConfidence: number;
  conflictDetected: boolean;
  conflictType:
    | "DIRECTION_SPLIT"
    | "SCORE_DISAGREEMENT"
    | "REGIME_CONFLICT"
    | "DERIVATIVES_CONFLICT"
    | "ML_CONFLICT"
    | "NO_CONFLICT";
  explanation: string;
  votes: {
    buy: number;
    sell: number;
    neutral: number;
  };
}

/**
 * Resolve a set of conflicting signal votes.
 *
 * Resolution algorithm:
 *   1. Count weighted votes by direction
 *   2. If one direction has clear majority (>60% weight) → TRADE
 *   3. If split (40–60%) → WAIT
 *   4. If all votes neutral → NO_TRADE
 *   5. Regime conflict overrides direction → WAIT
 *
 * Example:
 *   Strategy A: BUY (score 0.8)
 *   Strategy B: SELL (score 0.6)
 *   ML: BUY (score 0.7)
 *   Market Regime: RANGE
 *   Options Flow: BEARISH
 *   → WAIT (conflicting signals with range regime)
 */
export function resolveSignalConflict(
  votes: SignalVote[],
  marketRegime: "TREND" | "RANGE" | "VOLATILE" | "UNKNOWN",
  optionsFlowBias: "BULLISH" | "BEARISH" | "NEUTRAL",
): ConflictResolutionResult {
  if (votes.length === 0) {
    return {
      outcome: "NO_TRADE",
      direction: "NEUTRAL",
      resolvedConfidence: 0,
      conflictDetected: false,
      conflictType: "NO_CONFLICT",
      explanation: "No signal votes to resolve",
      votes: { buy: 0, sell: 0, neutral: 0 },
    };
  }

  // Weighted vote tally
  let buyWeight = 0;
  let sellWeight = 0;
  let neutralWeight = 0;
  let totalWeight = 0;

  for (const vote of votes) {
    const w = vote.score * vote.confidence;
    totalWeight += w;
    if (vote.direction === "LONG") buyWeight += w;
    else if (vote.direction === "SHORT") sellWeight += w;
    else neutralWeight += w;
  }

  if (totalWeight === 0) {
    return {
      outcome: "NO_TRADE",
      direction: "NEUTRAL",
      resolvedConfidence: 0,
      conflictDetected: false,
      conflictType: "NO_CONFLICT",
      explanation: "All votes have zero weight",
      votes: { buy: 0, sell: 0, neutral: 0 },
    };
  }

  const buyPct = buyWeight / totalWeight;
  const sellPct = sellWeight / totalWeight;

  const votesSummary = {
    buy: Math.round(buyPct * 100),
    sell: Math.round(sellPct * 100),
    neutral: Math.round((neutralWeight / totalWeight) * 100),
  };

  // Range regime reduces conviction threshold
  const confirmThreshold = marketRegime === "TREND" ? 0.60 : 0.70;
  const conflictThreshold = 1 - confirmThreshold;

  // Direction conflict detection
  const directionConflict = Math.min(buyPct, sellPct) > 0.25;

  // Derivatives conflict: options flow opposes the lead direction
  const leadDirection = buyPct > sellPct ? "LONG" : "SHORT";
  const derivativesConflict =
    (leadDirection === "LONG" && optionsFlowBias === "BEARISH") ||
    (leadDirection === "SHORT" && optionsFlowBias === "BULLISH");

  // Resolution
  let outcome: ConflictResolutionOutcome;
  let direction: SignalDirection = "NEUTRAL";
  let conflictType: ConflictResolutionResult["conflictType"] = "NO_CONFLICT";
  let explanation: string;
  let resolvedConfidence = 0;

  if (marketRegime === "RANGE" && directionConflict) {
    outcome = "WAIT";
    direction = "NEUTRAL";
    conflictType = "REGIME_CONFLICT";
    explanation = `RANGE regime + direction split (buy ${votesSummary.buy}% / sell ${votesSummary.sell}%) → WAIT`;
  } else if (directionConflict && derivativesConflict) {
    outcome = "NO_TRADE";
    direction = "NEUTRAL";
    conflictType = "DERIVATIVES_CONFLICT";
    explanation = `Direction split AND derivatives opposing → NO_TRADE`;
  } else if (buyPct >= confirmThreshold && !derivativesConflict) {
    outcome = "BUY";
    direction = "LONG";
    resolvedConfidence = buyPct;
    explanation = `Clear BUY consensus (${votesSummary.buy}% weight)`;
    if (directionConflict) {
      conflictType = "SCORE_DISAGREEMENT";
      explanation += ` with weak opposition (${votesSummary.sell}% sell votes)`;
    }
  } else if (sellPct >= confirmThreshold && !derivativesConflict) {
    outcome = "SELL";
    direction = "SHORT";
    resolvedConfidence = sellPct;
    explanation = `Clear SELL consensus (${votesSummary.sell}% weight)`;
    if (directionConflict) {
      conflictType = "SCORE_DISAGREEMENT";
      explanation += ` with weak opposition (${votesSummary.buy}% buy votes)`;
    }
  } else if (buyPct >= confirmThreshold && derivativesConflict) {
    outcome = "WAIT";
    direction = "LONG";
    conflictType = "DERIVATIVES_CONFLICT";
    explanation = `BUY ${votesSummary.buy}% but derivatives opposing → WAIT`;
  } else if (sellPct >= confirmThreshold && derivativesConflict) {
    outcome = "WAIT";
    direction = "SHORT";
    conflictType = "DERIVATIVES_CONFLICT";
    explanation = `SELL ${votesSummary.sell}% but derivatives opposing → WAIT`;
  } else {
    outcome = "WAIT";
    direction = "NEUTRAL";
    conflictType = "DIRECTION_SPLIT";
    explanation = `Insufficient consensus (buy ${votesSummary.buy}% / sell ${votesSummary.sell}%) → WAIT`;
  }

  return {
    outcome,
    direction,
    resolvedConfidence,
    conflictDetected: directionConflict || derivativesConflict,
    conflictType,
    explanation,
    votes: votesSummary,
  };
}

// ─── Opportunity Clustering ───────────────────────────────────────────────────

/**
 * Strategy groups that commonly fire on the same underlying opportunity.
 * These are considered CORRELATED — not independent confirmations.
 *
 * A breakout on NIFTY triggers: OPENING_BREAKOUT + MOMENTUM + VOLUME_BREAKOUT
 * simultaneously. This is ONE opportunity, not three.
 */
const CORRELATED_STRATEGY_GROUPS: Array<{
  label: string;
  strategies: string[];
  correlationReason: string;
}> = [
  {
    label: "BREAKOUT_GROUP",
    strategies: ["OPENING_BREAKOUT", "MOMENTUM", "VOLUME_BREAKOUT"],
    correlationReason:
      "These three strategies all fire on the same price breakout — the volume confirms the momentum which is confirmed by the opening range break.",
  },
  {
    label: "OPTIONS_FLOW_GROUP",
    strategies: ["LIQUIDITY_EDGE", "MAX_PAIN_GRAVITY", "PCR_EXTREME"],
    correlationReason:
      "These strategies all derive from the same option chain data — a PCR extreme feeds into both LIQUIDITY_EDGE and MAX_PAIN_GRAVITY simultaneously.",
  },
  {
    label: "OI_SIGNALS_GROUP",
    strategies: ["OI_BUILDUP", "LIQUIDITY_EDGE"],
    correlationReason:
      "OI buildup is one of the five factors in LIQUIDITY_EDGE — they often fire together on the same OI change.",
  },
];

function getStrategiesOnSameInstrument(
  signals: Array<{ signalId: string; strategyId: string; sourceType: string; instrument: string; timestamp: number; direction: SignalDirection; confidence: number; score: number }>,
  targetInstrument: string,
  windowMs: number,
  refTimestamp: number,
): typeof signals {
  return signals.filter(
    (s) =>
      s.instrument === targetInstrument &&
      Math.abs(s.timestamp - refTimestamp) <= windowMs,
  );
}

function areStrategiesCorrelated(stratA: string, stratB: string): boolean {
  for (const group of CORRELATED_STRATEGY_GROUPS) {
    if (group.strategies.includes(stratA) && group.strategies.includes(stratB)) {
      return true;
    }
  }
  return false;
}

function computeClusterCorrelationId(
  instrument: string,
  direction: SignalDirection,
  approximateTimeMs: number,
): string {
  // Round to nearest 5 minutes to catch near-simultaneous signals
  const timeKey = Math.floor(approximateTimeMs / (5 * 60 * 1000));
  return `${instrument}_${direction}_${timeKey}`;
}

/**
 * Cluster a set of signals into OpportunityClusters.
 *
 * Two signals belong to the same cluster when:
 *   1. Same instrument
 *   2. Same direction (or one is NEUTRAL)
 *   3. Within a 10-minute window
 *   4. Their strategies are in a correlated group
 *
 * Returns both the clusters and the updated signals with correlationId set.
 */
export function clusterSignals(
  signals: Array<{
    signalId: string;
    strategyId: string;
    sourceType: string;
    instrument: string;
    timestamp: number;
    direction: SignalDirection;
    confidence: number;
    score: number;
  }>,
  windowMs = 10 * 60 * 1000, // 10 minutes
): {
  clusters: OpportunityCluster[];
  correlationIdBySignal: Map<string, string>;
} {
  const clusters: OpportunityCluster[] = [];
  const correlationIdBySignal = new Map<string, string>();
  const assigned = new Set<string>();

  for (const signal of signals) {
    if (assigned.has(signal.signalId)) continue;

    // Find correlated signals
    const correlatedSignals = signals.filter((other) => {
      if (other.signalId === signal.signalId) return false;
      if (other.instrument !== signal.instrument) return false;
      if (Math.abs(other.timestamp - signal.timestamp) > windowMs) return false;
      if (
        other.direction !== signal.direction &&
        other.direction !== "NEUTRAL" &&
        signal.direction !== "NEUTRAL"
      )
        return false;
      return areStrategiesCorrelated(signal.strategyId, other.strategyId);
    });

    const correlationId = computeClusterCorrelationId(
      signal.instrument,
      signal.direction,
      signal.timestamp,
    );

    if (correlatedSignals.length === 0) {
      // Solo signal — single-member cluster
      correlationIdBySignal.set(signal.signalId, correlationId);
      assigned.add(signal.signalId);
      clusters.push({
        clusterId: `${signal.instrument}_${signal.strategyId}_${signal.timestamp}`,
        correlationId,
        opportunityLabel: `${signal.instrument} ${signal.direction} — ${signal.strategyId}`,
        instrument: signal.instrument,
        opportunityStartMs: signal.timestamp,
        direction: signal.direction,
        signals: [
          {
            signalId: signal.signalId,
            strategyId: signal.strategyId,
            sourceType: signal.sourceType as any,
            confidence: signal.confidence,
            score: signal.score,
          },
        ],
        representativeSignalId: signal.signalId,
        independentConfirmations: 1,
        clusterConfidence: signal.confidence,
        deduplicated: false,
        createdAt: Date.now(),
      });
      continue;
    }

    // Multi-signal cluster
    const allInCluster = [signal, ...correlatedSignals.filter((s) => !assigned.has(s.signalId))];
    for (const s of allInCluster) {
      assigned.add(s.signalId);
      correlationIdBySignal.set(s.signalId, correlationId);
    }

    // Select representative: highest score
    const representative = allInCluster.reduce((best, s) =>
      s.score > best.score ? s : best,
    );

    // Independent confirmations: count strategies not in the same correlated group
    const strategyGroups = new Set<string>();
    for (const s of allInCluster) {
      const group =
        CORRELATED_STRATEGY_GROUPS.find((g) =>
          g.strategies.includes(s.strategyId),
        )?.label ?? s.strategyId;
      strategyGroups.add(group);
    }
    const independentConfirmations = strategyGroups.size;

    // Combined confidence: NOT sum — geometric mean (avoids over-counting)
    const confidences = allInCluster.map((s) => s.confidence);
    const clusterConfidence =
      Math.pow(
        confidences.reduce((prod, c) => prod * c, 1),
        1 / confidences.length,
      );

    // Strategy-grouped label
    const stratLabels = allInCluster.map((s) => s.strategyId).join("+");
    const clusterId = `${signal.instrument}_${signal.direction}_${signal.timestamp}`;

    clusters.push({
      clusterId,
      correlationId,
      opportunityLabel: `${signal.instrument} ${signal.direction} — ${stratLabels}`,
      instrument: signal.instrument,
      opportunityStartMs: signal.timestamp,
      direction: signal.direction,
      signals: allInCluster.map((s) => ({
        signalId: s.signalId,
        strategyId: s.strategyId,
        sourceType: s.sourceType as any,
        confidence: s.confidence,
        score: s.score,
      })),
      representativeSignalId: representative.signalId,
      independentConfirmations,
      clusterConfidence,
      deduplicated: allInCluster.length > 1,
      createdAt: Date.now(),
    });
  }

  return { clusters, correlationIdBySignal };
}
