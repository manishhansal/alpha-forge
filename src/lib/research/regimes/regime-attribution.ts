/**
 * Phase 7 — Regime Attribution Engine
 * Phase 8 — Strategy Regime Matrix
 *
 * Every completed trade must be attributed to a market regime.
 * Performance is computed per regime to reveal where each strategy
 * has genuine edge and where it destroys value.
 *
 * Required regimes:
 *   BULL_TRENDING, BEAR_TRENDING, RANGE_BOUND
 *   HIGH_VOLATILITY, LOW_VOLATILITY
 *   HIGH_LIQUIDITY, LOW_LIQUIDITY
 *   EVENT_DRIVEN, EXPIRY_DAY, NORMAL_DAY
 *
 * Regime classification uses the following heuristics for daily attribution:
 *   BULL/BEAR_TRENDING   → ADX > 25 + SMA20 slope direction
 *   RANGE_BOUND          → ADX < 20 + price oscillating within BB
 *   HIGH/LOW_VOLATILITY  → ATR > 1.5× 20-day avg / ATR < 0.7× 20-day avg
 *   HIGH/LOW_LIQUIDITY   → volume > 1.5× avg / < 0.5× avg
 *   EVENT_DRIVEN         → external tag (earnings, RBI/FOMC announcement)
 *   EXPIRY_DAY           → calendar-based (NSE weekly/monthly expiry)
 *   NORMAL_DAY           → none of the above
 */

import type {
  MarketRegime,
  PerRegimeStats,
  RegimeAttribution,
  RegimeMatrixCell,
  StrategyRegimeMatrix,
  PerformancePeriod,
} from "../types";
import { computePerformanceMetrics, type AnalyzerTrade } from "../performance/strategy-performance-analyzer";

// ─── Regime-tagged Trade ──────────────────────────────────────────────────────

export interface RegimeTaggedTrade extends AnalyzerTrade {
  regime: MarketRegime;
  tradeDate: string; // ISO date
}

// ─── Regime Classifier (heuristic) ───────────────────────────────────────────

export interface DailyBar {
  date: string;
  close: number;
  volume: number;
  high: number;
  low: number;
  atr?: number;
  adx?: number;
  sma20?: number;
  sma50?: number;
  isExpiryDay?: boolean;
  isEventDay?: boolean;
}

function sma(values: number[], period: number, i: number): number | null {
  if (i < period - 1) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += values[j];
  return sum / period;
}

/**
 * Classify a single day's market regime based on OHLCV and indicator data.
 * This is the heuristic fallback; the ML regime classifier is authoritative
 * when available.
 */
export function classifyDayRegime(bar: DailyBar, context: {
  avgVolume20: number;
  avgAtr20: number;
  sma20Slope: number; // price change over last 5 days from SMA20
}): MarketRegime {
  if (bar.isExpiryDay) return "EXPIRY_DAY";
  if (bar.isEventDay) return "EVENT_DRIVEN";

  const vol = bar.volume ?? 0;
  const atr = bar.atr ?? 0;
  const adx = bar.adx ?? 15;

  // Volatility regime
  if (atr > context.avgAtr20 * 1.5) return "HIGH_VOLATILITY";
  if (atr < context.avgAtr20 * 0.7) return "LOW_VOLATILITY";

  // Liquidity regime (secondary override)
  if (vol > context.avgVolume20 * 1.5) return "HIGH_LIQUIDITY";
  if (vol < context.avgVolume20 * 0.5) return "LOW_LIQUIDITY";

  // Trend vs range
  if (adx > 25 && context.sma20Slope > 0.002) return "BULL_TRENDING";
  if (adx > 25 && context.sma20Slope < -0.002) return "BEAR_TRENDING";
  if (adx < 20) return "RANGE_BOUND";

  return "NORMAL_DAY";
}

/**
 * Batch-classify a series of daily bars into regimes.
 * Returns a map from date string to MarketRegime.
 */
export function classifyRegimeSeries(bars: DailyBar[]): Map<string, MarketRegime> {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const atrs = bars.map((b) => b.atr ?? 0);
  const result = new Map<string, MarketRegime>();

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // 20-day averages
    const avgVol = i >= 20 ? volumes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20 : volumes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
    const avgAtr = i >= 20 ? atrs.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20 : atrs.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);

    // 5-day SMA20 slope
    const sma20Now = sma(closes, 20, i);
    const sma20Prev = sma(closes, 20, Math.max(0, i - 5));
    const sma20Slope =
      sma20Now && sma20Prev && sma20Prev !== 0
        ? (sma20Now - sma20Prev) / sma20Prev
        : 0;

    result.set(
      bar.date,
      classifyDayRegime(bar, { avgVolume20: avgVol, avgAtr20: avgAtr, sma20Slope }),
    );
  }

  return result;
}

// ─── Regime Attribution Computation ──────────────────────────────────────────

/**
 * Compute per-regime performance statistics for a set of regime-tagged trades.
 */
export function computeRegimeAttribution(
  strategyId: string,
  period: PerformancePeriod,
  trades: RegimeTaggedTrade[],
  annualFactor: number = 252,
  riskFreeRate: number = 0.065,
): RegimeAttribution {
  if (trades.length === 0) {
    return {
      strategyId,
      period,
      regimeStats: [],
      bestRegime: "NORMAL_DAY",
      worstRegime: "NORMAL_DAY",
      regimeFitScore: 0,
      computedAt: new Date().toISOString(),
    };
  }

  // Group trades by regime
  const byRegime = new Map<MarketRegime, RegimeTaggedTrade[]>();
  for (const trade of trades) {
    const existing = byRegime.get(trade.regime) ?? [];
    existing.push(trade);
    byRegime.set(trade.regime, existing);
  }

  const regimeStats: PerRegimeStats[] = [];

  for (const [regime, regimeTrades] of byRegime.entries()) {
    const metrics = computePerformanceMetrics(regimeTrades, period, annualFactor, riskFreeRate);

    // Statistical confidence: t-test p-value inverted (lower p = higher confidence)
    const statConfidence = metrics.pValue < 0.05
      ? 0.95
      : metrics.pValue < 0.10
        ? 0.80
        : metrics.pValue < 0.20
          ? 0.60
          : 0.30;

    regimeStats.push({
      regime,
      tradeCount: regimeTrades.length,
      winRate: metrics.winRate,
      sharpe: metrics.sharpe,
      expectancy: metrics.expectancy,
      profitFactor: metrics.profitFactor,
      maxDrawdown: metrics.maxDrawdown,
      totalReturn: metrics.totalReturn,
      exposureFraction: regimeTrades.length / trades.length,
      statConfidence,
    });
  }

  // Sort by Sharpe descending
  regimeStats.sort((a, b) => b.sharpe - a.sharpe);

  const bestRegime = regimeStats[0]?.regime ?? "NORMAL_DAY";
  const worstRegime = regimeStats[regimeStats.length - 1]?.regime ?? "NORMAL_DAY";

  // Regime fit score: weighted average Sharpe across all regimes, normalised to 0-1
  const totalExposure = regimeStats.reduce((s, r) => s + r.exposureFraction, 0);
  const weightedSharpe = regimeStats.reduce(
    (s, r) => s + r.sharpe * (r.exposureFraction / Math.max(totalExposure, 1)),
    0,
  );
  const regimeFitScore = Math.max(0, Math.min(1, (weightedSharpe + 2) / 4)); // normalise [-2,2] → [0,1]

  return {
    strategyId,
    period,
    regimeStats,
    bestRegime,
    worstRegime,
    regimeFitScore,
    computedAt: new Date().toISOString(),
  };
}

// ─── Strategy × Regime Matrix ─────────────────────────────────────────────────

/**
 * Build the full Strategy × Regime matrix from multiple attribution results.
 */
export function buildStrategyRegimeMatrix(
  attributions: RegimeAttribution[],
): StrategyRegimeMatrix {
  const ALL_REGIMES: MarketRegime[] = [
    "BULL_TRENDING",
    "BEAR_TRENDING",
    "RANGE_BOUND",
    "HIGH_VOLATILITY",
    "LOW_VOLATILITY",
    "HIGH_LIQUIDITY",
    "LOW_LIQUIDITY",
    "EVENT_DRIVEN",
    "EXPIRY_DAY",
    "NORMAL_DAY",
  ];

  const strategies = [...new Set(attributions.map((a) => a.strategyId))];
  const cells: RegimeMatrixCell[] = [];

  for (const attribution of attributions) {
    for (const regime of ALL_REGIMES) {
      const stats = attribution.regimeStats.find((r) => r.regime === regime);
      cells.push({
        strategyId: attribution.strategyId,
        regime,
        sharpe: stats?.sharpe ?? 0,
        profitFactor: stats?.profitFactor ?? 0,
        expectancy: stats?.expectancy ?? 0,
        winRate: stats?.winRate ?? 0,
        maxDrawdown: stats?.maxDrawdown ?? 0,
        tradeCount: stats?.tradeCount ?? 0,
        statConfidence: stats?.statConfidence ?? 0,
      });
    }
  }

  return {
    strategies,
    regimes: ALL_REGIMES,
    cells,
    generatedAt: new Date().toISOString(),
  };
}
