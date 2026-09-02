/**
 * Tests — Market Context Engine (Phase 6)
 *
 * Verifies NIFTY trend, VIX regime, breadth, gap analysis,
 * regime derivation, and context alignment scoring.
 */

import { describe, it, expect } from "vitest";
import {
  buildMarketContextSnapshot,
  scoreContextAlignment,
} from "@/lib/signal-intelligence/market-context-engine";
import type { MarketContextInput } from "@/lib/signal-intelligence/market-context-engine";

function makeInput(overrides: Partial<MarketContextInput> = {}): MarketContextInput {
  return {
    niftyLtp: 24500,
    niftyPrevClose: 24300,
    niftyChangePct: 0.82,
    niftyHigh: 24600,
    niftyLow: 24200,
    niftyOpen: 24350,
    niftyVolume: 150_000_000,
    niftyAvgVolume20d: 100_000_000,
    niftyDailyCandles: Array.from({ length: 20 }, (_, i) => ({
      time: 1725000000 + i * 86400,
      open: 24000 + i * 50,
      high: 24100 + i * 50,
      low: 23900 + i * 50,
      close: 24050 + i * 50,
      volume: 100_000_000,
    })),
    niftyIntradayCandles: Array.from({ length: 12 }, (_, i) => ({
      time: 1725148500 + i * 300, // 09:15 IST onwards
      open: 24350 + i * 10,
      high: 24370 + i * 10,
      low: 24330 + i * 10,
      close: 24360 + i * 10,
      volume: 5_000_000,
    })),
    bankniftyChangePct: 1.1,
    bankniftyLtp: 52000,
    indiaVix: 13.5,
    indiaVixPrevClose: 13.0,
    advancingCount: 380,
    decliningCount: 120,
    sessionOpenMs: 1725148500000, // 09:15 IST
    nowMs: 1725163200000, // ~11:20 IST
    ...overrides,
  };
}

describe("buildMarketContextSnapshot", () => {
  it("computes NIFTY trend correctly for +0.82% change", () => {
    const ctx = buildMarketContextSnapshot(makeInput());
    expect(ctx.niftyTrend).toBe("UP");
  });

  it("computes STRONG_UP for large positive move", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ niftyChangePct: 2.5 }));
    expect(ctx.niftyTrend).toBe("STRONG_UP");
  });

  it("computes STRONG_DOWN for large negative move", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ niftyChangePct: -2.5 }));
    expect(ctx.niftyTrend).toBe("STRONG_DOWN");
  });

  it("computes FLAT for small change", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ niftyChangePct: 0.1 }));
    expect(ctx.niftyTrend).toBe("FLAT");
  });

  it("computes VIX regime NORMAL for VIX 13.5", () => {
    const ctx = buildMarketContextSnapshot(makeInput());
    expect(ctx.vixRegime).toBe("NORMAL");
  });

  it("computes VIX regime EXTREME for VIX > 25", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ indiaVix: 28 }));
    expect(ctx.vixRegime).toBe("EXTREME");
  });

  it("computes VIX regime LOW for VIX < 10", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ indiaVix: 9 }));
    expect(ctx.vixRegime).toBe("LOW");
  });

  it("computes VERY_BROAD breadth when 380/500 stocks advance", () => {
    const ctx = buildMarketContextSnapshot(makeInput());
    // 380/500 = 76% advancing
    expect(ctx.marketBreadth).toBe("VERY_BROAD");
  });

  it("computes VERY_NARROW breadth when few stocks advance", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ advancingCount: 100, decliningCount: 400 }));
    // 100/500 = 20% advancing → VERY_NARROW
    expect(ctx.marketBreadth).toBe("VERY_NARROW");
  });

  it("computes volume regime HIGH for RVOL 1.5×", () => {
    const ctx = buildMarketContextSnapshot(makeInput());
    // 150M / 100M = 1.5×
    expect(ctx.volumeRegime).toBe("HIGH");
  });

  it("marks missing fields correctly", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ indiaVix: null, advancingCount: null }));
    expect(ctx.isComplete).toBe(false);
    expect(ctx.missingFields).toContain("indiaVix");
    expect(ctx.missingFields).toContain("advancingCount");
  });

  it("momentum score is positive for bullish context", () => {
    const ctx = buildMarketContextSnapshot(makeInput());
    expect(ctx.momentumScore).toBeGreaterThan(0);
  });

  it("momentum score is negative for bearish context", () => {
    const ctx = buildMarketContextSnapshot(
      makeInput({ niftyChangePct: -1.5, bankniftyChangePct: -2.0, advancingCount: 80, decliningCount: 420 })
    );
    expect(ctx.momentumScore).toBeLessThan(0);
  });

  it("includes sessionDate in IST format", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ nowMs: 1725163200000 }));
    expect(ctx.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("scoreContextAlignment", () => {
  it("returns positive score for LONG signal in bullish context", () => {
    const ctx = buildMarketContextSnapshot(makeInput());
    const score = scoreContextAlignment(ctx, "LONG");
    expect(score).toBeGreaterThan(0);
  });

  it("returns negative score for LONG signal in bearish context", () => {
    const ctx = buildMarketContextSnapshot(
      makeInput({ niftyChangePct: -2.0, bankniftyChangePct: -2.5, advancingCount: 50, decliningCount: 450 })
    );
    const score = scoreContextAlignment(ctx, "LONG");
    expect(score).toBeLessThan(0);
  });

  it("returns 0 for NEUTRAL direction", () => {
    const ctx = buildMarketContextSnapshot(makeInput());
    const score = scoreContextAlignment(ctx, "NEUTRAL");
    expect(score).toBe(0);
  });

  it("score is in [-1, 1] range", () => {
    const ctx = buildMarketContextSnapshot(makeInput({ niftyChangePct: 5.0 }));
    const score = scoreContextAlignment(ctx, "LONG");
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
  });
});
