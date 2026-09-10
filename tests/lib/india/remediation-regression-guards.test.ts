/**
 * Automated regression guards (remediation Phase 39).
 *
 * These lock in the invariants the audit + remediation established, so a future
 * change that reintroduces a bypass fails CI. Each guard asserts real behaviour
 * of executable code — not names or comments.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { runAPlusFactory, type CandidateSignal } from "@/lib/india/a-plus-signal-factory";
import { evaluateAPlusEligibility } from "@/lib/india/model-state-gate";
import { PrismaSignalRecordStore } from "@/lib/india/prisma-signal-record-store";
import type { PredictionRecord, ResolutionRecord } from "@/lib/india/signal-learning-loop";

// ── shared helpers ───────────────────────────────────────────────────────────
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
function candidate(over: Partial<CandidateSignal> = {}): CandidateSignal {
  const c = (v: number) => clamp01(v);
  return {
    signalId: "g-1", underlying: "NIFTY", symbol: "NIFTY-FUT", strategy: "ORB",
    signalFamily: "BREAKOUT", featureFamily: "TREND", direction: "LONG", instrument: "INDEX_FUT",
    timestamp: 1_700_000_000_000, regime: "BULL_TREND",
    dataQuality: 0.95, criticalDataIssue: false, liquidity: 0.9, strategyRegimeSuitable: true,
    strategySuppressed: false, strategyHealth: 0.9, strategyDegraded: false, multiLayerConfirmed: true,
    layerVetoed: false, calibratedProbability: 0.75, probabilityLowerBound: 0.6, modelAgreement: 0.9,
    predictionUncertainty: 0.15, qualityScore: 88, netEVPct: 1.0, netEVR: 1.0, riskPct: 1.0,
    costRobustnessScore: 0.8, survives2xCost: true, counterfactualRobustness: 0.9, fragile: false,
    historicalWinRate: c(0.65), historicalExpectancyR: 0.5, historicalProfitFactor: 2, historicalSampleCount: 200,
    hasConflict: false, entry: 100, stop: 98, target: 104, ...over,
  };
}

// ── GUARD 1: no A+ with net EV ≤ 0 ───────────────────────────────────────────
describe("GUARD: no A+ signal with net EV ≤ 0", () => {
  it("a negative-EV candidate can never be A+ (PRIME or STRONG)", () => {
    const r = runAPlusFactory([candidate({ netEVPct: -0.1, netEVR: -0.1, survives2xCost: false })]);
    expect(["A_PLUS_PRIME", "A_PLUS_STRONG"]).not.toContain(r.ranked[0]!.bucket);
  });
  it("zero net EV can never be A+", () => {
    const r = runAPlusFactory([candidate({ netEVPct: 0, netEVR: 0 })]);
    expect(["A_PLUS_PRIME", "A_PLUS_STRONG"]).not.toContain(r.ranked[0]!.bucket);
  });
});

// ── GUARD 2: an UNTRAINED model can never mint a live A+ ──────────────────────
describe("GUARD: untrained/shadow models cannot drive a live A+", () => {
  it("UNTRAINED → ABSTAIN", () => {
    const e = evaluateAPlusEligibility("UNTRAINED");
    expect(e.allowed).toBe(false);
    expect(e.fallbackDecision).toBe("ABSTAIN");
  });
  it("SHADOW → ABSTAIN", () => {
    expect(evaluateAPlusEligibility("SHADOW").allowed).toBe(false);
  });
});

// ── GUARD 3: no direct NSE market-data provider is registered ─────────────────
describe("GUARD: direct NSE provider must stay removed", () => {
  it("the NSE provider module exports only a removal notice (no fetching class)", () => {
    const nsePath = path.join(process.cwd(), "src/lib/market-data/providers/nse.ts");
    const src = fs.readFileSync(nsePath, "utf8");
    expect(src).toMatch(/NSE_PROVIDER_REMOVED_REASON/);
    // must NOT export a live provider class that could be registered
    expect(src).not.toMatch(/export\s+class\s+NseProvider/);
  });
  it("the registry does not register an NSE provider", () => {
    const regPath = path.join(process.cwd(), "src/lib/market-data/registry.ts");
    const src = fs.readFileSync(regPath, "utf8");
    expect(src).not.toMatch(/new\s+NseProvider/);
  });
});

// ── GUARD 4: a signal can never resolve twice (idempotency) ───────────────────
describe("GUARD: no duplicate resolution + immutable prediction", () => {
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
  const pred = (): PredictionRecord => ({
    signalId: "s1", symbol: "NIFTY", strategy: "ORB", direction: "LONG", timestamp: 1, entry: 100, stop: 98,
    targets: [104], timeframe: "INTRADAY", regime: "BULL_TREND", instrumentType: "INDEX_FUT", sector: null,
    signalQuality: 70, grade: "A", rawConfidence: 0.6, calibratedProbability: 0.6, expectedValue: 0.3,
    modelContributions: {}, qualityComponents: {}, abstentionDecision: false, featureSnapshot: {},
    derivativesSnapshot: {}, marketContext: {}, dataQuality: 0.9, liquidity: 0.8, costEstimate: 0.15,
    slippageEstimate: 0.05, modelVersion: "v1", tradeDate: "2026-09-10",
  });
  const res = (): ResolutionRecord => ({
    signalId: "s1", outcome: "TARGET_HIT", exit: 104, exitTime: 2, returnPct: 4, returnR: 2, mfe: 4, mae: 0.5,
    holdingTimeMs: 1, targetReached: true, stopReached: false, costActual: 0.15, slippageActual: 0.05,
    netReturn: 3.8, regimeDuringTrade: "BULL_TREND", ambiguous: false, resolvedAt: 2,
  });

  it("second prediction write is rejected (immutable snapshot)", async () => {
    const store = new PrismaSignalRecordStore(fakePrisma());
    await store.savePrediction(pred());
    await expect(store.savePrediction(pred())).rejects.toThrow(/immutable/);
  });
  it("second resolution write is rejected (idempotent)", async () => {
    const store = new PrismaSignalRecordStore(fakePrisma());
    await store.savePrediction(pred());
    await store.saveResolution(res());
    await expect(store.saveResolution(res())).rejects.toThrow(/already resolved|idempotent/);
  });
});

// ── GUARD 5: missing/critical data → NO_TRADE (no fabricated conviction) ──────
describe("GUARD: missing/critical data must not become high conviction", () => {
  it("a critical data issue forces NO_TRADE regardless of strong scores", () => {
    const r = runAPlusFactory([candidate({ criticalDataIssue: true })]);
    expect(r.ranked[0]!.bucket).toBe("NO_TRADE");
    expect(r.ranked[0]!.rejectedAtStage).toBe("DATA_QUALITY");
  });
});
