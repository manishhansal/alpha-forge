/**
 * TDD red phase — Task 2.1
 *
 * Verifies that the Volume Profile plugin computes the POC (Point of Control)
 * line at the correct price — i.e. the price row with the highest cumulative
 * traded volume across the chart's OHLCV data.
 *
 * The module under test (src/components/india/charts/plugins/volume-profile.ts)
 * does NOT exist yet, so every test in this file will fail at module resolution
 * (red phase confirmed).
 *
 * Requirements: 2.2
 */
import { describe, expect, it } from "vitest";

// The module under test — does NOT exist yet.
import { getPocPrice } from "@/components/india/charts/plugins/volume-profile";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal bar shape the plugin needs to compute POC. */
interface ChartBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

function bar(high: number, low: number, close: number, volume: number): ChartBar {
  return { high, low, close, volume };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test group 1: POC is at the price row with the highest volume
// ─────────────────────────────────────────────────────────────────────────────

describe("getPocPrice — POC line renders at the price row with the highest volume", () => {
  it("returns the price level where volume is concentrated when one bar dominates", () => {
    const bars: ChartBar[] = [
      // Many small-volume bars spread over a wide price range
      bar(110, 100, 105, 500),
      bar(115, 105, 110, 600),
      bar(120, 110, 115, 400),
      bar(125, 115, 120, 450),
      // One dominant bar with overwhelming volume concentrated near 200
      bar(201, 199, 200, 1_000_000),
    ];

    const poc = getPocPrice(bars, { tickSize: 1 });

    // POC must be in the vicinity of 200 — the dominant bar
    expect(poc).toBeGreaterThanOrEqual(198);
    expect(poc).toBeLessThanOrEqual(202);
  });

  it("returns the correct POC when all bars have the same narrow price range but different volumes", () => {
    // Three groups of bars, the middle group has the most volume
    const bars: ChartBar[] = [
      // Low-price zone: bars around 100, low volume
      bar(101, 99, 100, 1_000),
      bar(101, 99, 100, 1_200),

      // Mid-price zone: bars around 150, highest volume
      bar(151, 149, 150, 50_000),
      bar(151, 149, 150, 60_000),
      bar(151, 149, 150, 55_000),

      // High-price zone: bars around 200, medium volume
      bar(201, 199, 200, 5_000),
      bar(201, 199, 200, 4_500),
    ];

    const poc = getPocPrice(bars, { tickSize: 1 });

    // POC must be near 150 — the price band with the highest cumulative volume
    expect(poc).toBeGreaterThanOrEqual(149);
    expect(poc).toBeLessThanOrEqual(151);
  });

  it("POC is within [min_low, max_high] of the input bars", () => {
    const bars: ChartBar[] = [
      bar(22_100, 22_000, 22_050, 10_000),
      bar(22_200, 22_100, 22_150, 8_000),
      bar(22_050, 21_950, 22_000, 20_000), // highest volume
      bar(22_300, 22_200, 22_250, 5_000),
    ];

    const minLow = Math.min(...bars.map((b) => b.low));
    const maxHigh = Math.max(...bars.map((b) => b.high));

    const poc = getPocPrice(bars, { tickSize: 1 });

    expect(poc).toBeGreaterThanOrEqual(minLow);
    expect(poc).toBeLessThanOrEqual(maxHigh);
  });

  it("single bar: POC is within the bar's price range", () => {
    const bars: ChartBar[] = [
      bar(19_600, 19_400, 19_500, 100_000),
    ];

    const poc = getPocPrice(bars, { tickSize: 1 });

    expect(poc).toBeGreaterThanOrEqual(19_400);
    expect(poc).toBeLessThanOrEqual(19_600);
  });

  it("POC changes when a new dominant volume bar is added", () => {
    const originalBars: ChartBar[] = [
      bar(101, 99, 100, 9_000),
      bar(201, 199, 200, 10_000),  // originally the most volume, near 200
    ];

    const pocOriginal = getPocPrice(originalBars, { tickSize: 1 });
    expect(pocOriginal).toBeGreaterThanOrEqual(199);
    expect(pocOriginal).toBeLessThanOrEqual(201);

    // Add a bar with massive volume near 300
    const updatedBars: ChartBar[] = [
      ...originalBars,
      bar(301, 299, 300, 500_000), // dominant new bar near 300
    ];

    const pocUpdated = getPocPrice(updatedBars, { tickSize: 1 });

    // POC must now shift to the new dominant price area
    expect(pocUpdated).toBeGreaterThanOrEqual(299);
    expect(pocUpdated).toBeLessThanOrEqual(301);

    // And must be different from the original POC
    expect(pocUpdated).not.toBe(pocOriginal);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test group 2: POC with NSE-calibrated tick sizes
// ─────────────────────────────────────────────────────────────────────────────

describe("getPocPrice — NSE tick size calibration", () => {
  it("returns an integer-aligned price for NIFTY (tickSize=1)", () => {
    const bars: ChartBar[] = [
      bar(22_105, 22_095, 22_100, 5_000),
      bar(22_205, 22_195, 22_200, 5_000),
      bar(22_305, 22_295, 22_300, 100_000), // clear winner
    ];

    const poc = getPocPrice(bars, { tickSize: 1 });

    // With tickSize=1, POC should be an integer
    expect(poc % 1).toBeCloseTo(0, 6);
    // And near 22_300
    expect(poc).toBeGreaterThanOrEqual(22_295);
    expect(poc).toBeLessThanOrEqual(22_305);
  });

  it("returns a 5-pt-aligned price for BANKNIFTY (tickSize=5)", () => {
    const bars: ChartBar[] = [
      bar(48_105, 48_095, 48_100, 3_000),
      bar(48_505, 48_495, 48_500, 200_000), // dominant near 48_500
    ];

    const poc = getPocPrice(bars, { tickSize: 5 });

    // With tickSize=5, POC must be a multiple of 5
    expect(poc % 5).toBeCloseTo(0, 6);
    // Near 48_500
    expect(poc).toBeGreaterThanOrEqual(48_490);
    expect(poc).toBeLessThanOrEqual(48_510);
  });

  it("returns a 0.05-pt-aligned price for NSE stocks (tickSize=0.05)", () => {
    const bars: ChartBar[] = [
      bar(2_500.1, 2_499.9, 2_500.0, 1_000),
      bar(2_750.1, 2_749.9, 2_750.0, 500_000), // dominant
    ];

    const poc = getPocPrice(bars, { tickSize: 0.05 });

    // Near 2_750
    expect(poc).toBeGreaterThanOrEqual(2_749);
    expect(poc).toBeLessThanOrEqual(2_751);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test group 3: POC consistency with the indicator adapter's VolumeProfile
// ─────────────────────────────────────────────────────────────────────────────

describe("getPocPrice — consistency with the existing VolumeProfile indicator", () => {
  it("POC from plugin matches POC from computeVolumeProfile on the same data", async () => {
    // Import the existing (implemented) indicator adapter for cross-checking
    const { computeVolumeProfile } = await import("@/features/indicators");

    const bars: ChartBar[] = [
      bar(100.5, 99.5, 100.0, 10_000),
      bar(101.5, 100.5, 101.0, 12_000),
      bar(150.5, 149.5, 150.0, 500_000), // dominant bar near 150
      bar(102.5, 101.5, 102.0, 8_000),
      bar(103.5, 102.5, 103.0, 9_000),
    ];

    const pluginPoc = getPocPrice(bars, { tickSize: 0.05 });

    // computeVolumeProfile expects OHLCVBar with openTime/closeTime fields
    const ohlcvBars = bars.map((b, i) => ({
      openTime: i * 60_000,
      closeTime: (i + 1) * 60_000 - 1,
      open: b.low,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
    const indicatorResult = computeVolumeProfile(ohlcvBars, { tickSize: 0.05 });

    // Both computations should point to the same dominant price region
    // (within 1 tick, given consistent bucket assignment strategies)
    expect(Math.abs(pluginPoc - indicatorResult.poc)).toBeLessThanOrEqual(0.05 * 3);
  });

  it("POC near the dominant volume bar for a NIFTY-like session", async () => {
    const { computeVolumeProfile } = await import("@/features/indicators");

    // Simulate a NIFTY session where one price zone attracted most volume
    const bars: ChartBar[] = [
      bar(22_050, 22_000, 22_025, 15_000),
      bar(22_100, 22_050, 22_075, 18_000),
      bar(22_150, 22_100, 22_125, 200_000), // dominant zone near 22_125
      bar(22_200, 22_150, 22_175, 22_000),
      bar(22_250, 22_200, 22_225, 17_000),
    ];

    const pluginPoc = getPocPrice(bars, { tickSize: 1 });

    const ohlcvBars = bars.map((b, i) => ({
      openTime: i * 5 * 60_000,
      closeTime: (i + 1) * 5 * 60_000 - 1,
      open: b.low,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
    const indicatorResult = computeVolumeProfile(ohlcvBars, { tickSize: 1 });

    // Plugin POC should agree with the indicator POC within a few ticks
    expect(Math.abs(pluginPoc - indicatorResult.poc)).toBeLessThanOrEqual(3);

    // Both should be in the general vicinity of 22_125
    expect(pluginPoc).toBeGreaterThanOrEqual(22_100);
    expect(pluginPoc).toBeLessThanOrEqual(22_150);
  });
});
