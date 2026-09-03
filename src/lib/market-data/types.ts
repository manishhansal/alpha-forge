/**
 * Canonical normalized types for the Indian Market Data layer.
 *
 * All timestamps are UTC internally. Convert to IST only at the UI boundary.
 * Prices are always in INR (rupees), never paisa.
 *
 * These types are the single source of truth consumed by the strategy engine,
 * ML services, and all UI surfaces. No direct provider types leak through.
 */

// ── Provider Identity ────────────────────────────────────────────────────────

export type ProviderId = "scrapling" | "angel_one" | "upstox" | "nse" | "yahoo";

export const PROVIDER_PRIORITY: readonly ProviderId[] = [
  "scrapling",
  "angel_one",
  "upstox",
  "nse",
  "yahoo",
];

// ── Exchange / Segment ───────────────────────────────────────────────────────

export type Exchange = "NSE" | "NFO" | "BSE" | "BFO" | "MCX" | "CDS";

export type Segment = "EQ" | "FO" | "CD" | "COM";

export type InstrumentType =
  | "EQ"      // Equity
  | "FUTIDX"  // Index Future
  | "FUTSTK"  // Stock Future
  | "OPTIDX"  // Index Option
  | "OPTSTK"  // Stock Option
  | "ETF"
  | "IDX";    // Index (no tradeable instrument, spot reference)

// ── Canonical Instrument ────────────────────────────────────────────────────

export type Instrument = {
  /** Exchange token (numeric string, provider-specific but stable within session). */
  token: string;
  /** Trading symbol on the exchange (e.g. "NIFTY28MAY2624000CE"). */
  tradingSymbol: string;
  /** Human-friendly name / underlying name (e.g. "NIFTY", "RELIANCE"). */
  name: string;
  exchange: Exchange;
  segment: Segment;
  instrumentType: InstrumentType;
  lotSize: number;
  /** ISIN — present for equities, null for derivatives. */
  isin: string | null;
  /** Expiry in ISO-8601 date string (YYYY-MM-DD) in UTC. Null for equities. */
  expiry: string | null;
  /** Strike price in INR. Null for non-options. */
  strike: number | null;
  optionType: "CE" | "PE" | null;
  tickSize: number;
};

// ── Quote ───────────────────────────────────────────────────────────────────

export type MDQuote = {
  /** NSE / NFO trading symbol or underlying name. */
  symbol: string;
  /** Exchange token for the instrument. */
  token: string | null;
  exchange: Exchange | null;
  name: string | null;
  /** Last traded price (INR). */
  ltp: number | null;
  /** Absolute change vs previous close. */
  change: number | null;
  /** Percent change vs previous close. */
  changePct: number | null;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** Open interest (contracts). Present for F&O instruments. */
  oi: number | null;
  weekHigh52: number | null;
  weekLow52: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
  totalBuyQty: number | null;
  totalSellQty: number | null;
  /** UTC ISO-8601 timestamp of the last trade. */
  lastTradeTime: string | null;
  provider: ProviderId;
  /** UTC ISO-8601 timestamp when this quote was fetched. */
  fetchedAt: string;
};

// ── OHLCV Candle ────────────────────────────────────────────────────────────

export type Interval =
  | "1m"
  | "3m"
  | "5m"
  | "10m"
  | "15m"
  | "30m"
  | "1h"
  | "1d"
  | "1w"
  | "1M";

export type OHLCVCandle = {
  /** UTC epoch seconds for the candle open time. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Open interest at candle close. Present for F&O candles. */
  oi?: number;
};

// ── Market Depth ─────────────────────────────────────────────────────────────

export type DepthLevel = {
  price: number;
  quantity: number;
  orders: number;
};

export type MarketDepth = {
  symbol: string;
  token: string;
  /** Top-5 bid levels, best bid first. */
  bids: DepthLevel[];
  /** Top-5 ask levels, best ask first. */
  asks: DepthLevel[];
  provider: ProviderId;
  /** UTC ISO-8601 */
  fetchedAt: string;
};

// ── Option Greeks ────────────────────────────────────────────────────────────

export type Greeks = {
  /** Implied volatility (annualised %). */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
};

// ── Option Contract ──────────────────────────────────────────────────────────

export type OptionContract = {
  token: string;
  tradingSymbol: string;
  underlying: string;
  /** Expiry as ISO-8601 date (UTC). */
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  oi: number;
  /** Change in OI vs previous session close. */
  oiChange: number;
  volume: number;
  greeks: Greeks;
  /** UTC ISO-8601 */
  fetchedAt: string;
};

// ── Option Chain ─────────────────────────────────────────────────────────────

export type OptionChainRow = {
  strike: number;
  ce: OptionContract | null;
  pe: OptionContract | null;
};

export type OptionChainAnalytics = {
  /** Put-call ratio by open interest. */
  pcrOi: number | null;
  /** Put-call ratio by volume. */
  pcrVolume: number | null;
  /** Strike with highest CE OI (resistance). */
  maxCeOiStrike: number | null;
  /** Strike with highest PE OI (support). */
  maxPeOiStrike: number | null;
  totalCeOi: number;
  totalPeOi: number;
  totalCeOiChange: number;
  totalPeOiChange: number;
  /** ATM implied volatility (%). */
  atmIv: number | null;
  /** Max pain strike price. */
  maxPain: number | null;
};

export type OptionChain = {
  underlying: string;
  /** Underlying spot price. */
  spot: number | null;
  /** Selected expiry (ISO-8601 date). */
  expiry: string;
  /** All available expiries sorted nearest-first. */
  expiries: string[];
  rows: OptionChainRow[];
  analytics: OptionChainAnalytics;
  provider: ProviderId;
  /** UTC ISO-8601 */
  fetchedAt: string;
};

// ── Live Tick ────────────────────────────────────────────────────────────────

export type LiveTick = {
  token: string;
  symbol: string;
  exchange: Exchange;
  /** Last traded price (INR). */
  ltp: number;
  /** Absolute change vs previous close. */
  change: number | null;
  changePct: number | null;
  volume: number | null;
  oi: number | null;
  /** UTC epoch milliseconds of the exchange-side tick timestamp. */
  exchangeTimestampMs: number;
  /** UTC epoch milliseconds when we received this tick. */
  receivedAtMs: number;
  provider: ProviderId;
};

// ── Historical Request ───────────────────────────────────────────────────────

export type HistoricalCandleRequest = {
  /** NSE trading symbol or underlying name. */
  symbol: string;
  /** Exchange token. If provided, skips symbol→token resolution. */
  token?: string;
  exchange: Exchange;
  interval: Interval;
  /** ISO-8601 UTC datetime string for range start. */
  from: string;
  /** ISO-8601 UTC datetime string for range end. */
  to: string;
};

// ── Instrument Master Request ────────────────────────────────────────────────

export type InstrumentMasterFilter = {
  exchange?: Exchange;
  instrumentType?: InstrumentType;
  underlying?: string;
};

// ── Provider Health ──────────────────────────────────────────────────────────

export type ProviderHealthStatus = "healthy" | "degraded" | "unhealthy";

export type ProviderHealth = {
  providerId: ProviderId;
  status: ProviderHealthStatus;
  /** Composite score 0–100. */
  score: number;
  /** UTC ISO-8601 of last successful call. */
  lastSuccessAt: string | null;
  /** UTC ISO-8601 of last failure. */
  lastFailureAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Whether the circuit breaker is currently open (blocking calls). */
  circuitOpen: boolean;
  /** UTC ISO-8601 of when the circuit will attempt to re-close (half-open). */
  circuitRetryAt: string | null;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
};

// ── Subscription ─────────────────────────────────────────────────────────────

export type SubscriptionMode = "ltp" | "quote" | "full";

export type SubscribeRequest = {
  tokens: Array<{ token: string; exchange: Exchange }>;
  mode: SubscriptionMode;
};

// ── Errors ───────────────────────────────────────────────────────────────────

export class MarketDataError extends Error {
  constructor(
    message: string,
    public readonly providerId: ProviderId | null,
    public readonly code?:
      | "AUTH_FAILURE"
      | "RATE_LIMIT"
      | "STALE_DATA"
      | "TIMEOUT"
      | "NOT_CONFIGURED"
      | "INVALID_RESPONSE"
      | "CIRCUIT_OPEN"
      | "NO_PROVIDER",
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}
