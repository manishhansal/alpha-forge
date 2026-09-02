/**
 * AlphaForge Signal Intelligence Engine — Canonical Types
 *
 * Every signal produced by any component of this system MUST conform to
 * `EnrichedSignal`. The taxonomy enforced here is the single point of truth
 * that prevents generic `technical` signals from masquerading as official
 * Indian F&O strategy signals.
 *
 * Key design rules:
 *   1. `signalSourceType` is REQUIRED and must be one of the allowed enum values.
 *   2. `UNKNOWN` is treated as an ERROR — it must never reach a leaderboard.
 *   3. `TECHNICAL_BASELINE` signals are tracked separately and never mixed
 *      into strategy-level metrics.
 *   4. Every signal must have a `correlationId` to support deduplication
 *      across the opportunity clustering layer.
 */

// ─── Signal Source Taxonomy ───────────────────────────────────────────────────

/**
 * Strict enum of allowed signal source types.
 * UNKNOWN is reserved for error cases only — never valid in production.
 */
export type SignalSourceType =
  | "STRATEGY"           // One of the 9 official India F&O strategies
  | "SCANNER"            // F&O scanner hit (momentum, volume, OI, PCR, IV, range)
  | "ML"                 // Pure ML model output (no deterministic base)
  | "META"               // Meta-layer ensemble (combines multiple sources)
  | "TECHNICAL_BASELINE" // Generic technical signals — NEVER in strategy metrics
  | "MANUAL"             // Manually opened from UI (Daily Pick, AI Signal board)
  | "RESEARCH"           // Research / backtest only — NEVER in live/paper metrics
  | "LEGACY"             // Pre-taxonomy signals — audit trail only
  | "UNKNOWN";           // ERROR STATE — must be investigated and reclassified

/**
 * Reporting partition — signals are separated into these buckets
 * for all leaderboard, precision, recall, and ML evaluation metrics.
 * UNKNOWN must be treated as an error and routed to investigation.
 */
export type SignalReportingBucket =
  | "OFFICIAL_STRATEGIES"  // STRATEGY source type only
  | "BASELINE"             // TECHNICAL_BASELINE
  | "FALLBACK"             // LEGACY + signals with incomplete taxonomy
  | "SCANNER"              // SCANNER source type
  | "ML"                   // ML source type
  | "META"                 // META source type
  | "MANUAL"               // MANUAL source type
  | "RESEARCH"             // RESEARCH source type
  | "UNKNOWN";             // ERROR — must never appear in production reports

// ─── Official India F&O Strategy IDs ─────────────────────────────────────────

/**
 * Canonical list of official India F&O strategies that are allowed to appear
 * in the strategy leaderboard. Only these strategies can have
 * signalSourceType = "STRATEGY".
 *
 * Generic `technical`, `fallback`, or `heuristic` strategy IDs must NOT be
 * added here.
 */
export const OFFICIAL_INDIA_STRATEGY_IDS = [
  "RANGE_EXPANSION",
  "MOMENTUM",
  "VOLUME_BREAKOUT",
  "OI_BUILDUP",
  "PCR_EXTREME",
  "IV_SPIKE",
  "LIQUIDITY_EDGE",
  "MAX_PAIN_GRAVITY",
  "OPENING_BREAKOUT",
] as const;

export type OfficialIndiaStrategyId = (typeof OFFICIAL_INDIA_STRATEGY_IDS)[number];

/** Type guard for official strategy IDs */
export function isOfficialIndiaStrategy(id: string): id is OfficialIndiaStrategyId {
  return (OFFICIAL_INDIA_STRATEGY_IDS as readonly string[]).includes(id);
}

// ─── Signal Direction / Action ────────────────────────────────────────────────

export type SignalDirection = "LONG" | "SHORT" | "NEUTRAL";
export type SignalAction = "BUY" | "SELL" | "WAIT" | "NO_TRADE";

// ─── Signal Lifecycle States ──────────────────────────────────────────────────

export type SignalLifecycleState =
  | "DETECTED"       // Conditions detected; not yet validated
  | "VALIDATING"     // Running validation checks
  | "QUALIFIED"      // Passed all validation checks
  | "RISK_CHECK"     // In pre-trade risk gate
  | "APPROVED"       // Risk approved
  | "PAPER_EXECUTED" // Paper trade opened
  | "ACTIVE"         // Trade is open / in-flight
  | "PARTIAL"        // Partial fill / partial exit
  | "EXITED"         // Trade fully closed
  | "EXPIRED"        // Elapsed evaluation horizon with no resolution
  | "REJECTED"       // Rejected by risk / quality filter
  | "CANCELLED";     // Cancelled before execution

// ─── Data Quality ─────────────────────────────────────────────────────────────

export type DataQualityLevel =
  | "COMPLETE"   // All required fields present and fresh
  | "PARTIAL"    // Some optional fields missing; core data present
  | "STALE"      // Data is older than acceptable threshold
  | "MISSING"    // Required data fields absent
  | "ESTIMATED"; // Values were estimated/interpolated

export interface DataQualityMetadata {
  level: DataQualityLevel;
  /** Missing fields that were required */
  missingFields: string[];
  /** Fields that were estimated/interpolated */
  estimatedFields: string[];
  /** UTC ms when the underlying market data was fetched */
  dataFetchedAtMs: number;
  /** Maximum acceptable data age in ms for this signal */
  maxStaleMs: number;
  /** Whether data is from a live provider or cached */
  isLive: boolean;
  /** Which provider supplied the primary data */
  providerId: string | null;
}

// ─── Risk Decision ────────────────────────────────────────────────────────────

export type RiskDecision =
  | "APPROVED"
  | "REJECTED_DRAWDOWN"
  | "REJECTED_EXPOSURE"
  | "REJECTED_CORRELATION"
  | "REJECTED_VAR"
  | "REJECTED_KILL_SWITCH"
  | "REJECTED_LIQUIDITY"
  | "NOT_EVALUATED";

export type PaperDecision =
  | "EXECUTED"
  | "SKIPPED_DUPLICATE"
  | "SKIPPED_MARKET_CLOSED"
  | "SKIPPED_EXPIRY_COOLDOWN"
  | "SKIPPED_LOW_QUALITY"
  | "SKIPPED_OUTSIDE_HOURS"
  | "NOT_ATTEMPTED";

// ─── Signal Abstention Reasons ────────────────────────────────────────────────

export type AbstentionReason =
  | "LOW_EDGE"
  | "BAD_REGIME"
  | "LOW_LIQUIDITY"
  | "POOR_RISK_REWARD"
  | "DATA_QUALITY"
  | "ML_UNCERTAINTY"
  | "CONFLICTING_TIMEFRAMES"
  | "CONFLICTING_DERIVATIVES"
  | "HIGH_CORRELATION"
  | "EXPIRY_RISK"
  | "EXCESS_PORTFOLIO_EXPOSURE"
  | "INSUFFICIENT_VOLUME"
  | "SPREAD_TOO_WIDE"
  | "STRUCTURE_INVALIDATED"
  | "MARKET_CLOSED";

// ─── Signal Quality Vector ────────────────────────────────────────────────────

/**
 * Multi-dimensional signal quality assessment. Each component is independently
 * inspectable. Do NOT collapse this into a single confidence score until the
 * ranking layer — separate visibility is required for attribution.
 */
export interface SignalQualityVector {
  /** Overall market context alignment [-1, 1] */
  marketContext: number;
  /** Regime fit score [-1, 1] (positive = regime supports this strategy) */
  regimeFit: number;
  /** Multi-timeframe alignment score [-1, 1] */
  mtfAlignment: number;
  /** Market structure quality [0, 1] */
  structureQuality: number;
  /** Momentum quality [0, 1] */
  momentumQuality: number;
  /** Volume quality [0, 1] */
  volumeQuality: number;
  /** Volatility fit [0, 1] (1 = ideal regime for this strategy) */
  volatilityFit: number;
  /** Liquidity quality [0, 1] */
  liquidityQuality: number;
  /** Derivatives confirmation [-1, 1] */
  derivativesConfirmation: number;
  /** Relative strength vs NIFTY [-1, 1] */
  relativeStrength: number;
  /** ML model probability [0, 1] (0.5 = neutral / unavailable) */
  mlProbability: number;
  /** Expected value estimate (positive = worth taking) */
  expectedValue: number;
  /** Execution quality estimate [0, 1] */
  executionQuality: number;
  /** Data quality [0, 1] */
  dataQuality: number;
  /** Composite signal score [0, 1] — weighted combination of above */
  composite: number;
  /** Individual component reasons for scoring */
  reasons: SignalQualityReason[];
}

export interface SignalQualityReason {
  component: keyof Omit<SignalQualityVector, "composite" | "reasons">;
  score: number;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  label: string;
}

// ─── Expected Value ───────────────────────────────────────────────────────────

export interface ExpectedValueEstimate {
  /** Calibrated win probability [0, 1] */
  pWin: number;
  /** Calibrated loss probability [0, 1] */
  pLoss: number;
  /** Expected gain if win (% of entry) */
  expectedWinPct: number;
  /** Expected loss if stop hit (% of entry) */
  expectedLossPct: number;
  /** Estimated transaction costs (% of entry) */
  estimatedCostPct: number;
  /** Estimated slippage (% of entry) */
  estimatedSlippagePct: number;
  /**
   * EV = P(win) × E[win] - P(loss) × E[loss] - costs
   * Positive = worth taking; negative = NO_TRADE
   */
  ev: number;
  /** Risk-adjusted EV: ev / stdDev (Sharpe-like per-trade ratio) */
  riskAdjustedEv: number;
}

// ─── Signal Ranking Grade ─────────────────────────────────────────────────────

export type SignalRankGrade =
  | "A_PLUS" // Exceptional — EV > 2, quality > 0.8, liquidity confirmed
  | "A"      // Strong — EV > 1, quality > 0.7
  | "B"      // Solid — EV > 0.5, quality > 0.55
  | "C"      // Marginal — EV > 0, quality > 0.45
  | "REJECT"; // EV ≤ 0 or quality ≤ 0.45

// ─── Core Enriched Signal ─────────────────────────────────────────────────────

/**
 * The canonical enriched signal type. Every signal component must produce
 * an `EnrichedSignal` or be wrapped into one before entering the
 * ranking / paper-trading pipeline.
 *
 * Fields marked REQUIRED must always be populated. Fields marked OPTIONAL
 * may be null/undefined when the relevant component was unavailable.
 */
export interface EnrichedSignal {
  // ── Identity (REQUIRED) ─────────────────────────────────────────────────
  /** Unique signal ID — stable across retries, used for deduplication */
  signalId: string;
  /**
   * The strategy that produced this signal.
   * For STRATEGY source: must be one of OFFICIAL_INDIA_STRATEGY_IDS.
   * For SCANNER: the scanner type (e.g. "MOMENTUM_SCANNER").
   * For ML: the model name.
   * For MANUAL: the UI surface (e.g. "DAILY_PICK").
   */
  strategyId: string;
  /** Strict source taxonomy — never UNKNOWN in a valid production signal */
  sourceType: SignalSourceType;
  /** Version string of the strategy/model that produced this signal */
  sourceVersion: string;

  // ── Instrument (REQUIRED) ────────────────────────────────────────────────
  /** NSE trading symbol (no .NS suffix) */
  instrument: string;
  /** Human-readable name */
  instrumentName: string;
  /** Exchange */
  exchange: "NSE" | "NFO" | "BSE" | "BFO";
  /** Instrument category */
  instrumentCategory:
    | "NIFTY_INDEX"
    | "BANKNIFTY_INDEX"
    | "FINNIFTY_INDEX"
    | "MIDCPNIFTY_INDEX"
    | "SENSEX_INDEX"
    | "INDEX_FUTURE"
    | "STOCK_FUTURE"
    | "INDEX_OPTION"
    | "STOCK_OPTION"
    | "FNO_STOCK"
    | "OTHER";

  // ── Timing (REQUIRED) ────────────────────────────────────────────────────
  /** UTC ms when signal conditions were first detected */
  timestamp: number;
  /** Timeframe the signal was evaluated on */
  timeframe: "1m" | "5m" | "15m" | "30m" | "1h" | "1d";
  /** UTC ms of signal expiry (after which it should not be acted upon) */
  expiresAt: number;

  // ── Trade Levels (REQUIRED) ──────────────────────────────────────────────
  direction: SignalDirection;
  entry: number;
  stopLoss: number;
  target: number;
  /** Risk:reward ratio — target distance / stop distance */
  riskReward: number;
  /** ATR at signal time, used for sizing */
  atr: number;

  // ── Confidence & Scoring (REQUIRED) ─────────────────────────────────────
  /** Raw confidence from the originating strategy [0, 1] */
  confidence: number;
  /** Multi-dimensional quality vector */
  qualityVector: SignalQualityVector;
  /** Expected value calculation */
  expectedValue: ExpectedValueEstimate;
  /** Final ranking grade */
  grade: SignalRankGrade;
  /** Final composite score [0, 100] used for ranking */
  score: number;

  // ── Context (REQUIRED) ───────────────────────────────────────────────────
  /** Market regime at signal time */
  regime: MarketRegimeLabel;
  /** Whether the regime supports this strategy */
  regimeFit: "SUPPORTED" | "NEUTRAL" | "ADVERSE";
  /** Data quality metadata */
  dataQuality: DataQualityMetadata;

  // ── Decisions (REQUIRED) ─────────────────────────────────────────────────
  /** Risk engine decision */
  riskDecision: RiskDecision;
  /** Paper trading execution decision */
  paperDecision: PaperDecision;
  /** If NO_TRADE, explicit reason */
  abstentionReason: AbstentionReason | null;
  /** Current lifecycle state */
  lifecycleState: SignalLifecycleState;

  // ── Traceability (REQUIRED) ──────────────────────────────────────────────
  /**
   * Correlation ID for the underlying market opportunity. Multiple strategies
   * detecting the same breakout share a `correlationId` — the opportunity
   * clustering layer uses this to prevent double-counting.
   */
  correlationId: string;
  /** Reporting bucket — computed from sourceType */
  reportingBucket: SignalReportingBucket;

  // ── Attribution (OPTIONAL) ───────────────────────────────────────────────
  /** ML model versions used, if any */
  modelVersions?: Record<string, string>;
  /** Feature engineering version */
  featureVersion?: string;
  /** Human-readable rationale bullets */
  rationale?: string[];
  /** Strategy-specific extras for replay */
  extras?: Record<string, number | string | boolean | null>;
}

// ─── Market Regime Labels ─────────────────────────────────────────────────────

export type MarketRegimeLabel =
  | "STRONG_BULL"
  | "BULL"
  | "SIDEWAYS"
  | "VOLATILE"
  | "BEAR"
  | "CRASH"
  | "EXPIRY_DAY"
  | "HIGH_VOL"
  | "LOW_VOL"
  | "UNKNOWN";

// ─── Signal Source Registry Entry ────────────────────────────────────────────

export interface SignalSourceRegistryEntry {
  /** Unique source identifier */
  sourceId: string;
  /** Display name */
  sourceName: string;
  /** Source type taxonomy */
  sourceType: SignalSourceType;
  /** Reporting bucket */
  reportingBucket: SignalReportingBucket;
  /** Whether this source is active in production */
  active: boolean;
  /** Whether this source is allowed on the strategy leaderboard */
  leaderboardEligible: boolean;
  /** Whether ML contribution is measured against this source */
  mlEvaluationTarget: boolean;
  /** Strategy-specific notes */
  notes: string;
  /** Source version */
  version: string;
}

// ─── Opportunity Cluster ──────────────────────────────────────────────────────

/**
 * An opportunity cluster represents ONE underlying market opportunity that
 * may have been detected by multiple strategies simultaneously.
 * Multiple signals in the same cluster are NOT independent evidence.
 */
export interface OpportunityCluster {
  /** Stable cluster ID: `${instrument}_${dateKey}_${aproximateTimeMin}` */
  clusterId: string;
  /** Correlation ID (matches EnrichedSignal.correlationId for all members) */
  correlationId: string;
  /** The underlying market opportunity being detected */
  opportunityLabel: string;
  /** Instrument involved */
  instrument: string;
  /** Approximate start time of the opportunity (UTC ms) */
  opportunityStartMs: number;
  /** Direction of the opportunity */
  direction: SignalDirection;
  /** All signals that belong to this cluster */
  signals: Array<{
    signalId: string;
    strategyId: string;
    sourceType: SignalSourceType;
    confidence: number;
    score: number;
  }>;
  /**
   * The "best" signal to represent this cluster for paper trading.
   * Selected by highest score among APPROVED signals.
   */
  representativeSignalId: string | null;
  /** Number of independent (non-correlated) strategies confirming */
  independentConfirmations: number;
  /** Combined cluster confidence (NOT sum of individual scores) */
  clusterConfidence: number;
  /** Whether this cluster was de-duplicated (prevented multiple paper trades) */
  deduplicated: boolean;
  createdAt: number;
}

// ─── MTF Alignment ────────────────────────────────────────────────────────────

export type MTFTimeframe = "1d" | "1h" | "15m" | "5m" | "1m";

export interface MTFFrame {
  timeframe: MTFTimeframe;
  trend: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  structure: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";
  momentum: number; // [-1, 1]
  volatility: "LOW" | "NORMAL" | "HIGH" | "EXTREME";
  vwapRelation: "ABOVE" | "BELOW" | "AT" | "UNKNOWN";
  signalDirection: SignalDirection;
  confirmed: boolean;
}

export interface MTFAlignmentScore {
  frames: MTFFrame[];
  /** Number of timeframes aligning with signal direction */
  alignedCount: number;
  /** Number of timeframes opposing signal direction */
  opposingCount: number;
  /** Weighted alignment score [-1, 1] (higher TFs weighted more) */
  alignmentScore: number;
  /** Human-readable alignment reasons */
  alignmentReasons: string[];
  /** Grade: STRONG / MODERATE / WEAK / CONFLICTED */
  grade: "STRONG" | "MODERATE" | "WEAK" | "CONFLICTED";
}

// ─── Universe Coverage ────────────────────────────────────────────────────────

export interface UniverseCoverageSnapshot {
  /** IST session date YYYY-MM-DD */
  sessionDate: string;
  /** UTC ms when this snapshot was taken */
  capturedAtMs: number;
  /** Total instruments in the F&O universe */
  expectedInstruments: number;
  /** Instruments for which market data was available */
  availableInstruments: number;
  /** Instruments for which data was fetched this session */
  scannedInstruments: number;
  /** Instruments with complete required data (all fields populated) */
  dataCompleteInstruments: number;
  /** Instruments with partial data (some fields missing) */
  dataPartialInstruments: number;
  /** Instruments with no data */
  dataMissingInstruments: number;
  /** Instruments that were evaluated by at least one strategy */
  strategyEvaluatedInstruments: number;
  /** Instruments eligible for paper trading (passed risk/quality gate) */
  paperEligibleInstruments: number;
  /** Instruments excluded for any reason */
  excludedInstruments: number;
  /** Per-instrument exclusion reasons */
  exclusionReasons: Array<{
    instrument: string;
    reason: string;
  }>;
  /** Coverage score [0, 1] — strategyEvaluated / expected */
  coverageScore: number;
  /** Whether this report is valid (coverage above minimum threshold) */
  isValid: boolean;
  /** Minimum coverage threshold for validity [0, 1] */
  minValidCoverage: number;
}

// ─── Today Signal Audit Mode ──────────────────────────────────────────────────

export interface TodaySignalAuditReport {
  /** IST session date */
  sessionDate: string;
  /** UTC ms when audit was generated */
  generatedAtMs: number;
  /** F&O universe coverage */
  universeCoverage: UniverseCoverageSnapshot;
  /** Total signals detected today */
  signalsDetected: number;
  /** Signals that passed validation */
  signalsQualified: number;
  /** Signals approved by risk */
  riskApproved: number;
  /** Paper trades opened */
  paperTradesOpened: number;
  /** Paper trades resolved */
  paperTradesResolved: number;
  /** Winners */
  winners: number;
  /** Losers */
  losers: number;
  /** Missed opportunities (estimated) */
  missedOpportunities: number;
  /** False signals (stopped out) */
  falseSignals: number;
  /** Duplicate signals prevented by clustering */
  duplicatesPrevented: number;
  /** Risk-rejected signals */
  riskRejected: number;
  /** Per-strategy breakdown */
  byStrategy: Array<{
    strategyId: string;
    sourceType: SignalSourceType;
    signalsDetected: number;
    qualified: number;
    paperTrades: number;
    wins: number;
    losses: number;
    pnlPct: number;
  }>;
  /** ML contribution summary */
  mlContribution: {
    evaluated: boolean;
    baseSignals: number;
    mlFilteredIn: number;
    mlFilteredOut: number;
    incrementalPrecision: number;
  };
  /** Execution quality */
  executionQuality: {
    avgSpreadPct: number;
    avgSlippagePct: number;
    dataFreshnessScore: number;
  };
  /** Replay hash — same session replayed must produce the same hash */
  replayHash: string | null;
}
