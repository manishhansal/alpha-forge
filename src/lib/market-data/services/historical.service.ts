/**
 * Historical candle service.
 *
 * Single entry point for fetching OHLCV candles. Consumers (strategy engine,
 * ML services, API routes) call this — never call Angel One / Upstox / Yahoo
 * directly.
 *
 * Routing rules:
 *   - F&O instruments (NFO/BFO): Angel One first, Upstox fallback.
 *   - NSE equities intraday:     Angel One → Upstox → Yahoo.
 *   - NSE equities daily/weekly: Angel One → Upstox → Yahoo.
 *   - Weekly+ intervals:         Yahoo only (Angel One has no weekly candles).
 */

import { registry } from "../registry";
import type { HistoricalCandleRequest, OHLCVCandle } from "../types";
import type { ProviderCallOptions } from "../provider";
import { filterValidCandles } from "../validation/candle-validator";

export type HistoricalOptions = ProviderCallOptions & {
  /**
   * When true, invalid candles are silently filtered out instead of causing
   * a provider switch. Default false (invalid candles trigger failover).
   */
  tolerateInvalidCandles?: boolean;
};

/**
 * Fetch historical OHLCV candles for an instrument.
 *
 * Returns an empty array when no provider can serve the request (never throws
 * so calling code stays simple). Log noise is handled inside the failover engine.
 */
export async function getHistoricalCandles(
  req: HistoricalCandleRequest,
  opts?: HistoricalOptions,
): Promise<OHLCVCandle[]> {
  try {
    const candles = await registry.getHistoricalCandles(req, opts);
    if (opts?.tolerateInvalidCandles) {
      return filterValidCandles(candles);
    }
    return candles;
  } catch {
    return [];
  }
}

/**
 * Convenience: fetch candles using a range string (e.g. "1d", "5d", "1mo")
 * instead of explicit from/to ISO strings.
 */
export async function getHistoricalCandlesByRange(
  symbol: string,
  interval: HistoricalCandleRequest["interval"],
  range: string,
  exchange: HistoricalCandleRequest["exchange"] = "NSE",
  opts?: HistoricalOptions,
): Promise<OHLCVCandle[]> {
  const now = Date.now();
  const fromMs = rangeToFromMs(range, now);
  const req: HistoricalCandleRequest = {
    symbol,
    exchange,
    interval,
    from: new Date(fromMs).toISOString(),
    to: new Date(now).toISOString(),
  };
  return getHistoricalCandles(req, opts);
}

function rangeToFromMs(range: string, now: number): number {
  const m = /^(\d+)(m|d|mo|y)$/.exec(range);
  if (!m) return now - 30 * 86_400_000;
  const n = Number(m[1]);
  const unit = m[2];
  const ms =
    unit === "m"
      ? n * 60_000
      : unit === "d"
        ? n * 86_400_000
        : unit === "mo"
          ? n * 30 * 86_400_000
          : n * 365 * 86_400_000;
  return now - ms;
}
