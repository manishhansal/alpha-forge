import { atr, rollingVwap, rsi } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection } from "@/features/scalping/types";

/**
 * VWAP Reversion Scalping
 *
 * Pure mean-reversion to VWAP. Fires when:
 *   - Price is overextended from VWAP: |close - vwap| ≥ `stretchAtr` × ATR.
 *   - Momentum is weakening: prior bar RSI was more extreme than current
 *     bar's RSI (rolling off the high/low).
 *   - Confirmation: current bar closes against the move (bear close above
 *     VWAP for shorts, bull close below VWAP for longs).
 *
 * Target = VWAP. Stop = 1× ATR beyond entry (in the direction of the
 * overextension). The strategy intentionally avoids trending markets — we
 * rely on RSI rolling over as a momentum filter, which rarely triggers
 * during strong impulses.
 */

const VWAP_WINDOW = 96;
const ATR_PERIOD = 14;
const STRETCH_ATR = 1.5;
const RSI_PERIOD = 14;
const RSI_LONG = 30;
const RSI_SHORT = 70;
const STOP_ATR_MULT = 1.0;

export const vwapReversionStrategy: ScalpStrategyModule = {
  id: "VWAP_REVERSION",
  warmup: Math.max(VWAP_WINDOW, RSI_PERIOD, ATR_PERIOD) + 5,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < vwapReversionStrategy.warmup) return null;

    const closes = candles.map((c) => c.close);
    const vwapSeries = rollingVwap(candles, VWAP_WINDOW);
    const atrSeries = atr(candles, ATR_PERIOD);
    const rsiSeries = rsi(closes, RSI_PERIOD);

    const window = Math.max(1, Math.min(lookback, n - 1));
    for (let i = n - 1; i >= n - window; i -= 1) {
      if (i < 1) continue;
      const c = candles[i];
      const prevRsi = rsiSeries[i - 1];
      const r = rsiSeries[i];
      const vw = vwapSeries[i];
      const a = atrSeries[i];
      if (!Number.isFinite(vw) || !Number.isFinite(a) || a <= 0) continue;

      const dist = (c.close - vw) / a;

      let direction: ScalpDirection | null = null;
      if (
        dist <= -STRETCH_ATR &&
        prevRsi <= RSI_LONG &&
        r > prevRsi &&
        c.close > c.open
      ) {
        direction = "LONG";
      } else if (
        dist >= STRETCH_ATR &&
        prevRsi >= RSI_SHORT &&
        r < prevRsi &&
        c.close < c.open
      ) {
        direction = "SHORT";
      }
      if (!direction) continue;

      const isLong = direction === "LONG";
      const entry = c.close;
      const stopLoss = isLong ? entry - a * STOP_ATR_MULT : entry + a * STOP_ATR_MULT;
      const target = vw;
      const stopDist = Math.abs(entry - stopLoss);
      const targetDist = Math.abs(target - entry);
      if (stopDist <= 0 || targetDist <= 0) continue;
      const riskReward = targetDist / stopDist;
      if (riskReward < 0.8) continue;

      let confidence = 0.55;
      if (Math.abs(dist) >= 2) confidence += 0.1;
      if (Math.abs(r - prevRsi) >= 5) confidence += 0.1;
      if (riskReward >= 1.5) confidence += 0.1;
      if (confidence > 0.9) confidence = 0.9;

      const rationale = [
        `Price ${Math.abs(dist).toFixed(2)}× ATR ${isLong ? "below" : "above"} VWAP (${vw.toFixed(4)}).`,
        `RSI rolling ${isLong ? "up from" : "down from"} ${prevRsi.toFixed(1)} → ${r.toFixed(1)} — momentum weakening.`,
        `Targeting VWAP mean reversion; stop 1× ATR(${ATR_PERIOD}) beyond entry.`,
      ];

      return {
        strategyId: "VWAP_REVERSION",
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
          stretchAtr: Number(dist.toFixed(2)),
          rsi: Number(r.toFixed(2)),
          prevRsi: Number(prevRsi.toFixed(2)),
        },
      };
    }
    return null;
  },
};
