import type { KlineCandle } from "@/types/market";

/**
 * Shared scalping indicator pack. Kept separate from `indicators.ts` (which
 * houses the LuxAlgo-faithful UT Bot / SMC port) so the new strategy modules
 * can compose VWAP, RSI, EMA, Bollinger Bands, etc. without dragging in
 * UT-Bot-specific machinery.
 *
 * Every helper returns a series aligned 1:1 with the input — warm-up bars
 * carry NaN-free seed values (typically the running mean or first close) so
 * callers can index by bar without null checks. Each strategy guards on a
 * per-indicator warm-up window before firing.
 */

// ───────────────────────────────────────────────────────────────────────────
// Moving averages.
// ───────────────────────────────────────────────────────────────────────────

export function sma(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0 || period <= 0) return out;

  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    acc += values[i];
    if (i >= period) acc -= values[i - period];
    out[i] = i + 1 < period ? acc / (i + 1) : acc / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0 || period <= 0) return out;

  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < n; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// RSI (Wilder smoothing).
// ───────────────────────────────────────────────────────────────────────────

export function rsi(closes: number[], period = 14): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(50);
  if (n <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < n; i += 1) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Bollinger Bands (mid = SMA, upper/lower = mid ± k·stdev).
// ───────────────────────────────────────────────────────────────────────────

export interface BollingerResult {
  mid: number[];
  upper: number[];
  lower: number[];
  /** Rolling stdev — handy for normalising deviation distances. */
  stdev: number[];
}

export function bollinger(closes: number[], period = 20, k = 2): BollingerResult {
  const n = closes.length;
  const mid = sma(closes, period);
  const stdev = new Array<number>(n).fill(0);
  const upper = new Array<number>(n).fill(0);
  const lower = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    const start = Math.max(0, i - period + 1);
    const len = i - start + 1;
    let sumSq = 0;
    for (let j = start; j <= i; j += 1) {
      const diff = closes[j] - mid[i];
      sumSq += diff * diff;
    }
    stdev[i] = Math.sqrt(sumSq / Math.max(1, len));
    upper[i] = mid[i] + k * stdev[i];
    lower[i] = mid[i] - k * stdev[i];
  }
  return { mid, upper, lower, stdev };
}

// ───────────────────────────────────────────────────────────────────────────
// VWAP — typical-price weighted by volume, anchored to the start of the
// series (`session` style). For intraday timeframes this is a close-enough
// proxy when bars span a single session; for longer series consumers should
// re-anchor with `vwapAnchored(candles, anchorIdx)`.
// ───────────────────────────────────────────────────────────────────────────

export function vwap(candles: KlineCandle[]): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;

  let pvSum = 0;
  let vSum = 0;
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pvSum += tp * c.volume;
    vSum += c.volume;
    out[i] = vSum > 0 ? pvSum / vSum : c.close;
  }
  return out;
}

/**
 * Rolling VWAP over a sliding window — useful for short-horizon "session"
 * VWAP on long histories (e.g. last 48 bars on a 5m chart ≈ 4 hours).
 */
export function rollingVwap(candles: KlineCandle[], window = 96): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;
  const pvs = new Array<number>(n).fill(0);
  const vs = new Array<number>(n).fill(0);
  let pvSum = 0;
  let vSum = 0;
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pvs[i] = tp * c.volume;
    vs[i] = c.volume;
    pvSum += pvs[i];
    vSum += vs[i];
    if (i >= window) {
      pvSum -= pvs[i - window];
      vSum -= vs[i - window];
    }
    out[i] = vSum > 0 ? pvSum / vSum : c.close;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// ATR (Wilder) — duplicated lightweight implementation so strategy modules
// don't have to import the UT-Bot indicators file.
// ───────────────────────────────────────────────────────────────────────────

export function atr(candles: KlineCandle[], period = 14): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;

  const trs: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    trs[i] = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }

  if (n <= period) {
    let acc = 0;
    for (let i = 0; i < n; i += 1) {
      acc += trs[i];
      out[i] = acc / Math.max(i, 1);
    }
    return out;
  }

  let prev = 0;
  for (let i = 1; i <= period; i += 1) prev += trs[i];
  prev /= period;
  for (let i = 0; i <= period; i += 1) out[i] = prev;
  for (let i = period + 1; i < n; i += 1) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Rolling extremes & swing detection.
// ───────────────────────────────────────────────────────────────────────────

export function rollingMax(values: number[], window: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const start = Math.max(0, i - window + 1);
    let m = values[start];
    for (let j = start + 1; j <= i; j += 1) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

export function rollingMin(values: number[], window: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const start = Math.max(0, i - window + 1);
    let m = values[start];
    for (let j = start + 1; j <= i; j += 1) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

export interface SwingPoint {
  /** Index in the candles array where the swing confirmed. */
  index: number;
  /** Price of the swing extreme. */
  price: number;
  /** Bar timestamp. */
  ts: number;
}

/**
 * Confirmed swing highs / lows: a bar at index `i` is a swing high if its
 * `high` is the strict max over [i-pivot, i+pivot] (likewise for lows). The
 * swing is recorded once the right-hand confirmation window finishes.
 */
export function findSwings(
  candles: KlineCandle[],
  pivot = 3,
): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const n = candles.length;
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = pivot; i < n - pivot; i += 1) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - pivot; j <= i + pivot; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: c.high, ts: c.closeTime });
    if (isLow) lows.push({ index: i, price: c.low, ts: c.closeTime });
  }
  return { highs, lows };
}

// ───────────────────────────────────────────────────────────────────────────
// Misc utilities used by strategies.
// ───────────────────────────────────────────────────────────────────────────

export function lastN<T>(arr: T[], count: number): T[] {
  if (count >= arr.length) return arr.slice();
  return arr.slice(arr.length - count);
}

/** Average of the last `period` values ending at index `i` (inclusive). */
export function trailingAvg(values: number[], i: number, period: number): number {
  const start = Math.max(0, i - period + 1);
  let acc = 0;
  for (let j = start; j <= i; j += 1) acc += values[j];
  return acc / Math.max(1, i - start + 1);
}

/** Clamp `n` into `[lo, hi]`. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
