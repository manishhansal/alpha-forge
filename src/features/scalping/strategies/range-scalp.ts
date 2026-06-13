import { atr, bollinger, rollingMax, rollingMin, rsi } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";

/**
 * Range Scalping
 *
 * Range detection: the rolling support / resistance band (last `rangeWin`
 * bars) is "tight" — band width ≤ `tightnessAtr` × ATR. This filters out
 * trending markets where Bollinger touches just keep getting paid.
 *
 * Entry (long; short is the mirror):
 *   - Price tags or pierces the lower Bollinger band (mean − 2σ).
 *   - RSI ≤ `rsiLong` (oversold).
 *   - Bar closes back above the lower band (rejection).
 *
 * Exit: target the middle band (SMA(20)). Stop a small ATR pad below the
 * rolling range low — invalidates the range thesis.
 */

const RANGE_WIN = 30;
const BB_PERIOD = 20;
const BB_K = 2;
const RSI_PERIOD = 14;
const RSI_LONG = 32;
const RSI_SHORT = 68;
const TIGHTNESS_ATR = 4.5;
const ATR_PERIOD = 14;
const STOP_ATR_PAD = 0.35;

export const rangeScalpStrategy: ScalpStrategyModule = {
  id: "RANGE_SCALP",
  warmup: Math.max(RANGE_WIN, BB_PERIOD, RSI_PERIOD, ATR_PERIOD) + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < rangeScalpStrategy.warmup) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const bb = bollinger(closes, BB_PERIOD, BB_K);
    const rsiSeries = rsi(closes, RSI_PERIOD);
    const atrSeries = atr(candles, ATR_PERIOD);
    const rangeHigh = rollingMax(highs, RANGE_WIN);
    const rangeLow = rollingMin(lows, RANGE_WIN);

    const window = Math.max(1, Math.min(lookback, n - 1));
    for (let i = n - 1; i >= n - window; i -= 1) {
      const c = candles[i];
      const a = atrSeries[i];
      if (!Number.isFinite(a) || a <= 0) continue;
      const bandWidth = rangeHigh[i] - rangeLow[i];
      if (bandWidth <= 0) continue;
      const tightness = bandWidth / a;
      if (tightness > TIGHTNESS_ATR) continue; // market is trending — skip.

      const mid = bb.mid[i];
      const upper = bb.upper[i];
      const lower = bb.lower[i];
      const r = rsiSeries[i];

      let direction: ScalpDirection | null = null;
      let stopAnchor = 0;
      let touched = 0;
      if (
        (c.low <= lower || c.close <= lower) &&
        c.close > lower &&
        c.close > c.open &&
        r <= RSI_LONG
      ) {
        direction = "LONG";
        stopAnchor = Math.min(c.low, rangeLow[i]);
        touched = lower;
      } else if (
        (c.high >= upper || c.close >= upper) &&
        c.close < upper &&
        c.close < c.open &&
        r >= RSI_SHORT
      ) {
        direction = "SHORT";
        stopAnchor = Math.max(c.high, rangeHigh[i]);
        touched = upper;
      }
      if (!direction) continue;

      const isLong = direction === "LONG";
      const entry = c.close;
      const stopLoss = isLong ? stopAnchor - a * STOP_ATR_PAD : stopAnchor + a * STOP_ATR_PAD;
      const target = mid;
      const stopDist = Math.abs(entry - stopLoss);
      const targetDist = Math.abs(target - entry);
      if (stopDist <= 0 || targetDist <= 0) continue;
      const riskReward = targetDist / stopDist;
      if (riskReward < 0.6) continue;

      let confidence = 0.5;
      if (Math.abs(r - 50) >= 22) confidence += 0.1;
      if (tightness < TIGHTNESS_ATR * 0.66) confidence += 0.1;
      if (riskReward >= 1.5) confidence += 0.1;
      if (confidence > 0.9) confidence = 0.9;

      const rationale = [
        `Range detected: width ${tightness.toFixed(2)}× ATR over last ${RANGE_WIN} bars — no trend.`,
        isLong
          ? `Bollinger lower band ${touched.toFixed(4)} tagged; RSI ${r.toFixed(1)} oversold.`
          : `Bollinger upper band ${touched.toFixed(4)} tagged; RSI ${r.toFixed(1)} overbought.`,
        `Targeting mid-band (${mid.toFixed(4)}); stop ${stopLoss.toFixed(4)} beyond range extreme.`,
      ];

      return {
        strategyId: "RANGE_SCALP",
        symbol,
        timeframe,
        direction,
        price: entry,
        trail: mid,
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
          rsi: Number(r.toFixed(2)),
          bandTightness: Number(tightness.toFixed(2)),
          bbUpper: Number(upper.toFixed(6)),
          bbLower: Number(lower.toFixed(6)),
        },
      };
    }
    return null;
  },
};
