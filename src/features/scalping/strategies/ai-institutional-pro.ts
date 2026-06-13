import { atr, ema, rollingVwap, rsi, trailingAvg } from "@/features/scalping/helpers";
import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type { ScalpDirection, ScalpTimeframe } from "@/features/scalping/types";
import type { KlineCandle } from "@/types/market";

/**
 * AI Institutional Buy/Sell System [Pro v5] — port of the TradingView Pine
 * indicator of the same name. Where the existing `INSTITUTIONAL_SMC`
 * strategy emits when a 9-component AI score reaches 7 (sweep + BOS focus),
 * this Pro v5 port is structured around the Pine workflow:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  HARD GATES  (must all pass — no signal otherwise)              │
 *   │    1. EMA20 vs EMA50 trend in the trade direction               │
 *   │    2. Higher-timeframe EMA50 alignment                          │
 *   │    3. RSI not pinned in the opposite extreme                    │
 *   │    4. Per-direction cooldown (no rapid-fire same-direction)     │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │  CONFLUENCE SCORE  (8 components, min N to fire)                │
 *   │    • VWAP side                                                  │
 *   │    • BOS — close crosses last confirmed swing extreme           │
 *   │    • Liquidity sweep — SSL (long) / BSL (short) on current bar  │
 *   │    • Fair Value Gap fresh within lookback                       │
 *   │    • Order block — engulfing close vs prior body                │
 *   │    • Volume spike ≥ presetMult × 20-bar avg in trade direction  │
 *   │    • Kill zone (London / New York for crypto, IST-anchored)     │
 *   │    • RSI on the trade side of 50                                │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Risk is sized per the Pine "Mode" presets — the trading-mode dropdown
 * in the indicator becomes a per-timeframe preset here (1m / 5m mirror
 * the Pine Scalping (5m) row; 15m uses Intraday (15m)):
 *
 *   ┌─────────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
 *   │ TF      │ vol× │ minSc│ cool │ TP×  │ SL×  │ rsiOB│ rsiOS│
 *   ├─────────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┤
 *   │ 1m, 5m  │ 1.5  │  6   │  10  │ 2.0  │ 1.0  │  60  │  40  │
 *   │ 15m     │ 1.4  │  6   │   8  │ 2.5  │ 1.0  │  62  │  38  │
 *   └─────────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┘
 *
 * Kill zones use the Crypto schedule from the Pine indicator (IST):
 *   London   12:30 – 14:30  →  07:00 – 09:00 UTC
 *   New York 18:00 – 21:00  →  12:30 – 15:30 UTC
 */

const EMA_FAST = 20;
const EMA_SLOW = 50;
/** HTF EMA50 proxy on the same series — Pine pulls a higher-TF security. */
const EMA_HTF = 200;
const VWAP_WINDOW = 96;
const ATR_PERIOD = 14;
const RSI_PERIOD = 14;
const VOL_LOOKBACK = 20;
const SWING_LEN = 5;
const FVG_LOOKBACK = 6;

interface ModePreset {
  /** Volume must exceed `volMult` × the 20-bar average to count. */
  volMult: number;
  /** Confluence score (out of 8) required to fire. */
  minScore: number;
  /** Bars between same-direction signals (rate limiter). */
  cooldown: number;
  /** Target = entry ± atr × tpMult. */
  tpMult: number;
  /** Stop = entry ∓ atr × slMult. */
  slMult: number;
  /** RSI overbought ceiling for longs (BUY blocked above). */
  rsiOB: number;
  /** RSI oversold floor for shorts (SELL blocked below). */
  rsiOS: number;
  /** Human-readable preset label surfaced in the rationale. */
  label: string;
}

const PRESETS: Record<ScalpTimeframe, ModePreset> = {
  "1m": {
    volMult: 1.5,
    minScore: 6,
    cooldown: 10,
    tpMult: 2.0,
    slMult: 1.0,
    rsiOB: 60,
    rsiOS: 40,
    label: "Scalping (5m)",
  },
  "5m": {
    volMult: 1.5,
    minScore: 6,
    cooldown: 10,
    tpMult: 2.0,
    slMult: 1.0,
    rsiOB: 60,
    rsiOS: 40,
    label: "Scalping (5m)",
  },
  "15m": {
    volMult: 1.4,
    minScore: 6,
    cooldown: 8,
    tpMult: 2.5,
    slMult: 1.0,
    rsiOB: 62,
    rsiOS: 38,
    label: "Intraday (15m)",
  },
};

export const aiInstitutionalProStrategy: ScalpStrategyModule = {
  id: "AI_INSTITUTIONAL_PRO",
  warmup: Math.max(EMA_HTF, VWAP_WINDOW, ATR_PERIOD * 3, SWING_LEN * 4) + 12,
  run({ symbol, timeframe, candles, lookback = 1 }) {
    const n = candles.length;
    if (n < aiInstitutionalProStrategy.warmup) return null;

    const preset = PRESETS[timeframe];
    if (!preset) return null;

    const closes = candles.map((c) => c.close);
    const vols = candles.map((c) => c.volume);
    const emaFast = ema(closes, EMA_FAST);
    const emaSlow = ema(closes, EMA_SLOW);
    const emaHtf = ema(closes, EMA_HTF);
    const vwapSeries = rollingVwap(candles, VWAP_WINDOW);
    const atrSeries = atr(candles, ATR_PERIOD);
    const rsiSeries = rsi(closes, RSI_PERIOD);

    // Pre-compute the most-recent confirmed swing high / low at each bar
    // (Pine semantics: `lastSwingHigh := high[swingLen]` once confirmed).
    const lastSwingHigh = new Array<number>(n).fill(NaN);
    const lastSwingLow = new Array<number>(n).fill(NaN);
    {
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
    }

    // Walk forward enough bars to enforce cooldown faithfully. We scan a
    // window long enough to track `cooldown` historical same-direction
    // fires before the lookback range we actually emit from.
    const lookbackWin = Math.max(1, Math.min(lookback, 6));
    const scanFrom = Math.max(
      aiInstitutionalProStrategy.warmup,
      n - lookbackWin - preset.cooldown * 2,
    );

    let lastBuyBar = -Infinity;
    let lastSellBar = -Infinity;
    let best: {
      bar: number;
      direction: ScalpDirection;
      score: number;
      bullScore: number;
      bearScore: number;
      flags: ReturnType<typeof evaluateBar>;
      a: number;
      vw: number;
      rsiVal: number;
      volRatio: number;
    } | null = null;

    for (let i = scanFrom; i < n; i += 1) {
      const c = candles[i];
      const a = atrSeries[i];
      if (!Number.isFinite(a) || a <= 0) continue;
      const vw = vwapSeries[i];
      if (!Number.isFinite(vw)) continue;
      const avgVol = trailingAvg(vols, i - 1, VOL_LOOKBACK);
      if (avgVol <= 0) continue;

      const flags = evaluateBar({
        candles,
        i,
        vwap: vw,
        emaFast: emaFast[i],
        emaSlow: emaSlow[i],
        emaHtf: emaHtf[i],
        rsiVal: rsiSeries[i],
        avgVol,
        volMult: preset.volMult,
        lastSwingHigh,
        lastSwingLow,
      });

      const volRatio = c.volume / avgVol;

      // 8-component confluence score (mirrors the Pine indicator).
      const bullScore =
        (flags.vwapBull ? 1 : 0) +
        (flags.bullBOS ? 1 : 0) +
        (flags.ssl ? 1 : 0) +
        (flags.bullFVG ? 1 : 0) +
        (flags.bullOB ? 1 : 0) +
        (flags.bullVolume ? 1 : 0) +
        (flags.killZone ? 1 : 0) +
        (flags.rsiVal < 50 ? 1 : 0);

      const bearScore =
        (flags.vwapBear ? 1 : 0) +
        (flags.bearBOS ? 1 : 0) +
        (flags.bsl ? 1 : 0) +
        (flags.bearFVG ? 1 : 0) +
        (flags.bearOB ? 1 : 0) +
        (flags.bearVolume ? 1 : 0) +
        (flags.killZone ? 1 : 0) +
        (flags.rsiVal > 50 ? 1 : 0);

      // Hard gates (Pine `buyGate` / `sellGate`).
      const buyGate =
        flags.bullTrend &&
        flags.htfBull &&
        flags.rsiVal < preset.rsiOB &&
        i - lastBuyBar >= preset.cooldown;
      const sellGate =
        flags.bearTrend &&
        flags.htfBear &&
        flags.rsiVal > preset.rsiOS &&
        i - lastSellBar >= preset.cooldown;

      const buySignal = bullScore >= preset.minScore && buyGate;
      const sellSignal = bearScore >= preset.minScore && sellGate;

      if (buySignal) lastBuyBar = i;
      if (sellSignal) lastSellBar = i;

      // Only emit from the lookback window; earlier bars exist purely to
      // accumulate cooldown / lastSwing state.
      if (i < n - lookbackWin) continue;

      if (buySignal) {
        best = {
          bar: i,
          direction: "LONG",
          score: bullScore,
          bullScore,
          bearScore,
          flags,
          a,
          vw,
          rsiVal: flags.rsiVal,
          volRatio,
        };
      } else if (sellSignal) {
        best = {
          bar: i,
          direction: "SHORT",
          score: bearScore,
          bullScore,
          bearScore,
          flags,
          a,
          vw,
          rsiVal: flags.rsiVal,
          volRatio,
        };
      }
    }

    if (!best) return null;

    const c = candles[best.bar];
    const isLong = best.direction === "LONG";
    const entry = c.close;
    const stopLoss = isLong
      ? entry - best.a * preset.slMult
      : entry + best.a * preset.slMult;
    const target = isLong
      ? entry + best.a * preset.tpMult
      : entry - best.a * preset.tpMult;
    const stopDist = Math.abs(entry - stopLoss);
    const targetDist = Math.abs(target - entry);
    if (stopDist <= 0 || targetDist <= 0) return null;
    const riskReward = targetDist / stopDist;

    // Confidence scales with score over threshold and structural alignment.
    let confidence = 0.55 + (best.score - preset.minScore) * 0.06;
    if (best.flags.killZone) confidence += 0.05;
    if (isLong ? best.flags.htfBull : best.flags.htfBear) confidence += 0.05;
    if (isLong ? best.flags.bullFVG : best.flags.bearFVG) confidence += 0.04;
    if (isLong ? best.flags.bullVolume : best.flags.bearVolume) confidence += 0.04;
    if (riskReward >= 1.8) confidence += 0.04;
    if (confidence > 0.95) confidence = 0.95;

    const fvgPresent = isLong ? best.flags.bullFVG : best.flags.bearFVG;
    const obPresent = isLong ? best.flags.bullOB : best.flags.bearOB;
    const sweepPresent = isLong ? best.flags.ssl : best.flags.bsl;
    const bosPresent = isLong ? best.flags.bullBOS : best.flags.bearBOS;
    const sessionLabel = best.flags.inLondon
      ? "London kill zone"
      : best.flags.inNewYork
        ? "New York kill zone"
        : "off-session";

    const trendSpread =
      ((best.flags.emaFast - best.flags.emaSlow) /
        Math.abs(best.flags.emaSlow || 1)) *
      100;

    const rationale = [
      `Mode preset → ${preset.label}: TP ${preset.tpMult}× ATR, SL ${preset.slMult}× ATR, min score ${preset.minScore}/8, cooldown ${preset.cooldown} bars.`,
      isLong
        ? `Hard gates passed: EMA${EMA_FAST} > EMA${EMA_SLOW} (${trendSpread.toFixed(2)}% spread), HTF EMA${EMA_HTF} bullish, RSI ${best.rsiVal.toFixed(1)} < ${preset.rsiOB}.`
        : `Hard gates passed: EMA${EMA_FAST} < EMA${EMA_SLOW} (${trendSpread.toFixed(2)}% spread), HTF EMA${EMA_HTF} bearish, RSI ${best.rsiVal.toFixed(1)} > ${preset.rsiOS}.`,
      isLong
        ? `Above VWAP ${best.vw.toFixed(4)} — institutional bias up.`
        : `Below VWAP ${best.vw.toFixed(4)} — institutional bias down.`,
      `Confluence ${best.score}/8 — ${[
        sweepPresent ? "liquidity sweep" : null,
        bosPresent ? "BOS" : null,
        fvgPresent ? "FVG" : null,
        obPresent ? "order block" : null,
        (isLong ? best.flags.bullVolume : best.flags.bearVolume)
          ? `volume ${best.volRatio.toFixed(2)}×`
          : null,
        best.flags.killZone ? sessionLabel : null,
      ]
        .filter(Boolean)
        .join(", ") || "no extra confluence"}.`,
      `Risk: TP ${target.toFixed(4)} (${preset.tpMult}× ATR), SL ${stopLoss.toFixed(4)} (${preset.slMult}× ATR) — RR ${riskReward.toFixed(2)}.`,
    ];

    return {
      strategyId: "AI_INSTITUTIONAL_PRO",
      symbol,
      timeframe,
      direction: best.direction,
      price: entry,
      trail: best.vw,
      atr: best.a,
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
        modePreset: preset.label,
        bullScore: best.bullScore,
        bearScore: best.bearScore,
        score: best.score,
        minScore: preset.minScore,
        cooldownBars: preset.cooldown,
        tpAtrMult: preset.tpMult,
        slAtrMult: preset.slMult,
        rsi: Number(best.rsiVal.toFixed(2)),
        vwap: Number(best.vw.toFixed(6)),
        volRatio: Number(best.volRatio.toFixed(2)),
        bos: bosPresent,
        sweep: sweepPresent,
        fvg: fvgPresent,
        orderBlock: obPresent,
        killZone: best.flags.killZone,
        session: sessionLabel,
        htfAligned: isLong ? best.flags.htfBull : best.flags.htfBear,
      },
    };
  },
};

interface BarFlags {
  emaFast: number;
  emaSlow: number;
  emaHtf: number;
  rsiVal: number;
  bullTrend: boolean;
  bearTrend: boolean;
  htfBull: boolean;
  htfBear: boolean;
  vwapBull: boolean;
  vwapBear: boolean;
  bullBOS: boolean;
  bearBOS: boolean;
  ssl: boolean;
  bsl: boolean;
  bullFVG: boolean;
  bearFVG: boolean;
  bullOB: boolean;
  bearOB: boolean;
  bullVolume: boolean;
  bearVolume: boolean;
  killZone: boolean;
  inLondon: boolean;
  inNewYork: boolean;
}

function evaluateBar(args: {
  candles: KlineCandle[];
  i: number;
  vwap: number;
  emaFast: number;
  emaSlow: number;
  emaHtf: number;
  rsiVal: number;
  avgVol: number;
  volMult: number;
  lastSwingHigh: number[];
  lastSwingLow: number[];
}): BarFlags {
  const { candles, i, vwap, emaFast, emaSlow, emaHtf, rsiVal, avgVol, volMult } =
    args;
  const c = candles[i];
  const prev = candles[i - 1];

  const bullTrend = emaFast > emaSlow;
  const bearTrend = emaFast < emaSlow;
  const htfBull = c.close > emaHtf;
  const htfBear = c.close < emaHtf;
  const vwapBull = c.close > vwap;
  const vwapBear = c.close < vwap;

  // BOS — Pine `ta.crossover(close, lastSwingHigh)` semantics.
  const shPrev = args.lastSwingHigh[i - 1];
  const slPrev = args.lastSwingLow[i - 1];
  const bullBOS =
    Number.isFinite(shPrev) && prev.close <= shPrev && c.close > shPrev;
  const bearBOS =
    Number.isFinite(slPrev) && prev.close >= slPrev && c.close < slPrev;

  // Liquidity sweep — Pine: `ssl = low < low[1] and close > low[1]`.
  const ssl = c.low < prev.low && c.close > prev.low;
  const bsl = c.high > prev.high && c.close < prev.high;

  // Fair Value Gap — fresh 3-candle gap within the last FVG_LOOKBACK bars.
  let bullFVG = false;
  let bearFVG = false;
  const fvgStart = Math.max(2, i - FVG_LOOKBACK);
  for (let j = i; j >= fvgStart; j -= 1) {
    if (candles[j].low > candles[j - 2].high) bullFVG = true;
    if (candles[j].high < candles[j - 2].low) bearFVG = true;
    if (bullFVG && bearFVG) break;
  }

  // Order block — Pine: bullish OB when prior bar was bearish and current
  // closes above prior high (engulfing reversal close).
  const bullOB = prev.close < prev.open && c.close > prev.high;
  const bearOB = prev.close > prev.open && c.close < prev.low;

  // Volume spike in the trade direction.
  const volRatio = c.volume / avgVol;
  const bullVolume = volRatio >= volMult && c.close > c.open;
  const bearVolume = volRatio >= volMult && c.close < c.open;

  // Kill zones — crypto schedule from the Pine indicator (IST → UTC).
  const hourUtc = new Date(c.openTime).getUTCHours();
  const minuteUtc = new Date(c.openTime).getUTCMinutes();
  const minutesSinceUtcMidnight = hourUtc * 60 + minuteUtc;
  // London 12:30 – 14:30 IST  →  07:00 – 09:00 UTC
  const inLondon =
    minutesSinceUtcMidnight >= 7 * 60 && minutesSinceUtcMidnight < 9 * 60;
  // New York 18:00 – 21:00 IST  →  12:30 – 15:30 UTC
  const inNewYork =
    minutesSinceUtcMidnight >= 12 * 60 + 30 &&
    minutesSinceUtcMidnight < 15 * 60 + 30;
  const killZone = inLondon || inNewYork;

  return {
    emaFast,
    emaSlow,
    emaHtf,
    rsiVal,
    bullTrend,
    bearTrend,
    htfBull,
    htfBear,
    vwapBull,
    vwapBear,
    bullBOS,
    bearBOS,
    ssl,
    bsl,
    bullFVG,
    bearFVG,
    bullOB,
    bearOB,
    bullVolume,
    bearVolume,
    killZone,
    inLondon,
    inNewYork,
  };
}

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
