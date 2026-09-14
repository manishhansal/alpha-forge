/**
 * src/lib/market-data/types.ts
 *
 * Canonical market-data types for AlphaForge.
 *
 * After the data-service2.0 centralization refactor, all market data flows
 * exclusively through data-service2.0. This file is a thin re-export and
 * backward-compat alias layer over the authoritative types defined in
 * @/lib/data-service/types.ts.
 *
 * DO NOT add provider-specific types here. Do NOT import from Angel One,
 * Upstox, Yahoo Finance, Binance, Deribit, Delta Exchange, NSE, or any
 * other external provider.
 */

// Re-export canonical types from the data-service2.0 client
export type {
  MarketQuote,
  OHLCVCandle,
  HistoricalRequest,
  OptionChain,
  OptionChainRow,
  CryptoOHLCV,
  FuturesOverview,
  MarketStatusResponse,
  DataServiceHealth,
  ProviderHealthEntry,
  LiveTick,
  DataServiceSuccessEnvelope,
  DataServiceErrorEnvelope,
} from "@/lib/data-service/types";

export { DataServiceUnavailableError } from "@/lib/data-service/types";

// ---------------------------------------------------------------------------
// Backward-compat type aliases
// Consumers that previously imported these names continue to compile.
// ---------------------------------------------------------------------------

/** @deprecated Use MarketQuote from @/lib/data-service/types */
export type MDQuote = import("@/lib/data-service/types").MarketQuote;

/** @deprecated Use HistoricalRequest from @/lib/data-service/types */
export type HistoricalCandleRequest = import("@/lib/data-service/types").HistoricalRequest;

/**
 * Provider identifier.
 * After centralization, the only active provider from AlphaForge's perspective
 * is "data-service2". Legacy IDs retained for type compatibility.
 * @deprecated All data comes from data-service2.
 */
export type ProviderId =
  | "data-service2"
  | "scrapling"
  | "angel_one"
  | "upstox"
  | "jugaad"
  | "openchart"
  | "yahoo";

/** @deprecated Use "data-service2" */
export const PROVIDER_PRIORITY: readonly ProviderId[] = ["data-service2"];

/** Error code type for backward compat */
export type MarketDataErrorCode = string;

/** Exchange identifier */
export type Exchange = "NSE" | "NFO" | "BSE" | "BFO" | "MCX" | "CDS";

/** Market segment */
export type Segment = "EQ" | "FO" | "CD" | "COM";

/** Instrument type */
export type InstrumentType =
  | "EQ"
  | "FUTIDX"
  | "FUTSTK"
  | "OPTIDX"
  | "OPTSTK"
  | "ETF"
  | "IDX"
  | "BOND";

/** Supported candle intervals */
export type Interval = "1m" | "5m" | "10m" | "15m" | "30m" | "1h" | "1d" | "1w" | "1M";

/** Subscription mode for live tick stream */
export type SubscriptionMode = "ltp" | "quote" | "full";

/** Instrument descriptor */
export interface Instrument {
  token: string;
  symbol: string;
  name: string;
  exchange: Exchange;
  instrumentType: InstrumentType;
  lotSize?: number;
  tickSize?: number;
  expiry?: string | null;
  strike?: number | null;
  optionType?: "CE" | "PE" | null;
  isin?: string | null;
}

/** Filter for instrument master queries */
export interface InstrumentMasterFilter {
  exchange?: Exchange;
  instrumentType?: InstrumentType;
  underlying?: string;
  expiry?: string;
}

/** Subscribe request for the live tick stream */
export interface SubscribeRequest {
  tokens: Array<{ token: string; exchange: Exchange }>;
  mode?: SubscriptionMode;
}

/** Provider health status */
export type ProviderHealthStatus = "UP" | "DOWN" | "DEGRADED" | "UNKNOWN";

/** Provider health record */
export interface ProviderHealth {
  id: string;
  status: ProviderHealthStatus;
  latencyMs: number | null;
  lastCheckedAt: string | null;
}

// ---------------------------------------------------------------------------
// Error class — DATA_SERVICE_UNAVAILABLE is the only expected failure mode
// ---------------------------------------------------------------------------

/**
 * Canonical error for any market-data failure in AlphaForge.
 * After centralization, this is always thrown when data-service2.0 is
 * unreachable or returns an error. There is NO fallback provider.
 */
export class MarketDataError extends Error {
  readonly name = "MarketDataError";

  constructor(
    message: string,
    public readonly providerId?: string | null,
    public readonly code?: string,
    public readonly httpStatus?: number,
    public readonly retryAfterMs?: number | null,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Parse a Retry-After header value into milliseconds. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const sec = Number(header);
  if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// ---------------------------------------------------------------------------
// Supported intervals
// ---------------------------------------------------------------------------

/** All supported candle intervals (3m is permanently removed for Indian market data). */
export const SUPPORTED_TIMEFRAMES: readonly Interval[] = [
  "1m",
  "5m",
  "10m",
  "15m",
  "30m",
  "1h",
  "1d",
  "1w",
  "1M",
] as const;

/** Type guard — returns true when `value` is a supported Interval. */
export function isSupportedInterval(value: string): value is Interval {
  return (SUPPORTED_TIMEFRAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Order-book / microstructure types (used by the microstructure engine)
// ---------------------------------------------------------------------------

/** A single level in the order book (bid or ask). */
export interface DepthLevel {
  /** Price for this level. */
  price: number;
  /** Quantity available at this price level. */
  quantity: number;
  /** Alias for quantity — backward compat. */
  qty?: number;
}

/** A market-depth (Level 2) snapshot for a single instrument. */
export interface MarketDepth {
  symbol: string;
  token: string;
  /** Ordered bid levels — index 0 = best bid (highest price). */
  bids: DepthLevel[];
  /** Ordered ask levels — index 0 = best ask (lowest price). */
  asks: DepthLevel[];
  /** Timestamp in ms. */
  ts: number;
}
