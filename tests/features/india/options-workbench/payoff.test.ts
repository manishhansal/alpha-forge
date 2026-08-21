/**
 * Failing tests for the Options Strategy Workbench payoff engine.
 *
 * These tests are written BEFORE the implementation exists at
 * src/features/india/options-workbench/payoff.ts.
 * They will fail with a module-not-found error until Task 14.2 is complete.
 *
 * This is the TDD red phase — all tests are expected to FAIL initially.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Import-under-test
// This import will fail with module-not-found until the payoff module is
// created. That is intentional — it confirms the TDD red phase.
// ---------------------------------------------------------------------------
import {
  computePayoff,
} from "@/features/india/options-workbench/payoff";

import type { OptionLeg, StrategyAnalysis } from "@/features/india/options-workbench/payoff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a spot range array centred around `atm` spanning ±range in `steps`
 * evenly-spaced increments.
 */
function spotRange(atm: number, range: number, steps: number): number[] {
  const result: number[] = [];
  for (let i = 0; i <= steps; i++) {
    result.push(atm - range + (2 * range * i) / steps);
  }
  return result;
}

/** Expected Long Call payoff at expiry for a single spot price. */
function longCallPayoff(spot: number, strike: number, premium: number): number {
  return Math.max(0, spot - strike) - premium;
}

/** Expected Short Call payoff at expiry for a single spot price. */
function shortCallPayoff(spot: number, strike: number, premium: number): number {
  return premium - Math.max(0, spot - strike);
}

/** Expected Long Put payoff at expiry for a single spot price. */
function longPutPayoff(spot: number, strike: number, premium: number): number {
  return Math.max(0, strike - spot) - premium;
}

// ---------------------------------------------------------------------------
// Test 1 — Long Call payoff at expiry
// ---------------------------------------------------------------------------

describe("computePayoff — Long Call (Requirement 11.1)", () => {
  const STRIKE = 23000;
  const PREMIUM = 150;
  const ATM = 23000;
  const RANGE = 1500;
  const SPOTS = spotRange(ATM, RANGE, 20);

  const longCallLeg: OptionLeg = {
    strike: STRIKE,
    flag: "CE",
    quantity: 1,    // long
    premium: PREMIUM,
    expiry: "2025-06-26",
  };

  it("payoff at expiry equals max(0, S − K) − premium for 20 spot values", () => {
    const result: StrategyAnalysis = computePayoff([longCallLeg], SPOTS, [PREMIUM]);

    expect(result.payoffAtExpiry).toHaveLength(SPOTS.length);

    for (let i = 0; i < SPOTS.length; i++) {
      const spot = SPOTS[i];
      const expected = longCallPayoff(spot, STRIKE, PREMIUM);
      const actual = result.payoffAtExpiry[i].pnl;
      expect(actual).toBeCloseTo(expected, 6);
    }
  });

  it("Long Call payoff is negative below break-even (premium lost)", () => {
    const result: StrategyAnalysis = computePayoff([longCallLeg], SPOTS, [PREMIUM]);
    // Below strike, payoff = -premium
    const belowStrike = result.payoffAtExpiry.filter((p) => p.spot < STRIKE);
    for (const point of belowStrike) {
      expect(point.pnl).toBeCloseTo(-PREMIUM, 6);
    }
  });

  it("Long Call payoff is zero at ATM (excluding premium)", () => {
    const atSpot = [STRIKE];
    const result: StrategyAnalysis = computePayoff([longCallLeg], atSpot, [PREMIUM]);
    // At S = K the intrinsic is 0, payoff = -premium
    expect(result.payoffAtExpiry[0].pnl).toBeCloseTo(-PREMIUM, 6);
  });

  it("Long Call payoff increases above strike (unlimited upside)", () => {
    const aboveStrike = SPOTS.filter((s) => s > STRIKE + PREMIUM);
    const aboveStrikePnl = aboveStrike.map((s) => longCallPayoff(s, STRIKE, PREMIUM));
    // All payoffs above break-even should be positive
    expect(aboveStrikePnl.every((p) => p > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Short Call payoff at expiry
// ---------------------------------------------------------------------------

describe("computePayoff — Short Call (Requirement 11.4)", () => {
  const STRIKE = 23000;
  const PREMIUM = 150;
  const ATM = 23000;
  const RANGE = 1500;
  const SPOTS = spotRange(ATM, RANGE, 20);

  const shortCallLeg: OptionLeg = {
    strike: STRIKE,
    flag: "CE",
    quantity: -1,   // short
    premium: PREMIUM,
    expiry: "2025-06-26",
  };

  it("payoff at expiry equals premium − max(0, S − K) for 20 spot values", () => {
    const result: StrategyAnalysis = computePayoff([shortCallLeg], SPOTS, [PREMIUM]);

    expect(result.payoffAtExpiry).toHaveLength(SPOTS.length);

    for (let i = 0; i < SPOTS.length; i++) {
      const spot = SPOTS[i];
      const expected = shortCallPayoff(spot, STRIKE, PREMIUM);
      const actual = result.payoffAtExpiry[i].pnl;
      expect(actual).toBeCloseTo(expected, 6);
    }
  });

  it("Short Call has maximum profit of premium when S ≤ K", () => {
    const belowOrAtStrike = SPOTS.filter((s) => s <= STRIKE);
    const result: StrategyAnalysis = computePayoff([shortCallLeg], belowOrAtStrike, [PREMIUM]);
    for (const point of result.payoffAtExpiry) {
      expect(point.pnl).toBeCloseTo(PREMIUM, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Straddle max loss = −(call_premium + put_premium) at ATM
// ---------------------------------------------------------------------------

describe("computePayoff — Straddle max loss (Requirement 11.2)", () => {
  const STRIKE = 23000;
  const CALL_PREMIUM = 200;
  const PUT_PREMIUM = 190;

  const straddle: OptionLeg[] = [
    { strike: STRIKE, flag: "CE", quantity: 1, premium: CALL_PREMIUM, expiry: "2025-06-26" },
    { strike: STRIKE, flag: "PE", quantity: 1, premium: PUT_PREMIUM, expiry: "2025-06-26" },
  ];

  it("max loss equals −(call_premium + put_premium) at ATM (exact)", () => {
    // At ATM (S = K), both options expire worthless — max loss of premium paid.
    const atAtm = [STRIKE];
    const result: StrategyAnalysis = computePayoff(straddle, atAtm, [CALL_PREMIUM, PUT_PREMIUM]);

    const expectedMaxLoss = -(CALL_PREMIUM + PUT_PREMIUM);
    expect(result.payoffAtExpiry[0].pnl).toBeCloseTo(expectedMaxLoss, 6);
  });

  it("maxLoss in StrategyAnalysis equals −(call_premium + put_premium)", () => {
    const SPOTS = spotRange(STRIKE, 2000, 20);
    const result: StrategyAnalysis = computePayoff(straddle, SPOTS, [CALL_PREMIUM, PUT_PREMIUM]);

    const expectedMaxLoss = -(CALL_PREMIUM + PUT_PREMIUM);
    // maxLoss field in StrategyAnalysis must equal the theoretical max loss.
    expect(result.maxLoss).toBeCloseTo(expectedMaxLoss, 6);
  });

  it("Straddle has exactly 2 break-even points", () => {
    // Long straddle: BE = K ± (call_prem + put_prem)
    const SPOTS = spotRange(STRIKE, 2000, 200);  // fine resolution
    const result: StrategyAnalysis = computePayoff(straddle, SPOTS, [CALL_PREMIUM, PUT_PREMIUM]);

    // Requirement 11.5: break-even count for a Straddle = 2
    expect(result.breakEvens).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Iron Condor payoff at centre = net credit received (exact)
// ---------------------------------------------------------------------------

describe("computePayoff — Iron Condor centre payoff (Requirement 11.3)", () => {
  /**
   * Iron Condor:
   *   Sell 22800 PE (+pe_premium),  Buy 22600 PE (−pe_long_premium)
   *   Sell 23200 CE (+ce_premium),  Buy 23400 CE (−ce_long_premium)
   *
   * Net credit = sum of all premiums × their signs
   */
  const ATM = 23000;
  const SHORT_PE_STRIKE = 22800;
  const LONG_PE_STRIKE = 22600;
  const SHORT_CE_STRIKE = 23200;
  const LONG_CE_STRIKE = 23400;

  // Premiums (realistic for NIFTY)
  const SHORT_PE_PREM = 80;   // sold — receive credit
  const LONG_PE_PREM = 40;    // bought — pay debit
  const SHORT_CE_PREM = 75;   // sold — receive credit
  const LONG_CE_PREM = 35;    // bought — pay debit

  const NET_CREDIT = SHORT_PE_PREM - LONG_PE_PREM + SHORT_CE_PREM - LONG_CE_PREM;
  // = 80 - 40 + 75 - 35 = 80

  const ironCondor: OptionLeg[] = [
    { strike: SHORT_PE_STRIKE, flag: "PE", quantity: -1, premium: SHORT_PE_PREM, expiry: "2025-06-26" },
    { strike: LONG_PE_STRIKE,  flag: "PE", quantity:  1, premium: LONG_PE_PREM,  expiry: "2025-06-26" },
    { strike: SHORT_CE_STRIKE, flag: "CE", quantity: -1, premium: SHORT_CE_PREM, expiry: "2025-06-26" },
    { strike: LONG_CE_STRIKE,  flag: "CE", quantity:  1, premium: LONG_CE_PREM,  expiry: "2025-06-26" },
  ];

  const premiums = [SHORT_PE_PREM, LONG_PE_PREM, SHORT_CE_PREM, LONG_CE_PREM];

  it("payoff at centre (ATM) equals net credit received (exact)", () => {
    const result: StrategyAnalysis = computePayoff(ironCondor, [ATM], premiums);

    // At the centre between short strikes all options expire worthless.
    // Payoff = net credit received.
    expect(result.payoffAtExpiry[0].pnl).toBeCloseTo(NET_CREDIT, 6);
  });

  it("maxProfit in StrategyAnalysis equals net credit received", () => {
    const SPOTS = spotRange(ATM, 1000, 50);
    const result: StrategyAnalysis = computePayoff(ironCondor, SPOTS, premiums);

    expect(result.maxProfit).toBeCloseTo(NET_CREDIT, 6);
  });

  it("payoff is positive between the two short strikes", () => {
    // Use a range strictly inside [SHORT_PE_STRIKE=22800, SHORT_CE_STRIKE=23200]
    // spotRange(ATM, 150, 10) → [22850 … 23150], all between the short strikes.
    const centreSpotsOnly = spotRange(ATM, 150, 10);
    const result: StrategyAnalysis = computePayoff(ironCondor, centreSpotsOnly, premiums);

    for (const point of result.payoffAtExpiry) {
      expect(point.pnl).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Long Put payoff at expiry
// ---------------------------------------------------------------------------

describe("computePayoff — Long Put (Requirement 11.4)", () => {
  const STRIKE = 23000;
  const PREMIUM = 160;
  const ATM = 23000;
  const RANGE = 1500;
  const SPOTS = spotRange(ATM, RANGE, 20);

  const longPutLeg: OptionLeg = {
    strike: STRIKE,
    flag: "PE",
    quantity: 1,    // long
    premium: PREMIUM,
    expiry: "2025-06-26",
  };

  it("payoff at expiry equals max(0, K − S) − premium for 20 spot values", () => {
    const result: StrategyAnalysis = computePayoff([longPutLeg], SPOTS, [PREMIUM]);

    expect(result.payoffAtExpiry).toHaveLength(SPOTS.length);

    for (let i = 0; i < SPOTS.length; i++) {
      const spot = SPOTS[i];
      const expected = longPutPayoff(spot, STRIKE, PREMIUM);
      const actual = result.payoffAtExpiry[i].pnl;
      expect(actual).toBeCloseTo(expected, 6);
    }
  });

  it("Long Put payoff is negative above break-even (premium lost)", () => {
    const aboveStrike = SPOTS.filter((s) => s >= STRIKE);
    const result: StrategyAnalysis = computePayoff([longPutLeg], aboveStrike, [PREMIUM]);
    for (const point of result.payoffAtExpiry) {
      expect(point.pnl).toBeCloseTo(-PREMIUM, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Break-even counts: Long Call → 1, Straddle → 2
// ---------------------------------------------------------------------------

describe("computePayoff — break-even counts (Requirement 11.5)", () => {
  it("Long Call has exactly 1 break-even point", () => {
    const STRIKE = 23000;
    const PREMIUM = 150;
    const SPOTS = spotRange(STRIKE, 2000, 200);

    const longCall: OptionLeg = {
      strike: STRIKE,
      flag: "CE",
      quantity: 1,
      premium: PREMIUM,
      expiry: "2025-06-26",
    };

    const result: StrategyAnalysis = computePayoff([longCall], SPOTS, [PREMIUM]);

    // Long Call has exactly one break-even: K + premium
    expect(result.breakEvens).toHaveLength(1);
    expect(result.breakEvens[0]).toBeCloseTo(STRIKE + PREMIUM, 0);
  });

  it("Straddle has exactly 2 break-even points", () => {
    const STRIKE = 23000;
    const CALL_PREM = 200;
    const PUT_PREM = 190;
    const SPOTS = spotRange(STRIKE, 2000, 200);

    const straddle: OptionLeg[] = [
      { strike: STRIKE, flag: "CE", quantity: 1, premium: CALL_PREM, expiry: "2025-06-26" },
      { strike: STRIKE, flag: "PE", quantity: 1, premium: PUT_PREM, expiry: "2025-06-26" },
    ];

    const result: StrategyAnalysis = computePayoff(straddle, SPOTS, [CALL_PREM, PUT_PREM]);

    // Straddle BEs: K − (CP + PP) and K + (CP + PP)
    expect(result.breakEvens).toHaveLength(2);
    const totalPrem = CALL_PREM + PUT_PREM;
    expect(result.breakEvens[0]).toBeCloseTo(STRIKE - totalPrem, 0);
    expect(result.breakEvens[1]).toBeCloseTo(STRIKE + totalPrem, 0);
  });
});
