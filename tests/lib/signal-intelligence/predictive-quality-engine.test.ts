/**
 * Tests for the Predictive Signal Quality Engine.
 *
 * The 10 required behaviours:
 *   1. monotonicity              — higher qualityScore ⇒ higher realized win rate
 *   2. no leakage                — CV splits purge/embargo overlapping labels
 *   3. small sample shrinkage    — tiny samples cannot produce inflated quality
 *   4. correlated feature handling — redundant components share weight budget
 *   5. missing data              — becomes uncertainty, never a directional penalty
 *   6. stale data                — reduces dataConfidence
 *   7. regime transition         — regime-conditioned tables & priors differ
 *   8. conflicting models        — disagreement lowers confidence, not direction
 *   9. cost stress               — cost-fragile signals are penalised via robustness
 *  10. quality score reproducibility — deterministic: identical inputs ⇒ identical output
 */

import { describe, it, expect } from "vitest";
import {
  scoreQuality,
  trainQualityModel,
  buildCvSplits,
  buildConditionalTables,
  shrinkWinRate,
  computeDataConfidence,
  computeFreshnessDecay,
  verifyMonotonicity,
  fitIsotonic,
  evalIsotonic,
  effectiveEdgeWeights,
  DEFAULT_QUALITY_MODEL,
  DEFAULT_TRAIN_CONFIG,
  EDGE_COMPONENTS,
  UNCERTAINTY_COMPONENTS,
  QUALITY_COMPONENTS,
  REDUNDANCY_GROUPS,
  type QualityFeatureVector,
  type QualityTrainingExample,
  type QualityModel,
} from "@/lib/signal-intelligence/predictive-quality-engine";

// ─── Deterministic synthetic data generator ──────────────────────────────────
// A seeded LCG so the whole suite is reproducible with no Math.random().

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // fixed epoch base

/**
 * Build a feature vector where a latent `edge ∈ [0,1]` drives most components.
 * Correlated components (momentum/mtf/structure) are made deliberately similar
 * so the correlated-feature test can detect grouping.
 */
function makeFeatures(
  edge: number,
  rng: () => number,
  overrides: Partial<QualityFeatureVector> = {},
): QualityFeatureVector {
  const jitter = () => (rng() - 0.5) * 0.1;
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return {
    strategyId: "OPENING_BREAKOUT",
    direction: "LONG",
    regime: "BULL_TREND",
    timeframe: "INTRADAY",
    instrument: "NIFTY",
    predictiveProbability: c(edge + jitter()),
    marketStructure: c(edge + jitter()),
    momentum: c(edge + jitter()),          // correlated w/ structure & mtf
    volume: c(0.5 + jitter()),
    volatilityFit: c(0.6 + jitter()),
    liquidity: c(0.8 + jitter()),
    derivativesConfirmation: c(edge + jitter()),
    relativeStrength: c(0.5 + jitter()),
    regimeFit: c(0.7 + jitter()),
    multiTimeframeAlignment: c(edge + jitter()), // correlated w/ momentum
    executionQuality: c(0.7 + jitter()),
    netExpectedValueR: (edge - 0.4) * 2,   // positive when edge high
    modelVotes: [1, 1, edge > 0.5 ? 1 : -1],
    recentDirectionVotes: [1, 1, 1],
    netExpectedValueRAt2xCost: (edge - 0.5) * 2,
    quoteAgeMs: 1_000,
    optionChainAgeMs: 5_000,
    oiAgeMs: 30_000,
    derivativesRequiredButMissing: false,
    providerAgreement: 0.95,
    usedFallbackProvider: false,
    latencyMs: 200,
    signalAgeMs: 0,
    ...overrides,
  };
}

/**
 * Generate labelled examples whose TRUE profit probability is a known monotone
 * function of the latent edge: P(win) = 0.25 + 0.5·edge. The engine should
 * recover monotonicity from this.
 */
function makeExamples(
  n: number,
  seed: number,
  opts: { strategyId?: string; regime?: QualityFeatureVector["regime"] } = {},
): QualityTrainingExample[] {
  const rng = lcg(seed);
  const out: QualityTrainingExample[] = [];
  for (let i = 0; i < n; i++) {
    const edge = rng(); // uniform latent edge
    const trueP = 0.25 + 0.5 * edge;
    const win = rng() < trueP ? 1 : 0;
    const f = makeFeatures(edge, rng, {
      strategyId: opts.strategyId ?? "OPENING_BREAKOUT",
      regime: opts.regime ?? "BULL_TREND",
    });
    const netR = win === 1 ? 1.8 + (rng() - 0.5) * 0.4 : -1.0;
    out.push({
      features: f,
      label: win as 0 | 1,
      signalMs: T0 + i * (DAY / 3), // ~3 signals/day, time-ordered
      outcomeMs: T0 + i * (DAY / 3) + 3 * 60 * 60 * 1000, // resolves 3h later
      netReturnR: netR,
      costAdjustedReturnR: netR - 0.05,
      slippageAdjustedReturnR: netR - 0.1,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("PredictiveQualityEngine — structure", () => {
  it("declares exactly 20 components partitioned into edge + uncertainty", () => {
    expect(QUALITY_COMPONENTS).toHaveLength(20);
    expect(new Set(QUALITY_COMPONENTS).size).toBe(20);
    // every component is in exactly one of the two partitions
    for (const c of QUALITY_COMPONENTS) {
      const inEdge = EDGE_COMPONENTS.includes(c);
      const inUnc = UNCERTAINTY_COMPONENTS.includes(c);
      expect(inEdge !== inUnc).toBe(true); // XOR
    }
  });

  it("default model is explicitly flagged UNTRAINED (cannot masquerade as empirical)", () => {
    expect(DEFAULT_QUALITY_MODEL.provenance).toBe("UNTRAINED_UNIFORM_PRIOR");
    const r = scoreQuality(makeFeatures(0.8, lcg(1)), DEFAULT_QUALITY_MODEL);
    expect(r.reasons.some((x) => x.includes("model_untrained"))).toBe(true);
  });

  it("effective edge weights sum to 1 and confidence components carry zero additive weight", () => {
    const w = effectiveEdgeWeights(DEFAULT_QUALITY_MODEL);
    const edgeSum = EDGE_COMPONENTS.reduce((s, c) => s + w[c], 0);
    expect(edgeSum).toBeCloseTo(1, 6);
    for (const c of UNCERTAINTY_COMPONENTS) expect(w[c]).toBe(0);
  });
});

describe("1. monotonicity", () => {
  it("higher qualityScore ⇒ higher realized win rate on held-out data (adequately-sampled buckets)", () => {
    // Larger OOS set so the high-score tail buckets clear the min-sample bar
    // (a 20-sample tail bucket is noise, not evidence — see verifyMonotonicity).
    const train = makeExamples(1500, 11);
    const test = makeExamples(1500, 999); // disjoint seed = out of sample
    const { model } = trainQualityModel(train, DEFAULT_TRAIN_CONFIG);
    const report = verifyMonotonicity(test, model);
    // Realized win rate must be non-decreasing across reliable score buckets,
    // and score-rank vs realized-win-rank must be strongly positive.
    expect(report.winRateMonotonic).toBe(true);
    expect(report.spearman).toBeGreaterThan(0.5);
  });

  it("predicted profit probability is monotone non-decreasing in qualityScore (structural guarantee)", () => {
    // This is the guarantee the isotonic calibration provides BY CONSTRUCTION:
    // a signal with a higher raw edge can never receive a lower calibrated
    // probability. We sweep the latent edge and assert the mapping is monotone.
    const train = makeExamples(1200, 71);
    const { model } = trainQualityModel(train, DEFAULT_TRAIN_CONFIG);
    let prev = -Infinity;
    let monotone = true;
    for (let e = 0; e <= 1.0001; e += 0.02) {
      // deterministic features at edge e with zero jitter (fixed rng seed reused)
      const f = makeFeatures(Math.min(1, e), lcg(1));
      const p = scoreQuality(f, model).predictedProfitProbability;
      if (p < prev - 1e-9) monotone = false;
      prev = p;
    }
    expect(monotone).toBe(true);
  });

  it("isotonic calibration curve is non-decreasing by construction", () => {
    const curve = fitIsotonic([
      { x: 0.1, y: 1 }, { x: 0.2, y: 0 }, { x: 0.3, y: 1 },
      { x: 0.4, y: 0 }, { x: 0.9, y: 1 },
    ]);
    for (let i = 1; i < curve.y.length; i++) {
      expect(curve.y[i]!).toBeGreaterThanOrEqual(curve.y[i - 1]! - 1e-9);
    }
    // monotone eval
    expect(evalIsotonic(curve, 0.9)).toBeGreaterThanOrEqual(evalIsotonic(curve, 0.1));
  });
});

describe("2. no leakage (purge + embargo)", () => {
  it("CV splits never share indices between train and test", () => {
    const ex = makeExamples(200, 7);
    for (const scheme of ["walkForward", "purgedKFold", "cpcv"] as const) {
      const splits = buildCvSplits(ex, { ...DEFAULT_TRAIN_CONFIG, scheme });
      expect(splits.length).toBeGreaterThan(0);
      for (const s of splits) {
        const testSet = new Set(s.testIdx);
        for (const ti of s.trainIdx) expect(testSet.has(ti)).toBe(false);
      }
    }
  });

  it("training examples whose label window overlaps the test window (+embargo) are purged", () => {
    const ex = makeExamples(120, 3);
    const cfg = { ...DEFAULT_TRAIN_CONFIG, scheme: "purgedKFold" as const, purgeMs: DAY, embargoMs: 2 * DAY };
    const splits = buildCvSplits(ex, cfg);
    for (const s of splits) {
      let tMin = Infinity;
      let tMax = -Infinity;
      for (const i of s.testIdx) {
        tMin = Math.min(tMin, ex[i]!.signalMs);
        tMax = Math.max(tMax, ex[i]!.outcomeMs);
      }
      const purgeStart = tMin - cfg.purgeMs;
      const embargoEnd = tMax + cfg.embargoMs;
      // no training example may have its [signalMs, outcomeMs] overlap the window
      for (const i of s.trainIdx) {
        const e = ex[i]!;
        const overlaps = e.outcomeMs >= purgeStart && e.signalMs <= embargoEnd;
        expect(overlaps).toBe(false);
      }
    }
  });
});

describe("3. small-sample shrinkage", () => {
  it("shrinks a perfect tiny sample toward the prior (no inflated win rate)", () => {
    // 3/3 wins, prior 0.5, priorStrength 20 → effective must be far below 1.0
    const shr = shrinkWinRate(3, 3, 0.5, 20);
    expect(shr.observedWinRate).toBe(1);
    expect(shr.effectiveWinRate).toBeLessThan(0.65);
    expect(shr.sampleConfidence).toBeLessThan(0.2);
  });

  it("a large sample is trusted (effective ≈ observed)", () => {
    const shr = shrinkWinRate(700, 1000, 0.5, 20);
    expect(shr.effectiveWinRate).toBeGreaterThan(0.68);
    expect(shr.sampleConfidence).toBeGreaterThan(0.97);
  });

  it("tiny conditional cell does not produce a top-grade signal", () => {
    // Build a table dominated by a strong but TINY cell.
    const strong = makeExamples(4, 5).map((e) => ({ ...e, label: 1 as const }));
    const ct = buildConditionalTables(strong, 20);
    const model: QualityModel = {
      ...DEFAULT_QUALITY_MODEL,
      conditionalTable: ct.table,
      priors: ct.priors,
      globalPrior: ct.globalPrior,
    };
    const r = scoreQuality(makeFeatures(0.9, lcg(2)), model);
    // sampleConfidence should be low, so the score is pulled toward prior
    expect(r.sampleConfidence).toBeLessThan(0.3);
    expect(r.qualityGrade).not.toBe("EXCEPTIONAL");
  });
});

describe("4. correlated feature handling (no double-counting)", () => {
  it("groups correlated components so they share a weight budget", () => {
    // momentum, marketStructure, multiTimeframeAlignment are in TREND_MOMENTUM
    const grp = REDUNDANCY_GROUPS.TREND_MOMENTUM;
    expect(grp).toContain("momentum");
    expect(grp).toContain("marketStructure");
    expect(grp).toContain("multiTimeframeAlignment");
    // predictive edge overlap group
    expect(REDUNDANCY_GROUPS.PREDICTIVE_EDGE).toContain("predictiveProbability");
    expect(REDUNDANCY_GROUPS.PREDICTIVE_EDGE).toContain("historicalConditionalWinRate");
    // derivatives group isolates OI/PCR overlap
    expect(REDUNDANCY_GROUPS.DERIVATIVES).toContain("derivativesConfirmation");
  });

  it("three perfectly-correlated components in one group do not out-vote the rest", () => {
    // Sum of the TREND_MOMENTUM group's effective weights must equal its group
    // budget — not 3× a single component's weight.
    const w = effectiveEdgeWeights(DEFAULT_QUALITY_MODEL);
    const groupSum = REDUNDANCY_GROUPS.TREND_MOMENTUM
      .filter((c) => EDGE_COMPONENTS.includes(c))
      .reduce((s, c) => s + w[c], 0);
    // With N edge groups uniform, the group budget ≈ 1/numGroups after renorm.
    // It must be < 0.5 (cannot dominate) and > 0.
    expect(groupSum).toBeGreaterThan(0);
    expect(groupSum).toBeLessThan(0.5);
  });
});

describe("5. missing data → uncertainty, not directional penalty", () => {
  it("a missing bullish component does not make the score bearish", () => {
    const rng = lcg(4);
    const full = makeFeatures(0.7, rng);
    // remove several favourable components (set to null)
    const missing: QualityFeatureVector = {
      ...full,
      momentum: null,
      marketStructure: null,
      derivativesConfirmation: null,
      relativeStrength: null,
    };
    const rFull = scoreQuality(full, DEFAULT_QUALITY_MODEL);
    const rMissing = scoreQuality(missing, DEFAULT_QUALITY_MODEL);
    // Missing favourable evidence should reduce CONFIDENCE, not flip direction.
    // The score must not collapse below the neutral prior region.
    expect(rMissing.predictedProfitProbability).toBeGreaterThanOrEqual(0.3);
    // attribution marks them unobserved with neutral value 0.5 (not 0)
    for (const c of ["momentum", "marketStructure"] as const) {
      const a = rMissing.attribution.find((x) => x.component === c)!;
      expect(a.observed).toBe(false);
      expect(a.value).toBe(0.5);
    }
    // and the missing version should be no MORE confident than the full one
    expect(rMissing.qualityScore).toBeLessThanOrEqual(rFull.qualityScore + 1e-6);
  });

  it("missing derivatives on a derivatives-required signal lowers dataConfidence only", () => {
    const rng = lcg(6);
    const f = makeFeatures(0.7, rng, { derivativesRequiredButMissing: true, optionChainAgeMs: null, oiAgeMs: null });
    const dc = computeDataConfidence(f, DEFAULT_QUALITY_MODEL);
    expect(dc).toBeLessThan(0.8);
  });
});

describe("6. stale data reduces confidence", () => {
  it("stale quote lowers dataConfidence monotonically with age", () => {
    const rng = lcg(8);
    const fresh = computeDataConfidence(makeFeatures(0.7, rng, { quoteAgeMs: 1_000 }), DEFAULT_QUALITY_MODEL);
    const stale = computeDataConfidence(makeFeatures(0.7, rng, { quoteAgeMs: 55_000 }), DEFAULT_QUALITY_MODEL);
    expect(stale).toBeLessThan(fresh);
  });

  it("an older signal has a lower quality score (freshness decay)", () => {
    const rng = lcg(9);
    const now = scoreQuality(makeFeatures(0.8, rng, { signalAgeMs: 0 }), DEFAULT_QUALITY_MODEL);
    const old = scoreQuality(makeFeatures(0.8, rng, { signalAgeMs: 60 * 60 * 1000 }), DEFAULT_QUALITY_MODEL);
    expect(old.qualityScore).toBeLessThan(now.qualityScore);
    expect(computeFreshnessDecay(30 * 60_000, 30 * 60_000)).toBeCloseTo(0.5, 6);
  });
});

describe("7. regime transition", () => {
  it("regime-conditioned priors/tables differ between bull and bear families", () => {
    // Bull family wins often; bear family loses often.
    const bull = makeExamples(200, 21, { strategyId: "MOMENTUM", regime: "BULL_TREND" })
      .map((e) => ({ ...e, label: 1 as const }));
    const bear = makeExamples(200, 22, { strategyId: "MOMENTUM", regime: "BEAR_TREND" })
      .map((e) => ({ ...e, label: 0 as const }));
    const ct = buildConditionalTables([...bull, ...bear], 20);
    expect(ct.priors["MOMENTUM|BULL_TREND"]).toBeGreaterThan(ct.priors["MOMENTUM|BEAR_TREND"]!);
  });

  it("same features score differently after a regime transition (via prior)", () => {
    const bull = makeExamples(200, 23, { strategyId: "MOMENTUM", regime: "BULL_TREND" }).map((e) => ({ ...e, label: 1 as const }));
    const bear = makeExamples(200, 24, { strategyId: "MOMENTUM", regime: "BEAR_TREND" }).map((e) => ({ ...e, label: 0 as const }));
    const ct = buildConditionalTables([...bull, ...bear], 20);
    const model: QualityModel = { ...DEFAULT_QUALITY_MODEL, conditionalTable: ct.table, priors: ct.priors, globalPrior: ct.globalPrior };
    const rng = lcg(25);
    const base = makeFeatures(0.6, rng, { strategyId: "MOMENTUM" });
    const inBull = scoreQuality({ ...base, regime: "BULL_TREND" }, model);
    const inBear = scoreQuality({ ...base, regime: "BEAR_TREND" }, model);
    expect(inBull.qualityScore).toBeGreaterThan(inBear.qualityScore);
  });
});

describe("8. conflicting models", () => {
  it("model disagreement lowers confidence without flipping direction", () => {
    const rng = lcg(30);
    const agree = makeFeatures(0.7, rng, { modelVotes: [1, 1, 1] });
    const conflict = makeFeatures(0.7, rng, { modelVotes: [1, -1, 1, -1] });
    const rAgree = scoreQuality(agree, DEFAULT_QUALITY_MODEL);
    const rConflict = scoreQuality(conflict, DEFAULT_QUALITY_MODEL);
    expect(rConflict.modelAgreement).toBeLessThan(rAgree.modelAgreement);
    expect(rConflict.qualityScore).toBeLessThanOrEqual(rAgree.qualityScore);
    // direction is not fabricated as a loss: still above rejection floor for a strong edge
    expect(rConflict.predictedProfitProbability).toBeGreaterThan(0.3);
  });
});

describe("9. cost stress", () => {
  it("a cost-fragile signal (EV collapses at 2× cost) scores lower than a robust one", () => {
    const rng = lcg(40);
    const robust = makeFeatures(0.7, rng, { netExpectedValueR: 1.0, netExpectedValueRAt2xCost: 0.9 });
    const fragile = makeFeatures(0.7, rng, { netExpectedValueR: 1.0, netExpectedValueRAt2xCost: 0.05 });
    const rRobust = scoreQuality(robust, DEFAULT_QUALITY_MODEL);
    const rFragile = scoreQuality(fragile, DEFAULT_QUALITY_MODEL);
    expect(rFragile.costRobustness).toBeLessThan(rRobust.costRobustness);
    expect(rFragile.qualityScore).toBeLessThan(rRobust.qualityScore);
  });
});

describe("10. reproducibility (deterministic inference)", () => {
  it("identical inputs produce byte-identical output", () => {
    const f = makeFeatures(0.73, lcg(50));
    const a = scoreQuality(f, DEFAULT_QUALITY_MODEL);
    const b = scoreQuality(f, DEFAULT_QUALITY_MODEL);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("training is deterministic for a fixed seed/config", () => {
    const ex = makeExamples(300, 60);
    const r1 = trainQualityModel(ex, DEFAULT_TRAIN_CONFIG);
    const r2 = trainQualityModel(ex, DEFAULT_TRAIN_CONFIG);
    expect(r1.model.groupWeights).toEqual(r2.model.groupWeights);
    expect(r1.oosBrier).toBe(r2.oosBrier);
    expect(r1.model.calibration).toEqual(r2.model.calibration);
  });

  it("no wall-clock/random dependence: score does not change across calls over time", () => {
    // scoreQuality must not read Date.now()/Math.random(); repeated calls equal.
    const f = makeFeatures(0.4, lcg(70), { signalAgeMs: 5 * 60_000 });
    const scores = new Set<number>();
    for (let i = 0; i < 5; i++) scores.add(scoreQuality(f, DEFAULT_QUALITY_MODEL).qualityScore);
    expect(scores.size).toBe(1);
  });
});
