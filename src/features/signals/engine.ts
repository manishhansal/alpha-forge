import type {
  FuturesSymbolView,
  IndicatorSnapshot,
  RiskLevel,
  SignalScoreContribution,
  SignalType,
  SymbolId,
  TradingSignal,
} from "@/types/market";

export interface SignalInputs {
  symbol: SymbolId;
  price: number;
  indicators: IndicatorSnapshot;
  futures: FuturesSymbolView | null;
  fearGreed: number | null;
  liquidationImbalance: number | null;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

function rsiContribution(rsi14: number | null): SignalScoreContribution {
  if (rsi14 === null) {
    return {
      key: "rsi",
      label: "RSI(14)",
      weight: 0.15,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const score = clamp((50 - rsi14) / 25, -1, 1);
  const desc = rsi14 > 70
    ? `Overbought (${rsi14.toFixed(1)})`
    : rsi14 < 30
      ? `Oversold (${rsi14.toFixed(1)})`
      : `Neutral (${rsi14.toFixed(1)})`;
  return { key: "rsi", label: "RSI(14)", weight: 0.15, score, description: desc, available: true };
}

function macdContribution(hist: number | null, line: number | null, signal: number | null): SignalScoreContribution {
  if (hist === null || line === null || signal === null) {
    return {
      key: "macd",
      label: "MACD(12,26,9)",
      weight: 0.15,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const ref = Math.max(Math.abs(line), Math.abs(signal), 1e-9);
  const score = clamp(hist / ref, -1, 1);
  const desc = hist > 0
    ? `Bullish histogram +${hist.toFixed(2)}`
    : hist < 0
      ? `Bearish histogram ${hist.toFixed(2)}`
      : "Flat";
  return { key: "macd", label: "MACD(12,26,9)", weight: 0.15, score, description: desc, available: true };
}

function emaContribution(emaCross: "bull" | "bear" | "none", e20: number | null, e50: number | null): SignalScoreContribution {
  if (emaCross === "none" || e20 === null || e50 === null) {
    return {
      key: "ema",
      label: "EMA 20/50",
      weight: 0.15,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const sep = (e20 - e50) / e50;
  const score = clamp(sep * 100, -1, 1);
  const desc = emaCross === "bull"
    ? `Bull cross · 20 above 50 by ${(sep * 100).toFixed(2)}%`
    : `Bear cross · 20 below 50 by ${(sep * 100).toFixed(2)}%`;
  return { key: "ema", label: "EMA 20/50", weight: 0.15, score, description: desc, available: true };
}

function fundingContribution(futures: FuturesSymbolView | null): SignalScoreContribution {
  if (!futures || futures.fundingRate === 0) {
    return {
      key: "funding",
      label: "Funding",
      weight: 0.1,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const r = futures.fundingRate;
  const score = clamp(-r / 0.0005, -1, 1);
  const apr = futures.fundingRateAnnualized * 100;
  const desc = r > 0.0001
    ? `Longs paying · ${apr.toFixed(2)}% APR`
    : r < -0.0001
      ? `Shorts paying · ${apr.toFixed(2)}% APR`
      : "Balanced";
  return { key: "funding", label: "Funding", weight: 0.1, score, description: desc, available: true };
}

function oiContribution(futures: FuturesSymbolView | null): SignalScoreContribution {
  if (!futures || futures.oiChangePct1h === 0) {
    return {
      key: "oi",
      label: "OI Trend (1h)",
      weight: 0.1,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const score = clamp(futures.oiChangePct1h / 2, -1, 1);
  const desc = `${futures.oiChangePct1h > 0 ? "Building" : "Unwinding"} ${futures.oiChangePct1h.toFixed(2)}%`;
  return { key: "oi", label: "OI Trend (1h)", weight: 0.1, score, description: desc, available: true };
}

function volumeContribution(vb: number | null, emaCross: "bull" | "bear" | "none"): SignalScoreContribution {
  if (vb === null) {
    return {
      key: "vol",
      label: "Volume",
      weight: 0.05,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const intensity = clamp((vb - 1) / 1.5, -1, 1);
  const dir = emaCross === "bear" ? -1 : 1;
  const score = intensity * dir;
  const desc = vb >= 1.5
    ? `Breakout ${vb.toFixed(2)}x avg`
    : vb >= 1
      ? `Above avg ${vb.toFixed(2)}x`
      : `Quiet ${vb.toFixed(2)}x`;
  return { key: "vol", label: "Volume", weight: 0.05, score, description: desc, available: true };
}

function liquidationContribution(imbalance: number | null): SignalScoreContribution {
  if (imbalance === null) {
    return {
      key: "liq",
      label: "Liq Imbalance",
      weight: 0.1,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const score = clamp(imbalance, -1, 1);
  const desc =
    imbalance > 0.2
      ? "Shorts being liquidated (bullish)"
      : imbalance < -0.2
        ? "Longs being liquidated (bearish)"
        : "Balanced";
  return { key: "liq", label: "Liq Imbalance", weight: 0.1, score, description: desc, available: true };
}

function fearGreedContribution(value: number | null): SignalScoreContribution {
  if (value === null) {
    return {
      key: "fearGreed",
      label: "Fear & Greed",
      weight: 0.1,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const score = clamp((value - 50) / 50, -1, 1);
  const desc =
    value < 25
      ? `Extreme Fear (${value})`
      : value < 45
        ? `Fear (${value})`
        : value < 55
          ? `Neutral (${value})`
          : value < 75
            ? `Greed (${value})`
            : `Extreme Greed (${value})`;
  return { key: "fearGreed", label: "Fear & Greed", weight: 0.1, score, description: desc, available: true };
}

function lsContribution(futures: FuturesSymbolView | null): SignalScoreContribution {
  if (!futures || futures.longShortRatio === 0) {
    return {
      key: "ls",
      label: "Long/Short",
      weight: 0.1,
      score: 0,
      description: "Unavailable",
      available: false,
    };
  }
  const score = clamp(-(futures.longShortRatio - 1) / 0.5, -1, 1);
  const desc =
    futures.longShortRatio > 1.1
      ? `Crowded long ${futures.longShortRatio.toFixed(2)} (contrarian short)`
      : futures.longShortRatio < 0.9
        ? `Crowded short ${futures.longShortRatio.toFixed(2)} (contrarian long)`
        : `Balanced ${futures.longShortRatio.toFixed(2)}`;
  return { key: "ls", label: "Long/Short", weight: 0.1, score, description: desc, available: true };
}

function classify(score: number, weightedDerivativeShare: number): SignalType {
  if (score >= 0.45) {
    return weightedDerivativeShare > 0.4 ? "LONG" : "BUY";
  }
  if (score <= -0.45) {
    return weightedDerivativeShare > 0.4 ? "SHORT" : "SELL";
  }
  if (score >= 0.2) return "BUY";
  if (score <= -0.2) return "SELL";
  return "HOLD";
}

function riskFor(confidence: number, contributions: SignalScoreContribution[]): RiskLevel {
  const conflicting = contributions.filter((c) => c.available).reduce((acc, c) => {
    return Math.sign(c.score) === 0 ? acc : acc + (c.score > 0 ? 1 : -1);
  }, 0);
  const aligned = Math.abs(conflicting);
  if (confidence >= 0.6 && aligned >= 4) return "low";
  if (confidence >= 0.35) return "medium";
  return "high";
}

function nextId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

export function computeSignal(inputs: SignalInputs): TradingSignal {
  const { indicators, futures, fearGreed, liquidationImbalance, symbol, price } = inputs;

  const contributions: SignalScoreContribution[] = [
    rsiContribution(indicators.rsi14),
    macdContribution(indicators.macdHistogram, indicators.macdLine, indicators.macdSignal),
    emaContribution(indicators.emaCross, indicators.ema20, indicators.ema50),
    fundingContribution(futures),
    oiContribution(futures),
    lsContribution(futures),
    volumeContribution(indicators.volumeBreakout, indicators.emaCross),
    liquidationContribution(liquidationImbalance),
    fearGreedContribution(fearGreed),
  ];

  const usedWeight = contributions.filter((c) => c.available).reduce((s, c) => s + c.weight, 0);
  const weighted = contributions.reduce((s, c) => s + c.weight * c.score, 0);
  const score = usedWeight > 0 ? weighted / usedWeight : 0;
  const confidence = clamp(Math.abs(score) * usedWeight, 0, 1);

  const derivativeKeys = new Set(["funding", "oi", "ls", "liq"]);
  const derivativeWeight = contributions
    .filter((c) => c.available && derivativeKeys.has(c.key))
    .reduce((s, c) => s + c.weight, 0);
  const derivativeShare = usedWeight > 0 ? derivativeWeight / usedWeight : 0;

  const type = classify(score, derivativeShare);

  const atr14 = indicators.atr14 ?? price * 0.015;
  const stopMult = 1.5;
  const targetMult = 3.0;

  let entry = price;
  let stopLoss = price;
  let target = price;
  if (type === "LONG" || type === "BUY") {
    stopLoss = price - stopMult * atr14;
    target = price + targetMult * atr14;
  } else if (type === "SHORT" || type === "SELL") {
    stopLoss = price + stopMult * atr14;
    target = price - targetMult * atr14;
  } else {
    entry = price;
    stopLoss = price - stopMult * atr14;
    target = price + targetMult * atr14;
  }

  const stopDist = Math.abs(entry - stopLoss);
  const targetDist = Math.abs(target - entry);
  const riskReward = stopDist > 0 ? targetDist / stopDist : 0;

  const risk = riskFor(confidence, contributions);

  const rationale = contributions
    .filter((c) => c.available && Math.abs(c.score) >= 0.05)
    .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
    .slice(0, 6)
    .map((c) => `${c.label}: ${c.description}`);

  return {
    id: nextId(),
    symbol,
    type,
    confidence,
    risk,
    entry,
    stopLoss,
    target,
    riskReward,
    rationale,
    generatedAt: Date.now(),
    features: {
      rsi: indicators.rsi14 ?? undefined,
      macdHistogram: indicators.macdHistogram ?? undefined,
      emaCross: indicators.emaCross,
      fundingRate: futures?.fundingRate,
      oiChangePct: futures?.oiChangePct1h,
      longShortRatio: futures?.longShortRatio,
      volumeBreakout: indicators.volumeBreakout !== null ? indicators.volumeBreakout >= 1.5 : undefined,
      liquidationImbalance: liquidationImbalance ?? undefined,
      fearGreed: fearGreed ?? undefined,
    },
  };
}
