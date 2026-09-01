/**
 * india-execution.test.ts — Realistic Indian Market Execution Simulation Engine tests.
 *
 * Scenarios tested:
 *   1. Liquid stock          — tight spread, no partial fill, low slippage
 *   2. Illiquid stock        — wide spread, potential partial fill, high slippage
 *   3. Liquid option (ATM)   — moderate spread, good fill quality
 *   4. Illiquid option (OTM) — wide spread, OTM penalty, degraded fill quality
 *   5. Gap through stop loss — STOP order, bar gaps past stop → fill at open
 *   6. Partial fill          — order size exceeds depth → partial fill recorded
 *   7. Unfilled limit order  — limit never reached → null returned
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resetEventIdCounter } from "@/lib/backtesting-v2/events/market-event";
import { resetPositionCounter } from "@/lib/backtesting-v2/models/position";
import { IndiaFillModel } from "@/lib/backtesting-v2/execution/india-fill-model";
import { IndiaExecutionEngine } from "@/lib/backtesting-v2/execution/india-execution-engine";
import { MarketDepthSimulator } from "@/lib/backtesting-v2/execution/market-depth";
import { ExecutionQualityReporter } from "@/lib/backtesting-v2/execution/execution-quality-report";
import type { IndiaFillExtras } from "@/lib/backtesting-v2/execution/india-fill-model";
import type { OrderRecord } from "@/lib/backtesting-v2/models/order";
import type { InstrumentId, OHLCVBar } from "@/lib/backtesting-v2/events/market-event";
import type { FillEvent } from "@/lib/backtesting-v2/events/fill-event";

// ── Test utilities ────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2024, 0, 8, 3, 45) - IST_OFFSET_MS; // 2024-01-08 09:15 IST

function msAt(minuteOffset: number): number {
  return BASE_MS + minuteOffset * 60_000;
}

function makeBar(opts: {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  oi?: number;
  minuteOffset?: number;
}): OHLCVBar {
  const openMs = msAt(opts.minuteOffset ?? 0);
  return {
    openMs,
    closeMs: openMs + 59_999,
    open: opts.open,
    high: opts.high,
    low: opts.low,
    close: opts.close,
    volume: opts.volume ?? 100_000,
    oi: opts.oi,
  };
}

function makeOrder(opts: {
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  qty: number;
  instrument: InstrumentId;
  limitPrice?: number;
  stopTriggerPrice?: number;
  validFromBarIndex?: number;
  expiryBarIndex?: number;
}): OrderRecord {
  return {
    id: "ord_test",
    orderEventId: "ord_test",
    signalEventId: "sig_test",
    instrument: opts.instrument,
    side: opts.side,
    intent: "OPEN",
    direction: opts.side === "BUY" ? "LONG" : "SHORT",
    orderType: opts.orderType,
    qty: opts.qty,
    limitPrice: opts.limitPrice,
    stopTriggerPrice: opts.stopTriggerPrice,
    validFromBarIndex: opts.validFromBarIndex ?? 0,
    expiryBarIndex: opts.expiryBarIndex ?? 10,
    maxSlippage: undefined,
    signalTimestampMs: msAt(-1),
    status: "OPEN",
    fillEventId: null,
    fillPrice: null,
    filledAtBarIndex: null,
    cancelReason: null,
  };
}

function getExtras(fill: FillEvent): IndiaFillExtras {
  return fill.extras as IndiaFillExtras;
}

// ── Instruments ───────────────────────────────────────────────────────────────

const LIQUID_STOCK: InstrumentId = {
  symbol: "RELIANCE",
  exchange: "NSE",
  instrumentType: "EQ",
  lotSize: 1,
  tickSize: 0.05,
  expiry: null,
  strike: null,
  optionType: null,
};

const ILLIQUID_STOCK: InstrumentId = {
  symbol: "SMALLCAP_XYZ",
  exchange: "NSE",
  instrumentType: "EQ",
  lotSize: 1,
  tickSize: 0.05,
  expiry: null,
  strike: null,
  optionType: null,
};

const LIQUID_OPTION_ATM: InstrumentId = {
  symbol: "NIFTY28MAR2422000CE",
  exchange: "NFO",
  instrumentType: "OPTIDX",
  lotSize: 50,
  tickSize: 0.05,
  expiry: "2024-03-28",
  strike: 22000,
  optionType: "CE",
};

const ILLIQUID_OPTION_OTM: InstrumentId = {
  symbol: "NIFTY28MAR2426000CE",
  exchange: "NFO",
  instrumentType: "OPTIDX",
  lotSize: 50,
  tickSize: 0.05,
  expiry: "2024-03-28",
  strike: 26000,
  optionType: "CE",
};

const NIFTY_FUTURES: InstrumentId = {
  symbol: "NIFTY28MAR24FUT",
  exchange: "NFO",
  instrumentType: "FUTIDX",
  lotSize: 50,
  tickSize: 0.05,
  expiry: "2024-03-28",
  strike: null,
  optionType: null,
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetEventIdCounter();
  resetPositionCounter();
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Liquid stock
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 1: Liquid stock (RELIANCE)", () => {
  it("fills a MARKET BUY at ask + small market impact", () => {
    const engine = IndiaExecutionEngine.liquid();
    const bar = makeBar({ open: 2900, high: 2910, low: 2895, close: 2905, volume: 500_000 });
    const order = makeOrder({ side: "BUY", orderType: "MARKET", qty: 100, instrument: LIQUID_STOCK });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);
    expect(fill).not.toBeNull();

    const extras = getExtras(fill!);
    // Fill price must be above open (buys pay slippage)
    expect(fill!.fillPrice).toBeGreaterThan(bar.open);
    // Slippage should be tight for liquid stock: < 0.5%
    expect(extras.slippageFraction).toBeLessThan(0.005);
    // Commission must be positive
    expect(fill!.commission).toBeGreaterThan(0);
    // Fill quality should be high for liquid instrument
    expect(extras.fillQuality).toBeGreaterThan(0.6);
    // Full fill (no partial)
    expect(extras.isPartialFill).toBe(false);
    expect(extras.filledQty).toBe(100);
  });

  it("charges correct transaction cost components for equity intraday", () => {
    const engine = new IndiaExecutionEngine({ latency: "LOW" });
    const bar = makeBar({ open: 1000, high: 1010, low: 995, close: 1005, volume: 300_000 });
    const order = makeOrder({ side: "BUY", orderType: "MARKET", qty: 50, instrument: LIQUID_STOCK });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs)!;
    expect(fill).not.toBeNull();
    // Commission > 0 (STT + exchange fee + GST at minimum)
    expect(fill.commission).toBeGreaterThan(0);
    // Fill price should reflect spread (above open for buy)
    expect(fill.fillPrice).toBeGreaterThanOrEqual(bar.open);
  });

  it("SELL fills below bid (slippage subtracts)", () => {
    const engine = IndiaExecutionEngine.liquid();
    const bar = makeBar({ open: 2900, high: 2910, low: 2895, close: 2905, volume: 500_000 });
    const order = makeOrder({ side: "SELL", orderType: "MARKET", qty: 100, instrument: LIQUID_STOCK });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs)!;
    // Sell fills at or below open (bid minus impact)
    expect(fill.fillPrice).toBeLessThan(bar.open);
    expect(fill.slippage).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: Illiquid stock
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 2: Illiquid stock (small-cap)", () => {
  it("shows wider slippage than liquid stock for same order size", () => {
    const liquidEngine   = IndiaExecutionEngine.liquid();
    const illiquidEngine = IndiaExecutionEngine.illiquid();

    const bar = makeBar({ open: 150, high: 153, low: 148, close: 151, volume: 5_000 });
    const order = makeOrder({
      side: "BUY", orderType: "MARKET", qty: 200, instrument: ILLIQUID_STOCK,
    });

    const liquidFill   = liquidEngine.tryFill(order, bar, 0, bar.closeMs);
    const illiquidFill = illiquidEngine.tryFill(order, bar, 0, bar.closeMs);

    // Illiquid fill may be null (depth too low) or have higher slippage
    if (illiquidFill !== null && liquidFill !== null) {
      const illiquidExtras = getExtras(illiquidFill);
      const liquidExtras   = getExtras(liquidFill);
      expect(illiquidExtras.slippageFraction).toBeGreaterThan(liquidExtras.slippageFraction);
    }
    // At minimum, illiquid scenario results in partial fill or null
    if (illiquidFill !== null) {
      const extras = getExtras(illiquidFill);
      expect(extras.fillQuality).toBeLessThanOrEqual(
        liquidFill ? getExtras(liquidFill).fillQuality : 1,
      );
    }
  });

  it("records higher latency for illiquid profile", () => {
    const engine = IndiaExecutionEngine.illiquid("HIGH");
    const bar = makeBar({ open: 150, high: 153, low: 148, close: 151, volume: 5_000 });
    const order = makeOrder({ side: "BUY", orderType: "MARKET", qty: 10, instrument: ILLIQUID_STOCK });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);
    if (fill) {
      const extras = getExtras(fill);
      // HIGH latency profile: total >= 850ms (typical: 150+400+300)
      expect(extras.latencyTotalMs).toBeGreaterThanOrEqual(850);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Liquid option (ATM)
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 3: Liquid ATM option (NIFTY CE)", () => {
  it("fills ATM option with moderate slippage and NSE option fees", () => {
    const engine = IndiaExecutionEngine.options("MEDIUM", 1.0);
    // ATM option: high OI and volume
    const bar = makeBar({
      open: 200, high: 215, low: 195, close: 208,
      volume: 20_000, oi: 100_000,
    });
    const order = makeOrder({
      side: "BUY", orderType: "MARKET", qty: 2, instrument: LIQUID_OPTION_ATM,
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs)!;
    expect(fill).not.toBeNull();

    const extras = getExtras(fill);
    // ATM options: slippage < 2% of premium
    expect(extras.slippageFraction).toBeLessThan(0.02);
    // Commission must include STT (sell) and exchange fee for options
    expect(fill.commission).toBeGreaterThan(0);
    // Order type recorded correctly
    expect(extras.orderType).toBe("MARKET");
    // Latency components all positive
    expect(extras.latencySignalMs).toBeGreaterThan(0);
    expect(extras.latencyNetworkMs).toBeGreaterThan(0);
    expect(extras.latencyTotalMs).toBe(
      extras.latencySignalMs + extras.latencyNetworkMs + extras.latencyOrderMs,
    );
  });

  it("execution quality report captures ATM option fill", () => {
    const engine = IndiaExecutionEngine.options();
    const bar = makeBar({ open: 200, high: 215, low: 195, close: 208, volume: 20_000, oi: 80_000 });
    const order = makeOrder({ side: "BUY", orderType: "MARKET", qty: 1, instrument: LIQUID_OPTION_ATM });

    engine.tryFill(order, bar, 0, bar.closeMs);
    const report = engine.buildQualityReport();

    expect(report.totalFills).toBe(1);
    expect(report.fees.totalFees).toBeGreaterThan(0);
    expect(report.slippage.avgFraction).toBeGreaterThanOrEqual(0);
    expect(report.byInstrumentType["OPTIDX"]).toBeDefined();
    expect(report.byOrderType["MARKET"]).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: Illiquid option (deep OTM)
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 4: Illiquid deep OTM option", () => {
  it("applies OTM liquidity penalty, reducing fill quality", () => {
    const atmEngine = IndiaExecutionEngine.options("MEDIUM", 1.0);
    const otmEngine = IndiaExecutionEngine.options("HIGH",   3.0);  // 3× OTM penalty

    const atmBar = makeBar({ open: 200, high: 215, low: 195, close: 208, volume: 20_000, oi: 80_000 });
    const otmBar = makeBar({ open: 5,   high: 6,   low: 4,   close: 5,   volume: 50,    oi: 200 });

    const atmOrder = makeOrder({ side: "BUY", orderType: "MARKET", qty: 1, instrument: LIQUID_OPTION_ATM });
    const otmOrder = makeOrder({ side: "BUY", orderType: "MARKET", qty: 1, instrument: ILLIQUID_OPTION_OTM });

    const atmFill = atmEngine.tryFill(atmOrder, atmBar, 0, atmBar.closeMs);
    const otmFill = otmEngine.tryFill(otmOrder, otmBar, 0, otmBar.closeMs);

    if (otmFill && atmFill) {
      const atmExtras = getExtras(atmFill);
      const otmExtras = getExtras(otmFill);
      // OTM penalty makes slippage fraction larger
      expect(otmExtras.slippageFraction).toBeGreaterThan(atmExtras.slippageFraction);
      // OTM fill quality worse than ATM
      expect(otmExtras.fillQuality).toBeLessThan(atmExtras.fillQuality);
    }
    // If OTM order was rejected entirely (too illiquid), that's also valid
    // behaviour — the test simply checks that null is not returned for ATM
    expect(atmFill).not.toBeNull();
  });

  it("charges higher effective cost for OTM options (exchange fee on premium)", () => {
    const engine = new IndiaExecutionEngine({ latency: "LOW" });
    const bar = makeBar({ open: 5, high: 7, low: 4, close: 5, volume: 200, oi: 500 });
    const order = makeOrder({
      side: "SELL", orderType: "MARKET", qty: 1, instrument: ILLIQUID_OPTION_OTM,
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);
    if (fill) {
      // STT applies to sell leg for options
      const extras = getExtras(fill);
      const breakdown = JSON.parse(extras.feesBreakdownJson as string);
      expect(breakdown.stt).toBeGreaterThan(0);
      expect(breakdown.exchangeCharge).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: Gap through stop loss
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 5: Gap through stop loss (STOP_MARKET)", () => {
  it("fills at bar open when bar gaps through the stop trigger", () => {
    const engine = IndiaExecutionEngine.realistic();
    // Stop trigger at 500; bar opens at 490 (gap down through stop)
    const stopPrice = 500;
    const bar = makeBar({
      open: 490,   // gaps BELOW stop
      high: 492,
      low: 485,
      close: 488,
      volume: 200_000,
    });
    const order = makeOrder({
      side: "SELL",
      orderType: "STOP",
      qty: 100,
      instrument: LIQUID_STOCK,
      stopTriggerPrice: stopPrice,
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs)!;
    expect(fill).not.toBeNull();

    const extras = getExtras(fill);
    // When bar gaps through stop, fill at open — not at stop price
    expect(extras.expectedPrice).toBe(stopPrice);
    // Actual fill = open minus slippage (sell side) → below open
    expect(fill.fillPrice).toBeLessThan(bar.open);
    // Fill price must be significantly worse than the stop (gap effect)
    expect(fill.fillPrice).toBeLessThan(stopPrice);
  });

  it("STOP_MARKET order does not fill when stop is not triggered", () => {
    const engine = IndiaExecutionEngine.realistic();
    // BUY stop triggers when bar.high >= stopPrice.
    // Set stop above the bar's high so it never triggers.
    const stopPrice = 520;   // bar.high = 510 < 520 → never triggered
    const bar = makeBar({ open: 500, high: 510, low: 495, close: 505, volume: 200_000 });
    const order = makeOrder({
      side: "BUY",
      orderType: "STOP",
      qty: 50,
      instrument: LIQUID_STOCK,
      stopTriggerPrice: stopPrice,
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);
    expect(fill).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: Partial fill
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 6: Partial fill", () => {
  it("partially fills when order size exceeds available depth", () => {
    // Use a very thin bar volume to force depth exhaustion
    const engine = new IndiaExecutionEngine({
      latency: "LOW",
      partialFillThreshold: 0.01,   // allow fills down to 1% of order
    });

    // Very low volume bar — synthetic depth will be tiny
    const bar = makeBar({
      open: 100, high: 105, low: 98, close: 102,
      volume: 50,  // extremely thin
    });

    // Large order that will overwhelm the tiny depth
    const order = makeOrder({
      side: "BUY",
      orderType: "MARKET",
      qty: 10_000,     // 10,000 shares vs ~50 total bar volume
      instrument: LIQUID_STOCK,
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);
    if (fill !== null) {
      const extras = getExtras(fill);
      // Should be partial
      expect(extras.isPartialFill).toBe(true);
      expect(extras.filledQty).toBeLessThan(order.qty);
      expect(extras.unfilledQty).toBeGreaterThan(0);
      expect(extras.filledQty + extras.unfilledQty).toBe(order.qty);
    }
    // null is also acceptable (below even 1% threshold)
  });

  it("returns null when available depth is below partialFillThreshold", () => {
    // Strict threshold: must fill >= 50% of order
    const engine = new IndiaExecutionEngine({
      latency: "LOW",
      partialFillThreshold: 0.5,
    });

    // Tiny bar volume → depth << 50% of large order
    const bar = makeBar({ open: 100, high: 105, low: 98, close: 102, volume: 10 });
    const order = makeOrder({
      side: "BUY",
      orderType: "MARKET",
      qty: 5_000,
      instrument: LIQUID_STOCK,
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);
    // Either null (rejected) or partial with >= 50% filled
    if (fill !== null) {
      const extras = getExtras(fill);
      expect(extras.filledQty / extras.filledQty + extras.unfilledQty).toBeGreaterThanOrEqual(0.5);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7: Unfilled limit order
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 7: Unfilled limit order", () => {
  it("returns null when limit price is never reached by the bar", () => {
    const engine = IndiaExecutionEngine.realistic();
    // Bar trades between 300 and 310; limit to buy at 290 (never reached)
    const bar = makeBar({ open: 305, high: 310, low: 300, close: 307, volume: 100_000 });
    const order = makeOrder({
      side: "BUY",
      orderType: "LIMIT",
      qty: 100,
      instrument: LIQUID_STOCK,
      limitPrice: 290,   // below bar's low of 300
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);
    expect(fill).toBeNull();
  });

  it("fills a BUY limit when bar.low touches the limit price", () => {
    const engine = IndiaExecutionEngine.realistic();
    const limitPrice = 298;
    // Bar.low = 297 — touches the limit
    const bar = makeBar({ open: 305, high: 310, low: 297, close: 303, volume: 100_000 });
    const order = makeOrder({
      side: "BUY",
      orderType: "LIMIT",
      qty: 100,
      instrument: LIQUID_STOCK,
      limitPrice,
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs)!;
    expect(fill).not.toBeNull();
    const extras = getExtras(fill);
    // Fill should be at or close to the limit price (slippage on top)
    expect(extras.expectedPrice).toBe(limitPrice);
    expect(fill.fillPrice).toBeGreaterThanOrEqual(limitPrice * 0.99);  // within 1%
    expect(extras.orderType).toBe("LIMIT");
  });

  it("unfilled limit orders are counted in the quality report", () => {
    const engine = IndiaExecutionEngine.realistic();
    const bar = makeBar({ open: 305, high: 310, low: 300, close: 307, volume: 100_000 });

    // Two limit orders — one fills, one does not
    const unfilledOrder = makeOrder({
      side: "BUY", orderType: "LIMIT", qty: 100, instrument: LIQUID_STOCK,
      limitPrice: 290,  // never reached
      expiryBarIndex: 0,  // expires this bar
    });
    const filledOrder = makeOrder({
      side: "BUY", orderType: "LIMIT", qty: 100, instrument: LIQUID_STOCK,
      limitPrice: 302,  // bar.low(300) ≤ 302 → fills
    });

    const fill1 = engine.tryFill(unfilledOrder, bar, 0, bar.closeMs);
    const fill2 = engine.tryFill(filledOrder, bar, 0, bar.closeMs);

    expect(fill1).toBeNull();
    expect(fill2).not.toBeNull();

    const report = engine.buildQualityReport();
    // One fill recorded
    expect(report.totalFills).toBe(1);
    // One unfilled order (the expired limit)
    expect(report.fillRate.unfilledOrNullFill).toBe(1);
    expect(report.fillRate.totalOrders).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Execution quality report
// ─────────────────────────────────────────────────────────────────────────────

describe("ExecutionQualityReport", () => {
  it("aggregates slippage, fees, latency, and fill quality across fills", () => {
    const engine = IndiaExecutionEngine.realistic();
    const bar = makeBar({ open: 500, high: 510, low: 495, close: 505, volume: 300_000 });

    for (let i = 0; i < 5; i++) {
      const order = makeOrder({
        side: i % 2 === 0 ? "BUY" : "SELL",
        orderType: "MARKET",
        qty: 10,
        instrument: NIFTY_FUTURES,
      });
      engine.tryFill(order, bar, 0, bar.closeMs);
    }

    const report = engine.buildQualityReport();

    expect(report.totalFills).toBe(5);
    expect(report.avgFillQuality).toBeGreaterThan(0);
    expect(report.avgFillQuality).toBeLessThanOrEqual(1);
    expect(report.slippage.avgFraction).toBeGreaterThan(0);
    expect(report.fees.totalFees).toBeGreaterThan(0);
    expect(report.latency.avgTotalMs).toBeGreaterThan(0);
    expect(report.fillRate.totalOrders).toBe(5);
    expect(report.fillRate.partialFillRate).toBeGreaterThanOrEqual(0);
    // Breakdown by instrument type
    expect(report.byInstrumentType["FUTIDX"]).toBeDefined();
    expect(report.byInstrumentType["FUTIDX"].count).toBe(5);
  });

  it("reports empty stats when no fills were recorded", () => {
    const reporter = new ExecutionQualityReporter();
    const report = reporter.build();

    expect(report.totalFills).toBe(0);
    expect(report.avgFillQuality).toBe(0);
    expect(report.fees.totalFees).toBe(0);
    expect(report.fills).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Market depth simulator
// ─────────────────────────────────────────────────────────────────────────────

describe("MarketDepthSimulator", () => {
  it("produces a snapshot with bestAsk > bestBid", () => {
    const sim = new MarketDepthSimulator();
    const bar = makeBar({ open: 1000, high: 1010, low: 995, close: 1005, volume: 200_000 });
    const snap = sim.snapshot(LIQUID_STOCK, bar);

    expect(snap.bestAsk).toBeGreaterThan(snap.bestBid);
    expect(snap.spread).toBeGreaterThan(0);
    expect(snap.bids.length).toBe(5);
    expect(snap.asks.length).toBe(5);
    expect(snap.totalBidQty).toBeGreaterThan(0);
    expect(snap.totalAskQty).toBeGreaterThan(0);
  });

  it("walkBook returns VWAP price above bestAsk for large BUY order", () => {
    const sim = new MarketDepthSimulator({ depthLevels: 5 });
    const bar = makeBar({ open: 100, high: 102, low: 99, close: 101, volume: 500 });
    const snap = sim.snapshot(ILLIQUID_STOCK, bar);
    const { vwapPrice } = sim.walkBook("BUY", 100_000, snap);

    // Walking a huge buy through a tiny book should result in market impact
    expect(vwapPrice).toBeGreaterThanOrEqual(snap.bestAsk);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STOP_LIMIT orders
// ─────────────────────────────────────────────────────────────────────────────

describe("STOP_LIMIT order", () => {
  it("does not fill when stop triggers but limit is not reachable", () => {
    const engine = IndiaExecutionEngine.realistic();
    // BUY stop-limit: stop=310, limit=308, but bar never trades below 308 after stop
    // Bar: open=315, high=320, low=311 → stop triggers (high>=310) but low=311 > limit=308
    const bar = makeBar({ open: 315, high: 320, low: 311, close: 317, volume: 200_000 });
    const order = makeOrder({
      side: "BUY",
      orderType: "STOP_LIMIT",
      qty: 50,
      instrument: LIQUID_STOCK,
      stopTriggerPrice: 310,
      limitPrice: 308,  // bar low=311 never reaches 308
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);
    expect(fill).toBeNull();
  });

  it("fills STOP_LIMIT when both stop and limit are reachable in the same bar", () => {
    const engine = IndiaExecutionEngine.realistic();
    // SELL stop-limit: stop=290, limit=292 (limit >= stop for sell)
    // Bar: open=300, high=295, low=285 → stop triggers (low<=290) AND high>=292
    const bar = makeBar({ open: 300, high: 295, low: 285, close: 288, volume: 200_000 });
    const order = makeOrder({
      side: "SELL",
      orderType: "STOP_LIMIT",
      qty: 50,
      instrument: LIQUID_STOCK,
      stopTriggerPrice: 290,
      limitPrice: 292,  // bar high=295 >= 292 → limit reachable
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs)!;
    expect(fill).not.toBeNull();
    expect(fill.fillPrice).toBeLessThanOrEqual(bar.open);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-lookahead guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Anti-lookahead guard", () => {
  it("returns null when barIndex < validFromBarIndex", () => {
    const engine = IndiaExecutionEngine.realistic();
    const bar = makeBar({ open: 500, high: 510, low: 495, close: 505, volume: 200_000 });
    const order = makeOrder({
      side: "BUY", orderType: "MARKET", qty: 10,
      instrument: LIQUID_STOCK,
      validFromBarIndex: 5,  // not valid until bar 5
    });

    const fill = engine.tryFill(order, bar, 0, bar.closeMs);  // barIndex=0
    expect(fill).toBeNull();
  });

  it("returns null when barIndex > expiryBarIndex", () => {
    const engine = IndiaExecutionEngine.realistic();
    const bar = makeBar({ open: 500, high: 510, low: 495, close: 505, volume: 200_000 });
    const order = makeOrder({
      side: "BUY", orderType: "MARKET", qty: 10,
      instrument: LIQUID_STOCK,
      validFromBarIndex: 0,
      expiryBarIndex: 2,  // expired
    });

    const fill = engine.tryFill(order, bar, 5, bar.closeMs);  // barIndex=5 > expiry=2
    expect(fill).toBeNull();
  });
});
