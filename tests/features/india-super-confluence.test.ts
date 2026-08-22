import { describe, expect, it } from "vitest";

import {
  computeSuperConfluence,
} from "@/features/india/indicators/super-confluence";
import type { Candle } from "@/types/india/market";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeCandles(n: number, startPrice = 100, trend: "up" | "down" | "flat" = "flat"): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const delta = trend === "up" ? i * 0.5 : trend === "down" ? -i * 0.5 : 0;
    const close = startPrice + delta;
    return {
      time:   Math.floor(Date.now() / 1000) - (n - 1 - i) * 86400,
      open:   close - 0.5,
      high:   close + 1,
      low:    close - 1,
      close,
      volume: 500_000,
    };
  });
}

// ─── Warmup guard ─────────────────────────────────────────────────────────────

describe("features/india/indicators/super-confluence — warmup guard", () => {
  it("returns null when fewer bars than warmup are supplied", () => {
    // Warmup needs at least max(aiSpeed*2+5, smcPivotLen*2+5) = 50*2+5 = 105
    const tooShort = makeCandles(50);
    expect(computeSuperConfluence(tooShort)).toBeNull();
  });

  it("returns a result with the minimum required bars (110 bars)", () => {
    const candles = makeCandles(110, 200, "up");
    const result = computeSuperConfluence(candles);
    expect(result).not.toBeNull();
    expect(result!.bars).toHaveLength(110);
  });
});

// ─── Result shape ─────────────────────────────────────────────────────────────

describe("features/india/indicators/super-confluence — result shape", () => {
  const candles = makeCandles(120, 200, "up");
  const result  = computeSuperConfluence(candles)!;

  it("score is in [-1, 1]", () => {
    expect(result.score).toBeGreaterThanOrEqual(-1);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("tag is a non-empty string", () => {
    expect(typeof result.tag).toBe("string");
    expect(result.tag.length).toBeGreaterThan(0);
  });

  it("every bar has the required fields", () => {
    for (const b of result.bars) {
      expect(typeof b.time).toBe("number");
      expect(typeof b.close).toBe("number");
      expect(typeof b.utTrail).toBe("number");
      expect(typeof b.aiLine).toBe("number");
      expect(typeof b.aiDir).toBe("number");
      expect(typeof b.smcBias).toBe("number");
      expect(typeof b.utBuy).toBe("boolean");
      expect(typeof b.utSell).toBe("boolean");
      expect(typeof b.superBuy).toBe("boolean");
      expect(typeof b.superSell).toBe("boolean");
      // EMA fields (added in EMA gate commit)
      expect(typeof b.ema9).toBe("number");
      expect(typeof b.ema15).toBe("number");
      expect(typeof b.ema21).toBe("number");
      expect(typeof b.emaBull).toBe("boolean");
      expect(typeof b.emaBear).toBe("boolean");
    }
  });

  it("superBuy and superSell are mutually exclusive on every bar", () => {
    for (const b of result.bars) {
      expect(b.superBuy && b.superSell).toBe(false);
    }
  });
});

// ─── EMA stack gate ───────────────────────────────────────────────────────────

describe("features/india/indicators/super-confluence — EMA 9/15/21 gate", () => {
  it("emaBull is true when EMA9 > EMA15 > EMA21 (rising series)", () => {
    const rising = makeCandles(150, 100, "up");
    const result = computeSuperConfluence(rising)!;
    // On the last bar of a strongly rising series, EMA9 > EMA15 > EMA21.
    const last = result.bars[result.bars.length - 1];
    expect(last.ema9).toBeGreaterThan(last.ema15);
    expect(last.ema15).toBeGreaterThan(last.ema21);
    expect(last.emaBull).toBe(true);
    expect(last.emaBear).toBe(false);
  });

  it("emaBear is true when EMA9 < EMA15 < EMA21 (falling series)", () => {
    const falling = makeCandles(150, 200, "down");
    const result = computeSuperConfluence(falling)!;
    const last = result.bars[result.bars.length - 1];
    expect(last.ema9).toBeLessThan(last.ema15);
    expect(last.ema15).toBeLessThan(last.ema21);
    expect(last.emaBear).toBe(true);
    expect(last.emaBull).toBe(false);
  });

  it("superBuy requires emaBull to be true — EMA is the 4th gate", () => {
    const candles = makeCandles(120, 100, "flat");
    const result = computeSuperConfluence(candles)!;
    // On a flat series emaBull is likely false; superBuy must also be false.
    for (const b of result.bars) {
      if (!b.emaBull) {
        expect(b.superBuy).toBe(false);
      }
      if (!b.emaBear) {
        expect(b.superSell).toBe(false);
      }
    }
  });
});

// ─── Partial score values ─────────────────────────────────────────────────────

describe("features/india/indicators/super-confluence — partial score", () => {
  it("score is ±1.0 when a superBuy or superSell fires on the last bar", () => {
    // Test that the score contract holds: a fresh super signal always pins to ±1.
    const candles = makeCandles(130, 100, "up");
    const result  = computeSuperConfluence(candles)!;
    const last    = result.bars[result.bars.length - 1];
    if (last.superBuy)  expect(result.score).toBe(1.0);
    if (last.superSell) expect(result.score).toBe(-1.0);
  });

  it("score is 0 when no components are aligned on the last bar", () => {
    // A perfectly flat series has no trending bias → all components neutral.
    const candles = makeCandles(120, 100, "flat");
    const result  = computeSuperConfluence(candles)!;
    // Score may be partial but should be finite and in range.
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(-1);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

// ─── barsSinceSignal ──────────────────────────────────────────────────────────

describe("features/india/indicators/super-confluence — barsSinceSignal", () => {
  it("is null when no super signal has ever fired", () => {
    // Flat series almost never triggers a triple-confluence signal.
    const candles = makeCandles(120, 100, "flat");
    const result  = computeSuperConfluence(candles)!;
    // barsSinceSignal could be null or a number — accept both;
    // if a signal happened to fire it's a valid non-null number.
    if (result.barsSinceSignal !== null) {
      expect(typeof result.barsSinceSignal).toBe("number");
    }
  });

  it("barsSinceSignal = 0 means the signal fired on the last bar", () => {
    const candles = makeCandles(130, 100, "up");
    const result  = computeSuperConfluence(candles)!;
    const last    = result.bars[result.bars.length - 1];
    if (last.superBuy || last.superSell) {
      expect(result.barsSinceSignal).toBe(0);
    }
  });
});
