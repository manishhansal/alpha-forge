/**
 * shadow-data-gate.test.ts — §21 live-builder ↔ authoritative data-gate wiring.
 *
 * Proves the production integration point that was missing: the authoritative
 * (DB-backed) surface gate is evaluated FIRST, and its verdict is passed into
 * evaluateShadow as a fail-closed dataGateVeto that can only STRENGTHEN the
 * data block — so the A+ factory + ML decision path cannot emit a TRADE on data
 * the gate rejected. These tests drive the gate purely from dependency status +
 * snapshot fields (no DB), which is the deterministic, market-hours-independent
 * surface of the feature.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateShadowWithDataGate,
  deriveDataGateVeto,
  type ShadowDataGateInput,
} from "@/lib/india/shadow-data-gate";
import type { CanonicalCandidate } from "@/lib/india/shadow-intelligence";
import { defaultMetaArtifact } from "@/lib/india/ml-meta-training";
import type { MetaModelArtifact } from "@/lib/india/ml-meta-decision";
import type { SurfaceGateResult } from "@/lib/market-data/services/signal-surface-data-gate.service";

// A strong, clean candidate whose OWN flags would otherwise let it TRADE.
function candidate(over: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return {
    signalId: "gate-1", underlying: "NIFTY", symbol: "NIFTY-FUT", strategy: "ORB",
    signalFamily: "BREAKOUT", featureFamily: "TREND", direction: "LONG", instrument: "INDEX_FUT",
    timestamp: 1_700_000_000_000, regime: "BULL_TREND",
    dataQuality: 0.95, criticalDataIssue: false, insufficientData: false, liquidity: 0.9,
    quotedSpreadPct: 0.02, relativeVolume: 1.3, volatility: 0.4, minutesFromOpen: 30,
    strategyRegimeSuitable: true, strategySuppressed: false, strategyHealth: 0.9, strategyDegraded: false,
    multiLayerConfirmed: true, layerVetoed: false, hasConflict: false,
    calibratedProbability: 0.7, probabilityLowerBound: 0.6, modelAgreement: 0.85, predictionUncertainty: 0.2,
    rawConfidence: 0.7, calibrationAvailable: true, qualityScore: 85,
    entry: 100, stop: 98, target: 106, expectedWinR: 3, expectedLossR: 1, riskPct: 2, notionalINR: 100000,
    historicalWinRate: 0.62, historicalExpectancyR: 0.5, historicalProfitFactor: 1.9, historicalSampleCount: 200,
    directionalThesisSupported: true, maxPainAgrees: true, pcrAgrees: false, oiAgrees: true,
    isValidatedOptionsFlowStrategy: false, clusterCorrelation: 0.1, riskBlocked: false,
    delayDecayRPerCandle: 0.02, hourlyDecayR: 0.05, ...over,
  };
}

function trainedArtifact(): MetaModelArtifact {
  const a = defaultMetaArtifact();
  a.trainedAtMs = 1_700_000_000_000;
  a.contribution.regimeClassifier = { ...a.contribution.regimeClassifier, addsValue: true, rocAuc: 0.62 };
  return a;
}

const now = 1_700_000_000_000;

describe("deriveDataGateVeto", () => {
  function gate(over: Partial<SurfaceGateResult>): SurfaceGateResult {
    return {
      allowed: true, surface: "APlusFactory", globalState: "DATA_READY",
      reason: "ok", blockedBy: [], degradedBy: [], snapshotConsistent: true, ...over,
    };
  }

  it("allowed gate → no veto", () => {
    const v = deriveDataGateVeto(gate({ allowed: true }), []);
    expect(v.blocked).toBe(false);
    expect(v.insufficient).toBe(false);
  });

  it("disallowed gate → blocked veto", () => {
    const v = deriveDataGateVeto(gate({ allowed: false, reason: "critical dep down" }), []);
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("critical dep down");
  });

  it("dependency INSUFFICIENT_HISTORY → insufficient veto", () => {
    const v = deriveDataGateVeto(gate({ allowed: false }), [
      { name: "history_5m", status: "INSUFFICIENT_HISTORY", critical: true },
    ]);
    expect(v.insufficient).toBe(true);
  });

  it("gate blocked on a history_* dep → insufficient veto", () => {
    const v = deriveDataGateVeto(gate({ allowed: false, blockedBy: ["history_5m:INSUFFICIENT_HISTORY"] }), []);
    expect(v.insufficient).toBe(true);
  });
});

describe("evaluateShadowWithDataGate — fail-closed authoritative wiring", () => {
  const input = (over: Partial<ShadowDataGateInput> = {}): ShadowDataGateInput => ({
    surface: "APlusFactory",
    dependencies: [{ name: "ohlcv", status: "AVAILABLE", critical: true }],
    snapshotFields: [{ name: "price", timestampMs: now, critical: true }],
    ...over,
  });

  it("healthy data → gate allowed, no data veto added", async () => {
    const { gate, dataGateVeto } = await evaluateShadowWithDataGate(candidate(), trainedArtifact(), input());
    expect(gate.allowed).toBe(true);
    expect(dataGateVeto.blocked).toBe(false);
    expect(dataGateVeto.insufficient).toBe(false);
  });

  it("critical dependency UNAVAILABLE → gate blocks → canonical decision REJECT", async () => {
    const { gate, decision } = await evaluateShadowWithDataGate(
      candidate(),
      trainedArtifact(),
      input({ dependencies: [{ name: "ohlcv", status: "UNAVAILABLE", critical: true }] }),
    );
    expect(gate.allowed).toBe(false);
    // The veto OR-s into criticalDataIssue → canonical authority must REJECT.
    expect(decision.canonical.decision).toBe("REJECT");
    expect(decision.canonical.reason).toBe("CRITICAL_DATA_FAILURE");
  });

  it("stale/skewed snapshot (critical fields far apart) → gate blocks → REJECT", async () => {
    const { gate, decision } = await evaluateShadowWithDataGate(
      candidate(),
      trainedArtifact(),
      input({
        snapshotFields: [
          { name: "price", timestampMs: now, critical: true },
          { name: "oi", timestampMs: now - 5 * 60_000, critical: true }, // 5m skew > 60s
        ],
      }),
    );
    expect(gate.snapshotConsistent).toBe(false);
    expect(gate.allowed).toBe(false);
    expect(decision.canonical.decision).toBe("REJECT");
  });

  it("no dependencies AND no snapshot fields → fail closed (blocked → REJECT)", async () => {
    const { gate, decision } = await evaluateShadowWithDataGate(
      candidate(),
      trainedArtifact(),
      input({ dependencies: [], snapshotFields: [] }),
    );
    expect(gate.allowed).toBe(false);
    expect(decision.canonical.decision).toBe("REJECT");
  });

  it("the veto can only STRENGTHEN — a clean candidate is not forced to TRADE, but a blocked one can never TRADE", async () => {
    const { decision } = await evaluateShadowWithDataGate(
      candidate(),
      trainedArtifact(),
      input({ dependencies: [{ name: "ohlcv", status: "AUTH_FAILED", critical: true }] }),
    );
    expect(decision.canonical.decision).not.toBe("TRADE");
  });
});
