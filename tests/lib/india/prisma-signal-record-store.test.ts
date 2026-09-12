/**
 * Tests for the durable Prisma-backed SignalRecordStore.
 *
 * Uses an in-memory fake of the two Prisma delegates (indiaPredictionRecord,
 * indiaResolutionRecord) so we can assert the adapter's contract WITHOUT a real
 * database:
 *   • prediction immutability (no second write for the same signalId)
 *   • resolution idempotency (a signal can never resolve twice)
 *   • resolution requires an existing prediction
 *   • round-trip mapping (BigInt ms, JSON snapshots) is lossless
 *   • listCompleted / listOpenPredictions behave correctly
 */

import { describe, it, expect } from "vitest";
import { PrismaSignalRecordStore } from "@/lib/india/prisma-signal-record-store";
import type { PredictionRecord, ResolutionRecord } from "@/lib/india/signal-learning-loop";

// ── minimal in-memory fake of the two Prisma delegates ───────────────────────
function makeFakePrisma() {
  const preds = new Map<string, Record<string, unknown>>();
  const res = new Map<string, Record<string, unknown>>();
  const delegate = (store: Map<string, Record<string, unknown>>) => ({
    findUnique: async ({ where }: { where: { signalId: string } }) => store.get(where.signalId) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (store.has(data.signalId as string)) {
        const e = new Error("Unique constraint failed") as Error & { code?: string };
        e.code = "P2002";
        throw e;
      }
      store.set(data.signalId as string, { ...data });
      return data;
    },
    findMany: async (args?: { include?: { prediction?: boolean }; where?: { resolution?: { is: null } } }) => {
      if (args?.where?.resolution) {
        // open predictions = predictions without a resolution
        return [...preds.values()].filter((p) => !res.has(p.signalId as string));
      }
      // resolutions with prediction joined
      const rows = [...res.values()].map((r) => ({
        ...r,
        prediction: args?.include?.prediction ? (preds.get(r.signalId as string) ?? null) : undefined,
      }));
      return rows;
    },
  });
  return { indiaPredictionRecord: delegate(preds), indiaResolutionRecord: delegate(res) } as never;
}

function pred(signalId: string): PredictionRecord {
  return {
    signalId, symbol: "NIFTY", strategy: "ORB", direction: "LONG", timestamp: 1_700_000_000_000,
    entry: 100, stop: 98, targets: [104, 108], timeframe: "INTRADAY", regime: "BULL_TREND",
    instrumentType: "INDEX_FUT", sector: null, signalQuality: 78, grade: "A", rawConfidence: 0.6,
    calibratedProbability: 0.62, expectedValue: 0.4, modelContributions: { meta: 0.5 },
    qualityComponents: { evEvidence: 0.7 }, abstentionDecision: false,
    featureSnapshot: { rsi: 61 }, derivativesSnapshot: { pcr: 0.9 }, marketContext: { vix: 13.2 },
    dataQuality: 0.95, liquidity: 0.8, costEstimate: 0.15, slippageEstimate: 0.05,
    modelVersion: "test-v1", tradeDate: "2026-09-10",
  };
}
function resolution(signalId: string): ResolutionRecord {
  return {
    signalId, outcome: "TARGET_HIT", exit: 104, exitTime: 1_700_000_600_000, returnPct: 4, returnR: 2,
    mfe: 4.2, mae: 0.5, holdingTimeMs: 600_000, targetReached: true, stopReached: false,
    costActual: 0.15, slippageActual: 0.05, netReturn: 3.8, regimeDuringTrade: "BULL_TREND",
    ambiguous: false, resolvedAt: 1_700_000_600_000,
  };
}

describe("PrismaSignalRecordStore", () => {
  it("persists and round-trips a prediction losslessly", async () => {
    const store = new PrismaSignalRecordStore(makeFakePrisma());
    const p = pred("sig-1");
    await store.savePrediction(p);
    const got = await store.getPrediction("sig-1");
    expect(got).toEqual(p);
  });

  it("enforces prediction IMMUTABILITY — a second write throws", async () => {
    const store = new PrismaSignalRecordStore(makeFakePrisma());
    await store.savePrediction(pred("sig-1"));
    await expect(store.savePrediction(pred("sig-1"))).rejects.toThrow(/immutable/);
  });

  it("resolution requires an existing prediction", async () => {
    const store = new PrismaSignalRecordStore(makeFakePrisma());
    await expect(store.saveResolution(resolution("ghost"))).rejects.toThrow(/unknown signal/);
  });

  it("enforces resolution IDEMPOTENCY — a signal cannot resolve twice", async () => {
    const store = new PrismaSignalRecordStore(makeFakePrisma());
    await store.savePrediction(pred("sig-1"));
    await store.saveResolution(resolution("sig-1"));
    await expect(store.saveResolution(resolution("sig-1"))).rejects.toThrow(/already resolved|idempotent/);
  });

  it("listCompleted joins prediction+resolution; listOpen excludes resolved", async () => {
    const store = new PrismaSignalRecordStore(makeFakePrisma());
    await store.savePrediction(pred("sig-1"));
    await store.savePrediction(pred("sig-2"));
    await store.saveResolution(resolution("sig-1"));
    const completed = await store.listCompleted();
    expect(completed.map((c) => c.prediction.signalId)).toEqual(["sig-1"]);
    expect(completed[0]!.resolution.outcome).toBe("TARGET_HIT");
    const open = await store.listOpenPredictions();
    expect(open.map((p) => p.signalId)).toEqual(["sig-2"]);
  });
});
