/**
 * Tests for the promotion-gate state machine (Phase 33).
 *
 * Key invariants:
 *   • default (nothing proven) → PAPER
 *   • all 18 gates pass → PRODUCTION_CANDIDATE (never auto-PRODUCTION)
 *   • a catastrophic (P0) gate failing → HALTED
 *   • the CURRENT real evidence yields PAPER/HALTED, never PRODUCTION
 */

import { describe, it, expect } from "vitest";
import {
  evaluatePromotion,
  emptyGateInputs,
  MANDATORY_GATES,
  type GateInputs,
} from "@/lib/india/promotion-gates";

function allPass(): GateInputs {
  const out = {} as GateInputs;
  for (const g of MANDATORY_GATES) out[g] = { passed: true, reason: "ok" };
  return out;
}

describe("promotion gate machine", () => {
  it("has exactly 18 mandatory gates", () => {
    expect(MANDATORY_GATES.length).toBe(18);
  });

  it("default (nothing demonstrated) → HALTED, not production-eligible", () => {
    // Conservative safety posture: if the absence of leakage / data corruption
    // (the catastrophic gates) cannot be demonstrated, the system must NOT run.
    // "Not proven safe" is treated as "unsafe" → HALTED, never PRODUCTION.
    const e = evaluatePromotion(emptyGateInputs());
    expect(e.state).toBe("HALTED");
    expect(e.productionEligible).toBe(false);
    expect(e.failedGates.length).toBe(18);
  });

  it("all gates pass → PRODUCTION_CANDIDATE (never auto PRODUCTION)", () => {
    const e = evaluatePromotion(allPass());
    expect(e.state).toBe("PRODUCTION_CANDIDATE");
    expect(e.productionEligible).toBe(true);
    // the machine never returns PRODUCTION on its own
    expect(e.state).not.toBe("PRODUCTION");
  });

  it("a catastrophic (P0) gate failing → HALTED", () => {
    const g = allPass();
    g.noP0Leakage = { passed: false, reason: "look-ahead found" };
    const e = evaluatePromotion(g);
    expect(e.state).toBe("HALTED");
  });

  it("a non-catastrophic gate failing → PAPER", () => {
    const g = allPass();
    g.positiveNetExpectancy = { passed: false, reason: "negative expectancy" };
    const e = evaluatePromotion(g);
    expect(e.state).toBe("PAPER");
    expect(e.productionEligible).toBe(false);
  });

  it("the CURRENT real evidence yields PAPER (not production)", () => {
    // Model the audited reality at commit 1c2941b.
    const g = emptyGateInputs();
    // Things that genuinely pass today:
    g.noP0Leakage = { passed: true, reason: "conservative both-touched→stop resolver" };
    g.noP0DataCorruption = { passed: true, reason: "provider provenance + reconciliation exact; no direct NSE" };
    g.dataProviderFailoverVerified = { passed: true, reason: "registry+failover unit-tested" };
    g.durablePredictionPersistence = { passed: true, reason: "PrismaSignalRecordStore added (not yet wired)" };
    g.durableOutcomePersistence = { passed: true, reason: "IndiaResolutionRecord added (not yet wired)" };
    // Everything else remains failed: no OOS edge, negative expectancy, unwired,
    // no monotonicity evidence, etc.
    const e = evaluatePromotion(g);
    expect(e.state).toBe("PAPER");
    expect(e.productionEligible).toBe(false);
    expect(e.failedGates).toContain("positiveNetExpectancy");
    expect(e.failedGates).toContain("qualityMonotonicity");
    expect(e.failedGates).toContain("runtimeIntegrationVerified");
  });
});
