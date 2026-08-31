/**
 * Portfolio model — deterministic unit tests.
 *
 * Tests: accounting invariants, margin, P&L, drawdown tracking,
 * capital exhaustion, session bookkeeping.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Portfolio } from "@/lib/backtesting-v2/models/portfolio";
import { buildFillEvent } from "@/lib/backtesting-v2/events/fill-event";
import { resetPositionCounter } from "@/lib/backtesting-v2/models/position";
import { resetEventIdCounter } from "@/lib/backtesting-v2/events/market-event";
import { niftyInstrument } from "./helpers";

beforeEach(() => {
  resetPositionCounter();
  resetEventIdCounter();
});

function makeOpenFill(opts: {
  price: number;
  qty?: number;
  commission?: number;
  direction?: "LONG" | "SHORT";
  timestampMs?: number;
}) {
  const instrument = niftyInstrument();
  return buildFillEvent({
    sourceEventId: "src_1",
    orderEventId: "ord_1",
    signalEventId: "sig_1",
    timestampMs: opts.timestampMs ?? 1_000_000,
    instrument,
    side: opts.direction === "SHORT" ? "SELL" : "BUY",
    intent: "OPEN",
    direction: opts.direction ?? "LONG",
    qty: opts.qty ?? 1,
    fillPrice: opts.price,
    commission: opts.commission ?? 0,
    slippage: 0,
    signalTimestampMs: (opts.timestampMs ?? 1_000_000) - 60_000,
    executionTimestampMs: opts.timestampMs ?? 1_000_000,
    executionBarIndex: 1,
  });
}

function makeCloseFill(opts: {
  price: number;
  qty?: number;
  commission?: number;
  direction?: "LONG" | "SHORT";
  intent?: "CLOSE" | "STOP_LOSS" | "TAKE_PROFIT";
  timestampMs?: number;
}) {
  const instrument = niftyInstrument();
  return buildFillEvent({
    sourceEventId: "src_2",
    orderEventId: "ord_2",
    signalEventId: "sig_1",
    timestampMs: opts.timestampMs ?? 2_000_000,
    instrument,
    side: opts.direction === "SHORT" ? "BUY" : "SELL",
    intent: opts.intent ?? "CLOSE",
    direction: opts.direction ?? "LONG",
    qty: opts.qty ?? 1,
    fillPrice: opts.price,
    commission: opts.commission ?? 0,
    slippage: 0,
    signalTimestampMs: 1_000_000,
    executionTimestampMs: opts.timestampMs ?? 2_000_000,
    executionBarIndex: 3,
  });
}

const attribution = {
  strategyId: "test",
  signalId: "sig_1",
  modelVersion: "v1",
  featureVersion: "f1",
  marketRegime: "UNKNOWN" as const,
  dataQualityScore: 0.9,
};

// ── Margin accounting ─────────────────────────────────────────────────────────

describe("Portfolio margin accounting", () => {
  it("deducts margin from cash on position open", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, marginFactor: 0.1 });
    const fill = makeOpenFill({ price: 1_000 });

    portfolio.openPositionFromFill(fill, {
      stopLoss: 950,
      target: 1_100,
      attribution,
    });

    // Notional = 1 lot × 1000 price × 50 lot_size = 50_000
    // Margin = 50_000 × 0.1 = 5_000
    expect(portfolio.marginUsed).toBeCloseTo(5_000);
    expect(portfolio.cash).toBeCloseTo(95_000); // 100_000 - 5_000
  });

  it("releases margin on position close", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, marginFactor: 0.1 });
    const openFill = makeOpenFill({ price: 1_000 });
    const pos = portfolio.openPositionFromFill(openFill, {
      stopLoss: 950, target: 1_100, attribution,
    });

    const closeFill = makeCloseFill({ price: 1_050 });
    portfolio.closePositionFromFill(pos.id, closeFill, "TARGET");

    expect(portfolio.marginUsed).toBeCloseTo(0);
    expect(portfolio.openPositionCount).toBe(0);
  });
});

// ── P&L accounting ────────────────────────────────────────────────────────────

describe("Portfolio P&L accounting", () => {
  it("records positive realised P&L on winning trade", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, marginFactor: 0.1 });
    const entry = 1_000;
    const exit = 1_100;
    const qty = 1;
    const lotSize = 50;

    const openFill = makeOpenFill({ price: entry, qty });
    const pos = portfolio.openPositionFromFill(openFill, { stopLoss: 950, target: exit, attribution });

    const closeFill = makeCloseFill({ price: exit, qty });
    const trade = portfolio.closePositionFromFill(pos.id, closeFill, "TARGET");

    // Gross P&L = (1100 - 1000) × 1 × 50 = 5000
    expect(trade.grossPnl).toBeCloseTo(5_000);
    expect(trade.netPnl).toBeCloseTo(5_000); // zero commission in this test
    expect(portfolio.totalRealisedPnl).toBeCloseTo(5_000);
  });

  it("records negative realised P&L on losing trade", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, marginFactor: 0.1 });
    const openFill = makeOpenFill({ price: 1_000, qty: 1 });
    const pos = portfolio.openPositionFromFill(openFill, { stopLoss: 950, target: 1_100, attribution });

    const closeFill = makeCloseFill({ price: 950, qty: 1, intent: "STOP_LOSS" });
    const trade = portfolio.closePositionFromFill(pos.id, closeFill, "STOP");

    expect(trade.netPnl).toBeLessThan(0);
    expect(portfolio.totalRealisedPnl).toBeLessThan(0);
  });

  it("equity = cash + unrealised after mark-to-market", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, marginFactor: 0.1 });
    const openFill = makeOpenFill({ price: 1_000, qty: 1 });
    portfolio.openPositionFromFill(openFill, { stopLoss: 950, target: 1_100, attribution });

    portfolio.markToMarket(new Map([["NIFTY", 1_050]]));

    // Unrealised = (1050 - 1000) × 1 × 50 = 2500
    expect(portfolio.totalUnrealisedPnl).toBeCloseTo(2_500);
    expect(portfolio.equity).toBeCloseTo(portfolio.cash + portfolio.totalUnrealisedPnl);
  });
});

// ── Drawdown tracking ─────────────────────────────────────────────────────────

describe("Portfolio drawdown tracking", () => {
  it("maxDrawdown increases as equity falls", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, marginFactor: 0.1 });
    const openFill = makeOpenFill({ price: 1_000 });
    portfolio.openPositionFromFill(openFill, { stopLoss: 500, target: 2_000, attribution });

    portfolio.markToMarket(new Map([["NIFTY", 900]]));  // unrealised loss
    portfolio.snapshotEquity(2_000_000, 5);

    expect(portfolio.maxDrawdown).toBeGreaterThan(0);
  });

  it("currentDrawdown is 0 when equity is at peak", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000 });
    expect(portfolio.currentDrawdown).toBe(0);
  });
});

// ── Daily loss limit ──────────────────────────────────────────────────────────

describe("Daily loss limit", () => {
  it("isDailyLossLimitHit() is false when within limit", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, dailyLossLimitFraction: 0.02 });
    expect(portfolio.isDailyLossLimitHit()).toBe(false);
  });

  it("isDailyLossLimitHit() is true after daily loss exceeds 2%", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, dailyLossLimitFraction: 0.02 });
    portfolio.onSessionOpen(0);

    // Simulate a ₹2100 loss on a 100K portfolio (limit = ₹2000)
    const openFill = makeOpenFill({ price: 1_000 });
    const pos = portfolio.openPositionFromFill(openFill, { stopLoss: 900, target: 1_200, attribution });
    const closeFill = makeCloseFill({ price: 958, qty: 1, intent: "STOP_LOSS" }); // loss ≈ 2100
    portfolio.closePositionFromFill(pos.id, closeFill, "STOP");

    expect(portfolio.isDailyLossLimitHit()).toBe(true);
  });
});

// ── canAfford ─────────────────────────────────────────────────────────────────

describe("Portfolio.canAfford", () => {
  it("returns true when available margin covers the notional", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, marginFactor: 0.1 });
    expect(portfolio.canAfford(50_000)).toBe(true); // needs ₹5000 margin, have ₹100K
  });

  it("returns false when notional × marginFactor > availableCash", () => {
    const portfolio = new Portfolio({ initialCapital: 1_000, marginFactor: 0.1 });
    // Needs ₹5000 margin for ₹50K notional, only ₹1000 available
    expect(portfolio.canAfford(50_000)).toBe(false);
  });
});

// ── Equity curve snapshots ────────────────────────────────────────────────────

describe("Equity curve", () => {
  it("snapshotEquity appends one point per call", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000 });
    portfolio.snapshotEquity(1_000, 0);
    portfolio.snapshotEquity(2_000, 1);
    portfolio.snapshotEquity(3_000, 2);
    expect(portfolio.equityCurve()).toHaveLength(3);
  });

  it("equity curve reflects running P&L", () => {
    const portfolio = new Portfolio({ initialCapital: 100_000, marginFactor: 0.1 });
    portfolio.snapshotEquity(1_000, 0);
    const initial = portfolio.equityCurve()[0].equity;
    expect(initial).toBeCloseTo(100_000);
  });
});
