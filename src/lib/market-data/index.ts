/**
 * src/lib/market-data/index.ts
 *
 * Public barrel for the AlphaForge market-data layer.
 *
 * After the data-service2.0 centralization refactor, all market data flows
 * exclusively through data-service2.0. This barrel re-exports the canonical
 * client functions and types so existing consumers continue to compile with
 * minimal changes.
 *
 * ARCHITECTURE:
 *   AlphaForge → DataServiceClient → data-service2.0 → providers
 *
 * NO direct provider calls. NO fallback providers. NO provider-specific types.
 *
 * If data-service2.0 is unavailable, DataServiceUnavailableError is thrown.
 * There is intentionally NO fallback to Angel One, Upstox, Yahoo, NSE, etc.
 */

// ── Canonical client functions ────────────────────────────────────────────────
export {
  DataServiceClient,
  getQuote,
  getQuotes,
  getHistorical,
  getCandles,
  getOptionChain,
  getMarketStatus,
  getInstruments,
  getFNOUniverse,
  getCryptoOHLCV,
  getCryptoTicker,
  getFuturesOverview,
  getDeribitOptionsOverview,
  subscribeToTicks,
  getDataServiceHealth,
  getProviderHealth,
  DataServiceUnavailableError,
  _resetDataServiceClientBootstrap,
} from "@/lib/data-service/client";

// ── Canonical types ───────────────────────────────────────────────────────────
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
} from "@/lib/data-service/types";

// ── Backward-compat re-exports from types.ts ──────────────────────────────────
export type {
  Exchange,
  Segment,
  InstrumentType,
  Interval,
  Instrument,
  InstrumentMasterFilter,
  SubscribeRequest,
  SubscriptionMode,
  ProviderHealth,
  ProviderHealthStatus,
  MDQuote,
  HistoricalCandleRequest,
} from "./types";

export { MarketDataError, parseRetryAfterMs, isSupportedInterval, SUPPORTED_TIMEFRAMES } from "./types";
