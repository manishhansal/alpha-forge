/**
 * OpportunityDetector
 *
 * Detects potentially tradeable market events from raw market data.
 * Detection is NOT approval — it merely identifies that a candidate
 * opportunity may exist and classifies the setup type.
 *
 * Detection types:
 *   A. Breakout — compression → expansion
 *   B. Trend continuation — pullback in established trend
 *   C. Mean reversion — stretched move returning to mean
 *   D. Liquidity event — stop sweep / failed breakout
 *   E. Opening opportunity — opening range / gap analysis
 *
 * Each detected opportunity is a CANDIDATE only. It must then pass the
 * full quality → EV → hard gate → risk pipeline before becoming a trade.
 *
 * This module is I/O-free. The caller provides all market data.
 */

import type { OHLCVCandle } from "@/lib/market-data/types";
import type { SetupType } from "./types";

// ─── Detection Result ─────────────────────────────────────────────────────────

export interface DetectionResult {
  detected: boolean;
  setupType: SetupType;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  /** Detection confidence [0, 1] — NOT a trade signal, just detection strength */
  detectionStrength: number;
  /** Price level where setup is triggered */
  triggerLevel: number | null;
  /** Price level where setup is invalidated */
  invalidationLevel: number | null;
  /** Approximate target projection */
  projectedTarget: number | null;
  reasons: string[];
  /** Whether this is a FRESH detection (< 1 ATR from trigger) or already extended */
  isFresh: boolean;
  /** Whether retest of breakout level has occurred */
  isRetest: boolean;
  /** Time elapsed since setup formation (ms) */
  ageMs: number;
}

// ─── Breakout Opportunity Detector ───────────────────────────────────────────

/**
 * Detect breakout conditions:
 *   - Pre-breakout compression (BB width narrowing)
 *   - Range contraction
 *   - Resistance proximity
 *   - Volume expansion on breakout bar
 *   - Displacement
 *   - Successful breakout
 *   - Retest of breakout level
 */
export function detectBreakout(
  candles: OHLCVCandle[],
  atr: number | null,
  volumeAvg20d: number | null,
  nowMs: number,
): DetectionResult {
  const noDetection: DetectionResult = {
    detected: false, setupType: "BREAKOUT", direction: "NEUTRAL",
    detectionStrength: 0, triggerLevel: null, invalidationLevel: null,
    projectedTarget: null, reasons: [], isFresh: false, isRetest: false, ageMs: 0,
  };

  if (candles.length < 20 || atr === null || atr <= 0) return noDetection;

  const recent = candles.slice(-20);
  const last = recent[recent.length - 1];
  const lookback = recent.slice(0, -1);

  const resistanceHigh = Math.max(...lookback.map(c => c.high));
  const supportLow = Math.min(...lookback.map(c => c.low));
  const rangeWidth = resistanceHigh - supportLow;
  const atrNormalizedRange = rangeWidth / atr;

  // Compression: range width < 2.5× ATR = compressed
  const isCompressed = atrNormalizedRange < 2.5;

  // Volume expansion on last bar
  const lastVol = last.volume ?? 0;
  const rvol = volumeAvg20d && volumeAvg20d > 0 ? lastVol / volumeAvg20d : null;
  const volumeExpanding = rvol !== null && rvol >= 1.3;

  // Breakout above resistance
  const isBreakoutUp = last.close > resistanceHigh && last.close > last.open;
  const isBreakoutDown = last.close < supportLow && last.close < last.open;

  // Displacement: close in top/bottom 20% of bar range
  const barRange = last.high - last.low;
  const closeLocation = barRange > 0 ? (last.close - last.low) / barRange : 0.5;
  const strongDisplacement = (isBreakoutUp && closeLocation > 0.7) ||
    (isBreakoutDown && closeLocation < 0.3);

  // Breakout distance (how far beyond the level)
  const breakoutDistanceUp = isBreakoutUp ? (last.close - resistanceHigh) / resistanceHigh * 100 : 0;
  const breakoutDistanceDown = isBreakoutDown ? (supportLow - last.close) / supportLow * 100 : 0;

  // Retest: price previously broke out and has returned to retest the level
  const isRetest = candles.length >= 25 && (() => {
    const older = candles.slice(-25, -5);
    const brokeUp = older.some(c => c.close > resistanceHigh);
    const retestingUp = last.close < resistanceHigh && last.close > resistanceHigh * 0.995;
    const brokeDown = older.some(c => c.close < supportLow);
    const retestingDown = last.close > supportLow && last.close < supportLow * 1.005;
    return (brokeUp && retestingUp) || (brokeDown && retestingDown);
  })();

  const reasons: string[] = [];
  let detectionStrength = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let triggerLevel: number | null = null;
  let invalidationLevel: number | null = null;
  let projectedTarget: number | null = null;

  if (isBreakoutUp || (isCompressed && last.close > resistanceHigh * 0.998)) {
    direction = "LONG";
    triggerLevel = resistanceHigh;
    invalidationLevel = supportLow;
    projectedTarget = resistanceHigh + rangeWidth;

    if (isBreakoutUp) {
      detectionStrength += 0.5;
      reasons.push(`Breakout above ${resistanceHigh.toFixed(2)}`);
    }
    if (isCompressed) { detectionStrength += 0.15; reasons.push("Compressed range"); }
    if (volumeExpanding) { detectionStrength += 0.2; reasons.push(`Volume ${rvol?.toFixed(1)}× avg`); }
    if (strongDisplacement) { detectionStrength += 0.1; reasons.push("Strong close location"); }
    if (isRetest) { detectionStrength += 0.05; reasons.push("Retest of breakout level"); }
  } else if (isBreakoutDown || (isCompressed && last.close < supportLow * 1.002)) {
    direction = "SHORT";
    triggerLevel = supportLow;
    invalidationLevel = resistanceHigh;
    projectedTarget = supportLow - rangeWidth;

    if (isBreakoutDown) {
      detectionStrength += 0.5;
      reasons.push(`Breakdown below ${supportLow.toFixed(2)}`);
    }
    if (isCompressed) { detectionStrength += 0.15; reasons.push("Compressed range"); }
    if (volumeExpanding) { detectionStrength += 0.2; reasons.push(`Volume ${rvol?.toFixed(1)}× avg`); }
    if (strongDisplacement) { detectionStrength += 0.1; reasons.push("Strong close location"); }
    if (isRetest) { detectionStrength += 0.05; reasons.push("Retest of breakdown level"); }
  } else if (isCompressed && volumeExpanding) {
    // Pre-breakout: coiling without direction yet
    direction = "NEUTRAL";
    detectionStrength = 0.3;
    reasons.push("Coiling before breakout — direction unclear");
  } else {
    return noDetection;
  }

  detectionStrength = Math.min(1, detectionStrength);

  // Freshness: is price still within 0.5× ATR of trigger level?
  const distFromTrigger = triggerLevel ? Math.abs(last.close - triggerLevel) : 0;
  const isFresh = distFromTrigger < atr * 0.5;

  // Reject overly extended moves (> 2× ATR from trigger)
  const tooExtended = distFromTrigger > atr * 2;
  if (tooExtended && direction !== "NEUTRAL") {
    reasons.push("Extended — missed ideal entry");
    detectionStrength *= 0.4;
  }

  const lastMs = (last.time ?? 0) * 1000;
  const ageMs = nowMs - lastMs;

  return {
    detected: detectionStrength >= 0.3,
    setupType: isRetest ? "BREAKOUT_RETEST" : "BREAKOUT",
    direction,
    detectionStrength,
    triggerLevel,
    invalidationLevel,
    projectedTarget,
    reasons,
    isFresh,
    isRetest,
    ageMs,
  };
}

// ─── Trend Continuation Detector ─────────────────────────────────────────────

export function detectTrendContinuation(
  candles: OHLCVCandle[],
  atr: number | null,
  sma20: number | null,
  sma50: number | null,
  rsi: number | null,
  volumeAvg20d: number | null,
  nowMs: number,
): DetectionResult {
  const noDetection: DetectionResult = {
    detected: false, setupType: "TREND_CONTINUATION", direction: "NEUTRAL",
    detectionStrength: 0, triggerLevel: null, invalidationLevel: null,
    projectedTarget: null, reasons: [], isFresh: false, isRetest: false, ageMs: 0,
  };

  if (candles.length < 30 || atr === null) return noDetection;

  const last = candles[candles.length - 1];
  const reasons: string[] = [];
  let strength = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  // Established trend: SMA20 > SMA50 + price above SMA20
  const bullTrend = sma20 !== null && sma50 !== null && sma20 > sma50 && last.close > sma20;
  const bearTrend = sma20 !== null && sma50 !== null && sma20 < sma50 && last.close < sma20;

  if (bullTrend) {
    direction = "LONG";
    strength += 0.35;
    reasons.push(`Bull trend: SMA20(${sma20?.toFixed(0)}) > SMA50(${sma50?.toFixed(0)}), price above SMA20`);

    // Pullback from overbought (RSI 45-60 = healthy pullback in uptrend)
    if (rsi !== null && rsi >= 40 && rsi <= 65) {
      strength += 0.2;
      reasons.push(`RSI ${rsi.toFixed(0)} — constructive pullback in uptrend`);
    }

    // Volume confirming
    const lastVol = last.volume ?? 0;
    const rvol = volumeAvg20d && volumeAvg20d > 0 ? lastVol / volumeAvg20d : null;
    if (rvol !== null && rvol >= 1.2) {
      strength += 0.15;
      reasons.push(`Volume ${rvol.toFixed(1)}× avg — institutional participation`);
    }

    // Price near SMA20 (pullback entry)
    if (sma20 !== null) {
      const distFromSma20 = Math.abs(last.close - sma20) / atr;
      if (distFromSma20 < 0.5) {
        strength += 0.15;
        reasons.push("Price near SMA20 — pullback entry opportunity");
      }
    }
  } else if (bearTrend) {
    direction = "SHORT";
    strength += 0.35;
    reasons.push(`Bear trend: SMA20(${sma20?.toFixed(0)}) < SMA50(${sma50?.toFixed(0)}), price below SMA20`);

    if (rsi !== null && rsi >= 35 && rsi <= 60) {
      strength += 0.2;
      reasons.push(`RSI ${rsi.toFixed(0)} — healthy bounce in downtrend`);
    }

    if (sma20 !== null) {
      const distFromSma20 = Math.abs(last.close - sma20) / atr;
      if (distFromSma20 < 0.5) {
        strength += 0.15;
        reasons.push("Price near SMA20 — bounce entry opportunity");
      }
    }
  } else {
    return noDetection;
  }

  if (strength < 0.35) return noDetection;

  const triggerLevel = last.close;
  const invalidationLevel = direction === "LONG"
    ? (sma50 ?? last.close - atr * 2)
    : (sma50 ?? last.close + atr * 2);
  const projectedTarget = direction === "LONG"
    ? last.close + atr * 2
    : last.close - atr * 2;

  const lastMs = (last.time ?? 0) * 1000;

  return {
    detected: true,
    setupType: "TREND_CONTINUATION",
    direction,
    detectionStrength: Math.min(1, strength),
    triggerLevel,
    invalidationLevel,
    projectedTarget,
    reasons,
    isFresh: true,
    isRetest: false,
    ageMs: nowMs - lastMs,
  };
}

// ─── Mean Reversion Detector ──────────────────────────────────────────────────

export function detectMeanReversion(
  candles: OHLCVCandle[],
  atr: number | null,
  rsi: number | null,
  vwap: number | null,
  nowMs: number,
): DetectionResult {
  const noDetection: DetectionResult = {
    detected: false, setupType: "MEAN_REVERSION", direction: "NEUTRAL",
    detectionStrength: 0, triggerLevel: null, invalidationLevel: null,
    projectedTarget: null, reasons: [], isFresh: false, isRetest: false, ageMs: 0,
  };

  if (candles.length < 20 || atr === null) return noDetection;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const reasons: string[] = [];
  let strength = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  // VWAP deviation
  const vwapDeviation = vwap !== null && vwap > 0
    ? (last.close - vwap) / vwap * 100 : null;

  // Statistically stretched: RSI extreme
  const oversold = rsi !== null && rsi < 30;
  const overbought = rsi !== null && rsi > 70;

  // Large single-bar move (> 1.5× ATR) then rejection candle
  const largeMove = Math.abs(last.close - prev.close) > atr * 1.5;
  const rejectionCandle = largeMove && (() => {
    const barRange = last.high - last.low;
    const closeLocation = barRange > 0 ? (last.close - last.low) / barRange : 0.5;
    return (last.close < prev.close && closeLocation > 0.6) || // bear bar closing near high = exhaustion
           (last.close > prev.close && closeLocation < 0.4);   // bull bar closing near low = exhaustion
  })();

  if (oversold || (vwapDeviation !== null && vwapDeviation < -1.5)) {
    direction = "LONG";
    if (oversold) { strength += 0.35; reasons.push(`RSI ${rsi?.toFixed(0)} — oversold`); }
    if (vwapDeviation !== null && vwapDeviation < -1.5) {
      strength += 0.25;
      reasons.push(`${vwapDeviation.toFixed(2)}% below VWAP — mean-reversion opportunity`);
    }
    if (rejectionCandle) { strength += 0.2; reasons.push("Rejection/exhaustion candle"); }
  } else if (overbought || (vwapDeviation !== null && vwapDeviation > 1.5)) {
    direction = "SHORT";
    if (overbought) { strength += 0.35; reasons.push(`RSI ${rsi?.toFixed(0)} — overbought`); }
    if (vwapDeviation !== null && vwapDeviation > 1.5) {
      strength += 0.25;
      reasons.push(`+${vwapDeviation.toFixed(2)}% above VWAP — mean-reversion opportunity`);
    }
    if (rejectionCandle) { strength += 0.2; reasons.push("Rejection/exhaustion candle"); }
  } else {
    return noDetection;
  }

  if (strength < 0.35) return noDetection;

  const targetLevel = vwap ?? last.close + (direction === "LONG" ? atr : -atr);
  const invalidation = direction === "LONG"
    ? last.low - atr * 0.5
    : last.high + atr * 0.5;

  const lastMs = (last.time ?? 0) * 1000;

  return {
    detected: true,
    setupType: "MEAN_REVERSION",
    direction,
    detectionStrength: Math.min(1, strength),
    triggerLevel: last.close,
    invalidationLevel: invalidation,
    projectedTarget: targetLevel,
    reasons,
    isFresh: true,
    isRetest: false,
    ageMs: nowMs - lastMs,
  };
}

// ─── Opening Range Detector ───────────────────────────────────────────────────

export function detectOpeningOpportunity(
  intradayCandles: OHLCVCandle[],
  atr: number | null,
  niftyChangePct: number | null,
  sessionOpenMs: number,
  nowMs: number,
): DetectionResult {
  const noDetection: DetectionResult = {
    detected: false, setupType: "OPENING_RANGE_BREAK", direction: "NEUTRAL",
    detectionStrength: 0, triggerLevel: null, invalidationLevel: null,
    projectedTarget: null, reasons: [], isFresh: false, isRetest: false, ageMs: 0,
  };

  if (intradayCandles.length < 3 || atr === null) return noDetection;

  const minutesSinceOpen = (nowMs - sessionOpenMs) / 60000;
  // Opening range only valid 15–90 minutes after open
  if (minutesSinceOpen < 15 || minutesSinceOpen > 90) return noDetection;

  // Opening range = high and low of first 3 candles (15m ORB equivalent)
  const orCandles = intradayCandles.slice(0, 3);
  const orHigh = Math.max(...orCandles.map(c => c.high));
  const orLow = Math.min(...orCandles.map(c => c.low));
  const last = intradayCandles[intradayCandles.length - 1];

  const reasons: string[] = [];
  let strength = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  const breakoutAbove = last.close > orHigh && last.close > last.open;
  const breakdownBelow = last.close < orLow && last.close < last.open;

  if (breakoutAbove) {
    direction = "LONG";
    strength = 0.5;
    reasons.push(`ORB above ${orHigh.toFixed(2)}`);

    if (niftyChangePct !== null && niftyChangePct > 0.2) {
      strength += 0.2;
      reasons.push(`NIFTY +${niftyChangePct.toFixed(2)}% — market confirms`);
    }

    const barRange = last.high - last.low;
    const closeLocation = barRange > 0 ? (last.close - last.low) / barRange : 0.5;
    if (closeLocation > 0.7) { strength += 0.15; reasons.push("Strong close location"); }
  } else if (breakdownBelow) {
    direction = "SHORT";
    strength = 0.5;
    reasons.push(`ORB below ${orLow.toFixed(2)}`);

    if (niftyChangePct !== null && niftyChangePct < -0.2) {
      strength += 0.2;
      reasons.push(`NIFTY ${niftyChangePct.toFixed(2)}% — market confirms`);
    }
  } else if (Math.abs(last.close - orHigh) < atr * 0.3) {
    direction = "LONG";
    strength = 0.25;
    reasons.push(`Price coiling near ORB high — potential breakout`);
  } else if (Math.abs(last.close - orLow) < atr * 0.3) {
    direction = "SHORT";
    strength = 0.25;
    reasons.push(`Price coiling near ORB low — potential breakdown`);
  } else {
    return noDetection;
  }

  const triggerLevel = direction === "LONG" ? orHigh : orLow;
  const invalidationLevel = direction === "LONG" ? orLow : orHigh;
  const projectedTarget = direction === "LONG"
    ? orHigh + (orHigh - orLow)
    : orLow - (orHigh - orLow);

  const distFromTrigger = Math.abs(last.close - triggerLevel);
  const isFresh = distFromTrigger < atr * 0.5;

  return {
    detected: strength >= 0.25,
    setupType: "OPENING_RANGE_BREAK",
    direction,
    detectionStrength: Math.min(1, strength),
    triggerLevel,
    invalidationLevel,
    projectedTarget,
    reasons,
    isFresh,
    isRetest: false,
    ageMs: nowMs - sessionOpenMs,
  };
}

// ─── Liquidity Event Detector ─────────────────────────────────────────────────

export function detectLiquidityEvent(
  candles: OHLCVCandle[],
  atr: number | null,
  volumeAvg20d: number | null,
  nowMs: number,
): DetectionResult {
  const noDetection: DetectionResult = {
    detected: false, setupType: "LIQUIDITY_SWEEP", direction: "NEUTRAL",
    detectionStrength: 0, triggerLevel: null, invalidationLevel: null,
    projectedTarget: null, reasons: [], isFresh: false, isRetest: false, ageMs: 0,
  };

  if (candles.length < 10 || atr === null) return noDetection;

  const recent = candles.slice(-10);
  const last = recent[recent.length - 1];
  const prevHigh = Math.max(...recent.slice(0, -1).map(c => c.high));
  const prevLow = Math.min(...recent.slice(0, -1).map(c => c.low));

  // Stop sweep: wick below previous swing low but closes back above
  const sweepLow = last.low < prevLow && last.close > prevLow;
  const sweepHigh = last.high > prevHigh && last.close < prevHigh;

  const wickSize = Math.max(last.high - last.close, last.close - last.low);
  const largeWick = wickSize > atr * 0.8;

  const lastVol = last.volume ?? 0;
  const rvol = volumeAvg20d && volumeAvg20d > 0 ? lastVol / volumeAvg20d : null;
  const highVolume = rvol !== null && rvol >= 1.5;

  const reasons: string[] = [];
  let strength = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  if (sweepLow && largeWick) {
    direction = "LONG"; // bearish sweep + recovery = bullish
    strength += 0.4;
    reasons.push(`Liquidity sweep below ${prevLow.toFixed(2)} — recovery indicates trap`);
    if (highVolume) { strength += 0.2; reasons.push(`High volume ${rvol?.toFixed(1)}× on sweep`); }
    if (largeWick) { strength += 0.15; reasons.push("Large wick confirms rejection"); }
  } else if (sweepHigh && largeWick) {
    direction = "SHORT";
    strength += 0.4;
    reasons.push(`Liquidity sweep above ${prevHigh.toFixed(2)} — rejection indicates trap`);
    if (highVolume) { strength += 0.2; reasons.push(`High volume ${rvol?.toFixed(1)}× on sweep`); }
  } else {
    return noDetection;
  }

  const invalidation = direction === "LONG" ? last.low - atr * 0.3 : last.high + atr * 0.3;
  const projected = direction === "LONG"
    ? last.close + (last.close - prevLow) * 1.5
    : last.close - (prevHigh - last.close) * 1.5;

  const lastMs = (last.time ?? 0) * 1000;

  return {
    detected: strength >= 0.4,
    setupType: "LIQUIDITY_SWEEP",
    direction,
    detectionStrength: Math.min(1, strength),
    triggerLevel: last.close,
    invalidationLevel: invalidation,
    projectedTarget: projected,
    reasons,
    isFresh: true,
    isRetest: false,
    ageMs: nowMs - lastMs,
  };
}

// ─── Opportunity Detector Facade ──────────────────────────────────────────────

export interface OpportunityDetectorInput {
  candles: OHLCVCandle[];
  intradayCandles: OHLCVCandle[];
  atr: number | null;
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  vwap: number | null;
  volumeAvg20d: number | null;
  niftyChangePct: number | null;
  sessionOpenMs: number;
  nowMs: number;
}

/**
 * Run all detectors and return the strongest detected opportunity.
 * Returns null if no valid opportunity detected.
 */
export function detectBestOpportunity(
  input: OpportunityDetectorInput,
): DetectionResult | null {
  const detections: DetectionResult[] = [];

  const breakout = detectBreakout(input.candles, input.atr, input.volumeAvg20d, input.nowMs);
  if (breakout.detected) detections.push(breakout);

  const trend = detectTrendContinuation(
    input.candles, input.atr, input.sma20, input.sma50, input.rsi, input.volumeAvg20d, input.nowMs
  );
  if (trend.detected) detections.push(trend);

  const meanRev = detectMeanReversion(input.candles, input.atr, input.rsi, input.vwap, input.nowMs);
  if (meanRev.detected) detections.push(meanRev);

  const opening = detectOpeningOpportunity(
    input.intradayCandles, input.atr, input.niftyChangePct, input.sessionOpenMs, input.nowMs
  );
  if (opening.detected) detections.push(opening);

  const liquidity = detectLiquidityEvent(input.candles, input.atr, input.volumeAvg20d, input.nowMs);
  if (liquidity.detected) detections.push(liquidity);

  if (detections.length === 0) return null;

  // Sort by detection strength descending, prefer fresh detections
  detections.sort((a, b) => {
    const freshBonus = (a.isFresh ? 0.1 : 0) - (b.isFresh ? 0.1 : 0);
    return (b.detectionStrength + freshBonus) - (a.detectionStrength + (b.isFresh ? 0.1 : 0));
  });

  return detections[0];
}
