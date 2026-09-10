/**
 * Tests for signal-mode + canonical decision authority (Phase 1/3).
 *
 * Core invariant: the veto hierarchy is strict — a lower-level TRADE can never
 * override a higher-level veto (critical data, risk, negative EV, untrained
 * model, …).
 */

import { describe, it, expect } from "vitest";
import { resolveSignalMode, newStackControlsExecution, DEFAULT_SIGNAL_MODE } from "@/lib/india/signal-mode";
import { resolveCanonicalDecision, type DecisionInputs } from "@/lib/india/canonical-decision";

/** A fully-clean, live-eligible, A+ input (the only path to TRADE via A+). */
function tradeReady(): DecisionInputs {
  return {
    criticalDataIssue: false, insufficientData: false, riskBlocked: false,
    modelState: "VALIDATED", calibrationAvailable: true, netEVPct: 0.8,
    survives2xCost: true, fragile: false, hasSufficientEvidence: true,
    aPlus: true, allMandatoryGatesPass: true,
  };
}

describe("signal mode", () => {
  it("defaults to SHADOW (new stack observes, does not execute)", () => {
    expect(resolveSignalMode({} as NodeJS.ProcessEnv)).toBe("SHADOW");
    expect(DEFAULT_SIGNAL_MODE).toBe("SHADOW");
    expect(newStackControlsExecution("SHADOW")).toBe(false);
    expect(newStackControlsExecution("LEGACY")).toBe(false);
  });
  it("unrecognised mode falls back to SHADOW (fail-safe)", () => {
    expect(resolveSignalMode({ INDIA_SIGNAL_MODE: "YOLO" } as unknown as NodeJS.ProcessEnv)).toBe("SHADOW");
  });
  it("only PAPER / PRODUCTION_CANDIDATE let the new stack execute", () => {
    expect(newStackControlsExecution("PAPER")).toBe(true);
    expect(newStackControlsExecution("PRODUCTION_CANDIDATE")).toBe(true);
  });
});

describe("canonical decision — veto hierarchy is strict", () => {
  it("clean A+ with all gates → TRADE", () => {
    expect(resolveCanonicalDecision(tradeReady()).decision).toBe("TRADE");
  });

  it("critical data failure REJECTs even when everything else screams A+", () => {
    const r = resolveCanonicalDecision({ ...tradeReady(), criticalDataIssue: true });
    expect(r.decision).toBe("REJECT");
    expect(r.reason).toBe("CRITICAL_DATA_FAILURE");
  });

  it("risk block cannot be overridden by an A+", () => {
    const r = resolveCanonicalDecision({ ...tradeReady(), riskBlocked: true });
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reason).toBe("RISK_BLOCKED");
  });

  it("negative net EV cannot become TRADE even if flagged A+", () => {
    const r = resolveCanonicalDecision({ ...tradeReady(), netEVPct: -0.1 });
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reason).toBe("NEGATIVE_NET_EV");
  });

  it("untrained model cannot lend conviction → WAIT", () => {
    const r = resolveCanonicalDecision({ ...tradeReady(), modelState: "UNTRAINED" });
    expect(r.decision).toBe("WAIT");
    expect(r.reason).toBe("UNTRAINED_MODEL");
  });

  it("shadow model is not live-eligible → WAIT", () => {
    expect(resolveCanonicalDecision({ ...tradeReady(), modelState: "SHADOW" }).reason).toBe("UNTRAINED_MODEL");
  });

  it("missing calibration → WAIT", () => {
    const r = resolveCanonicalDecision({ ...tradeReady(), calibrationAvailable: false });
    expect(r.decision).toBe("WAIT");
    expect(r.reason).toBe("CALIBRATION_UNAVAILABLE");
  });

  it("fails 2x cost stress → NO_TRADE", () => {
    expect(resolveCanonicalDecision({ ...tradeReady(), survives2xCost: false }).reason).toBe("FAILS_COST_STRESS");
  });

  it("fragile → WATCH", () => {
    expect(resolveCanonicalDecision({ ...tradeReady(), fragile: true }).reason).toBe("FRAGILE");
  });

  it("insufficient evidence → WATCH", () => {
    expect(resolveCanonicalDecision({ ...tradeReady(), hasSufficientEvidence: false }).reason).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("A+ that fails mandatory gates falls through to VALIDATED_HIGH_EDGE (still TRADE, but not on A+ authority)", () => {
    const r = resolveCanonicalDecision({ ...tradeReady(), allMandatoryGatesPass: false });
    expect(r.decision).toBe("TRADE");
    expect(r.reason).toBe("VALIDATED_HIGH_EDGE");
  });

  it("higher veto always beats a lower one (data failure + negative EV → REJECT, not NO_TRADE)", () => {
    const r = resolveCanonicalDecision({ ...tradeReady(), criticalDataIssue: true, netEVPct: -1, riskBlocked: true });
    expect(r.reason).toBe("CRITICAL_DATA_FAILURE");
  });
});
