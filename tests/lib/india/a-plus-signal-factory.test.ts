/**
 * Tests for the A+ Signal Factory.
 *
 * Proves:
 *   • A+ > A > B on realized win rate / expectancy / profit factor / net return
 *     on untouched OOS outcomes
 *   • A+ is rare (evidence-defined, not a targeted %)
 *   • independentSignalCount: 5 correlated confirmations ≠ 5 independent ones
 *   • duplicate signals do not inflate cluster probability (geometric mean)
 *   • OpportunityScore ranks by net-EV-per-risk, not raw confidence
 *   • bucket mapping + top-opportunities surface (PRIME/STRONG only)
 *   • evidence card completeness
 *   • determinism
 */

import { describe, it, expect } from "vitest";
import {
  runAPlusFactory,
  computeEvidenceScore,
  computeOpportunityScore,
  clusterCandidates,
  independentConfirmations,
  buildEvidenceCard,
  PIPELINE_STAGES,
  type CandidateSignal,
} from "@/lib/india/a-plus-signal-factory";

// ─── Deterministic synthetic candidate generator ─────────────────────────────

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
}
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const T0 = 1_700_000_000_000;

/**
 * Build a candidate whose observable evidence is driven by a latent `edge`
 * ∈ [0,1]. Everything scales with `edge` so that stronger candidates are both
 * scored higher AND (in the test harness) realize better outcomes.
 */
function candidate(id: number, edge: number, rng: () => number, over: Partial<CandidateSignal> = {}): CandidateSignal {
  const c = (v: number) => clamp01(v);
  const j = () => (rng() - 0.5) * 0.06;
  return {
    signalId: `sig-${id}`,
    underlying: over.underlying ?? `U${id}`,     // distinct underlyings by default (independent)
    symbol: over.symbol ?? `U${id}-FUT`,
    strategy: over.strategy ?? "OPENING_BREAKOUT",
    signalFamily: over.signalFamily ?? "BREAKOUT",
    featureFamily: over.featureFamily ?? "TREND_MOMENTUM",
    direction: over.direction ?? "LONG",
    instrument: over.instrument ?? "INDEX_FUT",
    timestamp: over.timestamp ?? T0 + id * 60_000,
    regime: over.regime ?? "BULL_TREND",
    dataQuality: c(0.9 + j()),
    criticalDataIssue: false,
    liquidity: c(0.55 + edge * 0.4 + j()),
    strategyRegimeSuitable: true,
    strategySuppressed: false,
    strategyHealth: c(0.5 + edge * 0.4 + j()),
    strategyDegraded: false,
    multiLayerConfirmed: true,
    layerVetoed: false,
    calibratedProbability: c(0.45 + edge * 0.35 + j()),
    probabilityLowerBound: c(0.4 + edge * 0.3 + j()),
    modelAgreement: c(0.5 + edge * 0.45 + j()),
    predictionUncertainty: c(0.5 - edge * 0.4 + j()),
    qualityScore: c(0.45 + edge * 0.45 + j()) * 100,
    netEVPct: (edge - 0.35) * 2.0,
    netEVR: (edge - 0.35) * 2.0,
    riskPct: 1.0,
    costRobustnessScore: c(0.35 + edge * 0.5 + j()),
    survives2xCost: edge > 0.4,
    counterfactualRobustness: c(0.5 + edge * 0.45 + j()),
    fragile: edge < 0.45,
    historicalWinRate: c(0.45 + edge * 0.3 + j()),
    historicalExpectancyR: (edge - 0.4) * 1.5,
    historicalProfitFactor: 1 + edge,
    historicalSampleCount: Math.round(20 + edge * 200),
    hasConflict: false,
    entry: 100,
    stop: 98,
    target: 104,
    ...over,
  };
}

/** True win probability the harness uses to realize an OOS outcome. */
function trueWinProb(edge: number): number {
  return clamp01(0.25 + 0.55 * edge);
}

const meanOf = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);
function profitFactor(rs: number[]): number {
  const w = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const l = Math.abs(rs.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  return l === 0 ? (w > 0 ? Infinity : 0) : w / l;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("structure", () => {
  it("exposes the full 14-stage pipeline", () => {
    expect(PIPELINE_STAGES).toContain("DATA_QUALITY");
    expect(PIPELINE_STAGES).toContain("CORRELATION_DEDUP");
    expect(PIPELINE_STAGES).toContain("NET_EV");
    expect(PIPELINE_STAGES.length).toBe(14);
  });
});

describe("A+ > A > B on realized OOS outcomes", () => {
  it("higher buckets realize higher win rate / expectancy / profit factor / net return", () => {
    // Generate a large candidate set spanning the edge spectrum, bucket them,
    // then realize outcomes from the TRUE (unobserved) win probability.
    const gen = lcg(11);
    const outcomeRng = lcg(999); // disjoint seed = OOS realization
    const candidates: Array<{ c: CandidateSignal; edge: number }> = [];
    // Large sample so realized (noisy) rates converge to their true monotone
    // ordering across buckets rather than being dominated by sampling noise.
    for (let i = 0; i < 6000; i++) {
      // realistic population: most signals are mediocre (edge concentrated low),
      // a minority are strong — so A+ is naturally rare, not targeted.
      const edge = gen() ** 2;
      candidates.push({ c: candidate(i, edge, gen), edge });
    }
    const result = runAPlusFactory(candidates.map((x) => x.c));
    const bucketById = new Map(result.ranked.map((r) => [r.signalId, r.bucket]));

    // realize outcomes
    const byBucket = new Map<string, number[]>(); // bucket -> realized R
    const winByBucket = new Map<string, number[]>();
    for (const { c, edge } of candidates) {
      const bucket = bucketById.get(c.signalId)!;
      const win = outcomeRng() < trueWinProb(edge);
      const rR = win ? 2 : -1;
      const netR = rR - 0.15; // realistic cost drag
      (byBucket.get(bucket) ?? byBucket.set(bucket, []).get(bucket)!).push(netR);
      (winByBucket.get(bucket) ?? winByBucket.set(bucket, []).get(bucket)!).push(win ? 1 : 0);
    }

    const aPlus = [...(byBucket.get("A_PLUS_PRIME") ?? []), ...(byBucket.get("A_PLUS_STRONG") ?? [])];
    const aPlusWins = [...(winByBucket.get("A_PLUS_PRIME") ?? []), ...(winByBucket.get("A_PLUS_STRONG") ?? [])];
    const a = byBucket.get("A_HIGH") ?? [];
    const aWins = winByBucket.get("A_HIGH") ?? [];
    const b = byBucket.get("B_SELECTIVE") ?? [];
    const bWins = winByBucket.get("B_SELECTIVE") ?? [];

    // require enough population in each bucket for a meaningful comparison
    expect(aPlus.length).toBeGreaterThanOrEqual(20);
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(b.length).toBeGreaterThanOrEqual(20);

    // realized win rate: A+ > A > B
    expect(meanOf(aPlusWins)).toBeGreaterThan(meanOf(aWins));
    expect(meanOf(aWins)).toBeGreaterThan(meanOf(bWins));
    // realized expectancy (net R): A+ > A > B
    expect(meanOf(aPlus)).toBeGreaterThan(meanOf(a));
    expect(meanOf(a)).toBeGreaterThan(meanOf(b));
    // realized net return (sum): A+ mean positive, B mean lower
    expect(meanOf(aPlus)).toBeGreaterThan(0);
    // realized profit factor: A+ > A > B
    expect(profitFactor(aPlus)).toBeGreaterThan(profitFactor(a));
    expect(profitFactor(a)).toBeGreaterThan(profitFactor(b));
  });

  it("A+ is RARE (a small fraction of the candidate set)", () => {
    const gen = lcg(21);
    const candidates: CandidateSignal[] = [];
    for (let i = 0; i < 1500; i++) candidates.push(candidate(i, gen(), gen));
    const result = runAPlusFactory(candidates);
    const aPlusCount = result.stats.aPlusPrime + result.stats.aPlusStrong;
    expect(aPlusCount / result.stats.total).toBeLessThan(0.25); // rare by evidence
    expect(aPlusCount).toBeGreaterThan(0);                      // but achievable
  });
});

describe("correlation dedup — independence not inflated by duplicates", () => {
  it("independentConfirmations collapses same-family duplicates", () => {
    const gen = lcg(31);
    // 5 correlated NIFTY LONGs (2 same-strategy futures, 1 call, 2 banknifty — but all TREND_MOMENTUM/BREAKOUT)
    const members: CandidateSignal[] = [
      candidate(1, 0.8, gen, { underlying: "NIFTY", strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" }),
      candidate(2, 0.8, gen, { underlying: "NIFTY", strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" }),
      candidate(3, 0.8, gen, { underlying: "NIFTY", strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" }),
    ];
    // all share strategy+feature+signal family → 1 independent confirmation
    expect(independentConfirmations(members)).toBe(1);
  });

  it("genuinely distinct families count as more independent confirmations", () => {
    const gen = lcg(32);
    const members: CandidateSignal[] = [
      candidate(1, 0.8, gen, { underlying: "NIFTY", strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" }),
      candidate(2, 0.8, gen, { underlying: "NIFTY", strategy: "OI_BUILDUP", featureFamily: "DERIVATIVES", signalFamily: "OPTIONS_FLOW" }),
    ];
    expect(independentConfirmations(members)).toBe(2);
  });

  it("clustering: 5 correlated NIFTY/BANKNIFTY LONGs are NOT 5 independent confirmations", () => {
    const gen = lcg(33);
    const t = T0;
    const cands: CandidateSignal[] = [
      candidate(1, 0.8, gen, { underlying: "NIFTY", timestamp: t, direction: "LONG", strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" }),
      candidate(2, 0.8, gen, { underlying: "NIFTY", timestamp: t + 60000, direction: "LONG", strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" }),
      candidate(3, 0.8, gen, { underlying: "NIFTY", timestamp: t + 120000, direction: "LONG", strategy: "MOMENTUM", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT", instrument: "INDEX_OPTION" }),
      candidate(4, 0.8, gen, { underlying: "BANKNIFTY", timestamp: t, direction: "LONG", strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" }),
      candidate(5, 0.8, gen, { underlying: "BANKNIFTY", timestamp: t + 60000, direction: "LONG", strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" }),
    ];
    const clusters = clusterCandidates(cands);
    // NIFTY LONGs → one cluster, BANKNIFTY LONGs → another
    const nifty = clusters.find((cl) => cl.clusterId.startsWith("NIFTY"))!;
    const banknifty = clusters.find((cl) => cl.clusterId.startsWith("BANKNIFTY"))!;
    expect(nifty.members.length).toBe(3);
    expect(banknifty.members.length).toBe(2);
    // independence is NOT the member count
    expect(nifty.independentSignalCount).toBeLessThan(3);
    expect(banknifty.independentSignalCount).toBe(1);
  });

  it("duplicate signals do not inflate cluster probability above the members' level", () => {
    const gen = lcg(34);
    const dupProb = 0.7;
    const dup = (i: number) => candidate(i, 0.7, gen, { underlying: "NIFTY", direction: "LONG", timestamp: T0 + i * 1000, calibratedProbability: dupProb, strategy: "OPENING_BREAKOUT", featureFamily: "TREND_MOMENTUM", signalFamily: "BREAKOUT" });
    const clusters = clusterCandidates([dup(1), dup(2), dup(3), dup(4)]);
    const cl = clusters[0]!;
    // geometric mean of identical 0.7's = 0.7; the tiny independent boost cannot
    // apply because all share the same family (independence = 1).
    expect(cl.clusterProbability).toBeLessThanOrEqual(dupProb + 1e-9);
  });
});

describe("OpportunityScore ranks by net-EV-per-risk, not raw confidence", () => {
  it("a high-confidence but negative-EV signal ranks below a lower-confidence positive-EV one", () => {
    const gen = lcg(41);
    const highConfNegEv = candidate(1, 0.5, gen, { calibratedProbability: 0.95, netEVR: -0.2, netEVPct: -0.2, survives2xCost: false });
    const modConfPosEv = candidate(2, 0.5, gen, { calibratedProbability: 0.6, netEVR: 0.8, netEVPct: 0.8, survives2xCost: true, costRobustnessScore: 0.7, counterfactualRobustness: 0.8 });
    const s1 = computeOpportunityScore(highConfNegEv, 1);
    const s2 = computeOpportunityScore(modConfPosEv, 1);
    expect(s2.opportunityScore).toBeGreaterThan(s1.opportunityScore);
    expect(s1.evFactor).toBe(0); // negative EV → zero EV factor → zero opportunity
  });
});

describe("buckets + top opportunities", () => {
  it("only PRIME and STRONG appear in the top-priority surface", () => {
    const gen = lcg(51);
    const candidates: CandidateSignal[] = [];
    for (let i = 0; i < 400; i++) candidates.push(candidate(i, gen(), gen));
    const result = runAPlusFactory(candidates);
    expect(result.topOpportunities.every((r) => r.bucket === "A_PLUS_PRIME" || r.bucket === "A_PLUS_STRONG")).toBe(true);
    // top opportunities are sorted by opportunity score descending
    for (let i = 1; i < result.topOpportunities.length; i++) {
      expect(result.topOpportunities[i - 1]!.opportunity.opportunityScore).toBeGreaterThanOrEqual(result.topOpportunities[i]!.opportunity.opportunityScore - 1e-9);
    }
  });

  it("a hard-gate failure lands in NO_TRADE with the rejecting stage", () => {
    const gen = lcg(52);
    const bad = candidate(1, 0.9, gen, { criticalDataIssue: true });
    const result = runAPlusFactory([bad]);
    expect(result.ranked[0]!.bucket).toBe("NO_TRADE");
    expect(result.ranked[0]!.rejectedAtStage).toBe("DATA_QUALITY");
  });

  it("net-negative EV cannot be A+ even with strong everything else", () => {
    const gen = lcg(53);
    const strongButNegEv = candidate(1, 0.9, gen, { netEVPct: -0.1, netEVR: -0.1, survives2xCost: false });
    const result = runAPlusFactory([strongButNegEv]);
    expect(["A_PLUS_PRIME", "A_PLUS_STRONG"]).not.toContain(result.ranked[0]!.bucket);
  });
});

describe("evidence card", () => {
  it("builds a complete evidence card for an A+ signal (and null otherwise)", () => {
    const gen = lcg(61);
    // craft a clean A+ candidate + an independent confirmation for PRIME
    const strong = (i: number) => candidate(i, 0.95, gen, {
      underlying: "NIFTY", direction: "LONG", timestamp: T0 + i * 1000,
      calibratedProbability: 0.72, probabilityLowerBound: 0.6, modelAgreement: 0.85,
      qualityScore: 82, netEVPct: 1.0, netEVR: 1.0, survives2xCost: true,
      costRobustnessScore: 0.75, counterfactualRobustness: 0.85, fragile: false,
      historicalWinRate: 0.62, historicalSampleCount: 150, predictionUncertainty: 0.2, liquidity: 0.85,
      strategy: i === 61 ? "OPENING_BREAKOUT" : "OI_BUILDUP",
      featureFamily: i === 61 ? "TREND_MOMENTUM" : "DERIVATIVES",
      signalFamily: i === 61 ? "BREAKOUT" : "OPTIONS_FLOW",
    });
    const result = runAPlusFactory([strong(61), strong(62)]);
    const aPlus = result.ranked.find((r) => r.bucket === "A_PLUS_PRIME" || r.bucket === "A_PLUS_STRONG");
    expect(aPlus).toBeDefined();
    const card = buildEvidenceCard(aPlus!)!;
    expect(card.whyItQualifies.length).toBeGreaterThan(0);
    expect(card.probability).toBeGreaterThan(0);
    expect(card.sampleSize).toBeGreaterThan(0);
    expect(card.riskReward).toBeGreaterThan(0);
    expect(card.mainInvalidation).toMatch(/stop/);
    // non-A+ signal → no card
    const gen2 = lcg(62);
    const weak = candidate(99, 0.2, gen2);
    const r2 = runAPlusFactory([weak]);
    expect(buildEvidenceCard(r2.ranked[0]!)).toBeNull();
  });
});

describe("determinism", () => {
  it("identical candidate set → identical ranking", () => {
    const build = () => { const g = lcg(71); return Array.from({ length: 50 }, (_, i) => candidate(i, g(), g)); };
    const r1 = runAPlusFactory(build());
    const r2 = runAPlusFactory(build());
    expect(r1.ranked.map((r) => `${r.signalId}:${r.bucket}`)).toEqual(r2.ranked.map((r) => `${r.signalId}:${r.bucket}`));
  });

  it("evidence score is deterministic", () => {
    const g = lcg(72);
    const c = candidate(1, 0.7, g);
    expect(computeEvidenceScore(c).evidenceScore).toBe(computeEvidenceScore(c).evidenceScore);
  });
});
