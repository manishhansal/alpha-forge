/**
 * MarketDataProvider — the single interface every data source must implement.
 *
 * The strategy engine, ML services, and all API routes MUST only call this
 * interface. Never import Angel One, Upstox, Yahoo Finance, or NSE directly
 * outside of src/lib/market-data/providers/.
 */

import type {
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  LiveTick,
  MDQuote,
  OHLCVCandle,
  OptionChain,
  ProviderHealth,
  ProviderId,
  SubscribeRequest,
} from "./types";

// ── Per-call options ─────────────────────────────────────────────────────────

export interface ProviderCallOptions {
  /**
   * Abort signal forwarded from the caller (e.g. from a Next.js route).
   * Providers should respect cancellation to avoid dangling fetches.
   */
  signal?: AbortSignal;
  /**
   * When true, the provider must NOT fall back to any other upstream.
   * Used by the failover layer to ensure clean separation between providers.
   */
  noFallback?: boolean;
}

// ── Core interface ───────────────────────────────────────────────────────────

export interface MarketDataProvider {
  /** Stable identifier for this provider. */
  readonly id: ProviderId;

  /**
   * Fetch historical OHLCV candles for an instrument.
   *
   * - Returns an empty array (never throws) when no data is available for
   *   the requested range so the failover layer can move to the next provider.
   * - Candle timestamps are UTC epoch seconds.
   */
  getHistoricalCandles(
    req: HistoricalCandleRequest,
    opts?: ProviderCallOptions,
  ): Promise<OHLCVCandle[]>;

  /**
   * Fetch the latest quote for a single symbol.
   *
   * Returns null when the symbol is unresolvable (e.g. not listed on this
   * provider's exchange) so callers can fall back without catching exceptions.
   */
  getLatestQuote(
    symbol: string,
    opts?: ProviderCallOptions,
  ): Promise<MDQuote | null>;

  /**
   * Fetch quotes for multiple symbols in a single round-trip.
   * The returned array is aligned with the input array.
   * Unresolvable symbols return null at their respective index.
   */
  getQuotes(
    symbols: string[],
    opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>>;

  /**
   * Fetch the option chain for an F&O underlying.
   *
   * @param underlying  NSE symbol (e.g. "NIFTY", "BANKNIFTY", "RELIANCE").
   * @param expiry      ISO-8601 date string. When omitted, nearest expiry.
   */
  getOptionChain(
    underlying: string,
    expiry?: string,
    opts?: ProviderCallOptions,
  ): Promise<OptionChain>;

  /**
   * Fetch or return cached instrument master rows.
   *
   * Implementations may cache this heavily (the ScripMaster is ~10 MB).
   */
  getInstrumentMaster(
    filter?: InstrumentMasterFilter,
    opts?: ProviderCallOptions,
  ): Promise<Instrument[]>;

  /**
   * Subscribe to a live tick stream.
   *
   * Returns an `unsubscribe` function. The provider is responsible for
   * reconnecting on disconnection; the failover layer handles provider-level
   * switchover.
   *
   * Adapters that don't have a true WebSocket feed (e.g. Yahoo) MUST implement
   * this via polling and return a teardown that clears the interval.
   */
  subscribe(
    req: SubscribeRequest,
    onTick: (tick: LiveTick) => void,
    onError?: (err: unknown) => void,
  ): () => void;

  /**
   * Unsubscribe from a live tick stream by token set.
   * No-op if the tokens were not subscribed.
   */
  unsubscribe(tokens: string[]): void;

  /**
   * Return the current health snapshot for this provider.
   * Must be a pure read — no side effects.
   */
  getProviderHealth(): ProviderHealth;
}

// ── Capability flags ─────────────────────────────────────────────────────────

/**
 * Static capability descriptor for each provider.
 * Used by the registry to route requests to providers that can serve them.
 */
export interface ProviderCapabilities {
  historicalCandles: boolean;
  liveQuotes: boolean;
  webSocket: boolean;
  optionChain: boolean;
  instrumentMaster: boolean;
  /** Supports intraday (sub-daily) candles. */
  intradayCandles: boolean;
  /** Supports F&O (NFO) instruments. */
  fno: boolean;
}

/**
 * A registered provider entry — combines the implementation with its
 * capabilities and numeric priority (lower = tried first).
 */
export interface RegisteredProvider {
  provider: MarketDataProvider;
  capabilities: ProviderCapabilities;
  /** Priority 1 = highest (tried first). Angel One = 1, Upstox = 2, NSE = 3, Yahoo = 4. */
  priority: number;
  /** Whether this provider is currently enabled (can be toggled at runtime). */
  enabled: boolean;
}
