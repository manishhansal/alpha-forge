/**
 * Candle-fed ports of the three price/volume NSE scanners so they can be
 * backtested on historical daily OHLCV (the option-chain scanners — PCR,
 * IV, OI build-up — and the two positioning strategies have no historical
 * data source, so they're scored off the live paper-trade record instead).
 *
 * Each module re-implements the live scanner's logic against a trailing
 * candle window and returns a directional signal with ATR-sized levels.
 * Pure + I/O-free so the backtester can be unit-tested with fixed candles.
 */

import { atrFromCandles } from "@/features/india/scalping/paper-trader-core";
import type { IndiaScalpDirection } from "@/features/india/scalping/types";
import type { Candle } from "@/types/india";

/** The subset of strategy ids that are derivable from price/volume alone. */
export type IndiaPriceStrategyId =
  | "RANGE_EXPANSION"
  | "MOMENTUM"
  | "VOLUME_BREAKOUT";

export interface IndiaPriceSignal {
  direction: IndiaScalpDirection;
  entry: number;
  stopLoss: number;
  target: number;
  confidence: number;
  /** Candle `time` (seconds) the signal fired on. */
  triggeredAtSec: number;
}

export interface IndiaPriceStrategyModule {
  id: IndiaPriceStrategyId;
  /** Minimum candles the module needs before it can emit a signal. */
  warmup: number;
  run(window: ReadonlyArray<Candle>): IndiaPriceSignal | null;
}

/** Stop = 1× ATR, target = 2× ATR → 2:1 reward / risk. */
const SL_ATR_MULT = 1;
const TP_ATR_MULT = 2;
/** Momentum: minimum |1-bar return| (%) to call it a momentum day. */
const MOMENTUM_MIN_PCT = 2.5;
/** Volume breakout: ratio over the 20-bar average that counts as a break. */
const VOL_BREAKOUT_RATIO = 1.5;
const VOL_BREAKOUT_MIN_PCT = 1;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  return avg(closes.slice(-period));
}

/** Build ATR-sized levels around `entry`. ATR falls back to 1% of price. */
function levels(
  window: ReadonlyArray<Candle>,
  entry: number,
  direction: IndiaScalpDirection,
): { stopLoss: number; target: number } {
  const atr = atrFromCandles(window, 14) ?? entry * 0.01;
  const risk = Math.max(atr * SL_ATR_MULT, entry * 0.001);
  const reward = atr * TP_ATR_MULT;
  const isLong = direction === "LONG";
  return {
    stopLoss: isLong ? entry - risk : entry + risk,
    target: isLong ? entry + reward : entry - reward,
  };
}

export const momentumModule: IndiaPriceStrategyModule = {
  id: "MOMENTUM",
  warmup: 16,
  run(window) {
    const n = window.length;
    if (n < this.warmup) return null;
    const last = window[n - 1];
    const prev = window[n - 2];
    if (!last || !prev || prev.close <= 0) return null;

    const retPct = ((last.close - prev.close) / prev.close) * 100;
    if (Math.abs(retPct) < MOMENTUM_MIN_PCT) return null;

    const direction: IndiaScalpDirection = retPct > 0 ? "LONG" : "SHORT";
    const { stopLoss, target } = levels(window, last.close, direction);
    return {
      direction,
      entry: last.close,
      stopLoss,
      target,
      confidence: 0.4 + clamp01(Math.abs(retPct) / 6) * 0.5,
      triggeredAtSec: last.time,
    };
  },
};

export const volumeBreakoutModule: IndiaPriceStrategyModule = {
  id: "VOLUME_BREAKOUT",
  warmup: 22,
  run(window) {
    const n = window.length;
    if (n < this.warmup) return null;
    const last = window[n - 1];
    const prev = window[n - 2];
    if (!last || !prev || prev.close <= 0) return null;

    const prior = window.slice(-21, -1).map((c) => c.volume ?? 0).filter((v) => v > 0);
    const avgVol = avg(prior);
    const lastVol = last.volume ?? 0;
    if (avgVol <= 0 || lastVol <= 0) return null;
    const ratio = lastVol / avgVol;
    const retPct = ((last.close - prev.close) / prev.close) * 100;
    if (ratio < VOL_BREAKOUT_RATIO || Math.abs(retPct) < VOL_BREAKOUT_MIN_PCT) {
      return null;
    }

    const direction: IndiaScalpDirection = retPct >= 0 ? "LONG" : "SHORT";
    const { stopLoss, target } = levels(window, last.close, direction);
    return {
      direction,
      entry: last.close,
      stopLoss,
      target,
      confidence: 0.4 + clamp01((ratio - VOL_BREAKOUT_RATIO) / 2.5) * 0.5,
      triggeredAtSec: last.time,
    };
  },
};

function startOfWeekSec(lastSec: number): number {
  const d = new Date(lastSec * 1000);
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  const monday =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
    dow * 86_400_000;
  return Math.floor(monday / 1000);
}

function startOfMonthSec(lastSec: number): number {
  const d = new Date(lastSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

/**
 * Range Expansion — candle port of `evaluateRangeExpansion` in the scanner
 * engine: today's H−L is the widest of the prior 7 sessions, bullish
 * daily/weekly/monthly close, SMA 20>50>200 stack, vol ≥ 1.5× 20-day avg,
 * close in the upper half of the range. LONG-only (the live scanner is too).
 */
export const rangeExpansionModule: IndiaPriceStrategyModule = {
  id: "RANGE_EXPANSION",
  warmup: 205,
  run(window) {
    const n = window.length;
    if (n < this.warmup) return null;
    const last = window[n - 1];
    const prev = window[n - 2];
    if (!last || !prev) return null;

    const todayRange = last.high - last.low;
    const prev7 = window.slice(-8, -1);
    if (prev7.length < 7) return null;
    const prev7MaxRange = Math.max(...prev7.map((c) => c.high - c.low));
    if (todayRange <= 0 || prev7MaxRange <= 0) return null;
    if (todayRange < prev7MaxRange * 1.2) return null;

    if (!(last.close > last.open)) return null;
    if (!(last.close > prev.close)) return null;

    const weekStart = startOfWeekSec(last.time);
    const week = window.filter((c) => c.time >= weekStart);
    if (week.length === 0 || !(last.close > week[0].open)) return null;
    const monthStart = startOfMonthSec(last.time);
    const month = window.filter((c) => c.time >= monthStart);
    if (month.length === 0 || !(last.close > month[0].open)) return null;

    const closes = window.map((c) => c.close);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    if (sma20 == null || sma50 == null || sma200 == null) return null;
    if (!(sma20 > sma50 && sma50 > sma200)) return null;

    const vols = window.slice(-21, -1).map((c) => c.volume ?? 0).filter((v) => v > 0);
    const avgVol20 = avg(vols);
    if (avgVol20 <= 0) return null;
    const volRatio = (last.volume ?? 0) / avgVol20;
    if (volRatio < 1.5) return null;

    const closeStrength = (last.close - last.low) / todayRange;
    if (closeStrength < 0.5) return null;

    const rangeRatio = todayRange / prev7MaxRange;
    const { stopLoss, target } = levels(window, last.close, "LONG");
    const rawScore = rangeRatio * volRatio * (0.5 + closeStrength);
    return {
      direction: "LONG",
      entry: last.close,
      stopLoss,
      target,
      confidence: 0.5 + clamp01((rawScore - 2) / 8) * 0.45,
      triggeredAtSec: last.time,
    };
  },
};

export const INDIA_PRICE_STRATEGY_MODULES: Record<
  IndiaPriceStrategyId,
  IndiaPriceStrategyModule
> = {
  RANGE_EXPANSION: rangeExpansionModule,
  MOMENTUM: momentumModule,
  VOLUME_BREAKOUT: volumeBreakoutModule,
};
