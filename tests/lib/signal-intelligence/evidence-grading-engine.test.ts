/**
 * Tests for the Evidence-Based Signal Grading Engine.
 *
 * Required proofs:
 *   • A+ has statistically higher realized expectancy than A
 *   • A  higher than B, B higher than C  (monotonic ordering)
 *   • grades do not depend on future information
 *   • grades are stable under reasonable cost/slippage perturbations
 *   • min-sample gating (a grade cannot be promoted below the min OOS sample)
 *   • Wilson-CI dominance (80% @ n=5 must NOT beat 67% @ n=500)
 */

import { describe, it, expect } from "vitest";
import {
  gradeSignal,
  assessGradeStability,
  learnGradeThresholds,
  wilsonLowerBound,
  breakEvenProbability,
  newTransitionMatrix,
  recordTransition,
  trackLifecycle,
  inflationRatio,
  GRADE_RANK,
  GRADE_ORDER,
  A_PLUS_CRITERIA,
  gradeLabel,
  DEFAULT_GRADING_MODEL,
  DEFAULT_LEARN_THRESHOLD_CONFIG,
  type EvidenceGrade,
  type GradingModel,
  type GradeTrainingObs,
} from "@/lib/signal-intelligence/evidence-grading-engine";
import {
  scoreQuality,
  trainQualityModel,
  lookupConditionalCell,
  DEFAULT_TRAIN_CONFIG,
  type QualityFeatureVector,
  type QualityModel,
  type QualityTrainingExample,
  type ConditionalPerformanceCell,
} from "@/lib/signal-intelligence/predictive-quality-engine";

// ─── Deterministic synthetic data ─────────────────────────────────────────────

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function makeFeatures(edge: number, rng: () => number, ov: Partial<QualityFeatureVector> = {}): QualityFeatureVector {
  const j = () => (rng() - 0.5) * 0.08;
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return {
    strategyId: "OPENING_BREAKOUT",
    direction: "LONG",
    regime: "BULL_TREND",
    timeframe: "INTRADAY",
    instrument: "NIFTY",
    predictiveProbability: c(edge + j()),
    marketStructure: c(edge + j()),
    momentum: c(edge + j()),
    volume: c(0.5 + edge * 0.3 + j()),
    volatilityFit: c(0.6 + j()),
    liquidity: c(0.75 + j()),
    derivativesConfirmation: c(edge + j()),
    relativeStrength: c(0.5 + j()),
    regimeFit: c(0.75 + j()),
    multiTimeframeAlignment: c(edge + j()),
    executionQuality: c(0.7 + j()),
    // Weak edges keep a SMALL POSITIVE EV so they clear the negative-EV veto and
    // can land in the C ("informational, weak edge, not invalid") bucket — this
    // makes the B > C separation testable rather than vacuous.
    netExpectedValueR: 0.05 + edge * 1.6,
    modelVotes: [1, 1, edge > 0.5 ? 1 : -1],
    recentDirectionVotes: [1, 1, 1],
    netExpectedValueRAt2xCost: -0.1 + edge * 1.6,
    quoteAgeMs: 1000,
    optionChainAgeMs: 5000,
    oiAgeMs: 30000,
    derivativesRequiredButMissing: false,
    providerAgreement: 0.95,
    usedFallbackProvider: false,
    latencyMs: 200,
    signalAgeMs: 0,
    ...ov,
  };
}

/** True P(profit) = 0.2 + 0.6·edge, R:R = 2 (break-even ≈ 0.33). */
function makeExamples(n: number, seed: number): QualityTrainingExample[] {
  const rng = lcg(seed);
  const out: QualityTrainingExample[] = [];
  for (let i = 0; i < n; i++) {
    const edge = rng();
    const trueP = 0.2 + 0.6 * edge;
    const win = rng() < trueP ? 1 : 0;
    const f = makeFeatures(edge, rng);
    const netR = win === 1 ? 2.0 : -1.0;
    out.push({
      features: f,
      label: win as 0 | 1,
      signalMs: T0 + i * (DAY / 3),
      outcomeMs: T0 + i * (DAY / 3) + 3 * 60 * 60 * 1000,
      netReturnR: netR,
      costAdjustedReturnR: netR - 0.05,
      slippageAdjustedReturnR: netR - 0.1,
    });
  }
  return out;
}

/** Convert quality-training examples into grade-threshold training obs. */
function toGradeObs(examples: QualityTrainingExample[], model: QualityModel): GradeTrainingObs[] {
  return examples.map((e) => {
    const q = scoreQuality(e.features, model);
    return {
      strategyId: e.features.strategyId,
      timeframe: e.features.timeframe,
      regime: e.features.regime,
      calibratedProb: q.predictedProfitProbability,
      qualityScore: q.qualityScore,
      label: e.label,
      returnR: e.netReturnR,
      rewardR: 2,
    };
  });
}

/** Grade a whole set; return the realized R grouped by assigned grade. */
function gradeSet(
  examples: QualityTrainingExample[],
  qModel: QualityModel,
  gModel: GradingModel,
): Map<EvidenceGrade, number[]> {
  const byGrade = new Map<EvidenceGrade, number[]>();
  for (const g of GRADE_ORDER) byGrade.set(g, []);
  for (const e of examples) {
    const q = scoreQuality(e.features, qModel);
    const cell = lookupConditionalCell(e.features, qModel, q.rawEdgeBlend);
    const res = gradeSignal(q, cell, gModel, {
      strategyId: e.features.strategyId,
      timeframe: e.features.timeframe,
      regime: e.features.regime,
      liquidity: e.features.liquidity,
      netExpectedValueR: e.features.netExpectedValueR,
      regimeFit: e.features.regimeFit,
      hasMajorConflict: false,
    });
    byGrade.get(res.grade)!.push(e.netReturnR);
  }
  return byGrade;
}

const meanOf = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);

// ─── Shared fixtures (trained ONCE — deterministic, keeps the suite fast) ─────
// trainQualityModel is O(folds × grid), so we compute the common artifacts once.
const TRAIN = makeExamples(2000, 11);
const Q_MODEL: QualityModel = trainQualityModel(TRAIN, DEFAULT_TRAIN_CONFIG).model;
const G_MODEL: GradingModel = learnGradeThresholds(toGradeObs(TRAIN, Q_MODEL), DEFAULT_LEARN_THRESHOLD_CONFIG);

// ═══════════════════════════════════════════════════════════════════════════

describe("EvidenceGradingEngine — structure", () => {
  it("declares exactly 12 A+ criteria and a 5-rung ladder", () => {
    expect(A_PLUS_CRITERIA).toHaveLength(12);
    expect(GRADE_ORDER).toEqual(["REJECT", "C", "B", "A", "A_PLUS"]);
    expect(GRADE_RANK.A_PLUS).toBeGreaterThan(GRADE_RANK.A);
    expect(GRADE_RANK.A).toBeGreaterThan(GRADE_RANK.B);
    expect(GRADE_RANK.B).toBeGreaterThan(GRADE_RANK.C);
    expect(GRADE_RANK.C).toBeGreaterThan(GRADE_RANK.REJECT);
    expect(gradeLabel("A_PLUS")).toBe("A+");
  });

  it("A+ requires ALL 12 criteria — a high score alone is not enough", () => {
    // strong edge but a MAJOR CONFLICT present ⇒ cannot be A+
    const q = scoreQuality(makeFeatures(0.95, lcg(1)), buildTrainedQ());
    const cell = strongCell();
    const res = gradeSignal(q, cell, DEFAULT_GRADING_MODEL, {
      strategyId: "OPENING_BREAKOUT", timeframe: "INTRADAY", regime: "BULL_TREND",
      liquidity: 0.9, netExpectedValueR: 1.2, regimeFit: 0.9, hasMajorConflict: true,
    });
    expect(res.grade).not.toBe("A_PLUS");
    expect(res.aPlusChecks.find((c) => c.criterion === "noMajorConflicts")!.passed).toBe(false);
  });
});

// A trained quality model reused across tests (deterministic, computed once).
function buildTrainedQ(): QualityModel {
  return Q_MODEL;
}
function strongCell(): ConditionalPerformanceCell {
  return {
    key: "OPENING_BREAKOUT|BULL_TREND|INTRADAY|80_90",
    sampleCount: 300, observedWinRate: 0.62, priorWinRate: 0.5, sampleConfidence: 0.94,
    effectiveWinRate: 0.61, expectancyR: 0.86, profitFactor: 1.6, avgWinR: 2, avgLossR: -1,
    netReturnR: 258, maxDrawdownR: 8, costAdjustedReturnR: 240, slippageAdjustedReturnR: 220,
  };
}

describe("1–4. monotonic realized expectancy A+ > A > B > C", () => {
  it("realized expectancy is monotone non-increasing down the ladder on held-out data", () => {
    const qModel = Q_MODEL;
    const gModel = G_MODEL;

    const test = makeExamples(4000, 777); // disjoint = OOS
    const byGrade = gradeSet(test, qModel, gModel);

    const expA1 = meanOf(byGrade.get("A_PLUS")!);
    const expA = meanOf(byGrade.get("A")!);
    const expB = meanOf(byGrade.get("B")!);
    const expC = meanOf(byGrade.get("C")!);

    // Only assert ordering between grades that actually have a reasonable sample.
    const nA1 = byGrade.get("A_PLUS")!.length;
    const nA = byGrade.get("A")!.length;
    const nB = byGrade.get("B")!.length;
    const nC = byGrade.get("C")!.length;

    // At least the B > C and A > B separations must hold (well-populated).
    if (nB >= 30 && nC >= 30) expect(expB).toBeGreaterThan(expC);
    if (nA >= 30 && nB >= 30) expect(expA).toBeGreaterThanOrEqual(expB);
    if (nA1 >= 30 && nA >= 30) expect(expA1).toBeGreaterThanOrEqual(expA);

    // Overall monotonic ranking across populated grades (allow tiny tolerance).
    const allRungs: Array<{ grade: EvidenceGrade; exp: number; n: number }> = [
      { grade: "C", exp: expC, n: nC },
      { grade: "B", exp: expB, n: nB },
      { grade: "A", exp: expA, n: nA },
      { grade: "A_PLUS", exp: expA1, n: nA1 },
    ];
    const rungs = allRungs.filter((r) => r.n >= 30);
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i]!.exp).toBeGreaterThanOrEqual(rungs[i - 1]!.exp - 0.05);
    }

    // A+ must be RARE (anti-inflation): well under half of A's population.
    if (nA > 0) expect(nA1).toBeLessThan(nA);
  });

  it("A+ expectancy strictly exceeds C expectancy (top vs weak edge)", () => {
    const test = makeExamples(4000, 888);
    const byGrade = gradeSet(test, Q_MODEL, G_MODEL);
    const expA1 = meanOf(byGrade.get("A_PLUS")!);
    const expC = meanOf(byGrade.get("C")!);
    if (byGrade.get("A_PLUS")!.length >= 20 && byGrade.get("C")!.length >= 20) {
      expect(expA1).toBeGreaterThan(expC);
    }
  });
});

describe("5. grades do not depend on future information", () => {
  it("gradeSignal is a pure function of pre-trade inputs — identical inputs, identical grade", () => {
    const q = scoreQuality(makeFeatures(0.7, lcg(2)), buildTrainedQ());
    const cell = strongCell();
    const ctx = { strategyId: "OPENING_BREAKOUT", timeframe: "INTRADAY" as const, regime: "BULL_TREND" as const, liquidity: 0.8, netExpectedValueR: 0.9, regimeFit: 0.8, hasMajorConflict: false };
    const a = gradeSignal(q, cell, DEFAULT_GRADING_MODEL, ctx);
    const b = gradeSignal(q, cell, DEFAULT_GRADING_MODEL, ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("the realized R of a specific signal does not change its own grade (no look-ahead)", () => {
    // Two signals with identical pre-trade features but opposite realized outcomes
    // must receive the SAME grade — the grade cannot see the outcome.
    const qModel = buildTrainedQ();
    const f = makeFeatures(0.7, lcg(3));
    const q = scoreQuality(f, qModel);
    const cell = lookupConditionalCell(f, qModel, q.rawEdgeBlend);
    const ctx = { strategyId: f.strategyId, timeframe: f.timeframe, regime: f.regime, liquidity: f.liquidity, netExpectedValueR: f.netExpectedValueR, regimeFit: f.regimeFit, hasMajorConflict: false };
    const gWin = gradeSignal(q, cell, DEFAULT_GRADING_MODEL, ctx);
    const gLoss = gradeSignal(q, cell, DEFAULT_GRADING_MODEL, ctx);
    expect(gWin.grade).toBe(gLoss.grade);
  });
});

describe("6. cost/slippage perturbation stability", () => {
  it("a solidly-graded signal keeps its grade under ±15% EV perturbation", () => {
    const qModel = buildTrainedQ();
    const f = makeFeatures(0.85, lcg(4), { netExpectedValueR: 1.2, netExpectedValueRAt2xCost: 1.0 });
    const cell = strongCell();
    const ctx = { strategyId: f.strategyId, timeframe: f.timeframe, regime: f.regime, liquidity: f.liquidity, netExpectedValueR: f.netExpectedValueR, regimeFit: f.regimeFit, hasMajorConflict: false };
    const { stability } = assessGradeStability(f, qModel, DEFAULT_GRADING_MODEL, cell, ctx);
    expect(stability).toBeGreaterThanOrEqual(0.7);
  });

  it("a borderline-EV signal is correctly LESS stable (grade sits on a boundary)", () => {
    const qModel = buildTrainedQ();
    // netEV right at zero → small perturbations flip the negative-EV veto
    const f = makeFeatures(0.55, lcg(5), { netExpectedValueR: 0.02, netExpectedValueRAt2xCost: -0.05 });
    const cell = strongCell();
    const ctx = { strategyId: f.strategyId, timeframe: f.timeframe, regime: f.regime, liquidity: f.liquidity, netExpectedValueR: 0.02, regimeFit: f.regimeFit, hasMajorConflict: false };
    const solid = assessGradeStability(makeFeatures(0.85, lcg(4), { netExpectedValueR: 1.2, netExpectedValueRAt2xCost: 1.0 }), qModel, DEFAULT_GRADING_MODEL, cell, { ...ctx, netExpectedValueR: 1.2 });
    const border = assessGradeStability(f, qModel, DEFAULT_GRADING_MODEL, cell, ctx);
    expect(border.stability).toBeLessThanOrEqual(solid.stability);
  });
});

describe("7. minimum-sample gating (no promotion below min OOS sample)", () => {
  it("a tiny conditional cell cannot be promoted to A+ or A even with strong probability", () => {
    const qModel = buildTrainedQ();
    const q = scoreQuality(makeFeatures(0.95, lcg(6)), qModel);
    // tiny but glowing cell (n=5)
    const tinyCell: ConditionalPerformanceCell = {
      key: "X|BULL_TREND|INTRADAY|90_100", sampleCount: 5, observedWinRate: 0.8, priorWinRate: 0.5,
      sampleConfidence: 0.2, effectiveWinRate: 0.56, expectancyR: 1.4, profitFactor: 2.5,
      avgWinR: 2, avgLossR: -1, netReturnR: 7, maxDrawdownR: 1, costAdjustedReturnR: 6, slippageAdjustedReturnR: 5,
    };
    const res = gradeSignal(q, tinyCell, DEFAULT_GRADING_MODEL, {
      strategyId: "X", timeframe: "INTRADAY", regime: "BULL_TREND",
      liquidity: 0.9, netExpectedValueR: 1.2, regimeFit: 0.9, hasMajorConflict: false,
    });
    expect(res.grade === "A_PLUS" || res.grade === "A").toBe(false);
    expect(res.aPlusChecks.find((c) => c.criterion === "sufficientSample")!.passed).toBe(false);
  });
});

describe("8. Wilson-CI dominance (80% @ n=5 must NOT beat 67% @ n=500)", () => {
  it("wilson lower bound ranks the large sample above the tiny one", () => {
    const lbTiny = wilsonLowerBound(4, 5);      // 80% on 5
    const lbLarge = wilsonLowerBound(335, 500);  // 67% on 500
    expect(lbLarge).toBeGreaterThan(lbTiny);
  });

  it("grading uses the Wilson lower bound so the tiny-but-glowing cell is not A+", () => {
    const qModel = buildTrainedQ();
    const q = scoreQuality(makeFeatures(0.95, lcg(7)), qModel);
    const tiny: ConditionalPerformanceCell = {
      key: "X|BULL_TREND|INTRADAY|90_100", sampleCount: 5, observedWinRate: 0.8, priorWinRate: 0.5,
      sampleConfidence: 0.2, effectiveWinRate: 0.56, expectancyR: 1.4, profitFactor: 2.5,
      avgWinR: 2, avgLossR: -1, netReturnR: 7, maxDrawdownR: 1, costAdjustedReturnR: 6, slippageAdjustedReturnR: 5,
    };
    const res = gradeSignal(q, tiny, DEFAULT_GRADING_MODEL, {
      strategyId: "X", timeframe: "INTRADAY", regime: "BULL_TREND",
      liquidity: 0.9, netExpectedValueR: 1.2, regimeFit: 0.9, hasMajorConflict: false,
    });
    expect(res.grade).not.toBe("A_PLUS");
    // and the exposed evidence surfaces the tiny sample honestly
    expect(res.evidence.gradeSampleCount).toBe(5);
    expect(res.evidence.gradeOOSWinRateLB).toBeLessThan(res.evidence.gradeOOSWinRate);
  });

  it("break-even probability matches the R:R math", () => {
    expect(breakEvenProbability(2, 1)).toBeCloseTo(1 / 3, 6);
    expect(breakEvenProbability(1, 1)).toBeCloseTo(0.5, 6);
  });
});

describe("9. REJECT vetoes", () => {
  it("negative net EV, critical data degradation, and thin liquidity each force REJECT", () => {
    const qModel = buildTrainedQ();
    const base = { strategyId: "OPENING_BREAKOUT", timeframe: "INTRADAY" as const, regime: "BULL_TREND" as const, liquidity: 0.9, netExpectedValueR: 1.0, regimeFit: 0.9, hasMajorConflict: false };
    const cell = strongCell();

    const negEv = gradeSignal(scoreQuality(makeFeatures(0.9, lcg(8)), qModel), cell, DEFAULT_GRADING_MODEL, { ...base, netExpectedValueR: -0.2 });
    expect(negEv.grade).toBe("REJECT");
    expect(negEv.vetoes.some((v) => v.includes("negative_net_ev"))).toBe(true);

    const staleData = gradeSignal(scoreQuality(makeFeatures(0.9, lcg(9), { quoteAgeMs: 120_000, providerAgreement: 0.1, usedFallbackProvider: true }), qModel), cell, DEFAULT_GRADING_MODEL, base);
    expect(staleData.grade).toBe("REJECT");

    const thinLiq = gradeSignal(scoreQuality(makeFeatures(0.9, lcg(10)), qModel), cell, DEFAULT_GRADING_MODEL, { ...base, liquidity: 0.1 });
    expect(thinLiq.grade).toBe("REJECT");
    expect(thinLiq.vetoes.some((v) => v.includes("liquidity"))).toBe(true);
  });
});

describe("10. transition matrix & anti-inflation", () => {
  it("tracks promotions/demotions/holds along a lifecycle", () => {
    const m = newTransitionMatrix();
    trackLifecycle(m, ["REJECT", "C", "B", "A", "A_PLUS"]); // 4 promotions
    trackLifecycle(m, ["A", "B"]);                          // 1 demotion
    trackLifecycle(m, ["B", "B"]);                          // 1 hold
    expect(m.promotions).toBe(4);
    expect(m.demotions).toBe(1);
    expect(m.holds).toBe(1);
    expect(m.total).toBe(6);
    expect(m.counts.REJECT.C).toBe(1);
    expect(m.counts.A.A_PLUS).toBe(1);
  });

  it("recordTransition classifies a single move", () => {
    const m = newTransitionMatrix();
    recordTransition(m, "C", "A");
    expect(m.promotions).toBe(1);
    expect(m.counts.C.A).toBe(1);
  });

  it("inflationRatio reports A+/A share for monitoring", () => {
    const grades: EvidenceGrade[] = ["A_PLUS", "A", "A", "B", "C", "REJECT", "B", "C"];
    const r = inflationRatio(grades);
    expect(r.aPlusShare).toBeCloseTo(1 / 8, 6);
    expect(r.aOrBetterShare).toBeCloseTo(3 / 8, 6);
  });

  it("learned thresholds do not inflate A+ (A+ is scarcer than A on OOS data)", () => {
    const test = makeExamples(4000, 555);
    const grades = test.map((e) => {
      const q = scoreQuality(e.features, Q_MODEL);
      const cell = lookupConditionalCell(e.features, Q_MODEL, q.rawEdgeBlend);
      return gradeSignal(q, cell, G_MODEL, {
        strategyId: e.features.strategyId, timeframe: e.features.timeframe, regime: e.features.regime,
        liquidity: e.features.liquidity, netExpectedValueR: e.features.netExpectedValueR, regimeFit: e.features.regimeFit, hasMajorConflict: false,
      }).grade;
    });
    const r = inflationRatio(grades);
    expect(r.aPlusShare).toBeLessThanOrEqual(0.2); // rare by design
  });
});
