/**
 * Pure signal builder for the **Opening Breakout** F&O strategy — the
 * first-5-minute-candle (opening-range) breakout, tuned for Indian markets.
 *
 * The opening candle (09:15–09:19:59 IST) captures the day's first battle
 * between buyers and sellers. A subsequent 5-min candle that *closes* beyond
 * that range confirms the winner. The **retest** of the broken level is the
 * entry — the level flips resistance→support (or support→resistance), the
 * highest-probability, lowest-risk point of the setup. Stop sits below the
 * breakout candle's low (above its high for shorts); the target is 2R.
 *
 * This module is deliberately I/O-free (no `server-only`, no service imports)
 * so the logic is unit-testable with fixed candle fixtures. The async
 * orchestrator that fetches live 5-min candles + option-chain confirmation
 * lives in `opening-breakout.ts`.
 */

import type { Candle } from "@/types/india/market";
import type { OptionChainAnalytics } from "@/types/india/options";
import type {
  IndiaScalpSignal,
  IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

/**
 * F&O index underlyings — the four indices for which NSE writes options. Used
 * to apply a small confidence bonus to index ORB setups: indices are the
 * F&O hero (max liquidity, tightest spreads, no single-stock news shock, the
 * widest institutional participation). A clean retested index breakout should
 * rank above an equally-clean stock breakout on the Daily Picks board.
 */
const FNO_INDEX_SYMBOLS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The opening 5-min candle starts at 09:15 IST. */
const OPEN_HOUR = 9;
const OPEN_MINUTE = 15;

/** Reward:risk multiple — the strategy's "Target = 2× stop distance (2R)". */
const TARGET_RR = 2;
/** Stretch target ("can move upto") = 3R on a clean trend leg. */
const STRETCH_RR = 3;

/**
 * Opening-range width sanity (as % of the opening price):
 * - below `MIN` the range is too tight → false breakouts (skip),
 * - above `WIDE` the gap-driven range is huge → down-size confidence.
 * Mirrors the India-specific rules in the strategy write-up.
 */
const MIN_RANGE_PCT = 0.1;
const WIDE_RANGE_PCT = 0.7;

export interface OpeningBreakoutInput {
  /** NSE ticker without `.NS` (e.g. "RELIANCE", "NIFTY"). */
  symbol: string;
  /** Pretty display name — falls back to `symbol`. */
  symbolName?: string;
  timeframe: IndiaScalpTimeframe;
  /** 5-min candles ascending by time. May span several sessions. */
  candles: Candle[];
  /** Live last price (₹). Defaults to the latest candle's close. */
  lastPrice?: number | null;
  /** Option-chain analytics for PCR / OI / max-pain confirmation. */
  analytics?: OptionChainAnalytics | null;
}

/** IST hour / minute / `YYYY-MM-DD` date key for a unix-seconds timestamp. */
export function istParts(timeSec: number): {
  hour: number;
  minute: number;
  dateKey: string;
} {
  const ist = new Date(timeSec * 1000 + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return {
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    dateKey: `${y}-${m}-${d}`,
  };
}

/** Candles belonging to the latest IST session present in the series. */
export function latestSessionCandles(candles: Candle[]): Candle[] {
  if (candles.length === 0) return [];
  let latest = "";
  for (const c of candles) {
    const { dateKey } = istParts(c.time);
    if (dateKey > latest) latest = dateKey;
  }
  return candles
    .filter((c) => istParts(c.time).dateKey === latest)
    .sort((a, b) => a.time - b.time);
}

/** The opening 5-min candle (09:15 IST) of a single session, or null. */
export function firstFiveMinCandle(sessionCandles: Candle[]): Candle | null {
  for (const c of sessionCandles) {
    const { hour, minute } = istParts(c.time);
    if (hour === OPEN_HOUR && minute === OPEN_MINUTE) return c;
  }
  return null;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Project the option chain onto the trade direction: positive when the
 * positioning supports the breakout (puts being written / max pain pulling the
 * trade's way), negative when it fights it. Returns 0 when no chain is given.
 */
function optionAlignment(
  analytics: OptionChainAnalytics | null | undefined,
  isLong: boolean,
  spot: number,
): { score: number; note: string | null } {
  if (!analytics) return { score: 0, note: null };
  let score = 0;
  const notes: string[] = [];

  const pcr = analytics.pcrOi;
  if (pcr != null && Number.isFinite(pcr)) {
    // High PCR ⇒ heavy put writing ⇒ support below (bullish); low PCR ⇒ call
    // writing ⇒ resistance above (bearish).
    if (isLong) {
      if (pcr >= 1.1) {
        score += 0.08;
        notes.push(`PCR ${pcr.toFixed(2)} (put-writing support)`);
      } else if (pcr <= 0.8) {
        score -= 0.08;
        notes.push(`PCR ${pcr.toFixed(2)} fighting the long`);
      }
    } else {
      if (pcr <= 0.9) {
        score += 0.08;
        notes.push(`PCR ${pcr.toFixed(2)} (call-writing resistance)`);
      } else if (pcr >= 1.2) {
        score -= 0.08;
        notes.push(`PCR ${pcr.toFixed(2)} fighting the short`);
      }
    }
  }

  const maxPain = analytics.maxPain;
  if (maxPain != null && Number.isFinite(maxPain) && spot > 0) {
    // Max pain above spot pulls price up (bullish), below pulls it down.
    const painAbove = maxPain >= spot;
    if (isLong === painAbove) {
      score += 0.05;
      notes.push(`max-pain ${painAbove ? "above" : "below"} spot`);
    } else {
      score -= 0.04;
    }
  }

  return {
    score,
    note: notes.length > 0 ? notes.join(", ") : null,
  };
}

/**
 * Build an Opening Breakout signal from a symbol's 5-min candles. Returns null
 * when there is no opening candle yet, no breakout close beyond the range, or
 * the geometry is degenerate (zero risk distance). `confirmed` is true only
 * once the broken level has been **retested** — the strategy's non-negotiable
 * entry trigger; an unconfirmed signal flags a breakout still awaiting its
 * retest.
 */
export function buildOpeningBreakoutSignal(
  input: OpeningBreakoutInput,
): IndiaScalpSignal | null {
  const session = latestSessionCandles(input.candles);
  if (session.length < 2) return null;

  const first = firstFiveMinCandle(session);
  if (!first) return null;

  const rangeHigh = first.high;
  const rangeLow = first.low;
  const openPx = first.open > 0 ? first.open : first.close;
  if (!(rangeHigh > rangeLow) || !(openPx > 0)) return null;

  const after = session.filter((c) => c.time > first.time);
  if (after.length === 0) return null;

  // First 5-min candle to CLOSE beyond the opening range wins the breakout.
  let breakoutIdx = -1;
  let isLong = false;
  for (let i = 0; i < after.length; i++) {
    if (after[i].close > rangeHigh) {
      breakoutIdx = i;
      isLong = true;
      break;
    }
    if (after[i].close < rangeLow) {
      breakoutIdx = i;
      isLong = false;
      break;
    }
  }
  if (breakoutIdx < 0) return null;

  const breakout = after[breakoutIdx];
  const level = isLong ? rangeHigh : rangeLow;

  // Retest: a later candle that returns to the broken level and *holds with
  // direction confirmation*. We require:
  //   1. price touches the level (low ≤ level for long, high ≥ level for short),
  //   2. the bar closes back on the breakout side (close ≥ level / close ≤ level),
  //   3. the bar itself is directional in the trade's favour (bullish bar on a
  //      long retest, bearish bar on a short retest) — a doji or counter-bar
  //      at the level is a *failed* retest, not a held one.
  // This last gate stops the "wick into the level, close flat, then reverse"
  // false retests that produced the ICICIBANK SHORT stopout in <20m on
  // 2026-06-17.
  let retest: Candle | null = null;
  for (let j = breakoutIdx + 1; j < after.length; j++) {
    const c = after[j];
    const directional = isLong ? c.close > c.open : c.close < c.open;
    if (!directional) continue;
    if (isLong && c.low <= level && c.close >= level) {
      retest = c;
      break;
    }
    if (!isLong && c.high >= level && c.close <= level) {
      retest = c;
      break;
    }
  }
  const confirmed = retest != null;

  // Entry on the retest of the broken level (the support/resistance flip).
  const entry = level;
  const stopLoss = isLong ? breakout.low : breakout.high;
  const risk = Math.abs(entry - stopLoss);
  if (!(risk > 0)) return null;

  const target = isLong ? entry + TARGET_RR * risk : entry - TARGET_RR * risk;
  const lastPrice =
    input.lastPrice != null && Number.isFinite(input.lastPrice)
      ? input.lastPrice
      : (session.at(-1)?.close ?? breakout.close);

  // --- Confidence -----------------------------------------------------------
  const rangePct = ((rangeHigh - rangeLow) / openPx) * 100;
  let confidence = confirmed ? 0.62 : 0.42;

  // Opening-range width sanity (India: gaps widen the range; tight ranges trap).
  if (rangePct < MIN_RANGE_PCT) confidence -= 0.18;
  else if (rangePct > WIDE_RANGE_PCT) confidence -= 0.08;

  // Volume thrust on the breakout candle vs the opening candle.
  const firstVol = first.volume ?? 0;
  const breakoutVol = breakout.volume ?? 0;
  if (firstVol > 0 && breakoutVol > firstVol) confidence += 0.08;

  // Option-chain confirmation.
  const spotForChain = lastPrice ?? entry;
  const opt = optionAlignment(input.analytics, isLong, spotForChain);
  confidence += opt.score;

  // F&O index bonus — see FNO_INDEX_SYMBOLS comment for the rationale. Without
  // this, a NIFTY ORB long with chain max-pain marginally below spot ranked
  // below a half-dozen stock setups despite hitting its stretch target
  // intraday (2026-06-17 regression).
  if (FNO_INDEX_SYMBOLS.has(input.symbol)) confidence += 0.05;

  confidence = clamp01(confidence);

  // --- Rationale ------------------------------------------------------------
  const dirWord = isLong ? "Bullish" : "Bearish";
  const rationale: string[] = [
    `Opening 5-min range ₹${rangeLow.toFixed(2)}–₹${rangeHigh.toFixed(2)} (${rangePct.toFixed(2)}% wide)`,
    `${dirWord} breakout — 5-min close ${isLong ? "above" : "below"} the range`,
    confirmed
      ? `Retest of ₹${level.toFixed(2)} held — entry on the ${isLong ? "resistance→support" : "support→resistance"} flip`
      : `Awaiting retest of ₹${level.toFixed(2)} (the non-negotiable entry trigger)`,
    `Stop ₹${stopLoss.toFixed(2)} (below breakout candle ${isLong ? "low" : "high"}), target ₹${target.toFixed(2)} (2R)`,
  ];
  if (rangePct > WIDE_RANGE_PCT) {
    rationale.push("Wide gap-driven opening range — size down");
  }
  if (opt.note) rationale.push(`Option chain: ${opt.note}`);
  rationale.push("Options: trade ATM / 1-strike ITM (post-9:30 IV crush)");

  const triggeredAt = (retest ?? breakout).time * 1000;

  return {
    strategyId: "OPENING_BREAKOUT",
    symbol: input.symbol,
    symbolName: input.symbolName ?? input.symbol,
    timeframe: input.timeframe,
    direction: isLong ? "LONG" : "SHORT",
    price: lastPrice,
    reference: level,
    atr: risk,
    confirmed,
    entry,
    stopLoss,
    target,
    riskReward: TARGET_RR,
    confidence,
    rationale,
    triggeredAt,
    extras: {
      rangeHigh,
      rangeLow,
      rangePct: Number(rangePct.toFixed(3)),
      stretchTarget: isLong
        ? entry + STRETCH_RR * risk
        : entry - STRETCH_RR * risk,
      retested: confirmed,
      breakoutClose: breakout.close,
      pcrOi: input.analytics?.pcrOi ?? null,
      maxPain: input.analytics?.maxPain ?? null,
    },
  };
}
