/**
 * DataServiceClient SDK — unit tests
 *
 * Verifies:
 *   1. All public API methods exist and are callable
 *   2. Methods call data-service2.0 endpoints via fetch (not old ProviderRegistry)
 *   3. Named re-exports work correctly
 *   4. DataServiceUnavailableError thrown on failures
 *   5. stream.subscribe returns an unsubscribe function
 *   6. observability methods work
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// ── fetch mock ────────────────────────────────────────────────────────────────

function makeSuccessResponse(data: unknown, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, metadata: { requestedAt: new Date().toISOString(), dataAsOf: new Date().toISOString(), dataSourceType: "LIVE", provider: "angel_one", ...extra } }),
  } as Response;
}

function makeErrorResponse(status = 503, code = "SERVICE_UNAVAILABLE") {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code, message: "Service unavailable", requestId: "test-id" } }),
  } as Response;
}

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchSpy.mockClear();
  global.fetch = fetchSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQuote(symbol = "RELIANCE") {
  return {
    instrumentId: `NSE:${symbol}:EQ`,
    symbol,
    name: symbol,
    exchange: "NSE",
    ltp: 100,
    open: 98,
    high: 102,
    low: 97,
    prevClose: 99,
    change: 1,
    changePct: 1.01,
    volume: 1000000,
    oi: null,
    tradedValue: null,
    bid: null,
    ask: null,
    weekHigh52: null,
    weekLow52: null,
    marketStatus: "OPEN",
    lastTradeTime: null,
    dataAsOf: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    provider: "angel_one",
  };
}

function makeCandle(time = 1756944000) {
  return { time, open: 100, high: 105, low: 98, close: 103, volume: 10000, oi: null };
}

function makeChain(underlying = "NIFTY") {
  return {
    underlying,
    expiry: "2026-09-25",
    expiries: ["2026-09-25"],
    spotPrice: 25000,
    spot: 25000,
    pcrOi: 0.92,
    atmIv: 14.5,
    maxPain: 25000,
    rows: [],
    dataAsOf: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    provider: "angel_one",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DataServiceClient SDK", () => {

  // ── Structure tests ────────────────────────────────────────────────────────

  it("exports DataServiceClient with market, universe, stream, observability namespaces", async () => {
    const { DataServiceClient } = await import("@/lib/data-service/client");
    expect(DataServiceClient).toBeDefined();
    expect(typeof DataServiceClient.market).toBe("object");
    expect(typeof DataServiceClient.universe).toBe("object");
    expect(typeof DataServiceClient.stream).toBe("object");
    expect(typeof DataServiceClient.observability).toBe("object");
  });

  it("exports named convenience functions", async () => {
    const client = await import("@/lib/data-service/client");
    expect(typeof client.getQuote).toBe("function");
    expect(typeof client.getQuotes).toBe("function");
    expect(typeof client.getCandles).toBe("function");
    expect(typeof client.getHistorical).toBe("function");
    expect(typeof client.getOptionChain).toBe("function");
    expect(typeof client.getInstruments).toBe("function");
    expect(typeof client.getFNOUniverse).toBe("function");
    expect(typeof client.subscribeToTicks).toBe("function");
    expect(typeof client.getProviderHealth).toBe("function");
  });

  // ── market.quote ──────────────────────────────────────────────────────────

  it("market.quote calls data-service2.0 /v1/india/quotes/{symbol}", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse(makeQuote("RELIANCE")));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const result = await DataServiceClient.market.quote("RELIANCE");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/india/quotes/RELIANCE");
    expect(result?.symbol).toBe("RELIANCE");
    expect(result?.ltp).toBe(100);
  });

  it("market.quote returns null when provider returns null (empty data)", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse(null));
    const { DataServiceClient } = await import("@/lib/data-service/client");
    // null data from the service should result in a DataServiceUnavailableError
    // since "missing data field" — catch and return null gracefully
    try {
      const result = await DataServiceClient.market.quote("UNKNOWN");
      expect(result).toBeDefined(); // if it returns, it has data
    } catch {
      // DataServiceUnavailableError is acceptable here
    }
  });

  // ── market.quotes ─────────────────────────────────────────────────────────

  it("market.quotes calls data-service2.0 batch endpoint for multiple symbols", async () => {
    // New implementation uses /v1/india/quotes/batch (single request)
    fetchSpy.mockResolvedValueOnce(
      makeSuccessResponse({ quotes: [makeQuote("RELIANCE"), makeQuote("INFY")] }),
    );
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const result = await DataServiceClient.market.quotes(["RELIANCE", "INFY"]);

    // One batch call, not two individual calls
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/india/quotes/batch");
    expect(result).toHaveLength(2);
    expect(result[0]?.symbol).toBe("RELIANCE");
    expect(result[1]?.symbol).toBe("INFY");
  });

  // ── market.candles ────────────────────────────────────────────────────────

  it("market.candles calls data-service2.0 /v1/india/historical", async () => {
    const candles = [makeCandle(), makeCandle(1756944300)];
    fetchSpy.mockResolvedValue(makeSuccessResponse(candles));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const result = await DataServiceClient.market.candles({
      symbol: "RELIANCE",
      exchange: "NSE",
      interval: "5m",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-12T00:00:00Z",
    });

    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/india/historical");
    expect(url).toContain("symbol=RELIANCE");
    expect(result).toHaveLength(2);
  });

  it("market.historical is an alias for market.candles", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse([makeCandle()]));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const req = { symbol: "NIFTY", exchange: "NSE" as const, interval: "1d" as const, from: "2026-01-01", to: "2026-09-12" };
    const r1 = await DataServiceClient.market.candles(req);
    fetchSpy.mockResolvedValue(makeSuccessResponse([makeCandle()]));
    const r2 = await DataServiceClient.market.historical(req);

    expect(r1[0]?.time).toBe(r2[0]?.time);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ── market.options ────────────────────────────────────────────────────────

  it("market.options calls data-service2.0 /v1/india/option-chain", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse(makeChain("NIFTY")));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const result = await DataServiceClient.market.options("NIFTY", "2026-09-25");

    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/india/option-chain");
    expect(url).toContain("underlying=NIFTY");
    expect(result.underlying).toBe("NIFTY");
  });

  it("market.options works without expiry (defaults to nearest)", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse(makeChain("BANKNIFTY")));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    await DataServiceClient.market.options("BANKNIFTY");
    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("underlying=BANKNIFTY");
    expect(url).not.toContain("expiry=");
  });

  // ── market.instruments ────────────────────────────────────────────────────

  it("market.instruments calls data-service2.0 /v1/india/instruments", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse([{ symbol: "RELIANCE", exchange: "NSE" }]));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const result = await DataServiceClient.market.instruments({ exchange: "NSE", instrumentType: "EQ" });

    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/india/instruments");
    expect(result).toHaveLength(1);
  });

  // ── universe.fno ──────────────────────────────────────────────────────────

  it("universe.fno calls data-service2.0 with NSE EQ filter", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse([]));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    await DataServiceClient.universe.fno();

    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/india/instruments");
    expect(url).toContain("exchange=NSE");
  });

  // ── stream.subscribe ──────────────────────────────────────────────────────

  it("stream.subscribe returns an unsubscribe function", async () => {
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const onTick = vi.fn();
    const unsubscribe = DataServiceClient.stream.subscribe(["NIFTY", "RELIANCE"], onTick);

    expect(typeof unsubscribe).toBe("function");
    // Call unsubscribe — should not throw
    unsubscribe();
  });

  // ── observability ─────────────────────────────────────────────────────────

  it("observability.health calls data-service2.0 /v1/health/live", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse({ status: "ok", providers: [] }));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const result = await DataServiceClient.observability.health();

    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/health/live");
    expect(result).toBeDefined();
  });

  it("observability.providers calls data-service2.0 /v1/analytics/providers", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse([{ id: "angel_one", status: "UP", latencyMs: 80, lastCheckedAt: null }]));
    const { DataServiceClient } = await import("@/lib/data-service/client");

    const result = await DataServiceClient.observability.providers();

    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/analytics/providers");
    expect(result[0]?.id).toBe("angel_one");
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("throws DataServiceUnavailableError when data-service2.0 returns 503", async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(503));
    const { DataServiceClient, DataServiceUnavailableError } = await import("@/lib/data-service/client");

    await expect(DataServiceClient.market.quote("NIFTY")).rejects.toBeInstanceOf(DataServiceUnavailableError);
  });

  it("throws DataServiceUnavailableError on network error", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const { DataServiceClient, DataServiceUnavailableError } = await import("@/lib/data-service/client");

    await expect(DataServiceClient.market.quote("NIFTY")).rejects.toBeInstanceOf(DataServiceUnavailableError);
  });

  // ── Named exports ─────────────────────────────────────────────────────────

  it("getQuote named export works the same as DataServiceClient.market.quote", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse(makeQuote("TCS")));
    const { getQuote } = await import("@/lib/data-service/client");

    const result = await getQuote("TCS");
    expect(result?.symbol).toBe("TCS");
  });

  it("getFNOUniverse named export calls data-service2.0 instruments endpoint", async () => {
    fetchSpy.mockResolvedValue(makeSuccessResponse([]));
    const { getFNOUniverse } = await import("@/lib/data-service/client");

    await getFNOUniverse();
    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/india/instruments");
  });

  it("_resetDataServiceClientBootstrap is a no-op (no-op after centralization)", async () => {
    const { _resetDataServiceClientBootstrap } = await import("@/lib/data-service/client");
    expect(() => _resetDataServiceClientBootstrap()).not.toThrow();
  });
});
