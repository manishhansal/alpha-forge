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
export interface BrokerAdapter {
  /** Stable identifier — used in logs and in env-driven factory selection. */
  readonly id: "yahoo" | "nse" | "groww" | "zerodha" | "upstox" | "angel" | "shoonya";

  getQuote(symbol: string): Promise<Quote>;

  /** Multi-symbol quote fetch — adapters should batch where possible. */
  getQuotes(symbols: string[]): Promise<Quote[]>;

  /** Historical OHLCV. Throws if unsupported. */
  getHistorical(req: HistoricalRequest): Promise<Candle[]>;

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
