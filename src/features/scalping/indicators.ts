import type { KlineCandle } from "@/types/market";

/**
 * Scalping indicator pack.
 *
 * Implements the two pieces of the LuxAlgo Pine Script the user pinned for
 * accuracy:
 *   1. The UT Bot ATR trailing-stop entry/exit trigger (the actual scalp
 *      Buy/Sell shapes on the Pine chart).
 *   2. A trimmed-down "Smart Money Concepts" trend bias derived from BOS /
 *      CHoCH events on a short pivot length. We only use the bias as a
 *      directional filter — drawing labels and order blocks doesn't matter
 *      server-side.
 *
 * Wilder's ATR is shared between the two so sensitivity values translate the
 * same way as the Pine indicator.
 */

// ───────────────────────────────────────────────────────────────────────────
// Wilder's ATR — series form so the UT Bot can index by bar.
// ───────────────────────────────────────────────────────────────────────────
export function atrSeries(candles: KlineCandle[], period = 10): number[] {
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
    // Not enough history — back-fill with the running mean so callers can
    // still index without a NaN check (signals will simply not fire because
    // the engine guards on `n > warmup`).
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
// UT Bot ATR Trailing Stop  ──────────────────────────────────────────────────
// Direct port of the bottom half of the Pine Script. `keyValue` is the
// "sensitivity" knob (Pine `a`) and `atrPeriod` is `c`.
// ───────────────────────────────────────────────────────────────────────────
export interface UtBotResult {
  /** Trailing stop level per bar (NaN-free; warm-up bars carry the seed). */
  trail: number[];
  /** Position regime per bar: -1 short, +1 long, 0 flat. */
  pos: number[];
  /** Buy crossover per bar (true exactly on the bar the flip happens). */
  buy: boolean[];
  /** Sell crossunder per bar. */
  sell: boolean[];
}

export function utBot(
  candles: KlineCandle[],
  keyValue = 1,
  atrPeriod = 10,
): UtBotResult {
  const n = candles.length;
  const trail: number[] = new Array(n).fill(0);
  const pos: number[] = new Array(n).fill(0);
  const buy: boolean[] = new Array(n).fill(false);
  const sell: boolean[] = new Array(n).fill(false);
  if (n === 0) return { trail, pos, buy, sell };

  const atr = atrSeries(candles, atrPeriod);

  // Pine seeds the trailing stop at 0 and references previous close, so we
  // mirror that behaviour with `trail[i-1]` being the rolling stop.
  for (let i = 0; i < n; i += 1) {
    const src = candles[i].close;
    const prevSrc = i > 0 ? candles[i - 1].close : src;
    const nLoss = keyValue * atr[i];
    const prevTrail = i > 0 ? trail[i - 1] : 0;

    let next: number;
    if (src > prevTrail && prevSrc > prevTrail) {
      next = Math.max(prevTrail, src - nLoss);
    } else if (src < prevTrail && prevSrc < prevTrail) {
      next = Math.min(prevTrail, src + nLoss);
    } else if (src > prevTrail) {
      next = src - nLoss;
    } else {
      next = src + nLoss;
    }
    trail[i] = next;

    const prevPos = i > 0 ? pos[i - 1] : 0;
    let nextPos = prevPos;
    if (prevSrc < prevTrail && src > prevTrail) nextPos = 1;
    else if (prevSrc > prevTrail && src < prevTrail) nextPos = -1;
    pos[i] = nextPos;

    if (i > 0) {
      const crossOver = prevSrc <= prevTrail && src > prevTrail;
      const crossUnder = prevSrc >= prevTrail && src < prevTrail;
      buy[i] = src > next && crossOver;
      sell[i] = src < next && crossUnder;
    }
  }

  return { trail, pos, buy, sell };
}

// ───────────────────────────────────────────────────────────────────────────
// SMC pivots → trend bias (BOS / CHoCH on short swing length).
// We derive a `bias` series so the engine can confirm UT Bot triggers only
// when SMC structure agrees.
// ───────────────────────────────────────────────────────────────────────────
export type SmcBias = -1 | 0 | 1; // -1 bearish, 0 unknown, +1 bullish
export type SmcEvent = "BOS_BULL" | "BOS_BEAR" | "CHOCH_BULL" | "CHOCH_BEAR" | null;

export interface SmcResult {
  bias: SmcBias[];
  event: SmcEvent[];
  /** Last confirmed pivot high/low at each bar (forward-filled). */
  lastSwingHigh: number[];
  lastSwingLow: number[];
}

/**
 * Pivot-based structure detector. Mirrors the Pine `leg(size)` logic — a bar
 * is a pivot high if its high is the strict highest over the trailing
 * `pivotSize` window (and likewise for lows). Trend is BULLISH while price
 * keeps closing through pivot highs (BOS), and flips to BEARISH on the first
 * close below the most recent pivot low (CHoCH), and vice versa.
 */
export function smcStructure(candles: KlineCandle[], pivotSize = 5): SmcResult {
  const n = candles.length;
  const bias: SmcBias[] = new Array(n).fill(0);
  const event: SmcEvent[] = new Array(n).fill(null);
  const lastSwingHigh: number[] = new Array(n).fill(NaN);
  const lastSwingLow: number[] = new Array(n).fill(NaN);
  if (n === 0) return { bias, event, lastSwingHigh, lastSwingLow };

  let pivotHigh = NaN; // currently-active pivot high to break above for BOS-bull
  let pivotLow = NaN; // currently-active pivot low
  let pivotHighCrossed = false;
  let pivotLowCrossed = false;
  let currentBias: SmcBias = 0;

  // Pine confirms a pivot `pivotSize` bars after it forms. Mirror that.
  for (let i = 0; i < n; i += 1) {
    // Confirm pivot at index (i - pivotSize): is it the strict extreme over
    // the trailing window of length `pivotSize`?
    const confirmIdx = i - pivotSize;
    if (confirmIdx >= pivotSize) {
      const c = candles[confirmIdx];
      let isHigh = true;
      let isLow = true;
      for (let j = confirmIdx - pivotSize; j < confirmIdx; j += 1) {
        if (candles[j].high >= c.high) isHigh = false;
        if (candles[j].low <= c.low) isLow = false;
      }
      for (let j = confirmIdx + 1; j <= confirmIdx + pivotSize && j < n; j += 1) {
        if (candles[j].high >= c.high) isHigh = false;
        if (candles[j].low <= c.low) isLow = false;
      }
      if (isHigh) {
        pivotHigh = c.high;
        pivotHighCrossed = false;
      }
      if (isLow) {
        pivotLow = c.low;
        pivotLowCrossed = false;
      }
    }

    const close = candles[i].close;
    const prevClose = i > 0 ? candles[i - 1].close : close;

    // BOS / CHoCH crossover detection on close.
    if (
      Number.isFinite(pivotHigh) &&
      !pivotHighCrossed &&
      prevClose <= pivotHigh &&
      close > pivotHigh
    ) {
      pivotHighCrossed = true;
      const tag: SmcEvent = currentBias === -1 ? "CHOCH_BULL" : "BOS_BULL";
      event[i] = tag;
      currentBias = 1;
    } else if (
      Number.isFinite(pivotLow) &&
      !pivotLowCrossed &&
      prevClose >= pivotLow &&
      close < pivotLow
    ) {
      pivotLowCrossed = true;
      const tag: SmcEvent = currentBias === 1 ? "CHOCH_BEAR" : "BOS_BEAR";
      event[i] = tag;
      currentBias = -1;
    }

    bias[i] = currentBias;
    lastSwingHigh[i] = pivotHigh;
    lastSwingLow[i] = pivotLow;
  }

  return { bias, event, lastSwingHigh, lastSwingLow };
}
