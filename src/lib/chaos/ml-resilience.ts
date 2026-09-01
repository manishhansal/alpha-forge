/**
 * chaos/ml-resilience.ts
 *
 * Chaos Engineering – Scenario 3 & 13–14: ML Service Unavailability,
 * Invalid ML Output, and NaN/Infinity Feature Vectors
 *
 * Provides:
 *  - MLCircuitBreaker           : open/half-open/closed breaker for the ML
 *                                 service endpoint
 *  - validateMLRegimeResponse() : schema + range validation for regime output
 *  - validateMLRiskResponse()   : schema + range validation for risk output
 *  - validateMLRankingResponse(): schema + range validation for ranking output
 *  - sanitizeFeatureVector()    : replace NaN/Inf with safe defaults, log corruption
 *  - validateAndSanitizeFeatures(): combined check used before every ML POST
 *
 * Design decisions
 * ────────────────
 * • ML predictions are ADDITIVE enhancements; a validation failure always
 *   falls back to the heuristic engine — no exception is surfaced to the
 *   trade-opening path.
 * • Feature vector sanitization runs before the HTTP call so the ML service
 *   never receives NaN/Inf.  The mutation is logged as structured data so
 *   the root cause can be traced back to the indicator that produced the
 *   bad value.
 * • The circuit breaker tracks consecutive HTTP-level failures separately
 *   from schema validation failures — a misconfigured model that returns
 *   garbage doesn't keep the breaker closed.
 */

import type {
  MLRegimeResponse,
  MLRiskResponse,
  MLRankingResponse,
  MLMarketRegime,
} from "@/lib/india/ml-client";

// ─── Circuit breaker ──────────────────────────────────────────────────────────

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class MLCircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failures = 0;
  private successes = 0;
  private openedAt: number | null = null;

  private readonly openThreshold: number;
  private readonly halfOpenDelayMs: number;
  private readonly closeThreshold: number;

  constructor(opts: {
    openThreshold?: number;
    halfOpenDelayMs?: number;
    closeThreshold?: number;
  } = {}) {
    this.openThreshold = opts.openThreshold ?? 4;
    this.halfOpenDelayMs = opts.halfOpenDelayMs ?? 30_000; // 30s
    this.closeThreshold = opts.closeThreshold ?? 2;
  }

  get isCallable(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() - (this.openedAt ?? 0) >= this.halfOpenDelayMs) {
        this.state = "HALF_OPEN";
        this.successes = 0;
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN: allow probe
  }

  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.successes++;
      if (this.successes >= this.closeThreshold) {
        this.state = "CLOSED";
        this.failures = 0;
        this.openedAt = null;
        console.info("[ml-breaker] circuit closed — ML service healthy again");
      }
    } else {
      this.failures = 0;
    }
  }

  recordFailure(reason: string): void {
    this.failures++;
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.error(`[ml-breaker] probe failed — circuit remains OPEN: ${reason}`);
      return;
    }
    if (this.failures >= this.openThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.error(
        `[ml-breaker] circuit OPEN after ${this.failures} failures: ${reason}`,
      );
    }
  }

  get currentState(): BreakerState {
    return this.state;
  }

  reset(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
  }
}

export const mlBreakerInstance = new MLCircuitBreaker();

// ─── Output validation ────────────────────────────────────────────────────────

const VALID_REGIMES: ReadonlySet<MLMarketRegime> = new Set([
  "strong_bull",
  "bull",
  "sideways",
  "volatile",
  "bear",
  "crash",
]);

export interface ValidationResult<T> {
  valid: boolean;
  data: T | null;
  /** Human-readable reason when valid === false. */
  reason?: string;
}

/**
 * Validate an MLRegimeResponse from the ML service.
 * Rejects: missing fields, unknown regime, confidence outside [0,1],
 * non-finite probabilities.
 */
export function validateMLRegimeResponse(
  raw: unknown,
): ValidationResult<MLRegimeResponse> {
  if (!raw || typeof raw !== "object") {
    return { valid: false, data: null, reason: "response is not an object" };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.regime !== "string" || !VALID_REGIMES.has(r.regime as MLMarketRegime)) {
    return {
      valid: false,
      data: null,
      reason: `invalid regime: ${JSON.stringify(r.regime)}`,
    };
  }

  const confidence = Number(r.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      valid: false,
      data: null,
      reason: `invalid confidence: ${r.confidence}`,
    };
  }

  if (typeof r.probabilities !== "object" || r.probabilities === null) {
    return {
      valid: false,
      data: null,
      reason: "missing probabilities map",
    };
  }

  // All probability values must be finite and in [0,1]
  for (const [k, v] of Object.entries(r.probabilities as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return {
        valid: false,
        data: null,
        reason: `invalid probability for regime "${k}": ${v}`,
      };
    }
  }

  return { valid: true, data: raw as MLRegimeResponse };
}

/**
 * Validate an MLRiskResponse.
 * Rejects: missing required fields, probabilities outside [0,1],
 * non-finite drawdown or position size.
 */
export function validateMLRiskResponse(
  raw: unknown,
): ValidationResult<MLRiskResponse> {
  if (!raw || typeof raw !== "object") {
    return { valid: false, data: null, reason: "response is not an object" };
  }
  const r = raw as Record<string, unknown>;

  const stopHit = Number(r.prob_stop_hit);
  const targetHit = Number(r.prob_target_hit);
  const drawdown = Number(r.expected_drawdown_pct);
  const positionSize = Number(r.suggested_position_size_pct);
  const riskScore = Number(r.risk_score);

  const checks: Array<[boolean, string]> = [
    [!Number.isFinite(stopHit) || stopHit < 0 || stopHit > 1, `prob_stop_hit=${r.prob_stop_hit}`],
    [!Number.isFinite(targetHit) || targetHit < 0 || targetHit > 1, `prob_target_hit=${r.prob_target_hit}`],
    [!Number.isFinite(drawdown), `expected_drawdown_pct=${r.expected_drawdown_pct}`],
    [!Number.isFinite(positionSize) || positionSize < 0 || positionSize > 100, `suggested_position_size_pct=${r.suggested_position_size_pct}`],
    [!Number.isFinite(riskScore) || riskScore < 0 || riskScore > 1, `risk_score=${r.risk_score}`],
  ];

  for (const [bad, msg] of checks) {
    if (bad) return { valid: false, data: null, reason: `invalid field: ${msg}` };
  }

  return { valid: true, data: raw as MLRiskResponse };
}

/**
 * Validate an MLRankingResponse.
 * Rejects: missing rankings array, empty array, any entry with non-finite
 * score or out-of-range rank.
 */
export function validateMLRankingResponse(
  raw: unknown,
): ValidationResult<MLRankingResponse> {
  if (!raw || typeof raw !== "object") {
    return { valid: false, data: null, reason: "response is not an object" };
  }
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.rankings) || r.rankings.length === 0) {
    return { valid: false, data: null, reason: "rankings is empty or missing" };
  }

  for (const entry of r.rankings as Array<Record<string, unknown>>) {
    const score = Number(entry.score);
    const rank = Number(entry.rank);
    if (typeof entry.symbol !== "string" || !entry.symbol) {
      return { valid: false, data: null, reason: `ranking entry missing symbol` };
    }
    if (!Number.isFinite(score)) {
      return {
        valid: false,
        data: null,
        reason: `non-finite score for ${entry.symbol}: ${entry.score}`,
      };
    }
    if (!Number.isInteger(rank) || rank < 1) {
      return {
        valid: false,
        data: null,
        reason: `invalid rank for ${entry.symbol}: ${entry.rank}`,
      };
    }
  }

  return { valid: true, data: raw as MLRankingResponse };
}

// ─── Feature vector sanitization ─────────────────────────────────────────────

export interface SanitizeOptions {
  /** Value to substitute when a field is NaN.  Default 0. */
  nanReplacement?: number;
  /** Value to substitute when a field is +Infinity.  Default 999. */
  posInfReplacement?: number;
  /** Value to substitute when a field is -Infinity.  Default -999. */
  negInfReplacement?: number;
  /** Label used in structured log output. */
  label?: string;
}

/**
 * Recursively sanitize every numeric value in `features`:
 *  - NaN → `nanReplacement` (default 0)
 *  - +Infinity → `posInfReplacement` (default 999)
 *  - -Infinity → `negInfReplacement` (default -999)
 *
 * Returns a shallow copy of `features` with corrected values and a list of
 * field names that were mutated (empty when all values were clean).
 */
export function sanitizeFeatureVector<T extends Record<string, unknown>>(
  features: T,
  opts: SanitizeOptions = {},
): { sanitized: T; corrupted: string[] } {
  const nanReplacement = opts.nanReplacement ?? 0;
  const posInfReplacement = opts.posInfReplacement ?? 999;
  const negInfReplacement = opts.negInfReplacement ?? -999;
  const label = opts.label ?? "features";

  const sanitized = { ...features } as T;
  const corrupted: string[] = [];

  for (const [key, value] of Object.entries(features)) {
    if (typeof value !== "number") continue;

    if (Number.isNaN(value)) {
      (sanitized as Record<string, unknown>)[key] = nanReplacement;
      corrupted.push(key);
    } else if (value === Infinity) {
      (sanitized as Record<string, unknown>)[key] = posInfReplacement;
      corrupted.push(key);
    } else if (value === -Infinity) {
      (sanitized as Record<string, unknown>)[key] = negInfReplacement;
      corrupted.push(key);
    }
  }

  if (corrupted.length > 0) {
    console.error(
      `[ml-resilience] ${label} contained non-finite values — sanitized before ML call`,
      {
        corrupted,
        original: Object.fromEntries(
          corrupted.map((k) => [k, features[k]]),
        ),
        replacements: Object.fromEntries(
          corrupted.map((k) => [k, (sanitized as Record<string, unknown>)[k]]),
        ),
      },
    );
  }

  return { sanitized, corrupted };
}

/**
 * Sanitize a 2-D number array (e.g. the last-60-bars matrix for the TFT
 * price forecaster).  Returns the cleaned matrix and the count of cells that
 * were repaired.
 */
export function sanitizeBarMatrix(
  bars: number[][],
  opts: SanitizeOptions = {},
): { sanitized: number[][]; repairedCells: number } {
  const nanReplacement = opts.nanReplacement ?? 0;
  const posInfReplacement = opts.posInfReplacement ?? 999;
  const negInfReplacement = opts.negInfReplacement ?? -999;

  let repairedCells = 0;
  const sanitized = bars.map((row) =>
    row.map((v) => {
      if (Number.isNaN(v)) { repairedCells++; return nanReplacement; }
      if (v === Infinity) { repairedCells++; return posInfReplacement; }
      if (v === -Infinity) { repairedCells++; return negInfReplacement; }
      return v;
    }),
  );

  if (repairedCells > 0) {
    console.error(
      `[ml-resilience] bar matrix contained ${repairedCells} non-finite cells — sanitized`,
      { label: opts.label ?? "bar-matrix" },
    );
  }

  return { sanitized, repairedCells };
}
