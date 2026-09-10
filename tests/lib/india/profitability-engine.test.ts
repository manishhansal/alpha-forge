/**
 * Tests for the India Profitability-Selection Engine.
 *
 * Covers all required cost + robustness scenarios:
 *   • net vs gross EV (gross-only signals cannot be A/A+)
 *   • full cost stack (all 7 regulatory + spread/slippage/impact)
 *   • cost stress 1×/1.5×/2×/3× + costRobustnessScore
 *   • slippage model (liquidity/spread/volume/vol/TOD/moneyness/option-liq/order-size)
 *   • options greeks influence slippage
 *   • counterfactual perturbations + robustnessScore + fragility rejection
 *   • derivatives confirm-only (max-pain/PCR/OI alone cannot create a trade)
 *   • decision mapping TRADE/WATCH/WAIT/NO_TRADE
 *   • determinism
 */

import { describe, it, expect } from "vitest";
import {
  computeCostBreakdown,
  modelSlippage,
  computeNetEV,
  runCounterfactuals,
  evaluateDerivativesGate,
  runProfitabilityPipeline,
  gradeProfitability,
  DEFAULT_PROFITABILITY_CONFIG,
  COST_RATES,
  type SlippageInputs,
  type NetEVInput,
  type ProfitabilityPipelineInput,
  type CostBreakdownPct,
} from "@/lib/india/profitability-engine";

// ─── Builders ─────────────────────────────────────────────────────────────────

function baseSlippage(over: Partial<SlippageInputs> = {}): SlippageInputs {
  return {
    instrument: "INDEX_OPTION",
    quotedSpreadPct: 0.1,
    liquidity: 0.85,
    relativeVolume: 1.2,
    volatility: 0.3,
    minutesFromOpen: 120,
    orderSizeRatio: 1,
    option: null,
    ...over,
  };
}

function cost(over: Partial<CostBreakdownPct> = {}): CostBreakdownPct {
  const c: CostBreakdownPct = {
    brokerage: 0.02, stt: 0.02, exchange: 0.007, sebi: 0.0002, gst: 0.005, stampDuty: 0.003,
    spread: 0.2, slippage: 0.1, marketImpact: 0.02, totalPct: 0,
    ...over,
  };
  // Always recompute the total AFTER applying overrides (a component override
  // must be reflected in the total).
  c.totalPct = c.brokerage + c.stt + c.exchange + c.sebi + c.gst + c.stampDuty + c.spread + c.slippage + c.marketImpact;
  return c;
}

function netInput(over: Partial<NetEVInput> = {}): NetEVInput {
  return { pWin: 0.6, expectedWinR: 1.8, expectedLossR: 1.0, riskPct: 1.0, cost: cost(), ...over };
}

function pipelineInput(over: Partial<ProfitabilityPipelineInput> = {}): ProfitabilityPipelineInput {
  return {
    instrument: "INDEX_OPTION",
    strategyId: "OPENING_BREAKOUT",
    qualityScore: 80,
    calibratedPWin: 0.66,
    probabilityLowerBound: 0.55,
    modelAgreement: 0.9,
    predictionUncertainty: 0.2,
    confidence: 0.8,
    expectedWinR: 2.0,
    expectedLossR: 1.0,
    riskPct: 1.0,
    notionalINR: 100_000,
    slippage: baseSlippage(),
    derivatives: { directionalThesisSupported: true, maxPainAgrees: true, pcrAgrees: true, oiAgrees: false, isValidatedOptionsFlowStrategy: false },
    clusterCorrelation: 0.2,
    hasConflict: false,
    mlAbstained: false,
    riskBlocked: false,
    strategySuppressed: false,
    delayDecayRPerCandle: 0.1,
    hourlyDecayR: 0.3,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("cost stack", () => {
  it("includes every regulatory component + spread/slippage/impact", () => {
    const c = computeCostBreakdown({ instrument: "INDEX_OPTION", notionalINR: 100_000, spreadPct: 0.2, slippagePct: 0.1, marketImpactPct: 0.03 });
    expect(c.brokerage).toBeGreaterThan(0);
    expect(c.stt).toBeGreaterThan(0);
    expect(c.exchange).toBeGreaterThan(0);
    expect(c.sebi).toBeGreaterThan(0);
    expect(c.gst).toBeGreaterThan(0);
    expect(c.stampDuty).toBeGreaterThan(0);
    expect(c.spread).toBe(0.2);
    expect(c.slippage).toBe(0.1);
    expect(c.marketImpact).toBe(0.03);
    // total equals the sum
    const sum = c.brokerage + c.stt + c.exchange + c.sebi + c.gst + c.stampDuty + c.spread + c.slippage + c.marketImpact;
    expect(c.totalPct).toBeCloseTo(sum, 9);
  });

  it("smaller notional → larger brokerage % (flat fee amortised)", () => {
    const small = computeCostBreakdown({ instrument: "INDEX_OPTION", notionalINR: 20_000, spreadPct: 0, slippagePct: 0, marketImpactPct: 0 });
    const large = computeCostBreakdown({ instrument: "INDEX_OPTION", notionalINR: 500_000, spreadPct: 0, slippagePct: 0, marketImpactPct: 0 });
    expect(small.brokerage).toBeGreaterThan(large.brokerage);
  });

  it("equity has zero flat brokerage in the default rate table", () => {
    expect(COST_RATES.EQUITY.brokerageRoundTrip).toBe(0);
  });
});

describe("net vs gross EV — gross-only signals cannot be A/A+", () => {
  it("a signal profitable gross but negative net is REJECT", () => {
    // tiny edge, huge costs
    const c = cost({ spread: 1.0, slippage: 0.5, marketImpact: 0.2 });
    c.totalPct = c.brokerage + c.stt + c.exchange + c.sebi + c.gst + c.stampDuty + c.spread + c.slippage + c.marketImpact;
    const ev = computeNetEV(netInput({ pWin: 0.52, expectedWinR: 1.2, expectedLossR: 1.0, riskPct: 1.0, cost: c }));
    expect(ev.grossEVPct).toBeGreaterThan(0);
    expect(ev.netEVPct).toBeLessThan(0);
    const grade = gradeProfitability({ qualityScore: 90, calibratedPWin: 0.9, probabilityLowerBound: 0.8 }, ev, runCounterfactuals({ base: netInput({ cost: c }), delayDecayRPerCandle: 0.1, hourlyDecayR: 0.3 }), DEFAULT_PROFITABILITY_CONFIG);
    expect(grade).toBe("REJECT"); // gross positive but net negative
  });

  it("gross EV never lifts a net-negative signal above REJECT even with perfect quality", () => {
    const c = cost({ spread: 2.0 });
    c.totalPct = 2.5;
    const ev = computeNetEV(netInput({ cost: c }));
    const grade = gradeProfitability({ qualityScore: 100, calibratedPWin: 0.99, probabilityLowerBound: 0.95 }, ev, runCounterfactuals({ base: netInput({ cost: c }), delayDecayRPerCandle: 0, hourlyDecayR: 0 }), DEFAULT_PROFITABILITY_CONFIG);
    expect(grade).toBe("REJECT");
  });
});

describe("cost stress 1×/1.5×/2×/3× + costRobustnessScore", () => {
  it("computes the full stress ladder, monotonically decreasing", () => {
    const ev = computeNetEV(netInput());
    expect(ev.evAt1x).toBeGreaterThan(ev.evAt1_5x);
    expect(ev.evAt1_5x).toBeGreaterThan(ev.evAt2x);
    expect(ev.evAt2x).toBeGreaterThan(ev.evAt3x);
  });

  it("a cost-fragile signal has low costRobustnessScore and fails 2×", () => {
    // gross edge ~0.375%, total cost ~0.30% → net +0.075% at 1×, but −0.22% at 2×.
    const c = cost({ spread: 0.15, slippage: 0.05, marketImpact: 0.01 });
    c.totalPct = c.brokerage + c.stt + c.exchange + c.sebi + c.gst + c.stampDuty + c.spread + c.slippage + c.marketImpact;
    const ev = computeNetEV(netInput({ pWin: 0.55, expectedWinR: 1.5, expectedLossR: 1.0, cost: c }));
    expect(ev.netEVPct).toBeGreaterThan(0);      // positive at 1×
    expect(ev.survives2x).toBe(false);           // dies at 2×
    expect(ev.costRobustnessScore).toBeLessThan(0.4);
  });

  it("a cost-robust signal survives 2× (and 3×) with meaningful robustness", () => {
    const ev = computeNetEV(netInput({ pWin: 0.68, expectedWinR: 2.2, expectedLossR: 1.0, cost: cost({ spread: 0.05, slippage: 0.02, marketImpact: 0 }) }));
    expect(ev.survives2x).toBe(true);
    expect(ev.evAt3x).toBeGreaterThan(0);              // survives even 3× costs
    expect(ev.costRobustnessScore).toBeGreaterThan(0.3);
  });
});

describe("slippage model", () => {
  it("thin liquidity + low volume + high volatility widen slippage", () => {
    const good = modelSlippage(baseSlippage({ liquidity: 0.95, relativeVolume: 1.5, volatility: 0.1 }));
    const bad = modelSlippage(baseSlippage({ liquidity: 0.2, relativeVolume: 0.4, volatility: 0.9 }));
    expect(bad.slippagePct + bad.spreadPct).toBeGreaterThan(good.slippagePct + good.spreadPct);
  });

  it("open and close windows are slippier than mid-session", () => {
    const open = modelSlippage(baseSlippage({ minutesFromOpen: 5 }));
    const mid = modelSlippage(baseSlippage({ minutesFromOpen: 120 }));
    expect(open.slippagePct).toBeGreaterThan(mid.slippagePct);
  });

  it("larger order size increases market impact (sqrt law)", () => {
    const small = modelSlippage(baseSlippage({ orderSizeRatio: 1 }));
    const big = modelSlippage(baseSlippage({ orderSizeRatio: 9 }));
    expect(big.marketImpactPct).toBeGreaterThan(small.marketImpactPct);
  });

  it("deep-OTM, thin-OI, expiry-day options are much slippier than liquid ATM", () => {
    const liquidAtm = modelSlippage(baseSlippage({
      option: { bidAskSpreadPct: 0.3, iv: 18, theta: -5, gamma: 0.01, vega: 10, oi: 500_000, volume: 200_000, moneyness: "ATM", daysToExpiry: 3 },
    }));
    const thinOtm = modelSlippage(baseSlippage({
      option: { bidAskSpreadPct: 0.3, iv: 45, theta: -12, gamma: 0.08, vega: 40, oi: 1000, volume: 200, moneyness: "DEEP_OTM", daysToExpiry: 0 },
    }));
    expect(thinOtm.spreadPct + thinOtm.slippagePct).toBeGreaterThan(liquidAtm.spreadPct + liquidAtm.slippagePct);
    expect(thinOtm.reasons).toContain("thin_option_oi");
  });

  it("high IV / gamma / vega add execution friction (greeks influence slippage)", () => {
    const calm = modelSlippage(baseSlippage({ option: { bidAskSpreadPct: 0.3, iv: 15, theta: -3, gamma: 0.005, vega: 5, oi: 300_000, volume: 100_000, moneyness: "ATM", daysToExpiry: 5 } }));
    const wild = modelSlippage(baseSlippage({ option: { bidAskSpreadPct: 0.3, iv: 60, theta: -3, gamma: 0.12, vega: 80, oi: 300_000, volume: 100_000, moneyness: "ATM", daysToExpiry: 5 } }));
    expect(wild.slippagePct).toBeGreaterThan(calm.slippagePct);
  });
});

describe("counterfactual robustness", () => {
  it("runs all required perturbation scenarios", () => {
    const r = runCounterfactuals({ base: netInput(), delayDecayRPerCandle: 0.1, hourlyDecayR: 0.3 });
    const names = r.scenarios.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining([
      "base", "delay_1_candle", "delay_2_candle", "slippage_2x",
      "stop_10pct_wider", "target_10pct_closer", "target_10pct_farther", "entry_1hr_later",
    ]));
  });

  it("a strong signal stays positive under reasonable perturbations (robust)", () => {
    const r = runCounterfactuals({ base: netInput({ pWin: 0.68, expectedWinR: 2.5, expectedLossR: 1.0, cost: cost({ spread: 0.05, slippage: 0.02, marketImpact: 0 }) }), delayDecayRPerCandle: 0.05, hourlyDecayR: 0.1 });
    expect(r.robustnessScore).toBeGreaterThanOrEqual(0.85);
    expect(r.fragile).toBe(false);
  });

  it("a marginal signal that is positive at base but flips under perturbation is flagged fragile", () => {
    // Base net EV is POSITIVE but small; steep per-candle/hour edge decay flips it.
    const lowCost = cost({ spread: 0.02, slippage: 0.01, marketImpact: 0 });
    const base = netInput({ pWin: 0.56, expectedWinR: 1.2, expectedLossR: 1.0, riskPct: 1.0, cost: lowCost });
    // sanity: base must be net-positive so "fragile" (which requires base>0) can trigger
    expect(computeNetEV(base).netEVPct).toBeGreaterThan(0);
    const r = runCounterfactuals({ base, delayDecayRPerCandle: 0.4, hourlyDecayR: 0.8 });
    expect(r.robustnessScore).toBeLessThan(0.7);
    expect(r.fragile).toBe(true);
  });
});

describe("derivatives confirm-only", () => {
  it("max-pain/PCR/OI alone (no supported thesis) cannot create a directional trade", () => {
    const gate = evaluateDerivativesGate({ directionalThesisSupported: false, maxPainAgrees: true, pcrAgrees: true, oiAgrees: true, isValidatedOptionsFlowStrategy: false });
    expect(gate.allowed).toBe(false);
    expect(gate.derivativesAloneRejected).toBe(true);
  });

  it("derivatives CONFIRM a supported thesis (allowed, confirmation strength scales)", () => {
    const gate = evaluateDerivativesGate({ directionalThesisSupported: true, maxPainAgrees: true, pcrAgrees: true, oiAgrees: true, isValidatedOptionsFlowStrategy: false });
    expect(gate.allowed).toBe(true);
    expect(gate.derivativesAloneRejected).toBe(false);
    expect(gate.confirmationStrength).toBeCloseTo(1, 6);
  });

  it("a validated options-flow strategy may use derivatives as independent evidence", () => {
    const gate = evaluateDerivativesGate({ directionalThesisSupported: false, maxPainAgrees: true, pcrAgrees: false, oiAgrees: true, isValidatedOptionsFlowStrategy: true });
    expect(gate.allowed).toBe(true);
    expect(gate.derivativesAloneRejected).toBe(false);
  });

  it("the pipeline NO_TRADEs a derivatives-alone signal", () => {
    const r = runProfitabilityPipeline(pipelineInput({
      derivatives: { directionalThesisSupported: false, maxPainAgrees: true, pcrAgrees: true, oiAgrees: true, isValidatedOptionsFlowStrategy: false },
    }));
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reasons).toContain("derivatives_alone");
  });
});

describe("pipeline decisions TRADE / WATCH / WAIT / NO_TRADE", () => {
  it("a clean, robust, net-positive signal → TRADE", () => {
    const r = runProfitabilityPipeline(pipelineInput({
      slippage: baseSlippage({ liquidity: 0.95, relativeVolume: 1.5, volatility: 0.15, quotedSpreadPct: 0.03 }),
      expectedWinR: 2.4, expectedLossR: 1.0, riskPct: 1.2,
    }));
    expect(r.decision).toBe("TRADE");
    expect(r.grade === "A" || r.grade === "A_PLUS" || r.grade === "B").toBe(true);
    expect(r.netEV.netEVPct).toBeGreaterThan(0);
    expect(r.netEV.survives2x).toBe(true);
  });

  it("net-negative-after-costs signal → NO_TRADE", () => {
    const r = runProfitabilityPipeline(pipelineInput({
      slippage: baseSlippage({ liquidity: 0.15, relativeVolume: 0.3, volatility: 0.95, quotedSpreadPct: 1.2, minutesFromOpen: 5 }),
      expectedWinR: 1.2, expectedLossR: 1.0, riskPct: 0.5,
    }));
    expect(r.decision).toBe("NO_TRADE");
  });

  it("model abstention → WAIT (not NO_TRADE) when the base edge exists", () => {
    const r = runProfitabilityPipeline(pipelineInput({
      slippage: baseSlippage({ liquidity: 0.95, quotedSpreadPct: 0.03, volatility: 0.15 }),
      expectedWinR: 2.4, riskPct: 1.2,
      mlAbstained: true,
    }));
    expect(r.decision).toBe("WAIT");
  });

  it("timeframe/derivatives conflict → WAIT", () => {
    const r = runProfitabilityPipeline(pipelineInput({
      slippage: baseSlippage({ liquidity: 0.95, quotedSpreadPct: 0.03, volatility: 0.15 }),
      expectedWinR: 2.4, riskPct: 1.2, hasConflict: true,
    }));
    expect(r.decision).toBe("WAIT");
  });

  it("high cluster correlation → WATCH", () => {
    const r = runProfitabilityPipeline(pipelineInput({
      slippage: baseSlippage({ liquidity: 0.95, quotedSpreadPct: 0.03, volatility: 0.15 }),
      expectedWinR: 2.4, riskPct: 1.2, clusterCorrelation: 0.95,
    }));
    expect(r.decision).toBe("WATCH");
  });

  it("risk block → NO_TRADE regardless of edge", () => {
    const r = runProfitabilityPipeline(pipelineInput({ riskBlocked: true }));
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reasons).toContain("risk_blocked");
  });

  it("strategy suppressed in regime → NO_TRADE", () => {
    const r = runProfitabilityPipeline(pipelineInput({ strategySuppressed: true }));
    expect(r.decision).toBe("NO_TRADE");
  });

  it("emits the full stage trace in pipeline order", () => {
    const r = runProfitabilityPipeline(pipelineInput());
    const stages = r.stages.map((s) => s.stage);
    expect(stages).toEqual([
      "Derivatives", "NetEV", "CostStress", "Counterfactual",
      "CorrelationCluster", "ConflictResolution", "Abstention", "Risk", "Grade",
    ]);
  });
});

describe("determinism", () => {
  it("identical inputs produce byte-identical output", () => {
    const inp = pipelineInput();
    const a = runProfitabilityPipeline(inp);
    const b = runProfitabilityPipeline(inp);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
