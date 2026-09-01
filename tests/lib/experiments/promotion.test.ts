/**
 * promotion.test.ts
 *
 * Covers:
 *   • SHADOW → PAPER gate checks (each gate individually)
 *   • PAPER → LIVE always returns REQUIRES_APPROVAL (never ELIGIBLE)
 *   • rejectAutoLivePromotion always throws
 *   • issueApprovalToken: validation, TTL, single-use
 *   • approveLivePromotion: success path, expired token, consumed token, wrong arm
 *   • readinessSummary progress fractions
 *   • Audit log captures every event
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PromotionEngine,
  DEFAULT_SHADOW_TO_PAPER_GATES,
} from "@/lib/experiments/promotion";
import type { ShadowSummary } from "@/lib/experiments/shadow-trader";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEngine(overrides: Partial<typeof DEFAULT_SHADOW_TO_PAPER_GATES> = {}) {
  return new PromotionEngine({
    shadowToPaper: { ...DEFAULT_SHADOW_TO_PAPER_GATES, ...overrides },
    tokenTtlMs: 60_000, // 1 min TTL for tests
  });
}

function makeSummary(overrides: Partial<ShadowSummary> = {}): ShadowSummary {
  return {
    experimentId: "exp_001",
    armId: "control",
    totalTrades: 100,
    openPositions: 0,
    wins: 60,
    losses: 40,
    winRate: 0.6,
    totalNetPnlINR: 5_000,
    avgReturnPct: 0.25,
    profitFactor: 2.5,
    sharpe: 1.5,
    maxDrawdownPct: 8,        // 8% < 25% limit
    initialCapital: 1_000_000,
    currentEquity: 1_005_000,
    totalReturnPct: 0.5,
    totalCommissionINR: 300,
    equityCurvePoints: 100,
    benchmarkPoints: 0,
    lastUpdatedAtMs: Date.now(),
    ...overrides,
  };
}

/** Returns a shadowStartedAtMs that is `daysAgo` calendar days before now. */
function daysAgo(days: number) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

// ── SHADOW → PAPER gate checks ─────────────────────────────────────────────────

describe("PromotionEngine — SHADOW → PAPER gates", () => {
  it("returns ELIGIBLE when all gates pass", () => {
    const engine = makeEngine();
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "PAPER",
      makeSummary(), daysAgo(15),
    );
    expect(result.status).toBe("ELIGIBLE");
    expect(result.blockers).toHaveLength(0);
    expect(result.readinessFraction).toBe(1);
  });

  it("returns INELIGIBLE when trade count is below minimum", () => {
    const engine = makeEngine({ minimumTrades: 50 });
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "PAPER",
      makeSummary({ totalTrades: 30 }), daysAgo(15),
    );
    expect(result.status).toBe("INELIGIBLE");
    expect(result.blockers.some((b) => b.includes("minimum_trades") || b.includes("30"))).toBe(true);
  });

  it("returns INELIGIBLE when observation days below minimum", () => {
    const engine = makeEngine({ minimumObservationDays: 10 });
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "PAPER",
      makeSummary(), daysAgo(3), // only 3 days
    );
    expect(result.status).toBe("INELIGIBLE");
    expect(result.blockers.some((b) => b.includes("observation_days") || b.includes("3"))).toBe(true);
  });

  it("returns INELIGIBLE when Sharpe is below floor", () => {
    const engine = makeEngine({ minimumSharpe: 1.0 });
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "PAPER",
      makeSummary({ sharpe: 0.5 }), daysAgo(15),
    );
    expect(result.status).toBe("INELIGIBLE");
    expect(result.blockers.some((b) => b.includes("minimum_sharpe") || b.includes("0.5"))).toBe(true);
  });

  it("returns INELIGIBLE when drawdown exceeds ceiling", () => {
    const engine = makeEngine({ maximumDrawdown: 0.15 });
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "PAPER",
      makeSummary({ maxDrawdownPct: 20 }), // 20% > 15% limit
      daysAgo(15),
    );
    expect(result.status).toBe("INELIGIBLE");
    expect(result.blockers.some((b) => b.includes("maximum_drawdown") || b.includes("20"))).toBe(true);
  });

  it("returns INELIGIBLE when win rate is below floor", () => {
    const engine = makeEngine({ minimumWinRate: 0.55 });
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "PAPER",
      makeSummary({ winRate: 0.40 }), daysAgo(15),
    );
    expect(result.status).toBe("INELIGIBLE");
    expect(result.blockers.some((b) => b.includes("minimum_win_rate") || b.includes("40"))).toBe(true);
  });

  it("returns INELIGIBLE when profit factor is below floor", () => {
    const engine = makeEngine({ minimumProfitFactor: 2.0 });
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "PAPER",
      makeSummary({ profitFactor: 1.2 }), daysAgo(15),
    );
    expect(result.status).toBe("INELIGIBLE");
  });

  it("reports correct readinessFraction as a fraction of gates passed", () => {
    const engine = makeEngine({
      minimumTrades: 200,         // fail
      minimumObservationDays: 5,  // pass (we pass 15 days)
      minimumSharpe: 0,           // pass
      maximumDrawdown: 0.25,      // pass
      minimumWinRate: 0,          // pass
      minimumProfitFactor: 0,     // pass
    });
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "PAPER",
      makeSummary({ totalTrades: 50 }), // fails trade count gate only
      daysAgo(15),
    );
    expect(result.status).toBe("INELIGIBLE");
    // 5/6 gates pass
    expect(result.readinessFraction).toBeCloseTo(5 / 6, 4);
  });

  it("returns INVALID_TRANSITION for non-sequential transition", () => {
    const engine = makeEngine();
    const result = engine.checkPromotion(
      "exp_001", "control", "SHADOW", "LIVE",
      makeSummary(), daysAgo(15),
    );
    expect(result.status).toBe("INVALID_TRANSITION");
  });

  it("RESEARCH → BACKTEST returns ELIGIBLE with no gates", () => {
    const engine = makeEngine();
    const result = engine.checkPromotion(
      "exp_001", "control", "RESEARCH", "BACKTEST",
      makeSummary(), daysAgo(15),
    );
    expect(result.status).toBe("ELIGIBLE");
    expect(result.gates).toHaveLength(0);
  });
});

// ── PAPER → LIVE: never auto-promotes ─────────────────────────────────────────

describe("PromotionEngine — PAPER → LIVE never auto-promotes", () => {
  it("checkPromotion for PAPER → LIVE always returns REQUIRES_APPROVAL", () => {
    const engine = makeEngine();
    const result = engine.checkPromotion(
      "exp_001", "control", "PAPER", "LIVE",
      makeSummary(), daysAgo(30),
    );
    // NEVER ELIGIBLE — always requires human approval
    expect(result.status).toBe("REQUIRES_APPROVAL");
    expect(result.blockers[0]).toContain("approval token");
  });

  it("rejectAutoLivePromotion always throws with a clear message", () => {
    const engine = makeEngine();
    expect(() => engine.rejectAutoLivePromotion("exp_001", "control"))
      .toThrow("AUTO-PROMOTION TO LIVE IS STRICTLY FORBIDDEN");
  });

  it("rejectAutoLivePromotion records an audit entry", () => {
    const engine = makeEngine();
    try { engine.rejectAutoLivePromotion("exp_001", "control"); } catch { /* expected */ }
    const log = engine.auditLog();
    expect(log.some((e) => e.type === "PROMOTION_REJECTED")).toBe(true);
  });
});

// ── Approval tokens ────────────────────────────────────────────────────────────

describe("PromotionEngine — approval tokens", () => {
  it("issues a token with required fields", () => {
    const engine = makeEngine();
    const token = engine.issueApprovalToken(
      "exp_001", "control",
      "ops-team@example.com",
      "Paper trading beat benchmark for 30 days — approving LIVE promotion.",
    );
    expect(token.token).toHaveLength(64); // 32 bytes hex
    expect(token.experimentId).toBe("exp_001");
    expect(token.armId).toBe("control");
    expect(token.consumedAtMs).toBeNull();
    expect(token.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("throws when justification is too short", () => {
    const engine = makeEngine();
    expect(() =>
      engine.issueApprovalToken("exp_001", "control", "ops", "short"),
    ).toThrow("justification");
  });

  it("throws when issuedBy is empty", () => {
    const engine = makeEngine();
    expect(() =>
      engine.issueApprovalToken("exp_001", "control", "", "This is a valid justification text"),
    ).toThrow("issuedBy");
  });

  it("approveLivePromotion succeeds with a valid token", () => {
    const engine = makeEngine();
    const { token } = engine.issueApprovalToken(
      "exp_001", "control", "ops", "30 days paper run, Sharpe 1.8, DD < 5% — approve.",
    );
    const record = engine.approveLivePromotion(token, "exp_001", "control", "head-of-trading");
    expect(record.consumedAtMs).not.toBeNull();
    // Token is now consumed
    const retrieved = engine.getToken(token);
    expect(retrieved!.consumedAtMs).not.toBeNull();
  });

  it("approveLivePromotion records PROMOTION_APPROVED in audit log", () => {
    const engine = makeEngine();
    const { token } = engine.issueApprovalToken(
      "exp_001", "control", "ops", "LIVE approval — 6 week paper run passed all gates.",
    );
    engine.approveLivePromotion(token, "exp_001", "control", "trader-1");
    const log = engine.auditLog();
    expect(log.some((e) => e.type === "PROMOTION_APPROVED")).toBe(true);
    expect(log.some((e) => e.type === "TOKEN_CONSUMED")).toBe(true);
  });

  it("throws when token is already consumed (single-use enforcement)", () => {
    const engine = makeEngine();
    const { token } = engine.issueApprovalToken(
      "exp_001", "control", "ops", "Valid justification for live promotion.",
    );
    engine.approveLivePromotion(token, "exp_001", "control", "trader-1");
    // Second use must fail
    expect(() =>
      engine.approveLivePromotion(token, "exp_001", "control", "trader-2"),
    ).toThrow("already been consumed");
  });

  it("throws when token has expired", () => {
    const engine = new PromotionEngine({ tokenTtlMs: 1 }); // 1ms TTL
    const { token } = engine.issueApprovalToken(
      "exp_001", "control", "ops", "Fast-expiry token for testing purposes.",
    );
    // Wait for expiry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(() =>
          engine.approveLivePromotion(token, "exp_001", "control", "trader"),
        ).toThrow("expired");
        resolve();
      }, 10);
    });
  });

  it("throws when token is for a different experiment", () => {
    const engine = makeEngine();
    const { token } = engine.issueApprovalToken(
      "exp_001", "control", "ops", "Valid justification for the wrong experiment.",
    );
    expect(() =>
      engine.approveLivePromotion(token, "exp_DIFFERENT", "control", "trader"),
    ).toThrow("different experiment");
  });

  it("throws when token is for a different arm", () => {
    const engine = makeEngine();
    const { token } = engine.issueApprovalToken(
      "exp_001", "control", "ops", "Valid justification for the wrong arm.",
    );
    expect(() =>
      engine.approveLivePromotion(token, "exp_001", "different-arm", "trader"),
    ).toThrow("different experiment");
  });

  it("throws when token is unknown", () => {
    const engine = makeEngine();
    expect(() =>
      engine.approveLivePromotion("nonexistent-token", "exp_001", "control", "trader"),
    ).toThrow("not found");
  });

  it("audit log contains TOKEN_ISSUED entry", () => {
    const engine = makeEngine();
    engine.issueApprovalToken(
      "exp_001", "control", "ops", "Justified approval for audit log test case.",
    );
    const log = engine.auditLog();
    expect(log.some((e) => e.type === "TOKEN_ISSUED")).toBe(true);
  });
});

// ── Readiness summary ──────────────────────────────────────────────────────────

describe("PromotionEngine — readinessSummary", () => {
  it("eligible=true when all gates pass", () => {
    const engine = makeEngine();
    const summary = engine.readinessSummary(
      "exp_001", "control",
      makeSummary(),
      daysAgo(15),
    );
    expect(summary.eligible).toBe(true);
    expect(summary.readinessFraction).toBe(1);
    expect(summary.blockers).toHaveLength(0);
  });

  it("tradeFraction is capped at 1 when over requirement", () => {
    const engine = makeEngine({ minimumTrades: 50 });
    const summary = engine.readinessSummary(
      "exp_001", "control",
      makeSummary({ totalTrades: 200 }), // way over
      daysAgo(15),
    );
    expect(summary.sampleProgress.tradeFraction).toBe(1);
  });

  it("tradeFraction is proportional when under requirement", () => {
    const engine = makeEngine({ minimumTrades: 100 });
    const summary = engine.readinessSummary(
      "exp_001", "control",
      makeSummary({ totalTrades: 40 }),
      daysAgo(15),
    );
    expect(summary.sampleProgress.tradeFraction).toBeCloseTo(0.4, 4);
    expect(summary.sampleProgress.trades).toBe(40);
    expect(summary.sampleProgress.requiredTrades).toBe(100);
  });

  it("dayFraction reflects actual observation days", () => {
    const engine = makeEngine({ minimumObservationDays: 20 });
    const summary = engine.readinessSummary(
      "exp_001", "control",
      makeSummary(),
      daysAgo(10),
    );
    expect(summary.sampleProgress.dayFraction).toBeCloseTo(0.5, 1);
  });
});
