/**
 * India Signal Center Aggregator
 *
 * Aggregates signals from ALL Indian market signal families into one
 * canonical feed. Implements deduplication via OpportunityCluster grouping.
 *
 * Deduplication rule:
 *   Signals with the same (symbol, direction) within a 30-minute window
 *   are grouped into one OpportunityCluster.
 *   - 5 signals confirming the same trade = 1 cluster, NOT 5 trades.
 *   - Each cluster has exactly 1 primary signal (highest quality).
 *   - independentConfirmations counts unique signal FAMILIES, not signal count.
 */

import type {
  UnifiedIndiaSignal,
  OpportunityCluster,
  IndiaSignalFamily,
  SignalGrade,
  IndiaSignalCenterResponse,
  MarketRegime,
} from "./types";

// ── Deduplication / Clustering ────────────────────────────────────────────────

const CLUSTER_WINDOW_MS = 30 * 60_000; // 30 minutes

/**
 * Compute the correlation key for a signal.
 * Signals with the same key within CLUSTER_WINDOW_MS are grouped.
 */
function correlationKey(signal: UnifiedIndiaSignal): string {
  const slot = Math.floor(new Date(signal.generatedAt).getTime() / CLUSTER_WINDOW_MS);
  return `${signal.symbol}:${signal.direction}:${slot}`;
}

/**
 * Grade ordering for priority comparison.
 */
const GRADE_ORDER: Record<SignalGrade, number> = {
  S: 6, A: 5, B: 4, C: 3, D: 2, F: 1,
};

function betterGrade(a: SignalGrade, b: SignalGrade): SignalGrade {
  return GRADE_ORDER[a] >= GRADE_ORDER[b] ? a : b;
}

/**
 * Cluster a flat list of signals, grouping same-instrument same-direction
 * signals within the 30-minute window into OpportunityClusters.
 *
 * Uses DUP-001 fix: cross-timeframe duplicates are merged, not counted separately.
 */
export function clusterSignals(signals: UnifiedIndiaSignal[]): {
  clusters: OpportunityCluster[];
  unclustered: UnifiedIndiaSignal[];
} {
  const map = new Map<string, UnifiedIndiaSignal[]>();

  for (const signal of signals) {
    const key = correlationKey(signal);
    const existing = map.get(key) ?? [];
    existing.push(signal);
    map.set(key, existing);
  }

  const clusters: OpportunityCluster[] = [];
  const singletons: UnifiedIndiaSignal[] = [];

  for (const [, group] of map) {
    if (group.length === 1) {
      singletons.push(group[0]!);
      continue;
    }

    // Sort by quality descending
    const sorted = [...group].sort(
      (a, b) => b.qualityScore - a.qualityScore || b.confidence - a.confidence,
    );
    const primary = sorted[0]!;

    // Count unique families (not signal count)
    const families = new Set<IndiaSignalFamily>(group.map((s) => s.signalFamily));
    const confirmingFamilies = Array.from(families);

    // Weighted quality/confidence averages
    const totalQuality = group.reduce((sum, s) => sum + s.qualityScore, 0) / group.length;
    const totalConf = group.reduce((sum, s) => sum + s.confidence, 0) / group.length;

    const grade = group.reduce(
      (best, s) => betterGrade(best, s.grade),
      "F" as SignalGrade,
    );

    clusters.push({
      clusterId: `cluster:${primary.correlationId}`,
      correlationId: primary.correlationId,
      primarySignal: primary,
      allSignals: sorted,
      independentConfirmations: confirmingFamilies.length,
      confirmingFamilies,
      clusterQuality: Math.round(totalQuality),
      clusterConfidence: Math.round(totalConf * 100) / 100,
      grade,
      createdAt: primary.generatedAt,
    });
  }

  // Sort clusters: S/A grade first, then by quality
  clusters.sort(
    (a, b) =>
      GRADE_ORDER[b.grade] - GRADE_ORDER[a.grade] ||
      b.clusterQuality - a.clusterQuality,
  );

  return { clusters, unclustered: singletons };
}

/**
 * Merge clusters and unclustered singletons into the top-opportunities list.
 * Limit to top N to avoid overwhelming the dashboard.
 */
export function buildTopOpportunities(
  clusters: OpportunityCluster[],
  unclustered: UnifiedIndiaSignal[],
  maxItems = 20,
): OpportunityCluster[] {
  // Wrap singletons as 1-signal clusters for uniform display
  const singletonClusters: OpportunityCluster[] = unclustered.map((s) => ({
    clusterId: `single:${s.id}`,
    correlationId: s.correlationId,
    primarySignal: s,
    allSignals: [s],
    independentConfirmations: 1,
    confirmingFamilies: [s.signalFamily],
    clusterQuality: s.qualityScore,
    clusterConfidence: s.confidence,
    grade: s.grade,
    createdAt: s.generatedAt,
  }));

  const all = [...clusters, ...singletonClusters].sort(
    (a, b) =>
      GRADE_ORDER[b.grade] - GRADE_ORDER[a.grade] ||
      b.clusterQuality - a.clusterQuality,
  );

  return all.slice(0, maxItems);
}

/**
 * Compute stats for the signal center response.
 */
export function computeSignalStats(
  allSignals: UnifiedIndiaSignal[],
  clusters: OpportunityCluster[],
): IndiaSignalCenterResponse["stats"] {
  return {
    totalCandidates: allSignals.length,
    generated: allSignals.filter(
      (s) => s.status !== "ABSTAINED" && s.rejectionReason === null,
    ).length,
    approved: allSignals.filter(
      (s) => s.status === "ACTIVE" || s.status === "PAPER_EXECUTED",
    ).length,
    rejected: allSignals.filter((s) => s.rejectionReason !== null).length,
    abstained: allSignals.filter((s) => s.status === "ABSTAINED").length,
    clustered: clusters.reduce((sum, c) => sum + c.allSignals.length, 0),
    paperExecuted: allSignals.filter((s) => s.status === "PAPER_EXECUTED").length,
  };
}

/**
 * Build the complete signal center response from raw signal arrays.
 */
export function buildSignalCenterResponse(opts: {
  signals: UnifiedIndiaSignal[];
  rejected: UnifiedIndiaSignal[];
  regime: MarketRegime;
  marketOpen: boolean;
  niftyLevel: number | null;
  niftyChangePct: number | null;
  bankNiftyLevel: number | null;
  vixLevel: number | null;
  breadthBullish: number | null;
  dataProviders: IndiaSignalCenterResponse["dataProviders"];
}): IndiaSignalCenterResponse {
  const {
    signals, rejected, regime, marketOpen,
    niftyLevel, niftyChangePct, bankNiftyLevel, vixLevel, breadthBullish, dataProviders,
  } = opts;

  const activeSignals = signals.filter(
    (s) => s.status !== "EXPIRED" && s.status !== "SL_HIT" && s.status !== "TP3_HIT",
  );

  const { clusters, unclustered } = clusterSignals(activeSignals);
  const topOpportunities = buildTopOpportunities(clusters, unclustered);
  const stats = computeSignalStats([...signals, ...rejected], clusters);

  return {
    snapshotAt: new Date().toISOString(),
    marketOpen,
    regime,
    niftyLevel,
    niftyChangePct,
    bankNiftyLevel,
    vixLevel,
    breadthBullish,
    topOpportunities,
    allSignals: signals,
    clusters,
    rejected,
    stats,
    dataProviders,
  };
}
