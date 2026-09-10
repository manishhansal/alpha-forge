/**
 * Strategy-Specific, Regime-Aware Signal Scoring
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Replaces the single universal confluence formula (flagged in
 * `reports/INDIA_SIGNAL_FORENSIC_AUDIT.md` §15 as scoring every strategy with
 * one weight vector) with PER-STRATEGY, PER-REGIME scoring.
 *
 * Two layers:
 *   1. `StrategyProfile` — a static spec per strategy: horizon, mechanisms, and
 *      the RELEVANCE of each feature (required / supporting / irrelevant /
 *      adverse), suitable/unsuitable regimes, time-of-day windows, instruments,
 *      and derivatives/liquidity requirements. The feature relevances here are
 *      PRIORS — starting beliefs, NOT final weights.
 *   2. `StrategyFeatureImportance` — weights LEARNED from OOS data per
 *      `strategy × regime × timeframe` (permutation importance + mutual
 *      information + conditional IC + conditional win-rate/expectancy). The
 *      learned weights are blended over the profile priors (shrunk by sample
 *      size), so a feature that matters for ORB does NOT automatically get the
 *      same weight for mean-reversion.
 *
 * Plus the regime-aware selector pipeline:
 *   Regime → Candidate strategies → Suitability → (Signal → Probability →
 *   Quality → EV → Grade elsewhere), with poor-in-regime strategies suppressed
 *   via `strategyHealthScore` + `strategyRegimeMatrix`.
 *
 * All inference is PURE and DETERMINISTIC. Training is deterministic given data.
 * I/O-free; no `server-only` guard so it is unit-testable + worker-usable.
 */

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Vocabulary
// ═══════════════════════════════════════════════════════════════════════════

export const STRATEGY_REGIME_SCORING_VERSION = "srs-1.0.0";

/** The Indian strategies currently implemented (scanners + buckets + AI). */
export const INDIA_STRATEGIES = [
  "OPENING_BREAKOUT", // ORB
  "MOMENTUM",         // trend continuation
  "VOLUME_BREAKOUT",
  "RANGE_EXPANSION",
  "OI_BUILDUP",
  "PCR_EXTREME",      // mean-reversion (options)
  "IV_SPIKE",
  "LIQUIDITY_EDGE",
  "MAX_PAIN_GRAVITY", // mean-reversion (options)
  "AI_SIGNAL",        // multi-factor
  "DAILY_PICK",
] as const;

export type IndiaStrategy = (typeof INDIA_STRATEGIES)[number];

export type SrsRegime = "BULL_TREND" | "BEAR_TREND" | "RANGE" | "HIGH_VOL" | "LOW_VOL" | "UNKNOWN";
export type SrsTimeframe = "SCALP" | "INTRADAY" | "SWING";

/** The feature vocabulary that strategies score over. */
export const SRS_FEATURES = [
  "openingRangeStructure",
  "breakoutVolume",
  "vwapAlignment",
  "vwapDistance",
  "marketRegimeFit",
  "adx",
  "trendStack",
  "momentum",
  "volume",
  "rsi",
  "volatilityExpansion",
  "breakoutScore",
  "underlyingTrend",
  "oiChange",
  "oiConfirmation",
  "pcr",
  "ivRegime",
  "maxPain",
  "liquidity",
  "spread",
  "relativeStrength",
] as const;

export type SrsFeature = (typeof SRS_FEATURES)[number];

/**
 * Prior relevance of a feature to a strategy. These map to prior weights but are
 * NOT final — learned OOS importance overrides them when data is sufficient.
 *   REQUIRED  — core to the setup (high prior weight)
 *   SUPPORTING— confirms but not core (medium prior)
 *   IRRELEVANT— no expected edge (zero prior)
 *   ADVERSE   — its presence argues AGAINST the setup (negative prior)
 */
export type FeatureRelevance = "REQUIRED" | "SUPPORTING" | "IRRELEVANT" | "ADVERSE";

/** Prior weight magnitude for each relevance class. */
export const RELEVANCE_PRIOR: Record<FeatureRelevance, number> = {
  REQUIRED: 1.0,
  SUPPORTING: 0.4,
  IRRELEVANT: 0.0,
  ADVERSE: -0.6,
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — StrategyProfile
// ═══════════════════════════════════════════════════════════════════════════

export type Horizon = "SCALP" | "INTRADAY" | "SWING";

export interface StrategyProfile {
  strategyId: IndiaStrategy;
  label: string;
  family: "BREAKOUT" | "TREND" | "MEAN_REVERSION" | "OPTIONS_FLOW" | "MULTI_FACTOR";
  horizon: Horizon;
  /** Expected holding time in minutes (typical). */
  expectedHoldingMinutes: number;
  entryMechanism: string;
  stopMechanism: string;
  targetMechanism: string;

  /** Feature → prior relevance. Missing features default to IRRELEVANT. */
  featureRelevance: Partial<Record<SrsFeature, FeatureRelevance>>;

  suitableRegimes: SrsRegime[];
  unsuitableRegimes: SrsRegime[];
  /** Best time-of-day windows (IST minutes from 09:15 open). */
  bestTimeWindows: Array<{ startMin: number; endMin: number; label: string }>;
  suitableInstruments: Array<"INDEX_OPTION" | "STOCK_OPTION" | "FUT" | "EQUITY">;
  /** Does the strategy require live derivatives (OI/PCR/chain) data? */
  requiresDerivatives: boolean;
  /** Minimum liquidity tier the strategy needs. */
  liquidityRequirement: "STANDARD" | "HIGH" | "VERY_HIGH";
}

/** Effective prior weights for a strategy's features (from relevance classes). */
export function priorWeights(profile: StrategyProfile): Partial<Record<SrsFeature, number>> {
  const out: Partial<Record<SrsFeature, number>> = {};
  for (const f of SRS_FEATURES) {
    const rel = profile.featureRelevance[f] ?? "IRRELEVANT";
    out[f] = RELEVANCE_PRIOR[rel];
  }
  return out;
}

// ─── The per-strategy profiles (feature relevances are PRIORS) ────────────────

const OPEN = 0;
const T_0930 = 15;   // 09:30
const T_1000 = 45;   // 10:00
const T_1400 = 285;  // 14:00
const T_1500 = 345;  // 15:00

export const STRATEGY_PROFILES: Record<IndiaStrategy, StrategyProfile> = {
  OPENING_BREAKOUT: {
    strategyId: "OPENING_BREAKOUT",
    label: "Opening Range Breakout (ORB)",
    family: "BREAKOUT",
    horizon: "SCALP",
    expectedHoldingMinutes: 30,
    entryMechanism: "5-min close beyond opening-range high/low, entered on retest",
    stopMechanism: "opposite side of the opening range",
    targetMechanism: "2R measured move from range",
    featureRelevance: {
      openingRangeStructure: "REQUIRED",
      breakoutVolume: "REQUIRED",
      vwapAlignment: "REQUIRED",
      marketRegimeFit: "REQUIRED",
      oiConfirmation: "SUPPORTING",
      oiChange: "SUPPORTING",
      volume: "SUPPORTING",
      rsi: "SUPPORTING",         // low/medium — supporting only
      relativeStrength: "SUPPORTING",
      breakoutScore: "SUPPORTING",
      volatilityExpansion: "IRRELEVANT",
      maxPain: "IRRELEVANT",
    },
    suitableRegimes: ["BULL_TREND", "BEAR_TREND", "HIGH_VOL"],
    unsuitableRegimes: ["RANGE", "LOW_VOL"],
    bestTimeWindows: [{ startMin: T_0930, endMin: T_1000, label: "09:30–10:00 IST" }],
    suitableInstruments: ["INDEX_OPTION", "FUT"],
    requiresDerivatives: false,
    liquidityRequirement: "HIGH",
  },

  MOMENTUM: {
    strategyId: "MOMENTUM",
    label: "Trend Continuation / Momentum",
    family: "TREND",
    horizon: "INTRADAY",
    expectedHoldingMinutes: 4 * 60,
    entryMechanism: "pullback/continuation in a strong trend (top-decile intraday mover)",
    stopMechanism: "ATR-based below structure",
    targetMechanism: "trailing / measured trend extension",
    featureRelevance: {
      adx: "REQUIRED",
      trendStack: "REQUIRED",
      momentum: "REQUIRED",
      volume: "REQUIRED",
      vwapAlignment: "REQUIRED",
      relativeStrength: "SUPPORTING",
      rsi: "SUPPORTING",         // supporting, not core
      marketRegimeFit: "REQUIRED",
      breakoutScore: "SUPPORTING",
      pcr: "IRRELEVANT",
      maxPain: "IRRELEVANT",
      // excessive mean-reversion signal argues against a continuation
      vwapDistance: "ADVERSE",
    },
    suitableRegimes: ["BULL_TREND", "BEAR_TREND"],
    unsuitableRegimes: ["RANGE", "HIGH_VOL"],
    bestTimeWindows: [
      { startMin: T_0930, endMin: T_1000, label: "09:30–10:00 IST" },
      { startMin: T_1400, endMin: T_1500, label: "14:00–15:00 IST" },
    ],
    suitableInstruments: ["FUT", "EQUITY", "STOCK_OPTION"],
    requiresDerivatives: false,
    liquidityRequirement: "STANDARD",
  },

  VOLUME_BREAKOUT: {
    strategyId: "VOLUME_BREAKOUT",
    label: "Volume Breakout",
    family: "BREAKOUT",
    horizon: "INTRADAY",
    expectedHoldingMinutes: 4 * 60,
    entryMechanism: "close in top/bottom quartile of bar with volume ≥ 1.5× 20d avg",
    stopMechanism: "ATR-based below breakout base",
    targetMechanism: "measured move",
    featureRelevance: {
      breakoutVolume: "REQUIRED",
      volume: "REQUIRED",
      breakoutScore: "REQUIRED",
      marketRegimeFit: "REQUIRED",
      vwapAlignment: "SUPPORTING",
      momentum: "SUPPORTING",
      adx: "SUPPORTING",
      rsi: "IRRELEVANT",
      pcr: "IRRELEVANT",
      vwapDistance: "ADVERSE",
    },
    suitableRegimes: ["BULL_TREND", "BEAR_TREND"],
    unsuitableRegimes: ["RANGE"],
    bestTimeWindows: [{ startMin: T_0930, endMin: T_1400, label: "09:30–14:00 IST" }],
    suitableInstruments: ["FUT", "EQUITY"],
    requiresDerivatives: false,
    liquidityRequirement: "STANDARD",
  },

  RANGE_EXPANSION: {
    strategyId: "RANGE_EXPANSION",
    label: "Range Expansion (WR8)",
    family: "BREAKOUT",
    horizon: "SWING",
    expectedHoldingMinutes: 24 * 60,
    entryMechanism: "widest range of last 8 sessions with SMA20>50>200 stack",
    stopMechanism: "below the expansion candle low",
    targetMechanism: "swing measured move (EOD)",
    featureRelevance: {
      breakoutScore: "REQUIRED",
      volatilityExpansion: "REQUIRED",
      trendStack: "REQUIRED",
      volume: "REQUIRED",
      marketRegimeFit: "SUPPORTING",
      momentum: "SUPPORTING",
      rsi: "IRRELEVANT",
      pcr: "IRRELEVANT",
    },
    suitableRegimes: ["BULL_TREND", "BEAR_TREND", "HIGH_VOL"],
    unsuitableRegimes: ["LOW_VOL", "RANGE"],
    bestTimeWindows: [{ startMin: OPEN, endMin: T_1500, label: "session-wide (EOD)" }],
    suitableInstruments: ["EQUITY", "FUT"],
    requiresDerivatives: false,
    liquidityRequirement: "STANDARD",
  },

  OI_BUILDUP: {
    strategyId: "OI_BUILDUP",
    label: "OI Build-up",
    family: "OPTIONS_FLOW",
    horizon: "INTRADAY",
    expectedHoldingMinutes: 4 * 60,
    entryMechanism: "price+OI aligned buildup (long/short) with ≥5% OI delta",
    stopMechanism: "ATR-based",
    targetMechanism: "session extension",
    featureRelevance: {
      oiChange: "REQUIRED",
      oiConfirmation: "REQUIRED",
      underlyingTrend: "REQUIRED",
      volume: "SUPPORTING",
      pcr: "SUPPORTING",
      marketRegimeFit: "SUPPORTING",
      liquidity: "SUPPORTING",
      rsi: "IRRELEVANT",
      maxPain: "IRRELEVANT",
    },
    suitableRegimes: ["BULL_TREND", "BEAR_TREND"],
    unsuitableRegimes: ["LOW_VOL"],
    bestTimeWindows: [{ startMin: T_0930, endMin: T_1400, label: "09:30–14:00 IST" }],
    suitableInstruments: ["FUT", "STOCK_OPTION", "INDEX_OPTION"],
    requiresDerivatives: true,
    liquidityRequirement: "HIGH",
  },

  PCR_EXTREME: {
    strategyId: "PCR_EXTREME",
    label: "PCR Extreme (mean-reversion)",
    family: "MEAN_REVERSION",
    horizon: "INTRADAY",
    expectedHoldingMinutes: 2 * 60,
    entryMechanism: "fade sentiment extreme (PCR ≥ 1.5 long / ≤ 0.7 short)",
    stopMechanism: "beyond the sentiment extreme",
    targetMechanism: "reversion to mean / VWAP",
    featureRelevance: {
      pcr: "REQUIRED",
      rsi: "REQUIRED",
      vwapDistance: "REQUIRED",
      volatilityExpansion: "REQUIRED",
      ivRegime: "SUPPORTING",
      oiChange: "SUPPORTING",
      maxPain: "SUPPORTING",
      liquidity: "SUPPORTING",
      // strong trend / breakout is the enemy of a mean-reversion fade
      trendStack: "ADVERSE",
      adx: "ADVERSE",
      breakoutScore: "ADVERSE",
      momentum: "ADVERSE",
    },
    suitableRegimes: ["RANGE", "HIGH_VOL"],
    unsuitableRegimes: ["BULL_TREND", "BEAR_TREND"],
    bestTimeWindows: [{ startMin: T_1000, endMin: T_1400, label: "10:00–14:00 IST" }],
    suitableInstruments: ["INDEX_OPTION"],
    requiresDerivatives: true,
    liquidityRequirement: "VERY_HIGH",
  },

  IV_SPIKE: {
    strategyId: "IV_SPIKE",
    label: "IV Spike",
    family: "OPTIONS_FLOW",
    horizon: "INTRADAY",
    expectedHoldingMinutes: 3 * 60,
    entryMechanism: "ATM IV ≥ 20% above 5d avg without commensurate price move",
    stopMechanism: "IV mean-reversion invalidation",
    targetMechanism: "premium capture on IV normalisation",
    featureRelevance: {
      ivRegime: "REQUIRED",
      pcr: "REQUIRED",
      oiChange: "REQUIRED",
      liquidity: "REQUIRED",
      spread: "REQUIRED",
      underlyingTrend: "SUPPORTING",
      maxPain: "SUPPORTING",
      rsi: "IRRELEVANT",
      trendStack: "IRRELEVANT",
    },
    suitableRegimes: ["HIGH_VOL", "RANGE"],
    unsuitableRegimes: ["LOW_VOL"],
    bestTimeWindows: [{ startMin: T_1000, endMin: T_1400, label: "10:00–14:00 IST" }],
    suitableInstruments: ["INDEX_OPTION", "STOCK_OPTION"],
    requiresDerivatives: true,
    liquidityRequirement: "VERY_HIGH",
  },

  LIQUIDITY_EDGE: {
    strategyId: "LIQUIDITY_EDGE",
    label: "Liquidity Edge (option confluence)",
    family: "OPTIONS_FLOW",
    horizon: "INTRADAY",
    expectedHoldingMinutes: 3 * 60,
    entryMechanism: "5-factor option-chain confluence (PCR, max-pain, OI walls, ΔOI, trend)",
    stopMechanism: "OI-wall invalidation",
    targetMechanism: "toward the dominant OI wall / max-pain",
    featureRelevance: {
      pcr: "REQUIRED",
      oiChange: "REQUIRED",
      oiConfirmation: "REQUIRED",
      liquidity: "REQUIRED",
      spread: "REQUIRED",
      maxPain: "SUPPORTING",
      underlyingTrend: "SUPPORTING",
      ivRegime: "SUPPORTING",
      rsi: "IRRELEVANT",
    },
    suitableRegimes: ["RANGE", "HIGH_VOL", "BULL_TREND", "BEAR_TREND"],
    unsuitableRegimes: ["LOW_VOL"],
    bestTimeWindows: [{ startMin: T_1000, endMin: T_1400, label: "10:00–14:00 IST" }],
    suitableInstruments: ["INDEX_OPTION"],
    requiresDerivatives: true,
    liquidityRequirement: "VERY_HIGH",
  },

  MAX_PAIN_GRAVITY: {
    strategyId: "MAX_PAIN_GRAVITY",
    label: "Max-Pain Gravity (mean-reversion)",
    family: "MEAN_REVERSION",
    horizon: "INTRADAY",
    expectedHoldingMinutes: 3 * 60,
    entryMechanism: "fade spot drift ≥ 1.5×ATR from max-pain with OI-wall + PCR confirm",
    stopMechanism: "beyond the drift extreme",
    targetMechanism: "reversion toward max-pain strike",
    featureRelevance: {
      maxPain: "REQUIRED",
      pcr: "REQUIRED",
      oiConfirmation: "REQUIRED",
      vwapDistance: "SUPPORTING",
      ivRegime: "SUPPORTING",
      liquidity: "REQUIRED",
      spread: "REQUIRED",
      // strong directional trend defeats a max-pain fade
      trendStack: "ADVERSE",
      momentum: "ADVERSE",
      breakoutScore: "ADVERSE",
    },
    suitableRegimes: ["RANGE", "LOW_VOL"],
    unsuitableRegimes: ["BULL_TREND", "BEAR_TREND", "HIGH_VOL"],
    bestTimeWindows: [{ startMin: T_1400, endMin: T_1500, label: "14:00–15:00 IST (expiry gravity)" }],
    suitableInstruments: ["INDEX_OPTION"],
    requiresDerivatives: true,
    liquidityRequirement: "VERY_HIGH",
  },

  AI_SIGNAL: {
    strategyId: "AI_SIGNAL",
    label: "AI Multi-Factor",
    family: "MULTI_FACTOR",
    horizon: "INTRADAY",
    expectedHoldingMinutes: 4 * 60,
    entryMechanism: "multi-factor composite ≥ grade C with frozen TP/SL",
    stopMechanism: "ATR-based frozen at generation",
    targetMechanism: "3-tier TP ladder",
    featureRelevance: {
      marketRegimeFit: "REQUIRED",
      trendStack: "SUPPORTING",
      momentum: "SUPPORTING",
      volume: "SUPPORTING",
      breakoutScore: "SUPPORTING",
      relativeStrength: "SUPPORTING",
      oiChange: "SUPPORTING",
      pcr: "SUPPORTING",
      rsi: "SUPPORTING",
    },
    suitableRegimes: ["BULL_TREND", "BEAR_TREND", "RANGE", "HIGH_VOL"],
    unsuitableRegimes: ["UNKNOWN"],
    bestTimeWindows: [{ startMin: T_0930, endMin: T_1400, label: "09:30–14:00 IST" }],
    suitableInstruments: ["FUT", "EQUITY", "STOCK_OPTION", "INDEX_OPTION"],
    requiresDerivatives: false,
    liquidityRequirement: "STANDARD",
  },

  DAILY_PICK: {
    strategyId: "DAILY_PICK",
    label: "Daily Pick",
    family: "MULTI_FACTOR",
    horizon: "SWING",
    expectedHoldingMinutes: 24 * 60,
    entryMechanism: "bucket score ≥ 0.5, frozen at 09:15 IST",
    stopMechanism: "frozen SL",
    targetMechanism: "frozen target (EOD)",
    featureRelevance: {
      trendStack: "SUPPORTING",
      breakoutScore: "SUPPORTING",
      momentum: "SUPPORTING",
      volume: "SUPPORTING",
      marketRegimeFit: "REQUIRED",
      relativeStrength: "SUPPORTING",
      rsi: "IRRELEVANT",
    },
    suitableRegimes: ["BULL_TREND", "BEAR_TREND", "RANGE"],
    unsuitableRegimes: ["UNKNOWN"],
    bestTimeWindows: [{ startMin: OPEN, endMin: T_1500, label: "session-wide (EOD)" }],
    suitableInstruments: ["EQUITY", "FUT"],
    requiresDerivatives: false,
    liquidityRequirement: "STANDARD",
  },
};

/** Lookup a profile (throws-safe: returns null for unknown ids). */
export function getStrategyProfile(strategyId: string): StrategyProfile | null {
  return (STRATEGY_PROFILES as Record<string, StrategyProfile>)[strategyId] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — OOS-learned feature importance (strategy × regime × timeframe)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One labelled OOS observation for feature-importance learning: the feature
 * values at signal time (each in [0,1], direction-oriented), the realized
 * cost-adjusted outcome, and the realized R. Keyed by strategy/regime/timeframe.
 */
export interface FeatureImportanceObs {
  strategyId: IndiaStrategy;
  regime: SrsRegime;
  timeframe: SrsTimeframe;
  features: Partial<Record<SrsFeature, number>>;
  label: 0 | 1;
  returnR: number;
}

/** Learned importance of ONE feature within a strategy×regime×timeframe cell. */
export interface FeatureImportanceCell {
  feature: SrsFeature;
  /** Permutation importance: OOS log-loss degradation when the feature is shuffled. */
  permutationImportance: number;
  /** Mutual information between (binned) feature and outcome. */
  mutualInformation: number;
  /** Conditional Information Coefficient: corr(feature, returnR). */
  conditionalIC: number;
  /** Win rate among the top tercile of this feature. */
  conditionalWinRate: number;
  /** Expectancy (R) among the top tercile of this feature. */
  conditionalExpectancyR: number;
  /** Blended learned weight ∈ [-1, 1] (sign follows IC). */
  learnedWeight: number;
  sampleCount: number;
}

/** Learned importance for a strategy×regime×timeframe cell. */
export interface StrategyFeatureImportance {
  key: string; // "strategy|regime|timeframe"
  strategyId: IndiaStrategy;
  regime: SrsRegime;
  timeframe: SrsTimeframe;
  sampleCount: number;
  features: Partial<Record<SrsFeature, FeatureImportanceCell>>;
  /**
   * Final per-feature weights used for scoring: a sample-shrunk blend of the
   * profile PRIOR and the LEARNED weight. Sums (of positives) not normalised
   * here — the scorer normalises.
   */
  effectiveWeights: Partial<Record<SrsFeature, number>>;
  provenance: "LEARNED_OOS" | "PRIOR_ONLY";
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number): number => clamp(x, 0, 1);
const meanOf = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = meanOf(a.slice(0, n));
  const mb = meanOf(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** Mutual information between a binned feature and a binary label (nats). */
function mutualInformation(feature: number[], labels: number[], bins = 4): number {
  const n = feature.length;
  if (n < 4) return 0;
  const px = new Array(bins).fill(0);
  const py = [0, 0];
  const pxy: number[][] = Array.from({ length: bins }, () => [0, 0]);
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor(clamp01(feature[i]!) * bins));
    const y = labels[i]!;
    px[b] += 1;
    py[y] += 1;
    pxy[b]![y] += 1;
  }
  let mi = 0;
  for (let b = 0; b < bins; b++) {
    for (let y = 0; y < 2; y++) {
      const joint = pxy[b]![y]! / n;
      if (joint <= 0) continue;
      const marg = (px[b]! / n) * (py[y]! / n);
      if (marg <= 0) continue;
      mi += joint * Math.log(joint / marg);
    }
  }
  return Math.max(0, mi);
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const clampP = (p: number): number => Math.min(1 - 1e-6, Math.max(1e-6, p));
function logLoss(preds: number[], labels: number[]): number {
  if (preds.length === 0) return Infinity;
  let s = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = clampP(preds[i]!);
    s += labels[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / preds.length;
}

/** Deterministic seeded shuffle. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (1664525 * s + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function topTercile(rows: FeatureImportanceObs[], feature: SrsFeature): FeatureImportanceObs[] {
  const withF = rows.filter((r) => r.features[feature] != null);
  if (withF.length < 3) return withF;
  const sorted = [...withF].sort((a, b) => (b.features[feature]! - a.features[feature]!));
  return sorted.slice(0, Math.max(1, Math.floor(sorted.length / 3)));
}

/**
 * Learn per-feature importance for ONE strategy×regime×timeframe cell from OOS
 * observations. Combines permutation importance (over a simple logistic of the
 * single feature), mutual information, conditional IC, and conditional
 * win-rate/expectancy into a `learnedWeight`. Deterministic (seeded).
 */
export function learnCellImportance(
  strategyId: IndiaStrategy,
  regime: SrsRegime,
  timeframe: SrsTimeframe,
  rows: FeatureImportanceObs[],
  profile: StrategyProfile,
  opts: { minSample?: number; seed?: number } = {},
): StrategyFeatureImportance {
  const minSample = opts.minSample ?? 50;
  const seed = opts.seed ?? 42;
  const key = `${strategyId}|${regime}|${timeframe}`;
  const prior = priorWeights(profile);
  const n = rows.length;
  const baseRate = n > 0 ? meanOf(rows.map((r) => r.label)) : 0.5;

  const features: Partial<Record<SrsFeature, FeatureImportanceCell>> = {};
  const effectiveWeights: Partial<Record<SrsFeature, number>> = {};
  const provenance: StrategyFeatureImportance["provenance"] = n >= minSample ? "LEARNED_OOS" : "PRIOR_ONLY";

  // sample confidence for shrinkage of learned → prior
  const sampleConfidence = n > 0 ? n / (n + minSample) : 0;

  for (const f of SRS_FEATURES) {
    const priorW = prior[f] ?? 0;
    const withF = rows.filter((r) => r.features[f] != null);
    if (withF.length < 4 || n < minSample) {
      // not enough to learn → fall back to prior
      effectiveWeights[f] = priorW;
      continue;
    }
    const fv = withF.map((r) => clamp01(r.features[f]!));
    const ys = withF.map((r) => r.label);
    const rs = withF.map((r) => r.returnR);

    // conditional IC (feature vs realized R)
    const ic = pearson(fv, rs);
    // mutual information
    const mi = mutualInformation(fv, ys);
    // permutation importance: logistic on feature vs shuffled feature
    const fitLL = logLoss(fv.map((x) => sigmoid(4 * (x - 0.5))), ys);
    const shuffled = seededShuffle(fv, seed + f.length);
    const permLL = logLoss(shuffled.map((x) => sigmoid(4 * (x - 0.5))), ys);
    const permImp = Number.isFinite(permLL) && Number.isFinite(fitLL) ? permLL - fitLL : 0;
    // conditional win rate / expectancy of the top tercile
    const top = topTercile(withF, f);
    const condWr = meanOf(top.map((r) => r.label));
    const condExp = meanOf(top.map((r) => r.returnR));

    // learned weight: sign from IC, magnitude from a blend of |IC|, MI, perm imp,
    // and top-tercile edge over base rate. Clamped to [-1,1].
    const edge = condWr - baseRate;
    const mag = clamp(0.4 * Math.abs(ic) + 0.3 * Math.min(1, mi * 4) + 0.2 * Math.max(0, permImp * 4) + 0.4 * Math.max(0, edge * 2), 0, 1);
    const sign = ic >= 0 ? 1 : -1;
    const learnedWeight = clamp(sign * mag, -1, 1);

    features[f] = {
      feature: f,
      permutationImportance: permImp,
      mutualInformation: mi,
      conditionalIC: ic,
      conditionalWinRate: condWr,
      conditionalExpectancyR: condExp,
      learnedWeight,
      sampleCount: withF.length,
    };

    // blend learned over prior, shrunk by sample confidence
    effectiveWeights[f] = clamp(sampleConfidence * learnedWeight + (1 - sampleConfidence) * priorW, -1, 1);
  }

  return { key, strategyId, regime, timeframe, sampleCount: n, features, effectiveWeights, provenance };
}

/** A learned importance model keyed by strategy|regime|timeframe. */
export interface FeatureImportanceModel {
  version: string;
  cells: Record<string, StrategyFeatureImportance>;
}

/** Train a full importance model over all cells present in the data. */
export function learnFeatureImportance(
  obs: FeatureImportanceObs[],
  opts: { minSample?: number; seed?: number } = {},
): FeatureImportanceModel {
  const byCell = new Map<string, FeatureImportanceObs[]>();
  for (const o of obs) {
    const k = `${o.strategyId}|${o.regime}|${o.timeframe}`;
    const arr = byCell.get(k);
    if (arr) arr.push(o);
    else byCell.set(k, [o]);
  }
  const cells: Record<string, StrategyFeatureImportance> = {};
  for (const [key, rows] of byCell) {
    const [strategyId, regime, timeframe] = key.split("|") as [IndiaStrategy, SrsRegime, SrsTimeframe];
    const profile = getStrategyProfile(strategyId);
    if (!profile) continue;
    cells[key] = learnCellImportance(strategyId, regime, timeframe, rows, profile, opts);
  }
  return { version: STRATEGY_REGIME_SCORING_VERSION, cells };
}

/**
 * Resolve the effective feature weights for a strategy×regime×timeframe. Falls
 * back: exact cell → strategy|regime|ANY → strategy|ANY|ANY → profile priors.
 * This is what makes scoring strategy- AND regime-specific: a feature strong for
 * ORB in a trend does NOT get the same weight for mean-reversion in a range.
 */
export function resolveFeatureWeights(
  strategyId: IndiaStrategy,
  regime: SrsRegime,
  timeframe: SrsTimeframe,
  model: FeatureImportanceModel | null,
): { weights: Partial<Record<SrsFeature, number>>; provenance: string } {
  const profile = getStrategyProfile(strategyId);
  const prior = profile ? priorWeights(profile) : {};
  if (!model) return { weights: prior, provenance: "PRIOR_ONLY" };
  const keys = [
    `${strategyId}|${regime}|${timeframe}`,
    `${strategyId}|${regime}|ANY`,
    `${strategyId}|ANY|ANY`,
  ];
  for (const k of keys) {
    const cell = model.cells[k];
    if (cell && cell.provenance === "LEARNED_OOS") return { weights: cell.effectiveWeights, provenance: `LEARNED:${k}` };
  }
  return { weights: prior, provenance: "PRIOR_ONLY" };
}

/**
 * Score a signal's features for a given strategy×regime×timeframe. Features are
 * [0,1] direction-oriented; the returned score is the weighted, sign-aware,
 * normalised confluence in [0,1]. ADVERSE (negative-weight) features push the
 * score DOWN. Deterministic.
 */
export function scoreStrategyFeatures(
  strategyId: IndiaStrategy,
  regime: SrsRegime,
  timeframe: SrsTimeframe,
  features: Partial<Record<SrsFeature, number>>,
  model: FeatureImportanceModel | null,
): { score: number; weightsUsed: Partial<Record<SrsFeature, number>>; provenance: string; coverage: number } {
  const { weights, provenance } = resolveFeatureWeights(strategyId, regime, timeframe, model);
  let num = 0;
  let denomPos = 0;
  let present = 0;
  let total = 0;
  for (const f of SRS_FEATURES) {
    const w = weights[f] ?? 0;
    if (w === 0) continue;
    total += 1;
    const v = features[f];
    if (v == null) continue; // missing → neutral (does not push either way)
    present += 1;
    num += w * clamp01(v);
    denomPos += Math.abs(w);
  }
  // Positive-weighted sum / sum of |weights|, so adverse features subtract.
  const score = denomPos > 0 ? clamp01(0.5 + (num - 0.5 * sumPositive(weights)) / (denomPos || 1)) : 0.5;
  const coverage = total > 0 ? present / total : 0;
  return { score: clamp01(score), weightsUsed: weights, provenance, coverage };
}

function sumPositive(weights: Partial<Record<SrsFeature, number>>): number {
  let s = 0;
  for (const f of SRS_FEATURES) {
    const w = weights[f] ?? 0;
    if (w > 0) s += w;
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Strategy health, alpha decay, and recommended status
// ═══════════════════════════════════════════════════════════════════════════

export type RecommendedStatus = "ACTIVE" | "CAUTION" | "SHADOW" | "DISABLED";

/** One resolved trade for a strategy (for health/decay + matrix aggregation). */
export interface StrategyTrade {
  strategyId: IndiaStrategy;
  regime: SrsRegime;
  timeframe?: SrsTimeframe;
  label: 0 | 1;      // profitable (cost-adjusted) or not
  returnR: number;   // realized R
  outcomeMs: number; // resolution time (for rolling windows)
}

/** Wilson lower bound (reused for statistically-meaningful gating). */
export function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return Math.max(0, center - margin);
}

function stdOf(a: number[]): number {
  if (a.length < 2) return 0;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function expectancyR(rs: number[]): number { return meanOf(rs); }
function profitFactorR(rs: number[]): number {
  const w = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const l = Math.abs(rs.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  return l === 0 ? (w > 0 ? Infinity : 0) : w / l;
}
function sharpeR(rs: number[]): number {
  if (rs.length < 2) return 0;
  const sd = stdOf(rs);
  return sd === 0 ? 0 : meanOf(rs) / sd;
}
function maxDrawdownR(rs: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of rs) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

export interface AlphaDecay {
  /** Recent-window expectancy minus early-window expectancy (R). Negative = decaying. */
  expectancyDelta: number;
  /** Is the deterioration statistically meaningful (not just a few losses)? */
  decaying: boolean;
  earlyN: number;
  recentN: number;
  earlyExpectancyR: number;
  recentExpectancyR: number;
}

/**
 * Detect alpha decay from a strategy's time-ordered trades. Splits into an
 * early and recent half; flags `decaying` ONLY when the recent window is
 * statistically meaningful (≥ minWindow) AND the recent expectancy is
 * materially below the early expectancy beyond sampling noise. A handful of
 * losses can NEVER flip this — that's the "statistically meaningful evidence"
 * requirement.
 */
export function detectAlphaDecay(trades: StrategyTrade[], minWindow = 30): AlphaDecay {
  const sorted = [...trades].sort((a, b) => a.outcomeMs - b.outcomeMs);
  const half = Math.floor(sorted.length / 2);
  const early = sorted.slice(0, half);
  const recent = sorted.slice(half);
  const earlyExp = expectancyR(early.map((t) => t.returnR));
  const recentExp = expectancyR(recent.map((t) => t.returnR));
  const delta = recentExp - earlyExp;
  // sampling-noise band on the recent expectancy
  const recentSd = stdOf(recent.map((t) => t.returnR));
  const se = recent.length > 0 ? recentSd / Math.sqrt(recent.length) : Infinity;
  const decaying = recent.length >= minWindow && early.length >= minWindow && delta < -Math.max(0.1, 1.96 * se);
  return {
    expectancyDelta: delta,
    decaying,
    earlyN: early.length,
    recentN: recent.length,
    earlyExpectancyR: earlyExp,
    recentExpectancyR: recentExp,
  };
}

export interface StrategyHealth {
  strategyId: IndiaStrategy;
  /** [0,1] composite of recent OOS win rate (Wilson-LB), expectancy, PF, drawdown. */
  strategyHealthScore: number;
  sampleCount: number;
  /** Whether there is enough OOS evidence to trust the score. */
  reliable: boolean;
  alphaDecay: AlphaDecay;
}

/**
 * Compute a strategy's health from its recent OOS trades. The score blends the
 * Wilson lower bound of the win rate, normalised expectancy, profit factor and a
 * drawdown penalty. It is SAMPLE-AWARE — a thin sample yields `reliable=false`
 * and a score shrunk toward a neutral 0.5, so a strategy is never condemned (or
 * promoted) on a few trades.
 */
export function computeStrategyHealth(
  strategyId: IndiaStrategy,
  trades: StrategyTrade[],
  minReliable = 30,
): StrategyHealth {
  const n = trades.length;
  const rs = trades.map((t) => t.returnR);
  const wins = trades.filter((t) => t.label === 1).length;
  const wrLB = wilsonLowerBound(wins, n);
  const exp = expectancyR(rs);
  const pf = profitFactorR(rs);
  const dd = maxDrawdownR(rs);

  const wrComp = clamp01(wrLB);
  const expComp = clamp01(0.5 + exp / 2);            // 0R → 0.5, +1R → 1
  const pfComp = clamp01(Number.isFinite(pf) ? (pf - 1) / 1.5 + 0.4 : 0.9); // PF 1→0.4, 2.5→1
  const ddComp = clamp01(1 - dd / 10);               // 10R DD → 0
  const raw = 0.35 * wrComp + 0.3 * expComp + 0.2 * pfComp + 0.15 * ddComp;

  const sampleConfidence = n > 0 ? n / (n + minReliable) : 0;
  const score = clamp01(sampleConfidence * raw + (1 - sampleConfidence) * 0.5);

  return {
    strategyId,
    strategyHealthScore: score,
    sampleCount: n,
    reliable: n >= minReliable,
    alphaDecay: detectAlphaDecay(trades, Math.min(minReliable, 30)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — strategyRegimeMatrix
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategyRegimeCell {
  strategyId: IndiaStrategy;
  regime: SrsRegime;
  sampleCount: number;
  winRate: number;
  winRateLB: number;
  expectancy: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdown: number;
  currentHealth: number;
  recommendedStatus: RecommendedStatus;
  /** Whether the profile even considers this regime suitable. */
  regimeSuitable: boolean;
  reasons: string[];
}

/**
 * Map health + evidence + regime suitability to a recommended status.
 *
 *   DISABLED — statistically-meaningful negative edge in this regime, OR
 *              confirmed alpha decay with a negative recent expectancy.
 *   SHADOW   — insufficient evidence to trade (small sample / unsuitable regime):
 *              observe/paper only. This is the DEFAULT for a new strategy — a
 *              strategy is NEVER auto-promoted to LIVE.
 *   CAUTION  — positive but weak/uncertain edge, or mild decay: reduced size.
 *   ACTIVE   — statistically-meaningful positive edge in a suitable regime.
 *
 * There is NO "LIVE" status here — promotion to live is a human decision.
 */
export function recommendStatus(
  cell: { sampleCount: number; winRateLB: number; expectancy: number; currentHealth: number; regimeSuitable: boolean; decaying: boolean; recentExpectancyR: number },
  minReliable = 30,
): { status: RecommendedStatus; reasons: string[] } {
  const reasons: string[] = [];

  // DISABLED: meaningful negative edge, or decay with negative recent expectancy.
  if (cell.sampleCount >= minReliable && cell.expectancy < 0 && cell.winRateLB < 0.35) {
    reasons.push("meaningful_negative_edge");
    return { status: "DISABLED", reasons };
  }
  if (cell.decaying && cell.recentExpectancyR < 0) {
    reasons.push("alpha_decay_with_negative_recent_expectancy");
    return { status: "DISABLED", reasons };
  }

  // SHADOW: not enough evidence, or regime the profile deems unsuitable.
  if (cell.sampleCount < minReliable) {
    reasons.push(`insufficient_sample:${cell.sampleCount}<${minReliable}`);
    return { status: "SHADOW", reasons };
  }
  if (!cell.regimeSuitable) {
    reasons.push("regime_not_in_profile_suitable_set");
    return { status: "SHADOW", reasons };
  }

  // CAUTION: mild decay, or weak/uncertain positive edge.
  if (cell.decaying) {
    reasons.push("mild_alpha_decay");
    return { status: "CAUTION", reasons };
  }
  if (cell.expectancy <= 0.05 || cell.currentHealth < 0.55 || cell.winRateLB < 0.45) {
    reasons.push("weak_or_uncertain_edge");
    return { status: "CAUTION", reasons };
  }

  reasons.push("meaningful_positive_edge_in_suitable_regime");
  return { status: "ACTIVE", reasons };
}

/**
 * Build the full strategyRegimeMatrix from resolved trades. One cell per
 * (strategy × regime) present in the data. Statuses are recommendations only;
 * nothing is ever auto-promoted to live.
 */
export function buildStrategyRegimeMatrix(trades: StrategyTrade[], minReliable = 30): StrategyRegimeCell[] {
  const byCell = new Map<string, StrategyTrade[]>();
  for (const t of trades) {
    const k = `${t.strategyId}|${t.regime}`;
    const arr = byCell.get(k);
    if (arr) arr.push(t);
    else byCell.set(k, [t]);
  }
  const out: StrategyRegimeCell[] = [];
  for (const [key, rows] of byCell) {
    const [strategyId, regime] = key.split("|") as [IndiaStrategy, SrsRegime];
    const profile = getStrategyProfile(strategyId);
    const regimeSuitable = profile ? profile.suitableRegimes.includes(regime) : false;
    const rs = rows.map((t) => t.returnR);
    const wins = rows.filter((t) => t.label === 1).length;
    const n = rows.length;
    const winRate = n > 0 ? wins / n : 0;
    const winRateLB = wilsonLowerBound(wins, n);
    const exp = expectancyR(rs);
    const pf = profitFactorR(rs);
    const health = computeStrategyHealth(strategyId, rows, minReliable);
    const decay = health.alphaDecay;
    const { status, reasons } = recommendStatus(
      { sampleCount: n, winRateLB, expectancy: exp, currentHealth: health.strategyHealthScore, regimeSuitable, decaying: decay.decaying, recentExpectancyR: decay.recentExpectancyR },
      minReliable,
    );
    out.push({
      strategyId,
      regime,
      sampleCount: n,
      winRate,
      winRateLB,
      expectancy: exp,
      profitFactor: Number.isFinite(pf) ? pf : 0,
      sharpe: sharpeR(rs),
      maxDrawdown: maxDrawdownR(rs),
      currentHealth: health.strategyHealthScore,
      recommendedStatus: status,
      regimeSuitable,
      reasons,
    });
  }
  // deterministic ordering
  out.sort((a, b) => (a.strategyId < b.strategyId ? -1 : a.strategyId > b.strategyId ? 1 : a.regime < b.regime ? -1 : 1));
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Regime-aware strategy selector
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategySuitability {
  strategyId: IndiaStrategy;
  regime: SrsRegime;
  /** Profile says this regime is suitable. */
  profileSuitable: boolean;
  /** Recommended status from the matrix (or SHADOW when no data). */
  recommendedStatus: RecommendedStatus;
  /** Suitability multiplier ∈ [0,1] applied to the strategy's influence. */
  suitability: number;
  /** Whether the strategy is suppressed in this regime. */
  suppressed: boolean;
  reasons: string[];
}

/**
 * Given the current regime and the strategyRegimeMatrix, decide which candidate
 * strategies are eligible and how much influence each gets. A strategy with poor
 * historical performance IN THIS REGIME is suppressed; an unsuitable-regime or
 * data-thin strategy is put in SHADOW (observe only). This is the
 *   Regime → Candidate strategies → Suitability
 * front of the pipeline.
 */
export function selectStrategiesForRegime(
  regime: SrsRegime,
  matrix: StrategyRegimeCell[],
  candidates: IndiaStrategy[] = [...INDIA_STRATEGIES],
): StrategySuitability[] {
  const cellByStrat = new Map<IndiaStrategy, StrategyRegimeCell>();
  for (const c of matrix) if (c.regime === regime) cellByStrat.set(c.strategyId, c);

  return candidates.map((strategyId) => {
    const profile = getStrategyProfile(strategyId);
    const profileSuitable = profile ? profile.suitableRegimes.includes(regime) : false;
    const profileUnsuitable = profile ? profile.unsuitableRegimes.includes(regime) : true;
    const cell = cellByStrat.get(strategyId);
    const status = cell?.recommendedStatus ?? "SHADOW";
    const reasons: string[] = [];

    // Suitability multiplier by status + profile fit.
    let suitability: number;
    switch (status) {
      case "ACTIVE": suitability = profileSuitable ? 1.0 : 0.6; break;
      case "CAUTION": suitability = 0.5; break;
      case "SHADOW": suitability = 0; break;   // observe only — no live influence
      case "DISABLED": suitability = 0; break;
    }
    if (profileUnsuitable) { suitability = Math.min(suitability, 0); reasons.push("profile_marks_regime_unsuitable"); }
    if (status === "DISABLED") reasons.push("status_disabled");
    if (status === "SHADOW") reasons.push("status_shadow_observe_only");

    const suppressed = suitability <= 0;
    if (suppressed && reasons.length === 0) reasons.push("suppressed_in_regime");
    return { strategyId, regime, profileSuitable, recommendedStatus: status, suitability, suppressed, reasons };
  }).sort((a, b) => b.suitability - a.suitability);
}
