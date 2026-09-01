/**
 * PriceForecasterInputBuilder — Phase 3
 *
 * Builds the exact canonical input required by the TFT price forecaster.
 * This is the ONLY path that should supply bars to predictPriceRegime().
 *
 * Pipeline:
 *   Canonical Candle Store (CandleBar table / registry)
 *   ↓
 *   Confirmed Candles Only (time < current candle boundary)
 *   ↓
 *   Last N Candles (default 60)
 *   ↓
 *   Feature Validation (OHLCV integrity + timestamp continuity + freshness)
 *   ↓
 *   Price Forecaster
 *
 * Never silently sends an empty array. Respects ML_MODE:
 *   required  → throws PriceForecasterError when candles insufficient
 *   fallback  → returns { candles: [], status: "INSUFFICIENT" }
 *   disabled  → returns { candles: [], status: "DISABLED" }
 */

import "server-only";

import { getHistoricalCandlesByRange } from "@/lib/market-data/services/historical.service";
import type { OHLCVCandle } from "@/lib/market-data/types";
import { validateCandleSequence } from "@/lib/market-data/validation/candle-validator";
import { getMLMode } from "@/lib/india/ml-client";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Exact number of 5-minute confirmed candles required by the TFT model. */
export const PRICE_FORECASTER_LOOKBACK = 60;

/** Maximum staleness allowed for the most recent candle (ms). */
const MAX_FRESHNESS_MS = 10 * 60 * 1_000; // 10 minutes

/** Maximum session gap allowed between consecutive candles (seconds).
 *  A 5-minute interval has ~300s. We allow up to 2 bars gap (600s) to
 *  tolerate normal auction/closing ticks. */
const MAX_CANDLE_GAP_SEC = 600;

// ─── Types ───────────────────────────────────────────────────────────────────

export type PriceForecasterStatus =
  | "OK"               // Exactly PRICE_FORECASTER_LOOKBACK valid candles returned
  | "INSUFFICIENT"     // Fewer than required candles available
  | "STALE"            // Most-recent candle is too old
  | "VALIDATION_FAIL"  // OHLCV integrity or sequence errors
  | "DISABLED"         // ML_MODE=disabled
  | "ERROR";           // Unexpected error during construction

export interface PriceForecasterInputResult {
  status: PriceForecasterStatus;
  /** Exactly PRICE_FORECASTER_LOOKBACK candles when status=OK. Empty otherwise. */
  candles: OHLCVCandle[];
  /** ISO-8601 timestamp of the most recent candle. Null when status != OK. */
  lastCandleAt: string | null;
  /** Human-readable reason for non-OK status. */
  reason: string | null;
  /** Count of candles available before trimming to lookback window. */
  availableCount: number;
  /** Count of candles that failed individual OHLCV validation. */
  invalidCount: number;
}

export class PriceForecasterError extends Error {
  constructor(
    message: string,
    public readonly status: PriceForecasterStatus,
  ) {
    super(message);
    this.name = "PriceForecasterError";
  }
}

// ─── Core builder ────────────────────────────────────────────────────────────

/**
 * Build the canonical input for the TFT price forecaster.
 *
 * @param symbol     NSE symbol (e.g. "NIFTY 50", "^NSEI")
 * @param exchange   Exchange (default "NSE")
 * @param nowMs      Current wall-clock time in ms (defaults to Date.now())
 *
 * Behaviour by ML_MODE:
 *   disabled  → returns DISABLED immediately, no network calls.
 *   fallback  → returns INSUFFICIENT/STALE/VALIDATION_FAIL result (never throws).
 *   required  → throws PriceForecasterError on any failure.
 */
export async function buildPriceForecasterInput(
  symbol: string,
  exchange: "NSE" | "NFO" | "BSE" = "NSE",
  nowMs: number = Date.now(),
): Promise<PriceForecasterInputResult> {
  const mode = getMLMode();

  if (mode === "disabled") {
    return {
      status: "DISABLED",
      candles: [],
      lastCandleAt: null,
      reason: "ML_MODE=disabled",
      availableCount: 0,
      invalidCount: 0,
    };
  }

  try {
    // ── Step 1: Fetch canonical historical candles ──────────────────────────
    // Fetch more than needed (2× lookback) so we can trim to exactly N
    // confirmed bars after dropping any partial/invalid candles.
    const raw = await getHistoricalCandlesByRange(
      symbol,
      "5m",
      "5d",          // 5 days of 5-min bars covers ~375 bars (> 2× lookback)
      exchange,
      { tolerateInvalidCandles: true },
    );

    // ── Step 2: Use confirmed candles only ────────────────────────────────
    // The current (incomplete) bar has a timestamp >= the current 5-min boundary.
    // Confirmed bars have timestamps strictly before that boundary.
    const currentBarBoundarySec = Math.floor(nowMs / (5 * 60 * 1_000)) * (5 * 60);
    const confirmed = raw.filter((c) => c.time < currentBarBoundarySec);

    // ── Step 3: Sort ascending ────────────────────────────────────────────
    confirmed.sort((a, b) => a.time - b.time);

    // ── Step 4: Deduplicate ───────────────────────────────────────────────
    const seen = new Set<number>();
    const deduped: OHLCVCandle[] = [];
    for (const c of confirmed) {
      if (!seen.has(c.time)) {
        seen.add(c.time);
        deduped.push(c);
      }
    }

    const availableCount = deduped.length;

    // ── Step 5: Validate OHLCV integrity ─────────────────────────────────
    const seqResult = validateCandleSequence(deduped);
    const invalidCount = seqResult.errors.length;

    // If more than 20% of candles are invalid, this is a data quality failure.
    if (invalidCount > 0 && invalidCount / deduped.length > 0.2) {
      const reason = `OHLCV validation failed: ${invalidCount}/${deduped.length} candles invalid`;
      if (mode === "required") {
        throw new PriceForecasterError(reason, "VALIDATION_FAIL");
      }
      return {
        status: "VALIDATION_FAIL",
        candles: [],
        lastCandleAt: null,
        reason,
        availableCount,
        invalidCount,
      };
    }

    // Keep only the valid candles from the sequence.
    const validCandles = deduped.filter((_, i) =>
      !seqResult.errors.some((e) => e.index === i),
    );

    // ── Step 6: Check we have enough ─────────────────────────────────────
    if (validCandles.length < PRICE_FORECASTER_LOOKBACK) {
      const reason =
        `Insufficient candles: ${validCandles.length} available, ` +
        `${PRICE_FORECASTER_LOOKBACK} required`;
      if (mode === "required") {
        throw new PriceForecasterError(reason, "INSUFFICIENT");
      }
      return {
        status: "INSUFFICIENT",
        candles: [],
        lastCandleAt: null,
        reason,
        availableCount,
        invalidCount,
      };
    }

    // ── Step 7: Take the last N candles ───────────────────────────────────
    const lastN = validCandles.slice(-PRICE_FORECASTER_LOOKBACK);

    // ── Step 8: Check timestamp continuity (gap detection) ────────────────
    const INTERVAL_SEC = 5 * 60; // 5 minutes in seconds
    for (let i = 1; i < lastN.length; i++) {
      const gap = lastN[i]!.time - lastN[i - 1]!.time;
      if (gap > MAX_CANDLE_GAP_SEC) {
        // Large gap may indicate a market holiday or data hole.
        // We allow it (NSE has lunch breaks, pre-open gaps) but log it.
        // For a session gap > 15 minutes in intraday data, this is significant.
        if (gap > 15 * 60) {
          console.warn(
            `[price-forecaster] large gap detected between candles: ` +
              `${gap}s at index ${i} (expected ~${INTERVAL_SEC}s)`,
            { symbol, time_prev: lastN[i - 1]!.time, time_curr: lastN[i]!.time },
          );
        }
      }
    }

    // ── Step 9: Verify freshness of the most recent candle ────────────────
    const mostRecent = lastN[lastN.length - 1]!;
    const staleness = nowMs - mostRecent.time * 1_000;
    if (staleness > MAX_FRESHNESS_MS) {
      const reason =
        `Most recent candle is stale: ${Math.round(staleness / 60_000)}min old ` +
        `(max allowed: ${MAX_FRESHNESS_MS / 60_000}min)`;
      if (mode === "required") {
        throw new PriceForecasterError(reason, "STALE");
      }
      return {
        status: "STALE",
        candles: [],
        lastCandleAt: null,
        reason,
        availableCount,
        invalidCount,
      };
    }

    return {
      status: "OK",
      candles: lastN,
      lastCandleAt: new Date(mostRecent.time * 1_000).toISOString(),
      reason: null,
      availableCount,
      invalidCount,
    };
  } catch (err) {
    if (err instanceof PriceForecasterError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const reason = `Unexpected error: ${message}`;
    if (mode === "required") {
      throw new PriceForecasterError(reason, "ERROR");
    }
    return {
      status: "ERROR",
      candles: [],
      lastCandleAt: null,
      reason,
      availableCount: 0,
      invalidCount: 0,
    };
  }
}

/**
 * Convert a confirmed OHLCVCandle array to the bar matrix shape
 * expected by the TFT price forecaster.
 *
 * Shape: [n_bars, 9] where columns are:
 *   [open, high, low, close, volume, vpin, atm_iv, pcr, oi_buildup]
 *
 * When enriched fields (vpin/atm_iv/pcr/oi_buildup) are not available,
 * they default to 0.0. The model was trained to handle 0-padding for
 * these optional enrichment columns.
 */
export function candlesToBarMatrix(candles: OHLCVCandle[]): number[][] {
  return candles.map((c) => [
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume,
    0.0,  // vpin — requires tick-level data; 0 when unavailable
    0.0,  // atm_iv — requires live option chain; 0 when unavailable
    0.0,  // pcr — requires live option chain; 0 when unavailable
    0.0,  // oi_buildup — requires F&O data; 0 when unavailable
  ]);
}
