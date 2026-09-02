/**
 * Derivatives Intelligence — Phases 14–16
 *
 * F&O Open Interest Intelligence, Options Chain Intelligence,
 * and Options Flow Quality classification.
 *
 * Rules:
 *   1. OI data freshness must be tracked — stale OI is not used for decisions.
 *   2. Max Pain is contextual evidence, NOT a deterministic price target.
 *   3. "Smart money" claims from OI alone are explicitly labeled OBSERVATION.
 *   4. OI classification requires BOTH price and OI direction.
 *   5. Insufficient data quality must prevent classification.
 */

// ─── OI Classification ────────────────────────────────────────────────────────

export type OIBuildupKind =
  | "LONG_BUILDUP"    // Price up + OI up → fresh longs being added
  | "SHORT_BUILDUP"   // Price down + OI up → fresh shorts being added
  | "LONG_UNWINDING"  // Price down + OI down → longs exiting
  | "SHORT_COVERING"  // Price up + OI down → shorts buying back
  | "NEUTRAL"         // Insufficient directional evidence
  | "UNCLASSIFIED";   // Data quality insufficient

export interface OIBuildupResult {
  kind: OIBuildupKind;
  /** Price change % (positive = up) */
  priceChangePct: number;
  /** OI change % (positive = OI increasing) */
  oiChangePct: number;
  /** Current OI in contracts */
  currentOi: number | null;
  /** OI as of previous session */
  prevSessionOi: number | null;
  /** UTC ms of OI data */
  oiTimestampMs: number | null;
  /** Whether OI data is fresh enough for this classification */
  oiDataFresh: boolean;
  /** Confidence in the classification [0, 1] */
  confidence: number;
  reasons: string[];
}

/**
 * Classify F&O open interest positioning.
 *
 * @param priceChangePct - % price change vs previous close
 * @param oiChange - absolute OI change (contracts)
 * @param currentOi - current open interest
 * @param oiTimestampMs - when OI data was last updated (UTC ms)
 * @param nowMs - current time (UTC ms)
 */
export function classifyOIBuildup(
  priceChangePct: number,
  oiChange: number,
  currentOi: number | null,
  oiTimestampMs: number | null,
  nowMs: number,
): OIBuildupResult {
  const reasons: string[] = [];

  // OI freshness check (max 15 minutes stale for classification)
  const MAX_OI_STALE_MS = 15 * 60 * 1000;
  const oiDataFresh =
    oiTimestampMs !== null && nowMs - oiTimestampMs <= MAX_OI_STALE_MS;

  if (!oiDataFresh) {
    reasons.push(
      `OI data stale (${oiTimestampMs !== null ? Math.round((nowMs - oiTimestampMs) / 60000) : "unknown"}min old) — classification unreliable`,
    );
  }

  const prevSessionOi =
    currentOi !== null && oiChange !== null ? currentOi - oiChange : null;
  const oiChangePct =
    prevSessionOi !== null && prevSessionOi > 0
      ? (oiChange / prevSessionOi) * 100
      : 0;

  // Cannot classify when data quality is insufficient
  if (!oiDataFresh || currentOi === null || Math.abs(oiChange) < 1) {
    return {
      kind: "UNCLASSIFIED",
      priceChangePct,
      oiChangePct,
      currentOi,
      prevSessionOi,
      oiTimestampMs,
      oiDataFresh,
      confidence: 0,
      reasons: [
        ...reasons,
        "Insufficient OI data quality for classification",
      ],
    };
  }

  const priceUp = priceChangePct > 0.1;
  const priceDown = priceChangePct < -0.1;
  const oiUp = oiChange > 0;
  const oiDown = oiChange < 0;
  const significantChange = Math.abs(oiChangePct) > 1.0;

  let kind: OIBuildupKind = "NEUTRAL";
  if (priceUp && oiUp) {
    kind = "LONG_BUILDUP";
    reasons.push(`Price +${priceChangePct.toFixed(2)}% + OI +${oiChangePct.toFixed(1)}% → fresh longs`);
  } else if (priceDown && oiUp) {
    kind = "SHORT_BUILDUP";
    reasons.push(`Price ${priceChangePct.toFixed(2)}% + OI +${oiChangePct.toFixed(1)}% → fresh shorts`);
  } else if (priceUp && oiDown) {
    kind = "SHORT_COVERING";
    reasons.push(`Price +${priceChangePct.toFixed(2)}% + OI ${oiChangePct.toFixed(1)}% → short covering`);
  } else if (priceDown && oiDown) {
    kind = "LONG_UNWINDING";
    reasons.push(`Price ${priceChangePct.toFixed(2)}% + OI ${oiChangePct.toFixed(1)}% → long unwinding`);
  }

  const confidence =
    kind === "NEUTRAL"
      ? 0.3
      : significantChange
      ? 0.75
      : 0.5;

  return {
    kind,
    priceChangePct,
    oiChangePct,
    currentOi,
    prevSessionOi,
    oiTimestampMs,
    oiDataFresh,
    confidence,
    reasons,
  };
}

// ─── Options Chain Snapshot ───────────────────────────────────────────────────

export interface OptionChainIntelligence {
  underlying: string;
  spot: number;
  expiry: string;
  atm: number;                      // ATM strike
  atmIv: number | null;             // ATM IV %
  pcrOi: number | null;             // Put-Call Ratio by OI
  pcrVolume: number | null;         // PCR by volume
  ivSkew: number | null;            // OTM put IV - OTM call IV (positive = fear)
  ivPercentile: number | null;      // IV percentile vs history [0, 100]
  ceWallStrike: number | null;      // Max CE OI strike (resistance)
  peFloorStrike: number | null;     // Max PE OI strike (support)
  maxPain: number | null;           // Max pain strike
  totalCeOi: number;
  totalPeOi: number;
  totalCeOiChange: number;
  totalPeOiChange: number;
  callWallDistance: number | null;  // % from spot to CE wall
  putFloorDistance: number | null;  // % from spot to PE floor
  maxPainDistance: number | null;   // % from spot to max pain
  chainQuality: "COMPLETE" | "PARTIAL" | "STALE" | "MISSING";
  fetchedAtMs: number;
  reasons: string[];
}

/**
 * Build OptionChainIntelligence from raw analytics.
 */
export function buildOptionChainIntelligence(params: {
  underlying: string;
  spot: number;
  expiry: string;
  atmIv: number | null;
  pcrOi: number | null;
  pcrVolume: number | null;
  maxCeOiStrike: number | null;
  maxPeOiStrike: number | null;
  maxPain: number | null;
  totalCeOi: number;
  totalPeOi: number;
  totalCeOiChange: number;
  totalPeOiChange: number;
  fetchedAtMs: number;
  strikePriceInterval?: number;
}): OptionChainIntelligence {
  const {
    underlying, spot, expiry, atmIv, pcrOi, pcrVolume,
    maxCeOiStrike, maxPeOiStrike, maxPain,
    totalCeOi, totalPeOi, totalCeOiChange, totalPeOiChange,
    fetchedAtMs,
  } = params;
  const reasons: string[] = [];

  // ATM = nearest round strike to spot
  const strikeInterval = params.strikePriceInterval ?? (spot > 20000 ? 50 : spot > 5000 ? 100 : 50);
  const atm = Math.round(spot / strikeInterval) * strikeInterval;

  // Distances as %
  const callWallDistance =
    maxCeOiStrike !== null && spot > 0
      ? ((maxCeOiStrike - spot) / spot) * 100
      : null;
  const putFloorDistance =
    maxPeOiStrike !== null && spot > 0
      ? ((spot - maxPeOiStrike) / spot) * 100
      : null;
  const maxPainDistance =
    maxPain !== null && spot > 0
      ? ((maxPain - spot) / spot) * 100
      : null;

  // Chain quality
  const MAX_CHAIN_STALE_MS = 15 * 60 * 1000;
  const isStale = Date.now() - fetchedAtMs > MAX_CHAIN_STALE_MS;
  const hasOiData = totalCeOi > 0 || totalPeOi > 0;
  const chainQuality: "COMPLETE" | "PARTIAL" | "STALE" | "MISSING" =
    isStale ? "STALE" :
    !hasOiData ? "MISSING" :
    (pcrOi === null || atmIv === null) ? "PARTIAL" : "COMPLETE";

  if (isStale) reasons.push(`Chain data stale (${Math.round((Date.now() - fetchedAtMs) / 60000)}min old)`);
  if (!hasOiData) reasons.push("No OI data available");

  if (pcrOi !== null) {
    if (pcrOi > 1.3) reasons.push(`PCR ${pcrOi.toFixed(2)} — heavy put writing (bullish bias)`);
    else if (pcrOi < 0.7) reasons.push(`PCR ${pcrOi.toFixed(2)} — heavy call writing (bearish bias)`);
  }

  if (callWallDistance !== null && callWallDistance < 1.5) {
    reasons.push(`CE wall at ${maxCeOiStrike} — resistance ${callWallDistance.toFixed(2)}% above`);
  }
  if (putFloorDistance !== null && putFloorDistance < 1.5) {
    reasons.push(`PE floor at ${maxPeOiStrike} — support ${putFloorDistance.toFixed(2)}% below`);
  }

  return {
    underlying,
    spot,
    expiry,
    atm,
    atmIv,
    pcrOi,
    pcrVolume,
    ivSkew: null, // requires full chain rows
    ivPercentile: null,
    ceWallStrike: maxCeOiStrike,
    peFloorStrike: maxPeOiStrike,
    maxPain,
    totalCeOi,
    totalPeOi,
    totalCeOiChange,
    totalPeOiChange,
    callWallDistance,
    putFloorDistance,
    maxPainDistance,
    chainQuality,
    fetchedAtMs,
    reasons,
  };
}

// ─── Options Flow Quality ─────────────────────────────────────────────────────

export type OptionsFlowClassification =
  | "CALL_ACCUMULATION"
  | "PUT_ACCUMULATION"
  | "CALL_UNWINDING"
  | "PUT_UNWINDING"
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "POSSIBLE_HEDGING"
  | "POSSIBLE_SPECULATIVE_FLOW"
  | "NEUTRAL";

/**
 * Interpretation confidence level.
 * OI alone NEVER qualifies as HIGH_CONFIDENCE_INFERENCE.
 */
export type FlowInterpretationConfidence =
  | "OBSERVATION"                 // Raw data — no interpretation
  | "INFERENCE"                   // Inference from single data point
  | "HIGH_CONFIDENCE_INFERENCE";  // Multiple confirming signals

export interface OptionsFlowResult {
  classification: OptionsFlowClassification;
  confidence: FlowInterpretationConfidence;
  /** Score in [-1, 1]: positive = bullish flow, negative = bearish flow */
  flowScore: number;
  reasons: string[];
  /** IMPORTANT: this is never "smart money" from OI alone */
  warnings: string[];
}

/**
 * Classify options flow from OI and volume data.
 * Never claims "smart money" from OI alone.
 */
export function classifyOptionsFlow(
  oiBuildup: OIBuildupResult,
  chain: OptionChainIntelligence,
): OptionsFlowResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Default: observation only from OI
  warnings.push(
    "OI-based flow classification is OBSERVATION only — not smart-money inference. " +
    "OI changes can reflect hedging, rolling, or institutional positioning equally.",
  );

  if (chain.chainQuality === "STALE" || chain.chainQuality === "MISSING") {
    return {
      classification: "NEUTRAL",
      confidence: "OBSERVATION",
      flowScore: 0,
      reasons: ["Insufficient chain quality for flow classification"],
      warnings,
    };
  }

  let flowScore = 0;
  let classification: OptionsFlowClassification = "NEUTRAL";
  let confidence: FlowInterpretationConfidence = "OBSERVATION";

  // PCR-based flow
  if (chain.pcrOi !== null) {
    if (chain.pcrOi > 1.2) {
      flowScore += 0.3;
      reasons.push(`PCR ${chain.pcrOi.toFixed(2)} — put accumulation / PE writing`);
      classification = "PUT_ACCUMULATION";
      confidence = "INFERENCE";
    } else if (chain.pcrOi < 0.8) {
      flowScore -= 0.3;
      reasons.push(`PCR ${chain.pcrOi.toFixed(2)} — call accumulation / CE writing`);
      classification = "CALL_ACCUMULATION";
      confidence = "INFERENCE";
    }
  }

  // OI change flow
  const peOiChangePct = chain.totalPeOi > 0 ? (chain.totalPeOiChange / chain.totalPeOi) * 100 : 0;
  const ceOiChangePct = chain.totalCeOi > 0 ? (chain.totalCeOiChange / chain.totalCeOi) * 100 : 0;

  if (peOiChangePct > 3 && ceOiChangePct < 1) {
    flowScore += 0.2;
    reasons.push(`PE OI building (+${peOiChangePct.toFixed(1)}%) — put writing (bullish bias)`);
    if (classification === "PUT_ACCUMULATION") confidence = "HIGH_CONFIDENCE_INFERENCE";
  } else if (ceOiChangePct > 3 && peOiChangePct < 1) {
    flowScore -= 0.2;
    reasons.push(`CE OI building (+${ceOiChangePct.toFixed(1)}%) — call writing (bearish bias)`);
    if (classification === "CALL_ACCUMULATION") confidence = "HIGH_CONFIDENCE_INFERENCE";
  }

  // OI buildup confirmation
  if (oiBuildup.kind === "LONG_BUILDUP") {
    flowScore += 0.15;
    reasons.push("F&O: Long buildup confirms bullish flow");
  } else if (oiBuildup.kind === "SHORT_BUILDUP") {
    flowScore -= 0.15;
    reasons.push("F&O: Short buildup confirms bearish flow");
  } else if (oiBuildup.kind === "SHORT_COVERING") {
    flowScore += 0.1;
    reasons.push("Short covering — forced short exits");
  }

  flowScore = Math.max(-1, Math.min(1, flowScore));

  return { classification, confidence, flowScore, reasons, warnings };
}

// ─── Expiry Day Engine ────────────────────────────────────────────────────────

export type ExpiryType = "WEEKLY" | "MONTHLY" | "SPECIAL" | "HOLIDAY_SHIFTED";

export type ExpiryBehavior =
  | "TRENDING_EXPIRY"
  | "MEAN_REVERSION_EXPIRY"
  | "HIGH_GAMMA"
  | "LOW_LIQUIDITY"
  | "ABNORMAL_IV";

export type ExpiryStrategyBehavior =
  | "ALLOW_EXPIRY"
  | "AVOID_EXPIRY"
  | "REDUCE_SIZE_EXPIRY"
  | "EXPIRY_SPECIAL_MODE";

export interface ExpiryContext {
  isExpiryDay: boolean;
  expiryType: ExpiryType | null;
  expiryBehavior: ExpiryBehavior | null;
  daysToExpiry: number | null;
  underlying: string | null;
  /** Minutes from IST midnight to the relevant expiry */
  expiryTimeIST: number | null;
  gammaRiskActive: boolean;     // true after 14:30 IST on expiry day
  isWeeklyExpiry: boolean;
  isMonthlyExpiry: boolean;
  reasons: string[];
}

/**
 * Build expiry context from IST datetime and calendar.
 * @param nowMs - current UTC ms
 */
export function buildExpiryContext(
  nowMs: number,
  expiryDays?: Map<string, { type: ExpiryType; underlying: string }>,
): ExpiryContext {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const dow = ist.getUTCDay();
  const istMins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const dateKey = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
  const reasons: string[] = [];

  // Thursday = NIFTY weekly expiry by default
  const isThursday = dow === 4;
  // Check if it's last Thursday of month for monthly expiry
  const nextThursday = new Date(ist);
  nextThursday.setUTCDate(ist.getUTCDate() + 7);
  const isMonthlyExpiry = isThursday && nextThursday.getUTCMonth() !== ist.getUTCMonth();

  const isWeeklyExpiry = isThursday && !isMonthlyExpiry;

  const isExpiryDay = expiryDays?.has(dateKey) ?? isThursday;

  const gammaRiskActive = isExpiryDay && istMins >= 14 * 60 + 30;

  if (isExpiryDay) {
    reasons.push(isMonthlyExpiry ? "Monthly expiry day" : "Weekly expiry day (NIFTY)");
    if (gammaRiskActive) reasons.push("Gamma risk active (post 14:30 IST)");
  }

  const expiryType: ExpiryType | null = isExpiryDay
    ? isMonthlyExpiry ? "MONTHLY" : "WEEKLY"
    : null;

  return {
    isExpiryDay,
    expiryType,
    expiryBehavior: gammaRiskActive ? "HIGH_GAMMA" : isExpiryDay ? "MEAN_REVERSION_EXPIRY" : null,
    daysToExpiry: isExpiryDay ? 0 : isThursday ? 0 : ((4 - dow + 7) % 7) || 7,
    underlying: isExpiryDay ? "NIFTY" : null,
    expiryTimeIST: isExpiryDay ? 15 * 60 + 30 : null,
    gammaRiskActive,
    isWeeklyExpiry,
    isMonthlyExpiry,
    reasons,
  };
}

/**
 * Determine how a strategy should behave on expiry day.
 * Strategies that don't explicitly declare expiry mode default to REDUCE_SIZE.
 */
export function getStrategyExpiryBehavior(
  strategyId: string,
  context: ExpiryContext,
): ExpiryStrategyBehavior {
  if (!context.isExpiryDay) return "ALLOW_EXPIRY";

  // PCR_EXTREME and MAX_PAIN_GRAVITY are expiry-day specialists
  const EXPIRY_SPECIALISTS = new Set(["PCR_EXTREME", "MAX_PAIN_GRAVITY"]);
  // Opening Breakout can work on expiry but needs size reduction
  const REDUCE_SIZE_STRATEGIES = new Set(["OPENING_BREAKOUT", "MOMENTUM", "RANGE_EXPANSION"]);
  // These are better avoided on expiry day due to IV crush
  const AVOID_EXPIRY = new Set(["VOLUME_BREAKOUT", "RANGE_EXPANSION", "OI_BUILDUP"]);

  if (context.gammaRiskActive) {
    // After 14:30 on expiry: only specialists fire, all others avoid
    return EXPIRY_SPECIALISTS.has(strategyId) ? "EXPIRY_SPECIAL_MODE" : "AVOID_EXPIRY";
  }

  if (EXPIRY_SPECIALISTS.has(strategyId)) return "EXPIRY_SPECIAL_MODE";
  if (AVOID_EXPIRY.has(strategyId)) return "AVOID_EXPIRY";
  if (REDUCE_SIZE_STRATEGIES.has(strategyId)) return "REDUCE_SIZE_EXPIRY";
  return "REDUCE_SIZE_EXPIRY";
}
