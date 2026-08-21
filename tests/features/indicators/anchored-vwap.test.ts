/**
 * TDD red phase — Task 2.1
 *
 * Verifies the pure math function from the Anchored VWAP plugin:
 *
 *   computeAnchoredVwap(bars, anchorIndex) → number[]
 *
 * The module under test (src/components/india/charts/plugins/anchored-vwap.ts)
 * does NOT exist yet, so every test in this file will fail at module resolution
 * (red phase confirmed).
 *
 * Requirements: 2.1
 */
import { describe, expect, it } from "vitest";

// The module under test — does NOT exist yet.
import { computeAnchoredVwap } from "@/components/india/charts/plugins/anchored-vwap";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Build a synthetic bar with explicit OHLCV values. */
function bar(high: number, low: number, close: number, volume: number) {
  return { high, low, close, volume };
}

/**
 * Compute HLC3 (typical price) for a single bar.
 * Formula: (high + low + close) / 3
 */
function hlc3(high: number, low: number, close: number): number {
  return (high + low + close) / 3;
}

/**
 * Manually compute the expected Anchored VWAP array from anchorIndex to end.
 *
 * For each index i >= anchorIndex:
 *   vwap[i] = Σ(hlc3[j] × vol[j]) for j from anchorIndex to i
 *             ──────────────────────────────────────────────────
 *             Σ(vol[j]) for j from anchorIndex to i
 *
 * Indices before anchorIndex get NaN (undefined / not anchored).
 */
function manualAnchoredVwap(
  bars: Array<{ high: number; low: number; close: number; volume: number }>,
  anchorIndex: number,
): number[] {
  let cumTypicalVol = 0;
  let cumVol = 0;
  const result: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    if (i < anchorIndex) {
      result.push(NaN);
      continue;
    }
    const b = bars[i];
    cumTypicalVol += hlc3(b.high, b.low, b.close) * b.volume;
    cumVol += b.volume;
    result.push(cumTypicalVol / cumVol);
  }

  return result;
}

// 10 synthetic bars with known values so we can cross-check by hand.
const TEN_BARS = [
  bar(102, 98, 100, 1_000),   // bar 0 — HLC3 = 100.00
  bar(105, 101, 103, 1_500),  // bar 1 — HLC3 = 103.00
  bar(108, 104, 106, 2_000),  // bar 2 — HLC3 = 106.00
  bar(107, 103, 105, 1_800),  // bar 3 — HLC3 = 105.00
  bar(110, 106, 108, 2_200),  // bar 4 — HLC3 = 108.00
  bar(112, 108, 110, 1_700),  // bar 5 — HLC3 = 110.00
  bar(111, 107, 109, 1_600),  // bar 6 — HLC3 = 109.00
  bar(114, 110, 112, 2_100),  // bar 7 — HLC3 = 112.00
  bar(116, 112, 114, 1_900),  // bar 8 — HLC3 = 114.00
  bar(118, 114, 116, 2_300),  // bar 9 — HLC3 = 116.00
];

// ─────────────────────────────────────────────────────────────────────────────
// Test group 1: VWAP from anchor=0 equals Σ(HLC3×vol)/Σvol — exact equality
// ─────────────────────────────────────────────────────────────────────────────

describe("computeAnchoredVwap — exact formula from anchor at bar 0", () => {
  it("returns an array of the same length as the input bars", () => {
    const result = computeAnchoredVwap(TEN_BARS, 0);
    expect(result).toHaveLength(TEN_BARS.length);
  });

  it("VWAP at bar 0 (anchor) equals HLC3 of bar 0 exactly", () => {
    const result = computeAnchoredVwap(TEN_BARS, 0);
    const expected = hlc3(TEN_BARS[0].high, TEN_BARS[0].low, TEN_BARS[0].close);
    expect(result[0]).toBe(expected);
  });

  it("VWAP at bar 1 = (HLC3[0]×vol[0] + HLC3[1]×vol[1]) / (vol[0]+vol[1]) — exact equality", () => {
    const result = computeAnchoredVwap(TEN_BARS, 0);

    const tp0 = hlc3(TEN_BARS[0].high, TEN_BARS[0].low, TEN_BARS[0].close);
    const tp1 = hlc3(TEN_BARS[1].high, TEN_BARS[1].low, TEN_BARS[1].close);
    const expected = (tp0 * TEN_BARS[0].volume + tp1 * TEN_BARS[1].volume) /
      (TEN_BARS[0].volume + TEN_BARS[1].volume);

    expect(result[1]).toBe(expected);
  });

  it("VWAP at every bar from anchor 0 matches manual Σ(HLC3×vol)/Σvol — exact equality", () => {
    const result = computeAnchoredVwap(TEN_BARS, 0);
    const expected = manualAnchoredVwap(TEN_BARS, 0);

    for (let i = 0; i < TEN_BARS.length; i++) {
      expect(result[i], `bar ${i}`).toBe(expected[i]);
    }
  });

  it("VWAP at last bar equals manually computed cumulative sum over all 10 bars", () => {
    const result = computeAnchoredVwap(TEN_BARS, 0);

    // Compute expected VWAP at bar 9 by hand
    let cumTypVol = 0;
    let cumVol = 0;
    for (const b of TEN_BARS) {
      cumTypVol += hlc3(b.high, b.low, b.close) * b.volume;
      cumVol += b.volume;
    }
    const expectedFinal = cumTypVol / cumVol;

    expect(result[9]).toBe(expectedFinal);
  });

  it("VWAP values are monotonically reasonable (between min and max HLC3 of the session)", () => {
    const result = computeAnchoredVwap(TEN_BARS, 0);
    const minHlc3 = Math.min(...TEN_BARS.map((b) => hlc3(b.high, b.low, b.close)));
    const maxHlc3 = Math.max(...TEN_BARS.map((b) => hlc3(b.high, b.low, b.close)));

    for (let i = 0; i < result.length; i++) {
      expect(result[i], `bar ${i}`).toBeGreaterThanOrEqual(minHlc3 - 1e-10);
      expect(result[i], `bar ${i}`).toBeLessThanOrEqual(maxHlc3 + 1e-10);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test group 2: Anchor at bar 0 vs anchor at bar 5 produces different values
// ─────────────────────────────────────────────────────────────────────────────

describe("computeAnchoredVwap — anchor at bar 0 vs bar 5 produces different values", () => {
  it("VWAP[9] with anchor=0 is different from VWAP[9] with anchor=5", () => {
    const vwapFromBar0 = computeAnchoredVwap(TEN_BARS, 0);
    const vwapFromBar5 = computeAnchoredVwap(TEN_BARS, 5);

    // Both should have values at bar 9
    expect(vwapFromBar0[9]).toBeDefined();
    expect(vwapFromBar5[9]).toBeDefined();

    // They must differ because they accumulate from different starting points
    expect(vwapFromBar0[9]).not.toBe(vwapFromBar5[9]);
  });

  it("VWAP[7] with anchor=0 differs from VWAP[7] with anchor=5 for the same current bar", () => {
    const vwapFromBar0 = computeAnchoredVwap(TEN_BARS, 0);
    const vwapFromBar5 = computeAnchoredVwap(TEN_BARS, 5);

    expect(vwapFromBar0[7]).not.toBe(vwapFromBar5[7]);
  });

  it("VWAP with anchor=5 at bar 5 equals HLC3 of bar 5 (anchor point itself)", () => {
    const result = computeAnchoredVwap(TEN_BARS, 5);
    const expected = hlc3(TEN_BARS[5].high, TEN_BARS[5].low, TEN_BARS[5].close);
    expect(result[5]).toBe(expected);
  });

  it("VWAP with anchor=5 at bar 6 matches manual formula from bar 5 to bar 6", () => {
    const result = computeAnchoredVwap(TEN_BARS, 5);

    const tp5 = hlc3(TEN_BARS[5].high, TEN_BARS[5].low, TEN_BARS[5].close);
    const tp6 = hlc3(TEN_BARS[6].high, TEN_BARS[6].low, TEN_BARS[6].close);
    const expected = (tp5 * TEN_BARS[5].volume + tp6 * TEN_BARS[6].volume) /
      (TEN_BARS[5].volume + TEN_BARS[6].volume);

    expect(result[6]).toBe(expected);
  });

  it("VWAP with anchor=5 at bar 9 matches full manual formula from bar 5 to bar 9", () => {
    const result = computeAnchoredVwap(TEN_BARS, 5);
    const expected = manualAnchoredVwap(TEN_BARS, 5);

    // Check all bars from anchor to end
    for (let i = 5; i < TEN_BARS.length; i++) {
      expect(result[i], `bar ${i}`).toBe(expected[i]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test group 3: Bars before the anchor do not affect the VWAP
// ─────────────────────────────────────────────────────────────────────────────

describe("computeAnchoredVwap — bars before the anchor do not affect the accumulated VWAP", () => {
  it("results from anchor=5 at bars 5-9 are identical regardless of what bars 0-4 contain", () => {
    const vwapWithOriginalBars = computeAnchoredVwap(TEN_BARS, 5);

    // Build a version with wildly different bars 0–4
    const altBars = [
      bar(999, 1, 500, 999_999),   // bar 0 — very different from original
      bar(888, 2, 400, 888_888),   // bar 1
      bar(777, 3, 300, 777_777),   // bar 2
      bar(666, 4, 200, 666_666),   // bar 3
      bar(555, 5, 100, 555_555),   // bar 4
      ...TEN_BARS.slice(5),        // bars 5-9 are IDENTICAL to original
    ];

    const vwapWithAltBars = computeAnchoredVwap(altBars, 5);

    // Bars 5-9 must produce exactly the same VWAP values
    for (let i = 5; i < TEN_BARS.length; i++) {
      expect(vwapWithOriginalBars[i], `bar ${i}`).toBe(vwapWithAltBars[i]);
    }
  });

  it("VWAP with anchor=3 only accumulates bars 3 onwards — matches manual from anchor only", () => {
    const result = computeAnchoredVwap(TEN_BARS, 3);
    const expected = manualAnchoredVwap(TEN_BARS, 3);

    // Verify bars 3-9 match the manual calculation (bars before 3 should not contribute)
    for (let i = 3; i < TEN_BARS.length; i++) {
      expect(result[i], `bar ${i}`).toBe(expected[i]);
    }
  });

  it("two calls with different anchorIndex share the same bar data but yield different accumulators", () => {
    // This verifies no shared mutable state between calls
    const result0 = computeAnchoredVwap(TEN_BARS, 0);
    const result3 = computeAnchoredVwap(TEN_BARS, 3);
    const result5 = computeAnchoredVwap(TEN_BARS, 5);

    // All three should differ at bar 9
    const v0 = result0[9];
    const v3 = result3[9];
    const v5 = result5[9];

    // Anchor 0 includes more low-price bars (100-105), anchor 5+ starts at 110+
    // so v0 < v5 (more low-priced bars drag the average down)
    expect(v0).toBeLessThan(v5);
    // v3 should be between v0 and v5
    expect(v3).toBeLessThan(v5);
    expect(v3).toBeGreaterThan(v0);
  });

  it("VWAP with anchor at last bar equals HLC3 of that last bar exactly", () => {
    const lastIdx = TEN_BARS.length - 1;
    const result = computeAnchoredVwap(TEN_BARS, lastIdx);
    const expected = hlc3(TEN_BARS[lastIdx].high, TEN_BARS[lastIdx].low, TEN_BARS[lastIdx].close);
    expect(result[lastIdx]).toBe(expected);
  });

  it("single-bar input with anchor=0 returns array of length 1 equal to HLC3", () => {
    const singleBar = [bar(110, 90, 100, 5_000)];
    const result = computeAnchoredVwap(singleBar, 0);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(hlc3(110, 90, 100));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test group 4: Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("computeAnchoredVwap — edge cases", () => {
  it("uniform volume bars: VWAP equals the simple average of HLC3 values", () => {
    const uniformVolBars = TEN_BARS.map((b) => ({ ...b, volume: 1_000 }));
    const result = computeAnchoredVwap(uniformVolBars, 0);

    // With equal volume, VWAP = simple average of HLC3
    let cumHlc3 = 0;
    for (let i = 0; i < uniformVolBars.length; i++) {
      cumHlc3 += hlc3(uniformVolBars[i].high, uniformVolBars[i].low, uniformVolBars[i].close);
      const expectedAvg = cumHlc3 / (i + 1);
      expect(result[i], `bar ${i}`).toBeCloseTo(expectedAvg, 10);
    }
  });

  it("large volume spike on one bar pulls VWAP toward that bar's price", () => {
    const barsWithSpike = [
      bar(100, 96, 98, 1_000),     // bar 0 — low price, normal volume
      bar(100, 96, 98, 1_000),     // bar 1 — same
      bar(200, 196, 198, 1_000_000), // bar 2 — HIGH price, massive volume spike
    ];

    const result = computeAnchoredVwap(barsWithSpike, 0);

    // After bar 2, VWAP should be much closer to 198 than to 98
    expect(result[2]).toBeGreaterThan(190);
  });

  it("VWAP is always a weighted average: between min and max HLC3 for any input", () => {
    const bars = [
      bar(50, 40, 45, 100),
      bar(60, 50, 55, 200),
      bar(70, 60, 65, 150),
      bar(80, 70, 75, 300),
    ];
    const result = computeAnchoredVwap(bars, 0);

    const allHlc3 = bars.map((b) => hlc3(b.high, b.low, b.close));
    const minHlc3 = Math.min(...allHlc3);
    const maxHlc3 = Math.max(...allHlc3);

    for (let i = 0; i < result.length; i++) {
      expect(result[i], `bar ${i}`).toBeGreaterThanOrEqual(minHlc3 - 1e-10);
      expect(result[i], `bar ${i}`).toBeLessThanOrEqual(maxHlc3 + 1e-10);
    }
  });
});
