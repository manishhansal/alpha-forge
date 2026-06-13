import { atr } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";

/**
 * Fibonacci Pullback Scalp (1-minute crypto).
 *
 * Hunts the textbook 1m crypto pattern — a sharp impulse move, a
 * pullback into the 0.5 / 0.618 Fibonacci retracement zone of that
 * impulse, and a confirmation candle that resumes the impulse direction.
 *
 * The Fib ladder is anchored 0 = impulse extreme (top of an up impulse,
 * bottom of a down impulse) and 1 = impulse origin. A pullback that tags
 * the 0.5-0.618 band but never breaks 0.786 is the entry zone — a
 * classic "shallow retest first, deeper test second" sequence on the 1m.
 *
 * Sequence (long; short is the mirror):
 *   1. Within the last `IMPULSE_WIN` closed bars, find the swing low and
 *      swing high. The swing must be ≥ `IMPULSE_ATR_MULT` × ATR. If the
 *      low's index is BEFORE the high's, the impulse is UP.
 *   2. Compute the deepest pullback (the lowest low after the impulse
 *      peak, up to and including the current bar). Require:
 *        - depth ≥ 0.5 retrace (price has reached the 0.5 fib), AND
 *        - depth ≤ 0.786 retrace (the impulse hasn't been invalidated).
 *   3. Confirmation candle (current bar):
 *        - Prior bar's low pierced the 0.5-0.618 entry zone, AND
 *        - Current bar is bullish (close > open) AND closes back above
 *          the 0.5 fib — i.e. the zone rejected.
 *   4. Entry = bar close. Stop = pullback wick − ATR pad. Target = 0.0
 *      fib (the impulse extreme), giving ~1.5-2× RR on typical 1m noise.
 *
 * Only fires on the 1m timeframe — the impulse / retracement footprint
 * is too noisy on higher TFs and the engine has dedicated trend modules
 * for those (`EMA_PULLBACK`, `VWAP_SWEEP_TREND`).
 */

const IMPULSE_WIN = 12;
const IMPULSE_ATR_MULT = 3;
/** Pullback must reach at least this fib retrace to qualify. */
const FIB_ENTRY_MIN = 0.5;
/** Sweet spot upper edge of the entry zone (0.618 Fib). */
const FIB_ENTRY_MAX = 0.618;
/** A pullback deeper than this invalidates the impulse — skip the trade. */
const FIB_INVALIDATE = 0.786;
/** Target back to the impulse extreme. */
const TARGET_FIB = 0;
const ATR_PERIOD = 14;
const STOP_ATR_PAD = 0.15;
/** Minimum pullback duration in bars between the impulse extreme and now. */
const MIN_PULLBACK_BARS = 2;

export const fibPullbackStrategy: ScalpStrategyModule = {
  id: "FIB_PULLBACK",
  warmup: Math.max(IMPULSE_WIN, ATR_PERIOD) + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    if (timeframe !== "1m") return null;

    const n = candles.length;
    if (n < fibPullbackStrategy.warmup) return null;

    const atrSeries = atr(candles, ATR_PERIOD);
    const window = Math.max(1, Math.min(lookback, n - 1));

    for (let i = n - 1; i >= n - window; i -= 1) {
      if (i < IMPULSE_WIN) continue;
      const c = candles[i];
      const prev = candles[i - 1];
      const a = atrSeries[i];
      if (!Number.isFinite(a) || a <= 0) continue;

      // Scan the IMPULSE_WIN bars *before* the current bar for the swing
      // extremes. The current bar is reserved for the confirmation.
      const start = i - IMPULSE_WIN;
      let highIdx = start;
      let lowIdx = start;
      for (let j = start + 1; j <= i - 1; j += 1) {
        if (candles[j].high > candles[highIdx].high) highIdx = j;
        if (candles[j].low < candles[lowIdx].low) lowIdx = j;
      }
      const swingHigh = candles[highIdx].high;
      const swingLow = candles[lowIdx].low;
      const range = swingHigh - swingLow;
      if (range <= 0) continue;
      if (range < a * IMPULSE_ATR_MULT) continue;

      const isUp = lowIdx < highIdx;
      const isDown = highIdx < lowIdx;
      if (!isUp && !isDown) continue;

      const direction: ScalpDirection = isUp ? "LONG" : "SHORT";
      const extreme = isUp ? swingHigh : swingLow;
      const extIdx = isUp ? highIdx : lowIdx;

      // Need a few bars of pullback after the impulse peak to even
      // consider an entry — otherwise we're firing on the impulse bar
      // itself.
      if (i - extIdx < MIN_PULLBACK_BARS) continue;

      // Fib levels measured outwards from the impulse extreme. For an UP
      // impulse the fibs descend from the swing high; for a DOWN impulse
      // they ascend from the swing low.
      const fibAt = (lvl: number): number =>
        isUp ? extreme - range * lvl : extreme + range * lvl;
      const fib05 = fibAt(FIB_ENTRY_MIN);
      const fib0618 = fibAt(FIB_ENTRY_MAX);
      const fibInval = fibAt(FIB_INVALIDATE);

      // Deepest pullback price between the impulse extreme and the
      // current bar — the wick we'd put our stop behind.
      let pullbackExtreme: number;
      if (isUp) {
        pullbackExtreme = Number.POSITIVE_INFINITY;
        for (let j = extIdx + 1; j <= i; j += 1) {
          if (candles[j].low < pullbackExtreme) pullbackExtreme = candles[j].low;
        }
        if (!Number.isFinite(pullbackExtreme)) continue;
        // Reached the 0.5 fib (price ≤ fib05) but didn't break 0.786
        // (price > fibInval, since price is decreasing in an up impulse).
        if (pullbackExtreme > fib05) continue;
        if (pullbackExtreme < fibInval) continue;
      } else {
        pullbackExtreme = Number.NEGATIVE_INFINITY;
        for (let j = extIdx + 1; j <= i; j += 1) {
          if (candles[j].high > pullbackExtreme) pullbackExtreme = candles[j].high;
        }
        if (!Number.isFinite(pullbackExtreme)) continue;
        if (pullbackExtreme < fib05) continue;
        if (pullbackExtreme > fibInval) continue;
      }

      let confirmed = false;
      if (isUp) {
        const piercedZone = prev.low <= fib05;
        const bullish = c.close > c.open;
        const reclaimed = c.close > fib05;
        confirmed = piercedZone && bullish && reclaimed;
      } else {
        const piercedZone = prev.high >= fib05;
        const bearish = c.close < c.open;
        const reclaimed = c.close < fib05;
        confirmed = piercedZone && bearish && reclaimed;
      }
      if (!confirmed) continue;

      const entry = c.close;
      const stopLoss = isUp
        ? pullbackExtreme - a * STOP_ATR_PAD
        : pullbackExtreme + a * STOP_ATR_PAD;
      const stopDist = Math.abs(entry - stopLoss);
      if (stopDist <= 0) continue;
      const target = fibAt(TARGET_FIB);
      const targetDist = Math.abs(target - entry);
      if (targetDist <= 0) continue;
      const riskReward = targetDist / stopDist;
      if (riskReward < 1) continue;

      const depthFib = isUp
        ? (extreme - pullbackExtreme) / range
        : (pullbackExtreme - extreme) / range;

      let confidence = 0.55;
      if (range >= a * IMPULSE_ATR_MULT * 1.4) confidence += 0.1;
      if (depthFib >= 0.55 && depthFib <= 0.65) confidence += 0.1;
      if (riskReward >= 1.8) confidence += 0.1;
      if (confidence > 0.9) confidence = 0.9;

      const impulseBars = isUp ? highIdx - lowIdx : lowIdx - highIdx;
      const rationale = [
        isUp
          ? `Impulse up: ${swingLow.toFixed(4)} → ${swingHigh.toFixed(4)} (${(range / a).toFixed(1)}× ATR over ${impulseBars} bars).`
          : `Impulse down: ${swingHigh.toFixed(4)} → ${swingLow.toFixed(4)} (${(range / a).toFixed(1)}× ATR over ${impulseBars} bars).`,
        `Pullback tagged ${(depthFib * 100).toFixed(0)}% retrace — pierced the 0.5 fib (${fib05.toFixed(4)}) into the 0.5-0.618 zone without breaking 0.786 (${fibInval.toFixed(4)}).`,
        isUp
          ? `Confirmation candle: bullish close ${entry.toFixed(4)} reclaims the 0.5 fib — long the impulse continuation toward ${target.toFixed(4)}.`
          : `Confirmation candle: bearish close ${entry.toFixed(4)} rejects the 0.5 fib — short the impulse continuation toward ${target.toFixed(4)}.`,
      ];

      return {
        strategyId: "FIB_PULLBACK",
        symbol,
        timeframe,
        direction,
        price: entry,
        trail: fib05,
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
          impulseHigh: Number(swingHigh.toFixed(6)),
          impulseLow: Number(swingLow.toFixed(6)),
          impulseAtr: Number((range / a).toFixed(2)),
          fib05: Number(fib05.toFixed(6)),
          fib0618: Number(fib0618.toFixed(6)),
          fibInvalidate: Number(fibInval.toFixed(6)),
          pullbackFib: Number(depthFib.toFixed(3)),
        },
      };
    }
    return null;
  },
};
