/**
 * Indian F&O Data Quality Rules — Phase 12
 *
 * Validates option chain data and marks quality levels.
 * The Meta Decision Engine and Risk Engine must receive this status.
 *
 * Quality levels:
 *   GOOD     - All checks pass, data is reliable for trading decisions
 *   DEGRADED - Minor issues (some Greeks missing, slightly stale) — use with caution
 *   PARTIAL  - Significant missing data (< 80% of strikes have valid quotes)
 *   STALE    - Data is too old for reliable inference
 *   INVALID  - Fundamental data integrity failure (crossed market, negative IV, etc.)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type OptionDataQuality =
  | "GOOD"
  | "DEGRADED"
  | "PARTIAL"
  | "STALE"
  | "INVALID";

export type OptionDataIssue =
  | "CROSSED_MARKET"           // bid > ask
  | "NEGATIVE_IV"              // implied volatility < 0
  | "NEGATIVE_OI"              // open interest < 0
  | "STALE_QUOTE"              // quote is too old
  | "ZERO_LIQUIDITY"           // both bid and ask are 0
  | "WIDE_SPREAD"              // (ask - bid) / ask > threshold
  | "MISSING_STRIKE"           // expected ATM±N strike absent
  | "PARTIAL_CHAIN"            // fewer than 80% of expected strikes have quotes
  | "EXPIRY_MISMATCH"          // chain expiry doesn't match requested
  | "MISSING_ATM_IV"           // ATM IV is null
  | "INVALID_GREEKS"           // delta out of [-1, 1], gamma < 0, etc.
  | "NEGATIVE_LTP";            // LTP < 0

export interface OptionStrikeQuality {
  strike: number;
  issues: OptionDataIssue[];
  ceQuality: "GOOD" | "DEGRADED" | "INVALID";
  peQuality: "GOOD" | "DEGRADED" | "INVALID";
}

export interface OptionChainQualityResult {
  quality: OptionDataQuality;
  issues: OptionDataIssue[];
  /** Number of strikes with at least one issue. */
  strikeIssueCount: number;
  /** Total strikes evaluated. */
  totalStrikes: number;
  /** Pct of strikes with valid quotes [0, 1]. */
  validStrikePct: number;
  perStrike: OptionStrikeQuality[];
  /** ISO-8601 timestamp when this quality check was performed. */
  evaluatedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum age for option chain data to be considered fresh (ms). */
const MAX_CHAIN_AGE_MS = 5 * 60 * 1_000; // 5 minutes

/** Maximum bid-ask spread as % of ask before flagging WIDE_SPREAD. */
const MAX_SPREAD_PCT = 0.25; // 25%

/** Minimum fraction of strikes that must have valid quotes for GOOD. */
const MIN_VALID_STRIKE_FRACTION = 0.8;

// ─── Validators ──────────────────────────────────────────────────────────────

type OptionLeg = {
  ltp: number | null;
  bid?: number | null;
  ask?: number | null;
  oi?: number | null;
  iv?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
};

function validateOptionLeg(
  leg: OptionLeg | null | undefined,
  chainFetchedAtMs: number,
  nowMs: number,
): { issues: OptionDataIssue[]; quality: "GOOD" | "DEGRADED" | "INVALID" } {
  if (!leg) return { issues: [], quality: "GOOD" };

  const issues: OptionDataIssue[] = [];

  // LTP check
  if (leg.ltp !== null && leg.ltp !== undefined && leg.ltp < 0) {
    issues.push("NEGATIVE_LTP");
  }

  // Crossed market
  if (
    leg.bid !== null && leg.bid !== undefined &&
    leg.ask !== null && leg.ask !== undefined &&
    leg.bid > leg.ask
  ) {
    issues.push("CROSSED_MARKET");
  }

  // Zero liquidity
  if (
    leg.bid === 0 &&
    leg.ask === 0 &&
    (leg.ltp === null || leg.ltp === 0)
  ) {
    issues.push("ZERO_LIQUIDITY");
  }

  // Wide spread
  if (
    leg.bid !== null && leg.bid !== undefined &&
    leg.ask !== null && leg.ask !== undefined &&
    leg.ask > 0
  ) {
    const spreadPct = (leg.ask - leg.bid) / leg.ask;
    if (spreadPct > MAX_SPREAD_PCT) {
      issues.push("WIDE_SPREAD");
    }
  }

  // Negative IV
  if (leg.iv !== null && leg.iv !== undefined && leg.iv < 0) {
    issues.push("NEGATIVE_IV");
  }

  // Negative OI
  if (leg.oi !== null && leg.oi !== undefined && leg.oi < 0) {
    issues.push("NEGATIVE_OI");
  }

  // Invalid Greeks
  if (
    (leg.delta !== null && leg.delta !== undefined && (leg.delta < -1.001 || leg.delta > 1.001)) ||
    (leg.gamma !== null && leg.gamma !== undefined && leg.gamma < 0) ||
    (leg.vega !== null && leg.vega !== undefined && leg.vega < 0)
  ) {
    issues.push("INVALID_GREEKS");
  }

  // Stale quote check
  const agMs = nowMs - chainFetchedAtMs;
  if (agMs > MAX_CHAIN_AGE_MS) {
    issues.push("STALE_QUOTE");
  }

  // Determine quality
  const INVALID_ISSUES: OptionDataIssue[] = ["CROSSED_MARKET", "NEGATIVE_LTP", "NEGATIVE_IV", "NEGATIVE_OI", "INVALID_GREEKS"];
  if (issues.some((i) => INVALID_ISSUES.includes(i))) {
    return { issues, quality: "INVALID" };
  }
  if (issues.length > 0) {
    return { issues, quality: "DEGRADED" };
  }
  return { issues: [], quality: "GOOD" };
}

// ─── Chain quality evaluator ──────────────────────────────────────────────────

export type MinimalOptionChain = {
  expiry: string;
  spot: number | null;
  fetchedAt: string; // ISO-8601
  analytics: {
    atmIv: number | null;
    pcrOi: number | null;
    maxPain: number | null;
  };
  rows: Array<{
    strike: number;
    ce: OptionLeg | null;
    pe: OptionLeg | null;
  }>;
};

/**
 * Evaluate the quality of an option chain.
 * Returns a structured quality result that the Meta Decision Engine
 * and Risk Engine must consume before using chain data.
 */
export function evaluateOptionChainQuality(
  chain: MinimalOptionChain,
  requestedExpiry: string,
  nowMs: number = Date.now(),
): OptionChainQualityResult {
  const chainFetchedAtMs = new Date(chain.fetchedAt).getTime();
  const issues: OptionDataIssue[] = [];
  const perStrike: OptionStrikeQuality[] = [];

  // Check expiry mismatch
  if (chain.expiry !== requestedExpiry) {
    issues.push("EXPIRY_MISMATCH");
  }

  // Check missing ATM IV
  if (chain.analytics.atmIv === null || chain.analytics.atmIv === undefined) {
    issues.push("MISSING_ATM_IV");
  }

  // Evaluate each strike
  let validStrikeCount = 0;
  for (const row of chain.rows) {
    const ceResult = validateOptionLeg(row.ce, chainFetchedAtMs, nowMs);
    const peResult = validateOptionLeg(row.pe, chainFetchedAtMs, nowMs);

    const strikeIssues = Array.from(new Set([...ceResult.issues, ...peResult.issues]));

    perStrike.push({
      strike: row.strike,
      issues: strikeIssues,
      ceQuality: ceResult.quality,
      peQuality: peResult.quality,
    });

    if (
      ceResult.quality !== "INVALID" &&
      peResult.quality !== "INVALID" &&
      !strikeIssues.includes("STALE_QUOTE")
    ) {
      validStrikeCount++;
    }
  }

  const totalStrikes = chain.rows.length;
  const validStrikePct = totalStrikes > 0 ? validStrikeCount / totalStrikes : 0;

  if (totalStrikes < 10) {
    issues.push("PARTIAL_CHAIN");
  } else if (validStrikePct < MIN_VALID_STRIKE_FRACTION) {
    issues.push("PARTIAL_CHAIN");
  }

  // Determine overall quality
  let quality: OptionDataQuality;

  const hasInvalidIssues = issues.some((i) =>
    ["EXPIRY_MISMATCH", "NEGATIVE_IV", "NEGATIVE_OI"].includes(i),
  );
  const hasStaleness = issues.some((i) => i === "STALE_QUOTE") ||
    (nowMs - chainFetchedAtMs) > MAX_CHAIN_AGE_MS;
  const hasPartial = issues.includes("PARTIAL_CHAIN");

  if (hasInvalidIssues) {
    quality = "INVALID";
  } else if (hasStaleness) {
    quality = "STALE";
  } else if (hasPartial) {
    quality = "PARTIAL";
  } else if (issues.length > 0 || perStrike.some((s) => s.ceQuality === "DEGRADED" || s.peQuality === "DEGRADED")) {
    quality = "DEGRADED";
  } else {
    quality = "GOOD";
  }

  const strikeIssueCount = perStrike.filter(
    (s) => s.issues.length > 0 || s.ceQuality !== "GOOD" || s.peQuality !== "GOOD",
  ).length;

  return {
    quality,
    issues,
    strikeIssueCount,
    totalStrikes,
    validStrikePct,
    perStrike,
    evaluatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Determine if an option chain is safe to use for ML/execution decisions.
 * Returns true for GOOD and DEGRADED quality (with a confidence penalty).
 * Returns false for PARTIAL, STALE, INVALID.
 */
export function isChainUsableForDecisions(quality: OptionDataQuality): boolean {
  return quality === "GOOD" || quality === "DEGRADED";
}
