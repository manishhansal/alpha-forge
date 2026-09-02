/**
 * OpportunityV1 — Canonical Versioned Opportunity Object
 *
 * Every candidate trade in AlphaForge must be represented as an
 * OpportunityV1 before any decision is made. The object preserves
 * the complete evidence chain from market event to final decision.
 *
 * Design rules:
 *   1. opportunityId is immutable — never changes after creation
 *   2. Every stage of the pipeline adds its own fields — never overwrites
 *   3. finalDecision is ONLY set after ALL gates have been evaluated
 *   4. Rejection reasons are stored even when approved (for learning)
 *   5. The object separates Detection → Qualification → Approval → Sizing
 *
 * Pipeline stages (must be respected in order):
 *   MARKET DATA → OPPORTUNITY DETECTION → SIGNAL QUALITY →
 *   EXPECTED VALUE → RISK GATE → EXECUTION FEASIBILITY →
 *   POSITION SIZING → FINAL DECISION
 */

// ─── Instrument / Exchange ────────────────────────────────────────────────────

export type Exchange = "NSE" | "NFO" | "BSE" | "BFO";

export type Segment =
  | "FUTURES"
  | "OPTIONS"
  | "EQUITY"
  | "INDEX";

export type InstrumentCategory =
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

// ─── Setup Type ───────────────────────────────────────────────────────────────

export type SetupType =
  | "BREAKOUT"              // Price breaks out of compression/resistance
  | "BREAKOUT_RETEST"       // Breakout followed by successful retest
  | "TREND_CONTINUATION"    // Pullback within established trend
  | "MEAN_REVERSION"        // Stretched move returning to equilibrium
  | "LIQUIDITY_SWEEP"       // Stop sweep / failed breakout reversal
  | "OPENING_RANGE_BREAK"   // First 15-30 min range breakout
  | "GAP_FILL"              // Morning gap fill trade
  | "OI_DRIVEN"             // Open interest directional positioning
  | "IV_EVENT"              // IV spike or crush trade
  | "MAX_PAIN_GRAVITY"      // Options max-pain magnetism
  | "EXPIRY_GAMMA"          // Expiry day gamma-driven move
  | "UNKNOWN";

// ─── Market Regime ────────────────────────────────────────────────────────────

export type MarketRegimeState =
  | "STRONG_BULL_TREND"  // ADX > 30, price well above SMAs, breadth strong
  | "WEAK_BULL"          // Positive bias but low conviction
  | "RANGE"              // Price oscillating, ADX < 20
  | "HIGH_VOLATILITY_RANGE" // Range-bound but with high IV/ATR
  | "STRONG_BEAR_TREND"  // ADX > 30, price well below SMAs
  | "WEAK_BEAR"          // Negative bias but low conviction
  | "PANIC"              // VIX spike, gap-down, circuit breaker territory
  | "TRANSITION"         // Regime change in progress, conflicting signals
  | "UNKNOWN";           // Cannot determine with available data

// ─── Timeframe Alignment ──────────────────────────────────────────────────────

export type MTFAlignmentState =
  | "ALIGNED"           // All timeframes agree on direction
  | "PARTIALLY_ALIGNED" // Majority agree, minor timeframe conflict
  | "CONFLICTING"       // Major timeframes disagree
  | "NEUTRAL";          // No clear directional bias across timeframes

// ─── Quality Dimensions ──────────────────────────────────────────────────────

export type QualityTier =
  | "A_PLUS"  // Exceptional — all criteria met, high EV, no conflicts
  | "A"       // Strong — one moderate weakness
  | "B"       // Solid — tradeable, acceptable EV
  | "C"       // Marginal — borderline, research only
  | "D"       // Weak — very low probability of edge
  | "REJECT"; // Fails a hard gate — must not be traded

// ─── Sector / OI / Options Regimes ───────────────────────────────────────────

export type SectorContextClassification =
  | "STRONGLY_SUPPORTIVE"
  | "SUPPORTIVE"
  | "NEUTRAL"
  | "CONTRADICTORY"
  | "STRONGLY_CONTRADICTORY"
  | "UNKNOWN";

export type VolatilityRegimeState =
  | "COMPRESSED"
  | "NORMAL"
  | "EXPANDING"
  | "EXTREME"
  | "SHOCK";

export type LiquidityRegimeState =
  | "DEEP"
  | "ADEQUATE"
  | "THIN"
  | "ILLIQUID";

export type OIBuildupClassification =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "NEUTRAL"
  | "CONFLICT"
  | "UNCLASSIFIED";

export type OptionsFlowBias =
  | "BULLISH"
  | "BEARISH"
  | "NEUTRAL"
  | "PINNING"
  | "BREAKOUT_SUPPORTIVE"
  | "BREAKOUT_HOSTILE"
  | "CONTRADICTORY"
  | "UNKNOWN";

// ─── Decision States ──────────────────────────────────────────────────────────

export type OpportunityDecision =
  | "STRONG_BUY"
  | "BUY"
  | "WATCH"
  | "WAIT"
  | "REDUCE"
  | "EXIT"
  | "REJECT"
  | "ABSTAIN"; // No trade, but not a rejection — simply insufficient edge

export type OpportunityLifecycleState =
  | "DETECTED"          // Market conditions detected a candidate setup
  | "QUALIFIED"         // Passed initial quality screening
  | "APPROVED"          // Risk and EV approved
  | "RISK_APPROVED"     // Portfolio risk approved
  | "READY"             // Ready for execution
  | "TRIGGERED"         // Entry trigger fired
  | "ENTERED"           // Position opened
  | "PARTIAL"           // Partially filled or partial exit
  | "MANAGED"           // In active trade management
  | "EXITED"            // Trade fully closed
  | "EXPIRED"           // Opportunity window elapsed without execution
  | "CANCELLED"         // Cancelled before execution
  | "REJECTED"          // Hard rejection at any gate
  | "ABSTAINED";        // System chose not to trade (valid outcome)

// ─── Hard Rejection Codes ─────────────────────────────────────────────────────

/**
 * Standardized rejection codes. These enable learning — every rejection
 * is categorized so the system can compute false-rejection rates per code.
 */
export type HardRejectionCode =
  | "STALE_MARKET_DATA"          // Data older than acceptable threshold
  | "INVALID_OHLC"               // OHLC integrity failure (high < low, etc.)
  | "MISSING_REQUIRED_PRICE"     // Cannot determine entry/stop/target
  | "ZERO_LIQUIDITY"             // No tradeable volume
  | "INVALID_RISK_PARAMS"        // Stop or target mathematically invalid
  | "RR_BELOW_MINIMUM"           // R:R < configurable minimum (default 1.5)
  | "NEGATIVE_EXPECTED_VALUE"    // Net EV after costs is negative
  | "EXCESSIVE_SPREAD"           // Bid/ask spread exceeds edge
  | "DAILY_LOSS_LIMIT_BREACHED"  // Daily loss cap hit
  | "PORTFOLIO_EXPOSURE_EXCEEDED"// Total portfolio risk at limit
  | "CORRELATION_LIMIT_EXCEEDED" // Too correlated with existing positions
  | "MARKET_CLOSED"              // Outside trading hours
  | "EXECUTION_IMPOSSIBLE"       // Cannot be filled (circuit limit, etc.)
  | "CRITICAL_DATA_CORRUPTION"   // Provider returned corrupt / impossible data
  | "DRAWDOWN_HALT"              // Drawdown tier requires halt
  | "KILL_SWITCH_ACTIVE"         // Manual or auto kill switch
  | "EXPIRY_GAMMA_RISK"          // Expiry-day gamma risk too high
  | "INSTRUMENT_SUSPENDED"       // NSE circuit breaker / trading halt
  | "DUPLICATE_OPPORTUNITY"      // Same opportunity already active
  | "LOW_EXPECTANCY"             // Historical expectancy below threshold
  | "INSUFFICIENT_SAMPLE"        // Too few historical trades to evaluate
  | "MODEL_UNAVAILABLE";         // Required model not available and not fallback-safe

// ─── Soft Rejection Codes (influence score, not hard block) ─────────────────

export type SoftPenaltyCode =
  | "REGIME_CONFLICT"
  | "SECTOR_CONFLICT"
  | "MARKET_CONFLICT"
  | "OI_CONFLICT"
  | "OPTION_FLOW_CONFLICT"
  | "VOLATILITY_TOO_HIGH"
  | "LATE_ENTRY"
  | "SIGNAL_EXPIRED"
  | "ML_UNCERTAINTY"
  | "POOR_CALIBRATION"
  | "LOW_VOLUME"
  | "WEAK_STRUCTURE"
  | "WEAK_MOMENTUM"
  | "HIGH_SLIPPAGE_RISK"
  | "POOR_TIME_OF_DAY"
  | "CONFLICTING_TIMEFRAMES"
  | "MIXED_SECTOR_BREADTH"
  | "HIGH_CORRELATION_PENALTY";

// ─── Score Dimensions ─────────────────────────────────────────────────────────

/**
 * Multi-dimensional quality assessment. Each score is independently
 * computable and attributable. Do NOT collapse into a single number
 * until the ranking stage.
 *
 * Scores are normalized to [0, 1] unless stated otherwise.
 * Directional scores ([-1, 1]) indicate bullish/bearish alignment.
 */
export interface OpportunityScoreVector {
  // ── Market context ────────────────────────────────────────────────────────
  /** Overall market index alignment (NIFTY/BANKNIFTY trend confirmation) */
  structureScore: number;         // [0, 1]
  momentumScore: number;          // [0, 1]
  volumeScore: number;            // [0, 1]
  volatilityScore: number;        // [0, 1] — 1 = ideal volatility for strategy
  liquidityScore: number;         // [0, 1]
  marketContextScore: number;     // [-1, 1]

  // ── Regime alignment ──────────────────────────────────────────────────────
  regimeScore: number;            // [0, 1] — 1 = regime strongly supports strategy

  // ── Derivatives ──────────────────────────────────────────────────────────
  oiScore: number;                // [-1, 1]
  optionsScore: number;           // [-1, 1]

  // ── Cross-sectional ───────────────────────────────────────────────────────
  relativeStrengthScore: number;  // [-1, 1]
  sectorScore: number;            // [-1, 1]

  // ── Quality and execution ─────────────────────────────────────────────────
  mlScore: number;                // [0, 1] — calibrated ML probability
  executionScore: number;         // [0, 1] — time-of-day + spread + latency
  qualityScore: number;           // [0, 1] — weighted composite of above

  // ── Probabilistic ────────────────────────────────────────────────────────
  probabilityWin: number;         // [0, 1] — calibrated, not raw confidence
  expectedValue: number;          // raw EV in % terms (signed)
  expectedShortfall: number;      // expected loss if the trade loses (negative)

  // ── Cost-adjusted ────────────────────────────────────────────────────────
  costEstimate: number;           // total round-trip cost as % of notional
  slippageEstimate: number;       // estimated slippage as % of notional
  netExpectedValue: number;       // EV - costs - slippage (primary ranking metric)

  // ── Risk ─────────────────────────────────────────────────────────────────
  riskScore: number;              // [0, 1] — 0 = very risky, 1 = risk well contained
  portfolioRiskScore: number;     // [0, 1] — marginal portfolio risk contribution
  correlationPenalty: number;     // [0, 1] — 0 = no correlation, 1 = fully correlated

  // ── Final ranking ────────────────────────────────────────────────────────
  /** Risk-adjusted net expected value — primary sorting metric */
  finalScore: number;             // [0, 100]
}

// ─── Expiry Context ───────────────────────────────────────────────────────────

export interface OpportunityExpiryContext {
  isExpiryDay: boolean;
  expiryType: "WEEKLY" | "MONTHLY" | "NONE";
  daysToExpiry: number;
  hoursToExpiry: number;
  expiryBehaviorModifier: number; // [0, 1] — 1 = normal, <1 = risk penalty
  gammaRiskActive: boolean;
  ivBehaviorExpected: "EXPANSION" | "COMPRESSION" | "NEUTRAL" | "UNKNOWN";
  optionLiquidityAdequate: boolean;
}

// ─── Trade Levels ─────────────────────────────────────────────────────────────

export interface OpportunityTradeLevels {
  /** Zone for entry (may be a range, not a single price) */
  entryZone: { low: number; high: number; ideal: number };
  /** Price at which setup is invalidated — hard stop */
  invalidation: number;
  target1: number;
  target2: number;
  target3: number;
  /** Expected favorable move from entry to target1 (%) */
  expectedMove: number;
  /** Expected adverse move before reaching target (max expected drawdown, %) */
  expectedAdverseMove: number;
  /** Risk:Reward ratio using target2 as primary target */
  riskReward: number;
  /** ATR of the instrument at signal time */
  atrAtSignal: number;
  /** ATR multiplier used for stop */
  stopAtrMultiplier: number;
}

// ─── Opportunity Evidence ─────────────────────────────────────────────────────

export interface OpportunityEvidence {
  /** Positive evidence points (drove signal approval) */
  positiveEvidence: string[];
  /** Negative evidence points (argued against) */
  negativeEvidence: string[];
  /** Evidence that would invalidate the opportunity */
  invalidationConditions: string[];
  /** Factors that were unavailable / not evaluated */
  missingFactors: string[];
  /** Human-readable explanation of the final decision */
  decisionRationale: string;
  /** Why this instrument over others available */
  instrumentSelectionReason: string;
  /** Why now (timing justification) */
  timingJustification: string;
}

// ─── Model Versioning ─────────────────────────────────────────────────────────

export interface OpportunityModelVersions {
  modelVersion: string;     // opportunity engine version
  featureVersion: string;   // feature set version
  policyVersion: string;    // risk policy version
  mlModelVersion: string | null;
  strategyVersion: string;
}

// ─── OpportunityV1 — The Canonical Object ────────────────────────────────────

/**
 * OpportunityV1 is the single canonical representation of every candidate
 * trade in AlphaForge. It is immutable after creation and captures the
 * complete evidence chain.
 *
 * The object must be created with ALL known data at detection time.
 * Subsequent pipeline stages AUGMENT the object — they do not replace it.
 */
export interface OpportunityV1 {
  // ── Identity ─────────────────────────────────────────────────────────────
  /** Globally unique immutable ID. Format: opp_{instrument}_{ts}_{random6} */
  opportunityId: string;
  /** Correlation ID used for cross-opportunity deduplication */
  correlationId: string;
  /** Human-readable label for display */
  label: string;

  // ── Instrument ───────────────────────────────────────────────────────────
  instrument: string;       // NSE trading symbol (no suffix)
  instrumentName: string;   // Human-readable name
  exchange: Exchange;
  segment: Segment;
  instrumentCategory: InstrumentCategory;
  lotSize: number;          // 1 for equities

  // ── Timing ───────────────────────────────────────────────────────────────
  /** UTC ms when setup conditions were first detected */
  timestamp: number;
  /** UTC ms when opportunity data became available (no lookahead before this) */
  availableAt: number;
  /** UTC ms when opportunity expires (after which it must not be acted upon) */
  expiresAt: number;
  /** IST trading date YYYY-MM-DD */
  tradeDate: string;

  // ── Direction / Strategy ─────────────────────────────────────────────────
  direction: "LONG" | "SHORT" | "NEUTRAL";
  strategy: string;         // primary strategy ID
  signalSource: string;     // STRATEGY | SCANNER | ML | META | MANUAL
  setupType: SetupType;

  // ── Trade Levels ─────────────────────────────────────────────────────────
  levels: OpportunityTradeLevels;

  // ── Regime Context ───────────────────────────────────────────────────────
  marketRegime: MarketRegimeState;
  sectorRegime: SectorContextClassification;
  volatilityRegime: VolatilityRegimeState;
  liquidityRegime: LiquidityRegimeState;
  mtfAlignment: MTFAlignmentState;

  // ── Time Context ─────────────────────────────────────────────────────────
  timeOfDay: string;        // e.g. "09:30–10:00"
  sessionMinutesElapsed: number;
  expiryContext: OpportunityExpiryContext;

  // ── Score Vector ─────────────────────────────────────────────────────────
  scores: OpportunityScoreVector;

  // ── Quality ──────────────────────────────────────────────────────────────
  qualityTier: QualityTier;

  // ── Decision ─────────────────────────────────────────────────────────────
  decision: OpportunityDecision;
  decisionReason: string;
  lifecycleState: OpportunityLifecycleState;

  // ── Rejection Codes ───────────────────────────────────────────────────────
  /** Hard gates that were triggered (if any) */
  hardRejections: HardRejectionCode[];
  /** Soft penalties applied */
  softPenalties: SoftPenaltyCode[];

  // ── Evidence ─────────────────────────────────────────────────────────────
  evidence: OpportunityEvidence;

  // ── Position Sizing Output ────────────────────────────────────────────────
  /** Recommended position size as % of capital */
  recommendedSizePct: number;
  /** Recommended position size in INR */
  recommendedSizeINR: number;
  /** Whether hard sizing cap was applied */
  sizingCapApplied: boolean;

  // ── OI / Options Context ──────────────────────────────────────────────────
  oiBuildupClassification: OIBuildupClassification;
  optionsFlowBias: OptionsFlowBias;

  // ── Relative Strength ────────────────────────────────────────────────────
  relativeStrengthVsNifty: number | null;    // [-1, 1]
  relativeStrengthVsSector: number | null;   // [-1, 1]
  sectorRank: number | null;                  // 0-100 percentile within sector
  momentumRank: number | null;               // 0-100 percentile

  // ── Versioning ───────────────────────────────────────────────────────────
  versions: OpportunityModelVersions;

  // ── Provider Context ─────────────────────────────────────────────────────
  primaryProvider: string;
  dataQualityLevel: "COMPLETE" | "PARTIAL" | "STALE" | "MISSING";
  providerConfidence: number;  // [0, 1]
}

// ─── Opportunity Factory ──────────────────────────────────────────────────────

let _counter = 0;

/**
 * Create a new OpportunityV1 with a guaranteed unique ID.
 * The ID is deterministic for the same instrument + timestamp within a process.
 */
export function createOpportunityId(instrument: string, timestampMs: number): string {
  _counter = (_counter + 1) % 999999;
  const ts = timestampMs.toString(36).slice(-6);
  const rand = (_counter + Math.floor(Math.random() * 1000)).toString(36).padStart(4, "0").slice(-4);
  return `opp_${instrument.toLowerCase().replace(/[^a-z0-9]/g, "")}_${ts}_${rand}`;
}

/**
 * Create a correlation ID used to group related opportunities.
 * Signals on the same instrument+direction within 10 minutes share a correlationId.
 */
export function createCorrelationId(
  instrument: string,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  timestampMs: number,
): string {
  const windowMs = 10 * 60 * 1000;
  const timeKey = Math.floor(timestampMs / windowMs);
  return `corr_${instrument.toLowerCase()}_${direction.toLowerCase()}_${timeKey.toString(36)}`;
}

// ─── Opportunity Funnel ───────────────────────────────────────────────────────

/** Track the conversion ratios at each stage of the opportunity pipeline. */
export interface OpportunityFunnel {
  sessionDate: string;
  marketEventsDetected: number;
  candidatesGenerated: number;
  qualifiedOpportunities: number;
  riskApproved: number;
  executionFeasible: number;
  tradesOpened: number;
  winners: number;
  profitableAlpha: number;

  // Conversion ratios (0–1)
  detectionToQualification: number;
  qualificationToApproval: number;
  approvalToExecution: number;
  executionToWin: number;

  // Rejection breakdown
  rejectionsByCode: Record<HardRejectionCode, number>;
  softPenaltiesByCode: Record<SoftPenaltyCode, number>;
}

// ─── Opportunity Comparison ───────────────────────────────────────────────────

/** Used by the opportunity auction model to rank competing opportunities. */
export interface OpportunityRankEntry {
  opportunityId: string;
  instrument: string;
  direction: string;
  strategy: string;
  qualityTier: QualityTier;
  netExpectedValue: number;
  finalScore: number;
  recommendedSizePct: number;
  correlationPenalty: number;
  rankPosition: number;
  selected: boolean;
  selectionReason: string | null;
  rejectionReason: string | null;
}

// ─── Counterfactual ───────────────────────────────────────────────────────────

/**
 * Counterfactual outcome for a rejected opportunity.
 * Used to measure false-rejection rate and improve rejection logic.
 */
export interface OpportunityCounterfactual {
  opportunityId: string;
  hardRejectionCode: HardRejectionCode | null;
  softPenaltyCodes: SoftPenaltyCode[];
  counterfactualOutcome: "WIN" | "LOSS" | "BREAKEVEN" | "UNKNOWN";
  counterfactualReturn: number | null;   // % return if taken
  counterfactualRMultiple: number | null;
  wasCorrectRejection: boolean;
  wasIncorrectRejection: boolean;
  explanation: string;
  evaluatedAt: number;
}

// ─── Daily Signal Audit ───────────────────────────────────────────────────────

export interface DailySignalAuditReport {
  sessionDate: string;
  generatedAt: number;

  // Funnel
  funnel: OpportunityFunnel;

  // Top opportunities
  topApproved: OpportunityRankEntry[];
  topRejected: Array<{ opportunityId: string; instrument: string; rejectionCode: string; hardRejection: boolean }>;

  // Attribution
  rejectionReasonBreakdown: Record<string, number>;
  approvalByStrategy: Record<string, number>;
  approvalByRegime: Record<string, number>;
  approvalByTimeOfDay: Record<string, number>;
  approvalBySector: Record<string, number>;

  // Quality distribution
  qualityTierDistribution: Record<QualityTier, number>;

  // Performance (post-session, from paper trade outcomes)
  winningSetups: Array<{ strategy: string; setupType: string; count: number; avgR: number }>;
  losingSetups: Array<{ strategy: string; setupType: string; count: number; avgR: number }>;

  // Metrics
  averageNetEV: number;
  averageQualityScore: number;
  averageRR: number;
  totalTradesOpenedToday: number;
}
