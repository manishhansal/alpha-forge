import type { ScalpBacktestStats } from "@/features/scalping/backtest";

/**
 * Strategy scoring + recommendation engine.
 *
 * Converts the raw backtest stats into a single 0-100 score that we can put
 * on a chip in the strategy picker. The score weighs five dimensions, each
 * normalised into [0, 1] before being weighted-summed:
 *
 *   1. Win rate                      (25%) — how often the strategy is right.
 *   2. Profit factor                 (20%) — gross win / gross loss.
 *   3. Net return vs buy & hold      (20%) — alpha over the lazy benchmark.
 *   4. Max drawdown                  (15%) — lower = better; capped at 50%.
 *   5. Risk-adjusted (Sharpe)        (10%) — annualised Sharpe ratio.
 *   6. Statistical significance      (10%) — prefer strategies with enough
 *                                            trades to be meaningful (≥30).
 *
 * The aggregate score is then mapped to a letter grade A+ / A / B / C / D / F
 * and a plain-English recommendation that the UI surfaces next to the
 * strategy.
 */

export type StrategyGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export type StrategyRecommendation =
  | "highly-recommended"
  | "recommended"
  | "use-cautiously"
  | "not-recommended";

export interface StrategyScoreBreakdown {
  /** Final 0..100 score. */
  score: number;
  grade: StrategyGrade;
  recommendation: StrategyRecommendation;
  /** Plain-English label for the recommendation. */
  recommendationLabel: string;
  /** Short rationale rendered alongside the score. */
  rationale: string;
  /** Per-component normalised contributions (0..1). */
  components: {
    winRate: number;
    profitFactor: number;
    netReturn: number;
    drawdown: number;
    sharpe: number;
    significance: number;
  };
}

const WEIGHTS = {
  winRate: 0.25,
  profitFactor: 0.2,
  netReturn: 0.2,
  drawdown: 0.15,
  sharpe: 0.1,
  significance: 0.1,
} as const;

/**
 * Compute the strategy score from a single backtest stats payload (typically
 * the aggregated cross-symbol stats). Strategies with zero trades are graded
 * "F" with the `not-recommended` recommendation.
 */
export function scoreStrategy(stats: ScalpBacktestStats): StrategyScoreBreakdown {
  if (stats.totalTrades === 0) {
    return {
      score: 0,
      grade: "F",
      recommendation: "not-recommended",
      recommendationLabel: "Not recommended",
      rationale: "Strategy never fired across the 5-year window.",
      components: {
        winRate: 0,
        profitFactor: 0,
        netReturn: 0,
        drawdown: 0,
        sharpe: 0,
        significance: 0,
      },
    };
  }

  const components = {
    // Win rate in [0, 1]; 50%+ is the breakeven baseline so anchor a "good"
    // win rate at 55% and a "great" one at 65%.
    winRate: normalise(stats.winRate, 0.35, 0.65),
    // Profit factor: 1 = breakeven, 2 = excellent. Cap at 3 so a single
    // outlier doesn't swamp the score.
    profitFactor: pfNormalised(stats.profitFactor),
    // Strategy must beat buy & hold to clear the bar. Difference in % points,
    // normalised so +40pp ≈ full credit.
    netReturn: normalise(stats.totalReturnPct - stats.buyHoldReturnPct, -50, 40),
    // Drawdown — lower is better. 0% drawdown = 1.0; 50%+ drawdown = 0.
    drawdown: 1 - clamp01(stats.maxDrawdownPct / 0.5),
    // Sharpe: 0 = neutral, 1.5 = good, 2+ = excellent.
    sharpe: normalise(stats.sharpe, -0.5, 2.0),
    // Significance: need ≥30 trades to feel like the result wasn't pure
    // chance. Above 120 trades = full credit.
    significance: normalise(stats.totalTrades, 5, 120),
  };

  const raw =
    components.winRate * WEIGHTS.winRate +
    components.profitFactor * WEIGHTS.profitFactor +
    components.netReturn * WEIGHTS.netReturn +
    components.drawdown * WEIGHTS.drawdown +
    components.sharpe * WEIGHTS.sharpe +
    components.significance * WEIGHTS.significance;

  const score = Math.round(clamp01(raw) * 100);
  const grade = gradeFor(score);
  const recommendation = recommendationFor(score, stats);

  return {
    score,
    grade,
    recommendation,
    recommendationLabel: recommendationLabel(recommendation),
    rationale: rationaleFor(stats, score, recommendation),
    components,
  };
}

function gradeFor(score: number): StrategyGrade {
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  if (score >= 30) return "D";
  return "F";
}

function recommendationFor(
  score: number,
  stats: ScalpBacktestStats,
): StrategyRecommendation {
  if (stats.totalTrades < 10) return "not-recommended";
  if (score >= 75 && stats.totalPnlUsd > 0) return "highly-recommended";
  if (score >= 55 && stats.totalPnlUsd > 0) return "recommended";
  if (score >= 35) return "use-cautiously";
  return "not-recommended";
}

function recommendationLabel(r: StrategyRecommendation): string {
  switch (r) {
    case "highly-recommended":
      return "Highly recommended";
    case "recommended":
      return "Recommended";
    case "use-cautiously":
      return "Use with caution";
    case "not-recommended":
      return "Not recommended";
  }
}

function rationaleFor(
  stats: ScalpBacktestStats,
  score: number,
  recommendation: StrategyRecommendation,
): string {
  const pieces: string[] = [];
  pieces.push(`${(stats.winRate * 100).toFixed(0)}% win rate over ${stats.totalTrades} trades`);
  pieces.push(`PF ${formatPf(stats.profitFactor)}`);
  pieces.push(`${signedPct(stats.totalReturnPct)} vs ${signedPct(stats.buyHoldReturnPct)} B&H`);
  pieces.push(`${(stats.maxDrawdownPct * 100).toFixed(0)}% max DD`);

  let verdict = "Mixed signal — verify with paper trading before sizing up.";
  if (recommendation === "highly-recommended") {
    verdict = `Strong edge across the 5-year sample (score ${score}/100). Worth running live.`;
  } else if (recommendation === "recommended") {
    verdict = `Positive expectancy with acceptable risk (score ${score}/100). Good candidate.`;
  } else if (recommendation === "use-cautiously") {
    verdict = `Marginal edge (score ${score}/100). Size small or use only in favourable regimes.`;
  } else if (recommendation === "not-recommended") {
    verdict = `Insufficient edge in the backtest (score ${score}/100). Avoid or rework the rules.`;
  }

  return `${pieces.join(" · ")}. ${verdict}`;
}

function formatPf(pf: number): string {
  if (!Number.isFinite(pf)) return "∞";
  if (pf === 0) return "—";
  return pf.toFixed(2);
}

function signedPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function normalise(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (max === min) return 0;
  return clamp01((value - min) / (max - min));
}

function pfNormalised(pf: number): number {
  if (!Number.isFinite(pf)) return 1;
  if (pf <= 0) return 0;
  // 1.0 PF = 0.35 score, 2.0 = 0.75, 3.0+ = 1.0.
  return normalise(pf, 0.6, 3.0);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Combine per-symbol stats into a single aggregate stats payload that can be
 * fed into `scoreStrategy`. Win rates / PF are weighted by trade count so a
 * symbol with a tiny sample doesn't dominate.
 */
export function aggregateStats(
  perSymbol: ScalpBacktestStats[],
): ScalpBacktestStats | null {
  if (perSymbol.length === 0) return null;
  const totalTrades = perSymbol.reduce((s, r) => s + r.totalTrades, 0);
  if (totalTrades === 0) {
    const first = perSymbol[0];
    return { ...first };
  }

  const wins = perSymbol.reduce((s, r) => s + r.wins, 0);
  const losses = perSymbol.reduce((s, r) => s + r.losses, 0);
  const expired = perSymbol.reduce((s, r) => s + r.expired, 0);
  const startEquity = perSymbol.reduce((s, r) => s + r.startEquity, 0);
  const endEquity = perSymbol.reduce((s, r) => s + r.endEquity, 0);
  const totalPnlUsd = perSymbol.reduce((s, r) => s + r.totalPnlUsd, 0);

  // Approximate aggregate PF from per-symbol means: gross win $ ≈ Σ wins·avgWinPct·notional,
  // gross loss $ ≈ Σ losses·|avgLossPct|·notional. The notional cancels (same
  // across symbols in our runner) so we can drop it for ratio purposes.
  const grossWinScalar = perSymbol.reduce(
    (s, r) => s + r.wins * Math.max(0, r.avgWinPct),
    0,
  );
  const grossLossScalar = perSymbol.reduce(
    (s, r) => s + r.losses * Math.abs(Math.min(0, r.avgLossPct)),
    0,
  );
  const profitFactor =
    grossLossScalar === 0
      ? grossWinScalar > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : grossWinScalar / grossLossScalar;

  const tradeWeighted = (vals: number[], trades: number[]) => {
    let sumW = 0;
    let sum = 0;
    for (let i = 0; i < vals.length; i += 1) {
      if (trades[i] > 0) {
        sum += vals[i] * trades[i];
        sumW += trades[i];
      }
    }
    return sumW > 0 ? sum / sumW : 0;
  };

  const trades = perSymbol.map((r) => r.totalTrades);
  const winsArr = perSymbol.map((r) => r.wins);
  const lossesArr = perSymbol.map((r) => r.losses);

  return {
    strategyId: perSymbol[0].strategyId,
    symbol: perSymbol[0].symbol,
    interval: perSymbol[0].interval,
    startTs: Math.min(...perSymbol.map((r) => r.startTs).filter((v) => v > 0)) || 0,
    endTs: Math.max(...perSymbol.map((r) => r.endTs)),
    startEquity,
    endEquity,
    totalReturnPct: startEquity > 0 ? ((endEquity - startEquity) / startEquity) * 100 : 0,
    buyHoldReturnPct: tradeWeighted(
      perSymbol.map((r) => r.buyHoldReturnPct),
      perSymbol.map(() => 1),
    ),
    totalTrades,
    wins,
    losses,
    expired,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    profitFactor,
    avgWinPct: tradeWeighted(
      perSymbol.map((r) => r.avgWinPct),
      winsArr,
    ),
    avgLossPct: tradeWeighted(
      perSymbol.map((r) => r.avgLossPct),
      lossesArr,
    ),
    largestWinPct: Math.max(...perSymbol.map((r) => r.largestWinPct), 0),
    largestLossPct: Math.min(...perSymbol.map((r) => r.largestLossPct), 0),
    maxDrawdownPct: Math.max(...perSymbol.map((r) => r.maxDrawdownPct)),
    sharpe: tradeWeighted(
      perSymbol.map((r) => r.sharpe),
      trades,
    ),
    avgBarsHeld: tradeWeighted(
      perSymbol.map((r) => r.avgBarsHeld),
      trades,
    ),
    totalPnlUsd,
    barsScanned: perSymbol.reduce((s, r) => s + r.barsScanned, 0),
  };
}
