/**
 * feature-lookback.service.ts — Data Foundation V7 §4/§23.
 *
 * The single source of truth for HOW MUCH HISTORY each AlphaForge feature needs
 * before it may be computed. It replaces the old fixed "5-day backfill" with a
 * per-feature, per-timeframe requirement derived from the ACTUAL indicator
 * periods used across the codebase (grounded, not guessed):
 *
 *   - FnO trend scan warm-up floor: 30 daily bars (src/features/india/
 *     fno-trend-history/service.ts FNO_SCAN_WARMUP_BARS).
 *   - signals indicators: EMA20/EMA50, RSI14, MACD(12/26/9) — longest 50 bars
 *     (src/features/signals/indicators.ts).
 *   - scalping indicators: Wilder ATR(10), UT-Bot (src/features/scalping/
 *     indicators.ts).
 *   - ML context features: rsi_14, adx_14, macd_histogram, vwap_distance_pct,
 *     ema_stack_score (src/lib/india/ml-*.ts) — longest ~26 (MACD slow EMA).
 *
 * For each feature we record: name, timeframe, the raw indicator period, the
 * minimum VALID bars needed (period + settling), and a safety buffer. The
 * REQUIRED BARS a producer must have is the max over the features it consumes.
 *
 * This module is PURE (no I/O). `checkHistorySufficiency` (coverage.service)
 * consumes `requiredBars` and compares against REAL persisted bars — this file
 * only declares the requirement, never fabricates coverage.
 */

import type { Interval } from "../types";

/** A single feature's history requirement on a given timeframe. */
export interface FeatureLookback {
  /** Canonical feature name. */
  feature: string;
  /** Timeframe the feature is computed on. */
  timeframe: Interval;
  /** The dominant indicator period (bars) that drives the warm-up. */
  indicatorPeriod: number;
  /**
   * Minimum VALID bars before the feature is trustworthy. For EMA-family
   * indicators this is materially larger than the period (an EMA needs several
   * multiples of its span to settle); for SMA/rolling stats it is ~period.
   */
  requiredBars: number;
  /** Short note on where the period comes from. */
  source: string;
}

/**
 * EMA settling multiplier. An EMA with span N is only within ~1% of the true
 * value after roughly 3.45×N samples (ln(0.01)/ln(1-2/(N+1))). We use 3× as a
 * conservative, integer-friendly settling factor and then add the safety
 * buffer on top. SMA/rolling features use 1× (they are exact at N bars).
 */
const EMA_SETTLE_FACTOR = 3;

/** Default safety buffer added on top of the settled requirement (bars). */
export const DEFAULT_SAFETY_BUFFER_BARS = 20;

function emaBars(span: number): number {
  return Math.ceil(span * EMA_SETTLE_FACTOR);
}

/**
 * The canonical AlphaForge feature → lookback catalogue. Grouped by the
 * timeframe the feature is actually computed on. Values are grounded in the
 * indicator periods found in the codebase (see file header).
 */
export const FEATURE_LOOKBACKS: readonly FeatureLookback[] = [
  // ── Daily-timeframe features (FnO trend scan, daily picks) ────────────────
  { feature: "ema200_daily", timeframe: "1d", indicatorPeriod: 200, requiredBars: emaBars(200), source: "long-trend EMA200 (regime/trend context)" },
  { feature: "ema50_daily", timeframe: "1d", indicatorPeriod: 50, requiredBars: emaBars(50), source: "signals indicators ema50" },
  { feature: "ema20_daily", timeframe: "1d", indicatorPeriod: 20, requiredBars: emaBars(20), source: "signals indicators ema20" },
  { feature: "adx14_daily", timeframe: "1d", indicatorPeriod: 14, requiredBars: 14 * 2 + DEFAULT_SAFETY_BUFFER_BARS, source: "FnO trend scan ADX(14)" },
  { feature: "rsi14_daily", timeframe: "1d", indicatorPeriod: 14, requiredBars: 14 * 2, source: "FnO trend scan / signals RSI(14)" },
  { feature: "macd_daily", timeframe: "1d", indicatorPeriod: 26, requiredBars: emaBars(26), source: "MACD(12,26,9) slow EMA" },
  { feature: "atr14_daily", timeframe: "1d", indicatorPeriod: 14, requiredBars: 14 * 2, source: "FnO trend scan ATR(14) levels" },
  { feature: "volume_stats_daily", timeframe: "1d", indicatorPeriod: 20, requiredBars: 20, source: "20-day avg volume / rel-volume" },

  // ── Intraday scalp / signal features (5m primary) ─────────────────────────
  { feature: "ema200_5m", timeframe: "5m", indicatorPeriod: 200, requiredBars: emaBars(200), source: "5m trend EMA200" },
  { feature: "ema50_5m", timeframe: "5m", indicatorPeriod: 50, requiredBars: emaBars(50), source: "5m EMA50" },
  { feature: "vwap_5m", timeframe: "5m", indicatorPeriod: 75, requiredBars: 75, source: "session VWAP (full 09:15-15:30 → 75×5m bars)" },
  { feature: "atr10_5m", timeframe: "5m", indicatorPeriod: 10, requiredBars: 10 * 2, source: "scalping Wilder ATR(10) / UT-Bot" },
  { feature: "rsi14_5m", timeframe: "5m", indicatorPeriod: 14, requiredBars: 14 * 2, source: "5m RSI(14)" },
  { feature: "macd_5m", timeframe: "5m", indicatorPeriod: 26, requiredBars: emaBars(26), source: "5m MACD(12,26,9)" },

  // ── 15m / 30m / 1h context features ───────────────────────────────────────
  { feature: "ema50_15m", timeframe: "15m", indicatorPeriod: 50, requiredBars: emaBars(50), source: "15m EMA50 context" },
  { feature: "ema50_30m", timeframe: "30m", indicatorPeriod: 50, requiredBars: emaBars(50), source: "30m EMA50 context" },
  { feature: "ema50_1h", timeframe: "1h", indicatorPeriod: 50, requiredBars: emaBars(50), source: "1h EMA50 context" },

  // ── 1m micro-structure features ───────────────────────────────────────────
  { feature: "vwap_1m", timeframe: "1m", indicatorPeriod: 375, requiredBars: 375, source: "1m session VWAP (375 min = full session)" },
  { feature: "ema20_1m", timeframe: "1m", indicatorPeriod: 20, requiredBars: emaBars(20), source: "1m EMA20 micro-trend" },

  // ── 3m features ───────────────────────────────────────────────────────────
  { feature: "ema50_3m", timeframe: "3m", indicatorPeriod: 50, requiredBars: emaBars(50), source: "3m EMA50" },
];

/** NSE intraday bars per full trading session, by interval (09:15–15:30 IST). */
export const BARS_PER_SESSION: Partial<Record<Interval, number>> = {
  "1m": 375,
  "3m": 125,
  "5m": 75,
  "15m": 25,
  "30m": 13, // 12.5 → 13 (the 15:15–15:30 half-bar counts)
  "1h": 7, // 6.25 → 7
  "1d": 1,
};

export interface TimeframeRequirement {
  timeframe: Interval;
  /** The single largest requiredBars across all features on this timeframe. */
  requiredBars: number;
  /** With the safety buffer applied. */
  requiredBarsWithBuffer: number;
  /** Required sessions (ceil of requiredBarsWithBuffer / bars-per-session). */
  requiredSessions: number;
  /** The feature that drives the requirement. */
  drivingFeature: string;
}

/**
 * Compute the maximum lookback requirement per timeframe across ALL features.
 * This is what the backfill planner uses to decide how deep to go, and what a
 * producer's feature-warm-up gate uses as `requiredBars`.
 */
export function computeTimeframeRequirements(
  safetyBuffer = DEFAULT_SAFETY_BUFFER_BARS,
): TimeframeRequirement[] {
  const byTf = new Map<Interval, FeatureLookback>();
  for (const f of FEATURE_LOOKBACKS) {
    const cur = byTf.get(f.timeframe);
    if (!cur || f.requiredBars > cur.requiredBars) byTf.set(f.timeframe, f);
  }
  const out: TimeframeRequirement[] = [];
  for (const [tf, f] of byTf) {
    const withBuffer = f.requiredBars + safetyBuffer;
    const perSession = BARS_PER_SESSION[tf] ?? 1;
    out.push({
      timeframe: tf,
      requiredBars: f.requiredBars,
      requiredBarsWithBuffer: withBuffer,
      requiredSessions: Math.ceil(withBuffer / perSession),
      drivingFeature: f.feature,
    });
  }
  // Stable ordering by canonical interval.
  const order: Interval[] = ["1m", "3m", "5m", "15m", "30m", "1h", "1d"];
  out.sort((a, b) => order.indexOf(a.timeframe) - order.indexOf(b.timeframe));
  return out;
}

/** The required bars for a single timeframe (buffer included). */
export function requiredBarsForTimeframe(
  timeframe: Interval,
  safetyBuffer = DEFAULT_SAFETY_BUFFER_BARS,
): number {
  const req = computeTimeframeRequirements(safetyBuffer).find(
    (r) => r.timeframe === timeframe,
  );
  return req?.requiredBarsWithBuffer ?? 0;
}

/** The required trading sessions for a single timeframe (buffer included). */
export function requiredSessionsForTimeframe(
  timeframe: Interval,
  safetyBuffer = DEFAULT_SAFETY_BUFFER_BARS,
): number {
  const req = computeTimeframeRequirements(safetyBuffer).find(
    (r) => r.timeframe === timeframe,
  );
  return req?.requiredSessions ?? 0;
}

/**
 * Translate a timeframe's required sessions into a calendar-day backfill range
 * with headroom for weekends/holidays (~0.7 trading-day density). Used by the
 * backfill planner to pick a `from` date deep enough to satisfy the longest
 * feature. Never fewer than a floor so short-warm-up timeframes still get a
 * meaningful window.
 */
export function calendarDaysForTimeframe(
  timeframe: Interval,
  safetyBuffer = DEFAULT_SAFETY_BUFFER_BARS,
): number {
  const sessions = requiredSessionsForTimeframe(timeframe, safetyBuffer);
  // ~5 trading days per 7 calendar days → divide by (5/7); add a small pad.
  const calendar = Math.ceil((sessions * 7) / 5) + 3;
  return Math.max(calendar, 10);
}
