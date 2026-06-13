import { atr, ema, rollingMax, rollingMin, rollingVwap } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";

/**
 * VWAP + Liquidity Sweep + Trend Filter
 *
 * Rules (long; short is the mirror):
 *   1. Higher-timeframe trend is up — EMA50 is rising for the last `slopeLen`
 *      bars.
 *   2. Liquidity sweep — the current bar wicks below the prior `swingWin`
 *      bars' low but closes back above it (rejection).
 *   3. Price is stretched away from VWAP — close < VWAP by at least
 *      `vwapDistAtr` × ATR.
 *   4. Confirmation candle — current bar closes in the upper third of its
 *      range (bullish rejection).
 *
 * Exit: target is VWAP itself (mean reversion). Stop is just beyond the wick
 * that swept liquidity. Confidence scales with depth of stretch and slope.
 */

const SWING_WIN = 20;
const VWAP_WINDOW = 96;
const VWAP_DIST_ATR = 0.8;
const ATR_PERIOD = 14;
const STOP_ATR_PAD = 0.25;
const EMA_TREND = 50;
const SLOPE_LEN = 5;

export const vwapSweepTrendStrategy: ScalpStrategyModule = {
  id: "VWAP_SWEEP_TREND",
  warmup: VWAP_WINDOW + SLOPE_LEN + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < vwapSweepTrendStrategy.warmup) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const vwapSeries = rollingVwap(candles, VWAP_WINDOW);
    const ema50 = ema(closes, EMA_TREND);
    const atrSeries = atr(candles, ATR_PERIOD);
    // Use prior bar's swing extremes so the current bar's wick can sweep them.
    const priorHigh = rollingMax(highs.slice(0, -1), SWING_WIN);
    const priorLow = rollingMin(lows.slice(0, -1), SWING_WIN);

    const window = Math.max(1, Math.min(lookback, n - 1));
    for (let i = n - 1; i >= n - window; i -= 1) {
      const c = candles[i];
      const range = c.high - c.low;
      if (range <= 0) continue;
      const ema50Now = ema50[i];
      const ema50Then = ema50[i - SLOPE_LEN];
      const trendUp = ema50Now > ema50Then;
      const trendDown = ema50Now < ema50Then;
      const vw = vwapSeries[i];
      const a = atrSeries[i];
      if (!Number.isFinite(vw) || !Number.isFinite(a) || a <= 0) continue;

      const sweptLow = priorLow[i - 1];
      const sweptHigh = priorHigh[i - 1];

      let direction: ScalpDirection | null = null;
      let stopWick = 0;
      let sweptLevel = 0;
      if (
        trendUp &&
        c.low < sweptLow &&
        c.close > sweptLow &&
        c.close < vw &&
        vw - c.close >= a * VWAP_DIST_ATR &&
        c.close >= c.low + range * 0.66
      ) {
        direction = "LONG";
        stopWick = c.low;
        sweptLevel = sweptLow;
      } else if (
        trendDown &&
        c.high > sweptHigh &&
        c.close < sweptHigh &&
        c.close > vw &&
        c.close - vw >= a * VWAP_DIST_ATR &&
        c.close <= c.high - range * 0.66
      ) {
        direction = "SHORT";
        stopWick = c.high;
        sweptLevel = sweptHigh;
      }
      if (!direction) continue;

      const isLong = direction === "LONG";
      const entry = c.close;
      const stopLoss = isLong ? stopWick - a * STOP_ATR_PAD : stopWick + a * STOP_ATR_PAD;
      const target = vw;
      const stopDist = Math.abs(entry - stopLoss);
      const targetDist = Math.abs(target - entry);
      if (stopDist <= 0 || targetDist <= 0) continue;
      const riskReward = targetDist / stopDist;
      if (riskReward < 0.8) continue;

      const slopePct = ((ema50Now - ema50Then) / Math.abs(ema50Then || 1)) * 100;
      const distAtr = Math.abs(vw - entry) / a;
      let confidence = 0.55;
      if (distAtr >= 1.2) confidence += 0.1;
      if (Math.abs(slopePct) > 0.15) confidence += 0.1;
      if (riskReward >= 1.5) confidence += 0.1;
      if (confidence > 0.92) confidence = 0.92;

      const rationale = [
        isLong
          ? `EMA${EMA_TREND} rising over last ${SLOPE_LEN} bars (${slopePct.toFixed(2)}%) — higher TF trend up.`
          : `EMA${EMA_TREND} falling over last ${SLOPE_LEN} bars (${slopePct.toFixed(2)}%) — higher TF trend down.`,
        isLong
          ? `Sweep: wick to ${stopWick.toFixed(4)} took out prior low ${sweptLevel.toFixed(4)} and closed back inside.`
          : `Sweep: wick to ${stopWick.toFixed(4)} took out prior high ${sweptLevel.toFixed(4)} and closed back inside.`,
        `Price stretched ${distAtr.toFixed(2)}× ATR from VWAP (${vw.toFixed(4)}); targeting mean reversion.`,
      ];

      return {
        strategyId: "VWAP_SWEEP_TREND",
        symbol,
        timeframe,
        direction,
        price: entry,
        trail: vw,
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
          vwap: Number(vw.toFixed(6)),
          sweptLevel: Number(sweptLevel.toFixed(6)),
          ema50: Number(ema50Now.toFixed(6)),
          slopePct: Number(slopePct.toFixed(4)),
        },
      };
    }
    return null;
  },
};
