/**
 * Shared, client-safe definitions for the multi-timeframe strategy backtest
 * suite. Both the server-only runner (`run-all-backtests.ts`) and the client
 * context / panel import from here so the runtime config never drags the
 * `"server-only"` module into the browser bundle.
 */

import type { KlineInterval } from "@/services/binance/klines";

/**
 * The 1m..1d intervals exposed to the UI. `10m` is synthesized from 5m bars
 * (Binance doesn't natively offer it); everything else is a direct kline
 * interval on both the active broker and the Binance fallback.
 */
export const BACKTEST_INTERVAL_OPTIONS = [
  "1m",
  "5m",
  "10m",
  "15m",
  "1h",
  "4h",
  "1d",
] as const;

export type BacktestInterval = (typeof BACKTEST_INTERVAL_OPTIONS)[number];

/** Default bar size the cold-start suite computes for the Scalper page's
 *  strategy chips. The dedicated Strategy Backtest page defaults to 5m. */
export const BACKTEST_INTERVAL_DEFAULT: BacktestInterval = "4h";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BacktestIntervalConfig {
  /** The underlying kline interval to fetch (10m is fetched as 5m, then aggregated). */
  fetchInterval: KlineInterval;
  /** If set, every N raw bars are aggregated into one output bar. */
  aggregateEvery?: number;
  /** Lookback window for this interval, in milliseconds. */
  periodMs: number;
  /** Human-friendly period label (e.g. "30 days", "5 years"). */
  periodLabel: string;
  /** Display label for the interval picker. */
  intervalLabel: string;
}

/**
 * Per-interval lookback configuration. Every entry is sized so each symbol
 * yields ≤ ~11k candles — well under the 20-page broker cap and inside the
 * comfortable performance envelope of the backtest engine.
 */
export const BACKTEST_INTERVAL_CONFIG: Record<BacktestInterval, BacktestIntervalConfig> = {
  "1m": {
    fetchInterval: "1m",
    periodMs: 7 * DAY_MS,
    periodLabel: "7 days",
    intervalLabel: "1 minute",
  },
  "5m": {
    fetchInterval: "5m",
    periodMs: 30 * DAY_MS,
    periodLabel: "30 days",
    intervalLabel: "5 minutes",
  },
  "10m": {
    fetchInterval: "5m",
    aggregateEvery: 2,
    periodMs: 60 * DAY_MS,
    periodLabel: "60 days",
    intervalLabel: "10 minutes",
  },
  "15m": {
    fetchInterval: "15m",
    periodMs: 90 * DAY_MS,
    periodLabel: "90 days",
    intervalLabel: "15 minutes",
  },
  "1h": {
    fetchInterval: "1h",
    periodMs: 365 * DAY_MS,
    periodLabel: "1 year",
    intervalLabel: "1 hour",
  },
  "4h": {
    fetchInterval: "4h",
    periodMs: 5 * 365 * DAY_MS,
    periodLabel: "5 years",
    intervalLabel: "4 hours",
  },
  "1d": {
    fetchInterval: "1d",
    periodMs: 5 * 365 * DAY_MS,
    periodLabel: "5 years",
    intervalLabel: "1 day",
  },
};

/** Backwards-compat — historically the suite always ran on 4h. */
export const BACKTEST_INTERVAL: KlineInterval = "4h";
export const BACKTEST_PERIOD_YEARS = 5;
