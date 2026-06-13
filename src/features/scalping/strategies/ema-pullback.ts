import { atr, ema } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";

/**
 * EMA Pullback Trend Scalping
 *
 * Trend definition (long):
 *   EMA9 > EMA20 > EMA50, and EMA50 is rising over the last `slopeLen`
 *   bars.
 *
 * Pullback (long):
 *   The previous bar's low pierced (or touched) the EMA9-EMA20 zone — i.e.
 *   `prev.low ≤ ema9 && prev.low ≥ ema50` — so we've come back to dynamic
 *   support without breaking the stack.
 *
 * Confirmation (long):
 *   Current bar closes bullish (close > open) AND closes back above the
 *   EMA9. We fire the signal on this bar.
 *
 * Risk: stop just below the pullback low minus an ATR pad. Target is 2× the
 * stop distance — the classic 2:1 trend-following scalp.
 */

const EMA_FAST = 9;
const EMA_MID = 20;
const EMA_SLOW = 50;
const SLOPE_LEN = 5;
const ATR_PERIOD = 14;
const STOP_ATR_PAD = 0.2;
const TARGET_RR = 2;

export const emaPullbackStrategy: ScalpStrategyModule = {
  id: "EMA_PULLBACK",
  warmup: EMA_SLOW + SLOPE_LEN + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < emaPullbackStrategy.warmup) return null;

    const closes = candles.map((c) => c.close);
    const ema9 = ema(closes, EMA_FAST);
    const ema20 = ema(closes, EMA_MID);
    const ema50 = ema(closes, EMA_SLOW);
    const atrSeries = atr(candles, ATR_PERIOD);

    const window = Math.max(1, Math.min(lookback, n - 1));
    for (let i = n - 1; i >= n - window; i -= 1) {
      if (i < 1) continue;
      const c = candles[i];
      const prev = candles[i - 1];
      const a = atrSeries[i];
      if (!Number.isFinite(a) || a <= 0) continue;

      const e9 = ema9[i];
      const e20 = ema20[i];
      const e50 = ema50[i];
      const slopeNow = ema50[i];
      const slopeThen = ema50[i - SLOPE_LEN];
      const trendUp = e9 > e20 && e20 > e50 && slopeNow > slopeThen;
      const trendDown = e9 < e20 && e20 < e50 && slopeNow < slopeThen;

      let direction: ScalpDirection | null = null;
      let pullbackAnchor = 0;
      if (
        trendUp &&
        prev.low <= e9 &&
        prev.low >= e50 &&
        c.close > c.open &&
        c.close > e9
      ) {
        direction = "LONG";
        pullbackAnchor = Math.min(prev.low, c.low);
      } else if (
        trendDown &&
        prev.high >= e9 &&
        prev.high <= e50 &&
        c.close < c.open &&
        c.close < e9
      ) {
        direction = "SHORT";
        pullbackAnchor = Math.max(prev.high, c.high);
      }
      if (!direction) continue;

      const isLong = direction === "LONG";
      const entry = c.close;
      const stopLoss = isLong
        ? pullbackAnchor - a * STOP_ATR_PAD
        : pullbackAnchor + a * STOP_ATR_PAD;
      const stopDist = Math.abs(entry - stopLoss);
      if (stopDist <= 0) continue;
      const target = isLong ? entry + stopDist * TARGET_RR : entry - stopDist * TARGET_RR;
      const riskReward = TARGET_RR;

      const slopePct = ((slopeNow - slopeThen) / Math.abs(slopeThen || 1)) * 100;
      let confidence = 0.55;
      if (Math.abs(slopePct) > 0.2) confidence += 0.1;
      const fastSep = Math.abs(e9 - e20) / a;
      const midSep = Math.abs(e20 - e50) / a;
      if (fastSep > 0.3 && midSep > 0.5) confidence += 0.1;
      if (confidence > 0.9) confidence = 0.9;

      const rationale = [
        isLong
          ? `EMA stack bullish: 9 (${e9.toFixed(4)}) > 20 (${e20.toFixed(4)}) > 50 (${e50.toFixed(4)}).`
          : `EMA stack bearish: 9 (${e9.toFixed(4)}) < 20 (${e20.toFixed(4)}) < 50 (${e50.toFixed(4)}).`,
        isLong
          ? `Prior bar's low ${prev.low.toFixed(4)} pulled into the EMA9-EMA50 zone.`
          : `Prior bar's high ${prev.high.toFixed(4)} pulled into the EMA9-EMA50 zone.`,
        isLong
          ? `Confirmation candle closes ${entry.toFixed(4)} above EMA9 — continuation entry.`
          : `Confirmation candle closes ${entry.toFixed(4)} below EMA9 — continuation entry.`,
      ];

      return {
        strategyId: "EMA_PULLBACK",
        symbol,
        timeframe,
        direction,
        price: entry,
        trail: e9,
        atr: a,
        smcBias: 0,
        confirmed: true,
        entry,
        stopLoss,
        target,
        riskReward,
        confidence,
        rationale,
        triggeredAt: c.closeTime,
        extras: {
          ema9: Number(e9.toFixed(6)),
          ema20: Number(e20.toFixed(6)),
          ema50: Number(e50.toFixed(6)),
          slopePct: Number(slopePct.toFixed(4)),
        },
      };
    }
    return null;
  },
};
