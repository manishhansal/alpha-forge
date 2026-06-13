/**
 * Crypto AI Signals builder.
 *
 * Composes a rich, per-symbol AI signal for BTC / ETH / SOL by fanning out
 * the data sources we already ship — kline indicators, futures aggregate,
 * liquidations, fear & greed, plus the IST best-time engine for the timing
 * window — and folding everything into the shared `aiBuildSignal()` helper.
 *
 * Mark the module `server-only` so the broker registry + Redis cache (both
 * server-only) can be imported without leaking into a client bundle.
 */

import "server-only";

import { CACHE_TTL_SECONDS, TRACKED_SYMBOLS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { computeIndicators } from "@/features/signals/indicators";
import { getFuturesOverview } from "@/features/futures/aggregate";
import { getAllLiquidationBuckets } from "@/features/futures/liquidations";
import { getBestTimeStatus } from "@/features/best-time/engine";
import { fetchFearGreed } from "@/services/altme/fearGreed";
import { getServerBroker } from "@/services/brokers/registry";
import { getBrokerPair } from "@/services/brokers/shared";
import type { ServerBrokerAdapter } from "@/services/brokers/server-types";
import type {
  AiConfluenceFactor,
  AiMarketContext,
  AiMarketRegime,
  AiSignal,
  AiSignalsResponse,
} from "@/types/ai-signals";
import type {
  FuturesSymbolView,
  IndicatorSnapshot,
  KlineCandle,
  SymbolId,
} from "@/types/market";
import {
  AI_MODEL_VERSION,
  buildReasons,
  buildTimingWindow,
  buildTradeLevels,
  calibrateWinProbability,
  classifyAction,
  clamp,
  composeSummary,
  compositeScore,
  derivativeShare,
  directionFromAction,
  gradeFromConfidence,
  HORIZON_PROFILE,
  invalidationLine,
  makeFactor,
  pickHorizon,
  riskLevelFromConfidence,
  roundToTick,
  suggestPositionSizePct,
} from "./engine";

const REDIS_KEY_AI = "ai-signals:crypto:v1";
const CACHE_TTL = CACHE_TTL_SECONDS.signals;

/** Tick sizes used to round the entry/stop/TP levels we publish. */
function tickFor(symbol: SymbolId): number {
  switch (symbol) {
    case "BTC":
      return 1;
    case "ETH":
      return 0.5;
    case "SOL":
      return 0.05;
  }
}

interface SymbolInputs {
  symbol: SymbolId;
  pair: string;
  candles: KlineCandle[];
}

async function loadCandles(broker: ServerBrokerAdapter): Promise<SymbolInputs[]> {
  return Promise.all(
    TRACKED_SYMBOLS.map(async (s) => {
      const pair = broker.pairs.spot[s.id];
      try {
        const candles = await broker.fetchKlines(pair, "1h", 100);
        return { symbol: s.id, pair, candles };
      } catch (err) {
        console.warn(
          `[ai-signals/crypto] kline fetch failed for ${pair}:`,
          (err as Error).message,
        );
        return { symbol: s.id, pair, candles: [] as KlineCandle[] };
      }
    }),
  );
}

interface BuildArgs {
  symbol: SymbolId;
  pair: string;
  price: number;
  indicators: IndicatorSnapshot;
  futures: FuturesSymbolView | null;
  fearGreed: number | null;
  liquidationImbalance: number | null;
  now: number;
  inActiveWindow: boolean;
  windowLabel: string;
}

const DERIVATIVE_FACTOR_IDS = new Set([
  "funding",
  "oi",
  "longShort",
  "liquidations",
]);

/**
 * Build the 9-factor confluence stack used by the crypto AI engine. Each
 * factor uses `makeFactor()` to normalise its raw input into [-1, 1] and
 * publishes a one-line description for the rationale list.
 */
function cryptoFactors(args: BuildArgs): AiConfluenceFactor[] {
  const { indicators, futures, fearGreed, liquidationImbalance } = args;
  const macdRef = Math.max(
    Math.abs(indicators.macdLine ?? 0),
    Math.abs(indicators.macdSignal ?? 0),
    1e-9,
  );
  const emaSeparationPct =
    indicators.ema20 != null && indicators.ema50 != null && indicators.ema50 !== 0
      ? ((indicators.ema20 - indicators.ema50) / indicators.ema50) * 100
      : null;

  return [
    makeFactor({
      id: "rsi",
      category: "technical",
      label: "RSI(14)",
      weight: 0.12,
      raw: indicators.rsi14 != null ? 50 - indicators.rsi14 : null,
      denominator: 25,
      describe: () =>
        indicators.rsi14 == null
          ? "Unavailable"
          : indicators.rsi14 > 70
            ? `Overbought ${indicators.rsi14.toFixed(1)} — fade risk`
            : indicators.rsi14 < 30
              ? `Oversold ${indicators.rsi14.toFixed(1)} — mean-revert long bias`
              : `Neutral ${indicators.rsi14.toFixed(1)}`,
    }),
    makeFactor({
      id: "macd",
      category: "technical",
      label: "MACD histogram",
      weight: 0.12,
      raw: indicators.macdHistogram,
      denominator: macdRef,
      describe: (raw) =>
        raw > 0
          ? `Bullish histogram +${raw.toFixed(3)}`
          : raw < 0
            ? `Bearish histogram ${raw.toFixed(3)}`
            : "Flat histogram",
    }),
    makeFactor({
      id: "ema",
      category: "technical",
      label: "EMA 20/50 spread",
      weight: 0.13,
      raw: emaSeparationPct,
      denominator: 1,
      describe: () => {
        if (emaSeparationPct == null) return "Unavailable";
        const cross = indicators.emaCross;
        return cross === "bull"
          ? `Bull stack · 20 over 50 by ${emaSeparationPct.toFixed(2)}%`
          : cross === "bear"
            ? `Bear stack · 20 under 50 by ${(-emaSeparationPct).toFixed(2)}%`
            : "Flat — no trend";
      },
    }),
    makeFactor({
      id: "volume",
      category: "flow",
      label: "Volume thrust",
      weight: 0.08,
      raw:
        indicators.volumeBreakout != null
          ? indicators.volumeBreakout - 1
          : null,
      denominator: 1.5,
      describe: (raw) =>
        raw >= 0.5
          ? `Breakout volume ${(raw + 1).toFixed(2)}× avg`
          : raw >= 0
            ? `Above-avg volume ${(raw + 1).toFixed(2)}×`
            : `Below-avg volume ${(raw + 1).toFixed(2)}×`,
    }),
    makeFactor({
      id: "funding",
      category: "derivatives",
      label: "Funding rate",
      weight: 0.1,
      raw: futures && futures.fundingRate !== 0 ? futures.fundingRate : null,
      denominator: 0.0005,
      // Crowded longs paying funding = contrarian short (invert).
      invert: true,
      describe: () => {
        if (!futures || futures.fundingRate === 0) return "Unavailable";
        const apr = futures.fundingRateAnnualized * 100;
        if (futures.fundingRate > 0.0001)
          return `Longs paying ${apr.toFixed(2)}% APR — crowded long`;
        if (futures.fundingRate < -0.0001)
          return `Shorts paying ${Math.abs(apr).toFixed(2)}% APR — crowded short`;
        return "Funding balanced";
      },
    }),
    makeFactor({
      id: "oi",
      category: "derivatives",
      label: "OI 1h Δ",
      weight: 0.09,
      raw: futures && futures.oiChangePct1h !== 0 ? futures.oiChangePct1h : null,
      denominator: 2,
      describe: (raw) =>
        raw > 0
          ? `OI building +${raw.toFixed(2)}% / 1h`
          : `OI unwinding ${raw.toFixed(2)}% / 1h`,
    }),
    makeFactor({
      id: "longShort",
      category: "derivatives",
      label: "Long/Short ratio",
      weight: 0.08,
      raw:
        futures && futures.longShortRatio !== 0
          ? futures.longShortRatio - 1
          : null,
      denominator: 0.5,
      invert: true,
      describe: () => {
        if (!futures || futures.longShortRatio === 0) return "Unavailable";
        if (futures.longShortRatio > 1.1)
          return `Crowded long ${futures.longShortRatio.toFixed(2)} — contrarian short`;
        if (futures.longShortRatio < 0.9)
          return `Crowded short ${futures.longShortRatio.toFixed(2)} — contrarian long`;
        return `Balanced ${futures.longShortRatio.toFixed(2)}`;
      },
    }),
    makeFactor({
      id: "liquidations",
      category: "derivatives",
      label: "Liquidation imbalance",
      weight: 0.1,
      raw: liquidationImbalance,
      denominator: 1,
      describe: (raw) =>
        raw > 0.2
          ? `Shorts being liquidated — bullish flush`
          : raw < -0.2
            ? `Longs being liquidated — bearish flush`
            : `Balanced liquidations`,
    }),
    makeFactor({
      id: "fearGreed",
      category: "sentiment",
      label: "Fear & Greed",
      weight: 0.08,
      raw: fearGreed != null ? fearGreed - 50 : null,
      denominator: 50,
      // Extreme greed → contrarian bearish; extreme fear → contrarian bullish.
      invert: true,
      describe: () => {
        if (fearGreed == null) return "Unavailable";
        if (fearGreed < 25) return `Extreme Fear ${fearGreed} — contrarian buy`;
        if (fearGreed < 45) return `Fear ${fearGreed}`;
        if (fearGreed < 55) return `Neutral ${fearGreed}`;
        if (fearGreed < 75) return `Greed ${fearGreed}`;
        return `Extreme Greed ${fearGreed} — contrarian fade`;
      },
    }),
    makeFactor({
      id: "session",
      category: "macro",
      label: "Session quality",
      weight: 0.1,
      raw: args.inActiveWindow ? 1 : -0.4,
      denominator: 1,
      describe: () =>
        args.inActiveWindow
          ? `Inside ${args.windowLabel} — institutional flow active`
          : `Outside ${args.windowLabel} — thin liquidity`,
    }),
  ];
}

function buildCryptoSignal(args: BuildArgs): AiSignal {
  const meta = TRACKED_SYMBOLS.find((s) => s.id === args.symbol)!;
  const factors = cryptoFactors(args);

  const composite = compositeScore(factors);
  const derivShare = derivativeShare(factors, DERIVATIVE_FACTOR_IDS);
  const action = classifyAction(composite.score, derivShare, {
    allowPerps: true,
  });
  const direction = directionFromAction(action);
  const isWait = action === "WAIT";
  const bullish = direction === "BULLISH";

  const horizon = pickHorizon({
    inActiveWindow: args.inActiveWindow,
    derivativeShare: derivShare,
    scoreMagnitude: Math.abs(composite.score),
  });

  // Fall back to a 1.5% ATR if we couldn't compute one from the candles —
  // matches the legacy signal engine and keeps the levels reasonable.
  const atrRaw = args.indicators.atr14 ?? args.price * 0.015;
  const atr = clamp(atrRaw, args.price * 0.003, args.price * 0.08);

  const levels = buildTradeLevels({
    underlyingPrice: args.price,
    atr,
    horizon,
    bullish,
  });

  const tick = tickFor(args.symbol);
  const entry = roundToTick(levels.entry, tick);
  const stopLoss = roundToTick(levels.stopLoss, tick);
  const takeProfits = levels.takeProfits.map((tp) => ({
    ...tp,
    price: roundToTick(tp.price, tick),
  }));
  const entryZone = {
    min: roundToTick(levels.entryZone.min, tick),
    max: roundToTick(levels.entryZone.max, tick),
  };

  const confidenceScore = Math.round(composite.confidence * 100);
  const grade = gradeFromConfidence(composite.confidence);
  const winProbability = calibrateWinProbability(
    Math.abs(composite.score),
    composite.confidence,
  );

  const positionSizingPct = isWait
    ? 0
    : suggestPositionSizePct(entry, stopLoss, horizon, {
        confidence: composite.confidence,
      });

  const alignedRatio =
    composite.bullishCount + composite.bearishCount > 0
      ? Math.max(composite.bullishCount, composite.bearishCount) /
        (composite.bullishCount + composite.bearishCount)
      : 0;
  const riskLevel = riskLevelFromConfidence(composite.confidence, alignedRatio);

  const reasons = buildReasons(factors);

  const timing = buildTimingWindow({
    now: args.now,
    horizon,
    inActiveWindow: args.inActiveWindow,
    windowLabel: args.windowLabel,
  });

  const summary = composeSummary({
    action,
    symbol: args.symbol,
    grade,
    confidenceScore,
    reasons,
    horizon,
  });

  const invalidationCriteria = invalidationLine({
    bullish,
    stopLoss,
    horizon,
  });

  return {
    id: `crypto-${args.symbol}-${args.now}`,
    symbol: args.symbol,
    displayName: meta.name,
    market: "crypto",
    pair: getBrokerPair(args.symbol, "futures"),
    action,
    direction,
    horizon,
    underlyingPrice: args.price,
    entry: isWait ? args.price : entry,
    entryZone: isWait
      ? {
          min: args.price - args.price * 0.001,
          max: args.price + args.price * 0.001,
        }
      : entryZone,
    strike: isWait ? null : entry,
    stopLoss: isWait ? roundToTick(args.price - 1.5 * atr, tick) : stopLoss,
    takeProfits: isWait
      ? [
          { level: 1, price: roundToTick(args.price * 1.005, tick), percent: 0.5, allocation: 0.5 },
          { level: 2, price: roundToTick(args.price * 1.015, tick), percent: 1.5, allocation: 0.3 },
          { level: 3, price: roundToTick(args.price * 1.03, tick), percent: 3.0, allocation: 0.2 },
        ]
      : takeProfits,
    riskReward: isWait ? 0 : levels.riskReward,
    riskRewardBlended: isWait ? 0 : levels.riskRewardBlended,
    expectedMovePct: isWait ? 0 : levels.expectedMovePct,
    positionSizingPct,
    riskLevel: isWait ? "high" : riskLevel,
    confidence: composite.confidence,
    confidenceScore,
    grade,
    winProbability,
    timing,
    confluences: factors,
    bullishCount: composite.bullishCount,
    bearishCount: composite.bearishCount,
    reasons,
    invalidationCriteria,
    modelVersion: AI_MODEL_VERSION,
    summary,
  };
}

/**
 * Compose the per-market context (regime + headline + bullets) shown above
 * the signals grid. Lightweight aggregation — no extra fetches.
 */
function buildContext(args: {
  futures: FuturesSymbolView[];
  fearGreed: number | null;
  inActiveWindow: boolean;
  windowLabel: string;
}): AiMarketContext {
  const avgFunding =
    args.futures.length > 0
      ? args.futures.reduce((s, f) => s + f.fundingRate, 0) / args.futures.length
      : 0;
  const avgOi =
    args.futures.length > 0
      ? args.futures.reduce((s, f) => s + f.oiChangePct1h, 0) /
        args.futures.length
      : 0;

  let regimeScore = 0;
  if (args.fearGreed != null) regimeScore += (args.fearGreed - 50) / 50;
  regimeScore += clamp(avgOi / 3, -1, 1) * 0.5;
  regimeScore -= clamp(avgFunding / 0.0005, -1, 1) * 0.3;
  regimeScore = clamp(regimeScore, -1, 1);

  let regime: AiMarketRegime;
  if (regimeScore > 0.4) regime = "risk-on";
  else if (regimeScore < -0.4) regime = "risk-off";
  else if (Math.abs(regimeScore) < 0.15) regime = "compressed";
  else regime = "mixed";

  const bullets: string[] = [];
  if (args.fearGreed != null) {
    bullets.push(
      `Fear & Greed ${args.fearGreed} (${
        args.fearGreed >= 60 ? "Greed" : args.fearGreed <= 40 ? "Fear" : "Neutral"
      })`,
    );
  }
  bullets.push(
    `Avg funding ${(avgFunding * 100).toFixed(3)}% · OI 1h ${avgOi.toFixed(2)}%`,
  );
  bullets.push(
    args.inActiveWindow
      ? `Inside ${args.windowLabel} — execute setups now`
      : `Outside ${args.windowLabel} — sit on hands or scale in slow`,
  );

  const headline =
    regime === "risk-on"
      ? "Risk-on tape — momentum + sentiment skew bullish."
      : regime === "risk-off"
        ? "Risk-off tape — defensive, fade rips, tighter stops."
        : regime === "compressed"
          ? "Compressed range — expansion likely; pre-position lightly."
          : "Mixed regime — pick spots, no broad theme yet.";

  return {
    market: "crypto",
    regime,
    regimeScore,
    headline,
    bullets,
    inActiveWindow: args.inActiveWindow,
    windowLabel: args.windowLabel,
    dataFreshness: "live",
  };
}

export async function getCryptoAiSignals(): Promise<AiSignalsResponse> {
  return cached(REDIS_KEY_AI, CACHE_TTL, async () => {
    const broker = getServerBroker();
    const [klineResults, futuresRes, fgRes, liqRes] = await Promise.allSettled([
      loadCandles(broker),
      getFuturesOverview(),
      fetchFearGreed(1),
      getAllLiquidationBuckets(),
    ]);

    const perSymbolCandles =
      klineResults.status === "fulfilled" ? klineResults.value : [];
    const futuresList =
      futuresRes.status === "fulfilled" ? futuresRes.value.symbols : [];
    const futuresMap = new Map<SymbolId, FuturesSymbolView>();
    for (const f of futuresList) futuresMap.set(f.symbol, f);

    const fearGreed =
      fgRes.status === "fulfilled" && fgRes.value[0]
        ? fgRes.value[0].value
        : null;
    const liqMap = liqRes.status === "fulfilled" ? liqRes.value : null;

    const status = getBestTimeStatus();
    const inActiveWindow = status.active.slug !== "off" && status.active.slug !== "worst";
    const windowLabel = status.active.label;

    const now = Date.now();

    const signals: AiSignal[] = perSymbolCandles.map((entry) => {
      const indicators = computeIndicators(entry.candles);
      const lastClose =
        entry.candles.at(-1)?.close ??
        futuresMap.get(entry.symbol)?.markPrice ??
        0;
      return buildCryptoSignal({
        symbol: entry.symbol,
        pair: entry.pair,
        price: lastClose,
        indicators,
        futures: futuresMap.get(entry.symbol) ?? null,
        fearGreed,
        liquidationImbalance: liqMap?.[entry.symbol]?.imbalance ?? null,
        now,
        inActiveWindow,
        windowLabel,
      });
    });

    const context = buildContext({
      futures: futuresList,
      fearGreed,
      inActiveWindow,
      windowLabel,
    });

    let bullish = 0;
    let bearish = 0;
    let wait = 0;
    let confSum = 0;
    let topGrade: AiSignal["grade"] | null = null;
    const gradeRank = { S: 5, A: 4, B: 3, C: 2, D: 1 } as const;
    for (const s of signals) {
      if (s.direction === "BULLISH") bullish++;
      else if (s.direction === "BEARISH") bearish++;
      else wait++;
      confSum += s.confidence;
      if (!topGrade || gradeRank[s.grade] > gradeRank[topGrade]) topGrade = s.grade;
    }
    const avgConfidence = signals.length > 0 ? confSum / signals.length : 0;

    return {
      market: "crypto",
      generatedAt: now,
      modelVersion: AI_MODEL_VERSION,
      context,
      signals,
      stats: { bullish, bearish, wait, avgConfidence, topGrade },
    };
  });
}

// Expose the pure builder for unit tests (lets tests inject deterministic
// data without touching the broker / Redis / fear-greed network).
export const __internals = {
  buildCryptoSignal,
  cryptoFactors,
  DERIVATIVE_FACTOR_IDS,
  HORIZON_PROFILE,
};
