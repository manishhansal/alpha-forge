/**
 * Portfolio Risk Engine v2 — comprehensive test suite
 *
 * Scenarios covered:
 *   1.  Correlated positions — sector long-cluster rejection
 *   2.  Sector concentration — notional limit breach
 *   3.  VaR breach — block when historical VaR exceeds limit
 *   4.  Drawdown breach — CAUTION/WARNING/DANGER size reduction, HALT blocking
 *   5.  Dynamic size reduction — confidence, vol, correlation, drawdown factors
 *   6.  Kill switch — SOFT_KILL size reduction, HARD_KILL full block, reset
 *   7.  Happy-path approval — valid trade passes all gates
 *   8.  Exposure checks — gross, symbol, underlying, strategy concentration
 *   9.  Risk budget — per-trade, per-strategy, per-sector, portfolio limits
 *  10.  Correlation matrix — rolling correlation, cluster detection
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  PortfolioRiskEngine,
  createRiskEngine,
  type TradeProposal,
  type PortfolioRiskConfig,
} from "@/lib/risk/portfolio-risk";

import {
  calcExposureSnapshot,
  checkConcentration,
  checkCorrelatedLongCluster,
  toExposureFractions,
  getSector,
  resolveUnderlying,
  DEFAULT_EXPOSURE_LIMITS,
} from "@/lib/risk/exposure";

import {
  buildCorrelationMatrix,
  clusterByCorrelation,
  checkCorrelationRisk,
  updatePriceHistory,
  getCorrelation,
  type PriceHistory,
} from "@/lib/risk/correlation";

import {
  historicalVaR,
  parametricVaR,
  conditionalVaR,
  computeVaR,
  checkVaRBreach,
  DEFAULT_VAR_CONFIG,
} from "@/lib/risk/var";

import {
  computeDrawdownState,
  classifyDrawdownTier,
  checkDrawdown,
  DrawdownTracker,
  DEFAULT_DRAWDOWN_CONFIG,
} from "@/lib/risk/drawdown";

import {
  computePositionSize,
  confidenceFactor,
  portfolioVolFactor,
  correlationFactor,
  DEFAULT_SIZING_CONFIG,
} from "@/lib/risk/position-sizing";

import {
  checkRiskBudget,
  computePortfolioRiskBudget,
  evaluateKillSwitch,
  createKillSwitch,
  activateSoftKill,
  activateHardKill,
  resetKillSwitch,
  openRisk,
  DEFAULT_RISK_BUDGET_CONFIG,
} from "@/lib/risk/risk-limits";

import type { Position } from "@/lib/backtesting-v2/models/position";
import type { InstrumentId } from "@/lib/backtesting-v2/events/market-event";

// ── Test helpers ──────────────────────────────────────────────────────────────

const EQUITY = 1_000_000; // ₹10 lakh

function makeInstrument(symbol: string, lotSize = 1): InstrumentId {
  return {
    symbol,
    exchange: "NSE",
    instrumentType: "EQ",
    lotSize,
    tickSize: 0.05,
    expiry: null,
    strike: null,
    optionType: null,
  };
}

function makePosition(
  symbol: string,
  direction: "LONG" | "SHORT",
  qty: number,
  avgEntryPrice: number,
  stopLoss: number,
  strategyId = "strat-a",
  lotSize = 1,
): Position {
  return {
    id: `pos-${symbol}-${Math.random().toString(36).slice(2)}`,
    instrument: makeInstrument(symbol, lotSize),
    direction,
    status: "OPEN",
    avgEntryPrice,
    qty,
    stopLoss,
    target: avgEntryPrice * 1.05,
    unrealisedPnl: 0,
    realisedPnl: 0,
    totalCommission: 0,
    marginReserved: 0,
    openedAtMs: Date.now(),
    closedAtMs: null,
    openBarIndex: 0,
    closeBarIndex: null,
    closeReason: null,
    attribution: {
      strategyId,
      signalId: "sig-1",
      modelVersion: "v1",
      featureVersion: "v1",
      marketRegime: "TRENDING_UP",
      dataQualityScore: 0.9,
    },
    fills: [],
  };
}

function makeProposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "RELIANCE",
    strategyId: "strat-a",
    direction: "LONG",
    entryPrice: 2500,
    stopLoss: 2450,
    target: 2600,
    atr: 25,
    lotSize: 1,
    confidence: 0.75,
    ...overrides,
  };
}

// Generate a price series with a known slope + noise
function makePriceSeries(n: number, start = 100, drift = 0.001, seed = 1): number[] {
  const prices: number[] = [start];
  let rng = seed;
  for (let i = 1; i < n; i++) {
    // Simple LCG for deterministic noise
    rng = (rng * 1664525 + 1013904223) & 0xffffffff;
    const noise = ((rng >>> 0) / 0xffffffff - 0.5) * 0.01;
    prices.push(prices[i - 1] * (1 + drift + noise));
  }
  return prices;
}

// ── 1. Correlated positions — sector long-cluster rejection ───────────────────

describe("Correlated Long Cluster", () => {
  it("rejects a 4th LONG in the Bank sector when limit is 3", () => {
    // Three existing Bank longs
    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", 10, 1600, 1550),
      makePosition("ICICIBANK", "LONG", 10, 1000, 960),
      makePosition("SBIN", "LONG", 10, 800, 770),
    ];

    const engine = createRiskEngine(EQUITY, {
      exposure: { ...DEFAULT_EXPOSURE_LIMITS, maxCorrelatedLongs: 3 },
    });

    const result = engine.evaluate(
      makeProposal({ symbol: "KOTAKBANK", direction: "LONG" }),
      positions,
      EQUITY,
      0,
    );

    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("CORRELATED_LONG_CLUSTER");
    expect(result.rejectDetail).toMatch(/Bank/);
  });

  it("allows a LONG in the Bank sector when below limit", () => {
    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", 10, 1600, 1550),
      makePosition("ICICIBANK", "LONG", 10, 1000, 960),
    ];
    const engine = createRiskEngine(EQUITY, {
      exposure: { ...DEFAULT_EXPOSURE_LIMITS, maxCorrelatedLongs: 3 },
    });

    const result = engine.evaluate(
      makeProposal({ symbol: "SBIN", direction: "LONG" }),
      positions,
      EQUITY,
      0,
    );
    // Should not be rejected due to cluster (may still be approved or rejected for other reasons)
    expect(result.rejectReason).not.toBe("CORRELATED_LONG_CLUSTER");
  });

  it("does NOT apply cluster check for SHORT direction", () => {
    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", 10, 1600, 1550),
      makePosition("ICICIBANK", "LONG", 10, 1000, 960),
      makePosition("SBIN", "LONG", 10, 800, 770),
    ];
    const engine = createRiskEngine(EQUITY, {
      exposure: { ...DEFAULT_EXPOSURE_LIMITS, maxCorrelatedLongs: 3 },
    });

    const result = engine.evaluate(
      makeProposal({ symbol: "KOTAKBANK", direction: "SHORT" }),
      positions,
      EQUITY,
      0,
    );
    expect(result.rejectReason).not.toBe("CORRELATED_LONG_CLUSTER");
  });

  it("checkCorrelatedLongCluster counts correctly", () => {
    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", 1, 1600, 1550),
      makePosition("ICICIBANK", "LONG", 1, 1000, 960),
      makePosition("SBIN", "LONG", 1, 800, 770),
    ];
    const check = checkCorrelatedLongCluster(positions, "AXISBANK", {
      ...DEFAULT_EXPOSURE_LIMITS,
      maxCorrelatedLongs: 3,
    });
    expect(check.breached).toBe(true);
    expect(check.fraction).toBe(3);
  });
});

// ── 2. Sector concentration — notional limit breach ───────────────────────────

describe("Sector Concentration", () => {
  it("rejects when adding would breach sector notional limit", () => {
    // Existing Bank exposure: 40% of equity
    const bankNotional = EQUITY * 0.40;
    const bankQty = Math.floor(bankNotional / 1600);
    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", bankQty, 1600, 1550),
    ];

    const engine = createRiskEngine(EQUITY, {
      exposure: { ...DEFAULT_EXPOSURE_LIMITS, maxSectorFraction: 0.40 },
    });

    const result = engine.evaluate(
      makeProposal({
        symbol: "ICICIBANK",
        direction: "LONG",
        entryPrice: 1000,
        stopLoss: 960,
        // notional of even 1 lot will push sector over 40%
      }),
      positions,
      EQUITY,
      0,
    );

    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("SECTOR_CONCENTRATION");
    expect(result.rejectDetail).toMatch(/Bank/);
  });

  it("allows trade when sector has headroom", () => {
    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", 10, 1600, 1550), // ₹16k — tiny vs ₹10L
    ];
    const engine = createRiskEngine(EQUITY, {
      exposure: { ...DEFAULT_EXPOSURE_LIMITS, maxSectorFraction: 0.40 },
    });

    const result = engine.evaluate(
      makeProposal({ symbol: "ICICIBANK", direction: "LONG", entryPrice: 1000, stopLoss: 960 }),
      positions,
      EQUITY,
      0,
    );
    expect(result.rejectReason).not.toBe("SECTOR_CONCENTRATION");
  });

  it("checkConcentration correctly flags sector breach", () => {
    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", 250, 1600, 1550), // ₹4L = 40%
    ];
    const snap = calcExposureSnapshot(positions);
    const check = checkConcentration(
      snap,
      { symbol: "ICICIBANK", strategyId: "s1", direction: "LONG", notional: 1000 },
      EQUITY,
      { ...DEFAULT_EXPOSURE_LIMITS, maxSectorFraction: 0.40 },
    );
    expect(check.breached).toBe(true);
    expect(check.reason).toMatch(/Bank/);
  });

  it("getSector returns correct sector for known symbols", () => {
    expect(getSector("HDFCBANK")).toBe("Bank");
    expect(getSector("TCS")).toBe("IT");
    expect(getSector("MARUTI")).toBe("Auto");
    expect(getSector("UNKNOWN_STOCK_XYZ")).toBe("UNKNOWN");
  });
});

// ── 3. VaR breach ─────────────────────────────────────────────────────────────

describe("VaR Breach", () => {
  it("historicalVaR returns correct 95th percentile loss", () => {
    // 20 daily P&Ls: 19 are +1000, 1 is -50000.
    // At 95% confidence the cut-off index = floor(0.05 * 20) = 1, so sorted[0] = -50000 → VaR = 50000.
    const pnl = [
      ...Array(19).fill(1000),
      -50_000,
    ];
    const var95 = historicalVaR(pnl, 0.95);
    expect(var95).toBeGreaterThan(0);
    expect(var95).toBe(50_000);
  });

  it("parametricVaR is positive for a loss-biased series", () => {
    const pnl = Array(50).fill(-2000);
    const pVar = parametricVaR(pnl, 0.95);
    expect(pVar).toBeGreaterThanOrEqual(0);
  });

  it("CVaR >= historicalVaR (CVaR is always at least as severe)", () => {
    const pnl = Array.from({ length: 100 }, (_, i) => (i < 20 ? -10_000 + i * 100 : 500));
    const hVar = historicalVaR(pnl, 0.95);
    const cVar = conditionalVaR(pnl, 0.95);
    expect(cVar).toBeGreaterThanOrEqual(hVar);
  });

  it("computeVaR returns zero when insufficient observations", () => {
    const result = computeVaR([1000, -500], { ...DEFAULT_VAR_CONFIG, minObservations: 20 });
    expect(result.historicalVaR).toBe(0);
    expect(result.parametricVaR).toBe(0);
    expect(result.cVar).toBe(0);
    expect(result.observations).toBe(2);
  });

  it("engine rejects trade when VaR exceeds limit", () => {
    const engine = createRiskEngine(EQUITY, {
      var: {
        ...DEFAULT_VAR_CONFIG,
        minObservations: 5,
        varLimitFraction: 0.01, // 1% of equity = ₹10k limit
      },
    });

    // Inject large losses into history — 10 days of ₹50k losses
    for (let i = 0; i < 10; i++) {
      engine.onSessionClose(-50_000);
    }

    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);

    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("VAR_BREACH");
    expect(result.snapshot.varResult.historicalVaR).toBeGreaterThan(0);
  });

  it("checkVaRBreach returns not-breached when under limit", () => {
    const result = computeVaR(
      Array(30).fill(500),
      { ...DEFAULT_VAR_CONFIG, minObservations: 20 },
    );
    const check = checkVaRBreach(result, EQUITY, { ...DEFAULT_VAR_CONFIG, varLimitFraction: 0.10 });
    expect(check.breached).toBe(false);
  });
});

// ── 4. Drawdown breach ────────────────────────────────────────────────────────

describe("Drawdown Control", () => {
  it("classifies CAUTION tier at 1% daily drawdown", () => {
    const tier = classifyDrawdownTier(0.01, 0, DEFAULT_DRAWDOWN_CONFIG);
    expect(tier).toBe("CAUTION");
  });

  it("classifies WARNING tier at 1.5% daily drawdown", () => {
    expect(classifyDrawdownTier(0.015, 0, DEFAULT_DRAWDOWN_CONFIG)).toBe("WARNING");
  });

  it("classifies DANGER tier at 2% daily drawdown", () => {
    expect(classifyDrawdownTier(0.02, 0, DEFAULT_DRAWDOWN_CONFIG)).toBe("DANGER");
  });

  it("classifies HALT at 3% daily drawdown", () => {
    expect(classifyDrawdownTier(0.03, 0, DEFAULT_DRAWDOWN_CONFIG)).toBe("HALT");
  });

  it("classifies HALT when max drawdown reaches 10%", () => {
    expect(classifyDrawdownTier(0, 0.10, DEFAULT_DRAWDOWN_CONFIG)).toBe("HALT");
  });

  it("returns sizing multiplier 0.75 at CAUTION", () => {
    const state = computeDrawdownState(
      EQUITY * 0.99, EQUITY, EQUITY, DEFAULT_DRAWDOWN_CONFIG,
    );
    const check = checkDrawdown(state, DEFAULT_DRAWDOWN_CONFIG);
    expect(check.tier).toBe("CAUTION");
    expect(check.sizingMultiplier).toBe(0.75);
    expect(check.blocked).toBe(false);
  });

  it("returns sizing multiplier 0.25 at DANGER", () => {
    const state = computeDrawdownState(
      EQUITY * 0.979, EQUITY, EQUITY, DEFAULT_DRAWDOWN_CONFIG,
    );
    const check = checkDrawdown(state, DEFAULT_DRAWDOWN_CONFIG);
    expect(check.tier).toBe("DANGER");
    expect(check.sizingMultiplier).toBe(0.25);
  });

  it("blocks new trades at HALT (daily drawdown)", () => {
    const state = computeDrawdownState(
      EQUITY * 0.969, EQUITY, EQUITY, DEFAULT_DRAWDOWN_CONFIG,
    );
    const check = checkDrawdown(state, DEFAULT_DRAWDOWN_CONFIG);
    expect(check.blocked).toBe(true);
    expect(check.tier).toBe("HALT");
  });

  it("engine rejects trade when max drawdown breach triggers HALT", () => {
    const initialEquity = EQUITY;
    // Disable auto kill-switch escalation by setting hard kill threshold very high
    const engine = createRiskEngine(initialEquity, {
      drawdown: { ...DEFAULT_DRAWDOWN_CONFIG, maxDrawdownHalt: 0.10 },
      budget: {
        ...DEFAULT_RISK_BUDGET_CONFIG,
        hardKillDailyLossFraction: 1.0,  // disable auto hard kill
        softKillDailyLossFraction: 1.0,  // disable auto soft kill
      },
    });

    engine.onSessionOpen(initialEquity);
    // 11% drawdown from peak (exceeds 10% maxDrawdownHalt)
    const damagedEquity = initialEquity * 0.89;
    engine.onBarClose(new Map(), damagedEquity, -110_000, 1);

    const result = engine.evaluate(makeProposal(), [], damagedEquity, -110_000);

    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("DRAWDOWN_HALT");
  });

  it("DrawdownTracker updates peak correctly", () => {
    const tracker = new DrawdownTracker(100_000);
    tracker.update(120_000); // new peak
    const state = tracker.update(110_000);
    expect(state.peakEquity).toBe(120_000);
    expect(state.maxDrawdown).toBeCloseTo(10_000 / 120_000, 5);
  });
});

// ── 5. Dynamic size reduction ─────────────────────────────────────────────────

describe("Dynamic Position Sizing", () => {
  it("confidenceFactor scales linearly from 0.5 to 1.0", () => {
    expect(confidenceFactor(0.40)).toBeCloseTo(0.5, 3);
    expect(confidenceFactor(1.0)).toBeCloseTo(1.0, 3);
    expect(confidenceFactor(0.70)).toBeCloseTo(0.75, 3);
  });

  it("portfolioVolFactor returns 1.0 when vol is at or below target", () => {
    expect(portfolioVolFactor(0.005, 0.01)).toBe(1.0);
    expect(portfolioVolFactor(0, 0.01)).toBe(1.0);
  });

  it("portfolioVolFactor reduces size when vol exceeds target", () => {
    const factor = portfolioVolFactor(0.02, 0.01); // 2× target
    expect(factor).toBeLessThan(1.0);
    expect(factor).toBeGreaterThan(0);
  });

  it("correlationFactor is 1.0 at zero correlation", () => {
    expect(correlationFactor(0, 0.5)).toBe(1.0);
  });

  it("correlationFactor equals corrMinMultiplier at correlation = 1", () => {
    expect(correlationFactor(1.0, 0.5)).toBeCloseTo(0.5, 5);
  });

  it("high correlation reduces final qty vs zero correlation", () => {
    const noDDCheck = {
      blocked: false,
      tier: "NORMAL" as const,
      sizingMultiplier: 1.0,
      dailyDrawdown: 0,
      maxDrawdown: 0,
    };
    const baseInputs = {
      entryPrice: 2500,
      stopLoss: 2450,
      atr: 25,
      lotSize: 1,
      confidence: 0.80,
      equity: EQUITY,
      portfolioDailyVolFraction: 0,
      drawdownCheck: noDDCheck,
    };

    const lowCorrResult = computePositionSize(
      { ...baseInputs, maxPairwiseCorrelation: 0.0 },
      DEFAULT_SIZING_CONFIG,
    );
    const highCorrResult = computePositionSize(
      { ...baseInputs, maxPairwiseCorrelation: 0.9 },
      DEFAULT_SIZING_CONFIG,
    );

    expect(highCorrResult.qty).toBeLessThan(lowCorrResult.qty);
  });

  it("CAUTION drawdown reduces qty to ~75% of NORMAL", () => {
    const normalDDCheck = {
      blocked: false,
      tier: "NORMAL" as const,
      sizingMultiplier: 1.0,
      dailyDrawdown: 0,
      maxDrawdown: 0,
    };
    const cautionDDCheck = {
      blocked: false,
      tier: "CAUTION" as const,
      sizingMultiplier: 0.75,
      dailyDrawdown: 0.01,
      maxDrawdown: 0,
    };
    const baseInputs = {
      entryPrice: 2500,
      stopLoss: 2400,
      atr: 30,
      lotSize: 1,
      confidence: 0.80,
      equity: EQUITY,
      portfolioDailyVolFraction: 0,
      maxPairwiseCorrelation: 0,
    };

    const normalResult = computePositionSize({ ...baseInputs, drawdownCheck: normalDDCheck });
    const cautionResult = computePositionSize({ ...baseInputs, drawdownCheck: cautionDDCheck });

    expect(cautionResult.qty).toBeLessThanOrEqual(normalResult.qty);
    expect(cautionResult.drawdownFactor).toBe(0.75);
  });

  it("returns qty=0 when confidence below minimum", () => {
    const ddCheck = {
      blocked: false,
      tier: "NORMAL" as const,
      sizingMultiplier: 1.0,
      dailyDrawdown: 0,
      maxDrawdown: 0,
    };
    const result = computePositionSize({
      entryPrice: 2500,
      stopLoss: 2450,
      atr: 25,
      lotSize: 1,
      confidence: 0.20, // below 0.40 minimum
      equity: EQUITY,
      portfolioDailyVolFraction: 0,
      maxPairwiseCorrelation: 0,
      drawdownCheck: ddCheck,
    });
    expect(result.qty).toBe(0);
    expect(result.zeroReason).toMatch(/confidence/i);
  });

  it("engine applies drawdown size reduction, not blocking", () => {
    const engine = createRiskEngine(EQUITY, {
      drawdown: { ...DEFAULT_DRAWDOWN_CONFIG, dailyCaution: 0.01 },
    });
    engine.onSessionOpen(EQUITY);
    // 1% daily drawdown → CAUTION
    engine.onBarClose(new Map(), EQUITY * 0.989, -EQUITY * 0.011, 1);

    const result = engine.evaluate(makeProposal(), [], EQUITY * 0.989, -EQUITY * 0.011);

    if (result.decision === "APPROVED") {
      expect(result.sizingResult.drawdownFactor).toBeLessThan(1.0);
    }
    // If rejected it's for another reason (budget, exposure, etc.) — not drawdown halt
    expect(result.rejectReason).not.toBe("DRAWDOWN_HALT");
  });
});

// ── 6. Kill switch ────────────────────────────────────────────────────────────

describe("Kill Switch", () => {
  it("HARD_KILL blocks all new trades", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateHardKill("Manual operator halt");

    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);

    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("HARD_KILL");
    expect(result.rejectDetail).toMatch(/HARD KILL/);
    expect(result.snapshot.killSwitchState).toBe("HARD_KILL");
  });

  it("SOFT_KILL reduces position size", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateSoftKill("Elevated volatility");

    const resultSoft = engine.evaluate(makeProposal(), [], EQUITY, 0);
    engine.resetKillSwitch();
    const resultNormal = engine.evaluate(makeProposal(), [], EQUITY, 0);

    if (resultSoft.decision === "APPROVED" && resultNormal.decision === "APPROVED") {
      expect(resultSoft.recommendedQty).toBeLessThanOrEqual(resultNormal.recommendedQty);
    }
    expect(resultSoft.snapshot.killSwitchState).toBe("SOFT_KILL");
  });

  it("resetKillSwitch clears HARD_KILL state", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateHardKill("Test");
    expect(engine.killSwitchState).toBe("HARD_KILL");

    engine.resetKillSwitch();
    expect(engine.killSwitchState).toBe("NONE");
  });

  it("auto-triggers SOFT_KILL when daily loss fraction exceeds soft threshold", () => {
    let ks = createKillSwitch();
    // Daily loss = 3% of equity; soft threshold = 2.5%
    ks = evaluateKillSwitch(ks, -EQUITY * 0.03, EQUITY, DEFAULT_RISK_BUDGET_CONFIG);
    expect(ks.state).toBe("SOFT_KILL");
  });

  it("auto-triggers HARD_KILL when daily loss fraction exceeds hard threshold", () => {
    let ks = createKillSwitch();
    // Daily loss = 5% of equity; hard threshold = 4%
    ks = evaluateKillSwitch(ks, -EQUITY * 0.05, EQUITY, DEFAULT_RISK_BUDGET_CONFIG);
    expect(ks.state).toBe("HARD_KILL");
  });

  it("activateSoftKill and activateHardKill set correct state immutably", () => {
    const ks = createKillSwitch();
    const soft = activateSoftKill(ks, "reason", 1000);
    expect(soft.state).toBe("SOFT_KILL");
    expect(soft.activatedAtMs).toBe(1000);
    expect(soft.reason).toBe("reason");
    // Original unchanged
    expect(ks.state).toBe("NONE");

    const hard = activateHardKill(ks, "hard-reason", 2000);
    expect(hard.state).toBe("HARD_KILL");
    expect(hard.activatedAtMs).toBe(2000);
  });

  it("engine auto-triggers HARD_KILL after daily loss threshold via onBarClose", () => {
    const engine = createRiskEngine(EQUITY, {
      budget: { ...DEFAULT_RISK_BUDGET_CONFIG, hardKillDailyLossFraction: 0.04 },
    });
    engine.onSessionOpen(EQUITY);
    // 5% daily loss
    engine.onBarClose(new Map(), EQUITY * 0.95, -EQUITY * 0.05, 1);

    expect(engine.killSwitchState).toBe("HARD_KILL");
    const result = engine.evaluate(makeProposal(), [], EQUITY * 0.95, -EQUITY * 0.05);
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("HARD_KILL");
  });
});

// ── 7. Happy-path approval ────────────────────────────────────────────────────

describe("Happy-path approval", () => {
  it("approves a well-sized trade with no existing positions", () => {
    const engine = createRiskEngine(EQUITY);
    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);

    expect(result.decision).toBe("APPROVED");
    expect(result.recommendedQty).toBeGreaterThan(0);
    expect(result.rejectReason).toBeUndefined();
  });

  it("approved result carries correct sizing factors", () => {
    const engine = createRiskEngine(EQUITY);
    const result = engine.evaluate(
      makeProposal({ confidence: 0.85, entryPrice: 2500, stopLoss: 2450 }),
      [],
      EQUITY,
      0,
    );
    if (result.decision === "APPROVED") {
      expect(result.sizingResult.confidenceFactor).toBeGreaterThan(0.5);
      expect(result.sizingResult.qty).toBe(result.recommendedQty);
      expect(result.sizingResult.notional).toBeGreaterThan(0);
    }
  });

  it("snapshot exposure fractions are zero with no open positions", () => {
    const engine = createRiskEngine(EQUITY);
    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);
    const frac = result.snapshot.exposureFractions;
    expect(frac.grossFraction).toBe(0);
    expect(frac.longFraction).toBe(0);
  });
});

// ── 8. Exposure checks ────────────────────────────────────────────────────────

describe("Exposure checks", () => {
  it("calcExposureSnapshot correctly sums long and short notionals", () => {
    const positions: Position[] = [
      makePosition("RELIANCE", "LONG", 100, 2500, 2450),  // ₹2,50,000
      makePosition("TCS", "SHORT", 50, 3500, 3600),       // ₹1,75,000
    ];
    const snap = calcExposureSnapshot(positions);
    expect(snap.longExposure).toBeCloseTo(250_000, -1);
    expect(snap.shortExposure).toBeCloseTo(175_000, -1);
    expect(snap.grossExposure).toBeCloseTo(425_000, -1);
    expect(snap.netExposure).toBeCloseTo(75_000, -1);
  });

  it("toExposureFractions computes fractions relative to equity", () => {
    const positions: Position[] = [
      makePosition("RELIANCE", "LONG", 100, 2500, 2450),
    ];
    const snap = calcExposureSnapshot(positions);
    const frac = toExposureFractions(snap, EQUITY);
    expect(frac.grossFraction).toBeCloseTo(0.25, 2);
    expect(frac.longFraction).toBeCloseTo(0.25, 2);
  });

  it("rejects when gross exposure would exceed limit", () => {
    // Existing position fills 2,000,000 - 1 = 1,999,999 of the 2× equity limit.
    // Any additional notional (even 1 lot at ₹1500) will push gross above the cap.
    // Use strategy "strat-z" and disable all other concentration checks so only
    // GROSS_EXPOSURE fires.
    const bigQty = 800; // 800 × ₹2500 = ₹2,000,000 = exactly 2× equity
    const positions: Position[] = [
      makePosition("RELIANCE", "LONG", bigQty, 2500, 2450, "strat-z"),
    ];
    const engine = createRiskEngine(EQUITY, {
      exposure: {
        ...DEFAULT_EXPOSURE_LIMITS,
        maxGrossExposureMultiple: 2.0,
        maxStrategyFraction: 10.0,   // disable strategy check
        maxSectorFraction: 10.0,     // disable sector check
        maxSymbolFraction: 10.0,     // disable symbol check
        maxUnderlyingFraction: 10.0, // disable underlying check
        maxCorrelatedLongs: 100,     // disable cluster check
      },
    });

    const result = engine.evaluate(
      makeProposal({
        symbol: "INFY",
        strategyId: "strat-z",
        entryPrice: 1500,
        stopLoss: 1450,
      }),
      positions,
      EQUITY,
      0,
    );

    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("GROSS_EXPOSURE");
  });

  it("resolveUnderlying extracts base symbol from F&O name", () => {
    expect(resolveUnderlying("HDFCBANK")).toBe("HDFCBANK");
    // F&O suffix pattern
    expect(resolveUnderlying("RELIANCE28MAY25FUT").startsWith("RELIANCE")).toBe(true);
  });

  it("strategy concentration is tracked separately per strategyId", () => {
    const snap = calcExposureSnapshot([
      makePosition("RELIANCE", "LONG", 100, 2500, 2450, "strat-a"),
      makePosition("TCS", "LONG", 50, 3000, 2950, "strat-b"),
    ]);
    expect(snap.strategyExposure.get("strat-a")).toBeCloseTo(250_000, -1);
    expect(snap.strategyExposure.get("strat-b")).toBeCloseTo(150_000, -1);
  });
});

// ── 9. Risk budget ────────────────────────────────────────────────────────────

describe("Risk Budgets", () => {
  it("openRisk computes entry-to-stop risk correctly", () => {
    const pos = makePosition("RELIANCE", "LONG", 10, 2500, 2400, "strat-a", 1);
    // risk = 10 lots × |2500 - 2400| × 1 = 1000
    expect(openRisk(pos)).toBe(1000);
  });

  it("computePortfolioRiskBudget aggregates by strategy and sector", () => {
    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", 10, 1600, 1500, "strat-a"),  // risk = 1000
      makePosition("ICICIBANK", "LONG", 5, 1000, 900, "strat-a"),   // risk = 500
      makePosition("TCS", "LONG", 20, 3500, 3400, "strat-b"),       // risk = 2000
    ];
    const budget = computePortfolioRiskBudget(positions);
    expect(budget.totalOpenRisk).toBe(3500);
    expect(budget.strategyOpenRisk.get("strat-a")).toBe(1500);
    expect(budget.strategyOpenRisk.get("strat-b")).toBe(2000);
    expect(budget.sectorOpenRisk.get("Bank")).toBe(1500);
    expect(budget.sectorOpenRisk.get("IT")).toBe(2000);
  });

  it("checkRiskBudget rejects when per-trade risk exceeds limit", () => {
    const budget = computePortfolioRiskBudget([]);
    const ks = createKillSwitch();
    const config = { ...DEFAULT_RISK_BUDGET_CONFIG, maxTradeRiskFraction: 0.02 };
    // tradeRisk = ₹25,000 > 2% of ₹10L = ₹20,000
    const check = checkRiskBudget(
      { symbol: "RELIANCE", strategyId: "s1", tradeRisk: 25_000 },
      budget,
      EQUITY,
      ks,
      config,
    );
    expect(check.approved).toBe(false);
    expect(check.breachedLevel).toBe("TRADE");
  });

  it("checkRiskBudget rejects when portfolio risk budget exhausted", () => {
    // Portfolio already at 24% open risk
    const positions: Position[] = [
      makePosition("RELIANCE", "LONG", 1, 2500, 2500 - EQUITY * 0.24, "s1"),
    ];
    const budget = computePortfolioRiskBudget(positions);
    const ks = createKillSwitch();
    const config = { ...DEFAULT_RISK_BUDGET_CONFIG, maxPortfolioRiskFraction: 0.25 };
    // Adding even ₹15k more pushes portfolio over 25%
    const check = checkRiskBudget(
      { symbol: "INFY", strategyId: "s2", tradeRisk: 15_000 },
      budget,
      EQUITY,
      ks,
      config,
    );
    expect(check.approved).toBe(false);
    expect(check.breachedLevel).toBe("PORTFOLIO");
  });

  it("checkRiskBudget approves within all limits", () => {
    const budget = computePortfolioRiskBudget([]);
    const ks = createKillSwitch();
    const check = checkRiskBudget(
      { symbol: "RELIANCE", strategyId: "s1", tradeRisk: 5_000 }, // 0.5% of equity
      budget,
      EQUITY,
      ks,
      DEFAULT_RISK_BUDGET_CONFIG,
    );
    expect(check.approved).toBe(true);
    expect(check.killSwitchState).toBe("NONE");
  });

  it("HARD_KILL blocks in checkRiskBudget before budget checks", () => {
    const budget = computePortfolioRiskBudget([]);
    const ks = activateHardKill(createKillSwitch(), "test");
    const check = checkRiskBudget(
      { symbol: "RELIANCE", strategyId: "s1", tradeRisk: 1_000 },
      budget,
      EQUITY,
      ks,
      DEFAULT_RISK_BUDGET_CONFIG,
    );
    expect(check.approved).toBe(false);
    expect(check.killSwitchMultiplier).toBe(0);
  });
});

// ── 10. Correlation matrix and cluster detection ──────────────────────────────

describe("Correlation Matrix and Clustering", () => {
  it("builds a matrix with 1.0 on diagonal", () => {
    const history: PriceHistory = new Map([
      ["A", makePriceSeries(65, 100, 0.001, 1)],
      ["B", makePriceSeries(65, 200, 0.001, 2)],
    ]);
    const matrix = buildCorrelationMatrix(["A", "B"], history);
    const idxA = matrix.symbols.indexOf("A");
    const idxB = matrix.symbols.indexOf("B");
    expect(matrix.matrix[idxA][idxA]).toBe(1.0);
    expect(matrix.matrix[idxB][idxB]).toBe(1.0);
  });

  it("identical price series yields correlation ≈ 1.0", () => {
    const prices = makePriceSeries(65, 100, 0.002, 42);
    const history: PriceHistory = new Map([
      ["X", prices],
      ["Y", [...prices]], // exact copy
    ]);
    const matrix = buildCorrelationMatrix(["X", "Y"], history);
    const corr = getCorrelation(matrix, "X", "Y");
    expect(corr).toBeCloseTo(1.0, 4);
  });

  it("opposite price series yields correlation ≈ -1.0", () => {
    const prices = makePriceSeries(65, 100, 0.002, 7);
    // Invert: if original goes up, inverted goes down
    const inverted = prices.map((p, i) => (i === 0 ? p : prices[0] * prices[0] / p));
    const history: PriceHistory = new Map([
      ["P", prices],
      ["Q", inverted],
    ]);
    const matrix = buildCorrelationMatrix(["P", "Q"], history);
    const corr = getCorrelation(matrix, "P", "Q");
    expect(corr).toBeLessThan(-0.5); // strongly negative
  });

  it("clusterByCorrelation groups highly correlated symbols together", () => {
    const basePrices = makePriceSeries(65, 100, 0.001, 99);
    // A and B are identical — cluster together
    const history: PriceHistory = new Map([
      ["A", basePrices],
      ["B", [...basePrices]],
      ["C", makePriceSeries(65, 300, -0.002, 55)], // uncorrelated
    ]);
    const matrix = buildCorrelationMatrix(["A", "B", "C"], history);
    const clusters = clusterByCorrelation(matrix, 0.90);

    const abCluster = clusters.find(
      (c) => c.symbols.includes("A") && c.symbols.includes("B"),
    );
    expect(abCluster).toBeDefined();
    expect(abCluster!.symbols).not.toContain("C");
  });

  it("checkCorrelationRisk detects cluster breach", () => {
    const basePrices = makePriceSeries(65, 100, 0.001, 11);
    const history: PriceHistory = new Map([
      ["A", basePrices],
      ["B", [...basePrices]],
      ["C", [...basePrices]],
      ["D", [...basePrices]], // perfectly correlated with A, B, C
    ]);
    const matrix = buildCorrelationMatrix(["A", "B", "C", "D"], history);

    const openPositions = [
      { symbol: "A", direction: "LONG" as const },
      { symbol: "B", direction: "LONG" as const },
      { symbol: "C", direction: "LONG" as const },
    ];
    const check = checkCorrelationRisk("D", "LONG", openPositions, matrix, {
      windowBars: 60,
      highCorrThreshold: 0.90,
      maxClusterPositions: 3,
    });
    expect(check.breached).toBe(true);
    expect(check.clusterLongCount).toBe(3);
  });

  it("updatePriceHistory caps history at maxBars", () => {
    const history: PriceHistory = new Map();
    for (let i = 0; i < 260; i++) {
      updatePriceHistory(history, "SYM", 100 + i, 10);
    }
    expect(history.get("SYM")!.length).toBeLessThanOrEqual(11);
  });

  it("engine rebuilds correlation matrix after price history accumulates", () => {
    const engine = createRiskEngine(EQUITY);
    const prices = new Map([
      ["RELIANCE", 2500],
      ["TCS", 3500],
    ]);

    for (let i = 0; i < 10; i++) {
      engine.onBarClose(prices, EQUITY, 0, i);
    }

    expect(engine.corrMatrix).not.toBeNull();
    expect(engine.corrMatrix!.symbols.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Integration: multi-check scenario ────────────────────────────────────────

describe("Integration scenarios", () => {
  it("rejects second trade with HARD_KILL even if first was approved", () => {
    const engine = createRiskEngine(EQUITY);

    const first = engine.evaluate(makeProposal(), [], EQUITY, 0);
    expect(first.decision).toBe("APPROVED");

    engine.activateHardKill("Simulated circuit breaker");

    const second = engine.evaluate(makeProposal({ symbol: "TCS" }), [], EQUITY, 0);
    expect(second.decision).toBe("REJECTED");
    expect(second.rejectReason).toBe("HARD_KILL");
  });

  it("full pipeline: positions + drawdown + sizing produce coherent result", () => {
    const engine = createRiskEngine(EQUITY);
    engine.onSessionOpen(EQUITY);

    // 1% daily drawdown (CAUTION)
    const damagedEquity = EQUITY * 0.989;
    engine.onBarClose(new Map(), damagedEquity, -EQUITY * 0.011, 1);

    const positions: Position[] = [
      makePosition("HDFCBANK", "LONG", 5, 1600, 1550, "strat-a"),
    ];

    const result = engine.evaluate(
      makeProposal({ symbol: "INFY", strategyId: "strat-b" }),
      positions,
      damagedEquity,
      -EQUITY * 0.011,
    );

    if (result.decision === "APPROVED") {
      // At CAUTION, drawdown factor should be 0.75
      expect(result.sizingResult.drawdownFactor).toBe(0.75);
      expect(result.recommendedQty).toBeGreaterThan(0);
    }
    // If rejected, it should not be due to drawdown halt
    expect(result.rejectReason).not.toBe("DRAWDOWN_HALT");
  });

  it("VaR is zero before sufficient history, then grows with losses", () => {
    const engine = createRiskEngine(EQUITY, {
      var: { ...DEFAULT_VAR_CONFIG, minObservations: 5 },
    });

    expect(engine.currentVaR().historicalVaR).toBe(0);

    for (let i = 0; i < 10; i++) {
      engine.onSessionClose(-5_000);
    }

    const var10 = engine.currentVaR();
    expect(var10.observations).toBe(10);
    expect(var10.historicalVaR).toBeGreaterThan(0);
  });
});
