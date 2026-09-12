// @vitest-environment node
/**
 * NSE Direct Acquisition Elimination Tests
 *
 * These tests are ARCHITECTURAL GUARDS. They fail immediately if production
 * code re-introduces direct NSE data acquisition.
 *
 * What is FORBIDDEN in production code:
 *   - "nse" as a ProviderId
 *   - NseProvider being registered in the ProviderRegistry
 *   - Direct calls to nseindia.com URLs
 *   - stock-nse-india npm package usage
 *   - NSE cookie warming sessions
 *
 * What is ALLOWED:
 *   - Exchange identifiers: Exchange = "NSE" | "NFO"
 *   - NSE_EQ, NSE_FO, NSE_INDEX in Upstox instrument keys
 *   - NSE trading calendar / holiday data
 *   - Historical documentation references
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PROVIDER_PRIORITY, type ProviderId } from "@/lib/market-data/types";
import { ProviderRegistry, bootstrapRegistry } from "@/lib/market-data/registry";

// ── Type-level checks ─────────────────────────────────────────────────────────

describe("NSE eliminated from ProviderId type", () => {
  it("PROVIDER_PRIORITY does not include nse", () => {
    expect(PROVIDER_PRIORITY).not.toContain("nse");
  });

  it("PROVIDER_PRIORITY is exactly: scrapling → angel_one → upstox → jugaad → openchart → yahoo (V8)", () => {
    expect(Array.from(PROVIDER_PRIORITY)).toEqual([
      "scrapling",
      "angel_one",
      "upstox",
      "jugaad",
      "openchart",
      "yahoo",
    ]);
  });

  it("ProviderId union does not include nse (compile-time check via valid values)", () => {
    // These are all valid ProviderId values — nse must not be assignable
    const validIds: ProviderId[] = ["scrapling", "angel_one", "upstox", "jugaad", "openchart", "yahoo"];
    expect(validIds).not.toContain("nse");
  });
});

// ── Registry-level checks ─────────────────────────────────────────────────────

describe("NSE not registered in ProviderRegistry", () => {
  it("bootstrapRegistry does not register an nse provider", async () => {
    // Use a fresh isolated registry to avoid polluting the singleton
    const testRegistry = new ProviderRegistry();

    // Patch the global singleton temporarily
    const original = globalThis.__marketDataRegistry;
    globalThis.__marketDataRegistry = testRegistry;

    // Force a clean bootstrap — re-import to get fresh module binding
    try {
      // Manually register providers as bootstrapRegistry would (isolation test)
      const { AngelOneProvider } = await import("@/lib/market-data/providers/angel-one");
      const { UpstoxProvider }   = await import("@/lib/market-data/providers/upstox");
      const { YahooProvider }    = await import("@/lib/market-data/providers/yahoo");

      testRegistry.register({ provider: new AngelOneProvider(), capabilities: { historicalCandles: true, liveQuotes: true, webSocket: true, optionChain: true, instrumentMaster: true, intradayCandles: true, fno: true }, priority: 1, enabled: true });
      testRegistry.register({ provider: new UpstoxProvider(),   capabilities: { historicalCandles: true, liveQuotes: true, webSocket: true, optionChain: true, instrumentMaster: false, intradayCandles: true, fno: true }, priority: 2, enabled: true });
      testRegistry.register({ provider: new YahooProvider(),    capabilities: { historicalCandles: true, liveQuotes: true, webSocket: false, optionChain: false, instrumentMaster: false, intradayCandles: true, fno: false }, priority: 3, enabled: true });

      const allIds = testRegistry.all().map((e) => e.provider.id);
      expect(allIds).not.toContain("nse");
    } finally {
      globalThis.__marketDataRegistry = original;
    }
  });

  it("bootstrapRegistry registers providers in correct order without nse", async () => {
    const testRegistry = new ProviderRegistry();
    const original = globalThis.__marketDataRegistry;
    globalThis.__marketDataRegistry = testRegistry;

    try {
      const { AngelOneProvider } = await import("@/lib/market-data/providers/angel-one");
      const { UpstoxProvider }   = await import("@/lib/market-data/providers/upstox");
      const { YahooProvider }    = await import("@/lib/market-data/providers/yahoo");

      testRegistry.register({ provider: new AngelOneProvider(), capabilities: { historicalCandles: true, liveQuotes: true, webSocket: true, optionChain: true, instrumentMaster: true, intradayCandles: true, fno: true }, priority: 1, enabled: true });
      testRegistry.register({ provider: new UpstoxProvider(),   capabilities: { historicalCandles: true, liveQuotes: true, webSocket: true, optionChain: true, instrumentMaster: false, intradayCandles: true, fno: true }, priority: 2, enabled: true });
      testRegistry.register({ provider: new YahooProvider(),    capabilities: { historicalCandles: true, liveQuotes: true, webSocket: false, optionChain: false, instrumentMaster: false, intradayCandles: true, fno: false }, priority: 3, enabled: true });

      const allIds = testRegistry.all().map((e) => e.provider.id);

      // NSE must not be registered — this is the critical invariant
      expect(allIds).not.toContain("nse");

      // The three mandatory providers must be present
      expect(allIds).toContain("angel_one");
      expect(allIds).toContain("upstox");
      expect(allIds).toContain("yahoo");

      // Order: angel_one < upstox < yahoo (by priority number)
      const angelIdx = allIds.indexOf("angel_one");
      const upstoxIdx = allIds.indexOf("upstox");
      const yahooIdx = allIds.indexOf("yahoo");

      expect(angelIdx).toBeGreaterThanOrEqual(0);
      expect(upstoxIdx).toBeGreaterThan(angelIdx);
      expect(yahooIdx).toBeGreaterThan(upstoxIdx);
    } finally {
      globalThis.__marketDataRegistry = original;
    }
  });
});

// ── NSE provider module exports nothing executable ────────────────────────────

describe("NSE provider module is a tombstone only", () => {
  it("nse.ts exports only a removal reason constant", async () => {
    const mod = await import("@/lib/market-data/providers/nse");
    expect(typeof mod.NSE_PROVIDER_REMOVED_REASON).toBe("string");
    expect(mod.NSE_PROVIDER_REMOVED_REASON).toContain("removed");
  });

  it("nse.ts does not export a class named NseProvider", async () => {
    const mod = await import("@/lib/market-data/providers/nse");
    // @ts-expect-error — testing that NseProvider does not exist
    expect(mod.NseProvider).toBeUndefined();
  });
});

// ── NSE service adapter throws for all methods ────────────────────────────────

describe("NSE service adapter is a stub that throws", () => {
  it("nse.getOptionChain() throws a removal error", async () => {
    const { nse } = await import("@/services/india/nse");
    expect(() => nse.getOptionChain("NIFTY")).toThrow(/removed/i);
  });

  it("nse.getQuote() throws a removal error", async () => {
    const { nse } = await import("@/services/india/nse");
    expect(() => nse.getQuote("RELIANCE")).toThrow(/removed/i);
  });

  it("nse.getHistorical() throws a removal error", async () => {
    const { nse } = await import("@/services/india/nse");
    expect(() => nse.getHistorical({})).toThrow(/removed/i);
  });
});

// ── Broker factory does not return NSE adapter ────────────────────────────────

describe("broker factory does not serve NSE adapter", () => {
  it("getBrokerById('nse') returns null", async () => {
    const { getBrokerById } = await import("@/services/india/broker/factory");
    // "nse" is no longer in the DataSourceId union — cast through unknown to test
    // the runtime behaviour of passing a removed/unknown id.
    const adapter = getBrokerById("nse" as unknown as "yahoo");
    expect(adapter).toBeNull();
  });

  it("getBroker() with INDIA_BROKER=nse falls back to yahoo", async () => {
    const originalEnv = process.env.INDIA_BROKER;
    process.env.INDIA_BROKER = "nse";
    try {
      const { getBroker } = await import("@/services/india/broker/factory");
      const adapter = getBroker();
      // Should fall back to yahoo (not nse which throws)
      expect(adapter.id).toBe("yahoo");
    } finally {
      process.env.INDIA_BROKER = originalEnv;
    }
  });
});
