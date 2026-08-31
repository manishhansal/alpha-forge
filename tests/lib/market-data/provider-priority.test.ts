// @vitest-environment node
/**
 * Provider priority, failover, and recovery integration tests.
 *
 * Each test creates its own fresh ProviderRegistry instance so the global
 * singleton is never touched and tests remain fully isolated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ProviderRegistry } from "@/lib/market-data/registry";
import { resetAllHealth, recordFailure, recordSuccess, isCircuitOpen, getProviderHealth } from "@/lib/market-data/health";
import { MarketDataError, PROVIDER_PRIORITY } from "@/lib/market-data/types";
import type { RegisteredProvider } from "@/lib/market-data/provider";
import type { MarketDataProvider } from "@/lib/market-data/provider";
import type {
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  LiveTick,
  MDQuote,
  OHLCVCandle,
  OptionChain,
  ProviderId,
  ProviderHealth,
  SubscribeRequest,
} from "@/lib/market-data/types";

// ── Stub provider factory ─────────────────────────────────────────────────────

type ProviderResult = {
  quote?: MDQuote | null;
  candles?: OHLCVCandle[];
  optionChain?: OptionChain;
  error?: Error;
};

function makeQuote(id: ProviderId): MDQuote {
  return {
    symbol: "TEST", token: null, exchange: "NSE", name: null,
    ltp: 100, change: 0, changePct: 0, prevClose: 100,
    open: null, high: null, low: null, volume: null, oi: null,
    weekHigh52: null, weekLow52: null, upperCircuit: null, lowerCircuit: null,
    totalBuyQty: null, totalSellQty: null, lastTradeTime: null,
    provider: id, fetchedAt: new Date().toISOString(),
  };
}

function stubProvider(id: ProviderId, results: ProviderResult): MarketDataProvider {
  return {
    id,
    async getHistoricalCandles(_req: HistoricalCandleRequest): Promise<OHLCVCandle[]> {
      if (results.error) throw results.error;
      return results.candles ?? [];
    },
    async getLatestQuote(_symbol: string): Promise<MDQuote | null> {
      if (results.error) throw results.error;
      return results.quote !== undefined ? results.quote : makeQuote(id);
    },
    async getQuotes(symbols: string[]): Promise<Array<MDQuote | null>> {
      if (results.error) throw results.error;
      return symbols.map(() => results.quote !== undefined ? results.quote : makeQuote(id));
    },
    async getOptionChain(_underlying: string, _expiry?: string): Promise<OptionChain> {
      if (results.error) throw results.error;
      if (results.optionChain) return results.optionChain;
      throw new Error("no option chain in stub");
    },
    async getInstrumentMaster(_filter?: InstrumentMasterFilter): Promise<Instrument[]> { return []; },
    subscribe(_req: SubscribeRequest, _onTick: (t: LiveTick) => void): () => void { return () => {}; },
    unsubscribe(_tokens: string[]): void {},
    getProviderHealth(): ProviderHealth {
      return { providerId: id, status: "healthy", score: 100, lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, consecutiveSuccesses: 0, circuitOpen: false, circuitRetryAt: null, latencyP50Ms: null, latencyP99Ms: null };
    },
  };
}

function makeEntry(
  id: ProviderId,
  priority: number,
  results: ProviderResult,
  enabled = true,
  caps: Partial<RegisteredProvider["capabilities"]> = {},
): RegisteredProvider {
  return {
    provider: stubProvider(id, results),
    capabilities: {
      historicalCandles: true, liveQuotes: true, webSocket: false,
      optionChain: true, instrumentMaster: true, intradayCandles: true, fno: true,
      ...caps,
    },
    priority,
    enabled,
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetAllHealth();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── PROVIDER_PRIORITY constant ────────────────────────────────────────────────

describe("PROVIDER_PRIORITY constant", () => {
  it("lists providers in the correct priority order", () => {
    expect(PROVIDER_PRIORITY).toEqual(["angel_one", "upstox", "nse", "yahoo"]);
  });
});

// ── Priority ordering ─────────────────────────────────────────────────────────

describe("provider priority ordering", () => {
  it("registers providers sorted by priority regardless of insertion order", () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("yahoo", 4, {}));
    r.register(makeEntry("angel_one", 1, {}));
    r.register(makeEntry("nse", 3, {}));
    r.register(makeEntry("upstox", 2, {}));

    const ids = r.all().map((e) => e.provider.id);
    expect(ids).toEqual(["angel_one", "upstox", "nse", "yahoo"]);
  });

  it("calls the highest-priority (priority=1) provider first", async () => {
    const r = new ProviderRegistry();
    const called: ProviderId[] = [];

    for (const [id, priority] of [["angel_one", 1], ["upstox", 2], ["nse", 3]] as const) {
      const p = stubProvider(id as ProviderId, {});
      const orig = p.getLatestQuote.bind(p);
      p.getLatestQuote = async (s) => { called.push(id as ProviderId); return orig(s); };
      r.register({ provider: p, capabilities: { historicalCandles: true, liveQuotes: true, webSocket: false, optionChain: false, instrumentMaster: false, intradayCandles: true, fno: false }, priority, enabled: true });
    }

    await r.getLatestQuote("TEST");
    expect(called[0]).toBe("angel_one");
  });

  it("replaces a provider when re-registering the same id", () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("angel_one", 1, {}));
    r.register(makeEntry("angel_one", 1, { quote: null })); // replacement
    expect(r.all().filter((e) => e.provider.id === "angel_one")).toHaveLength(1);
  });
});

// ── Failover sequence ─────────────────────────────────────────────────────────

describe("failover sequence", () => {
  it("falls over to the next provider when the first fails", async () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("angel_one", 1, { error: new Error("angel down") }));
    r.register(makeEntry("upstox", 2, {}));

    const promise = r.getLatestQuote("TEST");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result?.provider).toBe("upstox");
  });

  it("tries all providers before giving up", async () => {
    const r = new ProviderRegistry();
    const err = new Error("down");
    r.register(makeEntry("angel_one", 1, { error: err }));
    r.register(makeEntry("upstox", 2, { error: err }));
    r.register(makeEntry("nse", 3, { error: err }));
    r.register(makeEntry("yahoo", 4, { error: err }));

    const expectation = expect(r.getLatestQuote("TEST")).rejects.toThrow(MarketDataError);
    await vi.runAllTimersAsync();
    await expectation;
  });

  it("skips disabled providers", async () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("angel_one", 1, {}, false)); // disabled
    r.register(makeEntry("upstox", 2, {}));

    const result = await r.getLatestQuote("TEST");
    expect(result?.provider).toBe("upstox");
  });

  it("throws MarketDataError when all providers are disabled", async () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("angel_one", 1, {}, false));
    await expect(r.getLatestQuote("TEST")).rejects.toThrow(MarketDataError);
  });

  it("disable() prevents a provider from being used", async () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("angel_one", 1, {}));
    r.register(makeEntry("upstox", 2, {}));
    r.disable("angel_one");
    const result = await r.getLatestQuote("TEST");
    expect(result?.provider).toBe("upstox");
  });

  it("enable() re-enables a previously disabled provider", () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("angel_one", 1, {}));
    r.disable("angel_one");
    r.enable("angel_one");
    expect(r.get("angel_one")?.enabled).toBe(true);
  });
});

// ── Capability routing ────────────────────────────────────────────────────────

describe("capability-based routing (withCapability)", () => {
  it("returns only providers with the required capability", () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("yahoo", 4, {}, true, { optionChain: false }));
    r.register(makeEntry("angel_one", 1, {}, true, { optionChain: true }));

    const capable = r.withCapability("optionChain");
    expect(capable.map((e) => e.provider.id)).toEqual(["angel_one"]);
  });

  it("returns an empty array when no provider has the capability", () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("yahoo", 4, {}, true, { webSocket: false }));
    expect(r.withCapability("webSocket")).toHaveLength(0);
  });

  it("excludes disabled providers even if they have the capability", () => {
    const r = new ProviderRegistry();
    r.register(makeEntry("angel_one", 1, {}, false, { optionChain: true }));
    r.register(makeEntry("upstox", 2, {}, true, { optionChain: true }));
    expect(r.withCapability("optionChain").map((e) => e.provider.id)).toEqual(["upstox"]);
  });
});

// ── Health integration ────────────────────────────────────────────────────────

describe("circuit breaker integration", () => {
  it("skips providers whose circuit is open", async () => {
    // Open angel_one circuit before the registry is involved
    for (let i = 0; i < 3; i++) recordFailure("angel_one", "auth_failure");
    expect(isCircuitOpen("angel_one")).toBe(true);

    const r = new ProviderRegistry();
    r.register(makeEntry("angel_one", 1, {}));
    r.register(makeEntry("upstox", 2, {}));

    const result = await r.getLatestQuote("TEST");
    expect(result?.provider).toBe("upstox");
  });

  it("allows a probe after the circuit retry window elapses", () => {
    for (let i = 0; i < 3; i++) recordFailure("angel_one", "auth_failure");
    expect(isCircuitOpen("angel_one")).toBe(true);

    // Advance past the 30s retry window
    vi.advanceTimersByTime(31_000);
    expect(isCircuitOpen("angel_one")).toBe(false);
  });
});

// ── Provider recovery ─────────────────────────────────────────────────────────

describe("provider recovery", () => {
  it("recovers score after consecutive successes", () => {
    for (let i = 0; i < 4; i++) recordFailure("angel_one", "api_error");
    const degraded = getProviderHealth("angel_one").score;

    for (let i = 0; i < 5; i++) recordSuccess("angel_one", 30);
    expect(getProviderHealth("angel_one").score).toBeGreaterThan(degraded);
  });

  it("closes the circuit after a successful probe", () => {
    for (let i = 0; i < 3; i++) recordFailure("angel_one", "auth_failure");
    expect(isCircuitOpen("angel_one")).toBe(true);

    recordSuccess("angel_one", 50);
    expect(isCircuitOpen("angel_one")).toBe(false);
  });
});
