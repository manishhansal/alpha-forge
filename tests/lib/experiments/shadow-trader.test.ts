/**
 * shadow-trader.test.ts
 *
 * Covers:
 *   • No real orders generated (isReal always false)
 *   • No paper portfolio impact (shadow portfolio is isolated)
 *   • Signal ingestion: acted=false guard, max positions guard
 *   • P&L arithmetic: long profit, short profit, stop-hit, target-hit
 *   • Intra-bar SL/TP detection via bar high/low
 *   • Equity curve tracks correctly
 *   • Benchmark points stored
 *   • Audit log captures all events
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ShadowTrader } from "@/lib/experiments/shadow-trader";
import type { ExperimentSignal } from "@/lib/experiments/experiment-manager";

// ── Helpers ────────────────────────────────────────────────────────────────────

const EXP_ID = "exp_test_0001";
const ARM_ID = "control";

const STAMP = {
  strategyVersion: "strat-v1",
  modelVersion: "model-v1",
  featureVersion: "feat-v1",
  experimentId: EXP_ID,
};

function makeTrader(cfg: ConstructorParameters<typeof ShadowTrader>[2] = {}) {
  return new ShadowTrader(EXP_ID, ARM_ID, {
    initialCapital: 100_000,
    lotSize: 1,
    slippageFraction: 0,       // zero slippage for clean arithmetic
    commissionFraction: 0,     // zero commission for clean arithmetic
    maxOpenPositions: 5,
    intraBarChecks: true,
    ...cfg,
  });
}

function makeSignal(overrides: Partial<ExperimentSignal> = {}): ExperimentSignal {
  return {
    id: "sig_001",
    experimentId: EXP_ID,
    armId: ARM_ID,
    versionStamp: STAMP,
    timestampMs: 1_700_000_000_000,
    symbol: "NIFTY",
    direction: "LONG",
    entryPrice: 21_000,
    stopLoss: 20_800,
    target: 21_400,
    confidence: 0.8,
    riskReward: 2.0,
    mode: "SHADOW",
    acted: false,
    ...overrides,
  };
}

function makeTick(close: number, high?: number, low?: number, barIndex = 1) {
  return {
    timestampMs: 1_700_000_100_000 + barIndex * 60_000,
    symbol: "NIFTY",
    open: close - 10,
    high: high ?? close + 50,
    low: low ?? close - 50,
    close,
    volume: 50_000,
    barIndex,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ShadowTrader — no real orders, no portfolio impact", () => {
  it("every SimulatedFill has isReal=false", () => {
    const trader = makeTrader();
    const fill = trader.ingestSignal(makeSignal());
    expect(fill).not.toBeNull();
    expect(fill!.isReal).toBe(false);
  });

  it("initial portfolio state is isolated with initialCapital", () => {
    const trader = makeTrader({ initialCapital: 200_000 });
    const state = trader.portfolioState;
    expect(state.initialCapital).toBe(200_000);
    expect(state.cash).toBe(200_000);
    expect(state.realisedPnl).toBe(0);
    expect(state.unrealisedPnl).toBe(0);
  });

  it("rejects signals with acted=true (shadow isolation)", () => {
    const trader = makeTrader();
    const fill = trader.ingestSignal(makeSignal({ acted: true }));
    expect(fill).toBeNull();
    const log = trader.auditLog();
    expect(log.some((e) => e.detail.includes("acted=true"))).toBe(true);
  });

  it("rejects signals for wrong experimentId", () => {
    const trader = makeTrader();
    const fill = trader.ingestSignal(makeSignal({ experimentId: "wrong_exp" }));
    expect(fill).toBeNull();
  });

  it("rejects signals for wrong armId", () => {
    const trader = makeTrader();
    const fill = trader.ingestSignal(makeSignal({ armId: "wrong_arm" }));
    expect(fill).toBeNull();
  });
});

describe("ShadowTrader — P&L arithmetic (zero slippage, zero commission)", () => {
  it("long position: profit when exit > entry", () => {
    const trader = makeTrader();
    trader.ingestSignal(makeSignal({ direction: "LONG", entryPrice: 21_000 }));

    const positions = trader.openPositions();
    expect(positions).toHaveLength(1);

    // Close at 21_200 — profit = (21200 - 21000) * 1 * 1 = 200
    const trade = trader.closePosition(positions[0].id, 21_200, "MANUAL_CLOSE");
    expect(trade).not.toBeNull();
    expect(trade!.netPnl).toBeCloseTo(200, 1);
    expect(trade!.direction).toBe("LONG");
  });

  it("long position: loss when exit < entry", () => {
    const trader = makeTrader();
    trader.ingestSignal(makeSignal({ direction: "LONG", entryPrice: 21_000 }));
    const [pos] = trader.openPositions();
    const trade = trader.closePosition(pos.id, 20_900, "STOP_HIT");
    expect(trade!.netPnl).toBeCloseTo(-100, 1);
  });

  it("short position: profit when exit < entry", () => {
    const trader = makeTrader();
    trader.ingestSignal(
      makeSignal({ id: "sig_short", direction: "SHORT", entryPrice: 21_000, stopLoss: 21_200, target: 20_600 }),
    );
    const [pos] = trader.openPositions();
    // Close at 20_700 — profit = (21000 - 20700) * 1 * 1 = 300
    const trade = trader.closePosition(pos.id, 20_700, "TARGET_HIT");
    expect(trade!.netPnl).toBeCloseTo(300, 1);
  });

  it("short position: loss when exit > entry", () => {
    const trader = makeTrader();
    trader.ingestSignal(
      makeSignal({ id: "sig_sh2", direction: "SHORT", entryPrice: 21_000, stopLoss: 21_200, target: 20_600 }),
    );
    const [pos] = trader.openPositions();
    const trade = trader.closePosition(pos.id, 21_150, "STOP_HIT");
    expect(trade!.netPnl).toBeCloseTo(-150, 1);
  });

  it("realised P&L accumulates across multiple trades", () => {
    const trader = makeTrader();

    // Trade 1: +200
    trader.ingestSignal(makeSignal({ id: "s1", entryPrice: 21_000 }));
    trader.closePosition(trader.openPositions()[0].id, 21_200, "TARGET_HIT");

    // Trade 2: -100
    trader.ingestSignal(makeSignal({ id: "s2", entryPrice: 21_000 }));
    trader.closePosition(trader.openPositions()[0].id, 20_900, "STOP_HIT");

    expect(trader.portfolioState.realisedPnl).toBeCloseTo(100, 1);
  });
});

describe("ShadowTrader — intra-bar SL/TP via processTick", () => {
  it("closes LONG position when bar low hits stop loss", () => {
    const trader = makeTrader();
    trader.ingestSignal(makeSignal({ entryPrice: 21_000, stopLoss: 20_800, target: 21_400 }));

    // Bar where low = 20_799 triggers stop
    trader.processTick(makeTick(21_050, 21_100, 20_799));
    expect(trader.openPositions()).toHaveLength(0);
    const [trade] = trader.closedTrades();
    expect(trade.closeReason).toBe("STOP_HIT");
  });

  it("closes LONG position when bar high hits target", () => {
    const trader = makeTrader();
    trader.ingestSignal(makeSignal({ entryPrice: 21_000, stopLoss: 20_800, target: 21_400 }));

    // Bar where high = 21_400 triggers target
    trader.processTick(makeTick(21_050, 21_400, 20_990));
    expect(trader.openPositions()).toHaveLength(0);
    expect(trader.closedTrades()[0].closeReason).toBe("TARGET_HIT");
  });

  it("closes SHORT position when bar high hits stop", () => {
    const trader = makeTrader();
    trader.ingestSignal(
      makeSignal({ id: "sh", direction: "SHORT", entryPrice: 21_000, stopLoss: 21_200, target: 20_600 }),
    );
    trader.processTick(makeTick(20_950, 21_201, 20_900));
    expect(trader.openPositions()).toHaveLength(0);
    expect(trader.closedTrades()[0].closeReason).toBe("STOP_HIT");
  });

  it("closes SHORT position when bar low hits target", () => {
    const trader = makeTrader();
    trader.ingestSignal(
      makeSignal({ id: "sh2", direction: "SHORT", entryPrice: 21_000, stopLoss: 21_200, target: 20_600 }),
    );
    trader.processTick(makeTick(20_850, 21_050, 20_599));
    expect(trader.openPositions()).toHaveLength(0);
    expect(trader.closedTrades()[0].closeReason).toBe("TARGET_HIT");
  });

  it("does NOT close position when bar stays inside SL/TP range", () => {
    const trader = makeTrader();
    trader.ingestSignal(makeSignal({ entryPrice: 21_000, stopLoss: 20_800, target: 21_400 }));
    // Bar stays between stop and target
    trader.processTick(makeTick(21_050, 21_200, 20_900));
    expect(trader.openPositions()).toHaveLength(1);
    expect(trader.closedTrades()).toHaveLength(0);
  });
});

describe("ShadowTrader — position limits and guards", () => {
  it("enforces maxOpenPositions", () => {
    const trader = makeTrader({ maxOpenPositions: 2 });

    trader.ingestSignal(makeSignal({ id: "s1", symbol: "NIFTY" }));
    trader.ingestSignal(makeSignal({ id: "s2", symbol: "BNF" }));

    // Third signal should be skipped
    const fill3 = trader.ingestSignal(makeSignal({ id: "s3", symbol: "FIN" }));
    expect(fill3).toBeNull();
    expect(trader.openPositions()).toHaveLength(2);
  });

  it("rejects duplicate signal for same symbol", () => {
    const trader = makeTrader();
    trader.ingestSignal(makeSignal({ id: "s1", symbol: "NIFTY" }));
    const dup = trader.ingestSignal(makeSignal({ id: "s2", symbol: "NIFTY" }));
    expect(dup).toBeNull();
    expect(trader.openPositions()).toHaveLength(1);
  });
});

describe("ShadowTrader — equity curve and summary", () => {
  it("records equity curve points on each processTick", () => {
    const trader = makeTrader();
    trader.processTick(makeTick(21_000, 21_100, 20_900, 1));
    trader.processTick(makeTick(21_050, 21_150, 20_950, 2));
    trader.processTick(makeTick(21_100, 21_200, 21_000, 3));

    const curve = trader.equityCurve();
    expect(curve).toHaveLength(3);
    expect(curve[0].barIndex).toBe(1);
    expect(curve[2].barIndex).toBe(3);
    expect(curve.every((p) => p.equity === trader.portfolioState.initialCapital)).toBe(true); // no positions
  });

  it("summary reflects closed trade stats correctly", () => {
    const trader = makeTrader();

    // Two wins
    trader.ingestSignal(makeSignal({ id: "s1" }));
    trader.closePosition(trader.openPositions()[0].id, 21_200, "TARGET_HIT"); // +200

    trader.ingestSignal(makeSignal({ id: "s2" }));
    trader.closePosition(trader.openPositions()[0].id, 21_300, "TARGET_HIT"); // +300

    // One loss
    trader.ingestSignal(makeSignal({ id: "s3" }));
    trader.closePosition(trader.openPositions()[0].id, 20_900, "STOP_HIT"); // -100

    const s = trader.summary();
    expect(s.totalTrades).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(2 / 3, 5);
    expect(s.totalNetPnlINR).toBeCloseTo(400, 1);
    expect(s.profitFactor).toBeCloseTo(500 / 100, 5); // (200+300) / 100
  });

  it("closeAllPositions closes every open position", () => {
    const trader = makeTrader({ maxOpenPositions: 3 });
    trader.ingestSignal(makeSignal({ id: "s1", symbol: "NIFTY" }));
    trader.ingestSignal(makeSignal({ id: "s2", symbol: "BNF" }));

    expect(trader.openPositions()).toHaveLength(2);

    const priceMap = new Map([["NIFTY", 21_100], ["BNF", 45_200]]);
    const closed = trader.closeAllPositions(priceMap, "SESSION_END");

    expect(closed).toHaveLength(2);
    expect(trader.openPositions()).toHaveLength(0);
    expect(closed.every((t) => t.closeReason === "SESSION_END")).toBe(true);
  });
});

describe("ShadowTrader — benchmark tracking", () => {
  it("stores benchmark points and returns them", () => {
    const trader = makeTrader();
    trader.updateBenchmark(21_000, "NIFTY50", 1_700_000_000_000);
    trader.updateBenchmark(21_050, "NIFTY50", 1_700_000_060_000);

    const bps = trader.benchmarkPoints();
    expect(bps).toHaveLength(2);
    expect(bps[0].source).toBe("NIFTY50");
    expect(bps[0].value).toBe(21_000);
  });
});

describe("ShadowTrader — audit log", () => {
  it("records SIGNAL_RECEIVED and FILL_SIMULATED for every accepted signal", () => {
    const trader = makeTrader();
    trader.ingestSignal(makeSignal());

    const log = trader.auditLog();
    expect(log.some((e) => e.type === "SIGNAL_RECEIVED")).toBe(true);
    expect(log.some((e) => e.type === "POSITION_OPENED")).toBe(true);
    expect(log.some((e) => e.type === "FILL_SIMULATED")).toBe(true);

    // Verify isReal=false is in the fill audit entry
    const fillEntry = log.find((e) => e.type === "FILL_SIMULATED");
    expect(fillEntry?.payload?.isReal).toBe(false);
  });

  it("records POSITION_CLOSED when trade is closed", () => {
    const trader = makeTrader();
    trader.ingestSignal(makeSignal());
    trader.closePosition(trader.openPositions()[0].id, 21_200, "TARGET_HIT");

    const log = trader.auditLog();
    expect(log.some((e) => e.type === "POSITION_CLOSED")).toBe(true);
  });
});
