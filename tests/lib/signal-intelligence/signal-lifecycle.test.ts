/**
 * Tests — Signal Lifecycle, Attribution, Decay, Position Sizing (Phases 27–36)
 *
 * Regression tests for:
 *   - State machine rejects invalid transitions
 *   - Recall engine marks NOT_INDEPENDENTLY_VALIDATED when no independent detector
 *   - Decay detection respects minimum sample (no premature demotion)
 *   - Position sizing respects hard caps
 */

import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  createLifecycleEvent,
  buildRecallReport,
  buildSignalAttribution,
  detectSignalDecay,
  computeDynamicPositionSize,
} from "@/lib/signal-intelligence/signal-lifecycle";

describe("Signal Lifecycle State Machine (Phase 27)", () => {
  describe("valid transitions", () => {
    it("DETECTED → VALIDATING is valid", () => {
      expect(isValidTransition("DETECTED", "VALIDATING")).toBe(true);
    });

    it("DETECTED → REJECTED is valid", () => {
      expect(isValidTransition("DETECTED", "REJECTED")).toBe(true);
    });

    it("QUALIFIED → RISK_CHECK is valid", () => {
      expect(isValidTransition("QUALIFIED", "RISK_CHECK")).toBe(true);
    });

    it("APPROVED → PAPER_EXECUTED is valid", () => {
      expect(isValidTransition("APPROVED", "PAPER_EXECUTED")).toBe(true);
    });

    it("ACTIVE → EXITED is valid", () => {
      expect(isValidTransition("ACTIVE", "EXITED")).toBe(true);
    });

    it("ACTIVE → EXPIRED is valid", () => {
      expect(isValidTransition("ACTIVE", "EXPIRED")).toBe(true);
    });
  });

  describe("invalid transitions", () => {
    it("DETECTED → APPROVED is invalid (must go through VALIDATING)", () => {
      expect(isValidTransition("DETECTED", "APPROVED")).toBe(false);
    });

    it("EXITED → ACTIVE is invalid (terminal state)", () => {
      expect(isValidTransition("EXITED", "ACTIVE")).toBe(false);
    });

    it("REJECTED → APPROVED is invalid (terminal state)", () => {
      expect(isValidTransition("REJECTED", "APPROVED")).toBe(false);
    });

    it("PAPER_EXECUTED → QUALIFIED is invalid (backward)", () => {
      expect(isValidTransition("PAPER_EXECUTED", "QUALIFIED")).toBe(false);
    });
  });

  describe("createLifecycleEvent", () => {
    it("creates valid event for allowed transition", () => {
      const event = createLifecycleEvent("sig-001", "DETECTED", "VALIDATING", "Validation started");
      expect(event.signalId).toBe("sig-001");
      expect(event.fromState).toBe("DETECTED");
      expect(event.toState).toBe("VALIDATING");
      expect(event.reason).toBe("Validation started");
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("throws for invalid transition", () => {
      expect(() =>
        createLifecycleEvent("sig-001", "DETECTED", "APPROVED", "Invalid shortcut"),
      ).toThrow();
    });

    it("allows null fromState for initial DETECTED event", () => {
      const event = createLifecycleEvent("sig-001", null, "DETECTED", "Signal created");
      expect(event.fromState).toBeNull();
      expect(event.toState).toBe("DETECTED");
    });
  });
});

describe("REGRESSION: Recall Engine marks NOT_INDEPENDENTLY_VALIDATED (Phase 28)", () => {
  const trades = [
    { instrument: "NIFTY", openedAt: new Date(), direction: "LONG", status: "WIN" },
    { instrument: "NIFTY", openedAt: new Date(), direction: "LONG", status: "LOSS" },
    { instrument: "BANKNIFTY", openedAt: new Date(), direction: "SHORT", status: "WIN" },
  ];

  it("marks notIndependentlyValidated as true", () => {
    const report = buildRecallReport("OPENING_BREAKOUT", trades, 7 * 24 * 3600 * 1000);
    expect(report.notIndependentlyValidated).toBe(true);
  });

  it("provides explanation for why independent validation is unavailable", () => {
    const report = buildRecallReport("OPENING_BREAKOUT", trades, 7 * 24 * 3600 * 1000);
    expect(report.notIndependentlyValidatedReason).toBeTruthy();
    expect(report.notIndependentlyValidatedReason).toContain("independent");
  });

  it("counts captured trades correctly", () => {
    const report = buildRecallReport("OPENING_BREAKOUT", trades, 7 * 24 * 3600 * 1000);
    expect(report.captured).toBe(3);
  });

  it("estimates missed as 20% of captured", () => {
    const report = buildRecallReport("OPENING_BREAKOUT", trades, 7 * 24 * 3600 * 1000);
    expect(report.missed).toBe(Math.round(3 * 0.2));
  });
});

describe("Signal Attribution (Phase 30)", () => {
  it("builds attribution with all required fields", () => {
    const attr = buildSignalAttribution({
      signalId: "sig-001",
      strategyId: "OPENING_BREAKOUT",
      instrument: "NIFTY",
      direction: "LONG",
      outcome: "WIN",
      confidence: 0.72,
      mlProbability: 0.65,
      mlModelVersion: "v1.0.0",
      rvol: 1.8,
      atr: 120,
      pcrOi: 1.25,
      maxPain: 24200,
      regimeLabel: "BULL",
      marketContextLabel: "UP, VIX=13.5, AD=76%",
      providerId: "angel_one",
      dataQuality: "COMPLETE",
      riskFilterPassed: true,
      mlFilterPassed: true,
      volumeFilterPassed: true,
    });

    expect(attr.signalId).toBe("sig-001");
    expect(attr.outcome).toBe("WIN");
    expect(attr.features.length).toBeGreaterThan(0);
    expect(attr.filters.length).toBeGreaterThan(0);
    expect(attr.explanation).toContain("OPENING_BREAKOUT");
    expect(attr.explanation).toContain("LONG");
    expect(attr.explanation).toContain("NIFTY");
  });

  it("includes ML model contribution when mlProbability > 0", () => {
    const attr = buildSignalAttribution({
      signalId: "sig-002",
      strategyId: "MOMENTUM",
      instrument: "RELIANCE",
      direction: "LONG",
      outcome: "LOSS",
      confidence: 0.55,
      mlProbability: 0.62,
      mlModelVersion: "v1.0.0",
      rvol: 1.2,
      atr: 50,
      pcrOi: null,
      maxPain: null,
      regimeLabel: "SIDEWAYS",
      marketContextLabel: "FLAT",
      providerId: "yahoo",
      dataQuality: "PARTIAL",
      riskFilterPassed: true,
      mlFilterPassed: true,
      volumeFilterPassed: true,
    });
    expect(attr.modelContributions.length).toBeGreaterThan(0);
  });
});

describe("REGRESSION: Signal Decay does not demote on tiny samples (Phase 36)", () => {
  it("returns HEALTHY state for < 10 trades", () => {
    const trades = Array.from({ length: 5 }, (_, i) => ({
      status: i % 2 === 0 ? "WIN" : "LOSS",
      pnlPct: i % 2 === 0 ? 1.5 : -1.0,
      openedAt: new Date(Date.now() - i * 3600 * 1000),
    }));
    const report = detectSignalDecay("MOMENTUM", trades);
    // Too few trades — must not trigger demotion
    expect(report.state).toBe("HEALTHY");
    expect(report.precisionTrend).toBe("INSUFFICIENT_DATA");
  });

  it("detects declining precision for 30 bad trades after 10 good", () => {
    const goodTrades = Array.from({ length: 15 }, (_, i) => ({
      status: "WIN",
      pnlPct: 1.5,
      openedAt: new Date(Date.now() - (i + 30) * 3600 * 1000),
    }));
    const badTrades = Array.from({ length: 25 }, (_, i) => ({
      status: "LOSS",
      pnlPct: -1.0,
      openedAt: new Date(Date.now() - i * 3600 * 1000),
    }));
    const report = detectSignalDecay("MOMENTUM", [...goodTrades, ...badTrades]);
    // 40 total trades; recent 20 all losses → decline should be detected
    expect(["WATCH", "DEGRADED", "CRITICAL"]).toContain(report.state);
    expect(report.decayDetected).toBe(true);
  });

  it("provides recommendation for every state", () => {
    const trades = Array.from({ length: 5 }, (_, i) => ({
      status: "WIN",
      pnlPct: 1.5,
      openedAt: new Date(),
    }));
    const report = detectSignalDecay("OPENING_BREAKOUT", trades);
    expect(report.recommendation).toBeTruthy();
  });
});

describe("Dynamic Position Sizing (Phase 34)", () => {
  const baseInput = {
    strategyId: "OPENING_BREAKOUT",
    totalCapital: 100_000,
    currentDrawdownPct: 0,
    signalScore: 75,
    calibratedWinProbability: 0.58,
    volatilityRegime: "NORMAL" as const,
    liquidityScore: 0.9,
    correlatedOpenPositions: 0,
    currentPortfolioExposurePct: 20,
    maxPositionSizePct: 20,
    maxPortfolioExposurePct: 80,
  };

  it("returns non-zero size for high-quality signal", () => {
    const result = computeDynamicPositionSize(baseInput);
    expect(result.recommendedSizePct).toBeGreaterThan(0);
    expect(result.recommendedSizeINR).toBeGreaterThan(0);
  });

  it("respects hard portfolio cap", () => {
    const almostFull = { ...baseInput, currentPortfolioExposurePct: 75 };
    const result = computeDynamicPositionSize(almostFull);
    expect(result.recommendedSizePct).toBeLessThanOrEqual(20);
    expect(result.hardCapApplied).toBe(true);
  });

  it("reduces size for deep drawdown (>15%)", () => {
    const normal = computeDynamicPositionSize(baseInput);
    const drawdown = computeDynamicPositionSize({ ...baseInput, currentDrawdownPct: 16 });
    expect(drawdown.recommendedSizePct).toBeLessThan(normal.recommendedSizePct);
    expect(drawdown.reducedForReason).toContain("drawdown");
  });

  it("reduces size in EXTREME volatility", () => {
    const normal = computeDynamicPositionSize(baseInput);
    const extreme = computeDynamicPositionSize({ ...baseInput, volatilityRegime: "EXTREME" });
    expect(extreme.recommendedSizePct).toBeLessThan(normal.recommendedSizePct);
  });

  it("reduces size when low calibrated win probability", () => {
    const lowProb = computeDynamicPositionSize({ ...baseInput, calibratedWinProbability: 0.38 });
    expect(lowProb.reducedForReason).toBeTruthy();
  });

  it("size never exceeds maxPositionSizePct", () => {
    const result = computeDynamicPositionSize(baseInput);
    expect(result.recommendedSizePct).toBeLessThanOrEqual(baseInput.maxPositionSizePct);
  });
});
