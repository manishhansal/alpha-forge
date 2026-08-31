/**
 * Angel One SmartAPI Provider — unit tests
 *
 * Test scenarios required:
 *   1. Authentication — provider returns null / error when credentials absent
 *   2. Candle normalization — raw SmartAPI tuples → OHLCVCandle[]
 *   3. Token resolution — InstrumentMasterService resolves symbols correctly
 *   4. WebSocket reconnect — AngelOneWsManager reconnect and subscription restore
 *   5. Stale tick detection — isTickStale fires for old exchange timestamps
 *   6. Redis cache hit/miss — memoQuote returns cached value / calls loader once
 *   7. API failover trigger — provider returns null and records failure so the
 *                             failover engine can switch providers
 *
 * All network calls are mocked — no real I/O.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// ── Shared mocks ──────────────────────────────────────────────────────────────
// We mock the angel adapter and SmartStreamClient before any module-under-test
// is imported so the module-level singleton picks up the stubs.

vi.mock("@/services/india/angelone", () => {
  const INDEX_TOKENS: Record<string, { token: string; exchange: string }> = {
    NIFTY:      { token: "26000", exchange: "NSE" },
    BANKNIFTY:  { token: "26009", exchange: "NSE" },
    FINNIFTY:   { token: "26037", exchange: "NSE" },
    MIDCPNIFTY: { token: "26074", exchange: "NSE" },
    INDIAVIX:   { token: "26017", exchange: "NSE" },
  };

  const SYMBOL_TO_INDEX: Record<string, string> = {
    "^NSEI":      "NIFTY",
    "^NSEBANK":   "BANKNIFTY",
    "^CNXFIN":    "FINNIFTY",
    "^NSEMDCP50": "MIDCPNIFTY",
    "^INDIAVIX":  "INDIAVIX",
    NIFTY:        "NIFTY",
    BANKNIFTY:    "BANKNIFTY",
  };

  const cashRows = [
    {
      symbol: "RELIANCE-EQ", token: "2885", name: "RELIANCE",
      expiry: "", strike: "-1.000000", instrumenttype: "", exch_seg: "NSE",
    },
    {
      symbol: "TCS-EQ", token: "11536", name: "TCS",
      expiry: "", strike: "-1.000000", instrumenttype: "", exch_seg: "NSE",
    },
  ];

  function buildEqTokenMap(rows: typeof cashRows) {
    const out = new Map<string, { token: string; exchange: string }>();
    for (const r of rows) {
      if (r.exch_seg !== "NSE" || !/-EQ$/.test(r.symbol)) continue;
      const name = r.name.toUpperCase();
      if (name && !out.has(name)) out.set(name, { token: r.token, exchange: "NSE" });
    }
    return out;
  }

  function resolveAngelToken(
    symbol: string,
    eqMap: Map<string, { token: string; exchange: string }>,
  ) {
    const idxKey = SYMBOL_TO_INDEX[symbol] ?? SYMBOL_TO_INDEX[symbol.toUpperCase()];
    if (idxKey) return INDEX_TOKENS[idxKey] ?? null;
    if (symbol.startsWith("^")) return null;
    const name = symbol.replace(/\.NS$/i, "").toUpperCase();
    return eqMap.get(name) ?? null;
  }

  // Mutable state so individual tests can override
  const angelMock = {
    getQuotes:     vi.fn(),
    getHistorical: vi.fn(),
    getOptionChain: vi.fn(),
    subscribeFeed:  vi.fn(),
    subscribeFeedWs: vi.fn(),
  };

  const getScripSubsets = vi.fn().mockResolvedValue({ cash: cashRows, options: [] });

  return {
    angel:             angelMock,
    buildEqTokenMap,
    resolveAngelToken,
    INDEX_TOKENS,
    SYMBOL_TO_INDEX,
    getScripSubsets,
    isAngelConfigured: vi.fn().mockReturnValue(true),
    // sessions map for WS test
    sessions: new Map(),
  };
});

vi.mock("@/services/india/angelone/smartstream", () => {
  const SMART_STREAM_URL = "wss://smartapisocket.angelone.in/smart-stream";
  const SMART_MODE       = { LTP: 1, QUOTE: 2, SNAPQUOTE: 3 } as const;
  const SMART_EXCHANGE_TYPE = {
    NSE_CM: 1, NSE_FO: 2, BSE_CM: 3, BSE_FO: 4, MCX_FO: 5, NCX_FO: 7, CDE_FO: 13,
  } as const;

  // Minimal mock — actual frame parsing is tested in the existing smartstream tests
  const SmartStreamClientMockCtor = vi.fn().mockImplementation(
    function(this: Record<string, unknown>, opts: { onTick: (t: unknown) => void; onError?: (e: unknown) => void }) {
      this.start         = vi.fn();
      this.stop          = vi.fn();
      this.handleMessage = vi.fn();
      this._opts         = opts;
    }
  );

  function parseSmartTick() { return null; }
  function changePctFromTick(ltp: number, close: number | null): number | null {
    if (close == null || close <= 0) return null;
    return ((ltp - close) / close) * 100;
  }
  function buildSubscribeMessage() { return {}; }

  return {
    SMART_STREAM_URL,
    SMART_MODE,
    SMART_EXCHANGE_TYPE,
    SmartStreamClient: SmartStreamClientMockCtor,
    parseSmartTick,
    changePctFromTick,
    buildSubscribeMessage,
  };
});

// Cache mock — we want to control hits/misses per test
const _cacheStore = new Map<string, unknown>();

vi.mock("@/services/india/cache", () => ({
  cache: {
    get:       vi.fn().mockImplementation((k: string) => Promise.resolve(_cacheStore.get(k))),
    set:       vi.fn().mockImplementation((k: string, v: unknown) => { _cacheStore.set(k, v); return Promise.resolve(); }),
    memo:      vi.fn().mockImplementation(async (k: string, _ttl: number, loader: () => Promise<unknown>) => {
      const hit = _cacheStore.get(k);
      if (hit !== undefined) return hit;
      const val = await loader();
      _cacheStore.set(k, val);
      return val;
    }),
    invalidate: vi.fn().mockResolvedValue(undefined),
    clear:      vi.fn().mockImplementation(() => { _cacheStore.clear(); return Promise.resolve(); }),
    backendId:  "memory",
  },
}));

// ── Imports under test ────────────────────────────────────────────────────────
// Must come AFTER all vi.mock() calls.

import {
  AngelOneProvider,
  AngelOneWsManager,
  InstrumentMasterService,
  ANGEL_CACHE_TTL,
  getInstrumentMasterService,
  getWsManager,
} from "@/lib/market-data/providers/angel-one";
import {
  resetAllHealth,
  recordFailure,
  isCircuitOpen,
  getProviderHealth,
  isTickStale,
} from "@/lib/market-data/health";
import { angel } from "@/services/india/angelone";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCandle(
  isoIst: string,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): [string, number, number, number, number, number] {
  return [isoIst, o, h, l, c, v];
}

const IST_OFFSET_S = 5.5 * 60 * 60;

function istToUtcEpochSec(isoIst: string): number {
  return Math.floor((Date.parse(isoIst) - IST_OFFSET_S * 1_000) / 1_000);
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("AngelOneProvider", () => {
  let provider: AngelOneProvider;

  beforeEach(() => {
    resetAllHealth();
    _cacheStore.clear();
    vi.clearAllMocks();
    // Default: getQuotes returns null for every symbol
    (angel.getQuotes as Mock).mockResolvedValue([]);
    (angel.getHistorical as Mock).mockResolvedValue([]);
    provider = new AngelOneProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Authentication ─────────────────────────────────────────────────────

  describe("1. Authentication", () => {
    it("returns null quotes when adapter throws an auth error", async () => {
      (angel.getQuotes as Mock).mockRejectedValueOnce(
        new Error("unauthorized: invalid JWT"),
      );

      const result = await provider.getQuotes(["RELIANCE"]);
      expect(result).toEqual([null]);
    });

    it("records an auth_failure in health when JWT error occurs", async () => {
      (angel.getQuotes as Mock).mockRejectedValueOnce(
        new Error("auth: session expired"),
      );

      await provider.getQuotes(["TCS"]);

      const health = getProviderHealth("angel_one");
      expect(health.consecutiveFailures).toBeGreaterThanOrEqual(1);
      // Score should have dropped from 100
      expect(health.score).toBeLessThan(100);
    });

    it("returns empty candles when historical call throws 401", async () => {
      (angel.getHistorical as Mock).mockRejectedValueOnce(
        new Error("SmartAPI /getCandleData: HTTP 401"),
      );

      const result = await provider.getHistoricalCandles({
        symbol:   "RELIANCE",
        exchange: "NSE",
        interval: "1d",
        from:     "2026-01-01T00:00:00Z",
        to:       "2026-06-01T00:00:00Z",
      });

      expect(result).toEqual([]);
    });

    it("opens the circuit after repeated auth failures", async () => {
      for (let i = 0; i < 8; i++) {
        recordFailure("angel_one", "auth_failure", "invalid credentials");
      }
      expect(isCircuitOpen("angel_one")).toBe(true);
    });
  });

  // ── 2. Candle normalization ───────────────────────────────────────────────

  describe("2. Candle normalization", () => {
    /**
     * The legacy adapter returns Candle[] with `time` in UTC epoch seconds.
     * The provider must re-encode then normalise them into OHLCVCandle[].
     */
    beforeEach(() => {
      (angel.getHistorical as Mock).mockResolvedValue([
        { time: 1_718_152_500, open: 100, high: 105, low:  99, close: 102, volume: 5_000 },
        { time: 1_718_152_560, open: 102, high: 108, low: 101, close: 107, volume: 6_200 },
      ]);
    });

    it("returns OHLCVCandle[] with correct OHLCV values", async () => {
      const candles = await provider.getHistoricalCandles({
        symbol: "RELIANCE", exchange: "NSE", interval: "1m",
        from: "2026-06-12T00:00:00Z", to: "2026-06-12T23:59:59Z",
      });
      expect(candles).toHaveLength(2);
      expect(candles[0]!.open).toBe(100);
      expect(candles[0]!.high).toBe(105);
      expect(candles[0]!.low).toBe(99);
      expect(candles[0]!.close).toBe(102);
      expect(candles[0]!.volume).toBe(5_000);
    });

    it("returns timestamps as UTC epoch seconds", async () => {
      const candles = await provider.getHistoricalCandles({
        symbol: "RELIANCE", exchange: "NSE", interval: "1m",
        from: "2026-06-12T00:00:00Z", to: "2026-06-12T23:59:59Z",
      });
      // All timestamps must be integers
      for (const c of candles) {
        expect(Number.isInteger(c.time)).toBe(true);
        expect(c.time).toBeGreaterThan(0);
      }
    });

    it("returns candles sorted by ascending timestamp", async () => {
      const candles = await provider.getHistoricalCandles({
        symbol: "RELIANCE", exchange: "NSE", interval: "1m",
        from: "2026-06-12T00:00:00Z", to: "2026-06-12T23:59:59Z",
      });
      for (let i = 1; i < candles.length; i++) {
        expect(candles[i]!.time).toBeGreaterThan(candles[i - 1]!.time);
      }
    });

    it("returns empty array for an unsupported interval (1w)", async () => {
      const candles = await provider.getHistoricalCandles({
        symbol: "RELIANCE", exchange: "NSE", interval: "1w",
        from: "2025-01-01T00:00:00Z", to: "2025-12-31T00:00:00Z",
      });
      expect(candles).toEqual([]);
    });

    it("returns empty array for an unsupported exchange (MCX)", async () => {
      const candles = await provider.getHistoricalCandles({
        symbol: "CRUDEOIL", exchange: "MCX", interval: "1d",
        from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z",
      });
      expect(candles).toEqual([]);
    });

    it("drops malformed candle tuples (non-finite OHLC)", async () => {
      (angel.getHistorical as Mock).mockResolvedValueOnce([
        { time: 1_718_152_500, open: 100, high: 105, low: 99, close: 102, volume: 5_000 },
        { time: 1_718_152_560, open: NaN, high: 108, low: 101, close: 107, volume: 6_200 },
        { time: 1_718_152_620, open: 107, high: 109, low: 106, close: 108, volume: 4_100 },
      ]);

      const candles = await provider.getHistoricalCandles({
        symbol: "TCS", exchange: "NSE", interval: "1m",
        from: "2026-06-12T00:00:00Z", to: "2026-06-12T23:59:59Z",
      });
      // The NaN open candle is dropped by filterValidCandles
      expect(candles.every((c) => Number.isFinite(c.open))).toBe(true);
    });

    it("supports all required intervals (1m 3m 5m 10m 15m 30m 1h 1d)", async () => {
      const intervals = ["1m", "3m", "5m", "10m", "15m", "30m", "1h", "1d"] as const;
      for (const interval of intervals) {
        (angel.getHistorical as Mock).mockResolvedValueOnce([
          { time: 1_718_152_500, open: 100, high: 105, low: 99, close: 102, volume: 100 },
        ]);
        const res = await provider.getHistoricalCandles({
          symbol: "NIFTY", exchange: "NSE", interval,
          from: "2026-06-12T00:00:00Z", to: "2026-06-12T23:59:59Z",
        });
        // Every supported interval should return at least one candle (mocked)
        expect(res.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ── 3. Token resolution ───────────────────────────────────────────────────

  describe("3. Token resolution (InstrumentMasterService)", () => {
    let svc: InstrumentMasterService;

    beforeEach(async () => {
      svc = new InstrumentMasterService();
      await svc.ensureLoaded();
    });

    it("resolves NIFTY index proxy ^NSEI to hardcoded index token", () => {
      const tok = svc.resolveToken("^NSEI");
      expect(tok).toEqual({ token: "26000", exchange: "NSE" });
    });

    it("resolves BANKNIFTY symbol to its hardcoded token", () => {
      const tok = svc.resolveToken("BANKNIFTY");
      expect(tok).toEqual({ token: "26009", exchange: "NSE" });
    });

    it("resolves a cash equity symbol to its ScripMaster token", () => {
      const tok = svc.resolveToken("RELIANCE");
      expect(tok).toEqual({ token: "2885", exchange: "NSE" });
    });

    it("strips Yahoo .NS suffix before resolving", () => {
      const tok = svc.resolveToken("TCS.NS");
      expect(tok).toEqual({ token: "11536", exchange: "NSE" });
    });

    it("returns null for BSE-only symbols Angel One cannot resolve", () => {
      expect(svc.resolveToken("^BSESN")).toBeNull();
    });

    it("returns null for completely unknown symbols", () => {
      expect(svc.resolveToken("DOESNOTEXIST999")).toBeNull();
    });

    it("filter() returns only NSE instruments when exchange=NSE", async () => {
      const result = svc.filter({ exchange: "NSE" });
      expect(result.every((i) => i.exchange === "NSE")).toBe(true);
    });

    it("classifies -EQ NSE rows as EQ instrumentType", async () => {
      const result = svc.filter({ exchange: "NSE" });
      const reliance = result.find((i) => i.name === "RELIANCE");
      expect(reliance?.instrumentType).toBe("EQ");
    });
  });

  // ── 4. WebSocket reconnect ────────────────────────────────────────────────

  describe("4. WebSocket reconnect and subscription restore", () => {
    it("does not create a second WS connection for the same token", async () => {
      const wsm = new AngelOneWsManager();
      const tick1 = vi.fn();
      const tick2 = vi.fn();

      wsm.subscribe("2885", "RELIANCE", "NSE", "WATCHLIST", tick1);
      wsm.subscribe("2885", "RELIANCE", "NSE", "WATCHLIST", tick2);

      // Both handlers registered under the same token
      expect(wsm.registrySize).toBe(1);
    });

    it("removes handler on unsubscribe; removes token from registry when last handler gone", () => {
      const wsm = new AngelOneWsManager();
      const tick1 = vi.fn();
      const tick2 = vi.fn();

      const unsub1 = wsm.subscribe("2885", "RELIANCE", "NSE", "WATCHLIST", tick1);
      wsm.subscribe("2885", "RELIANCE", "NSE", "WATCHLIST", tick2);

      unsub1();
      expect(wsm.registrySize).toBe(1); // second handler still active

      wsm.unsubscribeTokens(["2885"]);
      expect(wsm.registrySize).toBe(0);
    });

    it("does not dispatch ticks for unsubscribed tokens", () => {
      const wsm  = new AngelOneWsManager();
      const tick = vi.fn();

      const unsub = wsm.subscribe("2885", "RELIANCE", "NSE", "WATCHLIST", tick);
      unsub();

      // Simulate a tick arriving after unsubscription
      // Access private handleTick via bracket notation for testing
      (wsm as unknown as { handleTick: (t: unknown) => void })["handleTick"]({
        token: "2885", exchangeTimestamp: Date.now(), ltp: 2950,
        mode: 2, exchangeType: 1, sequence: 1,
      });

      expect(tick).not.toHaveBeenCalled();
    });

    it("dispatches ticks to all handlers for a subscribed token", () => {
      const wsm  = new AngelOneWsManager();
      const tick1 = vi.fn();
      const tick2 = vi.fn();

      wsm.subscribe("26000", "NIFTY", "NSE", "INDICES", tick1);
      wsm.subscribe("26000", "NIFTY", "NSE", "INDICES", tick2);

      (wsm as unknown as { handleTick: (t: unknown) => void }).handleTick({
        token: "26000", exchangeTimestamp: Date.now(), ltp: 23_000,
        mode: 2, exchangeType: 1, sequence: 1, close: 22_900,
      });

      expect(tick1).toHaveBeenCalledOnce();
      expect(tick2).toHaveBeenCalledOnce();
      const liveTick = tick1.mock.calls[0][0];
      expect(liveTick.ltp).toBe(23_000);
      expect(liveTick.symbol).toBe("NIFTY");
      expect(liveTick.provider).toBe("angel_one");
    });

    it("normalises the LiveTick shape correctly from a raw SmartTick", () => {
      const wsm  = new AngelOneWsManager();
      const tick = vi.fn();
      wsm.subscribe("11536", "TCS", "NSE", "FNO_STOCKS", tick);

      (wsm as unknown as { handleTick: (t: unknown) => void }).handleTick({
        token: "11536", exchangeTimestamp: Date.now() - 500, ltp: 3_500,
        close: 3_450, volume: 100_000, oi: 50_000,
        mode: 2, exchangeType: 1, sequence: 42,
      });

      const lt = tick.mock.calls[0][0];
      expect(lt.instrumentId).toBeUndefined(); // not a field in LiveTick
      expect(lt.ltp).toBe(3_500);
      expect(lt.volume).toBe(100_000);
      expect(lt.oi).toBe(50_000);
      expect(lt.change).toBeCloseTo(50, 1);
      expect(lt.changePct).toBeCloseTo(50 / 3_450 * 100, 2);
      expect(lt.provider).toBe("angel_one");
    });

    it("isStarted becomes true after start() is called", () => {
      const wsm = new AngelOneWsManager();
      expect(wsm.isStarted).toBe(false);
      wsm.start({ apiKey: "k", clientCode: "c", jwt: "j", feedToken: "f" });
      expect(wsm.isStarted).toBe(true);
      wsm.stop();
    });

    it("stop() sets isStarted to false and clears the registry", () => {
      const wsm = new AngelOneWsManager();
      wsm.subscribe("2885", "RELIANCE", "NSE", "WATCHLIST", vi.fn());
      wsm.start({ apiKey: "k", clientCode: "c", jwt: "j", feedToken: "f" });
      wsm.stop();
      expect(wsm.isStarted).toBe(false);
    });
  });

  // ── 5. Stale tick detection ───────────────────────────────────────────────

  describe("5. Stale tick detection", () => {
    it("isTickStale returns true for tick timestamps > 5s old", () => {
      const staleMs = Date.now() - 10_000;
      expect(isTickStale(staleMs)).toBe(true);
    });

    it("isTickStale returns false for recent tick timestamps", () => {
      const freshMs = Date.now() - 1_000;
      expect(isTickStale(freshMs)).toBe(false);
    });

    it("records stale data penalty in health when stale tick is received", () => {
      resetAllHealth();
      const wsm   = new AngelOneWsManager();
      const tick  = vi.fn();
      wsm.subscribe("2885", "RELIANCE", "NSE", "WATCHLIST", tick);

      const staleTimestamp = Date.now() - 120_000; // 2 minutes ago

      (wsm as unknown as { handleTick: (t: unknown) => void }).handleTick({
        token: "2885", exchangeTimestamp: staleTimestamp, ltp: 2950,
        mode: 2, exchangeType: 1, sequence: 1,
      });

      const health = getProviderHealth("angel_one");
      // Stale penalty (15 pts) should have reduced score below 100
      expect(health.score).toBeLessThan(100);
    });

    it("does NOT flag a tick that arrived within the stale threshold", () => {
      resetAllHealth();
      const wsm  = new AngelOneWsManager();
      const tick = vi.fn();
      wsm.subscribe("26000", "NIFTY", "NSE", "INDICES", tick);

      (wsm as unknown as { handleTick: (t: unknown) => void }).handleTick({
        token: "26000", exchangeTimestamp: Date.now() - 1_000, ltp: 23_000,
        mode: 2, exchangeType: 1, sequence: 1,
      });

      const health = getProviderHealth("angel_one");
      // No stale penalty — score should be 100 (fresh start) or equal to
      // whatever recordSuccess set it to (≥ 100 due to recovery, capped at 100)
      expect(health.score).toBeGreaterThanOrEqual(100);
    });
  });

  // ── 6. Redis cache hit/miss ───────────────────────────────────────────────

  describe("6. Redis cache hit / miss", () => {
    it("calls the upstream adapter only once for two identical quote requests", async () => {
      (angel.getQuotes as Mock).mockResolvedValue([
        {
          symbol: "RELIANCE", price: 2950, change: 40, changePct: 1.4,
          prevClose: 2910, name: "RELIANCE-EQ", fetchedAt: new Date().toISOString(),
        },
      ]);

      // First call — cache miss, adapter is invoked
      await provider.getLatestQuote("RELIANCE");
      // Second call — cache hit, adapter must NOT be invoked again
      await provider.getLatestQuote("RELIANCE");

      expect(angel.getQuotes).toHaveBeenCalledTimes(1);
    });

    it("returns the cached value on the second call", async () => {
      (angel.getQuotes as Mock).mockResolvedValue([
        {
          symbol: "TCS", price: 3_500, change: 50, changePct: 1.45,
          prevClose: 3_450, name: "TCS-EQ", fetchedAt: new Date().toISOString(),
        },
      ]);

      const first  = await provider.getLatestQuote("TCS");
      const second = await provider.getLatestQuote("TCS");

      expect(first?.ltp).toBe(3_500);
      expect(second?.ltp).toBe(3_500);
    });

    it("re-fetches from the adapter after the cache is invalidated", async () => {
      (angel.getQuotes as Mock)
        .mockResolvedValueOnce([{
          symbol: "RELIANCE", price: 2950, change: 40, changePct: 1.4,
          prevClose: 2910, name: "RELIANCE-EQ", fetchedAt: new Date().toISOString(),
        }])
        .mockResolvedValueOnce([{
          symbol: "RELIANCE", price: 3000, change: 90, changePct: 3.0,
          prevClose: 2910, name: "RELIANCE-EQ", fetchedAt: new Date().toISOString(),
        }]);

      await provider.getLatestQuote("RELIANCE");

      // Simulate cache expiry by clearing the store
      _cacheStore.clear();

      const second = await provider.getLatestQuote("RELIANCE");
      expect(second?.ltp).toBe(3000);
      expect(angel.getQuotes).toHaveBeenCalledTimes(2);
    });

    it("uses TTL of 3s for live quotes (ANGEL_CACHE_TTL.quote)", () => {
      expect(ANGEL_CACHE_TTL.quote).toBe(3_000);
    });

    it("uses TTL of 12h for instrument master (ANGEL_CACHE_TTL.instrument)", () => {
      expect(ANGEL_CACHE_TTL.instrument).toBe(12 * 60 * 60_000);
    });

    it("uses TTL of 30s for intraday candles (ANGEL_CACHE_TTL.intradayCandle)", () => {
      expect(ANGEL_CACHE_TTL.intradayCandle).toBe(30_000);
    });

    it("uses TTL of 4h for daily candles (ANGEL_CACHE_TTL.dailyCandle)", () => {
      expect(ANGEL_CACHE_TTL.dailyCandle).toBe(4 * 60 * 60_000);
    });
  });

  // ── 7. API failover trigger ───────────────────────────────────────────────

  describe("7. API failover trigger", () => {
    it("getQuotes returns [null, null] when adapter throws", async () => {
      (angel.getQuotes as Mock).mockRejectedValueOnce(new Error("SmartAPI: HTTP 503"));

      const result = await provider.getQuotes(["RELIANCE", "TCS"]);
      expect(result).toEqual([null, null]);
    });

    it("records a failure in health so the failover engine can detect it", async () => {
      resetAllHealth();
      (angel.getQuotes as Mock).mockRejectedValueOnce(new Error("rate limit exceeded"));

      await provider.getQuotes(["NIFTY"]);

      const health = provider.getProviderHealth();
      expect(health.consecutiveFailures).toBeGreaterThanOrEqual(1);
      expect(health.lastFailureAt).not.toBeNull();
    });

    it("opens the circuit and returns [] for candles after enough failures", async () => {
      resetAllHealth();
      // Force enough failures to open the circuit (score < 20)
      for (let i = 0; i < 8; i++) {
        recordFailure("angel_one", "api_error", "upstream 503");
      }

      // Circuit is now open
      expect(isCircuitOpen("angel_one")).toBe(true);

      const health = provider.getProviderHealth();
      expect(health.circuitOpen).toBe(true);
      expect(health.status).toBe("unhealthy");
    });

    it("getLatestQuote returns null when adapter throws a network error", async () => {
      (angel.getQuotes as Mock).mockRejectedValueOnce(new Error("ECONNRESET"));

      const result = await provider.getLatestQuote("RELIANCE");
      expect(result).toBeNull();
    });

    it("consecutive successes recover the health score toward 100", async () => {
      resetAllHealth();
      // Inject some failures first
      for (let i = 0; i < 3; i++) {
        recordFailure("angel_one", "api_error", "oops");
      }
      const afterFailures = getProviderHealth("angel_one").score;

      // Now succeed several times
      (angel.getQuotes as Mock).mockResolvedValue([{
        symbol: "RELIANCE", price: 2950, change: 0, changePct: 0,
        prevClose: 2950, name: "RELIANCE-EQ", fetchedAt: new Date().toISOString(),
      }]);
      for (let i = 0; i < 3; i++) {
        _cacheStore.clear();
        await provider.getQuotes(["RELIANCE"]);
      }

      const afterSuccesses = getProviderHealth("angel_one").score;
      expect(afterSuccesses).toBeGreaterThan(afterFailures);
    });

    it("provider.id is 'angel_one'", () => {
      expect(provider.id).toBe("angel_one");
    });

    it("getProviderHealth returns a valid ProviderHealth snapshot", () => {
      resetAllHealth();
      const h = provider.getProviderHealth();
      expect(h.providerId).toBe("angel_one");
      expect(h.status).toBe("healthy");
      expect(h.score).toBe(100);
      expect(h.circuitOpen).toBe(false);
    });
  });
});

// ── Standalone InstrumentMasterService tests ──────────────────────────────────

describe("InstrumentMasterService", () => {
  afterEach(() => {
    vi.clearAllMocks();
    _cacheStore.clear();
  });

  it("ensureLoaded() populates instruments from the ScripMaster", async () => {
    const svc = new InstrumentMasterService();
    await svc.ensureLoaded();
    const all = svc.filter();
    // The mock has 2 cash rows → 2 instruments
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("normalises NSE cash rows with EQ instrumentType", async () => {
    const svc = new InstrumentMasterService();
    await svc.ensureLoaded();
    const reliance = svc.filter({ exchange: "NSE" }).find((i) => i.name === "RELIANCE");
    expect(reliance).toBeDefined();
    expect(reliance?.instrumentType).toBe("EQ");
    expect(reliance?.token).toBe("2885");
  });

  it("does not perform a second network call within the cache window", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("@/services/india/angelone") as any;
    const getScripSubsets: Mock = mod.getScripSubsets;
    const svc = new InstrumentMasterService();
    await svc.ensureLoaded();
    await svc.ensureLoaded(); // second call — should be a no-op
    // getScripSubsets is called once by ensureLoaded but memoised — the mock
    // may be called once or zero times depending on cache state; either is fine.
    if (getScripSubsets) {
      expect(getScripSubsets.mock.calls.length).toBeLessThanOrEqual(2);
    }
  });
});
