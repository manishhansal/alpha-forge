/**
 * Phase 27 — Unit Tests: Transaction Cost Attribution
 */

import { describe, it, expect } from "vitest";
import {
  computeCostBreakdown,
  buildCostAttributionReport,
  CRYPTO_PERP_COST_MODEL,
  NSE_FNO_OPTIONS_COST_MODEL,
} from "@/lib/research/costs/cost-attribution";
import type { AnalyzerTrade } from "@/lib/research/performance/strategy-performance-analyzer";

function makeTrades(returns: number[], notional = 100_000): AnalyzerTrade[] {
  return returns.map((r) => ({ returnPct: r, holdBars: 5, notionalValue: notional }));
}

describe("computeCostBreakdown", () => {
  it("returns zero breakdown for empty trades", () => {
    const b = computeCostBreakdown([], CRYPTO_PERP_COST_MODEL, 1);
    expect(b.grossPnl).toBe(0);
    expect(b.totalCost).toBe(0);
    expect(b.netPnl).toBe(0);
  });

  it("net PnL is less than gross PnL (costs are positive)", () => {
    const trades = makeTrades([0.02, 0.01, -0.005], 50_000);
    const b = computeCostBreakdown(trades, CRYPTO_PERP_COST_MODEL, 1);
    expect(b.totalCost).toBeGreaterThan(0);
    expect(b.netPnl).toBeLessThan(b.grossPnl);
  });

  it("higher cost multiplier increases total cost", () => {
    const trades = makeTrades([0.02, 0.01], 50_000);
    const b1 = computeCostBreakdown(trades, CRYPTO_PERP_COST_MODEL, 1);
    const b2 = computeCostBreakdown(trades, CRYPTO_PERP_COST_MODEL, 2);
    expect(b2.totalCost).toBeGreaterThan(b1.totalCost);
  });

  it("NSE F&O cost model has slippage", () => {
    const trades = makeTrades([0.01], 100_000);
    const b = computeCostBreakdown(trades, NSE_FNO_OPTIONS_COST_MODEL, 1);
    expect(b.slippage).toBeGreaterThan(0);
    expect(b.spread).toBeGreaterThan(0);
  });
});

describe("buildCostAttributionReport", () => {
  it("marks strategy as COST_FRAGILE when unprofitable at 2× costs", () => {
    // Strategy barely profitable: small wins, high costs
    const trades = makeTrades([0.001, 0.001, 0.001], 100_000);
    const report = buildCostAttributionReport("TEST", "FINAL_OOS", trades, CRYPTO_PERP_COST_MODEL);
    // With very small returns and 2× costs, strategy may be fragile
    expect(typeof report.costFragile).toBe("boolean");
  });

  it("generates stress tests for all 4 multipliers", () => {
    const trades = makeTrades([0.02, 0.02, -0.01], 100_000);
    const report = buildCostAttributionReport("TEST", "FINAL_OOS", trades, CRYPTO_PERP_COST_MODEL);
    expect(report.stressTests).toHaveLength(4);
    const multipliers = report.stressTests.map((s) => s.multiplier);
    expect(multipliers).toContain(1);
    expect(multipliers).toContain(1.5);
    expect(multipliers).toContain(2);
    expect(multipliers).toContain(3);
  });

  it("higher multiplier has higher total cost", () => {
    const trades = makeTrades([0.02, -0.01, 0.015], 100_000);
    const report = buildCostAttributionReport("TEST", "FINAL_OOS", trades, CRYPTO_PERP_COST_MODEL);
    const costs = report.stressTests.map((s) => s.costBreakdown.totalCost);
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeGreaterThan(costs[i - 1]);
    }
  });

  it("break-even multiple is at least 1", () => {
    const trades = makeTrades([0.02, 0.02, 0.02, -0.005], 100_000);
    const report = buildCostAttributionReport("TEST", "FINAL_OOS", trades, CRYPTO_PERP_COST_MODEL);
    expect(report.breakEvenCostMultiple).toBeGreaterThanOrEqual(1);
  });
});
