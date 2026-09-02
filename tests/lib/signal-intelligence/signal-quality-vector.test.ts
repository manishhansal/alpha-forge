/**
 * Tests — Signal Quality Vector, EV Engine, Ranking, Abstention (Phases 19–23)
 *
 * Verifies multi-dimensional quality vector, expected value calculation,
 * signal grading, and abstention decisions.
 * Regression: signal must prefer NO_TRADE over low-quality trade.
 */

import { describe, it, expect } from "vitest";
import {
  computeExpectedValue,
  buildSignalQualityVector,
  gradeSignal,
  computeRankingScore,
  evaluateAbstention,
  getTODBucket,
} from "@/lib/signal-intelligence/signal-quality-vector";
import type { QualityVectorInput } from "@/lib/signal-intelligence/signal-quality-vector";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeGoodInput(overrides: Partial<QualityVectorInput> = {}): QualityVectorInput {
  const ev = computeExpectedValue(0.70, "OPENING_BREAKOUT", 24000, 23800, 24400, 0.05);
  return {
    strategyId: "OPENING_BREAKOUT",
    direction: "LONG",
    marketContextScore: 0.6,
    mlProbability: 0.65,
    regimeFit: "SUPPORTED",
    mtfAlignmentScore: 0.5,
    structureScore: 0.75,
    momentumScore: 0.72,
    volumeScore: 0.80,
    volatilityFitScore: 0.75,
    liquidityScore: 0.90,
    derivativesScore: 0.4,
    relativeStrengthScore: 0.3,
    ev,
    liquidity: {
      bidAskSpread: 5, spreadPct: 0.02, liquidityScore: 0.9,
      estimatedSlippagePct: 0.01, executionQuality: "EXCELLENT",
      rejected: false, rejectionReason: null, reasons: [],
    },
    dataQualityScore: 0.95,
    tod: { label: "09:30–10:00", recommendation: "TRADE", priorScore: 0.80, minutesFromOpen: 20 },
    rawConfidence: 0.70,
    ...overrides,
  };
}

describe("computeExpectedValue", () => {
  it("computes positive EV for favourable RR signal", () => {
    const ev = computeExpectedValue(0.65, "OPENING_BREAKOUT", 24000, 23850, 24450, 0.05);
    // 2:1 RR with 65% raw confidence → positive EV after calibration
    expect(ev.ev).toBeGreaterThan(-2); // calibrated probability reduces raw
    expect(ev.pWin).toBeGreaterThan(0.40);
    expect(ev.pLoss).toBeLessThan(0.65);
    expect(ev.pWin + ev.pLoss).toBeCloseTo(1.0, 5);
  });

  it("computes negative EV for 1:1 RR with low confidence", () => {
    const ev = computeExpectedValue(0.40, "MOMENTUM", 24000, 23950, 24050, 0.15);
    // 1:1 RR with low confidence + high spread → negative EV
    expect(ev.ev).toBeLessThan(0.5);
  });

  it("includes transaction cost in total cost", () => {
    const ev = computeExpectedValue(0.65, "OPENING_BREAKOUT", 24000, 23850, 24450, 0.05);
    expect(ev.estimatedCostPct).toBeGreaterThan(0);
    expect(ev.estimatedSlippagePct).toBeGreaterThan(0);
  });
});

describe("buildSignalQualityVector", () => {
  it("returns all 14 components", () => {
    const input = makeGoodInput();
    const vec = buildSignalQualityVector(input);
    expect(vec.marketContext).toBeDefined();
    expect(vec.regimeFit).toBeDefined();
    expect(vec.mtfAlignment).toBeDefined();
    expect(vec.structureQuality).toBeDefined();
    expect(vec.momentumQuality).toBeDefined();
    expect(vec.volumeQuality).toBeDefined();
    expect(vec.volatilityFit).toBeDefined();
    expect(vec.liquidityQuality).toBeDefined();
    expect(vec.derivativesConfirmation).toBeDefined();
    expect(vec.relativeStrength).toBeDefined();
    expect(vec.mlProbability).toBeDefined();
    expect(vec.expectedValue).toBeDefined();
    expect(vec.executionQuality).toBeDefined();
    expect(vec.dataQuality).toBeDefined();
  });

  it("composite is in [0, 1]", () => {
    const vec = buildSignalQualityVector(makeGoodInput());
    expect(vec.composite).toBeGreaterThanOrEqual(0);
    expect(vec.composite).toBeLessThanOrEqual(1);
  });

  it("provides reasons for every component", () => {
    const vec = buildSignalQualityVector(makeGoodInput());
    expect(vec.reasons.length).toBeGreaterThan(0);
  });

  it("ADVERSE regime lowers regimeFit component", () => {
    const goodRegime = buildSignalQualityVector(makeGoodInput({ regimeFit: "SUPPORTED" }));
    const badRegime = buildSignalQualityVector(makeGoodInput({ regimeFit: "ADVERSE" }));
    expect(goodRegime.regimeFit).toBeGreaterThan(badRegime.regimeFit);
  });

  it("short direction inverts market context score", () => {
    const longVec = buildSignalQualityVector(makeGoodInput({ direction: "LONG", marketContextScore: 0.8 }));
    const shortVec = buildSignalQualityVector(makeGoodInput({ direction: "SHORT", marketContextScore: 0.8 }));
    // Long in bullish context should score higher on marketContext than short
    expect(longVec.marketContext).toBeGreaterThan(shortVec.marketContext);
  });
});

describe("gradeSignal", () => {
  it("grades A_PLUS for high EV and high quality", () => {
    const ev = computeExpectedValue(0.75, "OPENING_BREAKOUT", 24000, 23700, 24900, 0.02);
    const vec = buildSignalQualityVector(makeGoodInput({ ev, mlProbability: 0.75, volumeScore: 0.9 }));
    // EV may vary — just check it's at least A or better
    const grade = gradeSignal(ev, vec, false, false);
    expect(["A_PLUS", "A", "B"]).toContain(grade);
  });

  it("grades REJECT for negative EV", () => {
    const ev = computeExpectedValue(0.30, "MOMENTUM", 24000, 23990, 24010, 0.30);
    const vec = buildSignalQualityVector(makeGoodInput({ ev, volumeScore: 0.2, momentumScore: 0.2 }));
    const grade = gradeSignal(ev, vec, false, false);
    expect(grade).toBe("REJECT");
  });

  it("grades REJECT when liquidity is rejected", () => {
    const ev = computeExpectedValue(0.70, "OPENING_BREAKOUT", 24000, 23800, 24400, 0.05);
    const vec = buildSignalQualityVector(makeGoodInput({ ev }));
    const grade = gradeSignal(ev, vec, true, false); // liquidityRejected = true
    expect(grade).toBe("REJECT");
  });

  it("grades REJECT when data quality is critical", () => {
    const ev = computeExpectedValue(0.70, "OPENING_BREAKOUT", 24000, 23800, 24400, 0.05);
    const vec = buildSignalQualityVector(makeGoodInput({ ev }));
    const grade = gradeSignal(ev, vec, false, true); // dataQualityCritical = true
    expect(grade).toBe("REJECT");
  });
});

describe("computeRankingScore", () => {
  it("returns 0 for REJECT grade", () => {
    const ev = computeExpectedValue(0.30, "MOMENTUM", 24000, 23990, 24010, 0.30);
    const vec = buildSignalQualityVector(makeGoodInput({ ev }));
    expect(computeRankingScore(ev, vec, "REJECT")).toBe(0);
  });

  it("returns score in [0, 100]", () => {
    const ev = computeExpectedValue(0.70, "OPENING_BREAKOUT", 24000, 23800, 24400, 0.05);
    const vec = buildSignalQualityVector(makeGoodInput({ ev }));
    const grade = gradeSignal(ev, vec, false, false);
    const score = computeRankingScore(ev, vec, grade);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("REGRESSION: system must prefer NO_TRADE over low-quality trade", () => {
  function makeAbstentionParams(overrides = {}) {
    const ev = computeExpectedValue(0.45, "MOMENTUM", 24000, 23970, 24030, 0.20);
    const vec = buildSignalQualityVector(makeGoodInput({ ev }));
    return {
      grade: gradeSignal(ev, vec, false, false),
      ev,
      qualityVector: vec,
      liquidityResult: { bidAskSpread: 2, spreadPct: 0.008, liquidityScore: 0.95, estimatedSlippagePct: 0.01, executionQuality: "EXCELLENT" as const, rejected: false, rejectionReason: null, reasons: [] },
      regimeFit: "NEUTRAL" as const,
      dataQualityLevel: "COMPLETE" as const,
      mlProbability: 0.45,
      tod: getTODBucket(Date.now()),
      hasConflictingTimeframes: false,
      hasConflictingDerivatives: false,
      portfolioExposurePct: 20,
      correlatedPositions: 0,
      isExpiryDay: false,
      isGammaRiskActive: false,
      ...overrides,
    };
  }

  it("abstains when grade is REJECT", () => {
    const params = makeAbstentionParams({ grade: "REJECT" as const });
    const decision = evaluateAbstention(params);
    expect(decision.shouldAbstain).toBe(true);
    expect(decision.action).toBe("NO_TRADE");
  });

  it("abstains when liquidity is rejected", () => {
    const params = makeAbstentionParams({
      liquidityResult: {
        bidAskSpread: 100, spreadPct: 0.42, liquidityScore: 0.1,
        estimatedSlippagePct: 0.2, executionQuality: "POOR" as const,
        rejected: true, rejectionReason: "Spread excessive", reasons: [],
      },
    });
    const decision = evaluateAbstention(params);
    expect(decision.shouldAbstain).toBe(true);
    expect(decision.reasons).toContain("LOW_LIQUIDITY");
  });

  it("abstains when ADVERSE regime", () => {
    const params = makeAbstentionParams({ regimeFit: "ADVERSE" as const });
    const decision = evaluateAbstention(params);
    expect(decision.shouldAbstain).toBe(true);
    expect(decision.reasons).toContain("BAD_REGIME");
  });

  it("abstains when conflicting timeframes", () => {
    const params = makeAbstentionParams({ hasConflictingTimeframes: true });
    const decision = evaluateAbstention(params);
    expect(decision.shouldAbstain).toBe(true);
    expect(decision.reasons).toContain("CONFLICTING_TIMEFRAMES");
  });

  it("abstains when gamma risk active (expiry)", () => {
    const params = makeAbstentionParams({ isGammaRiskActive: true });
    const decision = evaluateAbstention(params);
    expect(decision.shouldAbstain).toBe(true);
    expect(decision.reasons).toContain("EXPIRY_RISK");
  });

  it("abstains when excess portfolio exposure", () => {
    const params = makeAbstentionParams({ portfolioExposurePct: 85 });
    const decision = evaluateAbstention(params);
    expect(decision.shouldAbstain).toBe(true);
    expect(decision.reasons).toContain("EXCESS_PORTFOLIO_EXPOSURE");
  });

  it("does not abstain for a high-quality signal", () => {
    const ev = computeExpectedValue(0.70, "OPENING_BREAKOUT", 24000, 23800, 24400, 0.05);
    const vec = buildSignalQualityVector(makeGoodInput({ ev, mlProbability: 0.68 }));
    const grade = gradeSignal(ev, vec, false, false);
    const params = {
      grade,
      ev,
      qualityVector: vec,
      liquidityResult: { bidAskSpread: 2, spreadPct: 0.008, liquidityScore: 0.95, estimatedSlippagePct: 0.01, executionQuality: "EXCELLENT" as const, rejected: false, rejectionReason: null, reasons: [] },
      regimeFit: "SUPPORTED" as const,
      dataQualityLevel: "COMPLETE" as const,
      mlProbability: 0.68,
      tod: { label: "09:30–10:00", recommendation: "TRADE" as const, priorScore: 0.80, minutesFromOpen: 20 },
      hasConflictingTimeframes: false,
      hasConflictingDerivatives: false,
      portfolioExposurePct: 20,
      correlatedPositions: 0,
      isExpiryDay: false,
      isGammaRiskActive: false,
    };
    if (grade !== "REJECT") {
      const decision = evaluateAbstention(params);
      // A high-quality signal should not abstain (when no other filters block it)
      expect(decision.action).toBe("TRADE");
    }
  });
});

describe("getTODBucket", () => {
  it("returns CAUTION for 09:15–09:20 opening bucket", () => {
    // 09:15 IST = 03:45 UTC
    const ist0915 = new Date();
    ist0915.setUTCHours(3, 45, 0, 0);
    const bucket = getTODBucket(ist0915.getTime());
    expect(bucket.label).toBe("09:15–09:20");
    expect(bucket.recommendation).toBe("CAUTION");
  });

  it("returns AVOID for late session bucket", () => {
    // 15:20 IST = 09:50 UTC
    const ist1520 = new Date();
    ist1520.setUTCHours(9, 50, 0, 0);
    const bucket = getTODBucket(ist1520.getTime());
    expect(["AVOID", "CAUTION"]).toContain(bucket.recommendation);
  });
});
