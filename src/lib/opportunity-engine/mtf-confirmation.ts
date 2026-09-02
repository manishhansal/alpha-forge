/**
 * Multi-Timeframe Confirmation Engine
 *
 * Evaluates alignment across Daily → 1H → 15m → 5m → 1m timeframes.
 * Returns a structured alignment assessment — NOT a simple count of
 * "how many timeframes agree", but whether higher timeframes establish
 * context that the lower timeframe trade can operate within.
 *
 * Hierarchy rule:
 *   Daily bias is context — not a trade trigger
 *   1H confirms direction — required alignment
 *   15m provides setup — entry context
 *   5m is signal timeframe — entry trigger
 *   1m is execution — precision entry
 *
 * CRITICAL anti-lookahead rule:
 *   Unconfirmed (still forming) candles on a higher timeframe must NOT
 *   be treated as confirmed signals. A 1H candle is only valid at its
 *   close, not during formation. The `confirmed` flag enforces this.
 *
 * This module is I/O-free.
 */

import type { OHLCVCandle } from "@/lib/market-data/types";
import type { MTFAlignmentState } from "./types";

// ─── Timeframe Bias ───────────────────────────────────────────────────────────

export type TimeframeLabel = "DAILY" | "1H" | "15M" | "5M" | "1M";

export type TimeframeBias =
  | "STRONG_BULL"
  | "BULL"
  | "NEUTRAL"
  | "BEAR"
  | "STRONG_BEAR"
  | "PULLBACK_IN_BULL"  // Higher TF bull, current TF pulling back
  | "PULLBACK_IN_BEAR"  // Higher TF bear, current TF bouncing
  | "UNAVAILABLE";      // Cannot determine (insufficient data)

export interface TimeframeAssessment {
  timeframe: TimeframeLabel;
  bias: TimeframeBias;
  /** Whether the current candle is confirmed (closed) — MUST be false for forming bars */
  confirmed: boolean;
  /** EMA alignment score [-1, 1] */
  emaAlignmentScore: number;
  /** Price vs VWAP (if available) */
  priceVsVwap: "ABOVE" | "BELOW" | "AT" | "UNAVAILABLE";
  /** ATR-normalized momentum */
  normalizedMomentum: number;
  /** Whether this timeframe supports a LONG entry */
  supportsLong: boolean;
  /** Whether this timeframe supports a SHORT entry */
  supportsShort: boolean;
  reasons: string[];
}

export interface MTFConfirmationResult {
  alignment: MTFAlignmentState;
  /** Composite directional score [-1, 1] */
  alignmentScore: number;
  /** [0, 1] confidence in the alignment assessment */
  confidence: number;
  assessments: TimeframeAssessment[];
  /** Whether the higher-timeframe context supports the trade */
  higherTFContextValid: boolean;
  /** Whether the entry timeframe (5m / 15m) is aligned */
  entryTFAligned: boolean;
  /** Whether an unconfirmed higher-TF candle was detected (lookahead warning) */
  unconfirmedHigherTFWarning: boolean;
  /** Summary of alignment state */
  summary: string;
}

// ─── Bias Classifier ─────────────────────────────────────────────────────────

function computeEmaScore(candles: OHLCVCandle[], ema9p: number, ema21p: number): number {
  if (candles.length < ema21p + 5) return 0;
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];

  // Simple EMA
  function ema(arr: number[], p: number): number {
    const k = 2 / (p + 1);
    let val = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
    return val;
  }

  const e9 = ema(closes, ema9p);
  const e21 = ema(closes, ema21p);

  if (e9 > e21 && last > e9) return 1;
  if (e9 > e21) return 0.5;
  if (e9 < e21 && last < e9) return -1;
  if (e9 < e21) return -0.5;
  return 0;
}

function classifyBias(
  candles: OHLCVCandle[],
  higherTFBias: TimeframeBias | null,
): TimeframeBias {
  if (candles.length < 10) return "UNAVAILABLE";

  const last3 = candles.slice(-3);
  const last10 = candles.slice(-10);
  const lastClose = last3[last3.length - 1].close;
  const prevClose = last3[0].close;
  const chg = prevClose > 0 ? (lastClose - prevClose) / prevClose : 0;

  // Simple HH/HL or LL/LH detection over last 10 bars
  let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;
  for (let i = 1; i < last10.length; i++) {
    if (last10[i].high > last10[i - 1].high) higherHighs++;
    if (last10[i].low > last10[i - 1].low) higherLows++;
    if (last10[i].high < last10[i - 1].high) lowerHighs++;
    if (last10[i].low < last10[i - 1].low) lowerLows++;
  }

  const bullStructure = higherHighs >= 6 && higherLows >= 5;
  const bearStructure = lowerHighs >= 6 && lowerLows >= 5;
  const strongBull = bullStructure && chg > 0.003;
  const strongBear = bearStructure && chg < -0.003;

  if (strongBull) {
    if (higherTFBias === "BEAR" || higherTFBias === "STRONG_BEAR") return "PULLBACK_IN_BEAR";
    return "STRONG_BULL";
  }
  if (strongBear) {
    if (higherTFBias === "BULL" || higherTFBias === "STRONG_BULL") return "PULLBACK_IN_BULL";
    return "STRONG_BEAR";
  }
  if (bullStructure) return "BULL";
  if (bearStructure) return "BEAR";
  if (chg > 0.002) {
    if (higherTFBias === "BEAR" || higherTFBias === "STRONG_BEAR") return "PULLBACK_IN_BEAR";
    return "BULL";
  }
  if (chg < -0.002) {
    if (higherTFBias === "BULL" || higherTFBias === "STRONG_BULL") return "PULLBACK_IN_BULL";
    return "BEAR";
  }
  return "NEUTRAL";
}

// ─── Single Timeframe Evaluator ───────────────────────────────────────────────

function evaluateTimeframe(
  label: TimeframeLabel,
  candles: OHLCVCandle[],
  isCurrentBarConfirmed: boolean,
  higherTFBias: TimeframeBias | null,
  vwap: number | null,
): TimeframeAssessment {
  const reasons: string[] = [];

  if (candles.length < 5) {
    return {
      timeframe: label,
      bias: "UNAVAILABLE",
      confirmed: isCurrentBarConfirmed,
      emaAlignmentScore: 0,
      priceVsVwap: "UNAVAILABLE",
      normalizedMomentum: 0,
      supportsLong: false,
      supportsShort: false,
      reasons: ["Insufficient candles"],
    };
  }

  if (!isCurrentBarConfirmed) {
    reasons.push(`${label} current bar not confirmed — lookahead prevention active`);
  }

  const bias = classifyBias(candles, higherTFBias);
  const emaScore = computeEmaScore(candles, 9, 21);
  const lastClose = candles[candles.length - 1].close;

  // VWAP comparison
  let priceVsVwap: TimeframeAssessment["priceVsVwap"] = "UNAVAILABLE";
  if (vwap !== null && vwap > 0) {
    const dist = Math.abs(lastClose - vwap) / vwap;
    if (dist < 0.001) priceVsVwap = "AT";
    else if (lastClose > vwap) priceVsVwap = "ABOVE";
    else priceVsVwap = "BELOW";
  }

  // Normalized momentum (10-bar ROC / ATR)
  let normalizedMomentum = 0;
  if (candles.length >= 11) {
    const roc = candles[candles.length - 1].close - candles[candles.length - 11].close;
    const atrs = candles.slice(-10).map((c, i, arr) => {
      if (i === 0) return c.high - c.low;
      return Math.max(c.high - c.low, Math.abs(c.high - arr[i-1].close), Math.abs(c.low - arr[i-1].close));
    });
    const avgAtr = atrs.reduce((a, b) => a + b, 0) / atrs.length;
    normalizedMomentum = avgAtr > 0 ? Math.max(-3, Math.min(3, roc / avgAtr)) : 0;
  }

  const bullBias = bias === "STRONG_BULL" || bias === "BULL" || bias === "PULLBACK_IN_BEAR";
  const bearBias = bias === "STRONG_BEAR" || bias === "BEAR" || bias === "PULLBACK_IN_BULL";

  if (bias !== "UNAVAILABLE") reasons.push(`${label} bias: ${bias}`);
  if (emaScore !== 0) reasons.push(`EMA alignment: ${emaScore > 0 ? "bullish" : "bearish"} (${emaScore.toFixed(1)})`);
  if (priceVsVwap !== "UNAVAILABLE") reasons.push(`Price ${priceVsVwap} VWAP`);

  return {
    timeframe: label,
    bias,
    confirmed: isCurrentBarConfirmed,
    emaAlignmentScore: emaScore,
    priceVsVwap,
    normalizedMomentum,
    supportsLong: bullBias && isCurrentBarConfirmed,
    supportsShort: bearBias && isCurrentBarConfirmed,
    reasons,
  };
}

// ─── MTF Alignment Evaluator ─────────────────────────────────────────────────

export interface MTFInput {
  direction: "LONG" | "SHORT";
  /** Daily candles (confirmed — last candle is yesterday's close) */
  dailyCandles: OHLCVCandle[];
  /** 1H candles. Last bar confirmed flag needed. */
  h1Candles: OHLCVCandle[] | null;
  h1BarConfirmed: boolean;
  /** 15m candles */
  m15Candles: OHLCVCandle[] | null;
  m15BarConfirmed: boolean;
  /** 5m candles */
  m5Candles: OHLCVCandle[] | null;
  m5BarConfirmed: boolean;
  /** 1m candles (optional, for execution precision) */
  m1Candles: OHLCVCandle[] | null;
  m1BarConfirmed: boolean;
  /** VWAP for the session (intraday only) */
  vwap: number | null;
}

/**
 * Evaluate multi-timeframe alignment.
 *
 * Returns ALIGNED when all available TFs agree on direction.
 * Returns PARTIALLY_ALIGNED when higher TFs agree but lower TF is pulling back
 *   (e.g., Daily/1H bull + 5m/15m pullback) — this is often the BEST entry.
 * Returns CONFLICTING when major timeframes disagree.
 * Returns NEUTRAL when no directional consensus.
 */
export function evaluateMTFAlignment(input: MTFInput): MTFConfirmationResult {
  const isLong = input.direction === "LONG";
  const assessments: TimeframeAssessment[] = [];

  // Daily is always considered confirmed (uses yesterday's close)
  const daily = evaluateTimeframe("DAILY", input.dailyCandles, true, null, null);
  assessments.push(daily);

  let prevBias: TimeframeBias = daily.bias;

  if (input.h1Candles && input.h1Candles.length >= 5) {
    const h1 = evaluateTimeframe("1H", input.h1Candles, input.h1BarConfirmed, prevBias, input.vwap);
    assessments.push(h1);
    if (h1.confirmed) prevBias = h1.bias;
  }

  if (input.m15Candles && input.m15Candles.length >= 5) {
    const m15 = evaluateTimeframe("15M", input.m15Candles, input.m15BarConfirmed, prevBias, input.vwap);
    assessments.push(m15);
    if (m15.confirmed) prevBias = m15.bias;
  }

  if (input.m5Candles && input.m5Candles.length >= 5) {
    const m5 = evaluateTimeframe("5M", input.m5Candles, input.m5BarConfirmed, prevBias, input.vwap);
    assessments.push(m5);
  }

  if (input.m1Candles && input.m1Candles.length >= 5) {
    const m1 = evaluateTimeframe("1M", input.m1Candles, input.m1BarConfirmed, prevBias, input.vwap);
    assessments.push(m1);
  }

  // Count directional support from confirmed bars only
  const confirmed = assessments.filter(a => a.confirmed && a.bias !== "UNAVAILABLE");
  const supportsLong = confirmed.filter(a => a.supportsLong).length;
  const supportsShort = confirmed.filter(a => a.supportsShort).length;
  const neutral = confirmed.filter(a => a.bias === "NEUTRAL").length;
  const pullbacks = confirmed.filter(a =>
    a.bias === "PULLBACK_IN_BULL" || a.bias === "PULLBACK_IN_BEAR"
  ).length;

  const total = confirmed.length;
  if (total === 0) {
    return {
      alignment: "NEUTRAL",
      alignmentScore: 0,
      confidence: 0,
      assessments,
      higherTFContextValid: false,
      entryTFAligned: false,
      unconfirmedHigherTFWarning: assessments.some(a => !a.confirmed && a.timeframe !== "1M"),
      summary: "No confirmed timeframe data available",
    };
  }

  const longPct = supportsLong / total;
  const shortPct = supportsShort / total;

  // Higher-TF context: Daily + 1H must support the direction
  const higherTFAssessments = assessments.filter(a =>
    (a.timeframe === "DAILY" || a.timeframe === "1H") && a.confirmed
  );
  const higherTFContextValid = isLong
    ? higherTFAssessments.every(a => a.supportsLong || a.bias === "NEUTRAL")
    : higherTFAssessments.every(a => a.supportsShort || a.bias === "NEUTRAL");

  // Entry TF: 5m or 15m aligned
  const entryTFAssessments = assessments.filter(a =>
    (a.timeframe === "5M" || a.timeframe === "15M") && a.confirmed
  );
  const entryTFAligned = isLong
    ? entryTFAssessments.some(a => a.supportsLong)
    : entryTFAssessments.some(a => a.supportsShort);

  // Alignment score [-1, 1]
  const alignmentScore = isLong ? longPct - shortPct : shortPct - longPct;

  // Alignment state
  let alignment: MTFAlignmentState;
  if (alignmentScore >= 0.75) alignment = "ALIGNED";
  else if (alignmentScore >= 0.35) {
    // Check if it's a productive pullback pattern
    const isProductivePullback = pullbacks > 0 && higherTFContextValid;
    alignment = isProductivePullback ? "ALIGNED" : "PARTIALLY_ALIGNED";
  }
  else if (alignmentScore <= -0.2) alignment = "CONFLICTING";
  else alignment = "NEUTRAL";

  const confidence = Math.min(0.95, 0.3 + Math.abs(alignmentScore) * 0.7 + (confirmed.length / 5) * 0.2);

  const unconfirmedHigherTFWarning = assessments.some(
    a => !a.confirmed && (a.timeframe === "DAILY" || a.timeframe === "1H")
  );

  const summary = [
    `${alignment}: ${(alignmentScore * 100).toFixed(0)}% directional agreement`,
    higherTFContextValid ? "Higher TF context valid" : "Higher TF context weak",
    entryTFAligned ? "Entry TF aligned" : "Entry TF not aligned",
    unconfirmedHigherTFWarning ? "[WARN] Unconfirmed higher-TF bar detected" : "",
  ].filter(Boolean).join(" | ");

  return {
    alignment,
    alignmentScore,
    confidence,
    assessments,
    higherTFContextValid,
    entryTFAligned,
    unconfirmedHigherTFWarning,
    summary,
  };
}
