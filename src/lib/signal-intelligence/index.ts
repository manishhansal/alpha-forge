/**
 * Signal Intelligence Engine — Public API
 *
 * Single barrel export for all Signal Intelligence modules.
 * Consumers should import from this file, not from individual modules.
 */

// Types
export type {
  SignalSourceType,
  SignalReportingBucket,
  OfficialIndiaStrategyId,
  SignalDirection,
  SignalAction,
  SignalLifecycleState,
  DataQualityLevel,
  DataQualityMetadata,
  RiskDecision,
  PaperDecision,
  AbstentionReason,
  SignalQualityVector,
  SignalQualityReason,
  ExpectedValueEstimate,
  SignalRankGrade,
  EnrichedSignal,
  MarketRegimeLabel,
  SignalSourceRegistryEntry,
  OpportunityCluster,
  MTFAlignmentScore,
  MTFFrame,
  UniverseCoverageSnapshot,
  TodaySignalAuditReport,
} from "./types";

export {
  OFFICIAL_INDIA_STRATEGY_IDS,
  isOfficialIndiaStrategy,
} from "./types";

// Signal Source Registry
export {
  SignalSourceRegistry,
  assertOfficialStrategy,
  isOfficialStrategySource,
  getPaperTradeReportingBucket,
} from "./signal-source-registry";

// F&O Universe
export {
  FNOUniverseService,
  buildUniverseCoverageSnapshot,
  buildUnavailableCoverageSnapshot,
  formatCoverageSummary,
  MIN_VALID_COVERAGE,
} from "./fno-universe";
export type {
  FNOUniverseInstrument,
  FNOInstrumentCategory,
  FNOUniverse,
} from "./fno-universe";

// Market Context Engine
export {
  buildMarketContextSnapshot,
  scoreContextAlignment,
} from "./market-context-engine";
export type {
  MarketContextSnapshot,
  MarketContextInput,
  MarketTrend,
  VolumeRegime,
  VolatilityRegime,
  MarketBreadth,
  GapType,
} from "./market-context-engine";

// Multi-layer Signal Engine
export {
  evaluateMarketStructure,
  evaluateMomentumQuality,
  evaluateVolumeIntelligence,
  evaluateVolatilityRegime,
  evaluateLiquidity,
  evaluateBreakoutQuality,
  aggregateLayerResults,
} from "./multi-layer-engine";
export type {
  LayerName,
  LayerStatus,
  LayerResult,
  BreakoutQuality,
  BreakoutQualityResult,
  MomentumState,
  MomentumQualityResult,
  VolumeIntelligenceResult,
  VolatilityRegimeLabel,
  VolatilityRegimeResult,
  LiquidityResult,
  MarketStructureEvent,
  MarketStructureResult,
  MultiLayerEvaluation,
} from "./multi-layer-engine";

// Derivatives Intelligence
export {
  classifyOIBuildup,
  buildOptionChainIntelligence,
  classifyOptionsFlow,
  buildExpiryContext,
  getStrategyExpiryBehavior,
} from "./derivatives-intelligence";
export type {
  OIBuildupKind,
  OIBuildupResult,
  OptionChainIntelligence,
  OptionsFlowClassification,
  FlowInterpretationConfidence,
  OptionsFlowResult,
  ExpiryType,
  ExpiryBehavior,
  ExpiryStrategyBehavior,
  ExpiryContext,
} from "./derivatives-intelligence";

// Signal Quality Vector
export {
  getTODBucket,
  computeExpectedValue,
  buildSignalQualityVector,
  gradeSignal,
  computeRankingScore,
  evaluateAbstention,
} from "./signal-quality-vector";
export type {
  TODBucketResult,
  QualityVectorInput,
  AbstractionDecision,
} from "./signal-quality-vector";

// Conflict Resolver & Opportunity Clustering
export {
  resolveSignalConflict,
  clusterSignals,
} from "./conflict-resolver";
export type {
  ConflictResolutionOutcome,
  SignalVote,
  ConflictResolutionResult,
} from "./conflict-resolver";

// Signal Lifecycle, Attribution, Decay, Sizing
export {
  isValidTransition,
  createLifecycleEvent,
  buildRecallReport,
  buildSignalAttribution,
  detectSignalDecay,
  computeDynamicPositionSize,
} from "./signal-lifecycle";
export type {
  SignalLifecycleEvent,
  RecallOpportunity,
  StrategyRecallReport,
  SignalAttributionFeature,
  SignalAttributionRecord,
  SignalHealthState,
  SignalDecayReport,
  PositionSizingInput,
  PositionSizingResult,
} from "./signal-lifecycle";

// Paper Trading Fidelity
export {
  assertExecutionModeIsolation,
  canProducePaperTrades,
  canProduceLiveOrders,
  computePaperFill,
  buildSignalPaperFunnel,
  buildTodaySignalAuditReport,
  computeReplayHash,
} from "./paper-trading-fidelity";
export type {
  ExecutionMode,
  PaperExecutionParams,
  PaperFillResult,
  FunnelStage,
  FunnelStageCount,
  SignalPaperFunnel,
} from "./paper-trading-fidelity";
