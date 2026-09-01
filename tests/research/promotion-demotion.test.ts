/**
 * Phase 27 — Unit Tests: Promotion & Demotion Rules
 */

import { describe, it, expect, beforeEach } from "vitest";
import { evaluatePromotion, applyDemotion } from "@/lib/research/promotion/strategy-promotion-engine";
import type { PerformanceMetrics, CostAttributionReport } from "@/lib/research/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    period: "FINAL_OOS",
    totalReturn: 0.15,
    cagr: 0.12,
    volatility: 0.08,
    sharpe: 1.2,
    sortino: 1.5,
    calmar: 2.0,
    profitFactor: 1.8,
    winRate: 0.60,
    lossRate: 0.40,
    expectancy: 0.008,
    averageWin: 0.02,
    averageLoss: -0.01,
    payoffRatio: 2.0,
    maxDrawdown: 0.08,
    averageDrawdown: 0.03,
    drawdownDuration: 10,
    ulcerIndex: 2.5,
    sqn: 2.8,
    turnover: 52,
    averageHoldTime: 5,
    tradeCount: 100,
    tradesPerMonth: 8,
    exposureTime: 0.4,
    bestTrade: 0.05,
    worstTrade: -0.03,
    tailLoss: -0.025,
    skewness: 0.3,
    kurtosis: 3.5,
    tStatistic: 3.2,
    pValue: 0.001,
    statisticallySignificant: true,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("evaluatePromotion — EXPERIMENTAL → RESEARCH", () => {
  it("passes when hypothesis is defined", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "EXPERIMENTAL",
      hypothesisDefined: true,
    });
    expect(record.allGatesPassed).toBe(true);
    expect(record.toStatus).toBe("RESEARCH");
  });

  it("blocks when hypothesis is not defined", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "EXPERIMENTAL",
      hypothesisDefined: false,
    });
    expect(record.allGatesPassed).toBe(false);
    expect(record.toStatus).toBe("EXPERIMENTAL");
  });
});

describe("evaluatePromotion — RESEARCH → BACKTEST_VALIDATED", () => {
  it("passes when all backtest gates are met", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "RESEARCH",
      finalOosMetrics: makeMetrics({ tradeCount: 50 }),
      costReport: {
        strategyId: "UT_SMC",
        period: "FINAL_OOS",
        tradeCount: 50,
        baseline: {
          grossPnl: 10000, brokerage: 500, exchangeCharges: 200, taxes: 100,
          slippage: 300, spread: 200, marketImpact: 0, totalCost: 1300, netPnl: 8700, costTurnoverRatio: 0.01,
        },
        stressTests: [],
        costFragile: false,
        breakEvenCostMultiple: 2.5,
        computedAt: new Date().toISOString(),
      } as CostAttributionReport,
      hypothesisDefined: true,
    });
    expect(record.allGatesPassed).toBe(true);
  });

  it("blocks when trade count is below minimum (30)", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "RESEARCH",
      finalOosMetrics: makeMetrics({ tradeCount: 10 }),
      hypothesisDefined: true,
    });
    const tradeGate = record.gates.find((g) => g.gateName === "MIN_TRADE_COUNT");
    expect(tradeGate?.passed).toBe(false);
    expect(record.allGatesPassed).toBe(false);
  });

  it("blocks when expectancy is negative", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "RESEARCH",
      finalOosMetrics: makeMetrics({ tradeCount: 50, expectancy: -0.002 }),
      hypothesisDefined: true,
    });
    const gate = record.gates.find((g) => g.gateName === "POSITIVE_EXPECTANCY");
    expect(gate?.passed).toBe(false);
  });

  it("blocks when max drawdown exceeds 30%", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "RESEARCH",
      finalOosMetrics: makeMetrics({ tradeCount: 50, maxDrawdown: 0.45 }),
      hypothesisDefined: true,
    });
    const gate = record.gates.find((g) => g.gateName === "MAX_DRAWDOWN_LIMIT");
    expect(gate?.passed).toBe(false);
  });
});

describe("evaluatePromotion — LIVE_CANDIDATE → MANUAL_APPROVAL → LIVE", () => {
  it("LIVE_CANDIDATE → MANUAL_APPROVAL with gates passing", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "LIVE_CANDIDATE",
      paperMetrics: makeMetrics({ tradeCount: 50, sharpe: 1.2, profitFactor: 1.8 }),
      paperSessionCount: 45,
      decayMonitor: { state: "HEALTHY" } as any,
      costReport: {
        costFragile: false,
        breakEvenCostMultiple: 2.5,
        strategyId: "UT_SMC",
      } as any,
    });
    // LIVE_CANDIDATE → MANUAL_APPROVAL requires sessionCount ≥ 20 and paper Sharpe ≥ 0.6
    expect(record.fromStatus).toBe("LIVE_CANDIDATE");
  });

  it("LIVE requires explicit approval token — auto-promotion is blocked", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "MANUAL_APPROVAL",
      // No approval token provided
    });
    expect(record.allGatesPassed).toBe(false);
    const gate = record.gates.find((g) => g.gateName === "MANUAL_HUMAN_APPROVAL");
    expect(gate?.passed).toBe(false);
  });

  it("LIVE promotion passes with valid approval token", () => {
    const record = evaluatePromotion({
      strategyId: "UT_SMC",
      fromStatus: "MANUAL_APPROVAL",
      approvalToken: "VALID-TOKEN-123",
      approvedBy: "quant-lead@alphaforge.com",
    });
    const gate = record.gates.find((g) => g.gateName === "MANUAL_HUMAN_APPROVAL");
    expect(gate?.passed).toBe(true);
    if (record.allGatesPassed) {
      expect(record.promotedBy).toBe("quant-lead@alphaforge.com");
    }
  });
});

describe("applyDemotion", () => {
  it("creates a demotion record with all required fields", () => {
    const record = applyDemotion({
      strategyId: "UT_SMC",
      currentStatus: "LIVE",
      trigger: "ALPHA_DECAY",
      reason: "Rolling Sharpe dropped below 0.2",
      metricsSnapshot: { sharpe: 0.15 },
    });
    expect(record.strategyId).toBe("UT_SMC");
    expect(record.fromStatus).toBe("LIVE");
    expect(record.trigger).toBe("ALPHA_DECAY");
    expect(record.demotionReason).toBeDefined();
    expect(record.demotedAt).toBeDefined();
    expect(record.metricsSnapshot.sharpe).toBe(0.15);
  });

  it("force-disable sets status to DISABLED", () => {
    const record = applyDemotion({
      strategyId: "UT_SMC",
      currentStatus: "LIVE",
      trigger: "REPEATED_ERRORS",
      reason: "15 consecutive execution errors",
      forceDisable: true,
    });
    expect(record.toStatus).toBe("DISABLED");
  });

  it("default demotion from LIVE goes to DEGRADED", () => {
    const record = applyDemotion({
      strategyId: "UT_SMC",
      currentStatus: "LIVE",
      trigger: "ALPHA_DECAY",
      reason: "Test",
      forceDisable: false,
    });
    expect(record.toStatus).toBe("DEGRADED");
  });
});
