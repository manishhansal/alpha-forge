/**
 * Signal Quality Evaluation — Shared Types
 *
 * These types back every phase of the scientific signal evaluation pipeline:
 * Phases 1–20 of the AlphaForge Signal Quality Benchmark.
 *
 * EVALUATION RULE: All ground-truth definitions are fixed before any
 * outcome is computed. No post-hoc redefinition.
 */

// ─── Phase 1: Ground Truth Definitions ──────────────────────────────────────

/**
 * What constitutes a valid opportunity for each strategy.
 * These are the PRE-SIGNAL conditions — verified using ONLY data available
 * at signal generation time.
 */
export interface SignalOutcomeDefinition {
  strategyId: string;
  /** Name of the strategy for display */
  label: string;
  /**
   * What counts as a valid opportunity (conditions met in market that
   * the strategy is designed to detect).
   */
  validOpportunityDescription: string;
  /** What counts as success: target reached BEFORE stop */
  successDefinition: "TARGET_BEFORE_STOP";
  /** What counts as failure: stop reached BEFORE target */
  failureDefinition: "STOP_BEFORE_TARGET";
  /** What counts as neutral: neither hit within holding horizon */
  neutralDefinition: "TIME_EXIT";
  /** Evaluation horizon in milliseconds */
  evaluationHorizonMs: number;
  /** Human-readable horizon label */
  horizonLabel: string;
  /**
   * Conservative tie-break rule: when a candle touches both target and stop
   * in the same bar, the stop wins (protective — never inflate results).
   */
  tiebreakerRule: "STOP_WINS";
}

export type SignalOutcome =
  | "TARGET_HIT"    // TP reached before SL
  | "STOP_HIT"      // SL reached before TP
  | "TIME_EXIT"     // Neither hit within evaluation horizon
  | "OPEN"          // Trade still open (not yet evaluated)
  | "BREAKEVEN";    // Exit within 0.1% of entry (cost-adjusted neutral)

export type SignalClassification =
  | "TP"    // True Positive: signal fired, outcome was success
  | "FP"    // False Positive: signal fired, outcome was failure
  | "TN"    // True Negative: no signal, no opportunity (correct rejection)
  | "FN"    // False Negative: opportunity existed, no signal fired
  | "UNKNOWN";

// ─── Phase 2: Confusion Matrix ───────────────────────────────────────────────

export interface ConfusionMatrix {
  strategyId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Precision = TP / (TP + FP) */
  precision: number;
  /** Recall = TP / (TP + FN) */
  recall: number;
  /** F1 = 2 × Precision × Recall / (Precision + Recall) */
  f1: number;
  /** Specificity = TN / (TN + FP) */
  specificity: number;
  /** FPR = FP / (FP + TN) */
  falsePositiveRate: number;
  /** FNR = FN / (FN + TP) */
  falseNegativeRate: number;
  sampleSize: number;
  significanceLevel: StatisticalSignificance;
}

// ─── Phase 3: Recall Analysis ────────────────────────────────────────────────

export interface MissedOpportunity {
  instrument: string;
  timestamp: number;
  expectedCondition: string;
  actualSystemState: string;
  reasonForMiss:
    | "NO_SIGNAL_GENERATED"
    | "FILTERED_BY_VOLUME"
    | "FILTERED_BY_REGIME"
    | "FILTERED_BY_ML"
    | "FILTERED_BY_RISK"
    | "FILTERED_BY_QUANT_GATE"
    | "DUPLICATE_GUARD"
    | "MARKET_CLOSED"
    | "INSUFFICIENT_DATA";
}

export interface SignalCaptureRecall {
  strategyId: string;
  validOpportunities: number;
  captured: number;
  missed: number;
  filteredCorrectly: number;   // filtered AND would have been loss
  filteredIncorrectly: number; // filtered BUT would have been win
  signalRecall: number;        // captured / validOpportunities
  missRate: number;            // missed / validOpportunities
  filterAccuracy: number;      // filteredCorrectly / (filteredCorrectly + filteredIncorrectly)
  missedOpportunities: MissedOpportunity[];
}

// ─── Phase 4: Precision ──────────────────────────────────────────────────────

export interface SignalPrecisionResult {
  strategyId: string;
  totalSignals: number;
  profitable: number;
  loss: number;
  breakeven: number;
  targetHit: number;
  stopHit: number;
  timeExit: number;
  rawPrecision: number;          // profitable / (profitable + loss)
  /** After subtracting transaction costs */
  costAdjustedPrecision: number;
  /** After adjusting for R-multiple sizing */
  riskAdjustedPrecision: number;
  avgRMultiple: number;          // avg(pnlPct / riskPct)
  profitFactor: number;          // sum(wins) / |sum(losses)|
}

// ─── Phase 5: Forward Return Analysis ────────────────────────────────────────

export interface ForwardReturnBucket {
  horizon: "1m" | "5m" | "15m" | "30m" | "60m" | "strategy" | "eod";
  direction: "LONG" | "SHORT" | "ALL";
  count: number;
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  positiveCount: number;
  negativeCount: number;
  winRate: number;
  /** 5th–95th percentile range */
  p5: number;
  p95: number;
}

export interface ForwardReturnDistribution {
  strategyId: string;
  buckets: ForwardReturnBucket[];
}

// ─── Phase 6: MFE / MAE ──────────────────────────────────────────────────────

export interface MfeMaeRecord {
  tradeId: string;
  strategyId: string;
  instrument: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  /** Maximum Favorable Excursion as % of entry price */
  mfePct: number;
  /** Maximum Adverse Excursion as % of entry price */
  maePct: number;
  /** How much of MFE was captured: (exitPrice - entry) / (mfe - entry) */
  mfeCaptureRatio: number;
  outcome: SignalOutcome;
  riskPct: number;   // |entry - stopLoss| / entry
  rewardPct: number; // |entry - target| / entry
}

export interface MfeMaeSummary {
  strategyId: string;
  tradeCount: number;
  avgMfePct: number;
  avgMaePct: number;
  avgMfeCaptureRatio: number;
  /** Fraction of trades where MAE > risk (stopped prematurely by tight stop) */
  stopTooTightFraction: number;
  /** Fraction of trades where MFE > 1.5× reward (target too conservative) */
  targetTooConservativeFraction: number;
  mfePctP25: number;
  mfePctP75: number;
  maePctP25: number;
  maePctP75: number;
}

// ─── Phase 7: Confidence Calibration ─────────────────────────────────────────

export interface CalibrationBucket {
  lowerBound: number; // e.g. 50
  upperBound: number; // e.g. 55
  label: string;      // "50–55"
  signalCount: number;
  predictedWinRate: number; // midpoint of bucket / 100
  actualWinRate: number;
  avgReturn: number;
  expectancy: number; // avgReturn weighted by winRate
  calibrationError: number; // |predicted - actual|
}

export interface ConfidenceCalibration {
  strategyId: string; // "ALL" for aggregate
  buckets: CalibrationBucket[];
  /** Brier Score = mean((p_predicted - outcome)²) — lower is better */
  brierScore: number;
  /** Expected Calibration Error = weighted avg of |predicted - actual| */
  ece: number;
  /** Maximum Calibration Error across buckets */
  mce: number;
  overallAssessment:
    | "WELL_CALIBRATED"    // ECE < 0.05
    | "ACCEPTABLE"         // ECE 0.05–0.10
    | "POORLY_CALIBRATED"  // ECE 0.10–0.20
    | "SEVERELY_DISTORTED" // ECE > 0.20
    | "INSUFFICIENT_DATA";
}

// ─── Phase 8: Win Probability Validation ─────────────────────────────────────

export interface WinProbabilityBucket {
  lowerBound: number;  // e.g. 0.50
  upperBound: number;  // e.g. 0.60
  label: string;
  sampleSize: number;
  predictedProbability: number; // bucket midpoint
  realizedProbability: number;
  calibrationError: number;
  verdict: "WELL_CALIBRATED" | "OVER_CONFIDENT" | "UNDER_CONFIDENT" | "INSUFFICIENT_SAMPLE";
}

export interface WinProbabilityCalibration {
  strategyId: string;
  buckets: WinProbabilityBucket[];
  brierScore: number;
  ece: number;
}

// ─── Phase 9: Grade Validation ────────────────────────────────────────────────

export interface GradeMetrics {
  grade: "S" | "A" | "B" | "C" | "D";
  signalCount: number;
  winRate: number;
  avgExpectancy: number;
  profitFactor: number;
  avgForwardReturn: number;
  avgConfidence: number;
  avgRMultiple: number;
}

export interface GradeValidation {
  strategyId: string; // "ALL" for aggregate
  grades: GradeMetrics[];
  /** True if S ≥ A ≥ B ≥ C ≥ D for all key metrics */
  orderingValid: boolean;
  orderingBreaches: string[]; // description of each inversion
  verdict: "GRADE_SYSTEM_USEFUL" | "GRADE_SYSTEM_WEAKLY_USEFUL" | "GRADE_SYSTEM_NOT_USEFUL";
}

// ─── Phase 10: Strategy Leaderboard ──────────────────────────────────────────

export interface StrategyLeaderboardEntry {
  strategyId: string;
  label: string;
  market: "crypto" | "india";
  sampleSize: number;
  precision: number;
  recall: number;
  f1: number;
  profitFactor: number;
  expectancy: number;
  costAdjustedReturn: number;
  avgMfePct: number;
  avgMaePct: number;
  maxDrawdownPct: number;
  tradeCount: number;
  confidenceCalibrationEce: number;
  paperPnlPct: number;
  signalQualityScore: number;
  /** Effective sample size after applying bootstrap confidence interval */
  sampleConfidence: StatisticalSignificance;
  verdict: StrategyVerdict;
}

// ─── Phase 11: Filter Ablation ───────────────────────────────────────────────

export type FilterName =
  | "BASE"
  | "VOLUME_FILTER"
  | "TREND_FILTER"
  | "VWAP_FILTER"
  | "REGIME_FILTER"
  | "ML_FILTER"
  | "QUANT_GATE"
  | "RISK_FILTER";

export interface FilterAblationRow {
  filter: FilterName;
  precision: number;
  recall: number;
  expectancy: number;
  profitFactor: number;
  signalCount: number;
  incrementalPrecisionChange: number;
  incrementalRecallChange: number;
  incrementalExpectancyChange: number;
  verdict: "HIGH_VALUE" | "MODERATE_VALUE" | "LOW_VALUE" | "HARMFUL";
}

export interface FilterAblation {
  strategyId: string;
  rows: FilterAblationRow[];
}

// ─── Phase 12: ML Contribution ───────────────────────────────────────────────

export type MLLayer =
  | "STRATEGY_ONLY"
  | "STRATEGY_PLUS_ML"
  | "STRATEGY_PLUS_META"
  | "STRATEGY_PLUS_ML_PLUS_RISK";

export interface MLContributionRow {
  layer: MLLayer;
  signalCount: number;
  precision: number;
  recall: number;
  expectancy: number;
  drawdownPct: number;
  costAdjustedPnl: number;
}

export interface MLContribution {
  strategyId: string; // "ALL" for aggregate
  rows: MLContributionRow[];
  incrementalMLValue: number; // precision(ML) - precision(base)
  mlAddsMeasurableValue: boolean;
}

// ─── Phase 13: Signal Correlation ────────────────────────────────────────────

export interface SignalCorrelationMatrix {
  strategies: string[];
  /** NxN correlation matrix of signal overlap (co-occurrence rate) */
  correlationMatrix: number[][];
  /** Strategy pairs with overlap > 0.6 — counted as non-independent evidence */
  highCorrelationPairs: Array<{
    a: string;
    b: string;
    correlation: number;
    warning: string;
  }>;
  /** Clusters of strategies that fire on the same instruments in the same window */
  clusters: Array<{
    strategies: string[];
    clusterCorrelation: number;
  }>;
}

// ─── Phase 14: Market Regime Quality ─────────────────────────────────────────

export type MarketRegime =
  | "BULL_TRENDING"
  | "BEAR_TRENDING"
  | "RANGE_BOUND"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "EXPIRY_DAY"
  | "NORMAL_DAY";

export interface RegimePerformanceCell {
  regime: MarketRegime;
  signalCount: number;
  precision: number;
  recall: number;
  expectancy: number;
  profitFactor: number;
  verdict: "STRONG" | "ACCEPTABLE" | "WEAK" | "INSUFFICIENT_DATA";
}

export interface RegimeQuality {
  strategyId: string;
  cells: RegimePerformanceCell[];
  bestRegime: MarketRegime | null;
  worstRegime: MarketRegime | null;
}

// ─── Phase 15: Instrument Quality ────────────────────────────────────────────

export interface InstrumentQualityRow {
  instrument: string;
  signalCount: number;
  precision: number;
  expectancy: number;
  costImpactBps: number;
  slippageSensitivity: "LOW" | "MEDIUM" | "HIGH";
  verdict: "PREFERRED" | "ACCEPTABLE" | "AVOID";
}

// ─── Phase 16: Time-of-Day Quality ────────────────────────────────────────────

export interface TimeOfDayBucket {
  label: string;  // e.g. "09:15–09:30"
  startMinute: number; // minutes from market open (9:15 IST)
  endMinute: number;
  signalCount: number;
  precision: number;
  avgReturn: number;
  falseSignalRate: number;
  executionQuality: "EXCELLENT" | "GOOD" | "DEGRADED" | "POOR";
  recommendation: "TRADE" | "CAUTION" | "AVOID";
}

// ─── Phase 17: Paper vs Signal Funnel ────────────────────────────────────────

export interface PaperSignalFunnelStage {
  stage:
    | "SIGNAL_GENERATED"
    | "RISK_APPROVED"
    | "PAPER_EXECUTED"
    | "PROFITABLE_OUTCOME";
  count: number;
  passRate: number;  // vs previous stage
  edgeLost: number;  // precision drop vs previous stage
}

export interface PaperSignalFunnel {
  strategyId: string;
  stages: PaperSignalFunnelStage[];
  /** Layer where the most edge is lost */
  bottleneck: "RISK_FILTER" | "EXECUTION" | "OUTCOME" | "NONE";
  bottleneckDescription: string;
}

// ─── Phase 18: Cost Robustness ────────────────────────────────────────────────

export type CostScenario = "BASE" | "1_5X" | "2X" | "3X";

/** BASE cost assumption: NSE F&O transaction cost in basis points — also defined in stats.ts */
export const BASE_COST_BPS_CONST = 5; // use stats.BASE_COST_BPS in runtime code

export interface CostRobustnessRow {
  scenario: CostScenario;
  costBps: number;
  precision: number;
  expectancy: number;
  netPnlPct: number;
  profitFactor: number;
}

export interface CostRobustness {
  strategyId: string;
  rows: CostRobustnessRow[];
  verdict: "COST_ROBUST" | "COST_SENSITIVE" | "COST_FRAGILE";
}

// ─── Phase 19: Statistical Significance ──────────────────────────────────────

export type StatisticalSignificance =
  | "STATISTICALLY_MEANINGFUL"  // n ≥ 30, CI width < 0.15
  | "MARGINAL"                  // n ≥ 15
  | "INSUFFICIENT_EVIDENCE";    // n < 15

export interface StatisticalSignificanceReport {
  strategyId: string;
  sampleSize: number;
  precision95CiLow: number;
  precision95CiHigh: number;
  expectancy95CiLow: number;
  expectancy95CiHigh: number;
  bootstrapWinRateMean: number;
  bootstrapWinRateStd: number;
  significanceLevel: StatisticalSignificance;
  minimumSampleForConclusion: number;
}

// ─── Phase 20: Signal Quality Score ──────────────────────────────────────────

export interface SignalQualityScoreBreakdown {
  /**
   * Component weights sum to 100.
   * Each raw sub-score is in [0, 1] before weighting.
   */
  precisionScore: number;          // weight 20 — raw precision
  recallScore: number;             // weight 10 — signal capture rate
  expectancyScore: number;         // weight 20 — R-multiple adjusted expectancy
  costRobustnessScore: number;     // weight 10 — performance under 2× cost
  calibrationScore: number;        // weight 10 — 1 - ECE (confidence accuracy)
  regimeConsistencyScore: number;  // weight 10 — std-dev of regime performances
  sampleSizeScore: number;         // weight 5  — penalise insufficient data
  drawdownScore: number;           // weight 10 — max drawdown penalty
  paperExecutionScore: number;     // weight 5  — edge preserved through paper funnel
  /** Weighted composite [0–100] */
  total: number;
}

export interface SignalQualityScore {
  strategyId: string;
  label: string;
  breakdown: SignalQualityScoreBreakdown;
  score: number; // 0–100
  verdict: StrategyVerdict;
}

export type StrategyVerdict =
  | "HIGH_QUALITY"       // score ≥ 75, n ≥ 30
  | "PROMISING"          // score 60–74, n ≥ 15
  | "NEEDS_MORE_DATA"    // insufficient n regardless of score
  | "WEAK"               // score 40–59
  | "DEGRADED"           // score 25–39
  | "DISABLE_CANDIDATE"; // score < 25

// ─── Aggregate Report ─────────────────────────────────────────────────────────

/** The full signal quality benchmark report returned by the engine */
export interface SignalQualityReport {
  generatedAt: number;
  evaluationWindowDays: number;
  totalSignalsEvaluated: number;
  totalTradesEvaluated: number;
  /** Phase 2 */
  confusionMatrices: ConfusionMatrix[];
  /** Phase 3 */
  captureRecall: SignalCaptureRecall[];
  /** Phase 4 */
  precision: SignalPrecisionResult[];
  /** Phase 5 */
  forwardReturns: ForwardReturnDistribution[];
  /** Phase 6 */
  mfeMaeSummaries: MfeMaeSummary[];
  /** Phase 7 */
  confidenceCalibration: ConfidenceCalibration[];
  /** Phase 8 */
  winProbabilityCalibration: WinProbabilityCalibration[];
  /** Phase 9 */
  gradeValidation: GradeValidation[];
  /** Phase 10 */
  leaderboard: StrategyLeaderboardEntry[];
  /** Phase 11 */
  filterAblation: FilterAblation[];
  /** Phase 12 */
  mlContribution: MLContribution[];
  /** Phase 13 */
  signalCorrelation: SignalCorrelationMatrix;
  /** Phase 14 */
  regimeQuality: RegimeQuality[];
  /** Phase 15 */
  instrumentQuality: InstrumentQualityRow[];
  /** Phase 16 */
  timeOfDayQuality: TimeOfDayBucket[];
  /** Phase 17 */
  paperSignalFunnel: PaperSignalFunnel[];
  /** Phase 18 */
  costRobustness: CostRobustness[];
  /** Phase 19 */
  statisticalSignificance: StatisticalSignificanceReport[];
  /** Phase 20 */
  signalQualityScores: SignalQualityScore[];
  /** Final strategy verdicts */
  finalVerdicts: Array<{
    strategyId: string;
    label: string;
    verdict: StrategyVerdict;
    justification: string;
    score: number;
    sampleSize: number;
  }>;
}
