/**
 * End-to-end shadow-intelligence tests (Phase 28) + persistence wiring.
 *
 * Proves the new stack is genuinely composed end-to-end: canonical candidate →
 * profitability pipeline → A+ factory → canonical decision → immutable
 * prediction record. Also exercises the failure paths (untrained model, missing
 * data, negative EV, ambiguous outcome, duplicate resolution).
 */

import { describe, it, expect } from "vitest";
import {
  evaluateShadow,
  deriveMetaModelState,
  type CanonicalCandidate,
} from "@/lib/india/shadow-intelligence";
import { defaultMetaArtifact } from "@/lib/india/ml-meta-training";
import type { MetaModelArtifact } from "@/lib/india/ml-meta-decision";
import {
  buildResolutionRecord,
  persistShadowPrediction,
  persistShadowResolution,
  type ResolvedTradeInput,
} from "@/lib/india/shadow-persistence";
import { PrismaSignalRecordStore } from "@/lib/india/prisma-signal-record-store";

// ── a strong, clean canonical candidate ─────────────────────────────────────
function candidate(over: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return {
    signalId: "e2e-1", underlying: "NIFTY", symbol: "NIFTY-FUT", strategy: "ORB",
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

// A "trained" artifact (at least one model addsValue) to test the eligible path.
function trainedArtifact(): MetaModelArtifact {
  const a = defaultMetaArtifact();
  a.trainedAtMs = 1_700_000_000_000;
  a.contribution.regimeClassifier = { ...a.contribution.regimeClassifier, addsValue: true, rocAuc: 0.62 };
  return a;
}

describe("deriveMetaModelState", () => {
  it("default (untrained) artifact → UNTRAINED, zero contribution", () => {
    const s = deriveMetaModelState(defaultMetaArtifact());
    expect(s.state).toBe("UNTRAINED");
    expect(s.contribution).toBe(0);
  });
});

describe("evaluateShadow — end to end", () => {
  it("runs the FULL stack and returns a canonical decision", () => {
    const d = evaluateShadow(candidate(), defaultMetaArtifact());
    // profitability pipeline ran
    expect(d.profitability.version).toBeTruthy();
    expect(typeof d.profitability.netEV.netEVPct).toBe("number");
    // A+ factory ran (produced a bucket)
    expect(d.aPlusBucket).toBeTruthy();
    // canonical decision produced
    expect(["REJECT", "ABSTAIN", "NO_TRADE", "WAIT", "WATCH", "TRADE"]).toContain(d.canonical.decision);
  });

  it("UNTRAINED meta model → decision cannot claim ML edge (WAIT), contribution 0", () => {
    const d = evaluateShadow(candidate(), defaultMetaArtifact());
    expect(d.modelState).toBe("UNTRAINED");
    expect(d.modelContribution).toBe(0);
    // With an untrained model the canonical authority must not TRADE on ML edge.
    expect(d.canonical.decision).not.toBe("TRADE");
  });

  it("critical data issue → REJECT (no fabricated conviction)", () => {
    const d = evaluateShadow(candidate({ criticalDataIssue: true }), trainedArtifact());
    expect(d.canonical.decision).toBe("REJECT");
    expect(d.canonical.reason).toBe("CRITICAL_DATA_FAILURE");
  });

  it("insufficient data → ABSTAIN", () => {
    const d = evaluateShadow(candidate({ insufficientData: true }), trainedArtifact());
    expect(d.canonical.decision).toBe("ABSTAIN");
  });

  it("negative net EV can never be A+ / TRADE", () => {
    // Force a punishing payoff so net EV goes negative.
    const d = evaluateShadow(candidate({ expectedWinR: 0.1, expectedLossR: 3, calibratedProbability: 0.5 }), trainedArtifact());
    expect(["A_PLUS_PRIME", "A_PLUS_STRONG"]).not.toContain(d.aPlusBucket);
    if (d.profitability.netEV.netEVPct <= 0) {
      expect(d.canonical.decision).not.toBe("TRADE");
    }
  });

  it("correlation dedup: duplicate siblings do not inflate independence", () => {
    const base = candidate({ signalId: "c0" });
    const dup1 = candidate({ signalId: "c1", timestamp: base.timestamp + 60000 });
    const dup2 = candidate({ signalId: "c2", timestamp: base.timestamp + 120000 });
    const d = evaluateShadow(base, trainedArtifact(), [dup1, dup2]);
    // all same underlying+direction+family → not 3 independent confirmations
    expect(d.independentSignalCount).toBeLessThan(3);
  });
});

describe("shadow persistence — prediction immutable + resolution idempotent", () => {
  function fakePrisma() {
    const preds = new Map<string, Record<string, unknown>>();
    const res = new Map<string, Record<string, unknown>>();
    const del = (s: Map<string, Record<string, unknown>>) => ({
      findUnique: async ({ where }: { where: { signalId: string } }) => s.get(where.signalId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (s.has(data.signalId as string)) { const e = new Error("dup") as Error & { code?: string }; e.code = "P2002"; throw e; }
        s.set(data.signalId as string, { ...data }); return data;
      },
      findMany: async () => [] as unknown[],
    });
    return { indiaPredictionRecord: del(preds), indiaResolutionRecord: del(res) } as never;
  }
  const resolved = (over: Partial<ResolvedTradeInput> = {}): ResolvedTradeInput => ({
    signalId: "e2e-1", outcome: "TARGET_HIT", exit: 106, exitTime: 2, returnPct: 6, returnR: 3, mfe: 6, mae: 0.5,
    holdingTimeMs: 1, targetReached: true, stopReached: false, costActual: 0.15, slippageActual: 0.05,
    regimeDuringTrade: "BULL_TREND", ambiguous: false, resolvedAt: 2, ...over,
  });

  it("builds an immutable prediction snapshot then persists it once", async () => {
    const prisma = fakePrisma();
    const c = candidate();
    const d = evaluateShadow(c, trainedArtifact());
    const store = new PrismaSignalRecordStore(prisma);
    const first = await persistShadowPrediction(prisma, c, d, store);
    expect(first.persisted).toBe(true);
    // re-emit → not overwritten (immutability preserved, no throw)
    const second = await persistShadowPrediction(prisma, c, d, store);
    expect(second.persisted).toBe(false);
    expect(second.reason).toBe("already_exists_immutable");
  });

  it("net return in the resolution subtracts costs + slippage", () => {
    const rec = buildResolutionRecord(resolved({ returnPct: 6, costActual: 0.15, slippageActual: 0.05 }));
    expect(rec.netReturn).toBeCloseTo(6 - 0.15 - 0.05, 9);
  });

  it("resolution is idempotent — a duplicate close does not double-resolve", async () => {
    const prisma = fakePrisma();
    const c = candidate();
    const d = evaluateShadow(c, trainedArtifact());
    const store = new PrismaSignalRecordStore(prisma);
    await persistShadowPrediction(prisma, c, d, store);
    const r1 = await persistShadowResolution(prisma, resolved(), store);
    expect(r1.persisted).toBe(true);
    const r2 = await persistShadowResolution(prisma, resolved(), store);
    expect(r2.persisted).toBe(false);
    expect(r2.reason).toBe("already_resolved");
  });

  it("ambiguous outcome is preserved (conservative STOP_HIT + ambiguous flag, never silently favorable)", () => {
    // Both stop & target touched intrabar, ordering unknown → conservative STOP_HIT
    // for P&L, with the `ambiguous` flag set so aggregation excludes it. The
    // favorable (TARGET) outcome is NEVER assumed.
    const rec = buildResolutionRecord(resolved({ outcome: "STOP_HIT", ambiguous: true, targetReached: true, stopReached: true }));
    expect(rec.ambiguous).toBe(true);
    expect(rec.outcome).toBe("STOP_HIT");
    expect(rec.outcome).not.toBe("TARGET_HIT");
  });
});
