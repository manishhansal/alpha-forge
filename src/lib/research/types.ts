/**
 * AlphaForge V6 — Quant Research Platform
 * Canonical type definitions for the entire research infrastructure.
 *
 * These types are deliberately market-agnostic and cover:
 *   Phase 1  — StrategyRegistry / StrategyMeta
 *   Phase 2  — StrategyHypothesis
 *   Phase 3  — ResearchDataset
 *   Phase 4  — ResearchSplit / ISPeriod / OOSPeriod
 *   Phase 5  — StrategyPerformanceReport / PerformanceMetrics
 *   Phase 6  — CostAttributionReport
 *   Phase 7  — RegimeAttribution / PerRegimeStats
 *   Phase 8  — StrategyRegimeMatrix
 *   Phase 9  — StrategyCluster / CorrelationMatrix
 *   Phase 10 — DecayMonitorState / DecayAlert
 *   Phase 11 — MonteCarloResult / MonteCarloRobustnessScore
 *   Phase 12 — ParameterStabilityResult / ParameterStabilityScore
 *   Phase 13 — MultipleTestingGuard
 *   Phase 14 — SignalCalibrationResult
 *   Phase 15 — AblationResult
 *   Phase 16 — StrategyPromotionRecord
 *   Phase 17 — StrategyDemotionRecord
 *   Phase 18 — StrategyConfidenceScore
 *   Phase 19 — ExperimentRecord
 *   Phase 20 — LeaderboardEntry
 *   Phase 21 — AllocationWeight
 *   Phase 22 — KillSwitchState
 *   Phase 23 — PaperPerformanceComparison
 *   Phase 24 — ValidationSession
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type StrategyCategory =
  | "TREND_FOLLOWING"
  | "MEAN_REVERSION"
  | "MOMENTUM"
  | "BREAKOUT"
  | "VOLATILITY"
  | "OPTIONS_FLOW"
  | "LIQUIDITY"
  | "STATISTICAL"
  | "ORDERFLOW"
  | "RANGE"
  | "SCALPING";

export type InstrumentType =
  | "EQUITY"
  | "FUTURES"
  | "OPTIONS"
  | "CRYPTO_SPOT"
  | "CRYPTO_PERP"
  | "INDEX";

export type Market = "NSE_FNO" | "NSE_EQUITY" | "CRYPTO" | "NSE_INDEX";

export type StrategyTimeframe =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "4h"
  | "1d";

export type StrategyLifecycleStatus =
  | "EXPERIMENTAL"
  | "RESEARCH"
  | "BACKTEST_VALIDATED"
  | "WALK_FORWARD_VALIDATED"
  | "SHADOW"
  | "PAPER"
  | "LIVE_CANDIDATE"
  | "MANUAL_APPROVAL"
  | "LIVE"
  | "WARNING"
  | "DEGRADED"
  | "DISABLED";

export type HypothesisStatus = "DEFINED" | "UNVALIDATED" | "INVALIDATED";

export type ValidationMethod =
  | "WALK_FORWARD"
  | "ANCHORED_WALK_FORWARD"
  | "ROLLING_WALK_FORWARD"
  | "PURGED_KFOLD"
  | "CPCV"
  | "SIMPLE_SPLIT";

export type PerformancePeriod =
  | "IN_SAMPLE"
  | "VALIDATION"
  | "FINAL_OOS"
  | "PAPER"
  | "SHADOW";

export type MarketRegime =
  | "BULL_TRENDING"
  | "BEAR_TRENDING"
  | "RANGE_BOUND"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "HIGH_LIQUIDITY"
  | "LOW_LIQUIDITY"
  | "EVENT_DRIVEN"
  | "EXPIRY_DAY"
  | "NORMAL_DAY";

export type DecayState = "HEALTHY" | "WARNING" | "DEGRADED" | "CRITICAL" | "DISABLED";

export type ConfidenceBand =
  | "HIGH_CONFIDENCE"
  | "VALIDATED"
  | "WATCH"
  | "DEGRADED"
  | "DISABLED";

export type KillSwitchLevel = "NONE" | "SOFT_KILL" | "HARD_KILL";

export type CostMultiplier = 1 | 1.5 | 2 | 3;

// ─── Phase 1 — Strategy Registry ─────────────────────────────────────────────

export interface StrategyMeta {
  strategyId: string;
  strategyName: string;
  version: string;
  market: Market;
  instrumentType: InstrumentType;
  timeframe: StrategyTimeframe;
  entryLogic: string;
  exitLogic: string;
  stopLossLogic: string;
  targetLogic: string;
  positionSizing: string;
  requiredData: string[];
  requiredFeatures: string[];
  mlDependencies: string[];
  riskDependencies: string[];
  expectedHoldingPeriod: string;
  strategyCategory: StrategyCategory;
  status: StrategyLifecycleStatus;
  registeredAt: string;
  lastUpdatedAt: string;
}

// ─── Phase 2 — Hypothesis Framework ──────────────────────────────────────────

export interface StrategyHypothesis {
  strategyId: string;
  hypothesisVersion: string;
  hypothesis: string;
  marketInefficiency: string;
  expectedEdge: string;
  expectedFailureMode: string;
  expectedRegime: MarketRegime[];
  expectedHoldingPeriod: string;
  whyEdgeShouldExist: string;
  whatWouldInvalidate: string;
  status: HypothesisStatus;
  definedAt: string;
  lastReviewedAt: string;
}

// ─── Phase 3 — Research Datasets ─────────────────────────────────────────────

export interface ResearchDataset {
  datasetVersion: string;
  fingerprint: string; // SHA-256 of deterministic config
  provider: string;
  instrumentUniverse: string[];
  startDate: string;
  endDate: string;
  timeframe: StrategyTimeframe;
  adjustments: string[];
  missingDataPolicy: "FORWARD_FILL" | "DROP" | "INTERPOLATE" | "ZERO";
  dataQuality: number; // 0-1
  calendarVersion: string;
  generationTimestamp: string;
  totalBars: number;
  totalSymbols: number;
  notes: string;
}

// ─── Phase 4 — IS/OOS Governance ─────────────────────────────────────────────

export interface ResearchPeriod {
  name: string;
  startDate: string;
  endDate: string;
  bars: number;
  purpose: "DEVELOPMENT" | "VALIDATION" | "FINAL_OOS";
}

export interface ResearchSplit {
  splitId: string;
  strategyId: string;
  datasetVersion: string;
  validationMethod: ValidationMethod;
  developmentPeriod: ResearchPeriod;
  validationPeriod: ResearchPeriod;
  finalOosPeriod: ResearchPeriod;
  embargoBars: number;
  leakageTestPassed: boolean;
  createdAt: string;
}

// ─── Phase 5 — Performance Metrics ───────────────────────────────────────────

export interface PerformanceMetrics {
  period: PerformancePeriod;
  totalReturn: number;
  cagr: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  profitFactor: number;
  winRate: number;
  lossRate: number;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  payoffRatio: number;
  maxDrawdown: number;
  averageDrawdown: number;
  drawdownDuration: number; // bars
  ulcerIndex: number;
  sqn: number; // System Quality Number
  turnover: number;
  averageHoldTime: number; // bars
  tradeCount: number;
  tradesPerMonth: number;
  exposureTime: number; // fraction of time in market
  bestTrade: number;
  worstTrade: number;
  tailLoss: number; // 5th percentile trade
  skewness: number;
  kurtosis: number;
  // Statistical validity
  tStatistic: number;
  pValue: number;
  statisticallySignificant: boolean; // p < 0.05
}

export interface StrategyPerformanceReport {
  strategyId: string;
  datasetVersion: string;
  computedAt: string;
  inSample: PerformanceMetrics | null;
  validation: PerformanceMetrics | null;
  finalOos: PerformanceMetrics | null;
  paper: PerformanceMetrics | null;
  shadow: PerformanceMetrics | null;
}

// ─── Phase 6 — Cost Attribution ───────────────────────────────────────────────

export interface CostBreakdown {
  grossPnl: number;
  brokerage: number;
  exchangeCharges: number;
  taxes: number;
  slippage: number;
  spread: number;
  marketImpact: number;
  totalCost: number;
  netPnl: number;
  costTurnoverRatio: number; // costs / gross turnover
}

export interface CostStressResult {
  multiplier: CostMultiplier;
  costBreakdown: CostBreakdown;
  netSharpe: number;
  netExpectancy: number;
  profitable: boolean;
}

export interface CostAttributionReport {
  strategyId: string;
  period: PerformancePeriod;
  tradeCount: number;
  baseline: CostBreakdown;
  stressTests: CostStressResult[];
  costFragile: boolean; // true if unprofitable at 2× costs
  breakEvenCostMultiple: number; // smallest multiplier at which strategy breaks even
  computedAt: string;
}

// ─── Phase 7 — Regime Attribution ────────────────────────────────────────────

export interface PerRegimeStats {
  regime: MarketRegime;
  tradeCount: number;
  winRate: number;
  sharpe: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdown: number;
  totalReturn: number;
  exposureFraction: number; // fraction of time in this regime
  statConfidence: number; // 0-1
}

export interface RegimeAttribution {
  strategyId: string;
  period: PerformancePeriod;
  regimeStats: PerRegimeStats[];
  bestRegime: MarketRegime;
  worstRegime: MarketRegime;
  regimeFitScore: number; // weighted avg performance vs declared expected regime
  computedAt: string;
}

// ─── Phase 8 — Regime Matrix ──────────────────────────────────────────────────

export interface RegimeMatrixCell {
  strategyId: string;
  regime: MarketRegime;
  sharpe: number;
  profitFactor: number;
  expectancy: number;
  winRate: number;
  maxDrawdown: number;
  tradeCount: number;
  statConfidence: number;
}

export interface StrategyRegimeMatrix {
  strategies: string[]; // ordered list of strategy IDs
  regimes: MarketRegime[];
  cells: RegimeMatrixCell[];
  generatedAt: string;
}

// ─── Phase 9 — Correlation & Redundancy ──────────────────────────────────────

export interface StrategyPairCorrelation {
  strategyA: string;
  strategyB: string;
  returnCorrelation: number;
  signalCorrelation: number;
  tradeOverlap: number; // fraction of overlapping trades
  drawdownCorrelation: number;
  tailLossCorrelation: number;
}

export interface StrategyCluster {
  clusterId: string;
  clusterLabel: string;
  strategies: string[];
  avgIntraCorrelation: number;
  dominantCategory: StrategyCategory;
  allocationCapPct: number; // max combined capital allocation to cluster
  computedAt: string;
}

export interface CorrelationMatrix {
  strategies: string[];
  matrix: number[][]; // [i][j] = return correlation between strategies[i] and strategies[j]
  clusters: StrategyCluster[];
  computedAt: string;
}

// ─── Phase 10 — Alpha Decay ───────────────────────────────────────────────────

export interface RollingMetrics {
  timestamp: string;
  windowBars: number;
  sharpe: number;
  expectancy: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  signalQuality: number; // 0-1
}

export interface DecayAlert {
  strategyId: string;
  metric: keyof RollingMetrics;
  currentValue: number;
  historicalBaseline: number;
  deviationSigma: number;
  alertLevel: "WARNING" | "CRITICAL";
  detectedAt: string;
}

export interface DecayMonitorState {
  strategyId: string;
  state: DecayState;
  rollingHistory: RollingMetrics[];
  latestMetrics: RollingMetrics | null;
  historicalBaseline: Partial<RollingMetrics>;
  alerts: DecayAlert[];
  lastCheckedAt: string;
  stateChangedAt: string;
}

// ─── Phase 11 — Monte Carlo ───────────────────────────────────────────────────

export interface MonteCarloResult {
  simulationType:
    | "TRADE_SHUFFLE"
    | "BOOTSTRAP"
    | "RETURN_PERTURB"
    | "SLIPPAGE_PERTURB"
    | "COST_PERTURB"
    | "MISSED_TRADES"
    | "PARTIAL_FILL";
  iterations: number;
  probabilityOfLoss: number;
  probabilityOfRuin: number; // drawdown > 50%
  expectedDrawdown: number;
  drawdown95thPct: number;
  drawdown99thPct: number;
  sharpeDistribution: { p5: number; p25: number; median: number; p75: number; p95: number };
  terminalWealthDistribution: { p5: number; p25: number; median: number; p75: number; p95: number };
  worstCaseScenario: number;
}

export interface MonteCarloRobustnessScore {
  strategyId: string;
  overallScore: number; // 0-100
  results: MonteCarloResult[];
  robustLabel: "ROBUST" | "MODERATE" | "FRAGILE";
  computedAt: string;
}

// ─── Phase 12 — Parameter Stability ──────────────────────────────────────────

export interface ParameterNeighbor {
  parameterName: string;
  parameterValue: number;
  sharpe: number;
  expectancy: number;
  winRate: number;
  profitFactor: number;
}

export interface ParameterStabilityResult {
  parameterName: string;
  canonicalValue: number;
  neighborhood: ParameterNeighbor[];
  stabilityScore: number; // 0-1; 1 = completely flat neighborhood (ideal)
  overfitSuspected: boolean; // true if neighbors deviate sharply
  peakIsolated: boolean; // true if canonical is local max surrounded by losers
}

export interface ParameterStabilityScore {
  strategyId: string;
  overallStabilityScore: number; // 0-100
  parameters: ParameterStabilityResult[];
  label: "STABLE" | "MODERATE" | "OVERFIT_SUSPECTED";
  computedAt: string;
}

// ─── Phase 13 — Multiple Testing Guard ───────────────────────────────────────

export interface MultipleTestingGuard {
  strategyId: string;
  numberOfExperiments: number;
  parameterCombinations: number;
  strategyVariants: number;
  modelVariants: number;
  deflatedSharpeRatio: number;
  probabilityOfOverfitting: number; // 0-1; PBO from CPCV
  familywiseErrorRate: number; // Bonferroni-adjusted
  bhAdjustedPValue: number; // Benjamini-Hochberg FDR
  verdict: "PASS" | "WARN" | "FAIL";
  computedAt: string;
}

// ─── Phase 14 — Signal Quality / Calibration ─────────────────────────────────

export interface SignalCalibrationBin {
  lowerBound: number;
  upperBound: number;
  predictedWinProb: number;
  actualWinRate: number;
  sampleCount: number;
}

export interface SignalCalibrationResult {
  strategyId: string;
  brierScore: number; // lower is better; 0 = perfect
  expectedCalibrationError: number; // ECE; lower is better
  calibrationBins: SignalCalibrationBin[];
  wellCalibrated: boolean; // ECE < 0.05
  computedAt: string;
}

// ─── Phase 15 — Ablation Testing ─────────────────────────────────────────────

export interface AblationComponent {
  componentName: string;
  description: string;
  withComponent: PerformanceMetrics;
  withoutComponent: PerformanceMetrics;
  sharpeImpact: number; // positive = component helps
  expectancyImpact: number;
  winRateImpact: number;
  lowValueComponent: boolean; // true if removing improves or neutral on OOS
}

export interface AblationResult {
  strategyId: string;
  components: AblationComponent[];
  computedAt: string;
}

// ─── Phase 16 — Promotion Engine ─────────────────────────────────────────────

export interface PromotionGate {
  gateName: string;
  passed: boolean;
  requiredValue: number;
  actualValue: number;
  description: string;
}

export interface StrategyPromotionRecord {
  strategyId: string;
  fromStatus: StrategyLifecycleStatus;
  toStatus: StrategyLifecycleStatus;
  gates: PromotionGate[];
  allGatesPassed: boolean;
  promotedAt: string | null;
  promotedBy: string; // "AUTO" | user ID — LIVE always requires human approval
  notes: string;
}

// ─── Phase 17 — Demotion Engine ──────────────────────────────────────────────

export type DemotionTrigger =
  | "ALPHA_DECAY"
  | "EXCESSIVE_DRAWDOWN"
  | "REGIME_FAILURE"
  | "COST_DETERIORATION"
  | "EXECUTION_DEGRADATION"
  | "DATA_QUALITY_ISSUE"
  | "MODEL_DRIFT"
  | "STATISTICAL_CONFIDENCE_LOSS"
  | "KILL_SWITCH";

export interface StrategyDemotionRecord {
  strategyId: string;
  fromStatus: StrategyLifecycleStatus;
  toStatus: StrategyLifecycleStatus;
  trigger: DemotionTrigger;
  demotionReason: string;
  metricsSnapshot: Partial<PerformanceMetrics>;
  demotedAt: string;
  demotedBy: string; // "AUTO" | user ID
}

// ─── Phase 18 — Confidence Score ─────────────────────────────────────────────

export interface ConfidenceComponent {
  name: string;
  weight: number;
  rawScore: number; // 0-100
  weightedScore: number;
  available: boolean;
  description: string;
}

export interface StrategyConfidenceScore {
  strategyId: string;
  overallScore: number; // 0-100
  band: ConfidenceBand;
  components: ConfidenceComponent[];
  computedAt: string;
  validUntil: string; // expires and requires recomputation
}

// ─── Phase 19 — Experiment Tracking ──────────────────────────────────────────

export type ExperimentResultStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "INCONCLUSIVE"
  | "PROMOTED"
  | "DEMOTED";

export interface ResearchExperiment {
  experimentId: string;
  strategyId: string;
  strategyVersion: string;
  datasetVersion: string;
  parameterSet: Record<string, number | string | boolean>;
  marketUniverse: string[];
  dateRange: { start: string; end: string };
  validationMethod: ValidationMethod;
  costModelId: string;
  slippageModelId: string;
  metrics: Partial<PerformanceMetrics>;
  resultStatus: ExperimentResultStatus;
  gitCommitHash: string;
  timestamp: string;
  notes: string;
}

// ─── Phase 20 — Leaderboard ───────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank: number;
  strategyId: string;
  strategyName: string;
  status: StrategyLifecycleStatus;
  confidenceScore: number;
  oosSharpe: number;
  maxDrawdown: number;
  profitFactor: number;
  tradeCount: number;
  regimeFitScore: number;
  recentTrend: "IMPROVING" | "STABLE" | "DECLINING";
  expectancy: number;
  calmar: number;
  netSharpe: number; // after costs
}

export type LeaderboardView =
  | "ALL"
  | "RESEARCH"
  | "VALIDATED"
  | "PAPER"
  | "LIVE_CANDIDATE"
  | "DISABLED";

export interface StrategyLeaderboard {
  view: LeaderboardView;
  sortBy: keyof LeaderboardEntry;
  entries: LeaderboardEntry[];
  generatedAt: string;
}

// ─── Phase 21 — Allocation Engine ────────────────────────────────────────────

export interface AllocationWeight {
  strategyId: string;
  rawWeight: number; // before constraints
  finalWeight: number; // after correlation/drawdown/regime constraints
  capitalPct: number;
  rationale: string;
}

export interface AllocationPlan {
  totalCapital: number;
  allocations: AllocationWeight[];
  concentrationScore: number; // Herfindahl index — lower is more diversified
  expectedPortfolioSharpe: number;
  expectedPortfolioDrawdown: number;
  generatedAt: string;
}

// ─── Phase 22 — Kill Switch ───────────────────────────────────────────────────

export type KillSwitchTrigger =
  | "MAX_DRAWDOWN_BREACH"
  | "DATA_CORRUPTION"
  | "EXECUTION_ANOMALY"
  | "CRITICAL_ALPHA_DECAY"
  | "REPEATED_ERRORS"
  | "MANUAL";

export interface KillSwitchState {
  strategyId: string;
  level: KillSwitchLevel;
  trigger: KillSwitchTrigger | null;
  activatedAt: string | null;
  reason: string | null;
  noNewTrades: boolean;
  existingTradesPolicy: "MANAGE_NORMALLY" | "EMERGENCY_CLOSE" | "NO_ACTION";
}

// ─── Phase 23 — Paper Performance Analyzer ───────────────────────────────────

export interface PerformanceDrift {
  metric: string;
  backtestValue: number;
  shadowValue: number | null;
  paperValue: number | null;
  driftPct: number;
  materialDrift: boolean; // |drift| > threshold
  explanation: string;
}

export interface PaperPerformanceComparison {
  strategyId: string;
  backtestMetrics: Partial<PerformanceMetrics>;
  shadowMetrics: Partial<PerformanceMetrics> | null;
  paperMetrics: Partial<PerformanceMetrics> | null;
  drifts: PerformanceDrift[];
  signalDriftScore: number; // 0 = no drift, 1 = extreme
  fillQualityScore: number; // 0-1
  slippageDifferencePct: number;
  latencyMs: number;
  regimeDistributionDiff: number; // KL divergence from backtest regime distribution
  requiresInvestigation: boolean;
  computedAt: string;
}

// ─── Phase 24 — Validation Session Tracker ───────────────────────────────────

export interface ValidationSession {
  sessionId: string;
  strategyId: string;
  tradeDate: string;
  regime: MarketRegime;
  tradesTaken: number;
  wins: number;
  losses: number;
  netPnl: number;
  maxIntraDayDrawdown: number;
  notes: string;
}

export interface ValidationSessionSummary {
  strategyId: string;
  totalSessions: number;
  regimesCovered: MarketRegime[];
  minimumSessionsMet: boolean; // >= 20
  preferredSessionsMet: boolean; // >= 40
  hasNormalVolatility: boolean;
  hasHighVolatility: boolean;
  hasTrendingSession: boolean;
  hasRangeBoundSession: boolean;
  hasExpiryDay: boolean;
  readyForPromotion: boolean;
  sessions: ValidationSession[];
  computedAt: string;
}

// ─── Composite Research Record ────────────────────────────────────────────────

/** Full research dossier for a single strategy — all phases combined. */
export interface StrategyResearchRecord {
  meta: StrategyMeta;
  hypothesis: StrategyHypothesis | null;
  dataset: ResearchDataset | null;
  split: ResearchSplit | null;
  performance: StrategyPerformanceReport | null;
  costAttribution: CostAttributionReport | null;
  regimeAttribution: RegimeAttribution | null;
  monteCarlo: MonteCarloRobustnessScore | null;
  parameterStability: ParameterStabilityScore | null;
  multipleTestingGuard: MultipleTestingGuard | null;
  signalCalibration: SignalCalibrationResult | null;
  ablation: AblationResult | null;
  confidenceScore: StrategyConfidenceScore | null;
  promotionHistory: StrategyPromotionRecord[];
  demotionHistory: StrategyDemotionRecord[];
  experiments: ResearchExperiment[];
  decayMonitor: DecayMonitorState | null;
  killSwitch: KillSwitchState;
  paperComparison: PaperPerformanceComparison | null;
  validationSessions: ValidationSessionSummary | null;
}
