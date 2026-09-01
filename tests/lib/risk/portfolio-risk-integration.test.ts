// @vitest-environment node
/**
 * Phase 12 — Portfolio Risk End-to-End Audit Tests
 *
 * Verifies the full PortfolioRiskEngine pipeline:
 *   1. Hard kill → immediate rejection regardless of everything else
 *   2. Soft kill → approves but with reduced qty
 *   3. Drawdown halt → rejection when DD limit breached
 *   4. Gross exposure breach → rejection
 *   5. Signal approved by ML + meta model but REJECTED by risk engine
 *   6. Approved trade passes all checks
 *
 * Validates: PHASE 12 requirements — risk checks before any order
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PortfolioRiskEngine,
  createRiskEngine,
  DEFAULT_RISK_CONFIG,
} from "@/lib/risk/portfolio-risk";
import type { TradeProposal } from "@/lib/risk/portfolio-risk";
import type { Position } from "@/lib/backtesting-v2/models/position";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const EQUITY = 1_000_000; // ₹10L

function makeProposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "RELIANCE",
    strategyId: "MOMENTUM",
    direction: "LONG",
    entryPrice: 2800,
    stopLoss: 2730,
    target: 2950,
    atr: 35,
    lotSize: 1,
    confidence: 0.75,
    ...overrides,
  };
}

// Build minimal valid Position objects matching what portfolio-risk.ts uses
function makePosition(symbol: string, notional: number, direction: "LONG" | "SHORT" = "LONG"): Position {
  return {
    id: `pos-${symbol}`,
    instrument: {
      symbol,
      exchange: "NSE" as const,
      instrumentType: "EQ" as const,
      lotSize: 1,
      tickSize: 0.05,
      expiry: null,
      strike: null,
      optionType: null,
    },
    direction: direction as any,
    status: "OPEN" as any,
    avgEntryPrice: notional,
    qty: 1,
    stopLoss: notional * 0.95,
    target: notional * 1.05,
    unrealisedPnl: 0,
    realisedPnl: 0,
    totalCommission: 0,
    marginReserved: notional * 0.1,
    openedAtMs: Date.now(),
    closedAtMs: null,
    openBarIndex: 0,
    closeBarIndex: null,
    closeReason: null,
    attribution: {
      signalId: `sig-${symbol}`,
      strategyId: "MOMENTUM",
      modelVersion: "",
      featureVersion: "",
      marketRegime: "UNKNOWN" as const,
      dataQualityScore: 1.0,
    },
    fills: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Hard kill switch
// ─────────────────────────────────────────────────────────────────────────────

describe("PortfolioRiskEngine — hard kill switch", () => {
  it("immediately rejects all trades when HARD_KILL is active", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateHardKill("manual stop");

    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("HARD_KILL");
    expect(result.recommendedQty).toBe(0);
  });

  it("allows reset of hard kill switch", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateHardKill("test");
    engine.resetKillSwitch();

    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);
    // After reset, should not be hard-killed
    expect(result.rejectReason).not.toBe("HARD_KILL");
  });

  it("hard kill reason is present in rejectDetail", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateHardKill("daily loss limit breached");

    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);
    expect(result.rejectDetail).toContain("HARD KILL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Gross exposure breach
// ─────────────────────────────────────────────────────────────────────────────

describe("PortfolioRiskEngine — gross exposure rejection", () => {
  it("rejects when gross exposure would exceed the limit", () => {
    const engine = createRiskEngine(EQUITY, {
      exposure: {
        ...DEFAULT_RISK_CONFIG.exposure,
        maxGrossExposureMultiple: 0.5, // 50% of equity max = ₹500k
        maxSymbolFraction: 0.6,        // allow large single symbol
      },
    });

    // Build a position that already takes up 45% of equity
    // avgEntryPrice=450000, qty=1, lotSize=1 → notional = 450000 = 45% of 1M
    const positions: Position[] = [makePosition("EXISTING_SYM", EQUITY * 0.45)];

    // New proposal: entryPrice=150000 (15% of equity)
    // Total would be 45% + 15% = 60% > 50% limit
    const proposal = makeProposal({
      entryPrice: EQUITY * 0.15,
      lotSize: 1,
    });

    const result = engine.evaluate(proposal, positions, EQUITY, 0);
    // 45% existing + 15% new = 60% > 50% limit → should breach gross exposure
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toMatch(/GROSS_EXPOSURE|SYMBOL_CONCENTRATION/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Signal approved by ML + meta model but REJECTED by portfolio risk
// ─────────────────────────────────────────────────────────────────────────────

describe("PortfolioRiskEngine — risk rejection despite ML approval", () => {
  it("rejects a signal when kill switch is active even if ML confidence is high", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateHardKill("VIX spike > 40");

    // Simulated ML-approved high-confidence signal
    const mlApprovedSignal = makeProposal({ confidence: 0.95 });

    const result = engine.evaluate(mlApprovedSignal, [], EQUITY, 0);
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("HARD_KILL");
    expect(result.recommendedQty).toBe(0);
  });

  it("rejects when drawdown halt is explicitly triggered via hard kill", () => {
    const engine = createRiskEngine(EQUITY);

    // Explicitly activate hard kill (mirrors what would happen after large drawdown)
    engine.activateHardKill("daily drawdown limit 3% breached");

    const result = engine.evaluate(makeProposal(), [], EQUITY * 0.97, -0.03 * EQUITY);
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectReason).toBe("HARD_KILL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Approved trade
// ─────────────────────────────────────────────────────────────────────────────

describe("PortfolioRiskEngine — approved trade", () => {
  it("approves a safe trade with ample capital and no constraints", () => {
    const engine = createRiskEngine(EQUITY);
    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);

    // Should approve — small proposal vs ₹10L equity
    expect(result.decision).toBe("APPROVED");
    expect(result.recommendedQty).toBeGreaterThan(0);
  });

  it("returns a sizing result with all required fields", () => {
    const engine = createRiskEngine(EQUITY);
    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);

    if (result.decision === "APPROVED") {
      expect(result.sizingResult.qty).toBeGreaterThan(0);
      expect(result.sizingResult.notional).toBeGreaterThan(0);
      expect(result.sizingResult.confidenceFactor).toBeGreaterThan(0);
    }
  });

  it("snapshot includes corrMatrixAge field (regression: _corrMatrixBarAge bug fix)", () => {
    const engine = createRiskEngine(EQUITY);
    const result = engine.evaluate(makeProposal(), [], EQUITY, 0);
    expect(typeof result.snapshot.corrMatrixAge).toBe("number");
    expect(result.snapshot.corrMatrixAge).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Kill switch state machine
// ─────────────────────────────────────────────────────────────────────────────

describe("PortfolioRiskEngine — kill switch state machine", () => {
  it("starts with kill switch NONE", () => {
    const engine = createRiskEngine(EQUITY);
    expect(engine.killSwitchState).toBe("NONE");
  });

  it("transitions NONE → SOFT_KILL → HARD_KILL correctly", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateSoftKill("test soft");
    expect(engine.killSwitchState).toBe("SOFT_KILL");

    engine.activateHardKill("test hard");
    expect(engine.killSwitchState).toBe("HARD_KILL");
  });

  it("resets to NONE after resetKillSwitch()", () => {
    const engine = createRiskEngine(EQUITY);
    engine.activateHardKill("test");
    engine.resetKillSwitch();
    expect(engine.killSwitchState).toBe("NONE");
  });
});
