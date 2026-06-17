/**
 * India F&O AI Signals builder.
 *
 * Mirrors the crypto builder's shape but pulls from the India data stack:
 *   - Yahoo for live quotes + historical OHLCV on each underlying
 *   - NSE option chain (PCR, ATM IV, max-pain, OI build-up)
 *   - The India scanner cache (range-expansion / volume / momentum hits)
 *   - The India best-time engine for session-aware timing
 *
 * The result is the same `AiSignal` type the crypto surface produces — so
 * the rich `<AiSignalCard>` component can render either market 1:1.
 */

import "server-only";

import { FNO_INDICES, FNO_STOCKS } from "@/lib/india/fno-symbols";
import { mapWithConcurrency } from "@/lib/map-with-concurrency";
import { yahoo } from "@/services/india/yahoo";
import { nse } from "@/services/india/nse";
import { angel, isAngelConfigured } from "@/services/india/angelone";
import type {
  DerivOiBuildup,
  DerivPcr,
  OiBuildupDataType,
} from "@/services/india/angelone/derivatives";
import { cache as indiaCache } from "@/services/india/cache";
import {
  getBestTimeStatus,
  getNextTradingSessionOpen,
  type NextTradingSession,
} from "@/features/india/best-time/engine";
import { runScanner } from "@/services/india/scanner/engine";
import { getIndiaNews } from "@/services/india/news";
import type { MarketSentiment } from "@/types/india/news";
import type {
  AiConfluenceFactor,
  AiHorizon,
  AiMarketContext,
  AiMarketRegime,
  AiSignal,
  AiSignalsResponse,
} from "@/types/ai-signals";
import type { Candle, OiBuildupKind, OptionChain, Quote } from "@/types/india";
import {
  AI_MODEL_VERSION,
  buildReasons,
  buildTimingWindow,
  buildTradeLevels,
  calibrateWinProbability,
  classifyAction,
  clamp,
  composeSummary,
  compositeScore,
  derivativeShare,
  directionFromAction,
  gradeFromConfidence,
  invalidationLine,
  makeFactor,
  pickHorizon,
  riskLevelFromConfidence,
  roundToTick,
  suggestPositionSizePct,
} from "./engine";

// Daily Picks rescans the full F&O universe on this cadence — bumped to a
// minute per the spec ("scan all F&O stocks every minute"). The minute is the
// natural NSE intraday candle; finer than that the macro factors (PCR, OI
// buildup, daily-RSI/MACD) don't change meaningfully.
const CACHE_TTL_MS = 60_000;

/**
 * Concurrency cap when fanning Yahoo historical fetches across the full F&O
 * universe (170 symbols). Yahoo's chart endpoint rate-limits aggressively
 * on parallel bursts; 8 in-flight is the sweet spot we've seen settle
 * within ~12s on cold cache while staying clear of 429s.
 */
const YAHOO_HIST_CONCURRENCY = 8;

const DERIVATIVE_FACTOR_IDS = new Set([
  "pcr",
  "ivAtm",
  "oiBuildup",
  "maxPain",
]);

/** Directional score in [-1, 1] for each first-party OI build-up kind. */
const OI_KIND_SCORE: Record<OiBuildupKind, number> = {
  LONG_BUILDUP: 1,
  SHORT_COVERING: 0.6,
  SHORT_BUILDUP: -1,
  LONG_UNWINDING: -0.6,
};

/** Build a `symbol → PCR` map from the first-party PCR rows (first wins). */
export function pcrMapFromRows(rows: DerivPcr[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!out.has(r.symbol)) out.set(r.symbol, r.pcr);
  }
  return out;
}

/**
 * Collapse the first-party OI build-up rows into a per-symbol directional
 * read. When a symbol shows up under several build-up buckets we keep the one
 * carrying the largest OI (the dominant positioning) and map it to a score.
 */
export function oiScoreMapFromRows(
  rows: DerivOiBuildup[],
): Map<string, { score: number; kind: OiBuildupKind }> {
  const best = new Map<string, { oi: number; kind: OiBuildupKind }>();
  for (const r of rows) {
    const oi = r.oi ?? 0;
    const cur = best.get(r.symbol);
    if (!cur || oi > cur.oi) best.set(r.symbol, { oi, kind: r.kind });
  }
  const out = new Map<string, { score: number; kind: OiBuildupKind }>();
  for (const [sym, { kind }] of best) {
    out.set(sym, { score: OI_KIND_SCORE[kind], kind });
  }
  return out;
}

/**
 * NSE F&O tick size depends on the underlying price band. Stocks use
 * 0.05 ticks; indices >5,000 use 1.0 / 5.0 ticks but the option-chain
 * shows strikes at 50 / 100. For our AI levels we round entries / stops
 * to a sensible price band so the UI doesn't show 22_847.13 as a stop on
 * a NIFTY trade.
 */
function tickFor(symbol: string, price: number): number {
  if (FNO_INDICES.some((i) => i.underlying === symbol)) {
    return price >= 30_000 ? 5 : 1;
  }
  return 0.05;
}

/**
 * Compute a Wilder ATR(14) over daily candles. Returns null if we don't
 * have enough history.
 */
function dailyAtr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trs.push(tr);
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
  }
  return prev;
}

/** Wilder RSI(14) over daily closes. */
function dailyRsi(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const closes = candles.map((c) => c.close);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let g = gain / period;
  let l = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (l === 0) return 100;
  const rs = g / l;
  return 100 - 100 / (1 + rs);
}

/** SMA over closes. */
function sma(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const last = candles.slice(-period);
  return last.reduce((s, c) => s + c.close, 0) / period;
}

/** Epoch-day number of the Monday that starts `d`'s ISO week (UTC). */
function mondayKey(d: Date): number {
  const day = d.getUTCDay(); // 0 = Sun
  const diff = (day + 6) % 7; // days since Monday
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff);
  return Math.floor(monday / 86_400_000);
}

/**
 * Is the *current* weekly / monthly candle bullish (close > open)? Aggregated
 * from the daily candles — the period's open is its first session's open and
 * its close is the latest close. Returns null when there's no data.
 */
function periodBullish(dailies: Candle[], unit: "week" | "month"): boolean | null {
  if (dailies.length === 0) return null;
  const last = dailies.at(-1)!;
  const lastDate = new Date(last.time * 1000);
  const sameMonth = (c: Candle) => {
    const d = new Date(c.time * 1000);
    return (
      d.getUTCFullYear() === lastDate.getUTCFullYear() &&
      d.getUTCMonth() === lastDate.getUTCMonth()
    );
  };
  const sameWeek = (c: Candle) =>
    mondayKey(new Date(c.time * 1000)) === mondayKey(lastDate);
  const group = dailies.filter(unit === "month" ? sameMonth : sameWeek);
  if (group.length === 0) return null;
  return group.at(-1)!.close > group[0].open;
}

const candleRange = (c: Candle): number => c.high - c.low;

/**
 * Per-symbol read of the institutional futures-segment screen (the Chartink
 * filter set): today's range is the widest of the last 8 sessions (range
 * expansion), an up candle closing above the prior close, the week and month
 * are bullish, the prior session is liquid (>10k), and the SMA stack is
 * 20 > 50 > 200. We also evaluate the exact bearish mirror so the same screen
 * ranks shorts in a down market. Returns a signed score in [-1, 1] plus the
 * full-screen pass flags. Null when history is too short.
 */
export interface FuturesScreen {
  /** Signed read: bullish conditions minus the bearish mirror, in [-1, 1]. */
  score: number;
  /** All seven bullish conditions met (the literal Chartink screen). */
  bullPass: boolean;
  /** All seven bearish-mirror conditions met. */
  bearPass: boolean;
  /** Bullish conditions met (of 7). */
  metBull: number;
  /** Bearish conditions met (of 7). */
  metBear: number;
}

export function computeFuturesScreen(dailies: Candle[]): FuturesScreen | null {
  // Need today + 7 prior sessions for range expansion (and a prior close).
  if (dailies.length < 9) return null;
  const last = dailies.at(-1)!;
  const prev = dailies.at(-2)!;

  const prior7 = dailies.slice(-8, -1);
  const maxPriorRange = Math.max(...prior7.map(candleRange));
  const rangeExpansion = candleRange(last) > maxPriorRange;

  // Liquidity gate on the prior session. Index candles often ship 0/null
  // volume on Yahoo — treat those as a pass (the screen targets stocks).
  const prevVol = prev.volume ?? null;
  const liquidity = prevVol == null || prevVol === 0 ? true : prevVol > 10_000;

  const dailyBull = last.close > last.open;
  const dailyBear = last.close < last.open;
  const upDay = last.close > prev.close;
  const downDay = last.close < prev.close;

  const weekly = periodBullish(dailies, "week");
  const monthly = periodBullish(dailies, "month");

  const s20 = sma(dailies, 20);
  const s50 = sma(dailies, 50);
  const s200 = sma(dailies, 200);
  const haveStack = s20 != null && s50 != null && s200 != null;
  const stackBull = haveStack && s20! > s50! && s50! > s200!;
  const stackBear = haveStack && s20! < s50! && s50! < s200!;

  const bullDir = [dailyBull, upDay, weekly === true, monthly === true, stackBull].filter(
    Boolean,
  ).length;
  const bearDir = [
    dailyBear,
    downDay,
    weekly === false,
    monthly === false,
    stackBear,
  ].filter(Boolean).length;

  let score = (bullDir - bearDir) / 5;
  if (!rangeExpansion) score *= 0.6; // no volatility expansion → fade the read
  if (!liquidity) score *= 0.6;

  const bullPass =
    rangeExpansion &&
    liquidity &&
    dailyBull &&
    upDay &&
    weekly === true &&
    monthly === true &&
    stackBull;
  const bearPass =
    rangeExpansion &&
    liquidity &&
    dailyBear &&
    downDay &&
    weekly === false &&
    monthly === false &&
    stackBear;
  if (bullPass) score = Math.max(score, 0.9);
  if (bearPass) score = Math.min(score, -0.9);

  const gate = (rangeExpansion ? 1 : 0) + (liquidity ? 1 : 0);
  return {
    score: clamp(score, -1, 1),
    bullPass,
    bearPass,
    metBull: bullDir + gate,
    metBear: bearDir + gate,
  };
}

/**
 * Support/resistance breakout read in [-1, 1], the way a desk frames it:
 * a close above the prior `lookback`-day high (resistance) is bullish, below
 * the prior low (support) is bearish — but only when *volume confirms* the
 * break (institutions leave a volume footprint; a low-volume poke through a
 * level is a trap). Inside the range we return a small positional tilt toward
 * whichever edge price is hugging. Null when history is too short.
 */
function breakoutScore(candles: Candle[], lookback = 20): number | null {
  if (candles.length < lookback + 2) return null;
  const prior = candles.slice(-(lookback + 1), -1);
  const last = candles.at(-1);
  if (!last) return null;
  const hi = Math.max(...prior.map((c) => c.high));
  const lo = Math.min(...prior.map((c) => c.low));
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;

  const vol20 =
    prior.map((c) => c.volume ?? 0).reduce((a, b) => a + b, 0) / prior.length;
  const volRatio = vol20 > 0 ? (last.volume ?? 0) / vol20 : 1;
  // Volume gate: a clean break needs ≥1.2× average; below that we fade it.
  const volConf = clamp(volRatio / 1.2, 0.35, 1);

  if (last.close > hi) return clamp(volConf, 0, 1);
  if (last.close < lo) return -clamp(volConf, 0, 1);

  const mid = (hi + lo) / 2;
  const half = (hi - lo) / 2;
  return clamp(((last.close - mid) / half) * 0.5, -0.6, 0.6);
}

/** Nearest ATM option strike from an NSE chain. */
function nearestAtmStrike(chain: OptionChain | null, spot: number): number | null {
  if (!chain || chain.rows.length === 0) return null;
  let best = chain.rows[0].strike;
  let bestDist = Math.abs(best - spot);
  for (const row of chain.rows) {
    const d = Math.abs(row.strike - spot);
    if (d < bestDist) {
      bestDist = d;
      best = row.strike;
    }
  }
  return best;
}

interface IndiaSignalInputs {
  symbol: string;
  displayName: string;
  isIndex: boolean;
  quote: Quote | null;
  dailies: Candle[];
  chain: OptionChain | null;
  scannerScore: { score: number; tags: string[] } | null;
  now: number;
  inActiveWindow: boolean;
  windowLabel: string;
  /**
   * Next NSE session open — passed through to the timing-window builder
   * so the signal is framed as "queued for tomorrow" when NSE is closed.
   * Null when the market is currently open.
   */
  nextSession: NextTradingSession | null;
  /**
   * First-party SmartAPI PCR for this underlying (whole-segment feed). When
   * present it overrides the chain-derived PCR. Null/undefined → use the chain.
   */
  pcrOverride?: number | null;
  /**
   * First-party SmartAPI OI build-up read for this underlying. When present it
   * overrides the chain-derived ΔPE−ΔCE skew (which depends on per-strike ΔOI
   * the synthesised Angel chain can't supply).
   */
  oiOverride?: { score: number; kind: OiBuildupKind } | null;
  /** Today's (or last-session's) % change for the underlying — intraday demand read. */
  dayChangePct?: number | null;
  /**
   * Broad-market regime score in [-1, 1] (the NIFTY/BANKNIFTY/FINNIFTY tape +
   * VIX). Folded in as a confluence factor so single names lean *with* the
   * tape — a desk doesn't fight a strongly trending index intraday.
   */
  marketRegimeScore?: number | null;
  /** Per-symbol news read: net lexicon score + matched-headline count. */
  newsScore?: { score: number; count: number } | null;
  /**
   * Institutional futures-segment screen (range expansion + bullish candle +
   * up day + bullish week/month + liquidity + SMA 20>50>200, with a bearish
   * mirror). Folded in as a confluence factor for Daily Picks so the board
   * leans on the same filter set a desk screens with. Null → factor omitted.
   */
  futuresScreen?: FuturesScreen | null;
  /**
   * Force a specific horizon (Daily Picks pin every pick to `intraday` so the
   * board is an intraday product). When omitted the horizon is auto-picked.
   */
  horizonOverride?: AiHorizon;
  /**
   * Intraday framing: scale the daily ATR down to an intraday band so stops /
   * targets are realistic for a same-session trade rather than a 3-day swing.
   */
  intraday?: boolean;
  /**
   * Minimum |score| before a signal commits to a direction (below it → WAIT).
   * Daily Picks lowers this so borderline-but-real setups take a side rather
   * than leaving the board padded with WAIT cards.
   */
  actionMinMagnitude?: number;
}

/**
 * Build the 9-factor confluence stack used by the India AI engine.
 */
function indiaFactors(args: IndiaSignalInputs): AiConfluenceFactor[] {
  const { quote, dailies, chain } = args;
  const closes = dailies.map((c) => c.close);
  const rsi = dailyRsi(dailies);
  const sma20 = sma(dailies, 20);
  const sma50 = sma(dailies, 50);
  const sma200 = sma(dailies, 200);
  const lastClose = closes.at(-1) ?? quote?.price ?? null;

  // Trend stack score: +1 if 20 > 50 > 200 and price above 20; -1 if mirror.
  let trendStack = 0;
  if (sma20 != null && sma50 != null && sma200 != null && lastClose != null) {
    if (sma20 > sma50 && sma50 > sma200 && lastClose > sma20) trendStack = 1;
    else if (sma20 < sma50 && sma50 < sma200 && lastClose < sma20)
      trendStack = -1;
    else trendStack = clamp(((sma20 - sma50) / Math.max(sma50, 1)) * 10, -0.6, 0.6);
  }

  // Intraday demand: today's (or last session's) % change. The single most
  // important read for an intraday trade — a desk presses what's already
  // working, not a name fighting the tape.
  const dayChange = args.dayChangePct ?? quote?.changePct ?? null;
  // Support/resistance breakout with volume confirmation.
  const breakout = breakoutScore(dailies);
  // Broad-market regime in [-1, 1].
  const regime = args.marketRegimeScore ?? null;
  // Per-symbol news lexicon read.
  const news = args.newsScore ?? null;

  // 5-day momentum
  const mom5 =
    closes.length >= 6 && closes.at(-6)
      ? ((closes.at(-1)! - closes.at(-6)!) / closes.at(-6)!) * 100
      : null;

  // Volume thrust: today vs 20-day avg
  const vol20 =
    dailies.length >= 21
      ? dailies
          .slice(-21, -1)
          .map((c) => c.volume ?? 0)
          .reduce((a, b) => a + b, 0) / 20
      : null;
  const volRatio =
    vol20 && vol20 > 0 ? ((dailies.at(-1)?.volume ?? 0) / vol20) : null;

  // PCR (open-interest based). First-party SmartAPI PCR wins when present, then
  // the chain-derived value (indices only).
  const pcr = args.pcrOverride ?? chain?.analytics.pcrOi ?? null;
  const pcrIsFirstParty = args.pcrOverride != null;
  // ATM IV — high IV often precedes mean reversion in F&O indices
  const atmIv = chain?.analytics.atmIv ?? null;
  // OI build-up direction. First-party SmartAPI read wins when present;
  // otherwise fall back to the chain-derived ΔPE OI − ΔCE OI skew (positive →
  // bullish, indices only).
  const oiOverride = args.oiOverride ?? null;
  const oiSkew =
    chain != null
      ? (chain.analytics.totalPeOiChange ?? 0) - (chain.analytics.totalCeOiChange ?? 0)
      : null;
  // Max-pain pull — distance from spot
  const maxPainPull =
    chain != null && chain.analytics.maxPain != null && lastClose != null && lastClose > 0
      ? ((chain.analytics.maxPain - lastClose) / lastClose) * 100
      : null;

  const factors: AiConfluenceFactor[] = [
    makeFactor({
      id: "dayChange",
      category: "flow",
      label: "Intraday demand",
      weight: 0.13,
      raw: dayChange,
      denominator: 1.5,
      describe: (raw) =>
        raw >= 0.75
          ? `+${raw.toFixed(2)}% on the day — buyers in control`
          : raw <= -0.75
            ? `${raw.toFixed(2)}% on the day — sellers in control`
            : raw >= 0
              ? `+${raw.toFixed(2)}% — mild bid`
              : `${raw.toFixed(2)}% — mild offer`,
    }),
    makeFactor({
      id: "breakout",
      category: "chart",
      label: "S/R breakout (vol-confirmed)",
      weight: 0.13,
      raw: breakout,
      denominator: 1,
      describe: (raw) =>
        raw >= 0.6
          ? `Broke 20-day resistance on volume — continuation`
          : raw <= -0.6
            ? `Broke 20-day support on volume — breakdown`
            : raw > 0.15
              ? `Pressing the upper range — coiling for a break`
              : raw < -0.15
                ? `Hugging the lower range — distribution`
                : `Mid-range — no level in play`,
    }),
    makeFactor({
      id: "marketRegime",
      category: "macro",
      label: "Market tape",
      weight: 0.12,
      raw: regime,
      denominator: 1,
      describe: (raw) =>
        raw >= 0.4
          ? `Broad tape risk-on — trade with the longs`
          : raw <= -0.4
            ? `Broad tape risk-off — favour shorts`
            : `Tape mixed — name-specific edge only`,
    }),
    makeFactor({
      id: "news",
      category: "news",
      label: "News flow",
      weight: 0.08,
      raw: news ? news.score : null,
      denominator: 2,
      describe: () =>
        !news || news.count === 0
          ? "No fresh headlines"
          : news.score > 0
            ? `${news.count} headline(s) skew bullish`
            : news.score < 0
              ? `${news.count} headline(s) skew bearish`
              : `${news.count} headline(s) — neutral`,
    }),
    makeFactor({
      id: "trend",
      category: "technical",
      label: "Daily SMA trend",
      weight: 0.08,
      raw: trendStack,
      denominator: 1,
      describe: (raw) =>
        raw >= 0.9
          ? `Bull stack · SMA 20 > 50 > 200, price above 20`
          : raw <= -0.9
            ? `Bear stack · SMA 20 < 50 < 200, price below 20`
            : raw >= 0
              ? `Mild bullish — SMA spread positive`
              : `Mild bearish — SMA spread negative`,
    }),
    makeFactor({
      id: "rsi",
      category: "technical",
      label: "Daily RSI(14)",
      weight: 0.05,
      raw: rsi != null ? 50 - rsi : null,
      denominator: 25,
      describe: () =>
        rsi == null
          ? "Unavailable"
          : rsi > 70
            ? `Overbought ${rsi.toFixed(1)} — fade risk`
            : rsi < 30
              ? `Oversold ${rsi.toFixed(1)} — mean-revert bias`
              : `Neutral ${rsi.toFixed(1)}`,
    }),
    makeFactor({
      id: "momentum",
      category: "technical",
      label: "5-day momentum",
      weight: 0.08,
      raw: mom5,
      denominator: 4,
      describe: (raw) =>
        raw > 0
          ? `+${raw.toFixed(2)}% over 5 sessions`
          : `${raw.toFixed(2)}% over 5 sessions`,
    }),
    makeFactor({
      id: "volume",
      category: "flow",
      label: "Volume thrust",
      weight: 0.08,
      // Volume "thrust" must be *directional conviction* — above-average volume
      // moving in the day's price direction. We use the sign of today's % change
      // as the direction proxy. Below-average volume returns `null` (unavailable)
      // rather than 0, because lack of volume is *lack of conviction*: a `0`
      // would still be counted in the confidence denominator and dilute every
      // signal on coiling days, while `null` correctly removes it from the math.
      // It also cannot be flipped by `aligned()` into a SHORT-supporting score.
      raw:
        volRatio != null && dayChange != null && volRatio >= 1
          ? (volRatio - 1) * (dayChange >= 0 ? 1 : -1)
          : null,
      denominator: 1,
      describe: () =>
        volRatio == null
          ? "Unavailable"
          : volRatio >= 1.5
            ? `Breakout volume ${volRatio.toFixed(2)}× 20-day avg`
            : volRatio >= 1
              ? `Above-avg volume ${volRatio.toFixed(2)}×`
              : `Below-avg volume ${volRatio.toFixed(2)}× — no conviction`,
    }),
    makeFactor({
      id: "pcr",
      category: "derivatives",
      label: "PCR (OI)",
      weight: 0.08,
      raw: pcr != null ? pcr - 1 : null,
      denominator: 0.5,
      describe: () => {
        if (pcr == null) return "Unavailable";
        const src = pcrIsFirstParty ? " (SmartAPI)" : "";
        return pcr > 1.3
          ? `PCR ${pcr.toFixed(2)}${src} — heavy PE write, bullish bias`
          : pcr < 0.7
            ? `PCR ${pcr.toFixed(2)}${src} — heavy CE write, bearish bias`
            : `PCR ${pcr.toFixed(2)}${src} — balanced`;
      },
    }),
    makeFactor({
      id: "ivAtm",
      category: "derivatives",
      label: "ATM IV",
      weight: 0.04,
      raw: atmIv != null ? atmIv - 15 : null,
      denominator: 12,
      // High IV → wider expected range; we treat it as a *bearish* tilt for
      // directional positions because IV crush after the move kills options.
      invert: true,
      describe: () =>
        atmIv == null
          ? "Unavailable"
          : atmIv > 22
            ? `Elevated IV ${atmIv.toFixed(1)}% — option premium rich`
            : atmIv > 14
              ? `Normal IV ${atmIv.toFixed(1)}%`
              : `Compressed IV ${atmIv.toFixed(1)}% — premium cheap`,
    }),
    makeFactor({
      id: "oiBuildup",
      category: "derivatives",
      label: "OI build-up Δ",
      weight: 0.1,
      raw: oiOverride ? oiOverride.score : oiSkew,
      denominator: oiOverride ? 1 : 5e5,
      describe: () => {
        if (oiOverride)
          return `First-party OI: ${oiOverride.kind.replace(/_/g, " ")}`;
        if (oiSkew == null) return "Unavailable";
        if (oiSkew > 0)
          return `PE writers > CE writers (${(oiSkew / 1e5).toFixed(1)}L) — bullish OI`;
        return `CE writers > PE writers (${(-oiSkew / 1e5).toFixed(1)}L) — bearish OI`;
      },
    }),
    makeFactor({
      id: "maxPain",
      category: "derivatives",
      label: "Max-pain pull",
      weight: 0.05,
      raw: maxPainPull,
      denominator: 1.5,
      describe: () =>
        maxPainPull == null
          ? "Unavailable"
          : maxPainPull > 0.3
            ? `Max-pain ${maxPainPull.toFixed(2)}% above spot — magnet up`
            : maxPainPull < -0.3
              ? `Max-pain ${maxPainPull.toFixed(2)}% below spot — magnet down`
              : `Max-pain near spot — neutral pin`,
    }),
    makeFactor({
      id: "scanner",
      category: "flow",
      label: "Scanner agreement",
      weight: 0.08,
      raw: args.scannerScore?.score ?? null,
      denominator: 1,
      describe: () => {
        if (!args.scannerScore) return "Unavailable";
        const tags = args.scannerScore.tags.join(" · ");
        return tags
          ? `Scanner: ${tags}`
          : `Scanner score ${args.scannerScore.score.toFixed(2)}`;
      },
    }),
    makeFactor({
      id: "session",
      category: "macro",
      label: "NSE session",
      weight: 0.04,
      // The session factor is a *meta* state — "is the market open" — not a
      // directional edge. When we're outside the active F&O window we mark it
      // unavailable rather than scoring it -0.5; otherwise every off-hours
      // signal gets a permanent confidence penalty for no real reason. When
      // we're inside the window we still score it +1 to reward signals fired
      // at high-liquidity times.
      raw: args.inActiveWindow ? 1 : null,
      denominator: 1,
      describe: () =>
        args.inActiveWindow
          ? `Inside ${args.windowLabel} — F&O liquidity active`
          : `Outside ${args.windowLabel} — wait for market open`,
    }),
  ];

  // Institutional futures-segment screen (Daily Picks only). Added when the
  // caller supplies the screen read so it influences direction + confidence
  // and is read by the Daily Picks bucket ranking.
  const screen = args.futuresScreen ?? null;
  if (screen) {
    factors.push(
      makeFactor({
        id: "futuresScreen",
        category: "technical",
        label: "Futures momentum screen",
        weight: 0.12,
        raw: screen.score,
        denominator: 1,
        describe: () =>
          screen.bullPass
            ? "Passes the full bullish F&O screen (7/7) — widest range in 8 days, up candle > prev close, week + month up, SMA 20>50>200"
            : screen.bearPass
              ? "Passes the full bearish F&O screen (7/7) — widest range in 8 days, down candle < prev close, week + month down, SMA 20<50<200"
              : screen.score > 0.05
                ? `Bullish screen — ${screen.metBull}/7 conditions met`
                : screen.score < -0.05
                  ? `Bearish screen — ${screen.metBear}/7 conditions met`
                  : "Screen mixed — no clean edge",
      }),
    );
  }

  return factors;
}

/**
 * Cross-reference live scanner cache to compute a per-symbol bullishness
 * score in [-1, 1] plus a short list of tags ("Volume +", "Momentum +").
 */
async function loadScannerScores(): Promise<
  Map<string, { score: number; tags: string[] }>
> {
  const out = new Map<string, { score: number; tags: string[] }>();
  const safeRun = async (type: Parameters<typeof runScanner>[0]) => {
    try {
      return await runScanner(type, 50);
    } catch {
      return null;
    }
  };
  const [momentum, volume, rangeExp, oi] = await Promise.all([
    safeRun("momentum"),
    safeRun("volume-breakout"),
    safeRun("range-expansion"),
    safeRun("oi-buildup"),
  ]);
  const bump = (sym: string, delta: number, tag: string) => {
    const cur = out.get(sym) ?? { score: 0, tags: [] };
    cur.score = clamp(cur.score + delta, -1, 1);
    if (!cur.tags.includes(tag)) cur.tags.push(tag);
    out.set(sym, cur);
  };
  for (const hit of momentum?.hits ?? []) {
    const dir = (hit.changePct ?? 0) >= 0 ? 1 : -1;
    bump(hit.symbol, dir * 0.3, dir > 0 ? "Momentum +" : "Momentum −");
  }
  for (const hit of volume?.hits ?? []) {
    const dir = (hit.changePct ?? 0) >= 0 ? 1 : -1;
    bump(hit.symbol, dir * 0.25, dir > 0 ? "Volume +" : "Volume −");
  }
  for (const hit of rangeExp?.hits ?? []) {
    bump(hit.symbol, 0.35, "Range expansion");
  }
  for (const hit of oi?.hits ?? []) {
    const kind = String(hit.kind ?? "");
    if (kind === "LONG_BUILDUP") bump(hit.symbol, 0.3, "Long build-up");
    else if (kind === "SHORT_BUILDUP") bump(hit.symbol, -0.3, "Short build-up");
    else if (kind === "SHORT_COVERING") bump(hit.symbol, 0.2, "Short covering");
    else if (kind === "LONG_UNWINDING") bump(hit.symbol, -0.2, "Long unwinding");
  }
  return out;
}

interface NewsScores {
  /** symbol → { net lexicon score, matched-headline count }. */
  symbols: Map<string, { score: number; count: number }>;
  /** Aggregate market sentiment read (drives the regime tilt). */
  sentiment: MarketSentiment | null;
}

const EMPTY_NEWS: NewsScores = { symbols: new Map(), sentiment: null };

/**
 * Pull the enriched India + global news set and collapse it into a per-symbol
 * directional read (weighted by headline impact) plus the aggregate market
 * sentiment. Never throws — degrades to empty maps so the engine simply drops
 * the news factor when feeds are down.
 */
async function loadNewsScores(): Promise<NewsScores> {
  try {
    const feed = await getIndiaNews({ limit: 80 });
    const symbols = new Map<string, { score: number; count: number }>();
    const impactWeight = { high: 1, medium: 0.6, low: 0.3 } as const;
    for (const item of feed.items) {
      if (item.sentiment.score === 0) continue;
      const dir = Math.sign(item.sentiment.score);
      const w = impactWeight[item.impact];
      for (const sym of item.symbols) {
        const cur = symbols.get(sym) ?? { score: 0, count: 0 };
        cur.score += dir * w;
        cur.count += 1;
        symbols.set(sym, cur);
      }
    }
    return { symbols, sentiment: feed.sentiment };
  } catch (e) {
    console.warn("[ai-signals/india] news read failed:", (e as Error).message);
    return EMPTY_NEWS;
  }
}

interface FirstPartyDerivatives {
  pcr: Map<string, number>;
  oi: Map<string, { score: number; kind: OiBuildupKind }>;
}

const EMPTY_DERIVATIVES: FirstPartyDerivatives = {
  pcr: new Map(),
  oi: new Map(),
};

/**
 * Pull Angel One's first-party PCR + OI build-up across the F&O segment and
 * collapse them into per-symbol lookups. No-op (empty maps) when SmartAPI is
 * unconfigured, so the AI engine transparently keeps using the chain-derived
 * values. Never throws.
 */
async function loadFirstPartyDerivatives(): Promise<FirstPartyDerivatives> {
  if (!isAngelConfigured()) return EMPTY_DERIVATIVES;
  try {
    const datatypes: OiBuildupDataType[] = [
      "Long Built Up",
      "Short Built Up",
      "Short Covering",
      "Long Unwinding",
    ];
    const [pcrRows, ...oiResults] = await Promise.all([
      angel.getPutCallRatio(),
      ...datatypes.map((d) => angel.getOiBuildup(d, "NEAR")),
    ]);
    return {
      pcr: pcrMapFromRows(pcrRows),
      oi: oiScoreMapFromRows(oiResults.flat()),
    };
  } catch (e) {
    console.warn(
      "[ai-signals/india] first-party derivatives failed:",
      (e as Error).message,
    );
    return EMPTY_DERIVATIVES;
  }
}

function buildIndiaSignal(args: IndiaSignalInputs): AiSignal {
  const factors = indiaFactors(args);
  const composite = compositeScore(factors);
  const derivShare = derivativeShare(factors, DERIVATIVE_FACTOR_IDS);
  // F&O — always LONG/SHORT (perp-style), even for spot stocks, because the
  // tradeable instrument is the future / option.
  const rawAction = classifyAction(composite.score, derivShare, {
    allowPerps: true,
    ...(args.actionMinMagnitude != null
      ? { minMagnitude: args.actionMinMagnitude }
      : {}),
  });
  // India F&O is always traded as the future/option — normalise the spot-style
  // BUY/SELL the generic classifier can emit into LONG/SHORT.
  const action: typeof rawAction =
    rawAction === "BUY" ? "LONG" : rawAction === "SELL" ? "SHORT" : rawAction;
  const direction = directionFromAction(action);
  const isWait = action === "WAIT";
  const bullish = direction === "BULLISH";

  const horizon =
    args.horizonOverride ??
    pickHorizon({
      inActiveWindow: args.inActiveWindow,
      derivativeShare: derivShare,
      scoreMagnitude: Math.abs(composite.score),
    });

  const price = args.quote?.price ?? args.dailies.at(-1)?.close ?? 0;
  const atrRaw = dailyAtr(args.dailies) ?? price * 0.012;
  // Index ATRs can come out small relative to spot in compressed regimes;
  // bound to a sensible band so the TPs/stops aren't trivially close. For
  // intraday picks we work off a fraction of the daily ATR so stops/targets
  // are sized for a same-session move, not a multi-day swing.
  const atr = args.intraday
    ? clamp(atrRaw * 0.55, price * 0.003, price * 0.022)
    : clamp(atrRaw, price * 0.005, price * 0.06);

  const levels = buildTradeLevels({
    underlyingPrice: price,
    atr,
    horizon,
    bullish,
  });

  const tick = tickFor(args.symbol, price);
  const entry = roundToTick(levels.entry, tick);
  const stopLoss = roundToTick(levels.stopLoss, tick);
  const takeProfits = levels.takeProfits.map((tp) => ({
    ...tp,
    price: roundToTick(tp.price, tick),
  }));
  const entryZone = {
    min: roundToTick(levels.entryZone.min, tick),
    max: roundToTick(levels.entryZone.max, tick),
  };

  const strike = nearestAtmStrike(args.chain, price);

  const confidenceScore = Math.round(composite.confidence * 100);
  const grade = gradeFromConfidence(composite.confidence);
  const winProbability = calibrateWinProbability(
    Math.abs(composite.score),
    composite.confidence,
  );

  const positionSizingPct = isWait
    ? 0
    : suggestPositionSizePct(entry, stopLoss, horizon, {
        confidence: composite.confidence,
      });

  const alignedRatio =
    composite.bullishCount + composite.bearishCount > 0
      ? Math.max(composite.bullishCount, composite.bearishCount) /
        (composite.bullishCount + composite.bearishCount)
      : 0;
  const riskLevel = riskLevelFromConfidence(composite.confidence, alignedRatio);

  const reasons = buildReasons(factors);

  const timing = buildTimingWindow({
    now: args.now,
    horizon,
    inActiveWindow: args.inActiveWindow,
    windowLabel: args.windowLabel,
    nextSession:
      !args.inActiveWindow && args.nextSession
        ? {
            opensAt: args.nextSession.opensAt,
            dayLabel: args.nextSession.dayLabel,
            timeLabel: args.nextSession.timeLabel,
          }
        : undefined,
  });

  const summary = composeSummary({
    action,
    symbol: args.symbol,
    grade,
    confidenceScore,
    reasons,
    horizon,
  });

  const invalidationCriteria = invalidationLine({
    bullish,
    stopLoss,
    horizon,
  });

  return {
    id: `india-${args.symbol}-${args.now}`,
    symbol: args.symbol,
    displayName: args.displayName,
    market: "india",
    pair: args.isIndex ? args.symbol : `${args.symbol}.NS`,
    action,
    direction,
    horizon,
    underlyingPrice: price,
    entry: isWait ? price : entry,
    entryZone: isWait
      ? { min: price - price * 0.0015, max: price + price * 0.0015 }
      : entryZone,
    strike: isWait ? null : strike ?? entry,
    stopLoss: isWait ? roundToTick(price - 1.5 * atr, tick) : stopLoss,
    takeProfits: isWait
      ? [
          { level: 1, price: roundToTick(price * 1.005, tick), percent: 0.5, allocation: 0.5 },
          { level: 2, price: roundToTick(price * 1.015, tick), percent: 1.5, allocation: 0.3 },
          { level: 3, price: roundToTick(price * 1.03, tick), percent: 3.0, allocation: 0.2 },
        ]
      : takeProfits,
    riskReward: isWait ? 0 : levels.riskReward,
    riskRewardBlended: isWait ? 0 : levels.riskRewardBlended,
    expectedMovePct: isWait ? 0 : levels.expectedMovePct,
    positionSizingPct,
    riskLevel: isWait ? "high" : riskLevel,
    confidence: composite.confidence,
    confidenceScore,
    grade,
    winProbability,
    timing,
    confluences: factors,
    bullishCount: composite.bullishCount,
    bearishCount: composite.bearishCount,
    reasons,
    invalidationCriteria,
    modelVersion: AI_MODEL_VERSION,
    summary,
  };
}

function buildIndiaContext(args: {
  vixQuote: Quote | null;
  indexQuotes: Quote[];
  inActiveWindow: boolean;
  windowLabel: string;
  nextSession: NextTradingSession | null;
  newsSentiment?: MarketSentiment | null;
}): AiMarketContext {
  const avgChange =
    args.indexQuotes.length > 0
      ? args.indexQuotes.reduce((s, q) => s + (q.changePct ?? 0), 0) /
        args.indexQuotes.length
      : 0;
  const vix = args.vixQuote?.price ?? null;

  let regimeScore = clamp(avgChange / 2, -1, 1) * 0.7;
  if (vix != null) {
    if (vix > 20) regimeScore -= 0.3;
    else if (vix < 12) regimeScore += 0.2;
  }
  // Fold the news tape in as a modest tilt (±0.15) so a strongly bullish or
  // bearish headline flow nudges — but never single-handedly flips — the
  // price-derived regime.
  const news = args.newsSentiment ?? null;
  if (news) regimeScore += clamp(news.score / 100, -1, 1) * 0.15;
  regimeScore = clamp(regimeScore, -1, 1);

  let regime: AiMarketRegime;
  if (regimeScore > 0.4) regime = "risk-on";
  else if (regimeScore < -0.4) regime = "risk-off";
  else if (Math.abs(regimeScore) < 0.15) regime = "compressed";
  else regime = "mixed";

  const bullets: string[] = [];
  bullets.push(
    `NIFTY/BANKNIFTY/FINNIFTY avg ${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(2)}%`,
  );
  if (vix != null) bullets.push(`India VIX ${vix.toFixed(2)}`);
  if (news && news.bullCount + news.bearCount > 0) {
    bullets.push(`News ${news.bullCount}↑ / ${news.bearCount}↓`);
  }
  if (args.inActiveWindow) {
    bullets.push(`Inside ${args.windowLabel} — F&O execution OK`);
  } else if (args.nextSession) {
    bullets.push(
      `NSE closed — signals queued for ${args.nextSession.dayLabel}'s ${args.nextSession.timeLabel} open`,
    );
  } else {
    bullets.push(`Outside ${args.windowLabel} — plan only, no live execution`);
  }

  const headline =
    regime === "risk-on"
      ? "Risk-on — indices firm, VIX contained. Press the longs."
      : regime === "risk-off"
        ? "Risk-off — indices red, VIX elevated. Fade rips, hedge longs."
        : regime === "compressed"
          ? "Compressed — IV cheap, indices coiled. Pre-position lightly."
          : "Mixed — sectors rotating, pick spots only.";

  return {
    market: "india",
    regime,
    regimeScore,
    headline,
    bullets,
    inActiveWindow: args.inActiveWindow,
    windowLabel: args.windowLabel,
    dataFreshness: "live",
    // Only surface the next-session anchor when NSE is actually closed.
    // When it's open, leaving these nullish keeps the UI from rendering
    // a stale "queued for…" banner mid-session.
    nextSessionOpensAt:
      !args.inActiveWindow && args.nextSession
        ? args.nextSession.opensAt
        : null,
    nextSessionLabel:
      !args.inActiveWindow && args.nextSession
        ? `${args.nextSession.dayLabel} at ${args.nextSession.timeLabel}`
        : null,
    indiaVix: vix,
  };
}

/**
 * Build the F&O ticker universe the AI engine covers. We focus on the four
 * index underlyings (best option-chain coverage) and three high-liquidity
 * F&O leaders for stock-level signals.
 */
const FNO_STOCK_LEADERS = ["RELIANCE", "HDFCBANK", "TCS"] as const;

interface UniverseEntry {
  symbol: string;
  displayName: string;
  isIndex: boolean;
  yahooSymbol: string;
}

function buildUniverse(): UniverseEntry[] {
  const indexEntries: UniverseEntry[] = FNO_INDICES.map((i) => ({
    symbol: i.underlying,
    displayName: i.name,
    isIndex: true,
    yahooSymbol: i.symbol,
  }));
  const stockEntries: UniverseEntry[] = FNO_STOCK_LEADERS.map((s) => ({
    symbol: s,
    displayName: s,
    isIndex: false,
    yahooSymbol: s,
  }));
  return [...indexEntries, ...stockEntries];
}

/**
 * Daily Picks scans the **full F&O universe** — every NSE stock with a live
 * options & futures contract (sourced from `lib/india/sectors.ts` via
 * `FNO_STOCKS`). The base AI universe (indices + AI leaders) is layered in
 * first so those carry the option-chain enrichment, then every remaining
 * F&O stock is added for technicals-only scoring.
 *
 * Option chains are intentionally NOT fetched for the long tail — the NSE
 * option-chain endpoint rate-limits aggressively, so chains stay gated to
 * the indices + AI leaders (see `getIndiaDailyPickCandidates`).
 */
function buildDailyPickUniverse(): UniverseEntry[] {
  const base = buildUniverse();
  const seen = new Set(base.map((u) => u.symbol));
  const extra: UniverseEntry[] = [];
  for (const s of FNO_STOCKS) {
    if (seen.has(s)) continue;
    seen.add(s);
    extra.push({ symbol: s, displayName: s, isIndex: false, yahooSymbol: s });
  }
  return [...base, ...extra];
}

interface IndiaUniverseResult {
  signals: AiSignal[];
  context: AiMarketContext;
  generatedAt: number;
  inActiveWindow: boolean;
  nextSession: NextTradingSession | null;
  stats: AiSignalsResponse["stats"];
  /** Latest India VIX value (decimal %), or null when unavailable. */
  indiaVix: number | null;
  /** Intraday level + % change for the headline indices. */
  indexLevels: Partial<
    Record<"NIFTY" | "BANKNIFTY", { level: number; changePct: number | null }>
  >;
}

/**
 * Fan out across a universe of underlyings and fold every one into a rich
 * `AiSignal`. Shared by the AI Signals board (`getIndiaAiSignals`) and the
 * Daily Picks board (`getIndiaDailyPickCandidates`). Pass `fetchChainFor` to
 * skip the (slow, rate-limited) NSE option-chain call for symbols where it
 * adds little — the engine degrades gracefully when the chain is null.
 */
async function computeIndiaUniverse(
  universe: UniverseEntry[],
  opts?: {
    fetchChainFor?: (u: UniverseEntry) => boolean;
    /** Pin every signal to this horizon (Daily Picks → intraday). */
    forceHorizon?: AiHorizon;
    /** Size stops/targets for a same-session intraday trade. */
    intraday?: boolean;
    /** Lower the WAIT threshold so borderline setups still take a side. */
    actionMinMagnitude?: number;
    /** Compute + attach the institutional futures screen (Daily Picks). */
    attachFuturesScreen?: boolean;
  },
): Promise<IndiaUniverseResult> {
  const fetchChainFor = opts?.fetchChainFor ?? (() => true);
  const yahooSymbols = universe.map((u) => u.yahooSymbol);

  const [quotes, vixQuoteRes, scannerScoresRes, derivRes, newsRes] =
    await Promise.allSettled([
      yahoo.getQuotes(yahooSymbols),
      yahoo.getQuote("^INDIAVIX"),
      loadScannerScores(),
      loadFirstPartyDerivatives(),
      loadNewsScores(),
    ]);

  const quoteList = quotes.status === "fulfilled" ? quotes.value : [];
  const vixQuote = vixQuoteRes.status === "fulfilled" ? vixQuoteRes.value : null;
  const scannerMap =
    scannerScoresRes.status === "fulfilled"
      ? scannerScoresRes.value
      : new Map<string, { score: number; tags: string[] }>();
  const deriv =
    derivRes.status === "fulfilled" ? derivRes.value : EMPTY_DERIVATIVES;
  const news = newsRes.status === "fulfilled" ? newsRes.value : EMPTY_NEWS;

  const dailiesByYf = new Map<string, Candle[]>();
  const chainBySymbol = new Map<string, OptionChain | null>();

  // Two-phase fan-out with concurrency caps — at 170+ universe entries an
  // unbounded `Promise.all` would fire every Yahoo / NSE call simultaneously
  // and earn us a 429 on cold cache. Phase 1 pulls daily candles (the heavy
  // one; cached 4h downstream — see `cache.memo` TTL in the Yahoo adapter).
  // Phase 2 pulls option chains only for the gated subset.
  await mapWithConcurrency(
    universe,
    YAHOO_HIST_CONCURRENCY,
    async (u, idx) => {
      const yfSym = yahooSymbols[idx];
      try {
        const candles = await yahoo.getHistorical({
          symbol: u.yahooSymbol,
          interval: "1d",
          range: "1y",
        });
        dailiesByYf.set(yfSym, candles);
      } catch (err) {
        console.warn(
          `[ai-signals/india] hist failed for ${u.symbol}:`,
          (err as Error).message,
        );
        dailiesByYf.set(yfSym, []);
      }
    },
    { onError: () => null },
  );

  const chainFetches = universe.filter(fetchChainFor);
  await mapWithConcurrency(
    chainFetches,
    4,
    async (u) => {
      try {
        const chain = await nse.getOptionChain(u.symbol);
        chainBySymbol.set(u.symbol, chain);
      } catch (err) {
        console.warn(
          `[ai-signals/india] option-chain failed for ${u.symbol}:`,
          (err as Error).message,
        );
        chainBySymbol.set(u.symbol, null);
      }
    },
    { onError: () => null },
  );
  // Backfill nulls for universe members we intentionally skipped.
  for (const u of universe) {
    if (!chainBySymbol.has(u.symbol)) chainBySymbol.set(u.symbol, null);
  }

  const status = getBestTimeStatus();
  const inActiveWindow =
    status.active.slug !== "off" && status.active.slug !== "worst";
  const windowLabel = status.active.label;

  // When NSE is currently closed (off-hours, weekend, auction), resolve
  // the next 09:15 IST open so per-signal timing windows + the context
  // banner can frame every signal as "queued for the next session"
  // rather than "fired at a dead-zone timestamp".
  const nextSession = inActiveWindow ? null : getNextTradingSessionOpen();

  const now = Date.now();

  // Build the market context first so every single-name signal can lean *with*
  // the broad tape (regimeScore) — a desk doesn't fight a strongly trending
  // index intraday.
  const context = buildIndiaContext({
    vixQuote,
    indexQuotes: quoteList.slice(0, FNO_INDICES.length),
    inActiveWindow,
    windowLabel,
    nextSession,
    newsSentiment: news.sentiment,
  });

  const signals: AiSignal[] = universe.map((u, idx) => {
    const yfSym = yahooSymbols[idx];
    const quote = quoteList[idx] ?? null;
    const dailies = dailiesByYf.get(yfSym) ?? [];
    const chain = chainBySymbol.get(u.symbol) ?? null;
    const scannerScore = scannerMap.get(u.symbol) ?? null;
    return buildIndiaSignal({
      symbol: u.symbol,
      displayName: u.displayName,
      isIndex: u.isIndex,
      quote,
      dailies,
      chain,
      scannerScore,
      now,
      inActiveWindow,
      windowLabel,
      nextSession,
      pcrOverride: deriv.pcr.get(u.symbol) ?? null,
      oiOverride: deriv.oi.get(u.symbol) ?? null,
      dayChangePct: quote?.changePct ?? null,
      marketRegimeScore: context.regimeScore,
      newsScore: news.symbols.get(u.symbol) ?? null,
      horizonOverride: opts?.forceHorizon,
      intraday: opts?.intraday,
      actionMinMagnitude: opts?.actionMinMagnitude,
      futuresScreen: opts?.attachFuturesScreen
        ? computeFuturesScreen(dailies)
        : null,
    });
  });

  let bullish = 0;
  let bearish = 0;
  let wait = 0;
  let confSum = 0;
  let topGrade: AiSignal["grade"] | null = null;
  const gradeRank = { S: 5, A: 4, B: 3, C: 2, D: 1 } as const;
  for (const s of signals) {
    if (s.direction === "BULLISH") bullish++;
    else if (s.direction === "BEARISH") bearish++;
    else wait++;
    confSum += s.confidence;
    if (!topGrade || gradeRank[s.grade] > gradeRank[topGrade]) topGrade = s.grade;
  }
  const avgConfidence = signals.length > 0 ? confSum / signals.length : 0;

  // Capture intraday level + change for the headline indices so downstream
  // consumers (Daily Picks header) don't have to refetch the quote slice.
  const indexLevels: IndiaUniverseResult["indexLevels"] = {};
  for (const u of universe) {
    if (u.symbol !== "NIFTY" && u.symbol !== "BANKNIFTY") continue;
    const idx = universe.indexOf(u);
    const q = quoteList[idx] ?? null;
    if (q?.price != null && Number.isFinite(q.price)) {
      indexLevels[u.symbol as "NIFTY" | "BANKNIFTY"] = {
        level: q.price,
        changePct: q.changePct ?? null,
      };
    }
  }
  const indiaVix =
    vixQuote?.price != null && Number.isFinite(vixQuote.price)
      ? vixQuote.price
      : null;

  return {
    signals,
    context,
    generatedAt: now,
    inActiveWindow,
    nextSession,
    stats: { bullish, bearish, wait, avgConfidence, topGrade },
    indiaVix,
    indexLevels,
  };
}

export async function getIndiaAiSignals(): Promise<AiSignalsResponse> {
  return indiaCache.memo("ai-signals:india:v2", CACHE_TTL_MS, async () => {
    const r = await computeIndiaUniverse(buildUniverse());
    return {
      market: "india",
      generatedAt: r.generatedAt,
      modelVersion: AI_MODEL_VERSION,
      context: r.context,
      signals: r.signals,
      stats: r.stats,
    };
  });
}

export interface IndiaDailyPickCandidates {
  signals: AiSignal[];
  context: AiMarketContext;
  generatedAt: number;
  inActiveWindow: boolean;
  /** Latest India VIX value (decimal %), or null when unavailable. */
  indiaVix: number | null;
  /**
   * Intraday level + % change for the headline indices, used by the Daily
   * Picks Market Context Header. Missing entries mean the quote wasn't
   * available — the header renders `—` for that line.
   */
  indexLevels: Partial<
    Record<"NIFTY" | "BANKNIFTY", { level: number; changePct: number | null }>
  >;
}

/**
 * Candidate signal pool for the Daily Picks board — the AI index/leader
 * universe plus a broader high-liquidity F&O stock set so the engine has
 * enough distinct names to fill three buckets of three. Option chains are
 * fetched only for the indices + AI leaders to keep the fan-out fast.
 */
export async function getIndiaDailyPickCandidates(): Promise<IndiaDailyPickCandidates> {
  // v6 — full F&O universe expansion (174 symbols, replacing the 37-symbol
  // curated set). Bumping the key forces every in-memory + Redis entry
  // built against the older universe to be evicted on the first read.
  return indiaCache.memo("daily-picks:candidates:v6", CACHE_TTL_MS, async () => {
    const r = await computeIndiaUniverse(buildDailyPickUniverse(), {
      fetchChainFor: (u) =>
        u.isIndex || (FNO_STOCK_LEADERS as readonly string[]).includes(u.symbol),
      // Daily Picks is an intraday product — pin every candidate to an
      // intraday horizon and size levels for a same-session move. The lower
      // action threshold keeps the board filled with real directional setups
      // rather than WAIT placeholders.
      forceHorizon: "intraday",
      intraday: true,
      actionMinMagnitude: 0.1,
      // Rank with the institutional futures-segment screen (range expansion,
      // bullish candle / up day, bullish week+month, liquidity, SMA 20>50>200).
      attachFuturesScreen: true,
    });
    return {
      signals: r.signals,
      context: r.context,
      generatedAt: r.generatedAt,
      inActiveWindow: r.inActiveWindow,
      indiaVix: r.indiaVix,
      indexLevels: r.indexLevels,
    };
  });
}

export const __internals = {
  buildIndiaSignal,
  indiaFactors,
  dailyAtr,
  dailyRsi,
  sma,
  computeFuturesScreen,
  pcrMapFromRows,
  oiScoreMapFromRows,
  loadFirstPartyDerivatives,
  DERIVATIVE_FACTOR_IDS,
};
