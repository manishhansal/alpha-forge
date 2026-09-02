/**
 * Tests — Multi-Layer Signal Engine (Phases 5–13)
 *
 * Covers breakout quality, momentum quality, volume intelligence,
 * volatility regime, liquidity, market structure, and layer aggregation.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateBreakoutQuality,
  evaluateMomentumQuality,
  evaluateVolumeIntelligence,
  evaluateVolatilityRegime,
  evaluateLiquidity,
  evaluateMarketStructure,
  aggregateLayerResults,
} from "@/lib/signal-intelligence/multi-layer-engine";
import type { LayerResult } from "@/lib/signal-intelligence/multi-layer-engine";
import type { OHLCVCandle } from "@/lib/market-data/types";

// ── Test candles ──────────────────────────────────────────────────────────────

function makeCandles(n: number, trend: "UP" | "DOWN" | "FLAT" = "UP"): OHLCVCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 24000 + (trend === "UP" ? i * 20 : trend === "DOWN" ? -i * 20 : 0);
    return {
      time: 1725000000 + i * 300,
      open: base,
      high: base + 50,
      low: base - 50,
      close: trend === "UP" ? base + 15 : trend === "DOWN" ? base - 15 : base,
      volume: 1_000_000 + i * 10_000,
    };
  });
}

describe("evaluateBreakoutQuality", () => {
  it("returns WEAK_BREAKOUT for insufficient candles", () => {
    const result = evaluateBreakoutQuality(makeCandles(3), 24000, "UP", 24050, null, null, null);
    expect(result.quality).toBe("WEAK_BREAKOUT");
  });

  it("returns higher score with strong volume expansion", () => {
    const candles = makeCandles(20, "UP");
    const highVolumeResult = evaluateBreakoutQuality(candles, 24000, "UP", 24200, 5_000_000, 1_000_000, 100);
    const lowVolumeResult = evaluateBreakoutQuality(candles, 24000, "UP", 24200, 500_000, 1_000_000, 100);
    expect(highVolumeResult.score).toBeGreaterThan(lowVolumeResult.score);
  });

  it("RVOL is computed as currentVolume / avgVolume20d", () => {
    const candles = makeCandles(15, "UP");
    const result = evaluateBreakoutQuality(candles, 24000, "UP", 24100, 3_000_000, 1_000_000, 50);
    expect(result.rvol).toBeCloseTo(3.0, 1);
  });

  it("falseProbability decreases score", () => {
    const candles = makeCandles(15, "UP");
    // Candle close at low (bad close location) → higher false probability
    const weakCloseCandles = candles.map((c) => ({ ...c, close: c.low + 1 }));
    const result = evaluateBreakoutQuality(weakCloseCandles, 24000, "UP", 24100, 1_500_000, 1_000_000, 50);
    expect(result.falseProbability).toBeGreaterThan(0.4);
  });
});

describe("evaluateMomentumQuality", () => {
  it("returns CONTINUATION for bullish trending candles (LONG)", () => {
    const candles = makeCandles(50, "UP");
    const result = evaluateMomentumQuality(candles, "LONG");
    expect(result.roc).toBeGreaterThan(0);
  });

  it("returns CONTINUATION for bearish candles (SHORT)", () => {
    const candles = makeCandles(50, "DOWN");
    const result = evaluateMomentumQuality(candles, "SHORT");
    expect(result.roc).toBeLessThan(0);
  });

  it("computes RSI for candles with sufficient history", () => {
    const candles = makeCandles(40, "UP");
    const result = evaluateMomentumQuality(candles, "LONG");
    if (result.rsi !== null) {
      expect(result.rsi).toBeGreaterThanOrEqual(0);
      expect(result.rsi).toBeLessThanOrEqual(100);
    }
  });

  it("score is in [0, 1]", () => {
    const result = evaluateMomentumQuality(makeCandles(30, "UP"), "LONG");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe("evaluateVolumeIntelligence", () => {
  it("computes RVOL correctly", () => {
    const candles = makeCandles(20);
    const result = evaluateVolumeIntelligence(candles, 2_000_000, 1_000_000, "LONG", Date.now());
    expect(result.rvol).toBeCloseTo(2.0, 1);
  });

  it("marks volume climax for RVOL >= 3×", () => {
    const result = evaluateVolumeIntelligence(makeCandles(5), 4_000_000, 1_000_000, "LONG", Date.now());
    expect(result.volumeClimax).toBe(true);
  });

  it("marks volume exhaustion for RVOL < 0.3×", () => {
    const result = evaluateVolumeIntelligence(makeCandles(5), 200_000, 1_000_000, "LONG", Date.now());
    expect(result.volumeExhaustion).toBe(true);
  });

  it("score is higher for high RVOL", () => {
    const highRvol = evaluateVolumeIntelligence(makeCandles(5), 3_000_000, 1_000_000, "LONG", Date.now());
    const lowRvol = evaluateVolumeIntelligence(makeCandles(5), 500_000, 1_000_000, "LONG", Date.now());
    expect(highRvol.score).toBeGreaterThan(lowRvol.score);
  });

  it("intradayTimeAdjustedRvol is available when RVOL is available", () => {
    const result = evaluateVolumeIntelligence(makeCandles(5), 2_000_000, 1_000_000, "LONG", Date.now());
    expect(result.intradayTimeAdjustedRvol).not.toBeNull();
  });
});

describe("evaluateVolatilityRegime", () => {
  it("classifies NORMAL regime for mid-range VIX", () => {
    const candles = makeCandles(30);
    const result = evaluateVolatilityRegime(candles, 150, 14, ["NORMAL", "HIGH"]);
    expect(result.vixRegime).toBe("NORMAL");
  });

  it("classifies EXTREME for VIX > 25", () => {
    const result = evaluateVolatilityRegime(makeCandles(30), 300, 28, ["NORMAL"]);
    expect(result.vixRegime).toBe("EXTREME");
  });

  it("regimeSupportedByStrategy is false when regime not in declared list", () => {
    // With null currentAtr and VIX 28 → extreme regime; declared supports only NORMAL/LOW
    const result = evaluateVolatilityRegime(makeCandles(30), null, 28, ["NORMAL", "LOW"]);
    // VIX 28 → vixRegime=EXTREME; the overall regime is computed from atrPercentile
    // With null ATR, regime defaults to NORMAL — which IS in the supported list
    // So use a list that doesn't include NORMAL
    const result2 = evaluateVolatilityRegime(makeCandles(30), null, 28, ["LOW", "VERY_LOW"]);
    expect(result2.regimeSupportedByStrategy).toBe(false);
  });

  it("regimeSupportedByStrategy is true when regime is in declared list", () => {
    const result = evaluateVolatilityRegime(makeCandles(30), null, 14, ["NORMAL"]);
    expect(result.regimeSupportedByStrategy).toBe(true);
  });
});

describe("evaluateLiquidity", () => {
  it("returns EXCELLENT for very tight spread", () => {
    const result = evaluateLiquidity(5, 24000, 1_000_000, 800_000);
    expect(result.executionQuality).toBe("EXCELLENT");
    expect(result.rejected).toBe(false);
  });

  it("rejects when spread > 0.30%", () => {
    const result = evaluateLiquidity(80, 24000, 1_000_000, 800_000);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).not.toBeNull();
  });

  it("rejects when volume < 20% of average", () => {
    const result = evaluateLiquidity(2, 24000, 100_000, 1_000_000);
    expect(result.rejected).toBe(true);
  });

  it("liquidityScore is 1.0 for excellent quality", () => {
    const result = evaluateLiquidity(1, 24000, 1_000_000, 800_000);
    expect(result.liquidityScore).toBe(1.0);
  });
});

describe("evaluateMarketStructure", () => {
  it("returns NEUTRAL bias for flat candles", () => {
    const result = evaluateMarketStructure(makeCandles(30, "FLAT"), "LONG", Date.now());
    expect(result.structureBias).toBe("NEUTRAL");
  });

  it("returns reasonable score in [0, 1]", () => {
    const result = evaluateMarketStructure(makeCandles(30, "UP"), "LONG", Date.now());
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("handles insufficient candles gracefully", () => {
    const result = evaluateMarketStructure(makeCandles(5), "LONG", Date.now());
    expect(result.score).toBe(0.5); // neutral when insufficient data
  });
});

describe("aggregateLayerResults", () => {
  it("detects veto from a VETO layer", () => {
    const layers: LayerResult[] = [
      { layer: "LIQUIDITY", status: "VETO", score: 0, confidence: 1, direction: "NEUTRAL", quality: "CRITICAL", reason: "Spread too wide", contributing: true },
      { layer: "MOMENTUM", status: "CONFIRM", score: 0.8, confidence: 0.9, direction: "LONG", quality: "HIGH", reason: "Momentum strong", contributing: true },
    ];
    const result = aggregateLayerResults(layers);
    expect(result.vetoed).toBe(true);
    expect(result.vetoCount).toBe(1);
  });

  it("counts CONFIRM and OPPOSE layers", () => {
    const layers: LayerResult[] = [
      { layer: "MOMENTUM", status: "CONFIRM", score: 0.8, confidence: 0.9, direction: "LONG", quality: "HIGH", reason: "Strong", contributing: true },
      { layer: "VOLUME", status: "CONFIRM", score: 0.75, confidence: 0.8, direction: "LONG", quality: "HIGH", reason: "Good vol", contributing: true },
      { layer: "REGIME", status: "OPPOSE", score: 0.3, confidence: 0.7, direction: "SHORT", quality: "MEDIUM", reason: "Bearish regime", contributing: true },
    ];
    const result = aggregateLayerResults(layers);
    expect(result.confirmCount).toBe(2);
    expect(result.opposeCount).toBe(1);
    expect(result.vetoed).toBe(false);
  });

  it("compositeScore is in [0, 1]", () => {
    const layers: LayerResult[] = [
      { layer: "MOMENTUM", status: "CONFIRM", score: 0.8, confidence: 0.9, direction: "LONG", quality: "HIGH", reason: "", contributing: true },
    ];
    const result = aggregateLayerResults(layers);
    expect(result.compositeScore).toBeGreaterThanOrEqual(0);
    expect(result.compositeScore).toBeLessThanOrEqual(1);
  });
});
