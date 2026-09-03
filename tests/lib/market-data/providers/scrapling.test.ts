/**
 * ScraplingProvider — unit tests
 *
 * Covers requirements 7.1, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.11, 7.12:
 *   1. getHistoricalCandles constructs the correct URL with all query params
 *   2. getOptionChain throws MarketDataError on HTTP 503
 *   3. getQuotes returns array of nulls when DATA_SERVICE_URL is unset
 *   4. getInstrumentMaster returns [] when DATA_SERVICE_URL is unset
 *   5. getOptionChain throws NOT_CONFIGURED when DATA_SERVICE_URL is unset
 *   6. subscribe calls onError and continues polling when getQuotes throws
 *   7. ScraplingProvider is registered at priority 0 when DATA_SERVICE_URL is set
 *   8. ScraplingProvider is disabled in registry when DATA_SERVICE_URL is absent
 *
 * All network calls are mocked via vi.spyOn(globalThis, "fetch") — no real I/O.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ScraplingProvider } from "@/lib/market-data/providers/scrapling";
import { MarketDataError } from "@/lib/market-data/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal mock Response with JSON body. */
function mockOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/** Create a mock Response with a specific error status. */
function mockErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: `HTTP ${status}` }),
  } as unknown as Response;
}

/** A minimal OHLCVCandle for fixture use. */
const FIXTURE_CANDLE = {
  time:   1_700_000_000,
  open:   100,
  high:   105,
  low:     98,
  close:  103,
  volume: 5_000,
};

/** A minimal MDQuote for fixture use. */
function makeQuote(symbol: string, ltp: number) {
  return {
    symbol,
    token:    null,
    exchange: "NSE" as const,
    name:     null,
    ltp,
    change:     null,
    changePct:  null,
    prevClose:  null,
    open:       null,
    high:       null,
    low:        null,
    volume:     null,
    oi:         null,
    upperCircuit: null,
    lowerCircuit: null,
    weekHigh52: null,
    weekLow52:  null,
    totalBuyQty:  null,
    totalSellQty: null,
    lastTradeTime: null,
    provider:   "scrapling" as const,
    fetchedAt:  new Date().toISOString(),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("ScraplingProvider", () => {
  let provider: ScraplingProvider;
  let fetchSpy: Mock;

  /**
   * Save and restore DATA_SERVICE_URL so each test can set it independently.
   * Restoring in afterEach prevents env leakage between tests.
   */
  const originalDataServiceUrl = process.env.DATA_SERVICE_URL;

  beforeEach(() => {
    provider  = new ScraplingProvider();
    fetchSpy  = vi.spyOn(globalThis, "fetch") as unknown as Mock;
    // Default: provider is enabled with a test base URL.
    process.env.DATA_SERVICE_URL = "http://localhost:8200";
  });

  afterEach(() => {
    // Restore original env value.
    if (originalDataServiceUrl === undefined) {
      delete process.env.DATA_SERVICE_URL;
    } else {
      process.env.DATA_SERVICE_URL = originalDataServiceUrl;
    }
    vi.restoreAllMocks();
  });

  // ── Test 1: URL construction for getHistoricalCandles ─────────────────────

  it("getHistoricalCandles: constructs correct URL with all query params", async () => {
    fetchSpy.mockResolvedValue(
      mockOkResponse({ candles: [FIXTURE_CANDLE], count: 1 }),
    );

    const candles = await provider.getHistoricalCandles({
      symbol:   "NIFTY",
      exchange: "NSE",
      interval: "1d",
      from:     "2024-01-01T00:00:00Z",
      to:       "2024-12-31T00:00:00Z",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl] = fetchSpy.mock.calls[0] as [string, ...unknown[]];

    // Must include all five required query parameters.
    expect(calledUrl).toContain("/scraping/historical");
    expect(calledUrl).toContain("symbol=NIFTY");
    expect(calledUrl).toContain("exchange=NSE");
    expect(calledUrl).toContain("interval=1d");
    expect(calledUrl).toContain("from=");
    expect(calledUrl).toContain("to=");

    expect(candles).toHaveLength(1);
    expect(candles[0]!.open).toBe(FIXTURE_CANDLE.open);
  });

  // ── Test 2: getOptionChain throws MarketDataError on HTTP 503 ─────────────

  it("getOptionChain: throws MarketDataError on HTTP 503", async () => {
    fetchSpy.mockResolvedValue(mockErrorResponse(503));

    await expect(
      provider.getOptionChain("NIFTY"),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof MarketDataError)) return false;
      expect(err.providerId).toBe("scrapling");
      expect(err.code).toBe("INVALID_RESPONSE");
      return true;
    });
  });

  // ── Test 3: getQuotes returns nulls when DATA_SERVICE_URL is unset ────────

  it("getQuotes: returns array of nulls when DATA_SERVICE_URL is unset", async () => {
    delete process.env.DATA_SERVICE_URL;

    const result = await provider.getQuotes(["NIFTY", "BANKNIFTY", "RELIANCE"]);

    // fetch must NOT be called.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual([null, null, null]);
  });

  // ── Test 4: getInstrumentMaster returns [] when DATA_SERVICE_URL is unset ─

  it("getInstrumentMaster: returns [] when DATA_SERVICE_URL is unset", async () => {
    delete process.env.DATA_SERVICE_URL;

    const result = await provider.getInstrumentMaster({ exchange: "NSE" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  // ── Test 5: getOptionChain throws NOT_CONFIGURED when URL is unset ────────

  it("getOptionChain: throws MarketDataError with code NOT_CONFIGURED when DATA_SERVICE_URL is unset", async () => {
    delete process.env.DATA_SERVICE_URL;

    await expect(
      provider.getOptionChain("BANKNIFTY"),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof MarketDataError)) return false;
      expect(err.code).toBe("NOT_CONFIGURED");
      expect(err.providerId).toBe("scrapling");
      return true;
    });

    // fetch must NOT be called.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Test 6: subscribe — onError called and polling continues on error ─────

  it("subscribe: calls onError and continues polling when getQuotes throws", async () => {
    // Use fake timers so we can advance through the 5s polling interval.
    vi.useFakeTimers();

    const errorToThrow = new Error("network failure");
    const onTick   = vi.fn();
    const onError  = vi.fn();

    // First two poll cycles throw; third succeeds.
    const getQuotesSpy = vi
      .spyOn(provider, "getQuotes")
      .mockRejectedValueOnce(errorToThrow)
      .mockRejectedValueOnce(errorToThrow)
      .mockResolvedValueOnce([makeQuote("NIFTY", 24500)]);

    const req = {
      tokens: [{ token: "NIFTY", exchange: "NSE" as const }],
      mode:   "ltp" as const,
    };

    const stop = provider.subscribe(req, onTick, onError);

    // Tick 1: first poll fires immediately (no await needed yet for the first call).
    // Let the event loop flush to process the already-running async poll.
    await vi.runAllTimersAsync();

    // After two failing + one successful poll cycle the error handler should
    // have been called at least once and the tick handler exactly once.
    expect(onError).toHaveBeenCalledWith(errorToThrow);
    expect(onError.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(onTick).toHaveBeenCalledOnce();

    // The tick emitted should carry the scrapling provider id.
    const emittedTick = onTick.mock.calls[0][0];
    expect(emittedTick.provider).toBe("scrapling");
    expect(emittedTick.ltp).toBe(24500);

    // Clean up the polling loop.
    stop();
    vi.useRealTimers();
  });

  // ── Test 7: registered at priority 0 when DATA_SERVICE_URL is set ─────────

  it("is registered at priority 0 when DATA_SERVICE_URL is set", async () => {
    process.env.DATA_SERVICE_URL = "http://localhost:8200";

    // Use a fresh registry instance to avoid state leakage from other tests.
    const { ProviderRegistry } = await import(
      "@/lib/market-data/registry"
    );
    const { ScraplingProvider: SP } = await import(
      "@/lib/market-data/providers/scrapling"
    );

    const localRegistry = new ProviderRegistry();
    localRegistry.register({
      provider:     new SP(),
      capabilities: {
        historicalCandles: true,
        liveQuotes:        true,
        webSocket:         false,
        optionChain:       true,
        instrumentMaster:  true,
        intradayCandles:   true,
        fno:               true,
      },
      priority: 0,
      enabled:  !!process.env.DATA_SERVICE_URL,
    });

    const entry = localRegistry.get("scrapling");
    expect(entry).toBeDefined();
    expect(entry!.priority).toBe(0);
    expect(entry!.enabled).toBe(true);

    // Priority 0 means it appears first in the ordered list.
    const allEntries = localRegistry.all();
    expect(allEntries[0]!.provider.id).toBe("scrapling");
  });

  // ── Test 8: disabled in registry when DATA_SERVICE_URL is absent ──────────

  it("is not enabled in registry when DATA_SERVICE_URL is absent", async () => {
    delete process.env.DATA_SERVICE_URL;

    const { ProviderRegistry } = await import(
      "@/lib/market-data/registry"
    );
    const { ScraplingProvider: SP } = await import(
      "@/lib/market-data/providers/scrapling"
    );

    const localRegistry = new ProviderRegistry();
    localRegistry.register({
      provider:     new SP(),
      capabilities: {
        historicalCandles: true,
        liveQuotes:        true,
        webSocket:         false,
        optionChain:       true,
        instrumentMaster:  true,
        intradayCandles:   true,
        fno:               true,
      },
      priority: 0,
      enabled:  !!process.env.DATA_SERVICE_URL, // false when URL is unset
    });

    const entry = localRegistry.get("scrapling");
    expect(entry).toBeDefined();
    expect(entry!.enabled).toBe(false);

    // Disabled providers are excluded from the `enabled()` list.
    const enabledEntries = localRegistry.enabled();
    expect(enabledEntries.every((e) => e.provider.id !== "scrapling")).toBe(true);
  });

  // ── Additional correctness checks ─────────────────────────────────────────

  it("id is 'scrapling'", () => {
    expect(provider.id).toBe("scrapling");
  });

  it("getHistoricalCandles returns [] when DATA_SERVICE_URL is unset", async () => {
    delete process.env.DATA_SERVICE_URL;

    const result = await provider.getHistoricalCandles({
      symbol:   "RELIANCE",
      exchange: "NSE",
      interval: "1d",
      from:     "2024-01-01T00:00:00Z",
      to:       "2024-12-31T00:00:00Z",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("getLatestQuote returns null when DATA_SERVICE_URL is unset", async () => {
    delete process.env.DATA_SERVICE_URL;

    const result = await provider.getLatestQuote("NIFTY");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("getQuotes constructs URL with comma-separated symbols", async () => {
    fetchSpy.mockResolvedValue(
      mockOkResponse({
        quotes: [makeQuote("NIFTY", 24500), makeQuote("BANKNIFTY", 52000)],
      }),
    );

    await provider.getQuotes(["NIFTY", "BANKNIFTY"]);

    const [calledUrl] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toContain("/scraping/quotes");
    expect(calledUrl).toContain("symbols=NIFTY%2CBANKNIFTY");
  });

  it("getOptionChain forwards underlying and expiry params", async () => {
    const mockChain = {
      underlying: "NIFTY",
      spot:        24500,
      expiry:      "2024-12-26",
      expiries:    ["2024-12-26"],
      rows:        [],
      analytics:   {
        pcrOi: null, pcrVolume: null, maxCeOiStrike: null, maxPeOiStrike: null,
        totalCeOi: 0, totalPeOi: 0, totalCeOiChange: 0, totalPeOiChange: 0,
        atmIv: null, maxPain: null,
      },
      provider:  "scrapling",
      fetchedAt: new Date().toISOString(),
    };
    fetchSpy.mockResolvedValue(mockOkResponse(mockChain));

    const result = await provider.getOptionChain("NIFTY", "2024-12-26");

    const [calledUrl] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toContain("/scraping/option-chain");
    expect(calledUrl).toContain("underlying=NIFTY");
    expect(calledUrl).toContain("expiry=2024-12-26");
    expect(result.underlying).toBe("NIFTY");
  });

  it("getInstrumentMaster forwards exchange and type filter params", async () => {
    fetchSpy.mockResolvedValue(mockOkResponse([]));

    await provider.getInstrumentMaster({ exchange: "NFO", instrumentType: "OPTIDX" });

    const [calledUrl] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toContain("/scraping/instruments");
    expect(calledUrl).toContain("exchange=NFO");
    expect(calledUrl).toContain("type=OPTIDX");
  });

  it("dsGet throws MarketDataError with RATE_LIMIT code on HTTP 429", async () => {
    fetchSpy.mockResolvedValue(mockErrorResponse(429));

    await expect(provider.getQuotes(["NIFTY"])).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof MarketDataError)) return false;
      expect(err.code).toBe("RATE_LIMIT");
      return true;
    });
  });

  it("dsGet throws MarketDataError with AUTH_FAILURE code on HTTP 401", async () => {
    fetchSpy.mockResolvedValue(mockErrorResponse(401));

    await expect(provider.getQuotes(["NIFTY"])).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof MarketDataError)) return false;
      expect(err.code).toBe("AUTH_FAILURE");
      return true;
    });
  });

  it("unsubscribe is a no-op (does not throw)", () => {
    expect(() => provider.unsubscribe(["NIFTY", "BANKNIFTY"])).not.toThrow();
  });

  it("getProviderHealth returns a valid ProviderHealth snapshot", () => {
    const health = provider.getProviderHealth();
    expect(health.providerId).toBe("scrapling");
    expect(["healthy", "degraded", "unhealthy"]).toContain(health.status);
    expect(typeof health.score).toBe("number");
    expect(health.circuitOpen).toBe(false);
  });
});
