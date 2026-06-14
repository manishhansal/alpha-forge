import { describe, expect, it } from "vitest";

import {
  buildLiquidityEdgeSignal,
  buildMaxPainGravitySignal,
  type PositioningInput,
} from "@/features/india/scalping/strategies/positioning-core";
import type { OptionChainAnalytics } from "@/types/india/options";

function analytics(
  over: Partial<OptionChainAnalytics> = {},
): OptionChainAnalytics {
  return {
    pcrOi: 1.0,
    pcrVolume: 1.0,
    maxCeOiStrike: null,
    maxPeOiStrike: null,
    totalCeOi: 0,
    totalPeOi: 0,
    totalCeOiChange: 0,
    totalPeOiChange: 0,
    atmIv: 14,
    maxPain: null,
    ...over,
  };
}

function input(over: Partial<PositioningInput> = {}): PositioningInput {
  return {
    underlying: "NIFTY",
    symbolName: "NIFTY 50",
    timeframe: "5m",
    spot: 22000,
    changePct: 0.5,
    prevClose: 21890,
    analytics: analytics(),
    triggeredAt: Date.parse("2026-05-18T05:30:00Z"),
    ...over,
  };
}

describe("india/scalping/positioning-core — Max-Pain Gravity (IMPG)", () => {
  it("returns null when max pain is unavailable", () => {
    expect(
      buildMaxPainGravitySignal(input({ analytics: analytics({ maxPain: null }) })),
    ).toBeNull();
  });

  it("returns null when price is pinned to max pain (inside the buffer)", () => {
    // spot 22000, maxPain 21999 → drift ≈ 0.005% << 0.4% buffer.
    const sig = buildMaxPainGravitySignal(
      input({ spot: 22000, analytics: analytics({ maxPain: 21999 }) }),
    );
    expect(sig).toBeNull();
  });

  it("fades DOWN (SHORT) toward max pain when spot is above it", () => {
    const sig = buildMaxPainGravitySignal(
      input({ spot: 22300, analytics: analytics({ maxPain: 22000 }) }),
    );
    expect(sig).not.toBeNull();
    expect(sig!.strategyId).toBe("MAX_PAIN_GRAVITY");
    expect(sig!.direction).toBe("SHORT");
    expect(sig!.entry).toBe(22300);
    // target gravitates to the max-pain strike, stop is above entry.
    expect(sig!.target).toBe(22000);
    expect(sig!.stopLoss).toBeGreaterThan(sig!.entry);
    expect(sig!.confidence).toBeGreaterThan(0);
    expect(sig!.confidence).toBeLessThanOrEqual(1);
  });

  it("fades UP (LONG) toward max pain when spot is below it", () => {
    const sig = buildMaxPainGravitySignal(
      input({ spot: 21700, analytics: analytics({ maxPain: 22000 }) }),
    );
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("LONG");
    expect(sig!.target).toBe(22000);
    expect(sig!.stopLoss).toBeLessThan(sig!.entry);
  });

  it("boosts confidence when a confirming OI wall sits in the fade direction", () => {
    const base = buildMaxPainGravitySignal(
      input({ spot: 22300, analytics: analytics({ maxPain: 22000 }) }),
    );
    const withCeil = buildMaxPainGravitySignal(
      input({
        spot: 22300,
        // CE wall right at spot confirms the resistance ceiling for the short.
        analytics: analytics({ maxPain: 22000, maxCeOiStrike: 22300 }),
      }),
    );
    expect(withCeil!.confidence).toBeGreaterThan(base!.confidence);
  });
});

describe("india/scalping/positioning-core — India Liquidity Edge (ILE)", () => {
  it("returns null when no confluence edge clears the threshold", () => {
    // Perfectly neutral chain → no net bull/bear edge.
    const sig = buildLiquidityEdgeSignal(
      input({
        changePct: 0,
        analytics: analytics({ pcrOi: 1.0, maxPain: 22000 }),
      }),
    );
    expect(sig).toBeNull();
  });

  it("fires LONG when bullish confluence stacks (PCR + max pain above + PE floor + rising)", () => {
    const sig = buildLiquidityEdgeSignal(
      input({
        spot: 22000,
        changePct: 0.8,
        analytics: analytics({
          pcrOi: 1.4, // PE writing → bullish
          maxPain: 22200, // above spot → bullish pull
          maxPeOiStrike: 22000, // at the PE floor → support
          totalPeOiChange: 500000,
          totalCeOiChange: 100000, // ΔPE > ΔCE → bullish
        }),
      }),
    );
    expect(sig).not.toBeNull();
    expect(sig!.strategyId).toBe("LIQUIDITY_EDGE");
    expect(sig!.direction).toBe("LONG");
    expect(sig!.target).toBeGreaterThan(sig!.entry);
    expect(sig!.stopLoss).toBeLessThan(sig!.entry);
    expect(sig!.riskReward).toBeCloseTo(2.5, 5);
  });

  it("fires SHORT when bearish confluence stacks (low PCR + max pain below + CE wall + falling)", () => {
    const sig = buildLiquidityEdgeSignal(
      input({
        spot: 22000,
        changePct: -0.7,
        analytics: analytics({
          pcrOi: 0.7, // CE writing → bearish
          maxPain: 21800, // below spot → bearish pull
          maxCeOiStrike: 22000, // at the CE wall → resistance
          totalPeOiChange: 100000,
          totalCeOiChange: 500000, // ΔCE > ΔPE → bearish
        }),
      }),
    );
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("SHORT");
    expect(sig!.target).toBeLessThan(sig!.entry);
    expect(sig!.stopLoss).toBeGreaterThan(sig!.entry);
  });
});
