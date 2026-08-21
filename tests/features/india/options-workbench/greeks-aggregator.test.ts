/**
 * Failing tests for the Options Strategy Workbench greeks aggregator.
 *
 * These tests are written BEFORE the implementation exists at
 * src/features/india/options-workbench/payoff.ts.
 * They will fail with a module-not-found error until Task 14.2 is complete.
 *
 * This is the TDD red phase — all tests are expected to FAIL initially.
 *
 * Validates: Requirements 11.6
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Import-under-test
// This import will fail with module-not-found until the payoff module is
// created. That is intentional — it confirms the TDD red phase.
// ---------------------------------------------------------------------------
import {
  aggregateGreeks,
} from "@/features/india/options-workbench/payoff";

import type { Greeks, OptionLeg } from "@/features/india/options-workbench/payoff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGreeks(
  delta: number,
  gamma = 0.002,
  theta = -5.0,
  vega = 2.0,
): Greeks {
  return { delta, gamma, theta, vega };
}

// ---------------------------------------------------------------------------
// Test 1 — Net delta of a delta-neutral combination ≈ 0 (within 0.05)
// ---------------------------------------------------------------------------

describe("aggregateGreeks — delta-neutral strategy net delta ≈ 0 (Requirement 11.6)", () => {
  /**
   * A classic delta-neutral Straddle (long ATM call + long ATM put) has
   * net delta ≈ 0 at initiation because:
   *   ATM call delta ≈ +0.50
   *   ATM put delta  ≈ −0.50
   *   Net delta ≈ 0.00 (within ±0.05 per design spec)
   *
   * **Validates: Requirements 11.6**
   */

  it("ATM Straddle net delta is approximately 0 (within 0.05)", () => {
    const STRIKE = 23000;

    const straddle: OptionLeg[] = [
      { strike: STRIKE, flag: "CE", quantity: 1, premium: 200, expiry: "2025-06-26" },
      { strike: STRIKE, flag: "PE", quantity: 1, premium: 190, expiry: "2025-06-26" },
    ];

    const greeksPerLeg: Greeks[] = [
      makeGreeks(0.50),   // ATM call delta ≈ 0.50
      makeGreeks(-0.50),  // ATM put delta ≈ -0.50
    ];

    const net = aggregateGreeks(straddle, greeksPerLeg);

    // Per design postconditions: "Net delta of a delta-neutral strategy ≈ 0 (within 0.05)"
    expect(Math.abs(net.delta)).toBeLessThanOrEqual(0.05);
  });

  it("short Straddle net delta is also approximately 0 (within 0.05)", () => {
    const STRIKE = 23000;

    const shortStraddle: OptionLeg[] = [
      { strike: STRIKE, flag: "CE", quantity: -1, premium: 200, expiry: "2025-06-26" },
      { strike: STRIKE, flag: "PE", quantity: -1, premium: 190, expiry: "2025-06-26" },
    ];

    // Short position negates delta signs
    const greeksPerLeg: Greeks[] = [
      makeGreeks(0.50),   // call delta (engine should apply quantity sign)
      makeGreeks(-0.50),  // put delta
    ];

    const net = aggregateGreeks(shortStraddle, greeksPerLeg);

    expect(Math.abs(net.delta)).toBeLessThanOrEqual(0.05);
  });

  it("returns net delta, gamma, theta, and vega fields", () => {
    const leg: OptionLeg = {
      strike: 23000,
      flag: "CE",
      quantity: 1,
      premium: 200,
      expiry: "2025-06-26",
    };
    const greeks: Greeks = makeGreeks(0.50, 0.003, -6.0, 2.5);

    const net = aggregateGreeks([leg], [greeks]);

    expect(net).toHaveProperty("delta");
    expect(net).toHaveProperty("gamma");
    expect(net).toHaveProperty("theta");
    expect(net).toHaveProperty("vega");
  });

  it("single Long Call aggregates greeks with quantity=1 (no sign flip)", () => {
    const leg: OptionLeg = {
      strike: 23000,
      flag: "CE",
      quantity: 1,
      premium: 200,
      expiry: "2025-06-26",
    };
    const greeks: Greeks = makeGreeks(0.48, 0.003, -6.0, 2.5);

    const net = aggregateGreeks([leg], [greeks]);

    expect(net.delta).toBeCloseTo(0.48, 5);
    expect(net.gamma).toBeCloseTo(0.003, 5);
    expect(net.theta).toBeCloseTo(-6.0, 5);
    expect(net.vega).toBeCloseTo(2.5, 5);
  });

  it("single Short Call aggregates greeks with quantity=-1 (sign flip)", () => {
    const leg: OptionLeg = {
      strike: 23000,
      flag: "CE",
      quantity: -1,   // short
      premium: 200,
      expiry: "2025-06-26",
    };
    const greeks: Greeks = makeGreeks(0.48, 0.003, -6.0, 2.5);

    const net = aggregateGreeks([leg], [greeks]);

    // Short reverses signs: delta = -0.48, gamma = -0.003, theta = 6.0, vega = -2.5
    expect(net.delta).toBeCloseTo(-0.48, 5);
    expect(net.gamma).toBeCloseTo(-0.003, 5);
    expect(net.theta).toBeCloseTo(6.0, 5);
    expect(net.vega).toBeCloseTo(-2.5, 5);
  });

  it("multi-leg Bull Call Spread net delta is between 0 and 1", () => {
    /**
     * Bull Call Spread:
     *   Buy 22900 CE (delta ≈ 0.55) + Sell 23100 CE (delta ≈ 0.45)
     *   Net delta = 0.55 - 0.45 = 0.10 (positive, but less than 1.0)
     */
    const legs: OptionLeg[] = [
      { strike: 22900, flag: "CE", quantity:  1, premium: 180, expiry: "2025-06-26" },
      { strike: 23100, flag: "CE", quantity: -1, premium: 80,  expiry: "2025-06-26" },
    ];
    const greeksPerLeg: Greeks[] = [
      makeGreeks(0.55, 0.004, -7.0, 3.0),
      makeGreeks(0.45, 0.004, -6.0, 3.0),
    ];

    const net = aggregateGreeks(legs, greeksPerLeg);

    expect(net.delta).toBeGreaterThan(0);
    expect(net.delta).toBeLessThan(1);
    expect(net.delta).toBeCloseTo(0.10, 5);
  });

  it("Iron Condor net delta is approximately 0 at initiation", () => {
    /**
     * A balanced Iron Condor with symmetric strikes:
     *   Long 22600 PE  delta ≈ -0.15
     *   Short 22800 PE delta ≈ -0.25  (short → +0.25)
     *   Short 23200 CE delta ≈ +0.25  (short → -0.25)
     *   Long 23400 CE  delta ≈ +0.15
     * Net delta = -0.15 + 0.25 - 0.25 + 0.15 = 0.00
     */
    const legs: OptionLeg[] = [
      { strike: 22600, flag: "PE", quantity:  1, premium: 40,  expiry: "2025-06-26" },
      { strike: 22800, flag: "PE", quantity: -1, premium: 80,  expiry: "2025-06-26" },
      { strike: 23200, flag: "CE", quantity: -1, premium: 75,  expiry: "2025-06-26" },
      { strike: 23400, flag: "CE", quantity:  1, premium: 35,  expiry: "2025-06-26" },
    ];
    const greeksPerLeg: Greeks[] = [
      makeGreeks(-0.15, 0.003, -3.5, 1.5),   // long put
      makeGreeks(-0.25, 0.004, -5.0, 2.5),   // short put (engine applies quantity sign)
      makeGreeks( 0.25, 0.004, -5.0, 2.5),   // short call
      makeGreeks( 0.15, 0.003, -3.5, 1.5),   // long call
    ];

    const net = aggregateGreeks(legs, greeksPerLeg);

    // Balanced Iron Condor net delta ≈ 0 within ±0.05
    expect(Math.abs(net.delta)).toBeLessThanOrEqual(0.05);
  });
});
