import type { IndicatorSnapshot, KlineCandle } from "@/types/market";

/**
 * Wilder's RSI(period). Uses smoothed averages.
 * Returns null when there isn't enough history.
 */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Full EMA series (length === values.length, with leading entries equal to values until SMA seed). */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const out: number[] = new Array(values.length);
  if (values.length < period) {
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      acc += values[i];
      out[i] = acc / (i + 1);
    }
    return out;
  }
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
    out[i] = i === period - 1 ? sum / period : NaN;
  }
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  // Backfill the leading NaNs with the SMA seed for callers that index by position.
  const seed = out[period - 1];
  for (let i = 0; i < period - 1; i++) out[i] = seed;
  return out;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const series = emaSeries(values, period);
  return series.at(-1) ?? null;
}

export interface MacdResult {
  line: number;
  signal: number;
  histogram: number;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdResult | null {
  if (closes.length < slow + signal) return null;
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  const macdLine: number[] = closes.map((_, i) => fastSeries[i] - slowSeries[i]);
  const signalSeries = emaSeries(macdLine, signal);
  const line = macdLine.at(-1) ?? 0;
  const sig = signalSeries.at(-1) ?? 0;
  return { line, signal: sig, histogram: line - sig };
}

/** Wilder's ATR(period). */
export function atr(candles: KlineCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    trs.push(tr);
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
  }
  return prev;
}

/**
 * Volume breakout = current volume / average volume over `period` previous bars.
 * > 1.5 == notable, > 2.5 == strong breakout.
 */
export function volumeBreakout(volumes: number[], period = 20): number | null {
  if (volumes.length < period + 1) return null;
  const window = volumes.slice(-period - 1, -1);
  const avg = window.reduce((a, b) => a + b, 0) / window.length;
  if (avg === 0) return null;
  return volumes.at(-1)! / avg;
}

export function computeIndicators(candles: KlineCandle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const macdResult = macd(closes);
  let emaCross: "bull" | "bear" | "none" = "none";
  if (e20 !== null && e50 !== null) {
    if (e20 > e50) emaCross = "bull";
    else if (e20 < e50) emaCross = "bear";
  }
  return {
    rsi14: rsi(closes, 14),
    ema20: e20,
    ema50: e50,
    emaCross,
    macdLine: macdResult?.line ?? null,
    macdSignal: macdResult?.signal ?? null,
    macdHistogram: macdResult?.histogram ?? null,
    atr14: atr(candles, 14),
    volumeBreakout: volumeBreakout(volumes, 20),
  };
}
