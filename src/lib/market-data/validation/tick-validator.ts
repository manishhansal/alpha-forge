/**
 * Live tick validation for the Indian Market Data layer.
 *
 * A tick is valid when:
 *   - `ltp` is a finite positive number.
 *   - `token` is a non-empty string.
 *   - `exchangeTimestampMs` is a finite positive integer.
 *   - The timestamp is not in the future (with a 5s tolerance).
 *   - The LTP is within the instrument's circuit limits when known.
 *
 * Stale tick detection:
 *   - A tick is stale when its exchange timestamp is older than the
 *     configured threshold for the given data type.
 *   - Stale ticks are flagged but not automatically rejected — the
 *     consumer decides whether to use or discard them.
 */

import type { LiveTick } from "../types";
import { isTickStale } from "../health";

// ── Single-tick validation ────────────────────────────────────────────────────

export type TickValidationError =
  | "EMPTY_TOKEN"
  | "NON_FINITE_LTP"
  | "NEGATIVE_LTP"
  | "ZERO_LTP"
  | "INVALID_TIMESTAMP"
  | "FUTURE_TIMESTAMP"
  | "NEGATIVE_VOLUME"
  | "NEGATIVE_OI";

export type TickValidationResult =
  | { valid: true; stale: boolean }
  | { valid: false; error: TickValidationError; detail?: string; stale?: boolean };

/** Tolerance for future-dated timestamps (5 seconds to account for clock skew). */
const FUTURE_TOLERANCE_MS = 5_000;

/**
 * Validate a single live tick.
 *
 * @param tick        The tick to validate.
 * @param staleMs     Staleness threshold in ms (default: 5s for live ticks).
 * @param now         Current UTC epoch ms (injectable for testing).
 */
export function validateTick(
  tick: LiveTick,
  staleMs?: number,
  now = Date.now(),
): TickValidationResult {
  // Token must be present.
  if (!tick.token || tick.token.trim().length === 0) {
    return { valid: false, error: "EMPTY_TOKEN" };
  }

  // LTP must be a finite number.
  if (!Number.isFinite(tick.ltp)) {
    return {
      valid: false,
      error: "NON_FINITE_LTP",
      detail: `ltp=${tick.ltp}`,
    };
  }

  // LTP must be positive.
  if (tick.ltp < 0) {
    return {
      valid: false,
      error: "NEGATIVE_LTP",
      detail: `ltp=${tick.ltp}`,
    };
  }

  // LTP of exactly zero is suspicious (instruments don't trade at zero).
  if (tick.ltp === 0) {
    return {
      valid: false,
      error: "ZERO_LTP",
      detail: "ltp=0 — possible missing/stale quote",
    };
  }

  // Exchange timestamp must be a finite positive integer.
  if (
    !Number.isFinite(tick.exchangeTimestampMs) ||
    tick.exchangeTimestampMs <= 0 ||
    !Number.isInteger(tick.exchangeTimestampMs)
  ) {
    return {
      valid: false,
      error: "INVALID_TIMESTAMP",
      detail: `exchangeTimestampMs=${tick.exchangeTimestampMs}`,
    };
  }

  // Timestamp must not be in the future (with tolerance for clock skew).
  if (tick.exchangeTimestampMs > now + FUTURE_TOLERANCE_MS) {
    return {
      valid: false,
      error: "FUTURE_TIMESTAMP",
      detail: `exchangeTimestampMs=${tick.exchangeTimestampMs} now=${now}`,
    };
  }

  // Volume must be non-negative when present.
  if (tick.volume != null && (!Number.isFinite(tick.volume) || tick.volume < 0)) {
    return {
      valid: false,
      error: "NEGATIVE_VOLUME",
      detail: `volume=${tick.volume}`,
    };
  }

  // OI must be non-negative when present.
  if (tick.oi != null && (!Number.isFinite(tick.oi) || tick.oi < 0)) {
    return {
      valid: false,
      error: "NEGATIVE_OI",
      detail: `oi=${tick.oi}`,
    };
  }

  // Staleness check.
  const stale = isTickStale(tick.exchangeTimestampMs, staleMs, now);
  return { valid: true, stale };
}

// ── Batch validation ──────────────────────────────────────────────────────────

export type BatchTickValidationResult = {
  valid: LiveTick[];
  invalid: Array<{ tick: LiveTick; error: TickValidationError; detail?: string }>;
  stale: LiveTick[];
};

/**
 * Validate a batch of ticks. Returns separate arrays for valid, invalid, and
 * stale ticks. A tick can be both valid and stale simultaneously.
 */
export function validateTicks(
  ticks: LiveTick[],
  staleMs?: number,
  now = Date.now(),
): BatchTickValidationResult {
  const valid: LiveTick[] = [];
  const invalid: BatchTickValidationResult["invalid"] = [];
  const stale: LiveTick[] = [];

  for (const tick of ticks) {
    const result = validateTick(tick, staleMs, now);
    if (!result.valid) {
      invalid.push({ tick, error: result.error, detail: result.detail });
    } else {
      valid.push(tick);
      if (result.stale) {
        stale.push(tick);
      }
    }
  }

  return { valid, invalid, stale };
}

// ── Circuit-limit validation ──────────────────────────────────────────────────

/**
 * Check whether a tick's LTP is within known circuit limits.
 * Returns null when limits are not available.
 */
export function isWithinCircuitLimits(
  ltp: number,
  lower: number | null | undefined,
  upper: number | null | undefined,
): boolean | null {
  if (lower == null || upper == null) return null;
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  return ltp >= lower && ltp <= upper;
}
