import { atr, findSwings, trailingAvg } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";

/**
 * Order Flow + Liquidity Sweep Scalping
 *
 * No order book here — instead we use the candle footprint that liquidity
 * engineering leaves behind: a wick that pierces an obvious cluster of
 * equal swing highs / lows on a high-volume bar, then closes back inside
 * the range.
 *
 * Rules (short; long is the mirror):
 *   1. Identify recent equal highs — at least two confirmed swing highs in
 *      the last `lookbackSwings` whose prices are within `eqTolAtr` × ATR.
 *      The cluster price is the average of the two.
 *   2. The current bar's high pierces the cluster by ≥ `pierceAtr` × ATR
 *      AND the close is back below the cluster level (rejection wick).
 *   3. Volume spike — bar volume ≥ `volMult` × the 20-bar average.
 *   4. Bearish body — close < open.
 *
 * Entry: bar close. Stop: just above the wick. Target: 2× stop distance.
 */

const PIVOT = 3;
const LOOKBACK_SWINGS = 5;
const EQ_TOL_ATR = 0.35;
const PIERCE_ATR = 0.15;
const VOL_LOOKBACK = 20;
const VOL_MULT = 1.8;
const ATR_PERIOD = 14;
const STOP_ATR_PAD = 0.2;
const TARGET_RR = 2;

export const orderflowSweepStrategy: ScalpStrategyModule = {
  id: "ORDERFLOW_SWEEP",
  warmup: Math.max(PIVOT * 4, VOL_LOOKBACK, ATR_PERIOD) + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < orderflowSweepStrategy.warmup) return null;

    const atrSeries = atr(candles, ATR_PERIOD);
    const vols = candles.map((c) => c.volume);
    const swings = findSwings(candles, PIVOT);

    const window = Math.max(1, Math.min(lookback, n - 1));
    for (let i = n - 1; i >= n - window; i -= 1) {
      const c = candles[i];
      const a = atrSeries[i];
      if (!Number.isFinite(a) || a <= 0) continue;
      const avgVol = trailingAvg(vols, i - 1, VOL_LOOKBACK);
      if (avgVol <= 0) continue;
      const volRatio = c.volume / avgVol;
      if (volRatio < VOL_MULT) continue;

      // Only consider swings confirmed BEFORE the current bar.
      const priorHighs = swings.highs
        .filter((s) => s.index < i)
        .slice(-LOOKBACK_SWINGS);
      const priorLows = swings.lows
        .filter((s) => s.index < i)
        .slice(-LOOKBACK_SWINGS);

      const eqHigh = findEqualCluster(priorHighs.map((s) => s.price), a * EQ_TOL_ATR);
      const eqLow = findEqualCluster(priorLows.map((s) => s.price), a * EQ_TOL_ATR);

      let direction: ScalpDirection | null = null;
      let sweptLevel = 0;
      let stopWick = 0;
      if (
        eqHigh &&
        c.high >= eqHigh + a * PIERCE_ATR &&
        c.close < eqHigh &&
        c.close < c.open
      ) {
        direction = "SHORT";
        sweptLevel = eqHigh;
        stopWick = c.high;
      } else if (
        eqLow &&
        c.low <= eqLow - a * PIERCE_ATR &&
        c.close > eqLow &&
        c.close > c.open
      ) {
        direction = "LONG";
        sweptLevel = eqLow;
        stopWick = c.low;
      }
      if (!direction) continue;

      const isLong = direction === "LONG";
      const entry = c.close;
      const stopLoss = isLong ? stopWick - a * STOP_ATR_PAD : stopWick + a * STOP_ATR_PAD;
      const stopDist = Math.abs(entry - stopLoss);
      if (stopDist <= 0) continue;
      const target = isLong ? entry + stopDist * TARGET_RR : entry - stopDist * TARGET_RR;
      const riskReward = TARGET_RR;

      const pierceAtr = (Math.abs((isLong ? sweptLevel - c.low : c.high - sweptLevel)) / a);

      let confidence = 0.55;
      if (pierceAtr >= PIERCE_ATR * 2) confidence += 0.1;
      if (volRatio >= VOL_MULT * 1.5) confidence += 0.1;
      const wickLen = isLong ? c.close - c.low : c.high - c.close;
      const body = Math.abs(c.close - c.open);
      if (wickLen > body * 1.5) confidence += 0.1;
      if (confidence > 0.9) confidence = 0.9;

      const rationale = [
        isLong
          ? `Equal lows clustered near ${sweptLevel.toFixed(4)} swept (wick to ${stopWick.toFixed(4)}, ${pierceAtr.toFixed(2)}× ATR pierce).`
          : `Equal highs clustered near ${sweptLevel.toFixed(4)} swept (wick to ${stopWick.toFixed(4)}, ${pierceAtr.toFixed(2)}× ATR pierce).`,
        `Volume ${volRatio.toFixed(2)}× the 20-bar average — heavy participation at the sweep.`,
        isLong
          ? `Close ${entry.toFixed(4)} back above the cluster — instant rejection.`
          : `Close ${entry.toFixed(4)} back below the cluster — instant rejection.`,
      ];

      return {
        strategyId: "ORDERFLOW_SWEEP",
        symbol,
        timeframe,
        direction,
        price: entry,
        trail: sweptLevel,
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
          sweptLevel: Number(sweptLevel.toFixed(6)),
          volRatio: Number(volRatio.toFixed(2)),
          pierceAtr: Number(pierceAtr.toFixed(2)),
        },
      };
    }
    return null;
  },
};

/**
 * Return the average of the tightest cluster of `prices` whose spread is
 * within `tol`. Requires at least two prices in the cluster; otherwise null.
 */
function findEqualCluster(prices: number[], tol: number): number | null {
  if (prices.length < 2 || tol <= 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  let bestAvg: number | null = null;
  let bestCount = 1;
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    let sum = 0;
    while (j < sorted.length && sorted[j] - sorted[i] <= tol) {
      sum += sorted[j];
      j += 1;
    }
    const count = j - i;
    if (count >= 2 && count >= bestCount) {
      bestCount = count;
      bestAvg = sum / count;
    }
  }
  return bestAvg;
}
