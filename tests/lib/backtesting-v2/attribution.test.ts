/**
 * Attribution — lookahead audit and trade grouping tests.
 */

import { describe, it, expect } from "vitest";
import {
  buildAttributionReport,
  extractFillTimings,
} from "@/lib/backtesting-v2/analytics/attribution";
import type { Trade } from "@/lib/backtesting-v2/models/trade";
import { niftyInstrument } from "./helpers";

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const instrument = niftyInstrument();
  return {
    id: "t1",
    positionId: "p1",
    instrument,
    direction: "LONG",
    entryPrice: 100,
    exitPrice: 110,
    qty: 1,
    grossPnl: 500,
    commission: 50,
    netPnl: 450,
    pnlPct: 4.5,
    closeReason: "TARGET",
    openedAtMs: 1_000_000,
    closedAtMs: 2_000_000,
    openBarIndex: 1,
    closeBarIndex: 5,
    barsHeld: 4,
    durationMs: 1_000_000,
    strategyId: "momentum",
    signalId: "sig_1",
    modelVersion: "v1",
    featureVersion: "features-v1",
    marketRegime: "TRENDING_UP",
    dataQualityScore: 0.9,
    stopLoss: 90,
    target: 115,
    plannedRR: 1.5,
    actualRR: 1.0,
    entryAtr: 5,
    mae: -100,
    mfe: 600,
    ...overrides,
  };
}

describe("buildAttributionReport", () => {
  it("groups trades by strategyId correctly", () => {
    const trades: Trade[] = [
      makeTrade({ id: "t1", strategyId: "momentum" }),
      makeTrade({ id: "t2", strategyId: "momentum" }),
      makeTrade({ id: "t3", strategyId: "volume_breakout" }),
    ];

    const report = buildAttributionReport({ trades });

    expect(report.totalTrades).toBe(3);
    expect(report.byStrategy).toHaveLength(2);

    const momentum = report.byStrategy.find((s) => s.label === "momentum");
    expect(momentum?.trades).toBe(2);

    const vb = report.byStrategy.find((s) => s.label === "volume_breakout");
    expect(vb?.trades).toBe(1);
  });

  it("groups by marketRegime", () => {
    const trades: Trade[] = [
      makeTrade({ id: "t1", marketRegime: "TRENDING_UP" }),
      makeTrade({ id: "t2", marketRegime: "RANGING" }),
      makeTrade({ id: "t3", marketRegime: "TRENDING_UP" }),
    ];

    const report = buildAttributionReport({ trades });
    const trending = report.byMarketRegime.find((r) => r.label === "TRENDING_UP");
    expect(trending?.trades).toBe(2);
  });

  it("groups by data quality band", () => {
    const trades: Trade[] = [
      makeTrade({ id: "t1", dataQualityScore: 0.9 }),  // high
      makeTrade({ id: "t2", dataQualityScore: 0.6 }),  // medium
      makeTrade({ id: "t3", dataQualityScore: 0.3 }),  // low
    ];

    const report = buildAttributionReport({ trades });
    const bands = report.byDataQuality.map((b) => b.label);
    expect(bands.some((b) => b.includes("high"))).toBe(true);
    expect(bands.some((b) => b.includes("medium"))).toBe(true);
    expect(bands.some((b) => b.includes("low"))).toBe(true);
  });

  it("empty lookaheadViolations for correct fill timings", () => {
    const trades: Trade[] = [makeTrade()];
    const fillTimings = [
      {
        tradeId: "t1",
        strategyId: "momentum",
        signalTimestampMs: 1_000_000,
        executionTimestampMs: 1_060_000, // after signal
      },
    ];

    const report = buildAttributionReport({ trades, fillTimings });
    expect(report.lookaheadViolations).toHaveLength(0);
  });

  it("detects lookahead violation when executionTimestampMs <= signalTimestampMs", () => {
    const trades: Trade[] = [makeTrade()];
    const fillTimings = [
      {
        tradeId: "t1",
        strategyId: "momentum",
        signalTimestampMs: 2_000_000,
        executionTimestampMs: 1_000_000, // BEFORE signal — violation!
      },
    ];

    const report = buildAttributionReport({ trades, fillTimings });
    expect(report.lookaheadViolations).toHaveLength(1);
    expect(report.lookaheadViolations[0].tradeId).toBe("t1");
    expect(report.lookaheadViolations[0].deltaMs).toBeLessThan(0);
  });

  it("returns zero lookaheadViolations for empty trades", () => {
    const report = buildAttributionReport({ trades: [] });
    expect(report.lookaheadViolations).toHaveLength(0);
    expect(report.totalTrades).toBe(0);
  });

  it("winRate is correctly computed per strategy slice", () => {
    const trades: Trade[] = [
      makeTrade({ id: "t1", strategyId: "s1", netPnl: 100 }),
      makeTrade({ id: "t2", strategyId: "s1", netPnl: -50 }),
      makeTrade({ id: "t3", strategyId: "s1", netPnl: 200 }),
    ];

    const report = buildAttributionReport({ trades });
    const s1 = report.byStrategy.find((s) => s.label === "s1")!;
    expect(s1.winRate).toBeCloseTo(2 / 3);
    expect(s1.wins).toBe(2);
    expect(s1.losses).toBe(1);
  });

  it("profitFactor per strategy slice", () => {
    const trades: Trade[] = [
      makeTrade({ id: "t1", strategyId: "s1", netPnl: 200 }),
      makeTrade({ id: "t2", strategyId: "s1", netPnl: -100 }),
    ];
    const report = buildAttributionReport({ trades });
    const s1 = report.byStrategy.find((s) => s.label === "s1")!;
    expect(s1.profitFactor).toBeCloseTo(2);
  });
});
