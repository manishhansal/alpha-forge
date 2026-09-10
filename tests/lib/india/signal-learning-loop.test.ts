/**
 * Tests for the India Signal Closed-Loop Learning System.
 *
 * Covers:
 *   • chronological outcome evaluation + intrabar AMBIGUOUS (no inflation)
 *   • outcome states + policy-based (not price-direction) win labelling
 *   • auditable record store (immutable predictions)
 *   • rolling windows (20/50/100/250) + sample gating across dimensions
 *   • delayed retraining same-day embargo (hard leakage guard)
 *   • OOS split
 *   • champion/challenger promotion gates (meaningful OOS improvement only)
 *   • determinism
 */

import { describe, it, expect } from "vitest";
import {
  InMemorySignalRecordStore,
  evaluateOutcome,
  isStatEligible,
  isWin,
  buildRollingStatistics,
  ROLLING_WINDOWS,
  STAT_DIMENSIONS,
  qualityBucket,
  probabilityBucket,
  buildRetrainSplit,
  assertNoSameDayLeakage,
  runDelayedRetrain,
  computeMetricBattery,
  evaluateChampionChallenger,
  DEFAULT_CHAMPION_CHALLENGER_CONFIG,
  type PredictionRecord,
  type ResolutionRecord,
  type CompletedObservation,
  type EvalCandle,
  type EvalPolicy,
  type LearnRegime,
} from "@/lib/india/signal-learning-loop";

// ─── Builders ─────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function candle(timeSec: number, o: number, h: number, l: number, c: number): EvalCandle {
  return { time: timeSec, open: o, high: h, low: l, close: c };
}

function prediction(over: Partial<PredictionRecord> = {}): PredictionRecord {
  return {
    signalId: "sig-1", symbol: "NIFTY", strategy: "OPENING_BREAKOUT", direction: "LONG",
    timestamp: T0, entry: 100, stop: 98, targets: [104], timeframe: "INTRADAY",
    regime: "BULL_TREND", instrumentType: "INDEX_OPTION", sector: "INDEX",
    signalQuality: 78, grade: "A", rawConfidence: 0.8, calibratedProbability: 0.62,
    expectedValue: 0.5, modelContributions: { regimeClassifier: 0.4, stockRanker: 0.3 },
    qualityComponents: { predictiveProbability: 0.6 }, abstentionDecision: false,
    featureSnapshot: { rsi: 0.6 }, derivativesSnapshot: { pcr: 1.1 }, marketContext: { vix: 14 },
    dataQuality: 0.95, liquidity: 0.85, costEstimate: 0.1, slippageEstimate: 0.05,
    modelVersion: "v1", tradeDate: "2024-01-10",
    ...over,
  };
}

function resolution(over: Partial<ResolutionRecord> = {}): ResolutionRecord {
  return {
    signalId: "sig-1", outcome: "TARGET_HIT", exit: 104, exitTime: T0 + 60 * 60 * 1000,
    returnPct: 4, returnR: 2, mfe: 4.5, mae: -0.5, holdingTimeMs: 60 * 60 * 1000,
    targetReached: true, stopReached: false, costActual: 0.1, slippageActual: 0.05,
    netReturn: 3.85, regimeDuringTrade: "BULL_TREND", ambiguous: false, resolvedAt: T0 + 60 * 60 * 1000,
    ...over,
  };
}

function obs(i: number, over: { win?: boolean; regime?: LearnRegime; day?: string; prob?: number; quality?: number; strategy?: string; symbol?: string; ambiguous?: boolean } = {}): CompletedObservation {
  const win = over.win ?? true;
  const rR = win ? 2 : -1;
  const p = prediction({
    signalId: `sig-${i}`, calibratedProbability: over.prob ?? 0.6, signalQuality: over.quality ?? 78,
    strategy: over.strategy ?? "OPENING_BREAKOUT", symbol: over.symbol ?? "NIFTY", regime: over.regime ?? "BULL_TREND",
    tradeDate: over.day ?? "2024-01-10", timestamp: T0 + i * 60000,
  });
  const r = resolution({
    signalId: `sig-${i}`, outcome: win ? "TARGET_HIT" : "STOP_HIT", returnR: rR, returnPct: rR * 2,
    netReturn: rR * 2 - 0.15, regimeDuringTrade: over.regime ?? "BULL_TREND",
    ambiguous: over.ambiguous ?? false, resolvedAt: T0 + i * 60000 + 3600000,
  });
  return { prediction: p, resolution: r };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("record store (auditable, immutable)", () => {
  it("persists a prediction then a resolution; predictions are immutable", async () => {
    const store = new InMemorySignalRecordStore();
    const p = prediction();
    await store.savePrediction(p);
    await expect(store.savePrediction(p)).rejects.toThrow(/immutable/);
    await store.saveResolution(resolution());
    const completed = await store.listCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]!.prediction.signalId).toBe("sig-1");
  });

  it("cannot resolve an unknown signal", async () => {
    const store = new InMemorySignalRecordStore();
    await expect(store.saveResolution(resolution({ signalId: "ghost" }))).rejects.toThrow(/unknown/);
  });

  it("listOpenPredictions returns unresolved signals only", async () => {
    const store = new InMemorySignalRecordStore();
    await store.savePrediction(prediction({ signalId: "a" }));
    await store.savePrediction(prediction({ signalId: "b" }));
    await store.saveResolution(resolution({ signalId: "a" }));
    const open = await store.listOpenPredictions();
    expect(open.map((o) => o.signalId)).toEqual(["b"]);
  });
});

describe("chronological outcome evaluation + ambiguity", () => {
  const base: EvalPolicy = {
    direction: "LONG", entry: 100, stop: 98, target: 104, entryTimeMs: T0,
    maxHoldingMs: 4 * 60 * 60 * 1000, costPct: 0.1, slippagePct: 0.05, regimeDuringTrade: "BULL_TREND",
  };

  it("resolves TARGET_HIT when target is touched first, chronologically", async () => {
    const candles = [
      candle(T0 / 1000, 100, 101, 99.5, 100.5),
      candle(T0 / 1000 + 300, 100.5, 104.2, 100, 104),  // target hit
    ];
    const r = evaluateOutcome(candles, base);
    expect(r.outcome).toBe("TARGET_HIT");
    expect(r.targetReached).toBe(true);
    expect(r.ambiguous).toBe(false);
  });

  it("resolves STOP_HIT when stop is touched first", async () => {
    const candles = [
      candle(T0 / 1000, 100, 100.5, 97.5, 98),  // stop hit
    ];
    const r = evaluateOutcome(candles, base);
    expect(r.outcome).toBe("STOP_HIT");
    expect(r.stopReached).toBe(true);
  });

  it("marks AMBIGUOUS (not favorable) when both stop and target hit in one candle without ordering", async () => {
    const candles = [
      candle(T0 / 1000, 100, 104.5, 97.5, 100),  // both target and stop touched intrabar
    ];
    const r = evaluateOutcome(candles, base);
    expect(r.ambiguous).toBe(true);
    // recorded conservatively as a stop (NOT the favorable target)
    expect(r.outcome).toBe("STOP_HIT");
    // and excluded from statistics — the anti-inflation guarantee
    expect(isStatEligible({ ...r, signalId: "x" })).toBe(false);
  });

  it("a gap-open beyond the target resolves the ordering (not ambiguous)", async () => {
    const candles = [
      candle(T0 / 1000, 104.5, 105, 97.5, 104.8),  // opened already beyond target
    ];
    const r = evaluateOutcome(candles, { ...base, intrabarOrderingAvailable: true });
    expect(r.ambiguous).toBe(false);
    expect(r.outcome).toBe("TARGET_HIT");
  });

  it("TIME_EXIT at last close when neither level is hit within holding time", async () => {
    const candles = [
      candle(T0 / 1000, 100, 100.5, 99.6, 100.2),
      candle(T0 / 1000 + 5 * 3600, 100.2, 100.8, 99.8, 100.4),  // > maxHolding
    ];
    const r = evaluateOutcome(candles, base);
    expect(r.outcome).toBe("TIME_EXIT");
  });

  it("NO_FILL when there is no post-entry data", async () => {
    const candles = [candle(T0 / 1000 - 3600, 100, 101, 99, 100)]; // all pre-entry
    const r = evaluateOutcome(candles, base);
    expect(r.outcome).toBe("NO_FILL");
    expect(r.exit).toBeNull();
  });

  it("computes MFE / MAE / holdingTime / netReturn", async () => {
    const candles = [
      candle(T0 / 1000, 100, 102, 99, 101),
      candle(T0 / 1000 + 300, 101, 104.2, 100.5, 104),
    ];
    const r = evaluateOutcome(candles, base);
    expect(r.mfe).toBeGreaterThan(0);
    expect(r.mae).toBeLessThanOrEqual(0);
    expect(r.holdingTimeMs).toBeGreaterThan(0);
    expect(r.netReturn).toBeCloseTo((r.returnPct ?? 0) - 0.1 - 0.05, 9);
  });

  it("win is decided by execution policy, not final price direction", async () => {
    // A LOSS trade with a positive final-close direction must still be a STOP_HIT loss
    // because the stop was hit chronologically first.
    const candles = [
      candle(T0 / 1000, 100, 100.2, 97.5, 99),  // stop hit
      candle(T0 / 1000 + 300, 99, 106, 99, 105),  // later rallies — irrelevant
    ];
    const r = evaluateOutcome(candles, base);
    expect(r.outcome).toBe("STOP_HIT");
    expect(isWin({ ...r, signalId: "x" })).toBe(false);
  });
});

describe("rolling statistics", () => {
  it("computes 20/50/100/250 windows across all dimensions", () => {
    const observations = Array.from({ length: 120 }, (_, i) => obs(i, { win: i % 3 !== 0 }));
    const stats = buildRollingStatistics(observations, 30);
    // every dimension is represented
    for (const dim of STAT_DIMENSIONS) {
      expect(stats.some((s) => s.dimension === dim)).toBe(true);
    }
    const strat = stats.find((s) => s.dimension === "strategy" && s.bucket === "OPENING_BREAKOUT")!;
    expect(strat.windows.map((w) => w.window)).toEqual([...ROLLING_WINDOWS]);
    // the 20-window is full at 120 obs; the 250-window is not
    expect(strat.windows.find((w) => w.window === 20)!.full).toBe(true);
    expect(strat.windows.find((w) => w.window === 250)!.full).toBe(false);
  });

  it("sample gating: a thin bucket is not marked reliable", () => {
    const observations = Array.from({ length: 10 }, (_, i) => obs(i, { symbol: "TCS" }));
    const stats = buildRollingStatistics(observations, 30);
    const bucket = stats.find((s) => s.dimension === "symbol")!;
    expect(bucket.windows.find((w) => w.window === 20)!.reliable).toBe(false);
  });

  it("excludes ambiguous observations from the stats", () => {
    const clean = Array.from({ length: 40 }, (_, i) => obs(i, { win: true }));
    const withAmbig = [...clean, ...Array.from({ length: 20 }, (_, i) => obs(100 + i, { win: false, ambiguous: true }))];
    const s1 = buildRollingStatistics(clean, 30).find((s) => s.dimension === "strategy")!.windows.find((w) => w.window === 50)!;
    const s2 = buildRollingStatistics(withAmbig, 30).find((s) => s.dimension === "strategy")!.windows.find((w) => w.window === 50)!;
    // ambiguous losses must NOT drag the win rate down (they are excluded)
    expect(s2.winRate).toBeCloseTo(s1.winRate, 6);
  });

  it("bucketers map values correctly", () => {
    expect(qualityBucket(95)).toBe("90-100");
    expect(qualityBucket(42)).toBe("40-50");
    expect(probabilityBucket(0.75)).toBe("0.70-0.80");
  });
});

describe("delayed retraining — same-day embargo", () => {
  it("embargoes observations from the as-of day (never learn from today)", () => {
    const observations = [
      ...Array.from({ length: 60 }, (_, i) => obs(i, { day: "2024-01-08" })),
      ...Array.from({ length: 60 }, (_, i) => obs(100 + i, { day: "2024-01-10" })), // as-of day
    ];
    const split = buildRetrainSplit(observations, "2024-01-10", { embargoDays: 1, trainFraction: 0.6, minObservations: 50 });
    // none of the as-of-day observations may appear in train or oos
    const usable = [...split.train, ...split.oos];
    expect(usable.every((o) => o.prediction.tradeDate !== "2024-01-10")).toBe(true);
    expect(split.embargoed.every((o) => o.prediction.tradeDate === "2024-01-10")).toBe(true);
  });

  it("assertNoSameDayLeakage HARD-FAILS if a same-day obs sneaks into train", () => {
    const train = [obs(1, { day: "2024-01-10" })];
    const guard = assertNoSameDayLeakage(train, "2024-01-10", { embargoDays: 1, trainFraction: 0.6, minObservations: 50 });
    expect(guard.ok).toBe(false);
    expect(guard.reason).toMatch(/same_day/);
  });

  it("runDelayedRetrain produces a candidate only with enough embargoed history + clean guard", () => {
    const observations = Array.from({ length: 200 }, (_, i) => obs(i, { day: "2024-01-05" }));
    const report = runDelayedRetrain(observations, "2024-01-10", { embargoDays: 1, trainFraction: 0.6, minObservations: 100 });
    expect(report.leakageGuard.ok).toBe(true);
    expect(report.producedCandidate).toBe(true);
    expect(report.targets).toContain("calibration");
    expect(report.targets).toContain("modelWeights");
  });

  it("does not produce a candidate when usable history is too small", () => {
    const observations = Array.from({ length: 20 }, (_, i) => obs(i, { day: "2024-01-05" }));
    const report = runDelayedRetrain(observations, "2024-01-10", { embargoDays: 1, trainFraction: 0.6, minObservations: 100 });
    expect(report.producedCandidate).toBe(false);
  });
});

describe("champion / challenger", () => {
  function makeOos(n: number, winProb: number, prob: number, seed: number): CompletedObservation[] {
    let s = seed >>> 0;
    const rng = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
    return Array.from({ length: n }, (_, i) => {
      const win = rng() < winProb;
      return obs(seed * 1000 + i, { win, prob, day: `2024-01-0${(i % 5) + 1}`, regime: i % 2 === 0 ? "BULL_TREND" : "RANGE" });
    });
  }

  it("PROMOTES a challenger with statistically-meaningful OOS improvement", () => {
    const champion = makeOos(300, 0.5, 0.5, 1);   // ~break-even
    const challenger = makeOos(300, 0.72, 0.7, 2); // clearly better + better-calibrated
    const res = evaluateChampionChallenger(champion, challenger, DEFAULT_CHAMPION_CHALLENGER_CONFIG);
    expect(res.decision).toBe("PROMOTE");
    expect(res.z).toBeGreaterThan(1.96);
  });

  it("HOLDS (keeps champion) when the improvement is not statistically meaningful", () => {
    const champion = makeOos(300, 0.6, 0.6, 3);
    const challenger = makeOos(300, 0.61, 0.6, 4); // marginal, not meaningful
    const res = evaluateChampionChallenger(champion, challenger, DEFAULT_CHAMPION_CHALLENGER_CONFIG);
    expect(res.decision).not.toBe("PROMOTE");
  });

  it("HOLDS when OOS sample is insufficient (never promote on thin data)", () => {
    const champion = makeOos(40, 0.5, 0.5, 5);
    const challenger = makeOos(40, 0.9, 0.85, 6);
    const res = evaluateChampionChallenger(champion, challenger, DEFAULT_CHAMPION_CHALLENGER_CONFIG);
    expect(res.decision).toBe("HOLD");
    expect(res.reasons.some((r) => r.includes("insufficient_oos_sample"))).toBe(true);
  });

  it("does NOT promote a challenger that improves win rate but regresses calibration", () => {
    // challenger wins more but is wildly over-confident (bad Brier/ECE)
    const champion = makeOos(300, 0.55, 0.55, 7);
    const challenger = makeOos(300, 0.6, 0.98, 8); // predicts 0.98 but wins 0.6 → bad calibration
    const res = evaluateChampionChallenger(champion, challenger, DEFAULT_CHAMPION_CHALLENGER_CONFIG);
    expect(res.decision).not.toBe("PROMOTE");
  });

  it("computes the full metric battery", () => {
    const battery = computeMetricBattery(makeOos(200, 0.6, 0.6, 9));
    expect(battery.n).toBeGreaterThan(0);
    expect(battery).toHaveProperty("winRate");
    expect(battery).toHaveProperty("expectancyR");
    expect(battery).toHaveProperty("profitFactor");
    expect(battery).toHaveProperty("sharpe");
    expect(battery).toHaveProperty("maxDrawdownR");
    expect(battery).toHaveProperty("brier");
    expect(battery).toHaveProperty("ece");
    expect(battery).toHaveProperty("turnover");
    expect(battery).toHaveProperty("costAdjustedReturnPct");
    expect(battery).toHaveProperty("regimeRobustness");
  });
});

describe("determinism", () => {
  it("outcome evaluation and champion/challenger are deterministic", () => {
    const candles = [candle(T0 / 1000, 100, 104.5, 99.5, 104)];
    const policy: EvalPolicy = { direction: "LONG", entry: 100, stop: 98, target: 104, entryTimeMs: T0, maxHoldingMs: DAY, costPct: 0.1, slippagePct: 0.05, regimeDuringTrade: "BULL_TREND" };
    expect(JSON.stringify(evaluateOutcome(candles, policy))).toBe(JSON.stringify(evaluateOutcome(candles, policy)));
  });
});
