/**
 * Opportunity Engine — Public API
 *
 * Single barrel export for all Opportunity Engine modules.
 * Consumers should import from this file, not from individual modules.
 */

// Core types
export type {
  OpportunityV1, OpportunityDecision, OpportunityLifecycleState,
  QualityTier, MarketRegimeState, MTFAlignmentState, SetupType,
  SectorContextClassification, VolatilityRegimeState, LiquidityRegimeState,
  OIBuildupClassification, OptionsFlowBias, HardRejectionCode, SoftPenaltyCode,
  OpportunityScoreVector, OpportunityTradeLevels, OpportunityEvidence,
  OpportunityExpiryContext, OpportunityModelVersions, OpportunityFunnel,
  OpportunityRankEntry, OpportunityCounterfactual, DailySignalAuditReport,
} from "./types";

export { createOpportunityId, createCorrelationId } from "./types";

// Market Regime Engine
export {
  classifyMarketRegime, computeRegimeScore,
  STRATEGY_REGIME_MATRIX,
} from "./market-regime-engine";
export type { RegimeEvaluation, RegimeCompatibility, RegimeInput } from "./market-regime-engine";

// MTF Confirmation
export { evaluateMTFAlignment } from "./mtf-confirmation";
export type { MTFConfirmationResult, MTFInput, TimeframeAssessment, TimeframeBias } from "./mtf-confirmation";

// Relative Strength + Sector
export {
  computeRelativeStrength, evaluateSectorContext, sectorClassificationToScore,
  INDIA_SECTOR_MAP,
} from "./relative-strength-engine";
export type {
  RelativeStrengthResult, SectorContextResult, ReturnSeries,
} from "./relative-strength-engine";

// Expected Value Engine
export {
  computeFullEV, testSlippageSensitivity,
  DEFAULT_NSE_FNO_COST_MODEL, NSE_FUTURES_COST_MODEL,
} from "./expected-value-engine";
export type { EVResult, EVInput, IndiaFnOCostModel } from "./expected-value-engine";

// Hard Gate Engine
export { evaluateHardGates, evaluateSoftPenalties, DEFAULT_HARD_GATE_CONFIG } from "./hard-gate-engine";
export type {
  HardGateResult, HardGateInputs, SoftPenaltyResult, SoftPenaltyInputs, HardGateConfig,
} from "./hard-gate-engine";

// Opportunity Detector
export {
  detectBreakout, detectTrendContinuation, detectMeanReversion,
  detectOpeningOpportunity, detectLiquidityEvent, detectBestOpportunity,
} from "./opportunity-detector";
export type { DetectionResult, OpportunityDetectorInput } from "./opportunity-detector";

// Position Sizing Engine
export {
  computePositionSize, classifyDrawdownTier, computeDailyRiskBudget,
  DEFAULT_SIZING_CONFIG,
} from "./position-sizing-engine";
export type {
  SizingResult, SizingInput, SizingConfig, DrawdownState, DrawdownTier, DailyRiskBudget,
} from "./position-sizing-engine";

// Probability Calibration
export {
  computeCalibrationReport, gradeOpportunityTier, computeShrunkenWinRate,
} from "./probability-calibration";
export type {
  CalibrationReport, CalibrationBin, ScoreBucketStats,
  TradeOutcome, QualityTierThresholds, SampleAwareMetric,
} from "./probability-calibration";

// Strategy Condition Profiler + Weight Engine + Champion/Challenger
export {
  buildStrategyConditionProfile, computeStrategyWeight, evaluateChampionChallenger,
} from "./strategy-condition-profiler";
export type {
  StrategyConditionProfile, ConditionalPerformance, StrategyWeightInput,
  StrategyWeightResult, ChampionChallengerRecord, ChampionChallengerStatus,
  ProfileTrade,
} from "./strategy-condition-profiler";

// Counterfactual Engine
export {
  evaluateCounterfactual, analyzeFilterPerformance, buildRejectionQualityReport,
} from "./counterfactual-engine";
export type {
  CounterfactualRecord, FilterPerformanceReport, RejectionQualityReport,
  CounterfactualOutcome,
} from "./counterfactual-engine";

// Performance Attribution
export {
  buildPerformanceAttribution, analyzeMFEMAE,
} from "./performance-attribution";
export type {
  AttributedTrade, PerformanceAttribution, MFEMAEDistribution,
} from "./performance-attribution";

// Pipeline Orchestrator
export { runOpportunityPipeline, rankOpportunities } from "./pipeline";
export type { OpportunityPipelineInput, OpportunityPipelineResult } from "./pipeline";
