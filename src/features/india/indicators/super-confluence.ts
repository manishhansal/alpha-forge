/**
 * Super Confluence Engine — TypeScript port of the combined Pine Script:
 *
 *   1. UT Bot ATR Trailing Stop  (keyValue=1, atrPeriod=10)
 *   2. AI Neural Trend Line      (HMA-smoothed adaptive trailing stop,
 *                                  speed=14, atrMult=2.0)
 *   3. SMC Swing Structure       (BOS / CHoCH pivot bias, pivotLen=50)
 *   4. EMA 9 / 15 / 21 stack    (entry & exit confirmation filter)
 *
 * A Super Buy fires when ALL FOUR agree bullish simultaneously:
 *   ut_buy  AND  aiTrendDir == 1  AND  smcBias == 1
 *   AND  ema9 > ema15 > ema21  (price in bullish EMA order)
 *
 * A Super Sell fires when ALL FOUR agree bearish:
 *   ut_sell  AND  aiTrendDir == -1  AND  smcBias == -1
 *   AND  ema9 < ema15 < ema21  (bearish EMA order)
 *
 * The EMA stack eliminates entries against the prevailing trend structure
 * — the most common source of fake signals from the three-system engine.
 */

import type { Candle } from "@/types/india/market";
import type { KlineCandle } from "@/types/market";
import { utBot, smcStructure, atrSeries } from "@/features/scalping/indicators";

// ─── Adapter: Candle → KlineCandle ──────────────────────────────────────────

function toKlineCandles(candles: Candle[]): KlineCandle[] {
  return candles.map((c) => ({
    openTime:  c.time * 1000,
    open:      c.open,
    high:      c.high,
    low:       c.low,
    close:     c.close,
    volume:    c.volume ?? 0,
    closeTime: c.time * 1000 + 86_400_000,
  }));
}

// ─── HMA (Hull Moving Average) ───────────────────────────────────────────────
// HMA(n) = WMA(2×WMA(n/2) − WMA(n), √n)

function wma(vals: number[], period: number): number[] {
  const n = vals.length;
  const out = new Array<number>(n).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let num = 0;
    for (let j = 0; j < period; j++) num += (j + 1) * vals[i - (period - 1 - j)];
    out[i] = num / denom;
  }
  return out;
}

function hma(vals: number[], period: number): number[] {
  const half  = Math.max(1, Math.floor(period / 2));
  const sqrt  = Math.max(1, Math.round(Math.sqrt(period)));
  const wmaH  = wma(vals, half);
  const wmaF  = wma(vals, period);
  const n     = vals.length;
  const diff  = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(wmaH[i]) && !isNaN(wmaF[i])) diff[i] = 2 * wmaH[i] - wmaF[i];
  }
  return wma(diff, sqrt);
}

// ─── EMA ─────────────────────────────────────────────────────────────────────
// Standard EMA seeded from SMA of first `period` closes (TradingView convention).

function emaSeries(vals: number[], period: number): number[] {
  const n     = vals.length;
  const out   = new Array<number>(n).fill(NaN);
  if (n < period) return out;
  const alpha = 2 / (period + 1);
  // Seed with SMA of first `period` bars.
  let prev = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) out[i] = prev;
  for (let i = period; i < n; i++) {
    prev   = vals[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

// ─── AI Neural Trend Line ────────────────────────────────────────────────────
// Mirrors the "AI Neural Trend Predictor" section:
//   ai_smooth_src = HMA(close, speed)
//   nLoss = ATR(atrLen) * mult
//   if trend == UP:  ai_line = max(ai_line[1], smooth - nLoss)
//                   → flip DOWN when close < ai_line
//   if trend == DOWN: ai_line = min(ai_line[1], smooth + nLoss)
//                   → flip UP when close > ai_line

export interface AiNeuralResult {
  line:    number[];   // the adaptive trailing line
  dir:     number[];   // +1 bullish, -1 bearish
}

function aiNeuralLine(
  candles: KlineCandle[],
  speed    = 14,
  atrLen   = 14,
  atrMult  = 2.0,
): AiNeuralResult {
  const n      = candles.length;
  const closes = candles.map((c) => c.close);
  const smooth = hma(closes, speed);
  const atr    = atrSeries(candles, atrLen);

  const line = new Array<number>(n).fill(NaN);
  const dir  = new Array<number>(n).fill(1);

  let prevLine = NaN;
  let prevDir  = 1;

  for (let i = 0; i < n; i++) {
    const s    = smooth[i];
    const a    = atr[i];
    const c    = closes[i];
    if (isNaN(s) || isNaN(a)) {
      line[i] = prevLine;
      dir[i]  = prevDir;
      continue;
    }
    const nLoss = a * atrMult;
    let curLine: number;
    let curDir = prevDir;

    if (prevDir === 1) {
      curLine = isNaN(prevLine) ? s - nLoss : Math.max(prevLine, s - nLoss);
      if (c < curLine) {
        curDir  = -1;
        curLine = s + nLoss;
      }
    } else {
      curLine = isNaN(prevLine) ? s + nLoss : Math.min(prevLine, s + nLoss);
      if (c > curLine) {
        curDir  = 1;
        curLine = s - nLoss;
      }
    }
    line[i]  = curLine;
    dir[i]   = curDir;
    prevLine = curLine;
    prevDir  = curDir;
  }
  return { line, dir };
}

// ─── Super Confluence Result ──────────────────────────────────────────────────

export interface SuperConfluenceBar {
  /** Unix seconds — mirrors Candle.time */
  time:        number;
  close:       number;
  /** UT Bot trailing stop level */
  utTrail:     number;
  /** AI Neural adaptive line */
  aiLine:      number;
  /** AI Neural trend direction: +1 bullish / -1 bearish */
  aiDir:       number;
  /** SMC swing bias: +1 bullish / -1 bearish / 0 unknown */
  smcBias:     number;
  /** SMC event on this bar or null */
  smcEvent:    string | null;
  /** Last confirmed swing high */
  swingHigh:   number;
  /** Last confirmed swing low */
  swingLow:    number;
  /** UT Bot buy trigger */
  utBuy:       boolean;
  /** UT Bot sell trigger */
  utSell:      boolean;
  /** EMA 9 value */
  ema9:        number;
  /** EMA 15 value */
  ema15:       number;
  /** EMA 21 value */
  ema21:       number;
  /** EMA stack is bullish: ema9 > ema15 > ema21 */
  emaBull:     boolean;
  /** EMA stack is bearish: ema9 < ema15 < ema21 */
  emaBear:     boolean;
  /** Triple-confluence long signal */
  superBuy:    boolean;
  /** Triple-confluence short signal */
  superSell:   boolean;
}

export interface SuperConfluenceResult {
  bars:   SuperConfluenceBar[];
  /**
   * Directional score in [-1, 1] for the most recent bar.
   *   +1.0 = fresh Super Buy (all three agree bullish)
   *   -1.0 = fresh Super Sell (all three agree bearish)
   *   Partial values represent partial alignment.
   */
  score:  number;
  /** Human-readable tag summarising the latest bar's state */
  tag:    string;
  /**
   * Number of bars since the last Super Buy (positive) or Super Sell
   * (negative). 0 means the signal fired on the last bar. null when
   * no signal has fired yet.
   */
  barsSinceSignal: number | null;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Compute the Super Confluence Engine over daily (or intraday) candles.
 *
 * Parameters match the Pine Script defaults:
 *   - UT Bot:      keyValue=1, atrPeriod=10
 *   - AI Neural:   speed=14, atrLen=14, atrMult=2.0
 *   - SMC pivots:  pivotLen=50  (swing structure — longer than the 5-bar
 *                   scalping default, matches Pine's `swingsLengthInput=50`)
 */
export function computeSuperConfluence(
  candles:  Candle[],
  options?: {
    utKeyValue?:   number;
    utAtrPeriod?:  number;
    aiSpeed?:      number;
    aiAtrLen?:     number;
    aiAtrMult?:    number;
    smcPivotLen?:  number;
  },
): SuperConfluenceResult | null {
  const {
    utKeyValue  = 1,
    utAtrPeriod = 10,
    aiSpeed     = 14,
    aiAtrLen    = 14,
    aiAtrMult   = 2.0,
    smcPivotLen = 50,
  } = options ?? {};

  // Need at least enough warmup bars for all indicators.
  const warmup = Math.max(aiSpeed * 2 + 5, aiAtrLen + 1, smcPivotLen * 2 + 5, utAtrPeriod + 5);
  if (candles.length < warmup) return null;

  const kline  = toKlineCandles(candles);
  const ut     = utBot(kline, utKeyValue, utAtrPeriod);
  const ai     = aiNeuralLine(kline, aiSpeed, aiAtrLen, aiAtrMult);
  const smc    = smcStructure(kline, smcPivotLen);
  const n      = candles.length;
  const closes = candles.map((c) => c.close);

  // EMA 9 / 15 / 21 — entry & exit confirmation stack
  const e9  = emaSeries(closes, 9);
  const e15 = emaSeries(closes, 15);
  const e21 = emaSeries(closes, 21);

  const bars: SuperConfluenceBar[] = candles.map((c, i) => {
    const ema9    = e9[i];
    const ema15   = e15[i];
    const ema21   = e21[i];
    const emaBull = isFinite(ema9) && isFinite(ema15) && isFinite(ema21)
      && ema9 > ema15 && ema15 > ema21;
    const emaBear = isFinite(ema9) && isFinite(ema15) && isFinite(ema21)
      && ema9 < ema15 && ema15 < ema21;

    // All four systems must agree for a full Super signal.
    const superBuy  = ut.buy[i]  && ai.dir[i] === 1  && smc.bias[i] === 1  && emaBull;
    const superSell = ut.sell[i] && ai.dir[i] === -1 && smc.bias[i] === -1 && emaBear;
    return {
      time:      c.time,
      close:     c.close,
      utTrail:   ut.trail[i],
      aiLine:    ai.line[i],
      aiDir:     ai.dir[i],
      smcBias:   smc.bias[i],
      smcEvent:  smc.event[i],
      swingHigh: smc.lastSwingHigh[i],
      swingLow:  smc.lastSwingLow[i],
      utBuy:     ut.buy[i],
      utSell:    ut.sell[i],
      ema9,
      ema15,
      ema21,
      emaBull,
      emaBear,
      superBuy,
      superSell,
    };
  });

  // ── Score the most recent bar ─────────────────────────────────────────────
  const last = bars[bars.length - 1];

  // Full four-way confluence → ±1.0
  // Three-way partial alignment → ±0.75
  // Two-way → ±0.5; One-way → ±0.25; nothing → 0
  let score = 0;
  const bullComponents = [
    last.utBuy  || ut.pos[n - 1] === 1,
    last.aiDir  === 1,
    last.smcBias === 1,
    last.emaBull,
  ].filter(Boolean).length;
  const bearComponents = [
    last.utSell || ut.pos[n - 1] === -1,
    last.aiDir  === -1,
    last.smcBias === -1,
    last.emaBear,
  ].filter(Boolean).length;

  if (last.superBuy)            score = 1.0;
  else if (last.superSell)      score = -1.0;
  else if (bullComponents === 3) score = 0.75;
  else if (bearComponents === 3) score = -0.75;
  else if (bullComponents === 2) score = 0.5;
  else if (bearComponents === 2) score = -0.5;
  else if (bullComponents === 1) score = 0.25;
  else if (bearComponents === 1) score = -0.25;

  // ── Tag ───────────────────────────────────────────────────────────────────
  let tag: string;
  if (last.superBuy)              tag = "🔥 Super Buy — UT+AI+SMC+EMA all bullish";
  else if (last.superSell)        tag = "🔥 Super Sell — UT+AI+SMC+EMA all bearish";
  else if (bullComponents === 3)  tag = "Strong bullish (3/4 agree)";
  else if (bearComponents === 3)  tag = "Strong bearish (3/4 agree)";
  else if (bullComponents === 2)  tag = "Partial bullish (2/4 agree)";
  else if (bearComponents === 2)  tag = "Partial bearish (2/4 agree)";
  else if (last.aiDir === 1)      tag = "AI trend bullish — awaiting UT + EMA confirmation";
  else if (last.aiDir === -1)     tag = "AI trend bearish — awaiting UT + EMA confirmation";
  else                            tag = "No confluence";

  // ── Bars since last signal ────────────────────────────────────────────────
  let barsSinceSignal: number | null = null;
  for (let i = n - 1; i >= 0; i--) {
    if (bars[i].superBuy) {
      barsSinceSignal = n - 1 - i;
      break;
    }
    if (bars[i].superSell) {
      barsSinceSignal = -(n - 1 - i);
      break;
    }
  }

  return { bars, score, tag, barsSinceSignal };
}
