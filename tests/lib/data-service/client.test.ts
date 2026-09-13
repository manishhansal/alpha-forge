/**
 * DataServiceClient SDK — unit tests (prompt §40)
 *
 * Verifies:
 *   1. All public API methods exist and are callable
 *   2. Methods route through the registry (not directly to providers)
 *   3. Named re-exports work correctly
 *   4. Bootstrap is idempotent (called once for multiple SDK calls)
 *   5. stream.subscribe returns an unsubscribe function
 *   6. observability.providerHealth returns health array
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MDQuote, OHLCVCandle, OptionChain, Instrument, ProviderHealth } from "@/lib/market-data/types";

vi.mock("server-only", () => ({}));

// ── Registry mock ─────────────────────────────────────────────────────────────

const mockRegistry = {
  getLatestQuote: vi.fn(),
  getQuotes: vi.fn(),
  getHistoricalCandles: vi.fn(),
  getOptionChain: vi.fn(),
  getInstrumentMaster: vi.fn(),
  subscribe: vi.fn(),
  getHealth: vi.fn(),
  getProviderHealth: vi.fn(),
};

const bootstrapSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/market-data/registry", () => ({
  registry: mockRegistry,
  bootstrapRegistry: bootstrapSpy,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQuote(symbol: string): MDQuote {
  return {
    symbol, token: null, exchange: "NSE", name: symbol,
    ltp: 100, change: 1, changePct: 1, prevClose: 99,
    open: 98, high: 102, low: 97, volume: 1000000,
    oi: null, weekHigh52: null, weekLow52: null,
    upperCircuit: null, lowerCircuit: null,
    totalBuyQty: null, totalSellQty: null,
    lastTradeTime: null, provider: "angel_one",
    fetchedAt: new Date().toISOString(),
  };
}

function makeCandle(time = 1756944000): OHLCVCandle {
  return { time, open: 100, high: 105, low: 98, close: 103, volume: 10000 };
}

function makeChain(underlying: string): OptionChain {
  return {
    underlying, spot: 25000, expiry: "2026-09-25",
    expiries: ["2026-09-25", "2026-10-30"],
    rows: [], analytics: {
      pcrOi: null, pcrVolume: null, maxCeOiStrike: null, maxPeOiStrike: null,
      totalCeOi: 0, totalPeOi: 0, totalCeOiChange: 0, totalPeOiChange: 0,
      atmIv: null, maxPain: null,
    },
    provider: "angel_one",
    fetchedAt: new Date().toISOString(),
  };
}

function makeHealth(): ProviderHealth {
  return {
    providerId: "angel_one", status: "healthy", score: 95,
    lastSuccessAt: new Date().toISOString(), lastFailureAt: null,
    consecutiveFailures: 0, consecutiveSuccesses: 10,
    circuitOpen: false, circuitRetryAt: null,
    latencyP50Ms: 80, latencyP95Ms: 150, latencyP99Ms: 200,
    requestCount: 10, successCount: 10, errorCount: 0, successRate: 1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DataServiceClient SDK", () => {
  beforeEach(() => {
    vi.resetModules();
    bootstrapSpy.mockClear();
    Object.values(mockRegistry).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockClear());
  });

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
    expect(typeof client.subscribeQuotes).toBe("function");
    expect(typeof client.getProviderHealth).toBe("function");
  });

  // ── market.quote ──────────────────────────────────────────────────────────

  it("market.quote calls registry.getLatestQuote with the symbol", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getLatestQuote.mockResolvedValue(makeQuote("RELIANCE"));

    const result = await DataServiceClient.market.quote("RELIANCE");

    expect(mockRegistry.getLatestQuote).toHaveBeenCalledWith("RELIANCE", undefined);
    expect(result?.symbol).toBe("RELIANCE");
    expect(result?.ltp).toBe(100);
  });

  it("market.quote bootstraps the registry exactly once", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getLatestQuote.mockResolvedValue(null);

    await DataServiceClient.market.quote("NIFTY");
    await DataServiceClient.market.quote("BANKNIFTY");
    await DataServiceClient.market.quote("RELIANCE");

    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
  });

  it("market.quote returns null when provider returns null", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getLatestQuote.mockResolvedValue(null);

    const result = await DataServiceClient.market.quote("UNKNOWN");
    expect(result).toBeNull();
  });

  // ── market.quotes ─────────────────────────────────────────────────────────

  it("market.quotes calls registry.getQuotes with symbol array", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getQuotes.mockResolvedValue([makeQuote("RELIANCE"), makeQuote("INFY")]);

    const result = await DataServiceClient.market.quotes(["RELIANCE", "INFY"]);

    expect(mockRegistry.getQuotes).toHaveBeenCalledWith(["RELIANCE", "INFY"], undefined);
    expect(result).toHaveLength(2);
    expect(result[0]?.symbol).toBe("RELIANCE");
    expect(result[1]?.symbol).toBe("INFY");
  });

  // ── market.candles ────────────────────────────────────────────────────────

  it("market.candles calls registry.getHistoricalCandles with full request", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    const expectedCandles = [makeCandle(), makeCandle(1756944300)];
    mockRegistry.getHistoricalCandles.mockResolvedValue(expectedCandles);

    const req = {
      symbol: "RELIANCE",
      exchange: "NSE" as const,
      interval: "5m" as const,
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-12T00:00:00Z",
    };
    const result = await DataServiceClient.market.candles(req);

    expect(mockRegistry.getHistoricalCandles).toHaveBeenCalledWith(req, undefined);
    expect(result).toHaveLength(2);
  });

  it("market.historical is an alias for market.candles", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getHistoricalCandles.mockResolvedValue([makeCandle()]);

    const req = { symbol: "NIFTY", exchange: "NSE" as const, interval: "1d" as const, from: "2026-01-01T00:00:00Z", to: "2026-09-12T00:00:00Z" };
    // Call candles — mock records first call
    const r1 = await DataServiceClient.market.candles(req);
    // Call historical — same mock, same result
    const r2 = await DataServiceClient.market.historical(req);

    // Both return the same shape from the same mock
    expect(r1[0]?.time).toBe(r2[0]?.time);
    expect(r1[0]?.close).toBe(r2[0]?.close);
    // Both went through getHistoricalCandles (2 calls total)
    expect(mockRegistry.getHistoricalCandles).toHaveBeenCalledTimes(2);
  });

  // ── market.options ────────────────────────────────────────────────────────

  it("market.options calls registry.getOptionChain with underlying + expiry", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getOptionChain.mockResolvedValue(makeChain("NIFTY"));

    const result = await DataServiceClient.market.options("NIFTY", "2026-09-25");

    expect(mockRegistry.getOptionChain).toHaveBeenCalledWith("NIFTY", "2026-09-25", undefined);
    expect(result.underlying).toBe("NIFTY");
  });

  it("market.options works without expiry (defaults to nearest)", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getOptionChain.mockResolvedValue(makeChain("BANKNIFTY"));

    await DataServiceClient.market.options("BANKNIFTY");
    expect(mockRegistry.getOptionChain).toHaveBeenCalledWith("BANKNIFTY", undefined, undefined);
  });

  // ── market.instruments ────────────────────────────────────────────────────

  it("market.instruments calls registry.getInstrumentMaster with filter", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    const inst: Instrument = {
      token: "1234", tradingSymbol: "RELIANCE", name: "Reliance Industries",
      exchange: "NSE", segment: "EQ", instrumentType: "EQ",
      lotSize: 1, isin: "INE002A01018", expiry: null, strike: null,
      optionType: null, tickSize: 0.05,
    };
    mockRegistry.getInstrumentMaster.mockResolvedValue([inst]);

    const result = await DataServiceClient.market.instruments({ exchange: "NSE", instrumentType: "EQ" });

    expect(mockRegistry.getInstrumentMaster).toHaveBeenCalledWith(
      { exchange: "NSE", instrumentType: "EQ" },
      undefined,
    );
    expect(result[0]?.tradingSymbol).toBeDefined();
  });

  // ── universe.fno ──────────────────────────────────────────────────────────

  it("universe.fno calls getInstrumentMaster with NSE EQ filter", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getInstrumentMaster.mockResolvedValue([]);

    await DataServiceClient.universe.fno();

    expect(mockRegistry.getInstrumentMaster).toHaveBeenCalledWith(
      { exchange: "NSE", instrumentType: "EQ" },
      undefined,
    );
  });

  // ── stream.subscribe ──────────────────────────────────────────────────────

  it("stream.subscribe returns an unsubscribe function", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    const mockUnsubscribe = vi.fn();
    mockRegistry.subscribe.mockReturnValue(mockUnsubscribe);

    const onTick = vi.fn();
    const unsubscribe = DataServiceClient.stream.subscribe(
      { tokens: [{ token: "1234", exchange: "NSE" }], mode: "ltp" },
      onTick,
    );

    expect(typeof unsubscribe).toBe("function");
    // Call unsubscribe — should not throw
    unsubscribe();
  });

  // ── observability.providerHealth ─────────────────────────────────────────

  it("observability.providerHealth calls registry.getHealth", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getHealth.mockReturnValue([makeHealth()]);

    const result = await DataServiceClient.observability.providerHealth();

    expect(mockRegistry.getHealth).toHaveBeenCalledTimes(1);
    expect(result[0]?.providerId).toBe("angel_one");
    expect(result[0]?.status).toBe("healthy");
  });

  it("observability.providerHealthById calls registry.getProviderHealth", async () => {
    const { _resetDataServiceClientBootstrap, DataServiceClient } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getProviderHealth.mockReturnValue(makeHealth());

    const result = await DataServiceClient.observability.providerHealthById("angel_one");
    expect(mockRegistry.getProviderHealth).toHaveBeenCalledWith("angel_one");
    expect(result?.status).toBe("healthy");
  });

  // ── Named exports ─────────────────────────────────────────────────────────

  it("getQuote named export works the same as DataServiceClient.market.quote", async () => {
    const { _resetDataServiceClientBootstrap, getQuote } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getLatestQuote.mockResolvedValue(makeQuote("TCS"));

    const result = await getQuote("TCS");
    expect(result?.symbol).toBe("TCS");
  });

  it("getFNOUniverse named export delegates to universe.fno", async () => {
    const { _resetDataServiceClientBootstrap, getFNOUniverse } = await import("@/lib/data-service/client");
    _resetDataServiceClientBootstrap();
    mockRegistry.getInstrumentMaster.mockResolvedValue([]);

    await getFNOUniverse();
    expect(mockRegistry.getInstrumentMaster).toHaveBeenCalledWith(
      { exchange: "NSE", instrumentType: "EQ" },
      undefined,
    );
  });
});
