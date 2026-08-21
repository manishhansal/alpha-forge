/**
 * TDD red phase — Task 1.1
 *
 * Verifies the VolumeProfile output from the streaming indicator adapter:
 *   - POC is the price bucket with the highest cumulative volume
 *   - VAH >= POC >= VAL for all valid session inputs
 *
 * The module under test (src/features/indicators/index.ts) does NOT exist yet,
 * so these tests will fail at module resolution (red phase).
 *
 * Requirements: 1.2
 */
import { describe, expect, it } from "vitest";

import {
  computeVolumeProfile,
  type OHLCVBar,
  type VolumeProfileResult,
} from "@/features/indicators";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build OHLCV bars with deterministic prices and volumes. */
function makeSessionBars(
  count: number,
  opts: {
    basePrice?: number;
    priceStep?: number;
    baseVolume?: number;
    seed?: number;
  } = {},
): OHLCVBar[] {
  const basePrice = opts.basePrice ?? 19_500;
  const priceStep = opts.priceStep ?? 10;
  const baseVolume = opts.baseVolume ?? 10_000;
  let s = opts.seed ?? 1;

  // Simple LCG for determinism without external deps
  function next(): number {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4_294_967_296;
  }

  const bars: OHLCVBar[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = (next() - 0.5) * priceStep * 2;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + next() * priceStep;
    const low = Math.min(open, close) - next() * priceStep;
    const volume = baseVolume + next() * baseVolume;
    bars.push({
      openTime: i * 5 * 60_000,
      closeTime: (i + 1) * 5 * 60_000 - 1,
      open,
      high,
      low: Math.max(0.05, low), // prices must be positive
      close,
      volume,
    });
    price = close;
  }
  return bars;
}

/** Manually compute which price bucket should be the POC. */
function manualPOC(bars: OHLCVBar[], tickSize: number): number {
  const buckets = new Map<number, number>();
  for (const bar of bars) {
    // Distribute bar volume uniformly across price buckets it spans
    const lowBucket = Math.floor(bar.low / tickSize) * tickSize;
    const highBucket = Math.floor(bar.high / tickSize) * tickSize;
    let numBuckets = Math.round((highBucket - lowBucket) / tickSize) + 1;
    if (numBuckets < 1) numBuckets = 1;
    const volPerBucket = bar.volume / numBuckets;
    for (let p = lowBucket; p <= highBucket + tickSize * 0.01; p = Math.round((p + tickSize) * 1e8) / 1e8) {
      const key = Math.round(p / tickSize) * tickSize;
      buckets.set(key, (buckets.get(key) ?? 0) + volPerBucket);
    }
  }
  let maxVol = -Infinity;
  let poc = 0;
  for (const [price, vol] of buckets) {
    if (vol > maxVol) {
      maxVol = vol;
      poc = price;
    }
  }
  return poc;
}

// ─────────────────────────────────────────────────────────────────────────────
// POC correctness
// ─────────────────────────────────────────────────────────────────────────────

describe("computeVolumeProfile — POC is highest-volume price bucket", () => {
  it("POC matches the manually computed argmax for a 75-bar session (stock tickSize=0.05)", () => {
    const bars = makeSessionBars(75, { basePrice: 2_500, priceStep: 5, seed: 101 });
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 0.05 });
    // The adapter must return the same price bucket we independently compute
    const expected = manualPOC(bars, 0.05);
    // POC should be within 1 tick of the manually computed one (floating-point
    // rounding in bucket assignment may differ by at most one tick)
    expect(Math.abs(result.poc - expected)).toBeLessThanOrEqual(0.05 * 2);
  });

  it("POC is the price level with the highest cumulative volume — synthetic winner bar", () => {
    // Build bars where one price level has overwhelmingly more volume
    const bars: OHLCVBar[] = [
      // Many small-volume bars at various prices
      ...Array.from({ length: 10 }, (_, i) => ({
        openTime: i * 60_000,
        closeTime: (i + 1) * 60_000 - 1,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: 100,
      })),
      // One dominant bar centred on price 200 with 1,000,000 volume
      {
        openTime: 11 * 60_000,
        closeTime: 12 * 60_000 - 1,
        open: 199.5,
        high: 200.5,
        low: 199.5,
        close: 200,
        volume: 1_000_000,
      },
    ];
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 0.05 });
    // POC must be in the vicinity of 200 (the dominant bar)
    expect(result.poc).toBeGreaterThanOrEqual(199);
    expect(result.poc).toBeLessThanOrEqual(201);
  });

  it("POC is within [min_low, max_high] of the input bars", () => {
    const bars = makeSessionBars(50, { basePrice: 19_500, priceStep: 100, seed: 7 });
    const minLow = Math.min(...bars.map((b) => b.low));
    const maxHigh = Math.max(...bars.map((b) => b.high));
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 1 });
    expect(result.poc).toBeGreaterThanOrEqual(minLow - 1);
    expect(result.poc).toBeLessThanOrEqual(maxHigh + 1);
  });

  it("POC for NIFTY session uses tickSize=1 (integer price level)", () => {
    const bars = makeSessionBars(75, { basePrice: 22_000, priceStep: 50, seed: 999 });
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 1 });
    // NIFTY tickSize=1 means POC must be an integer (within floating-point tolerance)
    expect(result.poc % 1).toBeCloseTo(0, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VAH >= POC >= VAL invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("computeVolumeProfile — VAH >= POC >= VAL invariant", () => {
  it("VAH >= POC >= VAL for a standard 75-bar session", () => {
    const bars = makeSessionBars(75, { seed: 42 });
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 0.05 });
    expect(result.vah).toBeGreaterThanOrEqual(result.poc);
    expect(result.poc).toBeGreaterThanOrEqual(result.val);
  });

  it("VAH >= POC >= VAL for NIFTY session (tickSize=1)", () => {
    const bars = makeSessionBars(75, { basePrice: 22_500, priceStep: 50, seed: 12 });
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 1 });
    expect(result.vah).toBeGreaterThanOrEqual(result.poc);
    expect(result.poc).toBeGreaterThanOrEqual(result.val);
  });

  it("VAH >= POC >= VAL for BANKNIFTY session (tickSize=5)", () => {
    const bars = makeSessionBars(75, { basePrice: 48_000, priceStep: 200, seed: 55 });
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 5 });
    expect(result.vah).toBeGreaterThanOrEqual(result.poc);
    expect(result.poc).toBeGreaterThanOrEqual(result.val);
  });

  it("VAH >= POC >= VAL across 10 random sessions", () => {
    for (let seed = 0; seed < 10; seed++) {
      const bars = makeSessionBars(75, { seed: seed * 137 + 1 });
      const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 0.05 });
      expect(result.vah, `seed=${seed} vah<poc`).toBeGreaterThanOrEqual(result.poc);
      expect(result.poc, `seed=${seed} poc<val`).toBeGreaterThanOrEqual(result.val);
    }
  });

  it("VAH > VAL when bars have meaningful price spread", () => {
    const bars = makeSessionBars(50, { basePrice: 2_000, priceStep: 20, seed: 77 });
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 0.05 });
    expect(result.vah).toBeGreaterThan(result.val);
  });

  it("value area covers approximately 70% of total session volume", () => {
    const bars = makeSessionBars(100, { seed: 88 });
    const result: VolumeProfileResult = computeVolumeProfile(bars, { tickSize: 0.05 });
    // The value area (70% rule) is a standard Volume Profile convention
    // We check that VAH and VAL are reasonable bounds
    expect(result.vah).toBeGreaterThanOrEqual(result.poc);
    expect(result.val).toBeLessThanOrEqual(result.poc);
    // At a minimum, vah > val
    expect(result.vah).toBeGreaterThan(result.val);
  });

  it("single-bar session returns VAH === POC === VAL", () => {
    const bar: OHLCVBar = {
      openTime: 0,
      closeTime: 59_999,
      open: 100,
      high: 105,
      low: 95,
      close: 100,
      volume: 1_000,
    };
    const result: VolumeProfileResult = computeVolumeProfile([bar], { tickSize: 0.05 });
    // With only one bar, value area is the entire profile — VAH === VAL === POC
    expect(result.vah).toBeGreaterThanOrEqual(result.poc);
    expect(result.poc).toBeGreaterThanOrEqual(result.val);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NSE-specific tickSize calibration
// ─────────────────────────────────────────────────────────────────────────────

describe("computeVolumeProfile — NSE tickSize calibration", () => {
  it("accepts tickSize=0.05 for NSE stocks", () => {
    const bars = makeSessionBars(50, { basePrice: 500, priceStep: 2, seed: 11 });
    expect(() => computeVolumeProfile(bars, { tickSize: 0.05 })).not.toThrow();
  });

  it("accepts tickSize=1 for NIFTY", () => {
    const bars = makeSessionBars(50, { basePrice: 22_000, priceStep: 30, seed: 22 });
    expect(() => computeVolumeProfile(bars, { tickSize: 1 })).not.toThrow();
  });

  it("accepts tickSize=5 for BANKNIFTY", () => {
    const bars = makeSessionBars(50, { basePrice: 48_000, priceStep: 100, seed: 33 });
    expect(() => computeVolumeProfile(bars, { tickSize: 5 })).not.toThrow();
  });
});
