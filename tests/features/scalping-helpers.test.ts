import { describe, expect, it } from "vitest";

import {
  atr,
  bollinger,
  clamp,
  ema,
  findSwings,
  lastN,
  rollingMax,
  rollingMin,
  rollingVwap,
  rsi,
  sma,
  trailingAvg,
  vwap,
} from "@/features/scalping/helpers";
import { flatCandles, makeCandles, trendingCandles } from "../setup/fixtures";

describe("features/scalping/helpers", () => {
  describe("sma()", () => {
    it("returns running average for a flat input series", () => {
      const out = sma([5, 5, 5, 5, 5], 3);
      expect(out).toHaveLength(5);
      expect(out[2]).toBeCloseTo(5);
      expect(out[4]).toBeCloseTo(5);
    });

    it("matches the textbook sliding-window average", () => {
      const out = sma([1, 2, 3, 4, 5, 6], 3);
      expect(out[2]).toBeCloseTo(2);
      expect(out[3]).toBeCloseTo(3);
      expect(out[5]).toBeCloseTo(5);
    });

    it("returns an empty array for empty input", () => {
      expect(sma([], 5)).toEqual([]);
    });

    it("handles period 0 / negative without throwing", () => {
      expect(sma([1, 2, 3], 0)).toEqual([0, 0, 0]);
    });
  });

  describe("ema()", () => {
    it("first value equals the first input", () => {
      const out = ema([10, 11, 12], 5);
      expect(out[0]).toBe(10);
    });

    it("converges to the constant when fed a flat series", () => {
      const out = ema(Array(50).fill(7), 10);
      expect(out[49]).toBeCloseTo(7, 6);
    });
  });

  describe("rsi()", () => {
    it("returns a flat 50 series for fewer than `period` candles", () => {
      const out = rsi([100, 101, 102], 14);
      expect(out.every((v) => v === 50)).toBe(true);
    });

    it("returns 100 when there are no down moves", () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
      const out = rsi(closes, 14);
      expect(out[29]).toBeCloseTo(100, 1);
    });

    it("rsi values are in [0, 100]", () => {
      const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
      const out = rsi(closes, 14);
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    });
  });

  describe("bollinger()", () => {
    it("publishes equal-length mid/upper/lower/stdev arrays", () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i));
      const b = bollinger(closes, 20, 2);
      expect(b.mid).toHaveLength(closes.length);
      expect(b.upper).toHaveLength(closes.length);
      expect(b.lower).toHaveLength(closes.length);
      expect(b.stdev).toHaveLength(closes.length);
    });

    it("upper >= mid >= lower at every bar after warm-up", () => {
      const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 2));
      const b = bollinger(closes, 20, 2);
      for (let i = 19; i < closes.length; i += 1) {
        expect(b.upper[i]).toBeGreaterThanOrEqual(b.mid[i]);
        expect(b.lower[i]).toBeLessThanOrEqual(b.mid[i]);
      }
    });
  });

  describe("vwap() / rollingVwap()", () => {
    it("vwap on a flat series equals the price", () => {
      const candles = flatCandles(100, 20);
      const out = vwap(candles);
      for (const v of out) expect(v).toBeCloseTo(100, 6);
    });

    it("rollingVwap warms up to a finite number on every bar", () => {
      const candles = trendingCandles(100, 1, 200);
      const out = rollingVwap(candles, 20);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    });
  });

  describe("atr()", () => {
    it("returns positive values for non-flat candles", () => {
      const candles = makeCandles(
        Array.from({ length: 50 }, (_, i) => 100 + ((i % 4) - 1.5)),
      );
      const out = atr(candles, 14);
      expect(out[20]).toBeGreaterThan(0);
    });
  });

  describe("rollingMax() / rollingMin()", () => {
    it("rollingMax tracks the running maximum", () => {
      const out = rollingMax([1, 3, 2, 5, 4], 3);
      expect(out).toEqual([1, 3, 3, 5, 5]);
    });

    it("rollingMin tracks the running minimum", () => {
      const out = rollingMin([5, 3, 4, 2, 6], 3);
      expect(out).toEqual([5, 3, 3, 2, 2]);
    });
  });

  describe("findSwings()", () => {
    it("detects no swings on a strictly monotonic series", () => {
      const candles = trendingCandles(100, 1, 30);
      const { highs, lows } = findSwings(candles, 3);
      expect(highs).toHaveLength(0);
      expect(lows).toHaveLength(0);
    });

    it("detects pivots in a sawtooth pattern", () => {
      // Build bars manually so each candle has an isolated high/low — the
      // makeCandles helper chains open→prev-close which ends up duplicating
      // highs around peaks and breaks the strict-pivot rule.
      const closes = [100, 101, 102, 103, 104, 103, 102, 101, 100, 99, 100, 101, 102, 103, 104];
      const candles = closes.map((close, i) => ({
        openTime: i * 60_000,
        closeTime: (i + 1) * 60_000 - 1,
        open: close,
        high: close + 0.1,
        low: close - 0.1,
        close,
        volume: 1_000,
      }));
      const { highs, lows } = findSwings(candles, 3);
      expect(highs.length + lows.length).toBeGreaterThan(0);
    });
  });

  describe("misc utilities", () => {
    it("lastN returns the last N items", () => {
      expect(lastN([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
      expect(lastN([1, 2], 5)).toEqual([1, 2]);
    });

    it("trailingAvg averages the last `period` values", () => {
      expect(trailingAvg([1, 2, 3, 4, 5], 4, 3)).toBeCloseTo(4);
    });

    it("clamp clamps to [lo, hi]", () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
    });
  });
});
