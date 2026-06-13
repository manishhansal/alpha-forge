import type {
  FuturesSymbolView,
  FuturesTickerSummary,
  SentimentBreakdownEntry,
  SentimentLabel,
  SentimentResult,
} from "@/types/market";

export interface SentimentInputs {
  fearGreedValue: number | null;
  futures: FuturesSymbolView[];
  tickers24h: FuturesTickerSummary[];
}

interface ScoreContribution {
  key: string;
  label: string;
  weight: number;
  score: number;
  rawValue: number | null;
  description: string;
  available: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function fearGreedScore(value: number | null): ScoreContribution {
  if (value === null) {
    return {
      key: "fearGreed",
      label: "Fear & Greed",
      weight: 0.15,
      score: 0,
      rawValue: null,
      description: "Unavailable",
      available: false,
    };
  }
  const score = clamp((value - 50) / 50, -1, 1);
  const description =
    value < 25 ? "Extreme Fear" : value < 45 ? "Fear" : value < 55 ? "Neutral" : value < 75 ? "Greed" : "Extreme Greed";
  return {
    key: "fearGreed",
    label: "Fear & Greed",
    weight: 0.15,
    score,
    rawValue: value,
    description: `${description} (${value})`,
    available: true,
  };
}

/**
 * Average 24h price change across the tracked symbols. This is the dominant
 * signal — the previous engine had no direct price input and could happily
 * label a -3% day "bullish" if funding + OI looked rich.
 *
 * Saturation point is ±3% (close to a typical 1-sigma day for BTC), so a
 * broad red tape across BTC/ETH/SOL pushes this contribution toward -1.
 */
function priceActionScore(tickers: FuturesTickerSummary[]): ScoreContribution {
  const changes = tickers.map((t) => t.changePct24h).filter((c) => Number.isFinite(c) && c !== 0);
  if (changes.length === 0) {
    return {
      key: "priceAction",
      label: "Price Action (24h)",
      weight: 0.35,
      score: 0,
      rawValue: null,
      description: "Unavailable",
      available: false,
    };
  }
  const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
  const score = clamp(avg / 3, -1, 1);
  const dir = avg > 0.5 ? "Rallying" : avg < -0.5 ? "Selling off" : "Drifting";
  return {
    key: "priceAction",
    label: "Price Action (24h)",
    weight: 0.35,
    score,
    rawValue: avg,
    description: `${dir} · ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`,
    available: true,
  };
}

function fundingBiasScore(futures: FuturesSymbolView[]): ScoreContribution {
  const rates = futures.map((f) => f.fundingRate).filter((r) => Number.isFinite(r) && r !== 0);
  if (rates.length === 0) {
    return {
      key: "fundingBias",
      label: "Funding Bias",
      weight: 0.15,
      score: 0,
      rawValue: null,
      description: "Unavailable",
      available: false,
    };
  }
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  const annualized = avg * 3 * 365;
  const score = clamp(-avg / 0.0005, -1, 1);
  const dir = avg > 0.0001 ? "Longs paying" : avg < -0.0001 ? "Shorts paying" : "Balanced";
  return {
    key: "fundingBias",
    label: "Funding Bias",
    weight: 0.15,
    score,
    rawValue: avg,
    description: `${dir} · ${(annualized * 100).toFixed(2)}% APR`,
    available: true,
  };
}

/**
 * Price-aware OI flow. Open interest by itself isn't directional — it just
 * measures conviction. Pairing it with the price tape gives the actual signal:
 *
 *   OI ↑ + price ↑ → longs accumulating (bullish)
 *   OI ↑ + price ↓ → shorts piling in   (bearish)
 *   OI ↓ + price ↑ → shorts covering    (mildly bullish)
 *   OI ↓ + price ↓ → long flush         (mildly bearish, but capitulation-ish)
 *
 * Previously this contribution treated all OI builds as bullish, which is why
 * a -3% day with rising OI was scoring at the top of the green bar.
 */
function oiFlowScore(
  futures: FuturesSymbolView[],
  tickers: FuturesTickerSummary[],
): ScoreContribution {
  const changes = futures.map((f) => f.oiChangePct1h).filter((c) => Number.isFinite(c) && c !== 0);
  if (changes.length === 0) {
    return {
      key: "oiFlow",
      label: "OI Flow (1h)",
      weight: 0.2,
      score: 0,
      rawValue: null,
      description: "Unavailable",
      available: false,
    };
  }
  const avgOi = changes.reduce((a, b) => a + b, 0) / changes.length;

  const priceChanges = tickers.map((t) => t.changePct24h).filter((c) => Number.isFinite(c));
  const avgPrice = priceChanges.length
    ? priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length
    : 0;
  const priceSign = avgPrice > 0.1 ? 1 : avgPrice < -0.1 ? -1 : 0;

  // When price is flat we don't know who's adding risk, so dampen the signal
  // instead of swinging it green by default.
  const directional = priceSign === 0 ? avgOi * 0.25 : avgOi * priceSign;
  const score = clamp(directional / 2, -1, 1);

  const building = avgOi > 0.25;
  const unwinding = avgOi < -0.25;
  let dir = "Stable";
  if (building && priceSign > 0) dir = "Longs adding";
  else if (building && priceSign < 0) dir = "Shorts piling in";
  else if (unwinding && priceSign > 0) dir = "Shorts covering";
  else if (unwinding && priceSign < 0) dir = "Long flush";
  else if (building) dir = "Building";
  else if (unwinding) dir = "Unwinding";

  return {
    key: "oiFlow",
    label: "OI Flow (1h)",
    weight: 0.2,
    score,
    rawValue: avgOi,
    description: `${dir} · ${avgOi >= 0 ? "+" : ""}${avgOi.toFixed(2)}%`,
    available: true,
  };
}

function longShortScore(futures: FuturesSymbolView[]): ScoreContribution {
  const ratios = futures.map((f) => f.longShortRatio).filter((r) => Number.isFinite(r) && r > 0);
  if (ratios.length === 0) {
    return {
      key: "longShort",
      label: "Long/Short",
      weight: 0.15,
      score: 0,
      rawValue: null,
      description: "Unavailable",
      available: false,
    };
  }
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const score = clamp(-(avg - 1) / 0.5, -1, 1);
  const dir = avg > 1.1 ? "Crowded long" : avg < 0.9 ? "Crowded short" : "Balanced";
  return {
    key: "longShort",
    label: "Long/Short",
    weight: 0.15,
    score,
    rawValue: avg,
    description: `${dir} · ${avg.toFixed(2)}`,
    available: true,
  };
}

export function computeSentiment(inputs: SentimentInputs): SentimentResult {
  const contributions: ScoreContribution[] = [
    priceActionScore(inputs.tickers24h),
    fearGreedScore(inputs.fearGreedValue),
    fundingBiasScore(inputs.futures),
    oiFlowScore(inputs.futures, inputs.tickers24h),
    longShortScore(inputs.futures),
  ];

  const usedWeight = contributions.filter((c) => c.available).reduce((sum, c) => sum + c.weight, 0);
  const weighted = contributions.reduce((sum, c) => sum + c.weight * c.score, 0);
  const score = usedWeight > 0 ? weighted / usedWeight : 0;

  const label: SentimentLabel = score > 0.15 ? "Bullish" : score < -0.15 ? "Bearish" : "Neutral";
  const confidence = clamp(Math.abs(score) * usedWeight, 0, 1);

  const breakdown: SentimentBreakdownEntry[] = contributions.map((c) => ({
    label: c.label,
    weight: c.weight,
    score: c.score,
    rawValue: c.rawValue,
    description: c.description,
  }));

  return {
    label,
    score,
    confidence,
    generatedAt: Date.now(),
    breakdown,
  };
}
