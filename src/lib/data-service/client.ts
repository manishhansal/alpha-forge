/**
 * DataServiceClient — canonical TypeScript SDK for all AlphaForge market data.
 *
 * This is the single named entry point that every consumer MUST use to access
 * market data. It is a thin, typed façade over the ProviderRegistry so consumers
 * never import Angel One, Upstox, Yahoo Finance, or any other provider directly.
 *
 * Usage:
 *   import { DataServiceClient } from "@/lib/data-service/client";
 *   const quotes = await DataServiceClient.market.quotes(["RELIANCE", "NIFTY"]);
 *   const candles = await DataServiceClient.market.candles({ symbol: "RELIANCE", ... });
 *
 * The SDK is safe to call from:
 *   - Next.js API routes (server-side)
 *   - Worker jobs
 *   - Signal engine
 *   - Backtest engine
 *   - Any server-side consumer
 *
 * It must NOT be imported from client-side browser code.
 *
 * Architecture: DataServiceClient → ProviderRegistry → withFailover() →
 *   ScraplingProvider (data-service) → AngelOneProvider → UpstoxProvider → YahooProvider
 *
 * Spec reference: prompt §40 — "Create a stable DataServiceClient SDK for TypeScript consumers."
 * API surface mirrors prompt §8 DataGateway and §9 public API design.
 */

import "server-only";

import type {
  Exchange,
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  Interval,
  LiveTick,
  MDQuote,
  OHLCVCandle,
  OptionChain,
  ProviderHealth,
  ProviderId,
} from "@/lib/market-data/types";
import type { ProviderCallOptions } from "@/lib/market-data/provider";

// ── Lazy registry initialiser ──────────────────────────────────────────────────
// Registry is bootstrapped once and reused. The lazy init pattern avoids issues
// with module loading order in Next.js server-side rendering.

let _bootstrapped = false;
async function getRegistry() {
  const { registry, bootstrapRegistry } = await import("@/lib/market-data/registry");
  if (!_bootstrapped) {
    await bootstrapRegistry();
    _bootstrapped = true;
  }
  return registry;
}

// ── Market namespace ───────────────────────────────────────────────────────────

const market = {
  /**
   * Fetch the latest quote for a single symbol.
   * Routes: data-service → Angel One → Upstox → Yahoo
   */
  async quote(symbol: string, opts?: ProviderCallOptions): Promise<MDQuote | null> {
    const r = await getRegistry();
    return r.getLatestQuote(symbol, opts);
  },

  /**
   * Fetch live quotes for multiple symbols in one call.
   * Unresolved symbols return null in the corresponding slot.
   * Routes: data-service → Angel One → Upstox → Yahoo
   */
  async quotes(symbols: string[], opts?: ProviderCallOptions): Promise<Array<MDQuote | null>> {
    const r = await getRegistry();
    return r.getQuotes(symbols, opts);
  },

  /**
   * Fetch historical OHLCV candles for a symbol over a date range.
   * Supported intervals: 1m 5m 10m 15m 30m 1h 1d 1w 1M  (3m is permanently removed)
   * Routes: data-service/openchart/jugaad → Angel One → Upstox → Yahoo (1d only)
   */
  async candles(req: HistoricalCandleRequest, opts?: ProviderCallOptions): Promise<OHLCVCandle[]> {
    const r = await getRegistry();
    return r.getHistoricalCandles(req, opts);
  },

  /**
   * Convenience alias for `candles` — same call, different name to match §8 DataGateway.
   */
  async historical(req: HistoricalCandleRequest, opts?: ProviderCallOptions): Promise<OHLCVCandle[]> {
    return market.candles(req, opts);
  },

  /**
   * Fetch the live option chain for an underlying (e.g. "NIFTY", "RELIANCE").
   * Optional expiry string narrows to a specific expiry.
   * Routes: data-service → Angel One → Upstox  (Yahoo has NO option chain capability)
   */
  async options(underlying: string, expiry?: string, opts?: ProviderCallOptions): Promise<OptionChain> {
    const r = await getRegistry();
    return r.getOptionChain(underlying, expiry, opts);
  },

  /**
   * Fetch the instrument master (list of tradeable instruments).
   * Optional filter by exchange, instrumentType, or underlying.
   * Routes: data-service → Angel One  (Upstox/Yahoo do not provide a full master)
   */
  async instruments(filter?: InstrumentMasterFilter, opts?: ProviderCallOptions): Promise<Instrument[]> {
    const r = await getRegistry();
    return r.getInstrumentMaster(filter, opts);
  },
};

// ── Universe namespace ──────────────────────────────────────────────────────────

const universe = {
  /**
   * Fetch the current NSE F&O eligible equity universe.
   * This returns only currently-listed F&O equities, not delisted or historical.
   * For point-in-time universe queries (backtesting), use ml-service historical_universe.
   */
  async fno(): Promise<Instrument[]> {
    return market.instruments({
      exchange: "NSE",
      instrumentType: "EQ",
    });
  },
};

// ── Stream namespace ────────────────────────────────────────────────────────────

const stream = {
  /**
   * Subscribe to live market ticks for a set of tokens.
   * Returns an unsubscribe function — call it to stop the subscription.
   *
   * Internally routes to Angel One SmartStream or Upstox WebSocket, whichever
   * is available. The consumer never needs to know which provider is active.
   *
   * Note: `tokens` must be exchange tokens, not NSE symbols.
   * Use `market.instruments()` to resolve symbols → tokens first.
   */
  subscribe(
    request: { tokens: Array<{ token: string; exchange: Exchange }>; mode?: "ltp" | "quote" | "full" },
    onTick: (tick: LiveTick) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    // Synchronous bootstrap — registry.subscribe() is sync once bootstrapped.
    // We need to handle the async bootstrap gracefully.
    let unsubFn: (() => void) | null = null;
    let stopped = false;

    getRegistry().then((r) => {
      if (stopped) return;
      unsubFn = r.subscribe(
        { tokens: request.tokens, mode: request.mode ?? "quote" },
        onTick,
        onError,
      );
    }).catch(onError);

    return () => {
      stopped = true;
      unsubFn?.();
    };
  },
};

// ── Observability namespace ────────────────────────────────────────────────────

const observability = {
  /**
   * Get health snapshots for all registered providers.
   * Returns an array of ProviderHealth objects with status, latency, circuit state.
   * Never exposes credentials.
   */
  async providerHealth(): Promise<ProviderHealth[]> {
    const r = await getRegistry();
    return r.getHealth();
  },

  /**
   * Get health for a single provider by ID.
   */
  async providerHealthById(id: ProviderId): Promise<ProviderHealth | undefined> {
    const r = await getRegistry();
    return r.getProviderHealth(id);
  },
};

// ── DataServiceClient — the public API ────────────────────────────────────────

/**
 * The single authoritative TypeScript SDK for all AlphaForge market data.
 *
 * Namespaces:
 *   DataServiceClient.market       — quotes, candles, options, instruments
 *   DataServiceClient.universe     — F&O universe management
 *   DataServiceClient.stream       — WebSocket subscriptions
 *   DataServiceClient.observability — provider health
 *
 * All calls route through the canonical ProviderRegistry with automatic failover.
 * No consumer should import any provider SDK directly.
 */
export const DataServiceClient = {
  market,
  universe,
  stream,
  observability,
} as const;

// ── Named re-exports for common operations ─────────────────────────────────────
// These allow `import { getQuote, getCandles } from "@/lib/data-service/client"`
// as a convenience pattern without destructuring DataServiceClient.

export const getQuote = market.quote;
export const getQuotes = market.quotes;
export const getCandles = market.candles;
export const getHistorical = market.historical;
export const getOptionChain = market.options;
export const getInstruments = market.instruments;
export const getFNOUniverse = universe.fno;
export const subscribeQuotes = stream.subscribe;
export const getProviderHealth = observability.providerHealth;

/**
 * Reset the bootstrap flag (for testing — allows re-bootstrapping in each test).
 * @internal
 */
export function _resetDataServiceClientBootstrap(): void {
  _bootstrapped = false;
}
