/**
 * Failing tests for the OpenAlgo broker adapter.
 *
 * Written BEFORE the implementation exists (Task 15.1 — TDD red phase).
 * These will fail with a module-not-found error until Task 15.2 is complete.
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.8 (Property 11, Property 15)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Global fetch mock — must be set up before importing the adapter so that the
// module-level fetch references are captured correctly.
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// The module import must come AFTER vi.stubGlobal so the adapter picks up the
// mock on module initialisation.
import { OpenAlgoAdapter } from "@/services/india/broker/openalgo-adapter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_URL = "https://openalgo.test";
const API_KEY = "test-api-key-abc123";

/** Canonical OpenAlgo quote API response shape. */
const OPENALGO_QUOTE_RESPONSE = {
  status: "success",
  data: {
    symbol: "RELIANCE",
    ltp: 2847.5,
    open: 2830.0,
    high: 2860.0,
    low: 2820.0,
    prev_close: 2835.0,
    change: 12.5,
    change_pct: 0.44,
    volume: 1_234_567,
  },
};

/** Canonical OpenAlgo historical (OHLCV) API response shape. */
const OPENALGO_HISTORICAL_RESPONSE = {
  status: "success",
  data: [
    { time: "2024-01-15T09:15:00+05:30", open: 2820, high: 2840, low: 2815, close: 2835, volume: 100_000 },
    { time: "2024-01-15T09:20:00+05:30", open: 2835, high: 2850, low: 2830, close: 2847, volume: 120_000 },
    { time: "2024-01-15T09:25:00+05:30", open: 2847, high: 2860, low: 2840, close: 2855, volume: 110_000 },
  ],
};

/** Canonical OpenAlgo placeOrder API response shape. */
const OPENALGO_ORDER_RESPONSE = {
  status: "success",
  data: {
    orderid: "ORDER-2024-001",
    status: "complete",
    symbol: "RELIANCE",
    quantity: 10,
    price: 2847.5,
    side: "BUY",
  },
};

/** Helper: build a resolved mock Response. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let adapter: OpenAlgoAdapter;

beforeEach(() => {
  adapter = new OpenAlgoAdapter(BASE_URL, API_KEY);
  fetchMock.mockReset();
  // Remove the live trading env var between tests so tests are isolated.
  delete process.env.LIVE_TRADING_ENABLED;
});

afterEach(() => {
  delete process.env.LIVE_TRADING_ENABLED;
});

// ---------------------------------------------------------------------------
// Tests — getQuote()
// ---------------------------------------------------------------------------

describe("OpenAlgoAdapter.getQuote()", () => {
  it("calls the correct quotes endpoint with the X-Api-Key header", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(OPENALGO_QUOTE_RESPONSE));

    await adapter.getQuote("RELIANCE");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${BASE_URL}/api/v1/quotes`);
    expect(url).toContain("RELIANCE");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe(API_KEY);
  });

  it("normalises the response to the Quote shape with required fields", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(OPENALGO_QUOTE_RESPONSE));

    const quote = await adapter.getQuote("RELIANCE");

    // Required Quote fields
    expect(quote.symbol).toBe("RELIANCE");
    expect(typeof quote.price).toBe("number");
    expect(quote.price).toBe(2847.5);
    expect(typeof quote.changePct).toBe("number");
    expect(quote.prevClose).toBe(2835.0);
    expect(typeof quote.fetchedAt).toBe("string");
    expect(quote.source).toBe("openalgo");
  });

  it("includes optional OHLCV fields in the Quote when the API provides them", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(OPENALGO_QUOTE_RESPONSE));

    const quote = await adapter.getQuote("RELIANCE");

    expect(quote.open).toBe(2830.0);
    expect(quote.high).toBe(2860.0);
    expect(quote.low).toBe(2820.0);
    expect(quote.volume).toBe(1_234_567);
  });

  it("throws when the API returns a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: "error", message: "Not found" }, 404));

    await expect(adapter.getQuote("INVALID")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — getHistorical()
// ---------------------------------------------------------------------------

describe("OpenAlgoAdapter.getHistorical()", () => {
  it("calls the historical endpoint with the correct query parameters", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(OPENALGO_HISTORICAL_RESPONSE));

    await adapter.getHistorical({ symbol: "RELIANCE", interval: "5m", range: "1d" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${BASE_URL}/api/v1/historical`);
    expect(url).toContain("RELIANCE");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe(API_KEY);
  });

  it("normalises the response to an OHLCV array with time/open/high/low/close/volume", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(OPENALGO_HISTORICAL_RESPONSE));

    const bars = await adapter.getHistorical({ symbol: "RELIANCE", interval: "5m", range: "1d" });

    expect(Array.isArray(bars)).toBe(true);
    expect(bars).toHaveLength(3);

    // Each bar must have the canonical OHLCV shape (Candle type)
    for (const bar of bars) {
      expect(typeof bar.time).toBe("number");   // unix timestamp (seconds)
      expect(typeof bar.open).toBe("number");
      expect(typeof bar.high).toBe("number");
      expect(typeof bar.low).toBe("number");
      expect(typeof bar.close).toBe("number");
    }
  });

  it("returns open/close/high/low values matching the raw API data", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(OPENALGO_HISTORICAL_RESPONSE));

    const bars = await adapter.getHistorical({ symbol: "RELIANCE", interval: "5m", range: "1d" });

    expect(bars[0].open).toBe(2820);
    expect(bars[0].high).toBe(2840);
    expect(bars[0].low).toBe(2815);
    expect(bars[0].close).toBe(2835);
    expect(bars[0].volume).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// Tests — placeOrder() — live trading guard (Property 11)
// ---------------------------------------------------------------------------

describe("OpenAlgoAdapter.placeOrder() — live trading guard", () => {
  const ORDER_PARAMS = {
    symbol: "RELIANCE",
    exchange: "NSE",
    side: "BUY" as const,
    quantity: 10,
    orderType: "MARKET" as const,
    product: "MIS" as const,
  };

  it("throws when LIVE_TRADING_ENABLED is not set", async () => {
    delete process.env.LIVE_TRADING_ENABLED;

    await expect(adapter.placeOrder(ORDER_PARAMS)).rejects.toThrow(
      /live trading is not enabled/i,
    );
  });

  it("throws when LIVE_TRADING_ENABLED is set to 'false'", async () => {
    process.env.LIVE_TRADING_ENABLED = "false";

    await expect(adapter.placeOrder(ORDER_PARAMS)).rejects.toThrow(
      /live trading is not enabled/i,
    );
  });

  it("throws when LIVE_TRADING_ENABLED is set to '1' (not exactly 'true')", async () => {
    process.env.LIVE_TRADING_ENABLED = "1";

    await expect(adapter.placeOrder(ORDER_PARAMS)).rejects.toThrow(
      /live trading is not enabled/i,
    );
  });

  it("does NOT make any HTTP request when LIVE_TRADING_ENABLED is not 'true'", async () => {
    delete process.env.LIVE_TRADING_ENABLED;

    try {
      await adapter.placeOrder(ORDER_PARAMS);
    } catch {
      // expected
    }

    // fetch must never have been called
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes exactly one POST request when LIVE_TRADING_ENABLED=true", async () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    fetchMock.mockResolvedValueOnce(mockResponse(OPENALGO_ORDER_RESPONSE));

    await adapter.placeOrder(ORDER_PARAMS);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${BASE_URL}/api/v1/placeorder`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe(API_KEY);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("returns a normalised OrderResult when the order succeeds", async () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    fetchMock.mockResolvedValueOnce(mockResponse(OPENALGO_ORDER_RESPONSE));

    const result = await adapter.placeOrder(ORDER_PARAMS);

    expect(result.orderId).toBe("ORDER-2024-001");
    expect(result.status).toBeDefined();
    expect(result.symbol).toBe("RELIANCE");
  });
});
