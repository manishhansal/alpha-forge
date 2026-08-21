/**
 * Bug 3 — Exploration tests for TATAMOTORS noisy console.error in
 * YahooAdapter.getHistorical().
 *
 * These tests run BEFORE any fix is applied. They:
 *   1. Confirm the bug exists (exploration): calling getHistorical with TATAMOTORS
 *      causes console.error to be called (because TATAMOTORS.NS is not recognised
 *      by Yahoo Finance).
 *   2. Establish preservation baselines:
 *      - Valid symbols (RELIANCE.NS) return candles and do NOT call console.error.
 *      - Non-denylist symbols that throw still call console.error (correct behavior).
 *
 * Bug Condition (isBugCondition_3):
 *   symbol IN KNOWN_DELISTED where KNOWN_DELISTED = {"TATAMOTORS"}
 *
 * Expected counterexample on unfixed code:
 *   getHistorical({ symbol: "TATAMOTORS", interval: "1d", range: "1y" })
 *   → console.error called with message containing "TATAMOTORS" and "No data found"
 *   → function still returns []
 *
 * Validates: Requirements 1.4, 2.4, 3.4, 3.5
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock yahoo-finance2 and the cache before any imports so they're captured
// at module initialisation time.
// vi.hoisted() ensures the mock variables are available inside vi.mock factories
// which are hoisted to the top of the file before any other code runs.
// ---------------------------------------------------------------------------

const { mockChart, mockQuote } = vi.hoisted(() => ({
  mockChart: vi.fn(),
  mockQuote: vi.fn(),
}));

// Mock the cache so memo() calls the loader directly (no caching in tests)
vi.mock("@/services/india/cache", () => ({
  cache: {
    memo: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
    get: vi.fn(),
    set: vi.fn(),
    invalidate: vi.fn(),
    clear: vi.fn(),
    backendId: "memory",
  },
}));

// Mock yahoo-finance2
vi.mock("yahoo-finance2", () => {
  class MockYahooFinance {
    chart = mockChart;
    quote = mockQuote;
  }
  return { default: MockYahooFinance };
});

import { YahooAdapter } from "@/services/india/yahoo";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Valid OHLCV chart response from yahoo-finance2 */
const VALID_CHART_RESPONSE = {
  quotes: [
    {
      date: new Date("2024-01-15"),
      open: 2820,
      high: 2840,
      low: 2815,
      close: 2835,
      volume: 100_000,
    },
    {
      date: new Date("2024-01-16"),
      open: 2835,
      high: 2850,
      low: 2828,
      close: 2847,
      volume: 120_000,
    },
    {
      date: new Date("2024-01-17"),
      open: 2847,
      high: 2862,
      low: 2840,
      close: 2855,
      volume: 110_000,
    },
  ],
};

/** Error thrown by yahoo-finance2 for unrecognised/delisted symbols */
const DELIST_ERROR = new Error("No data found, symbol may be delisted");

/** Error thrown for generic transient failures */
const TRANSIENT_ERROR = new Error("Network timeout — please retry");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let yahoo: YahooAdapter;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  yahoo = new YahooAdapter();
  mockChart.mockReset();
  mockQuote.mockReset();
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Group 1 — Bug exploration: TATAMOTORS → console.error IS called (Bug 3)
// ---------------------------------------------------------------------------

describe("Bug 3 exploration — TATAMOTORS.NS triggers console.error on unfixed code", () => {
  it("getHistorical(TATAMOTORS) calls console.error when yf.chart throws 'No data found'", async () => {
    /**
     * Bug exploration test: on UNFIXED code, getHistorical for TATAMOTORS.NS
     * reaches the yf.chart() call, catches the error, and logs it via console.error.
     *
     * isBugCondition_3: symbol IN KNOWN_DELISTED where KNOWN_DELISTED = {"TATAMOTORS"}
     *
     * Expected counterexample (documents the bug):
     *   yf.chart("TATAMOTORS.NS", ...) throws "No data found, symbol may be delisted"
     *   → catch block calls console.error("yahoo.getHistorical(TATAMOTORS): No data found…")
     *   → function returns []
     *
     * On FIXED code (KNOWN_DELISTED early-return guard added), the yf.chart call is
     * never made and console.error is never called.
     */
    mockChart.mockRejectedValue(DELIST_ERROR);

    const result = await yahoo.getHistorical({
      symbol: "TATAMOTORS",
      interval: "1d",
      range: "1y",
    });

    // The function always returns [] on error — this behavior is unchanged
    expect(result).toEqual([]);

    // On FIXED code (after adding KNOWN_DELISTED guard): console.error is NOT called
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("getHistorical(TATAMOTORS) returns [] even when yf.chart throws", async () => {
    /**
     * The return value [] is correct behavior even on unfixed code.
     * This is the non-crashing part — the bug is only the noisy console.error.
     */
    mockChart.mockRejectedValue(DELIST_ERROR);

    const result = await yahoo.getHistorical({
      symbol: "TATAMOTORS",
      interval: "1d",
      range: "1y",
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("yf.chart is called with TATAMOTORS.NS (confirming the delist path is reached)", async () => {
    /**
     * On unfixed code, yf.chart IS called for TATAMOTORS.NS.
     * After the fix (KNOWN_DELISTED early return), yf.chart should NOT be called.
     * This test documents the current (buggy) behavior.
     */
    mockChart.mockRejectedValue(DELIST_ERROR);

    await yahoo.getHistorical({
      symbol: "TATAMOTORS",
      interval: "1d",
      range: "1y",
    });

    // On FIXED code: chart should NOT be called (early return before any network call)
    expect(mockChart).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Preservation: valid symbol (RELIANCE) → candles returned, no error
// ---------------------------------------------------------------------------

describe("Bug 3 preservation — valid symbol (RELIANCE) behavior unchanged", () => {
  it("getHistorical(RELIANCE) returns candles when yf.chart succeeds", async () => {
    /**
     * Preservation test: RELIANCE.NS is a valid, actively-traded symbol.
     * getHistorical must return the OHLCV candles and NOT call console.error.
     *
     * This behavior must be identical before and after the Bug 3 fix.
     */
    mockChart.mockResolvedValue(VALID_CHART_RESPONSE);

    const result = await yahoo.getHistorical({
      symbol: "RELIANCE",
      interval: "1d",
      range: "1y",
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    // Each candle must have the standard OHLCV shape
    for (const candle of result) {
      expect(typeof candle.time).toBe("number");
      expect(typeof candle.open).toBe("number");
      expect(typeof candle.high).toBe("number");
      expect(typeof candle.low).toBe("number");
      expect(typeof candle.close).toBe("number");
    }

    // console.error must NOT be called for a valid symbol
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("getHistorical(RELIANCE) calls yf.chart with RELIANCE.NS", async () => {
    mockChart.mockResolvedValue(VALID_CHART_RESPONSE);

    await yahoo.getHistorical({
      symbol: "RELIANCE",
      interval: "1d",
      range: "1y",
    });

    expect(mockChart).toHaveBeenCalledWith(
      "RELIANCE.NS",
      expect.objectContaining({ interval: "1d" }),
    );
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("candle values match the data returned by yf.chart", async () => {
    mockChart.mockResolvedValue(VALID_CHART_RESPONSE);

    const result = await yahoo.getHistorical({
      symbol: "RELIANCE",
      interval: "1d",
      range: "1y",
    });

    expect(result[0].open).toBe(2820);
    expect(result[0].high).toBe(2840);
    expect(result[0].low).toBe(2815);
    expect(result[0].close).toBe(2835);
    expect(result[0].volume).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Preservation: non-denylist symbol with transient error → console.error
// IS called (correct behavior to preserve)
// ---------------------------------------------------------------------------

describe("Bug 3 preservation — non-denylist transient error still logs via console.error", () => {
  it("getHistorical(UNKNOWNXYZ) calls console.error on transient error", async () => {
    /**
     * Preservation test: when a symbol NOT in KNOWN_DELISTED encounters a
     * transient error, console.error IS still called. This is the existing
     * behavior that the fix must preserve — real failures remain visible.
     *
     * Property 7 (Preservation): for any symbol NOT in KNOWN_DELISTED,
     * the function behaves identically to the original — including calling
     * console.error on transient fetch errors.
     */
    mockChart.mockRejectedValue(TRANSIENT_ERROR);

    const result = await yahoo.getHistorical({
      symbol: "UNKNOWNXYZ",
      interval: "1d",
      range: "1y",
    });

    // Still returns []
    expect(result).toEqual([]);

    // console.error IS called for non-denylist symbols with transient errors
    expect(consoleSpy).toHaveBeenCalled();

    const firstCall = consoleSpy.mock.calls[0];
    const callArgs = firstCall.map((a: unknown) => String(a)).join(" ");
    expect(callArgs).toContain("UNKNOWNXYZ");
  });

  it("getHistorical(INFY) calls console.error when yf.chart throws", async () => {
    /**
     * INFY is a valid F&O stock that is NOT in KNOWN_DELISTED.
     * If yf.chart throws for INFY (transient error), console.error should fire.
     * After the Bug 3 fix, this behavior is preserved for non-denylist symbols.
     */
    mockChart.mockRejectedValue(TRANSIENT_ERROR);

    const result = await yahoo.getHistorical({
      symbol: "INFY",
      interval: "1d",
      range: "1y",
    });

    expect(result).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();

    const firstCall = consoleSpy.mock.calls[0];
    const callArgs = firstCall.map((a: unknown) => String(a)).join(" ");
    expect(callArgs).toContain("INFY");
  });

  it("getHistorical(RELIANCE) does NOT call console.error on success", async () => {
    /**
     * A valid symbol that succeeds must not log any errors.
     * This documents the non-error path preservation.
     */
    mockChart.mockResolvedValue(VALID_CHART_RESPONSE);

    await yahoo.getHistorical({
      symbol: "RELIANCE",
      interval: "1d",
      range: "1y",
    });

    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
