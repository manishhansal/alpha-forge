/**
 * Tests — Signal Conflict Resolver & Opportunity Clustering (Phases 25–26)
 *
 * Regression: three strategies on the same breakout must form ONE cluster,
 * not be counted as independent evidence.
 */

import { describe, it, expect } from "vitest";
import {
  resolveSignalConflict,
  clusterSignals,
} from "@/lib/signal-intelligence/conflict-resolver";
import type { SignalVote } from "@/lib/signal-intelligence/conflict-resolver";

describe("resolveSignalConflict", () => {
  it("resolves BUY when clear BUY majority", () => {
    const votes: SignalVote[] = [
      { strategyId: "OPENING_BREAKOUT", direction: "LONG", score: 0.8, confidence: 0.75, source: "STRATEGY" },
      { strategyId: "MOMENTUM", direction: "LONG", score: 0.7, confidence: 0.70, source: "STRATEGY" },
      { strategyId: "ML_REGIME", direction: "LONG", score: 0.6, confidence: 0.65, source: "ML" },
    ];
    const result = resolveSignalConflict(votes, "TREND", "NEUTRAL");
    expect(result.outcome).toBe("BUY");
    expect(result.direction).toBe("LONG");
    expect(result.conflictDetected).toBe(false);
  });

  it("resolves WAIT when direction split in RANGE regime", () => {
    const votes: SignalVote[] = [
      { strategyId: "OPENING_BREAKOUT", direction: "LONG", score: 0.7, confidence: 0.65, source: "STRATEGY" },
      { strategyId: "PCR_EXTREME", direction: "SHORT", score: 0.65, confidence: 0.60, source: "STRATEGY" },
      { strategyId: "ML_REGIME", direction: "LONG", score: 0.5, confidence: 0.55, source: "ML" },
    ];
    const result = resolveSignalConflict(votes, "RANGE", "NEUTRAL");
    expect(result.outcome).toBe("WAIT");
  });

  it("resolves WAIT when BUY majority but derivatives opposing", () => {
    const votes: SignalVote[] = [
      { strategyId: "OPENING_BREAKOUT", direction: "LONG", score: 0.8, confidence: 0.75, source: "STRATEGY" },
      { strategyId: "MOMENTUM", direction: "LONG", score: 0.7, confidence: 0.70, source: "STRATEGY" },
    ];
    const result = resolveSignalConflict(votes, "TREND", "BEARISH");
    expect(result.outcome).toBe("WAIT");
    expect(result.conflictType).toBe("DERIVATIVES_CONFLICT");
  });

  it("resolves WAIT or NO_TRADE for direction split with opposing derivatives", () => {
    const votes: SignalVote[] = [
      { strategyId: "OPENING_BREAKOUT", direction: "LONG", score: 0.7, confidence: 0.65, source: "STRATEGY" },
      { strategyId: "PCR_EXTREME", direction: "SHORT", score: 0.7, confidence: 0.65, source: "STRATEGY" },
    ];
    const result = resolveSignalConflict(votes, "VOLATILE", "BEARISH");
    // Both WAIT and NO_TRADE are valid outcomes for conflict + opposing derivatives
    expect(["NO_TRADE", "WAIT"]).toContain(result.outcome);
  });

  it("returns NO_TRADE for empty votes", () => {
    const result = resolveSignalConflict([], "TREND", "NEUTRAL");
    expect(result.outcome).toBe("NO_TRADE");
  });

  it("includes explanation for every resolution", () => {
    const votes: SignalVote[] = [
      { strategyId: "OPENING_BREAKOUT", direction: "LONG", score: 0.8, confidence: 0.75, source: "STRATEGY" },
    ];
    const result = resolveSignalConflict(votes, "TREND", "NEUTRAL");
    expect(result.explanation).toBeTruthy();
    expect(result.explanation.length).toBeGreaterThan(10);
  });
});

describe("REGRESSION: opportunity clustering prevents double-counting (Phase 26)", () => {
  const baseTs = Date.now() - 2 * 60 * 1000; // 2 minutes ago

  const signals = [
    { signalId: "sig-1", strategyId: "OPENING_BREAKOUT", sourceType: "STRATEGY", instrument: "NIFTY", timestamp: baseTs, direction: "LONG" as const, confidence: 0.72, score: 78 },
    { signalId: "sig-2", strategyId: "MOMENTUM", sourceType: "STRATEGY", instrument: "NIFTY", timestamp: baseTs + 60_000, direction: "LONG" as const, confidence: 0.65, score: 70 },
    { signalId: "sig-3", strategyId: "VOLUME_BREAKOUT", sourceType: "STRATEGY", instrument: "NIFTY", timestamp: baseTs + 120_000, direction: "LONG" as const, confidence: 0.68, score: 72 },
    { signalId: "sig-4", strategyId: "MAX_PAIN_GRAVITY", sourceType: "STRATEGY", instrument: "BANKNIFTY", timestamp: baseTs, direction: "SHORT" as const, confidence: 0.60, score: 65 },
  ];

  it("clusters ORB + Momentum + VolumeBreakout on same NIFTY breakout into ONE cluster", () => {
    const { clusters } = clusterSignals(signals, 15 * 60 * 1000);
    const niftyLongClusters = clusters.filter(
      (c) => c.instrument === "NIFTY" && c.direction === "LONG",
    );
    // These three strategies should cluster into one opportunity
    expect(niftyLongClusters.length).toBe(1);
    expect(niftyLongClusters[0].signals.length).toBe(3);
    expect(niftyLongClusters[0].deduplicated).toBe(true);
  });

  it("does NOT cluster NIFTY and BANKNIFTY as the same opportunity", () => {
    const { clusters } = clusterSignals(signals, 15 * 60 * 1000);
    const bankniftyCluster = clusters.find((c) => c.instrument === "BANKNIFTY");
    expect(bankniftyCluster).toBeDefined();
    expect(bankniftyCluster?.instrument).toBe("BANKNIFTY");
  });

  it("clusterConfidence is geometric mean, not sum", () => {
    const { clusters } = clusterSignals(signals, 15 * 60 * 1000);
    const niftyCluster = clusters.find(
      (c) => c.instrument === "NIFTY" && c.direction === "LONG",
    );
    expect(niftyCluster).toBeDefined();
    if (niftyCluster) {
      // Geometric mean of 0.72, 0.65, 0.68 ≈ 0.68
      const expectedGeomMean = Math.pow(0.72 * 0.65 * 0.68, 1 / 3);
      expect(niftyCluster.clusterConfidence).toBeCloseTo(expectedGeomMean, 2);
    }
  });

  it("all signals get a correlationId assigned", () => {
    const { correlationIdBySignal } = clusterSignals(signals, 15 * 60 * 1000);
    for (const sig of signals) {
      expect(correlationIdBySignal.has(sig.signalId)).toBe(true);
    }
  });

  it("clustered signals share the same correlationId", () => {
    const { correlationIdBySignal } = clusterSignals(signals, 15 * 60 * 1000);
    const id1 = correlationIdBySignal.get("sig-1");
    const id2 = correlationIdBySignal.get("sig-2");
    const id3 = correlationIdBySignal.get("sig-3");
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it("BANKNIFTY signal has different correlationId from NIFTY cluster", () => {
    const { correlationIdBySignal } = clusterSignals(signals, 15 * 60 * 1000);
    const niftyId = correlationIdBySignal.get("sig-1");
    const bankniftyId = correlationIdBySignal.get("sig-4");
    expect(niftyId).not.toBe(bankniftyId);
  });

  it("representative signal is the highest-scoring signal in cluster", () => {
    const { clusters } = clusterSignals(signals, 15 * 60 * 1000);
    const niftyCluster = clusters.find(
      (c) => c.instrument === "NIFTY" && c.direction === "LONG",
    );
    expect(niftyCluster?.representativeSignalId).toBe("sig-1"); // score 78 is highest
  });
});
