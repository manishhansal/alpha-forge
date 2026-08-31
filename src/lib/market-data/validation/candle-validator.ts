/**
 * Candle (OHLCV) validation for the Indian Market Data layer.
 *
 * A candle is valid when:
 *   - All OHLC values are finite positive numbers.
 *   - high >= max(open, close) and low <= min(open, close).
 *   - high >= low.
 *   - volume >= 0 (absent volume is treated as 0, not invalid).
 *   - Timestamp is a finite positive integer (UTC epoch seconds).
 *
 * A candle sequence is valid when:
 *   - All individual candles are valid.
 *   - Timestamps are strictly ascending.
 *   - No gaps larger than configurable threshold (optional check).
 */

import type { OHLCVCandle } from "../types";

// ── Single-candle validation ──────────────────────────────────────────────────

export type CandleValidationError =
  | "INVALID_TIMESTAMP"
  | "NON_FINITE_OHLC"
  | "NEGATIVE_PRICE"
  | "HIGH_BELOW_LOW"
  | "HIGH_BELOW_OPEN_OR_CLOSE"
  | "LOW_ABOVE_OPEN_OR_CLOSE"
  | "NEGATIVE_VOLUME";

export type CandleValidationResult =
  | { valid: true }
  | { valid: false; error: CandleValidationError; detail?: string };

/**
 * Validate a single OHLCV candle.
 */
export function validateCandle(candle: OHLCVCandle): CandleValidationResult {
  const { time, open, high, low, close, volume } = candle;

  // Timestamp must be a positive finite integer (UTC epoch seconds).
  if (!Number.isFinite(time) || time <= 0 || !Number.isInteger(time)) {
    return {
      valid: false,
      error: "INVALID_TIMESTAMP",
      detail: `time=${time}`,
    };
  }

  // All OHLC must be finite.
  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return {
      valid: false,
      error: "NON_FINITE_OHLC",
      detail: `o=${open} h=${high} l=${low} c=${close}`,
    };
  }

  // All prices must be positive.
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
    return {
      valid: false,
      error: "NEGATIVE_PRICE",
      detail: `o=${open} h=${high} l=${low} c=${close}`,
    };
  }

  // high must be >= low.
  if (high < low) {
    return {
      valid: false,
      error: "HIGH_BELOW_LOW",
      detail: `high=${high} low=${low}`,
    };
  }

  // high must be >= both open and close.
  if (high < open || high < close) {
    return {
      valid: false,
      error: "HIGH_BELOW_OPEN_OR_CLOSE",
      detail: `high=${high} open=${open} close=${close}`,
    };
  }

  // low must be <= both open and close.
  if (low > open || low > close) {
    return {
      valid: false,
      error: "LOW_ABOVE_OPEN_OR_CLOSE",
      detail: `low=${low} open=${open} close=${close}`,
    };
  }

  // Volume must be non-negative when present.
  if (volume != null && (!Number.isFinite(volume) || volume < 0)) {
    return {
      valid: false,
      error: "NEGATIVE_VOLUME",
      detail: `volume=${volume}`,
    };
  }

  return { valid: true };
}

// ── Sequence validation ───────────────────────────────────────────────────────

export type SequenceValidationError = {
  index: number;
  error: CandleValidationError | "TIMESTAMP_NOT_ASCENDING" | "DUPLICATE_TIMESTAMP";
  detail?: string;
};

export type SequenceValidationResult = {
  valid: boolean;
  errors: SequenceValidationError[];
  /** Number of candles that passed validation. */
  validCount: number;
};

/**
 * Validate an entire candle series.
 *
 * - Validates each candle individually.
 * - Checks that timestamps are strictly ascending.
 * - Returns a full list of errors (not just the first) so the caller can
 *   decide whether to reject the whole series or trim bad candles.
 */
export function validateCandleSequence(candles: OHLCVCandle[]): SequenceValidationResult {
  const errors: SequenceValidationError[] = [];
  let prevTime: number | null = null;
  let validCount = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const result = validateCandle(candle);

    if (!result.valid) {
      errors.push({ index: i, error: result.error, detail: result.detail });
      continue;
    }

    if (prevTime !== null) {
      if (candle.time === prevTime) {
        errors.push({
          index: i,
          error: "DUPLICATE_TIMESTAMP",
          detail: `time=${candle.time}`,
        });
        continue;
      }
      if (candle.time < prevTime) {
        errors.push({
          index: i,
          error: "TIMESTAMP_NOT_ASCENDING",
          detail: `time=${candle.time} prevTime=${prevTime}`,
        });
        continue;
      }
    }

    prevTime = candle.time;
    validCount++;
  }

  return {
    valid: errors.length === 0,
    errors,
    validCount,
  };
}

/**
 * Filter a candle array, dropping any candles that fail validation.
 * Returns only valid candles with strictly ascending timestamps.
 */
export function filterValidCandles(candles: OHLCVCandle[]): OHLCVCandle[] {
  const out: OHLCVCandle[] = [];
  let prevTime = -Infinity;
  for (const c of candles) {
    const r = validateCandle(c);
    if (r.valid && c.time > prevTime) {
      out.push(c);
      prevTime = c.time;
    }
  }
  return out;
}
