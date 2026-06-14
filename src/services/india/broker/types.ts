import type {
  Candle,
  HistoricalRequest,
  Interval,
  OptionChain,
  Quote,
} from "@/types/india";

/**
 * BrokerAdapter is the abstraction every market-data backend must implement.
 *
 * Goal: keep frontend/business logic broker-agnostic so we can swap Groww
 * for Zerodha / Upstox / Angel One / Shoonya later, or run a hybrid (e.g.
 * Groww feed + NSE option chain), without touching consumers.
 */
/**
 * Per-call knobs shared across adapters. Today this only carries
 * `allowFallback`: when `false`, an adapter must NOT reach for a different
 * upstream (e.g. Angel One falling back to Yahoo) — it returns empty
 * placeholders for anything it can't serve so the selected-source-only
 * resolver can move to the next *selected* source instead.
 */
export interface BrokerFetchOptions {
  allowFallback?: boolean;
}

export interface BrokerAdapter {
  /** Stable identifier — used in logs and in env-driven factory selection. */
  readonly id: "yahoo" | "nse" | "groww" | "zerodha" | "upstox" | "angel" | "shoonya";

  getQuote(symbol: string): Promise<Quote>;

  /** Multi-symbol quote fetch — adapters should batch where possible. */
  getQuotes(symbols: string[], opts?: BrokerFetchOptions): Promise<Quote[]>;

  /** Historical OHLCV. Throws if unsupported. */
  getHistorical(req: HistoricalRequest, opts?: BrokerFetchOptions): Promise<Candle[]>;

  /**
   * Option chain for an F&O underlying (NIFTY/BANKNIFTY/<stock>).
   * `expiry` is optional — when omitted, the nearest expiry is returned.
   */
  getOptionChain(symbol: string, expiry?: string): Promise<OptionChain>;

  /**
   * Subscribe to a live feed for a set of symbols. Returns an unsubscribe fn.
   * For adapters without a real feed (e.g. Yahoo), this should fall back to
   * polling at a sensible cadence.
   */
  subscribeFeed?(
    symbols: string[],
    onTick: (q: Quote) => void,
    intervalMs?: number,
  ): () => void;
}

export type SupportedInterval = Interval;
