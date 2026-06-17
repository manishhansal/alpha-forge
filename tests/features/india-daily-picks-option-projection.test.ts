import { describe, expect, it } from "vitest";

import {
  INDEX_LOT_SIZE,
  INDEX_STRIKE_STEP,
  livePremiumForContract,
  projectIndexScalpToOption,
  type OptionContract,
} from "@/features/india/daily-picks/option-projection";
import type { AiSignal } from "@/types/ai-signals";
import type { OptionChain, OptionChainRow, OptionLeg } from "@/types/india";

function leg(
  patch: Partial<OptionLeg> & { ltp?: number | null; delta?: number | null },
): OptionLeg {
  return {
    strike: 0,
    type: "CE",
    oi: 0,
    changeInOi: 0,
    volume: 0,
    iv: null,
    ltp: 100,
    bid: null,
    ask: null,
    ...patch,
  } as OptionLeg;
}

function row(
  strike: number,
  ce: Partial<OptionLeg> | null,
  pe: Partial<OptionLeg> | null,
): OptionChainRow {
  return {
    strike,
    ce: ce ? { ...leg({ ...ce }), strike, type: "CE" } : null,
    pe: pe ? { ...leg({ ...pe }), strike, type: "PE" } : null,
  };
}

function chain(opts: {
  spot: number;
  rows: OptionChainRow[];
  expiry?: string;
}): OptionChain {
  return {
    symbol: "NIFTY",
    spot: opts.spot,
    expiry: opts.expiry ?? "26-Jun-2026",
    expiries: [opts.expiry ?? "26-Jun-2026"],
    rows: opts.rows,
    analytics: {
      pcrOi: null,
      pcrVolume: null,
      maxCeOiStrike: null,
      maxPeOiStrike: null,
      totalCeOi: 0,
      totalPeOi: 0,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
      atmIv: null,
      maxPain: null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

function makeSignal(
  patch: Partial<AiSignal> & {
    direction?: AiSignal["direction"];
    entry?: number;
    stopLoss?: number;
    target?: number;
    stretch?: number;
  } = {},
): AiSignal {
  const entry = patch.entry ?? 24080;
  const stop = patch.stopLoss ?? 23866;
  const target = patch.target ?? 24337;
  const stretch = patch.stretch ?? 24500;
  return {
    direction: patch.direction ?? "BULLISH",
    entry,
    stopLoss: stop,
    underlyingPrice: entry,
    riskReward: 2,
    takeProfits: [
      { level: 1, price: target, percent: 1, allocation: 0.5 },
      { level: 3, price: stretch, percent: 2, allocation: 0.25 },
    ],
    ...patch,
  } as AiSignal;
}

describe("projectIndexScalpToOption", () => {
  it("snaps to the ATM strike and picks CE for a bullish signal", () => {
    // Spot 24080 → nearest 50-step strike is 24100.
    const c = chain({
      spot: 24080,
      rows: [
        row(24050, { ltp: 130 }, { ltp: 90 }),
        row(24100, { ltp: 100, delta: 0.5 }, { ltp: 110, delta: -0.5 }),
        row(24150, { ltp: 80 }, { ltp: 130 }),
      ],
    });
    const proj = projectIndexScalpToOption(makeSignal(), c, "NIFTY");
    expect(proj).not.toBeNull();
    expect(proj?.contract.strike).toBe(24100);
    expect(proj?.contract.side).toBe("CE");
    expect(proj?.contract.contractSymbol).toBe("NIFTY 24100 CE");
    expect(proj?.contract.lotSize).toBe(INDEX_LOT_SIZE.NIFTY);
    expect(proj?.entryPremium).toBe(100);
  });

  it("picks PE for a bearish signal", () => {
    const c = chain({
      spot: 24080,
      rows: [row(24100, { ltp: 100 }, { ltp: 110, delta: -0.45 })],
    });
    const proj = projectIndexScalpToOption(
      makeSignal({ direction: "BEARISH", target: 23800, stretch: 23600 }),
      c,
      "NIFTY",
    );
    expect(proj?.contract.side).toBe("PE");
    expect(proj?.entryPremium).toBe(110);
  });

  it("projects the target premium UP and the stop premium DOWN for a CE long", () => {
    // ATM call entry 100, delta 0.5, spot 24080. Target 24337 (+257) →
    // premium ≈ 100 + 0.5*257 = 228.5. Stop 23866 (-214) → ≈ 100 + 0.5*(-214) = -7
    // floored at MIN_PREMIUM (0.05).
    const c = chain({
      spot: 24080,
      rows: [row(24100, { ltp: 100, delta: 0.5 }, { ltp: 110, delta: -0.5 })],
    });
    const proj = projectIndexScalpToOption(makeSignal(), c, "NIFTY");
    expect(proj?.targetPremium).toBeCloseTo(228.5, 1);
    expect(proj?.stopPremium).toBeCloseTo(0.05, 2);
    // R:R falls back to the underlying R:R when the stop floors out at min
    // premium (extreme tail case).
    expect(proj?.riskReward).toBeGreaterThan(0);
  });

  it("uses bid/ask midpoint when LTP is missing, then drops the pick if no quote", () => {
    const c = chain({
      spot: 24080,
      rows: [
        row(24100, { ltp: null, bid: 90, ask: 110, delta: 0.5 }, { ltp: 100 }),
      ],
    });
    const proj = projectIndexScalpToOption(makeSignal(), c, "NIFTY");
    expect(proj?.entryPremium).toBe(100); // (90 + 110) / 2

    const dead = chain({
      spot: 24080,
      rows: [row(24100, { ltp: null, bid: null, ask: null }, { ltp: 100 })],
    });
    expect(projectIndexScalpToOption(makeSignal(), dead, "NIFTY")).toBeNull();
  });

  it("returns null on an empty chain", () => {
    const c = chain({ spot: 24080, rows: [] });
    expect(projectIndexScalpToOption(makeSignal(), c, "NIFTY")).toBeNull();
  });

  it("drops the pick when chain spot disagrees with the signal underlying (>5% drift)", () => {
    // Regression for the 2026-06-17 MIDCPNIFTY incident: signal underlying
    // was 17660 but the option-chain endpoint returned spot=14575 (a
    // ticker-mapping mismatch). Projecting against disagreeing references
    // produced a stop at ₹1640 on an entry of ₹197 — total nonsense. The
    // projection now refuses to ship.
    const c = chain({
      spot: 14575,
      rows: [row(14600, { ltp: 200, delta: 0.5 }, { ltp: 210 })],
    });
    const sig = makeSignal({
      entry: 17660,
      underlyingPrice: 17660,
      target: 17884,
      stretch: 18000,
      stopLoss: 17463,
    });
    expect(projectIndexScalpToOption(sig, c, "MIDCPNIFTY")).toBeNull();
  });

  it("tolerates small intraday drift (<5%) between chain spot and signal underlying", () => {
    // Real-world: signal generated a moment before the chain snapshot. A
    // half-percent drift is normal and must NOT drop the pick.
    const c = chain({
      spot: 24080,
      rows: [row(24100, { ltp: 100, delta: 0.5 }, { ltp: 110 })],
    });
    const sig = makeSignal({ entry: 24190, underlyingPrice: 24190 }); // ~0.46% drift
    expect(projectIndexScalpToOption(sig, c, "NIFTY")).not.toBeNull();
  });

  it("prefers the SIGNAL's underlying price (live Yahoo quote) to pick the ATM strike", () => {
    // The signal is computed from a live quote; chain.spot can lag by 5-30s.
    // ATM strike must come from the freshest source. With signal=24190 and
    // chain.spot=24080 we should pick the strike closest to 24190 (=24200),
    // not 24100 (closest to chain.spot).
    const c = chain({
      spot: 24080,
      rows: [
        row(24100, { ltp: 110, delta: 0.55 }, { ltp: 90 }),
        row(24200, { ltp: 60, delta: 0.45 }, { ltp: 140 }),
      ],
    });
    const sig = makeSignal({ entry: 24190, underlyingPrice: 24190 });
    const proj = projectIndexScalpToOption(sig, c, "NIFTY");
    expect(proj?.contract.strike).toBe(24200);
  });

  it("falls back to ATM delta when chain greeks are unavailable", () => {
    const c = chain({
      spot: 24080,
      rows: [row(24100, { ltp: 100, delta: null }, { ltp: 110 })],
    });
    const proj = projectIndexScalpToOption(makeSignal(), c, "NIFTY");
    // Default 0.5 delta → +50% of the +257 underlying move ≈ 128.5
    expect(proj?.targetPremium).toBeCloseTo(228.5, 1);
    expect(proj?.contract.delta).toBe(0.5);
  });

  it("respects the per-index strike step (BANKNIFTY → 100)", () => {
    expect(INDEX_STRIKE_STEP.BANKNIFTY).toBe(100);
    const c = chain({
      spot: 57610,
      rows: [
        row(57500, { ltp: 200 }, { ltp: 150 }),
        row(57600, { ltp: 150, delta: 0.5 }, { ltp: 200, delta: -0.5 }),
        row(57700, { ltp: 110 }, { ltp: 250 }),
      ],
    });
    const proj = projectIndexScalpToOption(
      makeSignal({ entry: 57610, target: 57900, stopLoss: 57400 }),
      c,
      "BANKNIFTY",
    );
    expect(proj?.contract.strike).toBe(57600);
    expect(proj?.contract.lotSize).toBe(INDEX_LOT_SIZE.BANKNIFTY);
  });
});

describe("livePremiumForContract", () => {
  function makeContract(side: "CE" | "PE" = "CE"): OptionContract {
    return {
      strike: 24100,
      side,
      expiry: "26-Jun-2026",
      contractSymbol: "NIFTY 24100 CE",
      lotSize: 75,
      spotAtFreeze: 24080,
      delta: 0.5,
      ivPct: 14,
    };
  }

  it("returns the latest LTP for the stored strike + side", () => {
    const c = chain({
      spot: 24130,
      rows: [row(24100, { ltp: 145 }, { ltp: 75 })],
    });
    expect(livePremiumForContract(makeContract("CE"), c)).toBe(145);
    expect(livePremiumForContract(makeContract("PE"), c)).toBe(75);
  });

  it("returns null when the chain is missing or the strike isn't quoted", () => {
    expect(livePremiumForContract(makeContract(), null)).toBeNull();
    const empty = chain({ spot: 24080, rows: [] });
    expect(livePremiumForContract(makeContract(), empty)).toBeNull();
  });
});
