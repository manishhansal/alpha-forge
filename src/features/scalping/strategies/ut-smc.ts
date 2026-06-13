import { smcStructure, utBot } from "@/features/scalping/indicators";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";

/**
 * UT Bot ATR trailing-stop + SMC structure filter — the original LuxAlgo
 * port. Sensitivity `a = 1`, ATR period `c = 10`, SMC pivot length `5`.
 */
const UT_KEY = 1;
const ATR_PERIOD = 10;
const SMC_PIVOT = 5;
const STOP_ATR_MULT = 1.0;
const TARGET_ATR_MULT = 2.0;

export const utSmcStrategy: ScalpStrategyModule = {
  id: "UT_SMC",
  warmup: ATR_PERIOD + SMC_PIVOT * 2 + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < utSmcStrategy.warmup) return null;

    const ut = utBot(candles, UT_KEY, ATR_PERIOD);
    const smc = smcStructure(candles, SMC_PIVOT);
    const window = Math.max(1, Math.min(lookback, n - 1));

    for (let i = n - 1; i >= n - window; i -= 1) {
      let direction: ScalpDirection | null = null;
      if (ut.buy[i]) direction = "LONG";
      else if (ut.sell[i]) direction = "SHORT";
      if (!direction) continue;

      const bias = smc.bias[i];
      const aligned =
        (direction === "LONG" && bias === 1) ||
        (direction === "SHORT" && bias === -1);

      const candle = candles[i];
      const price = candle.close;
      const trail = ut.trail[i];
      const atr = Number.isFinite(trail) ? Math.abs(price - trail) : 0;
      if (!Number.isFinite(atr) || atr <= 0) continue;

      const isLong = direction === "LONG";
      const stopDist = atr * STOP_ATR_MULT;
      const targetDist = atr * TARGET_ATR_MULT;
      const stopLoss = isLong ? price - stopDist : price + stopDist;
      const target = isLong ? price + targetDist : price - targetDist;
      const riskReward = stopDist > 0 ? targetDist / stopDist : 0;

      const rationale: string[] = [
        isLong
          ? `UT Bot flipped long — close ${price.toFixed(4)} crossed trail ${trail.toFixed(4)}.`
          : `UT Bot flipped short — close ${price.toFixed(4)} crossed trail ${trail.toFixed(4)}.`,
      ];
      if (aligned) {
        rationale.push(`SMC structure agrees: bias ${bias === 1 ? "bullish" : "bearish"}.`);
      } else if (bias === 0) {
        rationale.push("SMC structure neutral — no recent BOS/CHoCH.");
      } else {
        rationale.push(
          `SMC bias ${bias === 1 ? "bullish" : "bearish"} disagrees — trade with reduced size.`,
        );
      }
      if (smc.event[i]) {
        const friendly = smc.event[i]!.replace("_", " ").toLowerCase();
        rationale.push(`Fresh ${friendly} event on this bar.`);
      }

      let confidence = 0.55;
      if (aligned) confidence += 0.25;
      if (
        (direction === "LONG" &&
          (smc.event[i] === "BOS_BULL" || smc.event[i] === "CHOCH_BULL")) ||
        (direction === "SHORT" &&
          (smc.event[i] === "BOS_BEAR" || smc.event[i] === "CHOCH_BEAR"))
      ) {
        confidence += 0.1;
      }
      if (riskReward >= 2) confidence += 0.05;
      if (confidence > 0.95) confidence = 0.95;

      return {
        strategyId: "UT_SMC",
        symbol,
        timeframe,
        direction,
        price,
        trail,
        atr,
        smcBias: bias,
        confirmed: aligned,
        entry: price,
        stopLoss,
        target,
        riskReward,
        confidence,
        rationale,
        triggeredAt: candle.closeTime,
        extras: {
          utKey: UT_KEY,
          atrPeriod: ATR_PERIOD,
          smcEvent: smc.event[i] ?? null,
        },
      };
    }
    return null;
  },
};
