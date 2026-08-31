// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { withFailover, withRetry } from "@/lib/market-data/failover";
import { resetAllHealth, isCircuitOpen, getProviderHealth } from "@/lib/market-data/health";
import { MarketDataError } from "@/lib/market-data/types";
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

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a minimal stub MarketDataProvider that succeeds or fails on demand. */
function makeProvider(
  id: ProviderId,
  behaviour: "succeed" | "fail" | ((call: number) => "succeed" | "fail"),
): MarketDataProvider {
  let callCount = 0;
  const getResult = () => {
    callCount++;
    const result = typeof behaviour === "function" ? behaviour(callCount) : behaviour;
    return result;
  };

  return {
    id,
    async getHistoricalCandles(_req: HistoricalCandleRequest) {
      if (getResult() === "fail") throw new Error(`${id}: simulated error`);
      return [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }];
    },
    async getLatestQuote(_symbol: string) {
      if (getResult() === "fail") throw new Error(`${id}: simulated error`);
      return { symbol: "TEST", token: null, exchange: "NSE", name: null, ltp: 100, change: null, changePct: null, prevClose: null, open: null, high: null, low: null, volume: null, oi: null, weekHigh52: null, weekLow52: null, upperCircuit: null, lowerCircuit: null, totalBuyQty: null, totalSellQty: null, lastTradeTime: null, provider: id, fetchedAt: new Date().toISOString() } satisfies MDQuote;
    },
    async getQuotes(_symbols: string[]) {
      if (getResult() === "fail") throw new Error(`${id}: simulated error`);
      return [null];
    },
    async getOptionChain(_underlying: string, _expiry?: string): Promise<OptionChain> {
      throw new Error("not implemented in stub");
    },
    async getInstrumentMaster(_filter?: InstrumentMasterFilter): Promise<Instrument[]> {
      return [];
    },
    subscribe(_req: SubscribeRequest, _onTick: (t: LiveTick) => void) { return () => {}; },
    unsubscribe(_tokens: string[]) {},
    getProviderHealth(): ProviderHealth { return { providerId: id, status: "healthy", score: 100, lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, consecutiveSuccesses: 0, circuitOpen: false, circuitRetryAt: null, latencyP50Ms: null, latencyP99Ms: null }; },
  };
}

function makeEntry(
  id: ProviderId,
  priority: number,
  behaviour: "succeed" | "fail" | ((call: number) => "succeed" | "fail"),
): RegisteredProvider {
  return {
    provider: makeProvider(id, behaviour),
    capabilities: { historicalCandles: true, liveQuotes: true, webSocket: false, optionChain: true, instrumentMaster: false, intradayCandles: true, fno: true },
    priority,
    enabled: true,
  };
}

// A trivial operation that delegates to getLatestQuote
async function op(p: MarketDataProvider) {
  return p.getLatestQuote("TEST");
}

beforeEach(() => {
  resetAllHealth();
  // Disable sleep during tests to keep the suite fast
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── withFailover ──────────────────────────────────────────────────────────────

describe("withFailover()", () => {
  it("returns result from the first (highest-priority) provider", async () => {
    const entries = [
      makeEntry("angel_one", 1, "succeed"),
      makeEntry("upstox", 2, "fail"),
    ];
    const result = await withFailover(entries, op, "test");
    expect(result?.provider).toBe("angel_one");
  });

  it("moves to the second provider when the first fails all retries", async () => {
    const entries = [
      makeEntry("angel_one", 1, "fail"),
      makeEntry("upstox", 2, "succeed"),
    ];
    const resultPromise = withFailover(entries, op, "test");
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result?.provider).toBe("upstox");
  });

  it("throws MarketDataError when all providers are exhausted", async () => {
    const entries = [
      makeEntry("angel_one", 1, "fail"),
      makeEntry("upstox", 2, "fail"),
    ];
    const expectation = expect(withFailover(entries, op, "test")).rejects.toThrow(MarketDataError);
    await vi.runAllTimersAsync();
    await expectation;
  });

  it("skips providers with open circuits", async () => {
    // Open angel_one circuit by recording enough failures
    const { recordFailure } = await import("@/lib/market-data/health");
    for (let i = 0; i < 3; i++) recordFailure("angel_one", "auth_failure");
    expect(isCircuitOpen("angel_one")).toBe(true);

    const entries = [
      makeEntry("angel_one", 1, "succeed"), // should be skipped
      makeEntry("upstox", 2, "succeed"),
    ];
    const result = await withFailover(entries, op, "test");
    // Should have come from upstox since angel_one circuit is open
    expect(result?.provider).toBe("upstox");
  });

  it("throws when no providers are enabled", async () => {
    const entries = [
      { ...makeEntry("angel_one", 1, "fail"), enabled: false },
    ];
    await expect(withFailover(entries, op, "test")).rejects.toThrow(MarketDataError);
  });

  it("throws when the providers array is empty", async () => {
    await expect(withFailover([], op, "test")).rejects.toThrow(MarketDataError);
  });

  it("records a success on the winning provider after failover", async () => {
    const entries = [
      makeEntry("angel_one", 1, "fail"),
      makeEntry("upstox", 2, "succeed"),
    ];
    const promise = withFailover(entries, op, "test");
    await vi.runAllTimersAsync();
    await promise;
    const health = getProviderHealth("upstox");
    expect(health.consecutiveSuccesses).toBeGreaterThanOrEqual(1);
  });

  it("records failures on a failing provider", async () => {
    const entries = [
      makeEntry("angel_one", 1, "fail"),
      makeEntry("upstox", 2, "succeed"),
    ];
    const promise = withFailover(entries, op, "test");
    await vi.runAllTimersAsync();
    await promise;
    const health = getProviderHealth("angel_one");
    expect(health.consecutiveFailures).toBeGreaterThan(0);
  });
});

// ── Provider recovery ─────────────────────────────────────────────────────────

describe("provider recovery", () => {
  it("recovers a degraded provider when it starts succeeding again", async () => {
    // Degrade angel_one
    const { recordFailure, recordSuccess, getProviderHealth } = await import("@/lib/market-data/health");
    for (let i = 0; i < 4; i++) recordFailure("angel_one", "api_error");
    const degradedScore = getProviderHealth("angel_one").score;
    expect(degradedScore).toBeLessThan(60);

    // Simulate recovery
    for (let i = 0; i < 5; i++) recordSuccess("angel_one", 50);
    const recoveredScore = getProviderHealth("angel_one").score;
    expect(recoveredScore).toBeGreaterThan(degradedScore);
  });

  it("closes the circuit when the probe call succeeds", async () => {
    const { recordFailure, recordSuccess, isCircuitOpen } = await import("@/lib/market-data/health");

    // Open the circuit
    for (let i = 0; i < 3; i++) recordFailure("angel_one", "auth_failure");
    expect(isCircuitOpen("angel_one")).toBe(true);

    // Successful probe closes it
    recordSuccess("angel_one", 100);
    expect(isCircuitOpen("angel_one")).toBe(false);
  });

  it("succeeds with a previously failed provider once it's healthy again", async () => {
    const { recordFailure, recordSuccess } = await import("@/lib/market-data/health");

    // Degrade then recover
    for (let i = 0; i < 2; i++) recordFailure("angel_one", "api_error");
    for (let i = 0; i < 10; i++) recordSuccess("angel_one", 30);

    const entries = [makeEntry("angel_one", 1, "succeed")];
    const result = await withFailover(entries, op, "test");
    expect(result?.provider).toBe("angel_one");
  });
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe("withRetry()", () => {
  it("returns on first success without retrying", async () => {
    let calls = 0;
    const result = await withRetry("angel_one", async () => {
      calls++;
      return "ok";
    }, "test", 3);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries up to maxAttempts before throwing", async () => {
    let calls = 0;
    const expectation = expect(withRetry("upstox", async () => {
      calls++;
      throw new Error("always fails");
    }, "test", 3)).rejects.toThrow(MarketDataError);
    await vi.runAllTimersAsync();
    await expectation;
    expect(calls).toBe(3);
  });

  it("succeeds on a later attempt", async () => {
    let calls = 0;
    const resultPromise = withRetry("nse", async () => {
      calls++;
      if (calls < 3) throw new Error("not yet");
      return "success";
    }, "test", 5);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("stops immediately on auth_failure", async () => {
    let calls = 0;
    const expectation = expect(withRetry("angel_one", async () => {
      calls++;
      throw new Error("401 Unauthorized: JWT token expired");
    }, "test", 5)).rejects.toThrow(MarketDataError);
    await vi.runAllTimersAsync();
    await expectation;
    // Should stop after 1 attempt (auth failure = no retry)
    expect(calls).toBe(1);
  });
});
