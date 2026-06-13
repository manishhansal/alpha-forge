import { atr, sma, trailingAvg } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";

/**
 * News + Momentum Scalping
 *
 * The trader can't see the news feed from inside the engine, but the market
 * always *prints* the news as a volume + range expansion. So this strategy
 * looks for that footprint:
 *
 *   1. Volume spike — current bar's volume is ≥ `volMult` × the 20-bar avg.
 *   2. Range expansion — current bar's true range is ≥ `rangeMult` × ATR(14).
 *   3. Directional bar — close is in the top `bodyRatio` of the range (long)
 *      or the bottom (short) — the impulse is decisive.
 *   4. Follow-through — close is above (long) / below (short) the 20-bar SMA
 *      so we're never fighting the day's drift.
 *
 * Aggressive sizing: stop = opposite extreme of the impulse bar; target = 1.5×
 * the bar's range. This burns out fast on chop, which is by design — the
 * strategy only earns when a real news / liquidation cascade fires.
 */

const VOL_LOOKBACK = 20;
const ATR_PERIOD = 14;
const VOL_MULT = 2.8;
const RANGE_MULT = 1.8;
const BODY_RATIO = 0.6;
const SMA_FILTER = 20;
const TARGET_RANGE_MULT = 1.5;

export const newsMomentumStrategy: ScalpStrategyModule = {
  id: "NEWS_MOMENTUM",
  warmup: Math.max(VOL_LOOKBACK, ATR_PERIOD, SMA_FILTER) + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < newsMomentumStrategy.warmup) return null;

    const closes = candles.map((c) => c.close);
    const vols = candles.map((c) => c.volume);
    const atrSeries = atr(candles, ATR_PERIOD);
    const smaSeries = sma(closes, SMA_FILTER);

    const window = Math.max(1, Math.min(lookback, n - 1));
    for (let i = n - 1; i >= n - window; i -= 1) {
      const c = candles[i];
      const range = c.high - c.low;
      if (range <= 0) continue;
      const a = atrSeries[i];
      if (!Number.isFinite(a) || a <= 0) continue;

      const avgVol = trailingAvg(vols, i - 1, VOL_LOOKBACK);
      if (avgVol <= 0) continue;
      const volRatio = c.volume / avgVol;
      if (volRatio < VOL_MULT) continue;
      const rangeRatio = range / a;
      if (rangeRatio < RANGE_MULT) continue;

      const bodyTop = (c.close - c.low) / range;
      const bodyBot = (c.high - c.close) / range;
      const drift = smaSeries[i];

      let direction: ScalpDirection | null = null;
      if (bodyTop >= BODY_RATIO && c.close > drift && c.close > c.open) {
        direction = "LONG";
      } else if (bodyBot >= BODY_RATIO && c.close < drift && c.close < c.open) {
        direction = "SHORT";
      }
      if (!direction) continue;

      const isLong = direction === "LONG";
      const entry = c.close;
      const stopLoss = isLong ? c.low : c.high;
      const target = isLong
        ? entry + range * TARGET_RANGE_MULT
        : entry - range * TARGET_RANGE_MULT;
      const stopDist = Math.abs(entry - stopLoss);
      const targetDist = Math.abs(target - entry);
      if (stopDist <= 0 || targetDist <= 0) continue;
      const riskReward = targetDist / stopDist;

      let confidence = 0.5;
      if (volRatio >= VOL_MULT * 1.5) confidence += 0.1;
      if (rangeRatio >= RANGE_MULT * 1.5) confidence += 0.1;
      if (Math.max(bodyTop, bodyBot) >= 0.8) confidence += 0.1;
      if (riskReward >= 1.5) confidence += 0.05;
      if (confidence > 0.9) confidence = 0.9;

      const rationale = [
        `Volume ${volRatio.toFixed(2)}× the 20-bar average — likely news / liquidation impulse.`,
        `Range ${rangeRatio.toFixed(2)}× ATR(${ATR_PERIOD}); body ${(Math.max(bodyTop, bodyBot) * 100).toFixed(0)}% of the bar in the trade direction.`,
        isLong
          ? `Close ${entry.toFixed(4)} above SMA${SMA_FILTER} (${drift.toFixed(4)}) — riding the day's drift.`
          : `Close ${entry.toFixed(4)} below SMA${SMA_FILTER} (${drift.toFixed(4)}) — riding the day's drift.`,
      ];

      return {
        strategyId: "NEWS_MOMENTUM",
        symbol,
        timeframe,
        direction,
        price: entry,
        trail: drift,
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
          volRatio: Number(volRatio.toFixed(2)),
          rangeRatio: Number(rangeRatio.toFixed(2)),
          bodyRatio: Number(Math.max(bodyTop, bodyBot).toFixed(2)),
        },
      };
    }
    return null;
  },
};
