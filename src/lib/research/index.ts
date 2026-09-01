/**
 * AlphaForge V6 — Quant Research Platform
 * Central re-export of all research infrastructure modules.
 */

// Phase 1 — Strategy Registry
export { StrategyRegistry } from "./registry/strategy-registry";

// Phase 2 — Hypothesis Framework
export { HypothesisRegistry } from "./hypothesis/strategy-hypothesis";

// Phase 3 — Research Datasets
export {
  buildResearchDataset,
  computeDatasetFingerprint,
  assertDatasetIntegrity,
  CANONICAL_DATASETS,
} from "./datasets/research-dataset-builder";

// Phase 4 — IS/OOS Governance
export {
  buildResearchSplit,
  validateSplitIntegrity,
  generateWalkForwardWindows,
  CANONICAL_SPLITS,
} from "./splits/research-split";

// Phase 5 — Performance Analyzer
export {
  computePerformanceMetrics,
  buildPerformanceReport,
} from "./performance/strategy-performance-analyzer";

// Phase 6 — Cost Attribution
export {
  buildCostAttributionReport,
  computeCostBreakdown,
  NSE_FNO_OPTIONS_COST_MODEL,
  NSE_FNO_FUTURES_COST_MODEL,
  CRYPTO_PERP_COST_MODEL,
} from "./costs/cost-attribution";

// Phase 7+8 — Regime Attribution & Matrix
export {
  computeRegimeAttribution,
  buildStrategyRegimeMatrix,
  classifyRegimeSeries,
} from "./regimes/regime-attribution";

// Phase 9 — Correlation
export {
  buildCorrelationMatrix,
  computePairCorrelation,
} from "./correlation/strategy-correlation";

// Phase 10 — Alpha Decay
export {
  updateDecayMonitor,
  computeRollingMetrics,
} from "./decay/alpha-decay-monitor";

// Phase 11 — Monte Carlo
export {
  computeMonteCarloRobustness,
  runMonteCarlo,
} from "./montecarlo/monte-carlo-robustness";

// Phase 12 — Parameter Stability
export {
  analyseParameterStability,
  buildParameterStabilityScore,
  generateNeighborValues,
} from "./parameters/parameter-stability";

// Phase 13 — Multiple Testing Guard
export {
  buildMultipleTestingGuard,
  computeDeflatedSharpe,
  estimatePBO,
  bhFdrAdjust,
} from "./overfitting/multiple-testing-guard";

// Phase 14 — Signal Calibration
export {
  computeSignalCalibration,
  brierScore,
  computeCalibrationBins,
  expectedCalibrationError,
} from "./signals/signal-calibration";

// Phase 15 — Ablation Testing
export {
  runStrategyAblation,
  ablateComponent,
  STRATEGY_COMPONENT_DESCRIPTIONS,
} from "./ablation/strategy-ablation";

// Phase 16+17 — Promotion & Demotion
export {
  evaluatePromotion,
  applyPromotion,
  applyDemotion,
  checkAutoDemotion,
} from "./promotion/strategy-promotion-engine";

// Phase 18 — Confidence Score
export {
  computeStrategyConfidenceScore,
} from "./confidence/strategy-confidence-score";

// Phase 19 — Experiment Tracking
export {
  createExperimentRecord,
  completeExperiment,
  ExperimentStore,
} from "./experiments/research-experiment-tracker";

// Phase 20+21 — Leaderboard & Allocation
export {
  buildLeaderboard,
  computeAllocation,
} from "./leaderboard/strategy-leaderboard";

// Phase 22 — Kill Switch
export {
  getKillSwitchState,
  activateKillSwitch,
  deactivateKillSwitch,
  isNewTradeAllowed,
  evaluateAutoKillSwitch,
} from "./killswitch/strategy-kill-switch";

// Phase 23 — Paper Analysis
export {
  analyzePaperPerformance,
} from "./paper-analysis/paper-performance-analyzer";

// Phase 24 — Validation Sessions
export {
  addValidationSession,
  getValidationSessions,
  buildValidationSessionSummary,
} from "./validation-sessions/validation-session-tracker";

// Types
export type {
  StrategyMeta,
  StrategyHypothesis,
  ResearchDataset,
  ResearchSplit,
  PerformanceMetrics,
  StrategyPerformanceReport,
  CostAttributionReport,
  RegimeAttribution,
  StrategyRegimeMatrix,
  CorrelationMatrix,
  StrategyCluster,
  DecayMonitorState,
  MonteCarloRobustnessScore,
  ParameterStabilityScore,
  MultipleTestingGuard,
  SignalCalibrationResult,
  AblationResult,
  StrategyPromotionRecord,
  StrategyDemotionRecord,
  StrategyConfidenceScore,
  ResearchExperiment,
  LeaderboardEntry,
  StrategyLeaderboard,
  AllocationPlan,
  KillSwitchState,
  PaperPerformanceComparison,
  ValidationSessionSummary,
  StrategyResearchRecord,
  MarketRegime,
  StrategyLifecycleStatus,
  ConfidenceBand,
  DecayState,
} from "./types";
