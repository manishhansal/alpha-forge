import { atr, ema, rollingVwap, trailingAvg } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";
import type { KlineCandle } from "@/types/market";

/**
 * Institutional AI SMC — port of the "Ultimate Institutional AI SMC System"
 * Pine indicator into a closed-bar scalper.
 *
 * The Pine version aggregates 9 components into a 0-9 "AI score" and fires
 * when the score reaches 7. This module follows the same scoring scheme but
 * also enforces the institutional trading-workflow preconditions on top:
 *
 *   For LONG (SHORT is the mirror) we require ALL of:
 *     1. Bull trend          — EMA20 > EMA50 (short-term up).
 *     2. Above VWAP          — institutional bias up.
 *     3. SSL sweep recent    — within the last `SETUP_WINDOW` bars price
 *                              wicked below the prior bar's low and closed
 *                              back above (smart-money stop hunt absorbed).
 *     4. Bullish BOS recent  — close has crossed the most-recent confirmed
 *                              swing high in the same window (structure
 *                              break in the trade direction).
 *
 *   …and additionally the 9-component score must reach `SCORE_THRESHOLD`.
 *
 * The remaining score components (HTF EMA200 alignment, FVG nearby,
 * volume spike, bullish/bearish delta candle, kill-zone session) are
 * confidence boosters — never sole triggers — which mirrors the prompt's
 * guidance: "if even 2 conditions missing: DO NOT TRADE".
 *
 * Stop sits one quarter-ATR beyond the sweep wick (per the workflow:
 * "SL below liquidity sweep low / above bearish OB high"). Target is
 * 2× ATR (matches the indicator's `buyTP = close + atr*2`), giving a
 * clean 1.5-2× RR after the stop pad.
 */

const EMA_FAST = 20;
const EMA_SLOW = 50;
/** Same-timeframe HTF proxy — Pine pulls a 60m EMA50, we approximate with EMA200. */
const EMA_HTF = 200;
const VWAP_WINDOW = 96;
const ATR_PERIOD = 14;
const VOL_LOOKBACK = 20;
const VOL_MULT = 1.5;
const SWING_LEN = 5;
/** Sweep + BOS must have happened within this many bars of the trigger candle. */
const SETUP_WINDOW = 6;
/** A fresh FVG within this lookback counts toward the score. */
const FVG_LOOKBACK = 6;
const STOP_ATR_PAD = 0.25;
const TARGET_ATR_MULT = 2;
const SCORE_THRESHOLD = 7;

export const institutionalSmcStrategy: ScalpStrategyModule = {
  id: "INSTITUTIONAL_SMC",
  warmup: Math.max(EMA_HTF, VWAP_WINDOW, ATR_PERIOD * 3, SWING_LEN * 4) + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < institutionalSmcStrategy.warmup) return null;

    const closes = candles.map((c) => c.close);
    const vols = candles.map((c) => c.volume);
    const emaFast = ema(closes, EMA_FAST);
    const emaSlow = ema(closes, EMA_SLOW);
    const emaHtf = ema(closes, EMA_HTF);
    const vwapSeries = rollingVwap(candles, VWAP_WINDOW);
    const atrSeries = atr(candles, ATR_PERIOD);

    // Pre-compute the most-recent confirmed swing high / low at each bar.
    // A pivot at index `p` is confirmed at bar `p + SWING_LEN`, mirroring
    // Pine's `lastSwingHigh := high[swingLen]` semantics.
    const lastSwingHigh = new Array<number>(n).fill(NaN);
    const lastSwingLow = new Array<number>(n).fill(NaN);
    let curSH = NaN;
    let curSL = NaN;
    for (let j = 0; j < n; j += 1) {
      const p = j - SWING_LEN;
      if (p >= SWING_LEN && p + SWING_LEN < n) {
        if (isPivotHigh(candles, p, SWING_LEN)) curSH = candles[p].high;
        if (isPivotLow(candles, p, SWING_LEN)) curSL = candles[p].low;
      }
      lastSwingHigh[j] = curSH;
      lastSwingLow[j] = curSL;
    }

    const window = Math.max(1, Math.min(lookback, SETUP_WINDOW));
    for (let i = n - 1; i >= n - window; i -= 1) {
      const c = candles[i];
      const a = atrSeries[i];
      if (!Number.isFinite(a) || a <= 0) continue;
      const vw = vwapSeries[i];
      if (!Number.isFinite(vw)) continue;
      const avgVol = trailingAvg(vols, i - 1, VOL_LOOKBACK);
      if (avgVol <= 0) continue;

      // ── Bar-local conditions ────────────────────────────────────────────
      const bullTrend = emaFast[i] > emaSlow[i];
      const bearTrend = emaFast[i] < emaSlow[i];
      const htfBull = c.close > emaHtf[i];
      const htfBear = c.close < emaHtf[i];
      const aboveVwap = c.close > vw;
      const belowVwap = c.close < vw;
      const volRatio = c.volume / avgVol;
      const bullVolume = volRatio >= VOL_MULT && c.close > c.open;
      const bearVolume = volRatio >= VOL_MULT && c.close < c.open;
      const bullDelta = c.close > c.open;
      const bearDelta = c.close < c.open;
      const hourUtc = new Date(c.openTime).getUTCHours();
      const inLondon = hourUtc >= 7 && hourUtc <= 10;
      const inNewYork = hourUtc >= 13 && hourUtc <= 16;
      const inKillZone = inLondon || inNewYork;

      // ── Setup window (sweep + BOS) ──────────────────────────────────────
      let sslBar = -1;
      let bslBar = -1;
      const setupStart = Math.max(1, i - SETUP_WINDOW);
      for (let j = i; j >= setupStart; j -= 1) {
        const bar = candles[j];
        const prev = candles[j - 1];
        if (sslBar < 0 && bar.low < prev.low && bar.close > prev.low) sslBar = j;
        if (bslBar < 0 && bar.high > prev.high && bar.close < prev.high) bslBar = j;
        if (sslBar >= 0 && bslBar >= 0) break;
      }

      let bullBosBar = -1;
      let bearBosBar = -1;
      for (let j = setupStart; j <= i; j += 1) {
        const sh = lastSwingHigh[j - 1];
        const sl = lastSwingLow[j - 1];
        const bar = candles[j];
        const prev = candles[j - 1];
        if (
          bullBosBar < 0 &&
          Number.isFinite(sh) &&
          prev.close <= sh &&
          bar.close > sh
        ) {
          bullBosBar = j;
        }
        if (
          bearBosBar < 0 &&
          Number.isFinite(sl) &&
          prev.close >= sl &&
          bar.close < sl
        ) {
          bearBosBar = j;
        }
      }

      // FVG (3-candle gap) — fresh if formed within the FVG lookback.
      let bullFvg = false;
      let bearFvg = false;
      const fvgStart = Math.max(2, i - FVG_LOOKBACK);
      for (let j = i; j >= fvgStart; j -= 1) {
        if (candles[j].low > candles[j - 2].high) bullFvg = true;
        if (candles[j].high < candles[j - 2].low) bearFvg = true;
        if (bullFvg && bearFvg) break;
      }

      // ── 9-component AI score (mirrors the Pine indicator) ───────────────
      const bullScore =
        (bullTrend ? 1 : 0) +
        (htfBull ? 1 : 0) +
        (aboveVwap ? 1 : 0) +
        (bullVolume ? 1 : 0) +
        (bullDelta ? 1 : 0) +
        (sslBar >= 0 ? 1 : 0) +
        (bullBosBar >= 0 ? 1 : 0) +
        (bullFvg ? 1 : 0) +
        (inKillZone ? 1 : 0);

      const bearScore =
        (bearTrend ? 1 : 0) +
        (htfBear ? 1 : 0) +
        (belowVwap ? 1 : 0) +
        (bearVolume ? 1 : 0) +
        (bearDelta ? 1 : 0) +
        (bslBar >= 0 ? 1 : 0) +
        (bearBosBar >= 0 ? 1 : 0) +
        (bearFvg ? 1 : 0) +
        (inKillZone ? 1 : 0);

      // ── Mandatory institutional preconditions ───────────────────────────
      // Trend + VWAP + sweep + BOS — never enter without all four.
      const bullCoreOk =
        bullTrend && aboveVwap && sslBar >= 0 && bullBosBar >= 0;
      const bearCoreOk =
        bearTrend && belowVwap && bslBar >= 0 && bearBosBar >= 0;

      let direction: ScalpDirection | null = null;
      let score = 0;
      let sweepBar = -1;
      let bosBar = -1;
      let hasFvg = false;
      let htfAligned = false;
      if (bullCoreOk && bullScore >= SCORE_THRESHOLD) {
        direction = "LONG";
        score = bullScore;
        sweepBar = sslBar;
        bosBar = bullBosBar;
        hasFvg = bullFvg;
        htfAligned = htfBull;
      } else if (bearCoreOk && bearScore >= SCORE_THRESHOLD) {
        direction = "SHORT";
        score = bearScore;
        sweepBar = bslBar;
        bosBar = bearBosBar;
        hasFvg = bearFvg;
        htfAligned = htfBear;
      }
      if (!direction) continue;

      const isLong = direction === "LONG";
      // Retest filter — current bar must still be on the right side of the
      // short EMA. This is the workflow's "wait for retest, don't FOMO into
      // a candle that has already extended away from EMA20".
      if (isLong && c.close < emaFast[i]) continue;
      if (!isLong && c.close > emaFast[i]) continue;

      const sweepCandle = candles[sweepBar];
      const sweepWick = isLong ? sweepCandle.low : sweepCandle.high;
      const entry = c.close;
      const stopLoss = isLong
        ? sweepWick - a * STOP_ATR_PAD
        : sweepWick + a * STOP_ATR_PAD;
      const target = isLong
        ? entry + a * TARGET_ATR_MULT
        : entry - a * TARGET_ATR_MULT;
      const stopDist = Math.abs(entry - stopLoss);
      const targetDist = Math.abs(target - entry);
      if (stopDist <= 0 || targetDist <= 0) continue;
      const riskReward = targetDist / stopDist;
      if (riskReward < 0.8) continue;

      // Confidence: base + score over threshold + structural boosters.
      let confidence = 0.55 + (score - SCORE_THRESHOLD) * 0.06;
      if (inKillZone) confidence += 0.05;
      if (htfAligned) confidence += 0.05;
      if (hasFvg) confidence += 0.04;
      if (riskReward >= 1.5) confidence += 0.05;
      if (confidence > 0.95) confidence = 0.95;

      const sweepAge = i - sweepBar;
      const bosAge = i - bosBar;
      const slopePct = ((emaFast[i] - emaSlow[i]) / Math.abs(emaSlow[i] || 1)) * 100;
      const sessionLabel = inLondon
        ? "London kill zone"
        : inNewYork
          ? "New York kill zone"
          : "off-session";

      const rationale = [
        isLong
          ? `Trend up: EMA${EMA_FAST} > EMA${EMA_SLOW} (${slopePct.toFixed(2)}% spread); HTF EMA${EMA_HTF} ${htfBull ? "aligned" : "neutral"}.`
          : `Trend down: EMA${EMA_FAST} < EMA${EMA_SLOW} (${slopePct.toFixed(2)}% spread); HTF EMA${EMA_HTF} ${htfBear ? "aligned" : "neutral"}.`,
        isLong
          ? `Above VWAP (${vw.toFixed(4)}) — institutional bias up.`
          : `Below VWAP (${vw.toFixed(4)}) — institutional bias down.`,
        isLong
          ? `Sell-side liquidity swept ${sweepAge} bar${sweepAge === 1 ? "" : "s"} ago at ${sweepWick.toFixed(4)} — stop hunt absorbed.`
          : `Buy-side liquidity swept ${sweepAge} bar${sweepAge === 1 ? "" : "s"} ago at ${sweepWick.toFixed(4)} — stop hunt absorbed.`,
        isLong
          ? `Bullish BOS confirmed ${bosAge} bar${bosAge === 1 ? "" : "s"} ago — structure break above prior swing high.`
          : `Bearish BOS confirmed ${bosAge} bar${bosAge === 1 ? "" : "s"} ago — structure break below prior swing low.`,
        `Volume ${volRatio.toFixed(2)}× the 20-bar average${hasFvg ? `, fresh ${isLong ? "bullish" : "bearish"} FVG nearby` : ""} — AI score ${score}/9 (${sessionLabel}).`,
      ];

      return {
        strategyId: "INSTITUTIONAL_SMC",
        symbol,
        timeframe,
        direction,
        price: entry,
        trail: vw,
        atr: a,
        smcBias: isLong ? 1 : -1,
        confirmed: true,
        entry,
        stopLoss,
        target,
        riskReward,
        confidence,
        rationale,
        triggeredAt: c.closeTime,
        extras: {
          score,
          vwap: Number(vw.toFixed(6)),
          sweepLevel: Number(sweepWick.toFixed(6)),
          sweepBarsAgo: sweepAge,
          bosBarsAgo: bosAge,
          volRatio: Number(volRatio.toFixed(2)),
          inKillZone,
          session: sessionLabel,
          htfAligned,
          fvgPresent: hasFvg,
        },
      };
    }
    return null;
  },
};

function isPivotHigh(candles: KlineCandle[], idx: number, len: number): boolean {
  if (idx - len < 0 || idx + len >= candles.length) return false;
  const v = candles[idx].high;
  for (let k = idx - len; k <= idx + len; k += 1) {
    if (k === idx) continue;
    if (candles[k].high >= v) return false;
  }
  return true;
}

function isPivotLow(candles: KlineCandle[], idx: number, len: number): boolean {
  if (idx - len < 0 || idx + len >= candles.length) return false;
  const v = candles[idx].low;
  for (let k = idx - len; k <= idx + len; k += 1) {
    if (k === idx) continue;
    if (candles[k].low <= v) return false;
  }
  return true;
}
