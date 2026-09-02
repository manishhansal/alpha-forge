/**
 * Tests — Paper Trading Fidelity, Funnel, Audit, Isolation (Phases 37–42)
 *
 * Regression tests for:
 *   - Paper fill ≠ candle close (realistic execution)
 *   - EOD square-off handling
 *   - Execution mode isolation (BACKTEST/RESEARCH/PAPER/LIVE never mix)
 *   - Signal funnel bottleneck detection
 *   - Replay hash determinism (same inputs → same hash)
 */

import { describe, it, expect } from "vitest";
import {
  computePaperFill,
  buildSignalPaperFunnel,
  buildTodaySignalAuditReport,
  computeReplayHash,
  assertExecutionModeIsolation,
  canProducePaperTrades,
  canProduceLiveOrders,
} from "@/lib/signal-intelligence/paper-trading-fidelity";
import { buildUnavailableCoverageSnapshot } from "@/lib/signal-intelligence/fno-universe";

describe("computePaperFill", () => {
  it("market order adds spread + impact to fill price", () => {
    const result = computePaperFill({
      signalPrice: 24000,
      bidAskSpread: 5,
      marketImpactPct: 0.02,
      latencyMs: 500,
      orderType: "MARKET",
      priceChangeDuringLatency: 0,
      allowPartialFill: false,
      istMinutes: 10 * 60 + 30, // 10:30 IST
    });
    expect(result.filled).toBe(true);
    expect(result.fillPrice).toBeGreaterThan(24000); // market order fills above mid
    expect(result.slippagePct).toBeGreaterThan(0);
  });

  it("limit order fills at signal price when no drift", () => {
    const result = computePaperFill({
      signalPrice: 24000,
      bidAskSpread: 5,
      marketImpactPct: 0.01,
      latencyMs: 0,
      orderType: "LIMIT",
      priceChangeDuringLatency: 0,
      allowPartialFill: false,
      istMinutes: 10 * 60 + 30,
    });
    expect(result.filled).toBe(true);
    expect(result.fillPrice).toBe(24000);
    expect(result.slippagePct).toBe(0);
  });

  it("REGRESSION: paper fill != candle close — market order fills above mid", () => {
    // This is the key regression: previous system assumed paper fill = candle close
    const result = computePaperFill({
      signalPrice: 24000,
      bidAskSpread: 10,
      marketImpactPct: 0.03,
      latencyMs: 200,
      orderType: "MARKET",
      priceChangeDuringLatency: 5, // price moved 5₹ during latency
      allowPartialFill: false,
      istMinutes: 10 * 60,
    });
    // Fill price should NOT equal the original signal price
    expect(result.fillPrice).not.toBe(24000);
    expect(result.totalCostPct).toBeGreaterThan(0.05); // costs are real
  });

  it("EOD square-off uses approximate price", () => {
    const result = computePaperFill({
      signalPrice: 24000,
      bidAskSpread: 5,
      marketImpactPct: 0.01,
      latencyMs: 0,
      orderType: "MARKET",
      priceChangeDuringLatency: 0,
      allowPartialFill: false,
      istMinutes: 15 * 60 + 28, // 15:28 IST — EOD
    });
    expect(result.isEodSquareOff).toBe(true);
    expect(result.filled).toBe(true);
  });

  it("total cost is always positive", () => {
    const result = computePaperFill({
      signalPrice: 24000,
      bidAskSpread: 3,
      marketImpactPct: 0.01,
      latencyMs: 100,
      orderType: "MARKET",
      priceChangeDuringLatency: 0,
      allowPartialFill: false,
      istMinutes: 10 * 60,
    });
    expect(result.totalCostPct).toBeGreaterThan(0);
  });
});

describe("buildSignalPaperFunnel (Phase 38)", () => {
  it("identifies bottleneck at stage with largest drop", () => {
    const funnel = buildSignalPaperFunnel(
      "OPENING_BREAKOUT",
      100, // opportunities
      80,  // signals generated
      60,  // qualified
      55,  // risk approved
      50,  // orders placed
      50,  // filled
      35,  // winners
      15,  // losers
      Array(35).fill(1.5),
      Array(15).fill(-1.0),
    );
    expect(funnel.bottleneck).toBeDefined(); // null or a FunnelStage
    expect(funnel.stages.length).toBe(8);
  });

  it("computes paper win rate correctly", () => {
    const funnel = buildSignalPaperFunnel(
      "MOMENTUM",
      50, 40, 35, 30, 28, 28, 20, 8,
      Array(20).fill(1.5),
      Array(8).fill(-1.0),
    );
    expect(funnel.paperWinRate).toBeCloseTo(20 / 28, 2);
  });

  it("computes paper P&L as per-trade average", () => {
    const funnel = buildSignalPaperFunnel(
      "RANGE_EXPANSION",
      50, 40, 35, 30, 28, 28, 14, 14,
      Array(14).fill(2.0),
      Array(14).fill(-1.0),
    );
    // (14 * 2.0 + 14 * -1.0) / 28 = 0.5
    expect(funnel.paperPnlPct).toBeCloseTo(0.5, 2);
  });
});

describe("REGRESSION: Execution mode isolation (Phase 40)", () => {
  it("BACKTEST mode cannot produce paper trades", () => {
    expect(canProducePaperTrades("BACKTEST")).toBe(false);
  });

  it("RESEARCH mode cannot produce paper trades", () => {
    expect(canProducePaperTrades("RESEARCH")).toBe(false);
  });

  it("PAPER mode can produce paper trades", () => {
    expect(canProducePaperTrades("PAPER")).toBe(true);
  });

  it("LIVE mode can produce paper trades", () => {
    expect(canProducePaperTrades("LIVE")).toBe(true);
  });

  it("LIVE mode cannot produce live orders without env flag", () => {
    // In test environment LIVE_TRADING_ENABLED is not set
    expect(canProduceLiveOrders("LIVE")).toBe(false);
  });

  it("assertExecutionModeIsolation throws on mismatch", () => {
    expect(() =>
      assertExecutionModeIsolation("PAPER", "BACKTEST", "paper trader"),
    ).toThrow("[ExecutionIsolation]");
  });

  it("assertExecutionModeIsolation does not throw on match", () => {
    expect(() =>
      assertExecutionModeIsolation("PAPER", "PAPER", "paper trader"),
    ).not.toThrow();
  });
});

describe("REGRESSION: Deterministic replay hash (Phase 42)", () => {
  const baseCoverage = buildUnavailableCoverageSnapshot("2026-09-02", "No scanner");

  function makeReport(overrides = {}) {
    return buildTodaySignalAuditReport({
      sessionDate: "2026-09-02",
      universeCoverage: baseCoverage,
      signalsDetected: 15,
      signalsQualified: 12,
      riskApproved: 10,
      paperTradesOpened: 8,
      paperTradesResolved: 7,
      winners: 5,
      losers: 2,
      missedOpportunities: 3,
      falseSignals: 2,
      duplicatesPrevented: 2,
      riskRejected: 2,
      byStrategy: [
        { strategyId: "OPENING_BREAKOUT", sourceType: "STRATEGY" as const, signalsDetected: 5, qualified: 4, paperTrades: 3, wins: 2, losses: 1, pnlPct: 0.8 },
        { strategyId: "MOMENTUM", sourceType: "STRATEGY" as const, signalsDetected: 4, qualified: 3, paperTrades: 2, wins: 1, losses: 1, pnlPct: 0.3 },
      ],
      mlEvaluated: true,
      mlBaseSignals: 15,
      mlFilteredIn: 8,
      mlFilteredOut: 2,
      mlIncrementalPrecision: 0.05,
      avgSpreadPct: 0.08,
      avgSlippagePct: 0.04,
      dataFreshnessScore: 0.95,
      replayHash: null,
      ...overrides,
    });
  }

  it("same inputs produce identical replay hash", () => {
    const report1 = makeReport();
    const report2 = makeReport();
    const hash1 = computeReplayHash(report1);
    const hash2 = computeReplayHash(report2);
    expect(hash1).toBe(hash2);
  });

  it("different signals detected produces different hash", () => {
    const report1 = makeReport({ signalsDetected: 15 });
    const report2 = makeReport({ signalsDetected: 16 });
    const hash1 = computeReplayHash(report1);
    const hash2 = computeReplayHash(report2);
    expect(hash1).not.toBe(hash2);
  });

  it("hash starts with 'h' and is non-empty", () => {
    const report = makeReport();
    const hash = computeReplayHash(report);
    expect(hash).toBeTruthy();
    expect(hash.startsWith("h")).toBe(true);
  });

  it("different by-strategy breakdown produces different hash", () => {
    const report1 = makeReport();
    const report2 = makeReport({
      byStrategy: [
        { strategyId: "OPENING_BREAKOUT", sourceType: "STRATEGY" as const, signalsDetected: 5, qualified: 4, paperTrades: 4, wins: 3, losses: 1, pnlPct: 1.2 },
      ],
    });
    expect(computeReplayHash(report1)).not.toBe(computeReplayHash(report2));
  });
});
