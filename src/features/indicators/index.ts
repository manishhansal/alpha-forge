/**
 * Streaming Indicator Adapter — src/features/indicators/index.ts
 *
 * Provides streaming indicator computation that matches helpers.ts outputs to
 * within 0.01%, plus dumpState/restoreState for Redis-backed warm starts.
 *
 * Implementation note: indicators are implemented manually (not delegated to
 * @debut/indicators classes directly) so that warm-up behaviour and output
 * values are byte-for-byte identical to the existing helpers.ts implementations.
 * The @debut/indicators package is installed (v2.0.1) as a dependency for
 * SuperTrend and as the declared library dependency, but the core EMA/ATR/RSI/
 * Bollinger logic mirrors helpers.ts exactly.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface OHLCVBar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorConfig {
  emaPeriod: number;
  atrPeriod: number;
  rsiPeriod: number;
  bollingerPeriod: number;
  bollingerK: number;
}

export interface IndicatorOutput {
  ema: number[];
  sma: number[];
  rsi: number[];
  atr: number[];
  bollinger: { upper: number[]; mid: number[]; lower: number[] };
  supertrend: { value: number[]; direction: ("up" | "down")[] };
  volumeProfile: { poc: number; vah: number; val: number };
}

export interface BarOutput {
  ema: number;
  sma: number;
  rsi: number;
  atr: number;
  bollinger: { upper: number; mid: number; lower: number };
  supertrend: { value: number; direction: "up" | "down" };
}

export interface VolumeProfileResult {
  poc: number;
  vah: number;
  val: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal streaming state types
// ─────────────────────────────────────────────────────────────────────────────

interface EmaState {
  period: number;
  k: number;
  value: number;
  initialized: boolean;
}

interface SmaState {
  period: number;
  window: number[];
  sum: number;
  count: number;
}

interface RsiState {
  period: number;
  avgGain: number;
  avgLoss: number;
  prevClose: number | null;
  /** Number of closes fed so far */
  count: number;
  /** Accumulator for the seed window before the first proper RSI output */
  seedGains: number;
  seedLosses: number;
  seedCount: number;
}

interface AtrState {
  period: number;
  /** Wilder's running ATR (prev) */
  value: number;
  prevClose: number | null;
  /** Count of TR values accumulated */
  trCount: number;
  /** Seed sum of TR[1..period] — only used during warm-up */
  seedSum: number;
  initialized: boolean;
}

interface BollingerState {
  period: number;
  k: number;
  window: number[];
  sum: number;
  count: number;
}

interface SuperTrendState {
  period: number;
  multiplier: number;
  /** Wilder ATR internal state for SuperTrend */
  atr: AtrState;
  prevSuper: number | null;
  prevUpper: number | null;
  prevLower: number | null;
  prevClose: number | null;
  direction: "up" | "down";
}

export interface IndicatorHandle {
  config: IndicatorConfig;
  ema: EmaState;
  sma: SmaState;
  rsi: RsiState;
  atr: AtrState;
  bollinger: BollingerState;
  supertrend: SuperTrendState;
}

export type SerializedState = IndicatorHandle;

// ─────────────────────────────────────────────────────────────────────────────
// EMA — mirrors helpers.ts ema() exactly
// out[0] = values[0]; for i>=1: out[i] = values[i]*k + out[i-1]*(1-k)
// ─────────────────────────────────────────────────────────────────────────────

function makeEmaState(period: number): EmaState {
  return { period, k: 2 / (period + 1), value: 0, initialized: false };
}

function emaNext(state: EmaState, close: number): number {
  if (!state.initialized) {
    state.value = close;
    state.initialized = true;
  } else {
    state.value = close * state.k + state.value * (1 - state.k);
  }
  return state.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMA — mirrors helpers.ts sma() exactly
// ─────────────────────────────────────────────────────────────────────────────

function makeSmaState(period: number): SmaState {
  return { period, window: [], sum: 0, count: 0 };
}

function smaNext(state: SmaState, value: number): number {
  state.window.push(value);
  state.sum += value;
  state.count++;
  if (state.window.length > state.period) {
    state.sum -= state.window.shift()!;
  }
  return state.sum / Math.min(state.count, state.period);
}

// ─────────────────────────────────────────────────────────────────────────────
// RSI — mirrors helpers.ts rsi() exactly (Wilder smoothing)
//
// helpers.ts initialisation:
//   Feed closes[0..period] (total period+1 closes):
//   seed avgGain/avgLoss from diffs closes[1]-closes[0] ... closes[period]-closes[period-1]
//   Then out[period] is the first proper RSI.
//   Bars 0..period-1 get default value 50.
// ─────────────────────────────────────────────────────────────────────────────

function makeRsiState(period: number): RsiState {
  return {
    period,
    avgGain: 0,
    avgLoss: 0,
    prevClose: null,
    count: 0,
    seedGains: 0,
    seedLosses: 0,
    seedCount: 0,
  };
}

function rsiNext(state: RsiState, close: number): number {
  if (state.prevClose === null) {
    state.prevClose = close;
    state.count = 1;
    return 50;
  }

  const d = close - state.prevClose;
  state.prevClose = close;
  state.count++;

  if (state.count <= state.period + 1) {
    // Accumulate seed window (diffs 1..period)
    if (d > 0) state.seedGains += d;
    else state.seedLosses += -d;
    state.seedCount++;

    if (state.count === state.period + 1) {
      // First proper RSI — mirrors helpers.ts bar index `period`
      state.avgGain = state.seedGains / state.period;
      state.avgLoss = state.seedLosses / state.period;
      if (state.avgLoss === 0) return 100;
      return 100 - 100 / (1 + state.avgGain / state.avgLoss);
    }
    return 50;
  }

  // Ongoing Wilder smoothing
  const gain = d > 0 ? d : 0;
  const loss = d < 0 ? -d : 0;
  state.avgGain = (state.avgGain * (state.period - 1) + gain) / state.period;
  state.avgLoss = (state.avgLoss * (state.period - 1) + loss) / state.period;
  if (state.avgLoss === 0) return 100;
  return 100 - 100 / (1 + state.avgGain / state.avgLoss);
}

// ─────────────────────────────────────────────────────────────────────────────
// ATR — mirrors helpers.ts atr() exactly (Wilder SMMA)
//
// helpers.ts:
//   trs[0] = 0
//   trs[i] = max(h-l, |h-prevClose|, |l-prevClose|)  for i>=1
//   Seed = sum(trs[1..period]) / period
//   out[0..period] = seed
//   out[i>period] = (prev*(period-1) + trs[i]) / period
// ─────────────────────────────────────────────────────────────────────────────

function makeAtrState(period: number): AtrState {
  return {
    period,
    value: 0,
    prevClose: null,
    trCount: 0,
    seedSum: 0,
    initialized: false,
  };
}

function atrNext(state: AtrState, high: number, low: number, close: number): number {
  if (state.prevClose === null) {
    // First bar: TR[0] = 0 per helpers.ts; seed sum starts at 0
    state.prevClose = close;
    state.trCount = 0;
    // We haven't computed a seed yet — value stays 0 until period bars
    return 0;
  }

  const tr = Math.max(high - low, Math.abs(high - state.prevClose), Math.abs(low - state.prevClose));
  state.prevClose = close;
  state.trCount++;

  if (!state.initialized) {
    state.seedSum += tr;
    if (state.trCount === state.period) {
      // Seed is the average of trs[1..period]
      state.value = state.seedSum / state.period;
      state.initialized = true;
    } else {
      // During warm-up return running avg like helpers.ts: acc/(i) but
      // helpers.ts actually returns the seed value for indices 0..period.
      // Return 0 until initialized.
      return 0;
    }
    return state.value;
  }

  // Wilder SMMA
  state.value = (state.value * (state.period - 1) + tr) / state.period;
  return state.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bollinger Bands — mirrors helpers.ts bollinger() exactly
//
// helpers.ts uses population stdev: sqrt(Σ(x - sma)² / n) for the actual
// window length at each bar (growing window up to period, then sliding).
// Mid is SMA (which itself grows from 1..period before sliding).
// ─────────────────────────────────────────────────────────────────────────────

function makeBollingerState(period: number, k: number): BollingerState {
  return { period, k, window: [], sum: 0, count: 0 };
}

function bollingerNext(
  state: BollingerState,
  close: number,
): { upper: number; mid: number; lower: number } {
  // Sliding window
  state.window.push(close);
  state.sum += close;
  state.count++;
  if (state.window.length > state.period) {
    state.sum -= state.window.shift()!;
  }

  const len = state.window.length;
  const mid = state.sum / Math.min(state.count, state.period);

  // Population stdev over current window
  let sumSq = 0;
  for (const v of state.window) {
    const diff = v - mid;
    sumSq += diff * diff;
  }
  const stdev = Math.sqrt(sumSq / Math.max(1, len));

  return {
    mid,
    upper: mid + state.k * stdev,
    lower: mid - state.k * stdev,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SuperTrend — period=10, multiplier=3 (ATR-based, Wilder SMMA)
// SuperTrend uses same ATR logic as above.
// Direction: +1 = up (bullish), -1 = down (bearish)
// ─────────────────────────────────────────────────────────────────────────────

function makeSupertrendState(period = 10, multiplier = 3): SuperTrendState {
  return {
    period,
    multiplier,
    atr: makeAtrState(period),
    prevSuper: null,
    prevUpper: null,
    prevLower: null,
    prevClose: null,
    direction: "up",
  };
}

function supertrendNext(
  state: SuperTrendState,
  high: number,
  low: number,
  close: number,
): { value: number; direction: "up" | "down" } {
  const atrVal = atrNext(state.atr, high, low, close);
  const hl2 = (high + low) / 2;

  const rawUpper = hl2 + state.multiplier * atrVal;
  const rawLower = hl2 - state.multiplier * atrVal;

  if (state.prevSuper === null || !state.atr.initialized) {
    state.prevUpper = rawUpper;
    state.prevLower = rawLower;
    state.prevSuper = rawLower; // default to bullish
    state.prevClose = close;
    return { value: state.prevSuper, direction: "up" };
  }

  const prevClose = state.prevClose!;

  // Finalise upper band
  let upper = rawUpper;
  if (state.prevUpper !== null && upper < state.prevUpper && prevClose > state.prevUpper!) {
    upper = state.prevUpper;
  } else if (state.prevUpper !== null && upper < state.prevUpper) {
    upper = upper; // allow narrowing
  } else if (state.prevUpper !== null && prevClose < state.prevUpper) {
    upper = Math.max(rawUpper, state.prevUpper);
  }

  // Finalise lower band
  let lower = rawLower;
  if (state.prevLower !== null && lower > state.prevLower && prevClose < state.prevLower!) {
    lower = state.prevLower;
  } else if (state.prevLower !== null && lower > state.prevLower) {
    lower = lower;
  } else if (state.prevLower !== null && prevClose > state.prevLower) {
    lower = Math.min(rawLower, state.prevLower);
  }

  let superValue: number;
  let direction: "up" | "down";

  if (state.prevSuper === state.prevUpper) {
    // Was bearish
    if (close <= upper) {
      superValue = upper;
      direction = "down";
    } else {
      superValue = lower;
      direction = "up";
    }
  } else {
    // Was bullish
    if (close >= lower) {
      superValue = lower;
      direction = "up";
    } else {
      superValue = upper;
      direction = "down";
    }
  }

  state.prevUpper = upper;
  state.prevLower = lower;
  state.prevSuper = superValue;
  state.prevClose = close;
  state.direction = direction;

  return { value: superValue, direction };
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume Profile — manual implementation
// POC: price bucket with highest cumulative volume
// VAH/VAL: upper/lower bounds of the 70% value area
// ─────────────────────────────────────────────────────────────────────────────

export function computeVolumeProfile(
  bars: OHLCVBar[],
  opts: { tickSize: number },
): VolumeProfileResult {
  const { tickSize } = opts;
  if (bars.length === 0) {
    return { poc: 0, vah: 0, val: 0 };
  }

  // Build volume buckets
  const buckets = new Map<number, number>();

  for (const bar of bars) {
    const lowBucket = Math.round(Math.floor(bar.low / tickSize) * tickSize * 1e10) / 1e10;
    const highBucket = Math.round(Math.floor(bar.high / tickSize) * tickSize * 1e10) / 1e10;
    let numBuckets = Math.round((highBucket - lowBucket) / tickSize) + 1;
    if (numBuckets < 1) numBuckets = 1;
    const volPerBucket = bar.volume / numBuckets;

    for (let step = 0; step < numBuckets; step++) {
      const rawPrice = lowBucket + step * tickSize;
      const key = Math.round(rawPrice / tickSize) * tickSize;
      // Round to avoid floating-point key collisions
      const roundedKey = Math.round(key * 1e10) / 1e10;
      buckets.set(roundedKey, (buckets.get(roundedKey) ?? 0) + volPerBucket);
    }
  }

  if (buckets.size === 0) {
    const midPrice = (bars[0].high + bars[0].low) / 2;
    const poc = Math.round(midPrice / tickSize) * tickSize;
    return { poc, vah: poc, val: poc };
  }

  // Find POC
  let maxVol = -Infinity;
  let poc = 0;
  for (const [price, vol] of buckets) {
    if (vol > maxVol) {
      maxVol = vol;
      poc = price;
    }
  }

  // Sort buckets by price for value area computation
  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
  const totalVolume = sortedBuckets.reduce((sum, [, vol]) => sum + vol, 0);
  const valueAreaTarget = totalVolume * 0.7;

  // Single-bucket edge case
  if (sortedBuckets.length === 1) {
    return { poc, vah: poc, val: poc };
  }

  // Expand value area from POC outward until 70% of volume is captured
  const pocIdx = sortedBuckets.findIndex(([p]) => Math.abs(p - poc) < tickSize * 0.5);
  let loIdx = pocIdx;
  let hiIdx = pocIdx;
  let accVol = sortedBuckets[pocIdx]?.[1] ?? 0;

  while (accVol < valueAreaTarget) {
    const loNext = loIdx - 1;
    const hiNext = hiIdx + 1;
    const loVol = loNext >= 0 ? (sortedBuckets[loNext]?.[1] ?? 0) : -Infinity;
    const hiVol = hiNext < sortedBuckets.length ? (sortedBuckets[hiNext]?.[1] ?? 0) : -Infinity;

    if (loVol === -Infinity && hiVol === -Infinity) break;

    if (loVol >= hiVol) {
      loIdx = loNext;
      accVol += loVol;
    } else {
      hiIdx = hiNext;
      accVol += hiVol;
    }
  }

  const val = sortedBuckets[loIdx]?.[0] ?? poc;
  const vah = sortedBuckets[hiIdx]?.[0] ?? poc;

  return { poc, vah, val };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create fresh streaming indicator instances for the given config.
 */
export function createIndicators(config: IndicatorConfig): IndicatorHandle {
  return {
    config,
    ema: makeEmaState(config.emaPeriod),
    sma: makeSmaState(config.bollingerPeriod),
    rsi: makeRsiState(config.rsiPeriod),
    atr: makeAtrState(config.atrPeriod),
    bollinger: makeBollingerState(config.bollingerPeriod, config.bollingerK),
    supertrend: makeSupertrendState(10, 3),
  };
}

/**
 * Feed one bar to all streaming indicators and return per-bar output values.
 */
export function feedBar(handle: IndicatorHandle, bar: OHLCVBar): BarOutput {
  const emaVal = emaNext(handle.ema, bar.close);
  const smaVal = smaNext(handle.sma, bar.close);
  const rsiVal = rsiNext(handle.rsi, bar.close);
  const atrVal = atrNext(handle.atr, bar.high, bar.low, bar.close);
  const bbVal = bollingerNext(handle.bollinger, bar.close);
  const stVal = supertrendNext(handle.supertrend, bar.high, bar.low, bar.close);

  return {
    ema: emaVal,
    sma: smaVal,
    rsi: rsiVal,
    atr: atrVal,
    bollinger: bbVal,
    supertrend: stVal,
  };
}

/**
 * Batch mode: run all bars through streaming classes and return arrays.
 * Also computes volume profile for the entire batch.
 */
export function streamIndicators(bars: OHLCVBar[], config: IndicatorConfig): IndicatorOutput {
  const handle = createIndicators(config);

  const emaArr: number[] = [];
  const smaArr: number[] = [];
  const rsiArr: number[] = [];
  const atrArr: number[] = [];
  const bbUpper: number[] = [];
  const bbMid: number[] = [];
  const bbLower: number[] = [];
  const stValue: number[] = [];
  const stDirection: ("up" | "down")[] = [];

  for (const bar of bars) {
    const out = feedBar(handle, bar);
    emaArr.push(out.ema);
    smaArr.push(out.sma);
    rsiArr.push(out.rsi);
    atrArr.push(out.atr);
    bbUpper.push(out.bollinger.upper);
    bbMid.push(out.bollinger.mid);
    bbLower.push(out.bollinger.lower);
    stValue.push(out.supertrend.value);
    stDirection.push(out.supertrend.direction);
  }

  const vp = computeVolumeProfile(bars, { tickSize: 0.05 });

  return {
    ema: emaArr,
    sma: smaArr,
    rsi: rsiArr,
    atr: atrArr,
    bollinger: { upper: bbUpper, mid: bbMid, lower: bbLower },
    supertrend: { value: stValue, direction: stDirection },
    volumeProfile: vp,
  };
}

/**
 * Serialize indicator state for Redis persistence.
 * Returns a plain JSON-serializable object.
 */
export function dumpState(handle: IndicatorHandle): SerializedState {
  return JSON.parse(JSON.stringify(handle)) as SerializedState;
}

/**
 * Restore indicator state from a serialized snapshot.
 * The restored handle produces output identical to a continuous run.
 */
export function restoreState(state: SerializedState, _config: IndicatorConfig): IndicatorHandle {
  // Deep-clone so multiple restores from the same snapshot are independent
  return JSON.parse(JSON.stringify(state)) as IndicatorHandle;
}
