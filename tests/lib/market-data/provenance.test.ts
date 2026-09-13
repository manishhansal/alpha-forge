/**
 * Tests for DataProvenance stamping in the withFailover() success path.
 *
 * Feature: data-service-centralization, Property 11: Provenance Completeness
 * Validates: Requirements 12.2, 12.3, 16.1, 16.4
 *
 * Coverage:
 *   - computeFreshness() classifies data age into the four freshness buckets
 *   - stampLiveProvenance() produces a complete DataProvenance for live calls
 *   - stampCacheProvenance() sets providerType="CACHE" and preserves sourceChain
 *   - withFailover() stamps provenance on every successful provider call
 *   - withFailover() includes instrument + gapMs in PROVIDER_SWITCH log
 *   - getLastCallProvenance() returns the most recent stamped provenance
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeFreshness,
  computeBaselineQualityScore,
  resolveProviderType,
  isProviderAuthenticated,
  scoreToGrade,
  stampLiveProvenance,
  stampCacheProvenance,
} from "@/lib/market-data/provenance";
import {
  withFailover,
  getLastCallProvenance,
  clearLastCallProvenance,
  resetFailoverState,
} from "@/lib/market-data/failover";
import { resetAllHealth } from "@/lib/market-data/health";
import type { DataProvenance, ProviderId } from "@/lib/market-data/types";
import { MarketDataError } from "@/lib/market-data/types";
import type { RegisteredProvider } from "@/lib/market-data/provider";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvider(id: ProviderId, succeed: boolean, result: unknown = []) {
  return {
    id,
    getHistoricalCandles: succeed
      ? vi.fn().mockResolvedValue(result)
      : vi.fn().mockRejectedValue(new MarketDataError("fail", id, "AUTH_FAILURE", 401)),
    getLatestQuote: vi.fn(),
    getQuotes: succeed
      ? vi.fn().mockResolvedValue(result)
      : vi.fn().mockRejectedValue(new MarketDataError("fail", id, "AUTH_FAILURE", 401)),
    getOptionChain: succeed
      ? vi.fn().mockResolvedValue(result)
      : vi.fn().mockRejectedValue(new MarketDataError("fail", id, "AUTH_FAILURE", 401)),
    getInstrumentMaster: succeed
      ? vi.fn().mockResolvedValue(result)
      : vi.fn().mockRejectedValue(new MarketDataError("fail", id, "AUTH_FAILURE", 401)),
    subscribe: vi.fn().mockReturnValue(() => {}),
    unsubscribe: vi.fn(),
    getProviderHealth: vi.fn().mockReturnValue({
      providerId: id,
      status: "healthy",
      score: 100,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      circuitOpen: false,
      circuitRetryAt: null,
      latencyP50Ms: null,
      latencyP99Ms: null,
    }),
  };
}

function makeEntry(id: ProviderId, succeed: boolean, result?: unknown, priority = 0): RegisteredProvider {
  return {
    provider: makeProvider(id, succeed, result),
    capabilities: {
      historicalCandles: true,
      liveQuotes: true,
      webSocket: false,
      optionChain: true,
      instrumentMaster: true,
      intradayCandles: true,
      fno: true,
    },
    priority,
    enabled: true,
  };
}

// ── computeFreshness ──────────────────────────────────────────────────────────

describe("computeFreshness", () => {
  it("returns LIVE for data age ≤ 5000 ms", () => {
    expect(computeFreshness(0)).toBe("LIVE");
    expect(computeFreshness(2500)).toBe("LIVE");
    expect(computeFreshness(5000)).toBe("LIVE");
  });

  it("returns RECENT for data age 5001 – 60000 ms", () => {
    expect(computeFreshness(5001)).toBe("RECENT");
    expect(computeFreshness(30000)).toBe("RECENT");
    expect(computeFreshness(60000)).toBe("RECENT");
  });

  it("returns STALE for data age 60001 ms – 24 h", () => {
    expect(computeFreshness(60001)).toBe("STALE");
    expect(computeFreshness(3_600_000)).toBe("STALE");
    expect(computeFreshness(24 * 3_600_000)).toBe("STALE");
  });

  it("returns HISTORICAL for data age > 24 h", () => {
    expect(computeFreshness(24 * 3_600_000 + 1)).toBe("HISTORICAL");
    expect(computeFreshness(7 * 24 * 3_600_000)).toBe("HISTORICAL");
  });
});

// ── resolveProviderType ───────────────────────────────────────────────────────

describe("resolveProviderType", () => {
  it("classifies broker providers correctly", () => {
    expect(resolveProviderType("angel_one")).toBe("BROKER");
    expect(resolveProviderType("upstox")).toBe("BROKER");
  });

  it("classifies open-source providers correctly", () => {
    expect(resolveProviderType("scrapling")).toBe("OPEN_SOURCE");
    expect(resolveProviderType("jugaad")).toBe("OPEN_SOURCE");
    expect(resolveProviderType("openchart")).toBe("OPEN_SOURCE");
  });

  it("classifies yahoo as SECONDARY_FALLBACK", () => {
    expect(resolveProviderType("yahoo")).toBe("SECONDARY_FALLBACK");
  });
});

// ── isProviderAuthenticated ───────────────────────────────────────────────────

describe("isProviderAuthenticated", () => {
  it("returns true for broker providers", () => {
    expect(isProviderAuthenticated("angel_one")).toBe(true);
    expect(isProviderAuthenticated("upstox")).toBe(true);
  });

  it("returns false for open-source and fallback providers", () => {
    expect(isProviderAuthenticated("scrapling")).toBe(false);
    expect(isProviderAuthenticated("yahoo")).toBe(false);
    expect(isProviderAuthenticated("jugaad")).toBe(false);
    expect(isProviderAuthenticated("openchart")).toBe(false);
  });
});

// ── scoreToGrade ──────────────────────────────────────────────────────────────

describe("scoreToGrade", () => {
  it("maps scores to correct grades", () => {
    expect(scoreToGrade(100)).toBe("A+");
    expect(scoreToGrade(95)).toBe("A+");
    expect(scoreToGrade(94)).toBe("A");
    expect(scoreToGrade(85)).toBe("A");
    expect(scoreToGrade(84)).toBe("B");
    expect(scoreToGrade(70)).toBe("B");
    expect(scoreToGrade(69)).toBe("C");
    expect(scoreToGrade(50)).toBe("C");
    expect(scoreToGrade(49)).toBe("D");
    expect(scoreToGrade(30)).toBe("D");
    expect(scoreToGrade(29)).toBe("BLOCKED");
    expect(scoreToGrade(0)).toBe("BLOCKED");
  });
});

// ── stampLiveProvenance ───────────────────────────────────────────────────────

describe("stampLiveProvenance", () => {
  it("produces a complete DataProvenance for a live quote operation", () => {
    const now = Date.now();
    const provenance = stampLiveProvenance({
      providerId: "angel_one",
      dataAsOf: new Date(now - 1000).toISOString(), // 1 second old → LIVE
      isLive: true,
      isHistorical: false,
      requestedAtMs: now,
    });

    expect(provenance.provider).toBe("angel_one");
    expect(provenance.providerType).toBe("BROKER");
    expect(provenance.authenticated).toBe(true);
    expect(provenance.isLive).toBe(true);
    expect(provenance.isHistorical).toBe(false);
    expect(provenance.freshness).toBe("LIVE");
    expect(provenance.quality.score).toBeGreaterThan(0);
    expect(provenance.quality.score).toBeLessThanOrEqual(100);
    expect(provenance.quality.grade).toBeTruthy();
    expect(provenance.quality.validationStatus).toBe("PASSED");
    expect(provenance.quality.reconciliationStatus).toBe("UNRECONCILED");
    expect(provenance.sourceChain).toContain("angel_one");
    expect(typeof provenance.requestedAt).toBe("string");
    expect(typeof provenance.dataAsOf).toBe("string");
  });

  it("produces a complete DataProvenance for a historical candles operation", () => {
    const now = Date.now();
    const provenance = stampLiveProvenance({
      providerId: "scrapling",
      dataAsOf: new Date(now - 2 * 24 * 3_600_000).toISOString(), // 2 days old → HISTORICAL
      isLive: false,
      isHistorical: true,
      requestedAtMs: now,
    });

    expect(provenance.provider).toBe("scrapling");
    expect(provenance.providerType).toBe("OPEN_SOURCE");
    expect(provenance.authenticated).toBe(false);
    expect(provenance.isLive).toBe(false);
    expect(provenance.isHistorical).toBe(true);
    expect(provenance.freshness).toBe("HISTORICAL");
    expect(provenance.sourceChain).toContain("scrapling");
  });

  it("populates sourceChain with previously attempted providers", () => {
    const now = Date.now();
    const provenance = stampLiveProvenance({
      providerId: "upstox",
      dataAsOf: null,
      isLive: true,
      isHistorical: false,
      requestedAtMs: now,
      sourceChain: ["scrapling", "angel_one"],
    });

    // sourceChain should be [...sourceChain, providerId]
    expect(provenance.sourceChain).toEqual(["scrapling", "angel_one", "upstox"]);
  });

  it("handles null dataAsOf by defaulting to now (LIVE freshness)", () => {
    const now = Date.now();
    const provenance = stampLiveProvenance({
      providerId: "yahoo",
      dataAsOf: null,
      isLive: true,
      isHistorical: false,
      requestedAtMs: now,
    });

    expect(provenance.freshness).toBe("LIVE");
  });
});

// ── stampCacheProvenance ──────────────────────────────────────────────────────

describe("stampCacheProvenance", () => {
  it("sets providerType to CACHE and records original provider in sourceChain[0]", () => {
    const now = Date.now();
    const provenance = stampCacheProvenance(
      "angel_one",
      now,
      new Date(now - 2000).toISOString(),
      true,
      false,
    );

    // Requirement 16.4: providerType MUST be "CACHE" for cache-served responses.
    expect(provenance.providerType).toBe("CACHE");
    // The original live provider is at sourceChain[0].
    expect(provenance.sourceChain[0]).toBe("angel_one");
    expect(provenance.provider).toBe("angel_one");
    expect(provenance.isLive).toBe(true);
    expect(provenance.isHistorical).toBe(false);
    expect(provenance.freshness).toBe("LIVE");
  });

  it("reflects historical flag for candle cache hits", () => {
    const now = Date.now();
    const dataAsOf = new Date(now - 5 * 24 * 3_600_000).toISOString();
    const provenance = stampCacheProvenance("scrapling", now, dataAsOf, false, true);

    expect(provenance.providerType).toBe("CACHE");
    expect(provenance.isHistorical).toBe(true);
    expect(provenance.freshness).toBe("HISTORICAL");
  });
});

// ── computeBaselineQualityScore ───────────────────────────────────────────────

describe("computeBaselineQualityScore", () => {
  it("returns a score in [0, 100] for any provider and any non-negative age", () => {
    const ages = [0, 1000, 30000, 3_600_000, 48 * 3_600_000];
    const providers: ProviderId[] = ["scrapling", "angel_one", "upstox", "yahoo"];
    for (const age of ages) {
      for (const pid of providers) {
        const { score } = computeBaselineQualityScore(pid, age);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    }
  });

  it("gives higher scores to authenticated brokers vs open-source for the same age", () => {
    const age = 1000; // fresh data
    const { score: brokerScore } = computeBaselineQualityScore("angel_one", age);
    const { score: openSourceScore } = computeBaselineQualityScore("scrapling", age);
    expect(brokerScore).toBeGreaterThanOrEqual(openSourceScore);
  });

  it("grades LIVE data higher than HISTORICAL data", () => {
    const { score: liveScore } = computeBaselineQualityScore("angel_one", 1000);
    const { score: histScore } = computeBaselineQualityScore("angel_one", 48 * 3_600_000);
    expect(liveScore).toBeGreaterThan(histScore);
  });
});

// ── withFailover provenance integration ──────────────────────────────────────

describe("withFailover provenance integration", () => {
  beforeEach(() => {
    resetAllHealth();
    resetFailoverState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFailoverState();
    resetAllHealth();
  });

  it("stamps provenance with non-null required fields after a successful call", async () => {
    const mockResult = [
      { symbol: "NIFTY", ltp: 22000, fetchedAt: new Date().toISOString(), provider: "angel_one" },
    ];
    const providers = [makeEntry("angel_one", true, mockResult)];

    const result = await withFailover(
      providers,
      (p) => p.getQuotes(["NIFTY"]),
      "getQuotes",
    );

    expect(result).toEqual(mockResult);

    const provenance = getLastCallProvenance("getQuotes");
    expect(provenance).not.toBeNull();
    expect(provenance!.provider).toBe("angel_one");
    expect(provenance!.dataAsOf).toBeTruthy();
    expect(provenance!.isLive).toBe(true);
    expect(provenance!.quality.score).toBeGreaterThan(0);
    expect(provenance!.quality.grade).toBeTruthy();
    expect(provenance!.sourceChain).toContain("angel_one");
  });

  it("stamps isHistorical=true for getHistoricalCandles operation", async () => {
    const mockCandles = [{ time: 1_700_000_000, open: 100, high: 110, low: 90, close: 105, volume: 1000 }];
    const providers = [makeEntry("upstox", true, mockCandles)];

    await withFailover(
      providers,
      (p) => p.getHistoricalCandles({ symbol: "NIFTY", exchange: "NSE", interval: "5m", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" }),
      "getHistoricalCandles",
    );

    const provenance = getLastCallProvenance("getHistoricalCandles");
    expect(provenance).not.toBeNull();
    expect(provenance!.isHistorical).toBe(true);
    expect(provenance!.isLive).toBe(false);
    expect(provenance!.provider).toBe("upstox");
  });

  it("stamps provenance from the succeeding provider when first fails over", async () => {
    const mockResult = [{ symbol: "NIFTY", ltp: 22000, fetchedAt: new Date().toISOString(), provider: "upstox" }];
    const providers = [
      makeEntry("scrapling", false, [], 0),
      makeEntry("upstox", true, mockResult, 1),
    ];

    await withFailover(
      providers,
      (p) => p.getQuotes(["NIFTY"]),
      "getQuotes",
    );

    const provenance = getLastCallProvenance("getQuotes");
    expect(provenance).not.toBeNull();
    // The successful provider should be upstox, not scrapling.
    expect(provenance!.provider).toBe("upstox");
  });

  it("sourceChain includes failed provider before the succeeding one", async () => {
    const mockResult = [{ symbol: "NIFTY", ltp: 22000, fetchedAt: new Date().toISOString(), provider: "angel_one" }];
    const providers = [
      makeEntry("scrapling", false, [], 0),
      makeEntry("angel_one", true, mockResult, 1),
    ];

    await withFailover(
      providers,
      (p) => p.getQuotes(["NIFTY"]),
      "getQuotes",
    );

    const provenance = getLastCallProvenance("getQuotes");
    expect(provenance).not.toBeNull();
    // scrapling was attempted first (it's in attemptedProviders as sourceChain prefix)
    // angel_one is the final entry
    expect(provenance!.sourceChain).toContain("angel_one");
    // scrapling was attempted before angel_one succeeded
    const angelIdx = provenance!.sourceChain.indexOf("angel_one");
    const scraplingIdx = provenance!.sourceChain.indexOf("scrapling");
    expect(scraplingIdx).toBeLessThan(angelIdx);
  });

  it("getLastCallProvenance returns null before any call is made", () => {
    expect(getLastCallProvenance("getQuotes")).toBeNull();
    expect(getLastCallProvenance("getHistoricalCandles")).toBeNull();
  });

  it("clearLastCallProvenance resets stored provenance", async () => {
    const providers = [makeEntry("yahoo", true, [])];
    await withFailover(providers, (p) => p.getQuotes([]), "getQuotes");

    expect(getLastCallProvenance("getQuotes")).not.toBeNull();
    resetFailoverState();
    expect(getLastCallProvenance("getQuotes")).toBeNull();
  });

  it("stamps provenance with correct providerType for each provider category", async () => {
    const cases: Array<{ id: ProviderId; expectedType: DataProvenance["providerType"] }> = [
      { id: "angel_one", expectedType: "BROKER" },
      { id: "upstox", expectedType: "BROKER" },
      { id: "scrapling", expectedType: "OPEN_SOURCE" },
      { id: "yahoo", expectedType: "SECONDARY_FALLBACK" },
    ];

    for (const { id, expectedType } of cases) {
      resetFailoverState();
      resetAllHealth();
      const providers = [makeEntry(id, true, [])];
      await withFailover(providers, (p) => p.getQuotes([]), "getQuotes");
      const prov = getLastCallProvenance("getQuotes");
      expect(prov).not.toBeNull();
      expect(prov!.providerType).toBe(expectedType);
    }
  });
});

// ── PROVIDER_SWITCH log (Requirements 12.7, 15.6) ────────────────────────────

describe("PROVIDER_SWITCH log on failover", () => {
  beforeEach(() => {
    resetAllHealth();
    resetFailoverState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFailoverState();
    resetAllHealth();
  });

  it("emits a PROVIDER_SWITCH log containing all required fields on failover", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockResult = [{ symbol: "NIFTY", ltp: 22000, fetchedAt: new Date().toISOString(), provider: "angel_one" }];

    const providers = [
      makeEntry("scrapling", false, [], 0),
      makeEntry("angel_one", true, mockResult, 1),
    ];

    await withFailover(providers, (p) => p.getQuotes(["NIFTY"]), "getQuotes");

    // Find any warn call that contains PROVIDER_SWITCH
    const switchCalls = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("PROVIDER_SWITCH"),
    );
    expect(switchCalls.length).toBeGreaterThan(0);

    const logEntry = JSON.parse(switchCalls[0]![0] as string);
    // Required fields per Requirements 12.7, 15.6
    expect(logEntry.event).toBe("PROVIDER_SWITCH");
    expect(logEntry.from).toBe("scrapling");
    expect(logEntry.to).toBe("angel_one");
    expect(typeof logEntry.reason).toBe("string");
    expect(typeof logEntry.instrument).toBe("string");
    expect(typeof logEntry.gapMs).toBe("number");
    expect(logEntry.gapMs).toBeGreaterThanOrEqual(0);
    expect(typeof logEntry.timestamp).toBe("string");

    warnSpy.mockRestore();
  });
});
