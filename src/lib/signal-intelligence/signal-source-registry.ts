/**
 * Signal Source Registry — Phase 1
 *
 * Canonical registry of every signal source in the AlphaForge system.
 * This registry enforces the strict taxonomy that prevents generic `technical`
 * or `fallback` signals from contaminating strategy leaderboards.
 *
 * Rules:
 *   1. Every signal source must be registered here before use.
 *   2. Only OFFICIAL_INDIA_STRATEGY_IDS sources are leaderboard-eligible.
 *   3. TECHNICAL_BASELINE signals are tracked separately — never in strategy metrics.
 *   4. UNKNOWN sourceType is an ERROR and must be investigated.
 *   5. Adding a new strategy requires updating OFFICIAL_INDIA_STRATEGY_IDS AND
 *      this registry AND the corresponding ground truth definition.
 */

import type {
  SignalSourceRegistryEntry,
  SignalSourceType,
  SignalReportingBucket,
} from "./types";
import { isOfficialIndiaStrategy } from "./types";

// ─── Registry ────────────────────────────────────────────────────────────────

const REGISTRY_ENTRIES: SignalSourceRegistryEntry[] = [
  // ── Official India F&O Strategies ────────────────────────────────────────
  {
    sourceId: "RANGE_EXPANSION",
    sourceName: "Range Expansion (WR8)",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "WR8 volatility expansion with SMA 20>50>200 stack, vol ≥ 1.5×, upper-half close. " +
      "Sourced from NSE scanner engine. DO NOT mix with generic technical breakout.",
  },
  {
    sourceId: "MOMENTUM",
    sourceName: "Momentum",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "Top F&O movers ranked by absolute % intraday change. Angel One primary, Yahoo fallback. " +
      "Not a generic RSI/momentum indicator — specifically sorted F&O segment movers.",
  },
  {
    sourceId: "VOLUME_BREAKOUT",
    sourceName: "Volume Breakout",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "Vol ≥ 1.5× 20-day average AND close in top quartile of bar range. " +
      "Requires both volume AND price confirmation.",
  },
  {
    sourceId: "OI_BUILDUP",
    sourceName: "OI Build-up",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "OI delta × price direction → LONG_BUILDUP / SHORT_BUILDUP / LONG_UNWINDING / SHORT_COVERING. " +
      "Angel One primary (true OI), NSE chain fallback.",
  },
  {
    sourceId: "PCR_EXTREME",
    sourceName: "PCR Extreme",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "Contrarian PCR extreme (PCR > 1.3 = excessive bearish, possible mean-reversion long; " +
      "PCR < 0.7 = excessive bullish, possible mean-reversion short). Index focus.",
  },
  {
    sourceId: "IV_SPIKE",
    sourceName: "IV Spike",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "IV spike / crush relative to recent ATM IV baseline. Pairs with event risk calendar. " +
      "Not a generic Bollinger/volatility breakout.",
  },
  {
    sourceId: "LIQUIDITY_EDGE",
    sourceName: "India Liquidity Edge",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "Port of India Liquidity Edge Pine indicator. 5-factor option-chain confluence: " +
      "PCR side, max-pain side, OI-wall proximity, ΔPE-ΔCE, intraday trend. " +
      "Fires only when net confluence ≥ 2.",
  },
  {
    sourceId: "MAX_PAIN_GRAVITY",
    sourceName: "Max-Pain Gravity",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "Mean-reversion fade toward max-pain strike when spot drifts > 0.4% beyond it. " +
      "Boosted by CE/PE wall confirmation and PCR skew alignment. " +
      "Max pain is contextual evidence — NOT a deterministic price target.",
  },
  {
    sourceId: "OPENING_BREAKOUT",
    sourceName: "Opening Breakout (ORB)",
    sourceType: "STRATEGY",
    reportingBucket: "OFFICIAL_STRATEGIES",
    active: true,
    leaderboardEligible: true,
    mlEvaluationTarget: true,
    version: "1.0.0",
    notes:
      "First 5-min candle (09:15–09:19:59 IST) breakout with retest entry. " +
      "Requires: breakout close, retest hold, PCR/OI/max-pain confirmation. " +
      "ATM/1-strike ITM only. Wide gaps reduce confidence. Sub-0.1% ranges skipped.",
  },

  // ── Scanner Sources ──────────────────────────────────────────────────────
  {
    sourceId: "SCANNER_HIT",
    sourceName: "F&O Scanner Hit",
    sourceType: "SCANNER",
    reportingBucket: "SCANNER",
    active: true,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "1.0.0",
    notes:
      "Manual paper trade opened from the F&O Scanner board. " +
      "NOT an official strategy signal — tracked separately as SCANNER source. " +
      "MUST NOT appear in strategy leaderboard precision/recall metrics.",
  },
  {
    sourceId: "FNO_TREND",
    sourceName: "FnO Trend Scanner",
    sourceType: "SCANNER",
    reportingBucket: "SCANNER",
    active: true,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "1.0.0",
    notes:
      "14-condition Chartink-equivalent bullish/bearish trend screener " +
      "(MA+ADX+MACD). Daily timeframe, not an intraday strategy.",
  },

  // ── ML Sources ───────────────────────────────────────────────────────────
  {
    sourceId: "ML_REGIME",
    sourceName: "ML Market Regime",
    sourceType: "ML",
    reportingBucket: "ML",
    active: true,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "1.0.0",
    notes:
      "XGBoost market regime classifier. Used as a contextual feature for " +
      "strategy evaluation, not as a standalone entry signal.",
  },
  {
    sourceId: "ML_STOCK_RANKER",
    sourceName: "ML Stock Ranker",
    sourceType: "ML",
    reportingBucket: "ML",
    active: true,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "1.0.0",
    notes:
      "LightGBM stock outperformance ranker. Provides confidence boost to strategy " +
      "signals when the stock appears in top-20. NOT a standalone signal source.",
  },

  // ── Manual Sources ───────────────────────────────────────────────────────
  {
    sourceId: "DAILY_PICK",
    sourceName: "Daily Pick (Manual)",
    sourceType: "MANUAL",
    reportingBucket: "MANUAL",
    active: true,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "1.0.0",
    notes:
      "Paper trade opened manually from the Daily Picks board. " +
      "Evaluated separately as MANUAL source. NOT in strategy leaderboard.",
  },
  {
    sourceId: "AI_SIGNAL",
    sourceName: "AI Signal (Manual)",
    sourceType: "MANUAL",
    reportingBucket: "MANUAL",
    active: true,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "1.0.0",
    notes:
      "Paper trade opened manually from the AI Signals board. " +
      "This is a MANUAL source — the AI Signals engine produces a multi-confluence " +
      "output that is reviewed and acted upon by the user. NOT in strategy leaderboard. " +
      "IMPORTANT: AI_SIGNAL must NEVER be classified as a STRATEGY or TECHNICAL_BASELINE.",
  },

  // ── Technical Baseline ───────────────────────────────────────────────────
  {
    sourceId: "TECHNICAL_BASELINE",
    sourceName: "Technical Baseline",
    sourceType: "TECHNICAL_BASELINE",
    reportingBucket: "BASELINE",
    active: false,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "1.0.0",
    notes:
      "RESEARCH / BASELINE ONLY. Generic technical indicators used as a performance " +
      "baseline for strategy evaluation. MUST NEVER be used for live or paper signals. " +
      "Only valid in RESEARCH execution mode.",
  },

  // ── Legacy Sources ───────────────────────────────────────────────────────
  {
    sourceId: "LEGACY",
    sourceName: "Legacy Signal",
    sourceType: "LEGACY",
    reportingBucket: "FALLBACK",
    active: false,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "0.0.0",
    notes:
      "Pre-taxonomy signals. Audit trail only. Must be reclassified during " +
      "the next signal quality review.",
  },

  // ── Unknown (ERROR) ──────────────────────────────────────────────────────
  {
    sourceId: "UNKNOWN",
    sourceName: "Unknown Source",
    sourceType: "UNKNOWN",
    reportingBucket: "UNKNOWN",
    active: false,
    leaderboardEligible: false,
    mlEvaluationTarget: false,
    version: "0.0.0",
    notes:
      "ERROR STATE. Any signal with this source ID must be investigated immediately. " +
      "MUST NOT appear in any production report other than the error bucket.",
  },
];

// ─── Registry Class ───────────────────────────────────────────────────────────

class SignalSourceRegistryImpl {
  private readonly entries: Map<string, SignalSourceRegistryEntry>;

  constructor(entries: SignalSourceRegistryEntry[]) {
    this.entries = new Map(entries.map((e) => [e.sourceId, e]));
  }

  /**
   * Look up a registry entry by source ID.
   * Returns the UNKNOWN entry if the ID is not found (never throws).
   */
  get(sourceId: string): SignalSourceRegistryEntry {
    return this.entries.get(sourceId) ?? this.entries.get("UNKNOWN")!;
  }

  /**
   * Classify a source ID into its reporting bucket.
   * Returns UNKNOWN (error bucket) for unrecognised source IDs.
   */
  classifyBucket(sourceId: string): SignalReportingBucket {
    return this.get(sourceId).reportingBucket;
  }

  /**
   * Return the SignalSourceType for a source ID.
   * Returns UNKNOWN for unrecognised IDs.
   */
  getSourceType(sourceId: string): SignalSourceType {
    return this.get(sourceId).sourceType;
  }

  /**
   * Whether a source ID is eligible to appear on the strategy leaderboard.
   * Only returns true for official India F&O strategies.
   */
  isLeaderboardEligible(sourceId: string): boolean {
    return this.get(sourceId).leaderboardEligible;
  }

  /**
   * Whether ML contribution should be independently measured for this source.
   */
  isMlEvaluationTarget(sourceId: string): boolean {
    return this.get(sourceId).mlEvaluationTarget;
  }

  /**
   * Validate a source ID and return a classification result.
   * Errors are surfaced explicitly so callers can log them.
   */
  validate(sourceId: string): {
    valid: boolean;
    sourceType: SignalSourceType;
    bucket: SignalReportingBucket;
    leaderboardEligible: boolean;
    error: string | null;
  } {
    const entry = this.entries.get(sourceId);
    if (!entry) {
      return {
        valid: false,
        sourceType: "UNKNOWN",
        bucket: "UNKNOWN",
        leaderboardEligible: false,
        error: `Source ID "${sourceId}" is not registered. It will appear in the UNKNOWN error bucket.`,
      };
    }
    if (entry.sourceType === "UNKNOWN") {
      return {
        valid: false,
        sourceType: "UNKNOWN",
        bucket: "UNKNOWN",
        leaderboardEligible: false,
        error: `Source ID "${sourceId}" is classified as UNKNOWN — this is an error state requiring investigation.`,
      };
    }
    if (!entry.active) {
      return {
        valid: false,
        sourceType: entry.sourceType,
        bucket: entry.reportingBucket,
        leaderboardEligible: false,
        error: `Source ID "${sourceId}" is registered but marked inactive. Only allowed in LEGACY/RESEARCH mode.`,
      };
    }
    return {
      valid: true,
      sourceType: entry.sourceType,
      bucket: entry.reportingBucket,
      leaderboardEligible: entry.leaderboardEligible,
      error: null,
    };
  }

  /**
   * Classify the source string from a PaperTrade.source field.
   * PaperTrade.source format:
   *   India: "in:<strategyId>:<timeframe>" → strategyId
   *   Crypto: "<strategyId>:<timeframe>" → strategyId
   */
  classifyPaperTradeSource(source: string): {
    sourceId: string;
    sourceType: SignalSourceType;
    bucket: SignalReportingBucket;
    isIndia: boolean;
    strategyId: string;
    timeframe: string;
  } {
    const isIndia = source.startsWith("in:");
    const parts = isIndia ? source.split(":").slice(1) : source.split(":");
    const strategyId = parts[0] ?? "UNKNOWN";
    const timeframe = parts[1] ?? "1d";

    const entry = this.entries.get(strategyId);
    if (!entry) {
      return {
        sourceId: strategyId,
        sourceType: "UNKNOWN",
        bucket: "UNKNOWN",
        isIndia,
        strategyId,
        timeframe,
      };
    }

    return {
      sourceId: strategyId,
      sourceType: entry.sourceType,
      bucket: entry.reportingBucket,
      isIndia,
      strategyId,
      timeframe,
    };
  }

  /**
   * Detect whether a source ID represents a generic `technical` signal
   * that should NOT be silently counted as a strategy signal.
   *
   * This is the core check that prevents generic technical signal masking
   * per Phase 2 requirements.
   */
  isGenericTechnical(sourceId: string): boolean {
    const GENERIC_TECHNICAL_IDS = new Set([
      "technical",
      "generic",
      "fallback",
      "baseline",
      "heuristic",
      "TECHNICAL",
      "GENERIC",
      "FALLBACK",
      "BASELINE",
      "HEURISTIC",
      "TECHNICAL_BASELINE",
    ]);
    if (GENERIC_TECHNICAL_IDS.has(sourceId)) return true;
    // Check if a registered entry has TECHNICAL_BASELINE type
    const entry = this.entries.get(sourceId);
    return entry?.sourceType === "TECHNICAL_BASELINE";
  }

  /**
   * Determine where a source ID's signals should flow.
   * Returns "PRODUCTION" for active strategy/scanner sources.
   * Returns "RESEARCH_ONLY" for baseline/research sources.
   * Returns "ERROR_INVESTIGATE" for UNKNOWN sources.
   */
  getFlowDestination(
    sourceId: string,
  ): "PRODUCTION" | "RESEARCH_ONLY" | "ERROR_INVESTIGATE" {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.sourceType === "UNKNOWN") return "ERROR_INVESTIGATE";
    if (
      entry.sourceType === "TECHNICAL_BASELINE" ||
      entry.sourceType === "RESEARCH"
    )
      return "RESEARCH_ONLY";
    if (!entry.active) return "RESEARCH_ONLY";
    return "PRODUCTION";
  }

  /** All registered entries in alphabetical order */
  all(): SignalSourceRegistryEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId),
    );
  }

  /** All entries in the OFFICIAL_STRATEGIES bucket */
  officialStrategies(): SignalSourceRegistryEntry[] {
    return this.all().filter(
      (e) => e.reportingBucket === "OFFICIAL_STRATEGIES",
    );
  }
}

/**
 * Singleton registry instance. Import this in any module that needs
 * to classify or validate signal sources.
 */
export const SignalSourceRegistry = new SignalSourceRegistryImpl(
  REGISTRY_ENTRIES,
);

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Guard: assert that a source ID is an official strategy.
 * Throws (or returns false) when the ID is generic/unknown.
 *
 * Use this before counting a signal in strategy-level metrics.
 */
export function assertOfficialStrategy(sourceId: string): void {
  if (!isOfficialIndiaStrategy(sourceId)) {
    throw new Error(
      `[SignalSourceRegistry] "${sourceId}" is not an official India F&O strategy. ` +
        `It must NOT be counted in strategy leaderboard, recall, or precision metrics. ` +
        `Reporting bucket: ${SignalSourceRegistry.classifyBucket(sourceId)}`,
    );
  }
}

/**
 * Safe version of assertOfficialStrategy — returns boolean instead of throwing.
 */
export function isOfficialStrategySource(sourceId: string): boolean {
  return (
    isOfficialIndiaStrategy(sourceId) &&
    SignalSourceRegistry.getSourceType(sourceId) === "STRATEGY"
  );
}

/**
 * Determine the `SignalReportingBucket` for a given `PaperTrade.source` string.
 * This is used in the signal quality engine to correctly partition metrics
 * by reporting bucket.
 */
export function getPaperTradeReportingBucket(
  source: string,
): SignalReportingBucket {
  const { bucket } = SignalSourceRegistry.classifyPaperTradeSource(source);
  return bucket;
}
