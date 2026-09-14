/**
 * Canonical types for data-service2.0 — AlphaForge market data SDK.
 *
 * All market-data consumers MUST use these types instead of importing
 * provider-specific types from Angel One, Upstox, Yahoo Finance, etc.
 *
 * These types mirror the data-service2.0 response envelopes exactly so
 * consumers can trust them without any provider-specific translation.
 *
 * Phase 5 — data-service2.0 centralization refactor.
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when data-service2.0 is unreachable, returns a non-2xx response,
 * or returns a well-formed error envelope.
 *
 * Consumers MUST catch this error and surface it appropriately rather than
 * falling back to any other data source.
 */
export class DataServiceUnavailableError extends Error {
  readonly name = "DataServiceUnavailableError";

  constructor(
    message: string,
    /** HTTP status code when available, undefined for network/timeout errors. */
    public readonly statusCode?: number,
    /** Error code from the data-service2.0 error envelope when available. */
    public readonly serviceErrorCode?: string,
  ) {
    super(message);
    // Restore prototype chain for `instanceof` checks across compilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Response envelope helpers
// ---------------------------------------------------------------------------

/** Success envelope returned by data-service2.0. */
export interface DataServiceSuccessEnvelope<T> {
  data: T;
  metadata: {
    requestedAt: string;
    dataAsOf: string;
    dataSourceType: "LIVE" | "CACHED" | "DELAYED" | "SIMULATED";
    provider: string | null;
  };
}

/** Error envelope returned by data-service2.0. */
export interface DataServiceErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

/** Union of the two possible envelopes. */
export type DataServiceEnvelope<T> =
  | DataServiceSuccessEnvelope<T>
  | DataServiceErrorEnvelope;

// ---------------------------------------------------------------------------
// Indian market — quotes
// ---------------------------------------------------------------------------

/** Live quote for an Indian equity, index, or derivative instrument. */
export interface MarketQuote {
  /** Unique instrument identifier as used by data-service2.0. */
  instrumentId: string;
  /** NSE/BSE trading symbol. */
  symbol: string;
  /** Display name of the instrument (may be null if not provided). */
  name: string | null;
  /** Exchange (e.g. "NSE", "BSE"). */
  exchange: string;
  /** Last traded price. */
  ltp: number;
  /** Opening price for the session. */
  open: number | null;
  /** Intraday high. */
  high: number | null;
  /** Intraday low. */
  low: number | null;
  /** Previous session close. */
  prevClose: number | null;
  /** Absolute change from prevClose. */
  change: number | null;
  /** Percentage change from prevClose. */
  changePct: number | null;
  /** Traded volume for the session. */
  volume: number | null;
  /** Open interest (derivatives only). */
  oi: number | null;
  /** Total traded value (₹) for the session. */
  tradedValue: number | null;
  /** Best bid price. */
  bid: number | null;
  /** Best ask price. */
  ask: number | null;
  /** 52-week high price. */
  weekHigh52: number | null;
  /** 52-week low price. */
  weekLow52: number | null;
  /** Current market session status, e.g. "OPEN", "PRE_OPEN", "CLOSED". */
  marketStatus: string;
  /** ISO-8601 timestamp of the last trade. */
  lastTradeTime: string | null;
  /** ISO-8601 timestamp of when the data was recorded by data-service2.0. */
  dataAsOf: string;
  /**
   * Alias for dataAsOf — backward compatibility with code that expects fetchedAt.
   * @deprecated Use dataAsOf instead.
   */
  fetchedAt: string;
  /** Data provider name as reported by data-service2.0. */
  provider: string | null;
}

// ---------------------------------------------------------------------------
// Historical OHLCV
// ---------------------------------------------------------------------------

/** A single OHLCV candle for an Indian equity or derivative. */
export interface OHLCVCandle {
  /** Epoch seconds (start of the candle period). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Open interest at candle close. Null for cash equities. Optional for backward compat. */
  oi?: number | null;
}

/** Request parameters for historical OHLCV data. */
export interface HistoricalRequest {
  /** NSE/BSE symbol or exchange:symbol pair. */
  symbol: string;
  /** Exchange override — defaults to "NSE" in data-service2.0. */
  exchange?: string;
  /** Candle interval. */
  interval:
    | "1m"
    | "5m"
    | "10m"
    | "15m"
    | "30m"
    | "1h"
    | "1d"
    | "1w"
    | "1M";
  /** Start of the range in ISO-8601 format (inclusive). */
  from?: string;
  /** End of the range in ISO-8601 format (inclusive). */
  to?: string;
}

// ---------------------------------------------------------------------------
// Option chain
// ---------------------------------------------------------------------------

/** A single row in the option chain (one strike + option type). */
export interface OptionChainRow {
  strike: number;
  optionType: "CE" | "PE";
  /** Last traded price. */
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  /** Open interest (contracts). */
  oi: number | null;
  /** Change in OI from previous session. */
  oiChange: number | null;
  volume: number | null;
  /** Implied volatility (%). */
  iv: number | null;
  /** Black-Scholes delta. */
  delta: number | null;
  /** Black-Scholes gamma. */
  gamma: number | null;
  /** Black-Scholes theta (per day). */
  theta: number | null;
  /** Black-Scholes vega. */
  vega: number | null;
}

/** Full option chain for an underlying × expiry pair. */
export interface OptionChain {
  /** Underlying symbol, e.g. "NIFTY", "RELIANCE". */
  underlying: string;
  /** Expiry date in YYYY-MM-DD format. */
  expiry: string;
  /** Available expiry dates (may be populated by data-service2.0). */
  expiries?: string[];
  /** Spot price of the underlying at time of fetch. */
  spotPrice: number | null;
  /** Alias for spotPrice — backward compatibility. */
  spot: number | null;
  /** Put-call ratio by OI. */
  pcrOi: number | null;
  /** ATM implied volatility (%). */
  atmIv: number | null;
  /** Max pain strike price. */
  maxPain: number | null;
  rows: OptionChainRow[];
  /** ISO-8601 timestamp of when the chain data was captured. */
  dataAsOf: string;
  /** Alias for dataAsOf — backward compatibility. */
  fetchedAt: string;
  /** Provider name from data-service2.0. */
  provider: string | null;
  /**
   * Backward-compat analytics sub-object.
   * Maps the flat OptionChain fields to the old analytics shape.
   */
  analytics?: {
    pcrOi: number | null;
    pcrVolume: number | null;
    atmIv: number | null;
    maxPain: number | null;
    maxCeOiStrike: number | null;
    maxPeOiStrike: number | null;
    totalCeOi: number;
    totalPeOi: number;
    totalCeOiChange: number;
    totalPeOiChange: number;
  };
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/** A single OHLCV candle for a crypto pair. */
export interface CryptoOHLCV {
  /** Epoch seconds (start of the candle period). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Crypto perpetual futures overview row. */
export interface FuturesOverview {
  /** E.g. "BTCUSDT". */
  symbol: string;
  markPrice: number | null;
  /** Current funding rate (fractional, e.g. 0.0001 = 0.01%). */
  fundingRate: number | null;
  /** ISO-8601 timestamp of the next funding settlement. */
  nextFundingTime: string | null;
  /** Open interest in base currency. */
  openInterest: number | null;
  /** Long/short ratio (> 1 means more longs). */
  longShortRatio: number | null;
}

// ---------------------------------------------------------------------------
// Market status
// ---------------------------------------------------------------------------

export interface MarketStatusResponse {
  /** "OPEN" | "PRE_OPEN" | "CLOSED" | "HOLIDAY" */
  status: string;
  /** Current session phase name. */
  phase: string;
  /** ISO-8601 timestamp when the next phase begins, or null. */
  nextPhaseAt: string | null;
}

// ---------------------------------------------------------------------------
// Health / observability
// ---------------------------------------------------------------------------

export interface DataServiceHealth {
  status: string;
  providers: ProviderHealthEntry[];
}

export interface ProviderHealthEntry {
  /** Provider identifier (e.g. "angel_one", "upstox", "yahoo", "binance"). */
  id: string;
  status: "UP" | "DOWN" | "DEGRADED" | "UNKNOWN";
  latencyMs: number | null;
  lastCheckedAt: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// WebSocket tick stream
// ---------------------------------------------------------------------------

/** A single live tick received from the /v1/stream/ticks WebSocket. */
export interface LiveTick {
  symbol: string;
  exchange?: string;
  ltp: number;
  volume?: number | null;
  oi?: number | null;
  bid?: number | null;
  ask?: number | null;
  timestamp: string;
  [key: string]: unknown;
}
