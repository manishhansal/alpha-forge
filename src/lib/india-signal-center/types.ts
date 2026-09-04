/**
 * AlphaForge Unified Indian Market Signal Center — Canonical Types
 *
 * One canonical envelope for ALL Indian market signals regardless of origin:
 *   - AI Signals (india-builder.ts)
 *   - Daily Picks (features/india/daily-picks/)
 *   - F&O Scanners (services/india/scanner/)
 *   - FnO Trend Scanners (14-condition)
 *   - MSB Signals
 *   - Scalper signals (9 F&O strategies)
 *   - Expiry trades (Gamma Blast / Hero Zero)
 *   - Opportunity Engine decisions
 *
 * Key principle: ONE opportunity = ONE cluster, not N duplicate cards.
 * When multiple signal families confirm the same underlying opportunity,
 * they are grouped into one OpportunityCluster with confirmed count.
 */

import type { ProviderId } from "@/lib/market-data/types";

// ── Signal Family Taxonomy ────────────────────────────────────────────────────

export type IndiaSignalFamily =
  | "AI_SIGNAL"
  | "DAILY_PICK"
  | "FNO_SCANNER"
  | "FNO_TREND"
  | "MSB"
  | "SCALPER"
  | "EXPIRY_TRADE"
  | "OPPORTUNITY_ENGINE"
  | "STRATEGY_LAB"
  | "MANUAL";

export type IndiaSignalStrategy =
  | "RANGE_EXPANSION"
  | "MOMENTUM"
  | "VOLUME_BREAKOUT"
  | "OI_BUILDUP"
  | "PCR_EXTREME"
  | "IV_SPIKE"
  | "LIQUIDITY_EDGE"
  | "MAX_PAIN_GRAVITY"
  | "OPENING_BREAKOUT"
  | "SUPER_CONFLUENCE"
  | "FNO_TREND_14COND"
  | "MSB"
  | "GAMMA_BLAST"
  | "HERO_ZERO"
  | "INDICES_SCALP"
  | "HIGHLY_MOMENTUM"
  | "HIGHLY_SCALPING"
  | "HIGHLY_POTENTIAL"
  | "AI_MULTI_FACTOR"
  | "CUSTOM";

export type InstrumentType = "INDEX" | "STOCK" | "OPTION" | "FUTURE";

export type SignalAction = "BUY" | "SELL" | "WAIT" | "NO_TRADE";

export type SignalGrade = "S" | "A" | "B" | "C" | "D" | "F";

export type SignalStatus =
  | "ACTIVE"         // Signal is live and within its validity window
  | "PAPER_EXECUTED" // Paper trade opened
  | "TP1_HIT"        // First target reached
  | "TP2_HIT"        // Second target reached
  | "TP3_HIT"        // Third target reached
  | "SL_HIT"         // Stop loss triggered
  | "EXPIRED"        // Validity window elapsed
  | "INVALIDATED"    // Structure invalidated before entry
  | "ABSTAINED";     // Engine generated but rejected (reason documented)

export type MarketRegime =
  | "TRENDING_BULLISH"
  | "TRENDING_BEARISH"
  | "RANGE_BOUND"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "TRANSITION"
  | "UNKNOWN";

// ── Canonical Signal Envelope ─────────────────────────────────────────────────

/**
 * UnifiedIndiaSignal — one canonical envelope for every Indian market signal.
 *
 * Fields follow the principle of explicit nullability: null means "not available"
 * (e.g. no OI for equities), undefined means "not applicable for this signal type".
 */
export interface UnifiedIndiaSignal {
  // ── Identity ──────────────────────────────────────────────────────────────
  /** Canonical signal ID (UUID). Stable across retries / re-evaluations. */
  id: string;
  /** Deduplication key — same instrument+direction+timeframe within 30min window. */
  correlationId: string;
  /** UTC ISO-8601 timestamp when signal was generated. */
  generatedAt: string;
  /** UTC ISO-8601 timestamp when signal expires. */
  expiresAt: string | null;

  // ── Instrument ────────────────────────────────────────────────────────────
  symbol: string;
  exchange: "NSE" | "NFO" | "BSE" | "BFO";
  instrumentType: InstrumentType;
  displayName: string;

  // ── Signal Classification ─────────────────────────────────────────────────
  action: SignalAction;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  signalFamily: IndiaSignalFamily;
  strategy: IndiaSignalStrategy;
  /** Human-readable source attribution — never just "technical". */
  sourceAttribution: string;
  timeframe: string;

  // ── Price Levels ──────────────────────────────────────────────────────────
  entry: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  riskReward: number | null;

  // ── Quality Scores ────────────────────────────────────────────────────────
  confidence: number;                    // 0–1
  grade: SignalGrade;
  /** Calibrated win probability (0–1). Not assumed = confidence. */
  winProbability: number | null;
  /** Expected value estimate in R-multiples. */
  expectedValue: number | null;
  /** Overall signal quality score (0–100). */
  qualityScore: number;

  // ── Data Quality ──────────────────────────────────────────────────────────
  dataQualityScore: number;              // 0–100
  dataProvider: ProviderId | null;
  dataObservationId: string | null;

  // ── Market Context ────────────────────────────────────────────────────────
  regime: MarketRegime;
  niftyLevel: number | null;
  vixLevel: number | null;

  // ── Contextual Confirmations ──────────────────────────────────────────────
  volumeConfirmation: boolean | null;
  oiConfirmation: boolean | null;
  mtfAlignment: boolean | null;
  trendAlignment: boolean | null;

  // ── Options Context (F&O signals only) ───────────────────────────────────
  optionContext?: {
    underlying: string;
    expiry: string;
    strike: number;
    optionType: "CE" | "PE";
    contractSymbol: string;
    lotSize: number;
    spotAtSignal: number;
    oiAtSignal: number | null;
    ivAtSignal: number | null;
    pcr: number | null;
  };

  // ── Status ────────────────────────────────────────────────────────────────
  status: SignalStatus;
  rejectionReason: string | null;
  abstentionReason: string | null;

  // ── Outcome (populated after resolution) ─────────────────────────────────
  outcome?: {
    entryFill: number | null;
    mfe: number | null;
    mae: number | null;
    exitPrice: number | null;
    pnlR: number | null;
    pnlPct: number | null;
    exitReason: string | null;
    resolvedAt: string | null;
  };
}

// ── Opportunity Cluster ───────────────────────────────────────────────────────

/**
 * OpportunityCluster groups multiple signals that describe the same underlying
 * market opportunity. This prevents the same opportunity from appearing as
 * N independent entries in the signal feed.
 *
 * Example: NIFTY LONG opportunity confirmed by:
 *   - AI Signal (AI_MULTI_FACTOR)
 *   - F&O Scanner (MOMENTUM + OI_BUILDUP)
 *   - FnO Trend (FNO_TREND_14COND)
 *   = 1 cluster with 4 confirmations
 */
export interface OpportunityCluster {
  clusterId: string;
  correlationId: string;
  /** Primary signal (highest quality score). */
  primarySignal: UnifiedIndiaSignal;
  /** All confirming signals including the primary. */
  allSignals: UnifiedIndiaSignal[];
  /** Number of INDEPENDENT signal families that confirm this opportunity. */
  independentConfirmations: number;
  /** Families represented in this cluster. */
  confirmingFamilies: IndiaSignalFamily[];
  /** Cluster-level quality score (weighted average). */
  clusterQuality: number;
  /** Cluster-level confidence (weighted average). */
  clusterConfidence: number;
  /** Cluster-level grade (best grade of any confirming signal). */
  grade: SignalGrade;
  createdAt: string;
}

// ── Signal Center Response ────────────────────────────────────────────────────

export interface IndiaSignalCenterResponse {
  /** UTC ISO-8601 timestamp of this snapshot. */
  snapshotAt: string;
  /** Current market session status. */
  marketOpen: boolean;
  /** Current market regime. */
  regime: MarketRegime;

  // Market context
  niftyLevel: number | null;
  niftyChangePct: number | null;
  bankNiftyLevel: number | null;
  vixLevel: number | null;
  breadthBullish: number | null;   // 0–1

  // Top opportunities (clustered, deduplicated)
  topOpportunities: OpportunityCluster[];

  // All signals (flat, before clustering)
  allSignals: UnifiedIndiaSignal[];

  // Active clusters
  clusters: OpportunityCluster[];

  // Rejected signals (with reasons)
  rejected: UnifiedIndiaSignal[];

  // Signal counts
  stats: {
    totalCandidates: number;
    generated: number;
    approved: number;
    rejected: number;
    abstained: number;
    clustered: number;
    paperExecuted: number;
  };

  // Provider health summary
  dataProviders: {
    providerId: string;
    available: boolean;
    latencyMs: number | null;
  }[];
}

// ── Signal Family Metadata ────────────────────────────────────────────────────

export interface SignalFamilyMetadata {
  family: IndiaSignalFamily;
  displayName: string;
  description: string;
  apiRoute: string;
  workerJob: string | null;
  timeframes: string[];
  requiresOI: boolean;
  requiresOptionChain: boolean;
}

export const INDIA_SIGNAL_FAMILY_REGISTRY: SignalFamilyMetadata[] = [
  {
    family: "AI_SIGNAL",
    displayName: "AI Signals",
    description: "10+ factor AI engine combining SMA, RSI, momentum, PCR, ATM IV, OI delta, max-pain",
    apiRoute: "/api/in/ai-signals",
    workerJob: "india-auto-trader",
    timeframes: ["1d", "1h", "15m"],
    requiresOI: true,
    requiresOptionChain: true,
  },
  {
    family: "DAILY_PICK",
    displayName: "Daily Picks",
    description: "5 buckets: INDICES_SCALP, OPENING_BREAKOUT, HIGHLY_MOMENTUM, HIGHLY_SCALPING, HIGHLY_POTENTIAL",
    apiRoute: "/api/in/daily-picks",
    workerJob: "india-daily-picks",
    timeframes: ["1d"],
    requiresOI: true,
    requiresOptionChain: true,
  },
  {
    family: "FNO_SCANNER",
    displayName: "F&O Scanner",
    description: "6 scanner types: momentum, oi-buildup, pcr, iv-spike, volume-breakout, range-expansion",
    apiRoute: "/api/in/signals",
    workerJob: "india-scanner",
    timeframes: ["5m", "15m"],
    requiresOI: true,
    requiresOptionChain: false,
  },
  {
    family: "FNO_TREND",
    displayName: "F&O Trend Scanner",
    description: "14-condition Chartink-port bullish and bearish trend scanner",
    apiRoute: "/api/in/fno-bullish-trend",
    workerJob: "india-fno-trend-track",
    timeframes: ["1d"],
    requiresOI: true,
    requiresOptionChain: false,
  },
  {
    family: "MSB",
    displayName: "MSB Signals",
    description: "Market Structure Break signals",
    apiRoute: "/api/in/msb-signals",
    workerJob: null,
    timeframes: ["1h", "15m", "5m"],
    requiresOI: false,
    requiresOptionChain: false,
  },
  {
    family: "SCALPER",
    displayName: "India Scalper",
    description: "9 F&O strategies: UT Bot, HMA, SMC BOS/CHoCH, EMA stack + Super Confluence",
    apiRoute: "/api/in/scalper/signals",
    workerJob: "india-scalper",
    timeframes: ["1m", "3m", "5m"],
    requiresOI: true,
    requiresOptionChain: false,
  },
  {
    family: "EXPIRY_TRADE",
    displayName: "Expiry Trades",
    description: "Gamma Blast (ATM options near expiry) and Hero Zero (deep OTM lottery)",
    apiRoute: "/api/in/expiry-trades",
    workerJob: null,
    timeframes: ["expiry-day"],
    requiresOI: true,
    requiresOptionChain: true,
  },
  {
    family: "OPPORTUNITY_ENGINE",
    displayName: "Opportunity Engine",
    description: "12-stage validation pipeline; creates paper trades from approved signals",
    apiRoute: "/api/in/opportunity-engine",
    workerJob: "india-auto-trader",
    timeframes: ["all"],
    requiresOI: true,
    requiresOptionChain: true,
  },
];
