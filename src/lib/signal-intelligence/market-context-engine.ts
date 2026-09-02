/**
 * India Market Context Engine — Phase 6
 *
 * Builds a MarketContextSnapshot from live NIFTY/BANKNIFTY data,
 * India VIX, advance/decline ratio, sector leadership, and intraday
 * profile (gap, opening range, VWAP, ATR regime, volume regime).
 *
 * This module is I/O-free (pure computation given quotes + candles)
 * so it can be unit-tested with fixed inputs. The async orchestrator
 * that fetches live data lives in the API route.
 *
 * Every stock-level signal MUST reference the current MarketContextSnapshot.
 * A signal evaluated without market context is considered INCOMPLETE.
 */

import type { OHLCVCandle } from "@/lib/market-data/types";
import type { MarketRegimeLabel } from "./types";

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface MarketContextInput {
  /** NIFTY last traded price */
  niftyLtp: number | null;
  /** NIFTY previous close */
  niftyPrevClose: number | null;
  /** NIFTY % change today */
  niftyChangePct: number | null;
  /** NIFTY intraday high */
  niftyHigh: number | null;
  /** NIFTY intraday low */
  niftyLow: number | null;
  /** NIFTY today's open */
  niftyOpen: number | null;
  /** NIFTY volume today */
  niftyVolume: number | null;
  /** NIFTY 20-day avg volume */
  niftyAvgVolume20d: number | null;
  /** NIFTY recent daily candles (for ATR, trend) */
  niftyDailyCandles: OHLCVCandle[];
  /** NIFTY intraday candles (for opening range, VWAP) */
  niftyIntradayCandles: OHLCVCandle[];

  /** BANKNIFTY % change */
  bankniftyChangePct: number | null;
  /** BANKNIFTY last traded price */
  bankniftyLtp: number | null;

  /** India VIX value (%) */
  indiaVix: number | null;
  /** India VIX previous close */
  indiaVixPrevClose: number | null;

  /** Number of advancing stocks in F&O universe */
  advancingCount: number | null;
  /** Number of declining stocks in F&O universe */
  decliningCount: number | null;

  /** UTC ms of market open */
  sessionOpenMs: number;
  /** UTC ms now */
  nowMs: number;
}

// ─── Output Types ─────────────────────────────────────────────────────────────

export type MarketTrend = "STRONG_UP" | "UP" | "FLAT" | "DOWN" | "STRONG_DOWN";
export type VolumeRegime = "VERY_LOW" | "LOW" | "NORMAL" | "HIGH" | "SURGE";
export type VolatilityRegime = "VERY_LOW" | "LOW" | "NORMAL" | "HIGH" | "EXTREME";
export type MarketBreadth = "VERY_BROAD" | "BROAD" | "NEUTRAL" | "NARROW" | "VERY_NARROW";
export type GapType = "LARGE_UP" | "UP" | "FLAT" | "DOWN" | "LARGE_DOWN";

export interface MarketContextSnapshot {
  /** UTC ms when snapshot was taken */
  capturedAtMs: number;
  /** IST session date YYYY-MM-DD */
  sessionDate: string;

  // ── NIFTY context ────────────────────────────────────────────────────────
  niftyTrend: MarketTrend;
  niftyChangePct: number;
  niftyLtp: number;
  niftyOpeningRange: { high: number; low: number } | null;
  niftyVwap: number | null;
  niftyAtr: number | null;
  niftyAtrPct: number | null;
  niftyVolume: number | null;
  niftyVolumeRatio: number | null; // today vs 20d avg

  // ── BANKNIFTY context ────────────────────────────────────────────────────
  bankniftyTrend: MarketTrend;
  bankniftyChangePct: number;
  bankniftyLtp: number;

  // ── India VIX ────────────────────────────────────────────────────────────
  indiaVix: number | null;
  indiaVixChangePct: number | null;
  vixRegime: VolatilityRegime;

  // ── Advance / Decline ────────────────────────────────────────────────────
  advancingCount: number | null;
  decliningCount: number | null;
  /** Ratio advancing / (advancing + declining) */
  advanceDeclineRatio: number | null;
  marketBreadth: MarketBreadth;

  // ── Gap analysis ─────────────────────────────────────────────────────────
  gapType: GapType;
  gapPct: number;

  // ── Intraday profile ─────────────────────────────────────────────────────
  volumeRegime: VolumeRegime;
  volatilityRegime: VolatilityRegime;

  // ── Overall regime ───────────────────────────────────────────────────────
  regime: MarketRegimeLabel;
  /** Composite market momentum score [-1, 1] */
  momentumScore: number;
  /** Composite market volatility score [0, 1] */
  volatilityScore: number;

  // ── Sector leadership ────────────────────────────────────────────────────
  /** Leading sectors (positive momentum) */
  leadingSectors: string[];
  /** Lagging sectors (negative momentum) */
  laggingSectors: string[];

  // ── Quality ──────────────────────────────────────────────────────────────
  /** Whether all required fields were available */
  isComplete: boolean;
  /** List of unavailable fields */
  missingFields: string[];
}

// ─── Pure computation helpers ─────────────────────────────────────────────────

function toMarketTrend(changePct: number): MarketTrend {
  if (changePct >= 1.5) return "STRONG_UP";
  if (changePct >= 0.3) return "UP";
  if (changePct <= -1.5) return "STRONG_DOWN";
  if (changePct <= -0.3) return "DOWN";
  return "FLAT";
}

function toVolatilityRegime(vix: number | null): VolatilityRegime {
  if (vix === null) return "NORMAL";
  if (vix >= 25) return "EXTREME";
  if (vix >= 18) return "HIGH";
  if (vix >= 12) return "NORMAL";
  if (vix >= 8) return "LOW";
  return "VERY_LOW";
}

function toVolumeRegime(volumeRatio: number | null): VolumeRegime {
  if (volumeRatio === null) return "NORMAL";
  if (volumeRatio >= 2.5) return "SURGE";
  if (volumeRatio >= 1.5) return "HIGH";
  if (volumeRatio >= 0.8) return "NORMAL";
  if (volumeRatio >= 0.5) return "LOW";
  return "VERY_LOW";
}

function toMarketBreadth(adRatio: number | null): MarketBreadth {
  if (adRatio === null) return "NEUTRAL";
  if (adRatio >= 0.75) return "VERY_BROAD";
  if (adRatio >= 0.60) return "BROAD";
  if (adRatio >= 0.40) return "NEUTRAL";
  if (adRatio >= 0.25) return "NARROW";
  return "VERY_NARROW";
}

function toGapType(gapPct: number): GapType {
  if (gapPct >= 1.0) return "LARGE_UP";
  if (gapPct >= 0.25) return "UP";
  if (gapPct <= -1.0) return "LARGE_DOWN";
  if (gapPct <= -0.25) return "DOWN";
  return "FLAT";
}

/**
 * Compute VWAP from intraday OHLCV candles (IST-aligned).
 */
function computeVwap(candles: OHLCVCandle[]): number | null {
  if (candles.length === 0) return null;
  let totalTpv = 0;
  let totalVol = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume ?? 0;
    totalTpv += typicalPrice * vol;
    totalVol += vol;
  }
  return totalVol > 0 ? totalTpv / totalVol : null;
}

/**
 * Compute 14-bar simple ATR from daily candles.
 */
function computeAtr(candles: OHLCVCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trs.push(tr);
  }
  const window = trs.slice(-period);
  if (window.length === 0) return null;
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/**
 * Compute opening range from 5-min candles at 09:15 IST.
 */
function computeOpeningRange(
  intradayCandles: OHLCVCandle[],
): { high: number; low: number } | null {
  const IST_OFFSET_S = 5.5 * 3600;
  const openingCandles = intradayCandles.filter((c) => {
    const istSec = c.time + IST_OFFSET_S;
    const istMins = Math.floor(istSec / 60) % (24 * 60);
    return istMins >= 9 * 60 + 15 && istMins < 9 * 60 + 30;
  });
  if (openingCandles.length === 0) return null;
  return {
    high: Math.max(...openingCandles.map((c) => c.high)),
    low: Math.min(...openingCandles.map((c) => c.low)),
  };
}

/**
 * Derive overall market regime from multiple context inputs.
 */
function deriveRegime(
  niftyChangePct: number,
  adRatio: number | null,
  vix: number | null,
  volumeRatio: number | null,
): MarketRegimeLabel {
  // VIX-based regime takes priority
  if (vix !== null) {
    if (vix >= 25) return "VOLATILE";
    if (vix >= 20) return "HIGH_VOL";
    if (vix <= 10) return "LOW_VOL";
  }

  // Trend-based classification
  const absPct = Math.abs(niftyChangePct);
  if (absPct >= 1.5) {
    return niftyChangePct > 0 ? "STRONG_BULL" : "BEAR";
  }
  if (absPct >= 0.5) {
    return niftyChangePct > 0 ? "BULL" : "BEAR";
  }

  // Breadth-based
  if (adRatio !== null) {
    if (adRatio >= 0.65 && niftyChangePct >= 0) return "BULL";
    if (adRatio <= 0.35 && niftyChangePct <= 0) return "BEAR";
  }

  return "SIDEWAYS";
}

/**
 * IST YYYY-MM-DD from a UTC ms timestamp.
 */
function istDateKey(ms: number): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const d = new Date(ms + IST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a MarketContextSnapshot from raw market data inputs.
 * Pure function — no side effects, no I/O.
 */
export function buildMarketContextSnapshot(
  input: MarketContextInput,
): MarketContextSnapshot {
  const missingFields: string[] = [];

  // NIFTY required fields
  const niftyLtp = input.niftyLtp ?? 0;
  const niftyChangePct = input.niftyChangePct ?? 0;
  const niftyPrevClose = input.niftyPrevClose ?? 0;
  if (input.niftyLtp === null) missingFields.push("niftyLtp");
  if (input.niftyChangePct === null) missingFields.push("niftyChangePct");

  // BANKNIFTY
  const bankniftyChangePct = input.bankniftyChangePct ?? 0;
  const bankniftyLtp = input.bankniftyLtp ?? 0;
  if (input.bankniftyChangePct === null) missingFields.push("bankniftyChangePct");

  // Gap
  const gapPct =
    niftyPrevClose > 0 && niftyLtp > 0
      ? ((input.niftyOpen ?? niftyLtp) - niftyPrevClose) / niftyPrevClose * 100
      : 0;

  // VIX
  const vixChangePct =
    input.indiaVix !== null && input.indiaVixPrevClose !== null && input.indiaVixPrevClose > 0
      ? ((input.indiaVix - input.indiaVixPrevClose) / input.indiaVixPrevClose) * 100
      : null;
  if (input.indiaVix === null) missingFields.push("indiaVix");

  // Advance/Decline
  const totalAD =
    (input.advancingCount ?? 0) + (input.decliningCount ?? 0);
  const adRatio =
    totalAD > 0 && input.advancingCount !== null
      ? input.advancingCount / totalAD
      : null;
  if (input.advancingCount === null) missingFields.push("advancingCount");
  if (input.decliningCount === null) missingFields.push("decliningCount");

  // Volume ratio
  const volumeRatio =
    input.niftyAvgVolume20d !== null &&
    input.niftyAvgVolume20d > 0 &&
    input.niftyVolume !== null
      ? input.niftyVolume / input.niftyAvgVolume20d
      : null;

  // ATR
  const niftyAtr = computeAtr(input.niftyDailyCandles);
  const niftyAtrPct =
    niftyAtr !== null && niftyLtp > 0 ? (niftyAtr / niftyLtp) * 100 : null;

  // VWAP from intraday candles
  const niftyVwap = computeVwap(input.niftyIntradayCandles);

  // Opening range
  const openingRange = computeOpeningRange(input.niftyIntradayCandles);

  // Derived metrics
  const niftyTrend = toMarketTrend(niftyChangePct);
  const bankniftyTrend = toMarketTrend(bankniftyChangePct);
  const vixRegime = toVolatilityRegime(input.indiaVix);
  const volumeRegime = toVolumeRegime(volumeRatio);
  const volatilityRegime = toVolatilityRegime(input.indiaVix);
  const marketBreadth = toMarketBreadth(adRatio);
  const gapType = toGapType(gapPct);

  // Regime
  const regime = deriveRegime(niftyChangePct, adRatio, input.indiaVix, volumeRatio);

  // Composite momentum score [-1, 1]
  const momentumScore = Math.max(
    -1,
    Math.min(
      1,
      niftyChangePct / 2 +
        bankniftyChangePct / 4 +
        (adRatio !== null ? (adRatio - 0.5) * 0.5 : 0),
    ),
  );

  // Composite volatility score [0, 1]
  const volatilityScore =
    input.indiaVix !== null
      ? Math.min(1, input.indiaVix / 30)
      : Math.abs(niftyChangePct) / 3;

  const sessionDate = istDateKey(input.nowMs);

  return {
    capturedAtMs: input.nowMs,
    sessionDate,
    niftyTrend,
    niftyChangePct,
    niftyLtp,
    niftyOpeningRange: openingRange,
    niftyVwap,
    niftyAtr,
    niftyAtrPct,
    niftyVolume: input.niftyVolume,
    niftyVolumeRatio: volumeRatio,
    bankniftyTrend,
    bankniftyChangePct,
    bankniftyLtp,
    indiaVix: input.indiaVix,
    indiaVixChangePct: vixChangePct,
    vixRegime,
    advancingCount: input.advancingCount,
    decliningCount: input.decliningCount,
    advanceDeclineRatio: adRatio,
    marketBreadth,
    gapType,
    gapPct,
    volumeRegime,
    volatilityRegime,
    regime,
    momentumScore,
    volatilityScore,
    leadingSectors: [], // populated by sector RS engine
    laggingSectors: [],
    isComplete: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Score how well a given signal direction aligns with the market context.
 * Returns a score in [-1, 1]:
 *   +1 = context strongly supports the signal
 *   -1 = context strongly opposes the signal
 *    0 = neutral / unknown
 */
export function scoreContextAlignment(
  ctx: MarketContextSnapshot,
  signalDirection: "LONG" | "SHORT" | "NEUTRAL",
): number {
  if (signalDirection === "NEUTRAL") return 0;
  const isLong = signalDirection === "LONG";

  let score = 0;

  // NIFTY trend alignment (weight: 0.35)
  const niftyScore = ctx.niftyChangePct / 2; // normalise to ~[-1,1]
  score += (isLong ? niftyScore : -niftyScore) * 0.35;

  // Breadth alignment (weight: 0.20)
  if (ctx.advanceDeclineRatio !== null) {
    const breadthScore = ctx.advanceDeclineRatio * 2 - 1; // [0,1] → [-1,1]
    score += (isLong ? breadthScore : -breadthScore) * 0.20;
  }

  // VIX alignment (weight: 0.15)
  // High VIX hurts longs but can help shorts (up to a point)
  if (ctx.indiaVix !== null) {
    const vixPenalty = ctx.indiaVix > 20 ? -0.15 : ctx.indiaVix < 12 ? 0.1 : 0;
    score += isLong ? vixPenalty : -vixPenalty;
  }

  // BANKNIFTY confirmation (weight: 0.15)
  const bnkScore = ctx.bankniftyChangePct / 2;
  score += (isLong ? bnkScore : -bnkScore) * 0.15;

  // Volume regime alignment (weight: 0.15)
  const volBoost =
    ctx.volumeRegime === "HIGH" || ctx.volumeRegime === "SURGE"
      ? 0.15
      : ctx.volumeRegime === "LOW" || ctx.volumeRegime === "VERY_LOW"
      ? -0.1
      : 0;
  score += isLong ? volBoost : -volBoost;

  return Math.max(-1, Math.min(1, score));
}
