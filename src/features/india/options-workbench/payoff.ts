/**
 * Options Strategy Workbench — Payoff Engine & Greeks Aggregator
 *
 * Pure TypeScript implementation. No external dependencies.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OptionLeg {
  strike: number;
  flag: "CE" | "PE";
  quantity: number; // positive = long, negative = short
  premium: number;
  expiry: string;
}

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface StrategyAnalysis {
  payoffAtExpiry: { spot: number; pnl: number }[];
  payoffToday: { spot: number; pnl: number }[]; // same as expiry for simplicity
  breakEvens: number[];
  netGreeks: { delta: number; gamma: number; theta: number; vega: number };
  maxProfit: number;
  maxLoss: number;
}

// ---------------------------------------------------------------------------
// computePayoff
// ---------------------------------------------------------------------------

/**
 * Compute the full strategy analysis for a set of option legs across a spot range.
 *
 * Payoff formula (per leg, at expiry):
 *   CE: pnl += quantity * (max(0, S − strike) − premium)
 *   PE: pnl += quantity * (max(0, strike − S) − premium)
 *
 * Break-even detection uses linear interpolation between adjacent spot points
 * where the sign of the payoff changes.
 *
 * @param legs        Array of option legs defining the strategy
 * @param spotRange   Array of spot prices to evaluate payoff at
 * @param premiums    Array of premiums, one per leg (same order as legs)
 */
export function computePayoff(
  legs: OptionLeg[],
  spotRange: number[],
  premiums: number[]
): StrategyAnalysis {
  // Build payoff at expiry for each spot
  const payoffAtExpiry: { spot: number; pnl: number }[] = spotRange.map(
    (spot) => {
      let pnl = 0;
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const premium = premiums[i];
        const intrinsic =
          leg.flag === "CE"
            ? Math.max(0, spot - leg.strike)
            : Math.max(0, leg.strike - spot);
        pnl += leg.quantity * (intrinsic - premium);
      }
      return { spot, pnl };
    }
  );

  // payoffToday is the same as expiry for simplicity (no BS pricing)
  const payoffToday = payoffAtExpiry.map((p) => ({ ...p }));

  // Break-even detection via linear interpolation between sign crossings
  const breakEvens: number[] = [];
  const pnls = payoffAtExpiry.map((p) => p.pnl);
  for (let i = 0; i < pnls.length - 1; i++) {
    const p0 = pnls[i];
    const p1 = pnls[i + 1];
    if (p0 * p1 < 0) {
      // Sign change — interpolate
      const s0 = spotRange[i];
      const s1 = spotRange[i + 1];
      const be = s0 + (0 - p0) * ((s1 - s0) / (p1 - p0));
      breakEvens.push(be);
    }
  }

  // Aggregate max profit / max loss from the payoff curve
  const maxProfit = Math.max(...pnls);
  const maxLoss = Math.min(...pnls);

  // Net greeks — placeholder zeros (real greeks come from aggregateGreeks)
  const netGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };

  return {
    payoffAtExpiry,
    payoffToday,
    breakEvens,
    netGreeks,
    maxProfit,
    maxLoss,
  };
}

// ---------------------------------------------------------------------------
// aggregateGreeks
// ---------------------------------------------------------------------------

/**
 * Aggregate net greeks across all legs.
 *
 * For each leg: net_greek += quantity * greeksPerLeg[i][greek]
 *
 * Short positions (negative quantity) naturally negate the sign.
 *
 * @param legs          Array of option legs
 * @param greeksPerLeg  Greeks per leg, in the same order as legs
 */
export function aggregateGreeks(
  legs: OptionLeg[],
  greeksPerLeg: Greeks[]
): { delta: number; gamma: number; theta: number; vega: number } {
  let delta = 0;
  let gamma = 0;
  let theta = 0;
  let vega = 0;

  for (let i = 0; i < legs.length; i++) {
    const { quantity } = legs[i];
    const g = greeksPerLeg[i];
    delta += quantity * g.delta;
    gamma += quantity * g.gamma;
    theta += quantity * g.theta;
    vega += quantity * g.vega;
  }

  return { delta, gamma, theta, vega };
}
