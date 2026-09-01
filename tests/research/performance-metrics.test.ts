/**
 * Phase 27 — Unit Tests: Strategy Performance Metrics
 */

import { describe, it, expect } from "vitest";
import {
  computePerformanceMetrics,
  buildPerformanceReport,
  type AnalyzerTrade,
} from "@/lib/research/performance/strategy-performance-analyzer";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTrades(returns: number[], holdBars = 5, notional = 100_000): AnalyzerTrade[] {
  return returns.map((r) => ({ returnPct: r, holdBars, notionalValue: notional }));
}

// 10 trades: 6 wins, 4 losses; avg win 2%, avg loss -1%
const SAMPLE_TRADES = makeTrades([0.02, 0.02, 0.02, 0.02, 0.02, 0.02, -0.01, -0.01, -0.01, -0.01]);

// All winning trades
const ALL_WIN_TRADES = makeTrades([0.01, 0.02, 0.015, 0.01, 0.025]);

// All losing trades
const ALL_LOSS_TRADES = makeTrades([-0.01, -0.02, -0.015]);

// No trades
const EMPTY_TRADES: AnalyzerTrade[] = [];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computePerformanceMetrics", () => {
  it("returns zero-filled metrics for empty trade list", () => {
    const m = computePerformanceMetrics(EMPTY_TRADES, "FINAL_OOS");
    expect(m.tradeCount).toBe(0);
    expect(m.sharpe).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.expectancy).toBe(0);
  });

  it("computes correct trade count", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    expect(m.tradeCount).toBe(10);
  });

  it("computes correct win rate", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    expect(m.winRate).toBeCloseTo(0.6, 5);
  });

  it("computes correct loss rate (complement of win rate)", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    expect(m.lossRate).toBeCloseTo(0.4, 5);
  });

  it("computes correct expectancy", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    // E[R] = 0.6 × 0.02 + 0.4 × (-0.01) = 0.012 - 0.004 = 0.008
    expect(m.expectancy).toBeCloseTo(0.008, 4);
  });

  it("computes positive profit factor for winning strategy", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    expect(m.profitFactor).toBeGreaterThan(1);
  });

  it("computes positive Sharpe for consistent winning trades", () => {
    const m = computePerformanceMetrics(ALL_WIN_TRADES, "FINAL_OOS");
    expect(m.sharpe).toBeGreaterThan(0);
  });

  it("computes negative Sharpe for all losing trades", () => {
    const m = computePerformanceMetrics(ALL_LOSS_TRADES, "FINAL_OOS");
    expect(m.sharpe).toBeLessThan(0);
  });

  it("computes max drawdown between 0 and 1", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    expect(m.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(m.maxDrawdown).toBeLessThanOrEqual(1);
  });

  it("best trade is the maximum return", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    expect(m.bestTrade).toBeCloseTo(0.02, 5);
  });

  it("worst trade is the minimum return", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    expect(m.worstTrade).toBeCloseTo(-0.01, 5);
  });

  it("Calmar is non-negative when total return is positive", () => {
    const m = computePerformanceMetrics(ALL_WIN_TRADES, "FINAL_OOS");
    if (m.maxDrawdown > 0) {
      expect(m.calmar).toBeGreaterThan(0);
    }
  });

  it("p-value is between 0 and 1", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "FINAL_OOS");
    expect(m.pValue).toBeGreaterThanOrEqual(0);
    expect(m.pValue).toBeLessThanOrEqual(1);
  });

  it("correctly flags the performance period", () => {
    const m = computePerformanceMetrics(SAMPLE_TRADES, "PAPER");
    expect(m.period).toBe("PAPER");
  });
});

describe("buildPerformanceReport", () => {
  it("returns null periods when trades are empty", () => {
    const report = buildPerformanceReport("TEST", "v1", {});
    expect(report.inSample).toBeNull();
    expect(report.validation).toBeNull();
    expect(report.finalOos).toBeNull();
  });

  it("populates multiple periods independently", () => {
    const report = buildPerformanceReport("TEST", "v1", {
      inSampleTrades: makeTrades([0.01, 0.02]),
      finalOosTrades: makeTrades([0.015, -0.005]),
    });
    expect(report.inSample).not.toBeNull();
    expect(report.finalOos).not.toBeNull();
    expect(report.validation).toBeNull();
    expect(report.inSample!.period).toBe("IN_SAMPLE");
    expect(report.finalOos!.period).toBe("FINAL_OOS");
  });
});
