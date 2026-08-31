/**
 * Public API for the Indian Market Data layer.
 *
 * Import everything through this barrel — do NOT import from sub-modules
 * directly outside of src/lib/market-data/.
 *
 * Strategy engine, ML services, and API routes must ONLY use these exports.
 * Never import Angel One, Upstox, Yahoo Finance, or NSE adapters directly.
 */

// ── Canonical types ───────────────────────────────────────────────────────────
export type {
  ProviderId,
  Exchange,
  Segment,
  InstrumentType,
  Instrument,
  MDQuote,
  Interval,
  OHLCVCandle,
  DepthLevel,
  MarketDepth,
  Greeks,
  OptionContract,
  OptionChainRow,
  OptionChainAnalytics,
  OptionChain,
  LiveTick,
  HistoricalCandleRequest,
  InstrumentMasterFilter,
  ProviderHealthStatus,
  ProviderHealth,
  SubscriptionMode,
  SubscribeRequest,
} from "./types";

export { PROVIDER_PRIORITY, MarketDataError } from "./types";

// ── Provider interface ────────────────────────────────────────────────────────
export type {
  MarketDataProvider,
  ProviderCallOptions,
  ProviderCapabilities,
  RegisteredProvider,
} from "./provider";

// ── Registry ──────────────────────────────────────────────────────────────────
export { registry, bootstrapRegistry } from "./registry";

// ── Health ────────────────────────────────────────────────────────────────────
export {
  getProviderHealth,
  getAllProviderHealth,
  recordSuccess,
  recordFailure,
  recordStaleData,
  isCircuitOpen,
  resetHealth,
  resetAllHealth,
  isStale,
  isTickStale,
  mdLog,
  STALE_THRESHOLDS_MS,
} from "./health";

export type { FailureKind, StaleDataType } from "./health";

// ── Normalizer ────────────────────────────────────────────────────────────────
export {
  utcToIst,
  istToUtc,
  toSmartApiDateTime,
  fromSmartApiDateTime,
  fromUpstoxTimestamp,
  parseExpiryToUtcMs,
  normaliseExpiry,
  formatExpiryDmy,
  stripYahooSuffix,
  toYahooSymbol,
  normaliseCandlesFromAngel,
  normaliseCandlesFromUpstox,
  intervalToSmartApi,
  intervalToUpstox,
  intervalToYahoo,
  exchangeToSmartApi,
  exchangeToUpstox,
  finiteOrNull,
  paisaToRupee,
} from "./normalizer";

export type { AngelCandleTuple, UpstoxCandleRow } from "./normalizer";

// ── Validation ────────────────────────────────────────────────────────────────
export {
  validateCandle,
  validateCandleSequence,
  filterValidCandles,
} from "./validation/candle-validator";

export type {
  CandleValidationError,
  CandleValidationResult,
  SequenceValidationError,
  SequenceValidationResult,
} from "./validation/candle-validator";

export {
  validateTick,
  validateTicks,
  isWithinCircuitLimits,
} from "./validation/tick-validator";

export type {
  TickValidationError,
  TickValidationResult,
  BatchTickValidationResult,
} from "./validation/tick-validator";

// ── Services ──────────────────────────────────────────────────────────────────
export {
  getHistoricalCandles,
  getHistoricalCandlesByRange,
} from "./services/historical.service";

export type { HistoricalOptions } from "./services/historical.service";

export {
  subscribeLiveFeed,
} from "./services/live-feed.service";

export type {
  LiveFeedSubscription,
  LiveFeedOptions,
} from "./services/live-feed.service";

// ── Candle builder — production real-time (IST-aware, Redis + DB) ─────────────
export {
  RealTimeCandleBuilder,
  MultiInstrumentCandleBuilder,
  snapToNseInterval,
  isNseSessionTick,
  sessionOpenSecondsForMs,
  sessionCloseSecondsForMs,
  istDateForMs,
  LIVE_INTERVALS,
  // Legacy in-memory shims (backward-compatible)
  CandleBuilder,
  MultiCandleBuilder,
  snapToInterval,
} from "./services/candle-builder.service";

export type {
  // Production types
  CandleEvent,
  CandleEventType,
  CandleEventHandler,
  CandleBuilderConfig,
  LateTick,
  LateTickHandler,
  BackfillRequest,
  BackfillLoader,
  // Legacy shim types
  CandleTick,
  CandleBuilderOptions,
} from "./services/candle-builder.service";

export {
  getOptionChain,
  getNearestExpiryOptionChain,
  getOptionChains,
} from "./services/option-chain.service";

export type { OptionChainOptions } from "./services/option-chain.service";

export {
  getInstruments,
  findInstrument,
  getOptionInstruments,
  getFutureInstruments,
} from "./services/instrument-master.service";

export {
  reconcileQuotes,
  reconcileCandles,
  checkQuoteStaleness,
  checkCandleStaleness,
} from "./services/reconciliation.service";

export type {
  QuoteDiscrepancy,
  CandleDiscrepancy,
} from "./services/reconciliation.service";

// ── Cache ─────────────────────────────────────────────────────────────────────
export { TTL } from "./cache/market-cache";

// ── Provider constructors (for custom registry setup) ─────────────────────────
export { AngelOneProvider } from "./providers/angel-one";
export { UpstoxProvider, isUpstoxConfigured } from "./providers/upstox";
export { NseProvider, nseProvider } from "./providers/nse";
export { YahooProvider, yahooProvider } from "./providers/yahoo";
