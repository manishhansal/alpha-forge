/**
 * Multi-Layer Signal Engine — Phases 5–13
 *
 * Implements the 12-layer signal architecture. Each layer produces an
 * independent LayerResult with status, score, confidence, direction, and
 * reason. The layers are NOT blindly summed — each has a veto right when
 * quality is CRITICAL (e.g., missing data, circuit breaker, extreme spread).
 *
 * Layers:
 *   1.  MARKET_CONTEXT   — overall index/breadth context
 *   2.  REGIME           — market volatility / trend regime
 *   3.  STRUCTURE        — market structure (BOS, CHoCH, swing H/L, FVG)
 *   4.  MOMENTUM         — price momentum (ROC, RSI, EMA slope, ADX)
 *   5.  VOLUME           — relative volume, volume profile
 *   6.  VOLATILITY       — ATR percentile, realized vol, IV
 *   7.  LIQUIDITY        — bid/ask spread, depth, execution quality
 *   8.  DERIVATIVES      — OI, PCR, max pain, OI flow
 *   9.  RELATIVE_STRENGTH — relative to NIFTY and sector
 *   10. ML              — ML model probability outputs
 *   11. RISK             — portfolio risk / correlation / exposure
 *   12. EXECUTION        — entry timing, time-of-day, expiry calendar
 *
 * This module is I/O-free. All inputs are passed in as typed structures.
 */

import type { OHLCVCandle } from "@/lib/market-data/types";
import type { MarketContextSnapshot } from "./market-context-engine";
import type { SignalDirection, MarketRegimeLabel } from "./types";

// Re-export from types for convenience
export type { SignalDirection };

export type VolatilityRegimeLabel =
  | "VERY_LOW"
  | "LOW"
  | "NORMAL"
  | "HIGH"
  | "EXTREME";

// ─── Layer Types ──────────────────────────────────────────────────────────────
export type LayerName =
  | "MARKET_CONTEXT"
  | "REGIME"
  | "STRUCTURE"
  | "MOMENTUM"
  | "VOLUME"
  | "VOLATILITY"
  | "LIQUIDITY"
  | "DERIVATIVES"
  | "RELATIVE_STRENGTH"
  | "ML"
  | "RISK"
  | "EXECUTION";

export type LayerStatus =
  | "CONFIRM"    // Layer confirms the signal
  | "NEUTRAL"    // Layer neither confirms nor opposes
  | "OPPOSE"     // Layer opposes the signal (reduces score)
  | "VETO"       // Layer vetoes — signal must be rejected
  | "UNAVAILABLE"; // Data unavailable for this layer

export interface LayerResult {
  layer: LayerName;
  status: LayerStatus;
  /** [-1, 1] raw directional score */
  score: number;
  /** [0, 1] confidence in this layer's assessment */
  confidence: number;
  /** Signal direction this layer supports */
  direction: SignalDirection;
  /** Quality flag — CRITICAL triggers veto check */
  quality: "HIGH" | "MEDIUM" | "LOW" | "CRITICAL";
  /** Human-readable reason */
  reason: string;
  /** Whether this layer's score was used in the final composite */
  contributing: boolean;
}

// ─── Breakout Quality ─────────────────────────────────────────────────────────

export type BreakoutQuality =
  | "WEAK_BREAKOUT"
  | "VALID_BREAKOUT"
  | "STRONG_BREAKOUT"
  | "EXHAUSTION_BREAKOUT";

export interface BreakoutQualityResult {
  quality: BreakoutQuality;
  rangeWidth: number;
  atrNormalizedRange: number;
  volumeExpansion: number;
  rvol: number;
  closeLocation: number; // [0,1] — 1 = at high
  breakoutDistance: number; // % beyond range boundary
  followThrough: boolean;
  falseProbability: number; // [0, 1]
  score: number; // [0, 1]
  reasons: string[];
}

// ─── Momentum Quality ─────────────────────────────────────────────────────────

export type MomentumState =
  | "CONTINUATION"
  | "EXHAUSTION"
  | "DIVERGENCE"
  | "NEUTRAL";

export interface MomentumQualityResult {
  state: MomentumState;
  roc: number;
  rsi: number | null;
  adx: number | null;
  diPlus: number | null;
  diMinus: number | null;
  emaSlope: number | null;
  priceAcceleration: number;
  score: number;
  reasons: string[];
}

// ─── Volume Intelligence ──────────────────────────────────────────────────────

export interface VolumeIntelligenceResult {
  rvol: number | null;           // Relative volume vs 20-day avg
  volumePercentile: number | null; // [0, 100]
  volumeAcceleration: number | null;
  volumeSurprise: number | null; // today - expected for time-of-day
  upDownVolumeRatio: number | null;
  priceVolumeConfirm: boolean;
  volumeClimax: boolean;
  volumeExhaustion: boolean;
  intradayTimeAdjustedRvol: number | null;
  score: number;
  reasons: string[];
}

// ─── Volatility Regime ────────────────────────────────────────────────────────

export interface VolatilityRegimeResult {
  regime: VolatilityRegimeLabel;
  atrPercentile: number | null;    // [0, 100]
  realizedVol: number | null;      // annualised %
  intradayRangePercentile: number | null;
  gapMagnitude: number | null;     // gap as % of prev close
  vixRegime: VolatilityRegimeLabel;
  volatilityExpanding: boolean;
  volatilityCompressing: boolean;
  /** Whether this strategy's declared regimes include the current one */
  regimeSupportedByStrategy: boolean;
  score: number;
  reasons: string[];
}

// ─── Market Structure ─────────────────────────────────────────────────────────

export type StructureEvent =
  | "BOS"              // Break of Structure
  | "CHOCH"            // Change of Character
  | "LIQUIDITY_SWEEP"  // Equal H/L swept
  | "EQUAL_HIGH"
  | "EQUAL_LOW"
  | "ORDER_BLOCK"
  | "FAIR_VALUE_GAP"
  | "DISPLACEMENT"
  | "STRUCTURE_RETEST";

export interface MarketStructureEvent {
  event: StructureEvent;
  timestamp: number;    // UTC ms when event occurred
  price: number;
  direction: "BULLISH" | "BEARISH";
  strength: "STRONG" | "MODERATE" | "WEAK";
  /** UTC ms when this event expires (stale events should not be used) */
  validUntil: number;
  mitigated: boolean;
  invalidated: boolean;
}

export interface MarketStructureResult {
  events: MarketStructureEvent[];
  swingHigh: number | null;
  swingLow: number | null;
  structureBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  activeStructureCount: number;
  score: number;
  reasons: string[];
}

// ─── Helper indicator functions (pure) ───────────────────────────────────────

function simpleEma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * alpha + ema * (1 - alpha);
  }
  return ema;
}

function simpleRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-((period * 2) + 1));
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = slice[i] - slice[i - 1];
    avgGain += diff > 0 ? diff : 0;
    avgLoss += diff < 0 ? -diff : 0;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function simpleRoc(closes: number[], period = 10): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  if (past === 0) return 0;
  return ((current - past) / past) * 100;
}

function percentileRank(values: number[], current: number): number {
  if (values.length === 0) return 50;
  const below = values.filter((v) => v < current).length;
  return (below / values.length) * 100;
}

// ─── Layer 3: Market Structure ────────────────────────────────────────────────

export function evaluateMarketStructure(
  candles: OHLCVCandle[],
  direction: SignalDirection,
  nowMs: number,
): MarketStructureResult {
  if (candles.length < 20) {
    return {
      events: [],
      swingHigh: null,
      swingLow: null,
      structureBias: "NEUTRAL",
      activeStructureCount: 0,
      score: 0.5,
      reasons: ["Insufficient candles for structure analysis"],
    };
  }

  const recent = candles.slice(-50);
  // Simple swing high/low detection (look-back 5 bars each side)
  const N = 5;
  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  const events: MarketStructureEvent[] = [];

  for (let i = N; i < recent.length - N; i++) {
    const c = recent[i];
    const leftHighs = recent.slice(i - N, i).map((x) => x.high);
    const rightHighs = recent.slice(i + 1, i + N + 1).map((x) => x.high);
    const leftLows = recent.slice(i - N, i).map((x) => x.low);
    const rightLows = recent.slice(i + 1, i + N + 1).map((x) => x.low);

    if (
      c.high > Math.max(...leftHighs) &&
      c.high > Math.max(...rightHighs)
    ) {
      swingHigh = c.high;
    }
    if (c.low < Math.min(...leftLows) && c.low < Math.min(...rightLows)) {
      swingLow = c.low;
    }
  }

  // Simple BOS detection: last 3 closes above/below last swing
  const lastCandles = recent.slice(-3);
  if (swingHigh !== null) {
    const bosUp = lastCandles.every((c) => c.close > swingHigh!);
    if (bosUp) {
      events.push({
        event: "BOS",
        timestamp: (lastCandles[0].time ?? 0) * 1000,
        price: swingHigh,
        direction: "BULLISH",
        strength: "MODERATE",
        validUntil: nowMs + 4 * 60 * 60 * 1000, // 4h expiry
        mitigated: false,
        invalidated: false,
      });
    }
  }
  if (swingLow !== null) {
    const bosDown = lastCandles.every((c) => c.close < swingLow!);
    if (bosDown) {
      events.push({
        event: "BOS",
        timestamp: (lastCandles[0].time ?? 0) * 1000,
        price: swingLow,
        direction: "BEARISH",
        strength: "MODERATE",
        validUntil: nowMs + 4 * 60 * 60 * 1000,
        mitigated: false,
        invalidated: false,
      });
    }
  }

  // Simple FVG detection: gap between candle[i-1].high and candle[i+1].low
  for (let i = 1; i < recent.length - 1; i++) {
    const prev = recent[i - 1];
    const next = recent[i + 1];
    if (next.low > prev.high) {
      events.push({
        event: "FAIR_VALUE_GAP",
        timestamp: (recent[i].time ?? 0) * 1000,
        price: (prev.high + next.low) / 2,
        direction: "BULLISH",
        strength: "WEAK",
        validUntil: nowMs + 8 * 60 * 60 * 1000,
        mitigated: false,
        invalidated: false,
      });
    } else if (prev.low > next.high) {
      events.push({
        event: "FAIR_VALUE_GAP",
        timestamp: (recent[i].time ?? 0) * 1000,
        price: (prev.low + next.high) / 2,
        direction: "BEARISH",
        strength: "WEAK",
        validUntil: nowMs + 8 * 60 * 60 * 1000,
        mitigated: false,
        invalidated: false,
      });
    }
  }

  // Filter out expired events
  const activeEvents = events.filter((e) => e.validUntil > nowMs && !e.invalidated);

  const bullish = activeEvents.filter((e) => e.direction === "BULLISH").length;
  const bearish = activeEvents.filter((e) => e.direction === "BEARISH").length;
  const structureBias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    bullish > bearish ? "BULLISH" : bearish > bullish ? "BEARISH" : "NEUTRAL";

  const isLong = direction === "LONG";
  const aligned =
    (isLong && structureBias === "BULLISH") ||
    (!isLong && structureBias === "BEARISH");
  const score = aligned ? 0.7 : structureBias === "NEUTRAL" ? 0.5 : 0.3;
  const reasons = [`Structure bias: ${structureBias}, active events: ${activeEvents.length}`];

  return {
    events: activeEvents,
    swingHigh,
    swingLow,
    structureBias,
    activeStructureCount: activeEvents.length,
    score,
    reasons,
  };
}

// ─── Layer 4: Momentum Quality ────────────────────────────────────────────────

export function evaluateMomentumQuality(
  candles: OHLCVCandle[],
  direction: SignalDirection,
): MomentumQualityResult {
  const closes = candles.map((c) => c.close);
  const roc = simpleRoc(closes, 10);
  const rsi = simpleRsi(closes, 14);
  const adxPeriod = 14;
  let adx: number | null = null;
  let diPlus: number | null = null;
  let diMinus: number | null = null;

  if (candles.length >= adxPeriod * 2) {
    // Simple DX approximation
    const slice = candles.slice(-(adxPeriod * 2 + 1));
    let smoothTR = 0; let smoothDMp = 0; let smoothDMm = 0;
    for (let i = 1; i <= adxPeriod; i++) {
      const c = slice[i]; const p = slice[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      const up = c.high - p.high; const down = p.low - c.low;
      smoothTR += tr;
      smoothDMp += up > down && up > 0 ? up : 0;
      smoothDMm += down > up && down > 0 ? down : 0;
    }
    let prevAdx = 0;
    for (let i = adxPeriod + 1; i < slice.length; i++) {
      const c = slice[i]; const p = slice[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      const up = c.high - p.high; const down = p.low - c.low;
      smoothTR = smoothTR - smoothTR / adxPeriod + tr;
      smoothDMp = smoothDMp - smoothDMp / adxPeriod + (up > down && up > 0 ? up : 0);
      smoothDMm = smoothDMm - smoothDMm / adxPeriod + (down > up && down > 0 ? down : 0);
      const dP = smoothTR > 0 ? (smoothDMp / smoothTR) * 100 : 0;
      const dM = smoothTR > 0 ? (smoothDMm / smoothTR) * 100 : 0;
      const dxVal = dP + dM > 0 ? (Math.abs(dP - dM) / (dP + dM)) * 100 : 0;
      prevAdx = i === adxPeriod + 1 ? dxVal : (prevAdx * (adxPeriod - 1) + dxVal) / adxPeriod;
      diPlus = dP;
      diMinus = dM;
    }
    adx = prevAdx;
  }

  // EMA slope
  const ema9 = simpleEma(closes, 9);
  const ema9Prev = closes.length >= 11 ? simpleEma(closes.slice(0, -1), 9) : null;
  const emaSlope = ema9 !== null && ema9Prev !== null ? ema9 - ema9Prev : null;

  // Price acceleration (current ROC vs previous ROC)
  const rocPrev = closes.length >= 22 ? simpleRoc(closes.slice(0, -1), 10) : 0;
  const priceAcceleration = roc - rocPrev;

  const isLong = direction === "LONG";

  // Detect state
  let state: MomentumState = "NEUTRAL";
  const reasons: string[] = [];

  if (rsi !== null) {
    if (isLong && rsi > 60 && roc > 0) { state = "CONTINUATION"; reasons.push(`RSI ${rsi.toFixed(0)} in bullish zone, ROC ${roc.toFixed(2)}%`); }
    else if (!isLong && rsi < 40 && roc < 0) { state = "CONTINUATION"; reasons.push(`RSI ${rsi.toFixed(0)} in bearish zone, ROC ${roc.toFixed(2)}%`); }
    else if (isLong && rsi > 75) { state = "EXHAUSTION"; reasons.push(`RSI ${rsi.toFixed(0)} — overbought, momentum may be exhausted`); }
    else if (!isLong && rsi < 25) { state = "EXHAUSTION"; reasons.push(`RSI ${rsi.toFixed(0)} — oversold, momentum may be exhausted`); }
    else if (isLong && rsi < 40 && roc > 0) { state = "DIVERGENCE"; reasons.push(`RSI bearish but price rising — divergence`); }
    else if (!isLong && rsi > 60 && roc < 0) { state = "DIVERGENCE"; reasons.push(`RSI bullish but price falling — divergence`); }
  }

  if (adx !== null) {
    if (adx > 25) reasons.push(`ADX ${adx.toFixed(0)} — trending`);
    else if (adx < 15) reasons.push(`ADX ${adx.toFixed(0)} — ranging`);
  }

  const contBonus = state === "CONTINUATION" ? 0.2 : state === "EXHAUSTION" ? -0.2 : state === "DIVERGENCE" ? -0.1 : 0;
  const dirScore = isLong ? Math.min(1, Math.max(0, (roc + 5) / 10)) : Math.min(1, Math.max(0, (-roc + 5) / 10));
  const score = Math.max(0, Math.min(1, dirScore + contBonus));

  return { state, roc, rsi, adx, diPlus, diMinus, emaSlope, priceAcceleration, score, reasons };
}

// ─── Layer 5: Volume Intelligence ────────────────────────────────────────────

/**
 * Time-of-day normalized volume. NSE intraday volume profile:
 * First 30 min (09:15–09:45) is heaviest; lunch hour (12–13) is lightest.
 * These multipliers normalize volume so 09:20 is not naively compared to 13:00.
 */
const TOD_VOLUME_MULTIPLIERS: Record<string, number> = {
  "09:15": 2.5,
  "09:30": 2.0,
  "10:00": 1.5,
  "11:00": 1.2,
  "12:00": 0.8,
  "13:00": 0.8,
  "14:00": 1.0,
  "15:00": 1.3,
  "15:15": 1.5,
};

function getTodMultiplier(istMinutes: number): number {
  if (istMinutes < 9 * 60 + 30) return 2.5;
  if (istMinutes < 10 * 60) return 2.0;
  if (istMinutes < 11 * 60) return 1.5;
  if (istMinutes < 12 * 60) return 1.2;
  if (istMinutes < 13 * 60) return 0.8;
  if (istMinutes < 14 * 60) return 0.8;
  if (istMinutes < 15 * 60) return 1.0;
  return 1.3;
}

export function evaluateVolumeIntelligence(
  candles: OHLCVCandle[],
  currentVolume: number | null,
  avgVolume20d: number | null,
  direction: SignalDirection,
  nowMs: number,
): VolumeIntelligenceResult {
  const reasons: string[] = [];

  // RVOL
  const rvol =
    avgVolume20d !== null && avgVolume20d > 0 && currentVolume !== null
      ? currentVolume / avgVolume20d
      : null;

  // Time-of-day adjusted RVOL
  const istMins = Math.floor(((nowMs % (24 * 3600 * 1000)) + 5.5 * 3600 * 1000) / 60000) % (24 * 60);
  const todMultiplier = getTodMultiplier(istMins);
  const intradayTimeAdjustedRvol = rvol !== null ? rvol / todMultiplier : null;

  // Volume percentile from candle history
  const vols = candles.map((c) => c.volume ?? 0).filter((v) => v > 0);
  const volumePercentile =
    currentVolume !== null && vols.length > 0
      ? percentileRank(vols, currentVolume)
      : null;

  // Volume acceleration: last bar vs prev
  const lastVol = candles.length > 0 ? (candles[candles.length - 1].volume ?? 0) : 0;
  const prevVol = candles.length > 1 ? (candles[candles.length - 2].volume ?? 0) : 0;
  const volumeAcceleration = prevVol > 0 ? (lastVol - prevVol) / prevVol : null;

  // Price-volume confirmation
  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const prevClose = candles.length > 1 ? candles[candles.length - 2].close : 0;
  const priceUp = lastClose > prevClose;
  const volUp = lastVol > prevVol;
  const priceVolumeConfirm =
    (direction === "LONG" && priceUp && volUp) ||
    (direction === "SHORT" && !priceUp && volUp) ||
    direction === "NEUTRAL";

  // Volume climax / exhaustion
  const volumeClimax = rvol !== null && rvol >= 3.0;
  const volumeExhaustion = rvol !== null && rvol < 0.3;

  // Volume surprise (stub: compare to expected based on time-of-day)
  const volumeSurprise = intradayTimeAdjustedRvol !== null ? intradayTimeAdjustedRvol - 1 : null;

  if (rvol !== null) {
    if (rvol >= 2.0) reasons.push(`RVOL ${rvol.toFixed(1)}× — strong volume`);
    else if (rvol < 0.5) reasons.push(`RVOL ${rvol.toFixed(1)}× — thin volume`);
  }
  if (volumeClimax) reasons.push("Volume climax detected");
  if (!priceVolumeConfirm) reasons.push("Price-volume divergence");

  // Score
  let score = 0.5;
  if (rvol !== null) {
    score = rvol >= 2.0 ? 0.85 : rvol >= 1.5 ? 0.7 : rvol >= 1.0 ? 0.55 : rvol >= 0.5 ? 0.4 : 0.25;
  }
  if (!priceVolumeConfirm) score -= 0.15;
  if (volumeClimax) score = Math.max(score, 0.8);
  score = Math.max(0, Math.min(1, score));

  return {
    rvol,
    volumePercentile,
    volumeAcceleration,
    volumeSurprise,
    upDownVolumeRatio: null, // requires tick data
    priceVolumeConfirm,
    volumeClimax,
    volumeExhaustion,
    intradayTimeAdjustedRvol,
    score,
    reasons,
  };
}

// ─── Layer 6: Volatility Regime ────────────────────────────────────────────

export function evaluateVolatilityRegime(
  candles: OHLCVCandle[],
  currentAtr: number | null,
  vix: number | null,
  strategyVolatilitySupport: VolatilityRegimeLabel[],
): VolatilityRegimeResult {
  const reasons: string[] = [];

  // ATR percentile from history
  const atrs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]; const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atrs.push(tr);
  }
  const atrPercentile = currentAtr !== null && atrs.length > 0 ? percentileRank(atrs, currentAtr) : null;

  // Intraday range percentile
  const ranges = candles.map((c) => c.high - c.low);
  const currentRange = candles.length > 0 ? candles[candles.length - 1].high - candles[candles.length - 1].low : 0;
  const intradayRangePercentile = ranges.length > 0 ? percentileRank(ranges, currentRange) : null;

  // Realized vol (simple annualised from daily returns)
  let realizedVol: number | null = null;
  if (candles.length >= 20) {
    const returns = [];
    for (let i = 1; i < candles.length; i++) {
      if (candles[i - 1].close > 0) {
        returns.push(Math.log(candles[i].close / candles[i - 1].close));
      }
    }
    if (returns.length >= 20) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
      realizedVol = Math.sqrt(variance * 252) * 100;
    }
  }

  // VIX regime
  const vixRegime: VolatilityRegimeLabel =
    vix === null ? "NORMAL" :
    vix >= 25 ? "EXTREME" :
    vix >= 18 ? "HIGH" :
    vix >= 12 ? "NORMAL" :
    vix >= 8 ? "LOW" : "VERY_LOW";

  // Current regime
  const regime: VolatilityRegimeLabel =
    atrPercentile === null ? "NORMAL" :
    atrPercentile >= 90 ? "EXTREME" :
    atrPercentile >= 70 ? "HIGH" :
    atrPercentile >= 30 ? "NORMAL" :
    atrPercentile >= 10 ? "LOW" : "VERY_LOW";

  const volatilityExpanding = atrPercentile !== null && atrPercentile >= 70;
  const volatilityCompressing = atrPercentile !== null && atrPercentile <= 30;

  const regimeSupportedByStrategy = strategyVolatilitySupport.includes(regime);

  if (!regimeSupportedByStrategy) reasons.push(`Regime ${regime} not in strategy's supported regimes: [${strategyVolatilitySupport.join(", ")}]`);
  if (vix !== null) reasons.push(`India VIX: ${vix.toFixed(1)} (${vixRegime})`);
  if (atrPercentile !== null) reasons.push(`ATR percentile: ${atrPercentile.toFixed(0)}th`);

  const score = regimeSupportedByStrategy ? (regime === "NORMAL" ? 0.8 : regime === "HIGH" ? 0.65 : 0.5) : 0.3;
  const gapMagnitude = candles.length >= 2 && candles[candles.length - 2].close > 0
    ? Math.abs((candles[candles.length - 1].open - candles[candles.length - 2].close) / candles[candles.length - 2].close) * 100
    : null;

  return { regime, atrPercentile, realizedVol, intradayRangePercentile, gapMagnitude, vixRegime, volatilityExpanding, volatilityCompressing, regimeSupportedByStrategy, score, reasons };
}

// ─── Layer 7: Liquidity & Execution Quality ───────────────────────────────────

export interface LiquidityResult {
  bidAskSpread: number | null;
  spreadPct: number | null;
  liquidityScore: number;
  estimatedSlippagePct: number;
  executionQuality: "EXCELLENT" | "GOOD" | "FAIR" | "POOR";
  rejected: boolean;
  rejectionReason: string | null;
  reasons: string[];
}

/**
 * NSE F&O typical spread thresholds (% of price):
 * - < 0.05% = excellent
 * - 0.05–0.15% = good  
 * - 0.15–0.30% = fair
 * - > 0.30% = poor (consider skipping)
 */
export function evaluateLiquidity(
  bidAskSpread: number | null,
  ltp: number | null,
  volume: number | null,
  avgVolume20d: number | null,
): LiquidityResult {
  const reasons: string[] = [];

  const spreadPct =
    bidAskSpread !== null && ltp !== null && ltp > 0
      ? (bidAskSpread / ltp) * 100
      : null;

  let executionQuality: "EXCELLENT" | "GOOD" | "FAIR" | "POOR" = "GOOD";
  let rejected = false;
  let rejectionReason: string | null = null;

  if (spreadPct !== null) {
    if (spreadPct < 0.05) { executionQuality = "EXCELLENT"; }
    else if (spreadPct < 0.15) { executionQuality = "GOOD"; }
    else if (spreadPct < 0.30) { executionQuality = "FAIR"; reasons.push(`Spread ${spreadPct.toFixed(3)}% — fair`); }
    else {
      executionQuality = "POOR";
      rejected = true;
      rejectionReason = `Spread ${spreadPct.toFixed(3)}% exceeds 0.30% threshold`;
      reasons.push(rejectionReason);
    }
  }

  // Volume check
  const rvol = avgVolume20d !== null && avgVolume20d > 0 && volume !== null ? volume / avgVolume20d : null;
  if (rvol !== null && rvol < 0.2) {
    rejected = true;
    rejectionReason = `Volume ${(rvol * 100).toFixed(0)}% of average — liquidity insufficient`;
    reasons.push(rejectionReason);
  }

  const estimatedSlippagePct = spreadPct !== null ? spreadPct / 2 : 0.05;

  const liquidityScore =
    executionQuality === "EXCELLENT" ? 1.0 :
    executionQuality === "GOOD" ? 0.8 :
    executionQuality === "FAIR" ? 0.5 : 0.2;

  return { bidAskSpread, spreadPct, liquidityScore, estimatedSlippagePct, executionQuality, rejected, rejectionReason, reasons };
}

// ─── Breakout Quality Engine ─────────────────────────────────────────────────

export function evaluateBreakoutQuality(
  candles: OHLCVCandle[],
  breakoutLevel: number,
  direction: "UP" | "DOWN",
  currentClose: number,
  currentVolume: number | null,
  avgVolume20d: number | null,
  atr: number | null,
): BreakoutQualityResult {
  const reasons: string[] = [];

  if (candles.length < 8) {
    return {
      quality: "WEAK_BREAKOUT",
      rangeWidth: 0, atrNormalizedRange: 0, volumeExpansion: 0,
      rvol: 0, closeLocation: 0.5, breakoutDistance: 0, followThrough: false,
      falseProbability: 0.7, score: 0.2, reasons: ["Insufficient data"],
    };
  }

  const recent = candles.slice(-8);
  const rangeHigh = Math.max(...recent.slice(0, -1).map((c) => c.high));
  const rangeLow = Math.min(...recent.slice(0, -1).map((c) => c.low));
  const rangeWidth = rangeHigh - rangeLow;

  const last = candles[candles.length - 1];
  const totalRange = last.high - last.low;
  const closeLocation = totalRange > 0 ? (last.close - last.low) / totalRange : 0.5;

  const atrNormalizedRange = atr !== null && atr > 0 ? rangeWidth / atr : 1;
  const breakoutDistance =
    breakoutLevel > 0
      ? (Math.abs(currentClose - breakoutLevel) / breakoutLevel) * 100
      : 0;

  const rvol =
    avgVolume20d !== null && avgVolume20d > 0 && currentVolume !== null
      ? currentVolume / avgVolume20d
      : null;
  const volumeExpansion = rvol ?? 1;

  // Follow-through: next bar continues in breakout direction
  const followThrough =
    candles.length >= 2 &&
    (direction === "UP"
      ? candles[candles.length - 1].close > candles[candles.length - 2].close
      : candles[candles.length - 1].close < candles[candles.length - 2].close);

  // False breakout probability factors
  let falseProbability = 0.4;
  if (closeLocation < 0.4 && direction === "UP") { falseProbability += 0.2; reasons.push("Weak close location suggests false breakout"); }
  if (volumeExpansion < 1.0) { falseProbability += 0.15; reasons.push("Volume below average — weak confirmation"); }
  if (!followThrough) { falseProbability += 0.1; }
  if (breakoutDistance < 0.1) { falseProbability += 0.1; reasons.push("Minimal breakout distance"); }
  falseProbability = Math.min(0.9, falseProbability);

  // Score
  let score = 0.5;
  if (volumeExpansion >= 2.0) { score += 0.15; reasons.push(`Strong volume ${volumeExpansion.toFixed(1)}×`); }
  if (closeLocation >= 0.7 && direction === "UP") { score += 0.1; }
  if (followThrough) { score += 0.1; reasons.push("Follow-through confirmed"); }
  if (breakoutDistance >= 0.3) { score += 0.1; }
  score = Math.max(0, Math.min(1, score - falseProbability * 0.3));

  // Quality classification
  let quality: BreakoutQuality;
  if (score >= 0.8 && volumeExpansion >= 2.0 && followThrough) quality = "STRONG_BREAKOUT";
  else if (score >= 0.6 && volumeExpansion >= 1.2) quality = "VALID_BREAKOUT";
  else if (falseProbability >= 0.6 || (volumeExpansion < 0.8 && closeLocation < 0.4)) quality = "EXHAUSTION_BREAKOUT";
  else quality = "WEAK_BREAKOUT";

  return { quality, rangeWidth, atrNormalizedRange, volumeExpansion, rvol: rvol ?? 0, closeLocation, breakoutDistance, followThrough, falseProbability, score, reasons };
}

// ─── Aggregate Layer Evaluator ────────────────────────────────────────────────

export interface MultiLayerEvaluation {
  layers: LayerResult[];
  /** Number of CONFIRM layers */
  confirmCount: number;
  /** Number of OPPOSE layers */
  opposeCount: number;
  /** Number of VETO layers (signal must be rejected) */
  vetoCount: number;
  /** Whether any layer issued a veto */
  vetoed: boolean;
  /** Weighted composite score [0, 1] */
  compositeScore: number;
  /** Direction supported by most layers */
  dominantDirection: SignalDirection;
  /** Overall quality */
  overallQuality: "HIGH" | "MEDIUM" | "LOW" | "CRITICAL";
  reasons: string[];
}

/**
 * Aggregate multiple layer results into a MultiLayerEvaluation.
 * Layers with VETO status immediately flag the signal for rejection.
 */
export function aggregateLayerResults(layers: LayerResult[]): MultiLayerEvaluation {
  const weights: Record<LayerName, number> = {
    MARKET_CONTEXT:   0.12,
    REGIME:           0.10,
    STRUCTURE:        0.10,
    MOMENTUM:         0.10,
    VOLUME:           0.12,
    VOLATILITY:       0.08,
    LIQUIDITY:        0.10,
    DERIVATIVES:      0.10,
    RELATIVE_STRENGTH: 0.08,
    ML:               0.05,
    RISK:             0.03,
    EXECUTION:        0.02,
  };

  let confirmCount = 0;
  let opposeCount = 0;
  let vetoCount = 0;
  let totalWeight = 0;
  let weightedScore = 0;
  const reasons: string[] = [];
  const longVotes: number[] = [];
  const shortVotes: number[] = [];

  for (const layer of layers) {
    if (layer.status === "VETO") {
      vetoCount++;
      reasons.push(`VETO [${layer.layer}]: ${layer.reason}`);
      continue;
    }
    if (layer.status === "UNAVAILABLE") continue;
    if (!layer.contributing) continue;

    if (layer.status === "CONFIRM") confirmCount++;
    else if (layer.status === "OPPOSE") opposeCount++;

    const w = weights[layer.layer] ?? 0.05;
    totalWeight += w;
    weightedScore += layer.score * w;

    if (layer.direction === "LONG") longVotes.push(layer.score);
    else if (layer.direction === "SHORT") shortVotes.push(layer.score);

    if (layer.quality === "LOW" || layer.status === "OPPOSE") {
      reasons.push(`[${layer.layer}]: ${layer.reason}`);
    }
  }

  const compositeScore = totalWeight > 0 ? weightedScore / totalWeight : 0.5;
  const vetoed = vetoCount > 0;

  const avgLong = longVotes.length > 0 ? longVotes.reduce((a, b) => a + b, 0) / longVotes.length : 0;
  const avgShort = shortVotes.length > 0 ? shortVotes.reduce((a, b) => a + b, 0) / shortVotes.length : 0;
  const dominantDirection: SignalDirection =
    avgLong > avgShort + 0.1 ? "LONG" :
    avgShort > avgLong + 0.1 ? "SHORT" : "NEUTRAL";

  const criticalLayers = layers.filter((l) => l.quality === "CRITICAL").length;
  const overallQuality =
    vetoed || criticalLayers > 0 ? "CRITICAL" :
    compositeScore >= 0.7 ? "HIGH" :
    compositeScore >= 0.5 ? "MEDIUM" : "LOW";

  return { layers, confirmCount, opposeCount, vetoCount, vetoed, compositeScore, dominantDirection, overallQuality, reasons };
}
