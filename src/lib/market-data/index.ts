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

export {
  PROVIDER_PRIORITY,
  MarketDataError,
  parseRetryAfterMs,
  httpStatusToErrorCode,
} from "./types";

export type { MarketDataErrorCode } from "./types";

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
  getProviderCapabilityHealth,
  recordSuccess,
  recordFailure,
  recordStaleData,
  isCircuitOpen,
  isCapabilityCircuitOpen,
  resetHealth,
  resetAllHealth,
  codeToFailureKind,
  isNonRetryableWithinProvider,
  isStale,
  isTickStale,
  mdLog,
  STALE_THRESHOLDS_MS,
  TRACKED_CAPABILITIES,
} from "./health";

export type { FailureKind, StaleDataType, Capability } from "./health";

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
  filterValidCandlesWithReport,
} from "./validation/candle-validator";

export type {
  CandleValidationError,
  CandleValidationResult,
  SequenceValidationError,
  SequenceValidationResult,
  DroppedCandle,
  FilterCandlesReport,
} from "./validation/candle-validator";

// ── 9-Step Candle Validation Pipeline ────────────────────────────────────────
export { runCandlePipeline, OHLCVCandleSchema, PIPELINE_INTERVAL_SECONDS } from "./validation/candle-validation-pipeline";

export type {
  RawCandle,
  ValidatedCandle,
  PipelineDroppedCandle,
  ReconciliationConflict,
  CandlePipelineResult,
  CandlePipelineOptions,
} from "./validation/candle-validation-pipeline";

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

// ── DataAvailability contract (V2) ────────────────────────────────────────────
export {
  buildAvailability,
  newRequestId,
  worstStatus,
  isTradableStatus,
  NON_TRADABLE_STATUSES,
  DATASET_VERSION,
} from "./data-availability";

export type {
  DataAvailability,
  DataAvailabilityStatus,
  IntervalWindow,
  BuildAvailabilityInput,
} from "./data-availability";

// ── Status-returning read APIs (V2, non-breaking) ─────────────────────────────
export {
  getHistoricalCandlesWithStatus,
  getOptionChainWithStatus,
  getInstrumentsWithStatus,
  getQuotesWithStatus,
  failureKindToStatus,
  errorToStatus,
} from "./services/read-with-status.service";

export type {
  HistoricalWithStatusOptions,
  QuoteResult,
} from "./services/read-with-status.service";

// ── Data gates (V2): snapshot consistency + global DATA state (fail-closed) ────
export {
  evaluateSnapshotConsistency,
  evaluateGlobalDataState,
  strategyMayOperate,
  DEFAULT_MAX_SNAPSHOT_SKEW_MS,
} from "./data-gate";

export type {
  SnapshotField,
  SnapshotConsistencyResult,
  GlobalDataState,
  DataDependency,
  GlobalDataDecision,
} from "./data-gate";

// ── Coverage + history sufficiency (V2) ───────────────────────────────────────
export {
  buildCoverageMatrix,
  checkHistorySufficiency,
  expectedBars,
  tradingDaysInRange,
} from "./services/coverage.service";

export type {
  CoverageCell,
  CoverageQuery,
  HistorySufficiencyStatus,
  HistorySufficiencyResult,
  HistorySufficiencyQuery,
} from "./services/coverage.service";

export {
  reconcileTick,
  reconcileCandle,
  reconcileQuotes,
  reconciliationAgreementScore,
  checkQuoteStaleness,
  checkTickStaleness,
  checkOptionChainStaleness,
  validateOHLC,
  validateOHLCSequence,
  detectOutlier,
  comparePrices,
  buildQualityEnvelope,
  evaluateSafetyGate,
  evaluateSignalGate,
  recordProviderSwitch,
  computeProviderHealthScore,
  resetProviderStats,
} from "./services/reconciliation.service";

export type {
  QualityEnvelope,
  QualifiedMarketEvent,
  ReconciliationTick,
  ValidationStatus,
  InstrumentCategory,
  OHLCValidationError,
  OHLCValidationResult,
  PriceComparisonResult,
  OutlierResult,
  SafetyGateResult,
  SignalGateDecision,
  DataConsumer,
  ProviderSwitchEvent,
  ProviderHealthSnapshot,
  ReconciliationConfig,
  ReconciliationTier,
  ReconcilableQuote,
  FieldComparison,
  ReconciliationReport,
} from "./services/reconciliation.service";

// ── Cache ─────────────────────────────────────────────────────────────────────
export { TTL } from "./cache/market-cache";

// ── Provider constructors (for custom registry setup) ─────────────────────────
export { AngelOneProvider } from "./providers/angel-one";
export { UpstoxProvider, isUpstoxConfigured } from "./providers/upstox";
// NSE provider removed 2026-09-03. Export only the removal notice for documentation.
export { NSE_PROVIDER_REMOVED_REASON } from "./providers/nse";
export { YahooProvider, yahooProvider } from "./providers/yahoo";
