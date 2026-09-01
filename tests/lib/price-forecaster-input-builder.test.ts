/**
 * PriceForecasterInputBuilder — Unit Tests (Phase 3)
 *
 * Tests the full validation pipeline:
 *   - exactly 60 candles → OK
 *   - more than 60 candles → trimmed to 60, OK
 *   - 59 candles → INSUFFICIENT (fallback) / throws (required)
 *   - 0 candles → INSUFFICIENT
 *   - duplicate timestamps → deduped (result may still be INSUFFICIENT)
 *   - out-of-order timestamps → sorted correctly
 *   - NaN OHLC → VALIDATION_FAIL
 *   - invalid high/low → VALIDATION_FAIL
 *   - stale candles → STALE
 *   - ML_MODE=disabled → DISABLED immediately
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { OHLCVCandle } from "@/lib/market-data/types";
import {
  buildPriceForecasterInput,
  candlesToBarMatrix,
  PRICE_FORECASTER_LOOKBACK,
  PriceForecasterError,
} from "@/lib/india/price-forecaster-input-builder";

// ── Mock dependencies ─────────────────────────────────────────────────────────

vi.mock("@/lib/market-data/services/historical.service", () => ({
  getHistoricalCandlesByRange: vi.fn(),
}));

import { getHistoricalCandlesByRange } from "@/lib/market-data/services/historical.service";
const mockGetHistorical = getHistoricalCandlesByRange as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Now as epoch ms — used so tests are not clock-dependent. */
const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

/** 5-min interval in seconds. */
const INTERVAL_SEC = 5 * 60;

/**
 * Build a synthetic sequence of N valid 5-minute OHLCV candles ending just
 * before `nowMs`. Candles are confirmed (time < current-bar boundary).
 */
function makeCandles(count: number, endMs: number = NOW_MS): OHLCVCandle[] {
  // Current bar boundary: floor(nowMs / 300000) * 300
  const barBoundarySec = Math.floor(endMs / (INTERVAL_SEC * 1_000)) * INTERVAL_SEC;
  const candles: OHLCVCandle[] = [];
  for (let i = count; i >= 1; i--) {
    const time = barBoundarySec - i * INTERVAL_SEC;
    const base = 20000 + i;
    candles.push({
      time,
      open: base,
      high: base + 50,
      low: base - 50,
      close: base + 10,
      volume: 10000 + i,
    });
  }
  return candles;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("PriceForecasterInputBuilder", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: ML_MODE=fallback
    process.env.ML_MODE = "fallback";
  });

  afterEach(() => {
    delete process.env.ML_MODE;
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("returns OK with exactly 60 candles when exactly 60 valid candles available", async () => {
    mockGetHistorical.mockResolvedValue(makeCandles(60));

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("OK");
    expect(result.candles).toHaveLength(PRICE_FORECASTER_LOOKBACK);
    expect(result.invalidCount).toBe(0);
    expect(result.reason).toBeNull();
  });

  it("trims to exactly 60 candles when more than 60 are available", async () => {
    mockGetHistorical.mockResolvedValue(makeCandles(120));

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("OK");
    expect(result.candles).toHaveLength(PRICE_FORECASTER_LOOKBACK);
    expect(result.availableCount).toBeGreaterThanOrEqual(120);
  });

  it("candles are sorted ascending by time", async () => {
    const scrambled = makeCandles(60);
    // Shuffle
    for (let i = scrambled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [scrambled[i], scrambled[j]] = [scrambled[j]!, scrambled[i]!];
    }
    mockGetHistorical.mockResolvedValue(scrambled);

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("OK");
    for (let i = 1; i < result.candles.length; i++) {
      expect(result.candles[i]!.time).toBeGreaterThan(result.candles[i - 1]!.time);
    }
  });

  // ── Insufficient candles ──────────────────────────────────────────────────

  it("returns INSUFFICIENT when only 59 candles available (fallback mode)", async () => {
    mockGetHistorical.mockResolvedValue(makeCandles(59));

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("INSUFFICIENT");
    expect(result.candles).toHaveLength(0);
    expect(result.reason).toMatch(/insufficient/i);
  });

  it("throws PriceForecasterError when only 59 candles available (required mode)", async () => {
    process.env.ML_MODE = "required";
    mockGetHistorical.mockResolvedValue(makeCandles(59));

    await expect(
      buildPriceForecasterInput("NIFTY", "NSE", NOW_MS),
    ).rejects.toThrow(PriceForecasterError);
  });

  it("returns INSUFFICIENT on empty candle array", async () => {
    mockGetHistorical.mockResolvedValue([]);

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("INSUFFICIENT");
    expect(result.availableCount).toBe(0);
  });

  // ── Duplicate timestamps ──────────────────────────────────────────────────

  it("deduplicates candles with duplicate timestamps", async () => {
    const candles = makeCandles(60);
    // Inject 5 duplicates at the start
    const withDups = [...candles.slice(0, 5), ...candles];
    mockGetHistorical.mockResolvedValue(withDups);

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    // After deduplication we have exactly 60, so it should still be OK
    expect(result.status).toBe("OK");
    expect(result.candles).toHaveLength(PRICE_FORECASTER_LOOKBACK);
    // All timestamps must be unique
    const times = result.candles.map((c) => c.time);
    expect(new Set(times).size).toBe(times.length);
  });

  it("returns INSUFFICIENT when duplicates reduce count below 60", async () => {
    // 55 unique candles but with 5 duplicates
    const candles = makeCandles(55);
    const withDups = [...candles, ...candles.slice(0, 5)];
    mockGetHistorical.mockResolvedValue(withDups);

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("INSUFFICIENT");
  });

  // ── NaN / invalid OHLC ───────────────────────────────────────────────────

  it("returns VALIDATION_FAIL when majority of candles have NaN OHLC", async () => {
    const candles = makeCandles(60).map((c) => ({ ...c, open: NaN }));
    mockGetHistorical.mockResolvedValue(candles);

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("VALIDATION_FAIL");
    expect(result.candles).toHaveLength(0);
    expect(result.invalidCount).toBeGreaterThan(0);
  });

  it("tolerates a small number of invalid candles (< 20%) by filtering them", async () => {
    // 60 valid + 5 invalid = 65 raw; after filtering 60 valid remain
    const good = makeCandles(70);
    // Corrupt first 5 — these should be filtered, leaving 65 valid from 70
    const withBad = good.map((c, i) => (i < 5 ? { ...c, high: -1 } : c));
    mockGetHistorical.mockResolvedValue(withBad);

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);
    // 70 raw - 5 invalid = 65 valid, which is ≥ 60 → OK
    expect(result.status).toBe("OK");
    expect(result.invalidCount).toBe(5);
  });

  it("returns VALIDATION_FAIL when high < low in majority of candles", async () => {
    const candles = makeCandles(60).map((c) => ({
      ...c,
      high: c.low - 1,  // inverted: high below low
    }));
    mockGetHistorical.mockResolvedValue(candles);

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("VALIDATION_FAIL");
  });

  // ── Stale candles ────────────────────────────────────────────────────────

  it("returns STALE when most recent candle is more than 10 minutes old", async () => {
    const STALE_NOW = NOW_MS + 15 * 60 * 1_000; // advance time 15 min beyond last candle
    mockGetHistorical.mockResolvedValue(makeCandles(60, NOW_MS));

    const result = await buildPriceForecasterInput("NIFTY", "NSE", STALE_NOW);

    expect(result.status).toBe("STALE");
    expect(result.reason).toMatch(/stale/i);
  });

  it("does not flag as stale when most recent candle is within 10 minutes", async () => {
    // candles end NOW_MS − 1 * INTERVAL = 5 min behind nowMs
    mockGetHistorical.mockResolvedValue(makeCandles(60, NOW_MS));

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("OK");
  });

  // ── ML_MODE=disabled ────────────────────────────────────────────────────

  it("returns DISABLED immediately when ML_MODE=disabled, makes no network calls", async () => {
    process.env.ML_MODE = "disabled";

    const result = await buildPriceForecasterInput("NIFTY", "NSE", NOW_MS);

    expect(result.status).toBe("DISABLED");
    expect(result.candles).toHaveLength(0);
    expect(mockGetHistorical).not.toHaveBeenCalled();
  });

  // ── candlesToBarMatrix ───────────────────────────────────────────────────

  it("candlesToBarMatrix produces correct shape [N, 9]", () => {
    const candles = makeCandles(60);
    const matrix = candlesToBarMatrix(candles);

    expect(matrix).toHaveLength(60);
    for (const row of matrix) {
      expect(row).toHaveLength(9);
      // OHLCV should match source candle values
      expect(Number.isFinite(row[0])).toBe(true); // open
      expect(Number.isFinite(row[1])).toBe(true); // high
      expect(Number.isFinite(row[2])).toBe(true); // low
      expect(Number.isFinite(row[3])).toBe(true); // close
      expect(Number.isFinite(row[4])).toBe(true); // volume
      // Enrichment columns default to 0
      expect(row[5]).toBe(0); // vpin
      expect(row[6]).toBe(0); // atm_iv
      expect(row[7]).toBe(0); // pcr
      expect(row[8]).toBe(0); // oi_buildup
    }
  });

  it("candlesToBarMatrix preserves OHLCV values correctly", () => {
    const candle: OHLCVCandle = {
      time: 1700000000,
      open: 20100,
      high: 20200,
      low: 20050,
      close: 20150,
      volume: 50000,
    };
    const matrix = candlesToBarMatrix([candle]);

    expect(matrix[0]![0]).toBe(20100); // open
    expect(matrix[0]![1]).toBe(20200); // high
    expect(matrix[0]![2]).toBe(20050); // low
    expect(matrix[0]![3]).toBe(20150); // close
    expect(matrix[0]![4]).toBe(50000); // volume
  });
});
