import type { IndiaScalpStrategyId } from "@/features/india/scalping/strategies/catalog";

/**
 * India F&O strategy scoring engine.
 *
 * Unlike the crypto scorer — which keys off a 5-year OHLCV backtest — the
 * NSE side has no historical backtest engine yet (that's still on the
 * roadmap). What it DOES have, now that the F&O paper-trader worker ships,
 * is a live paper-trade track record per strategy. So this engine scores
 * each strategy off its accumulated paper-trade journal stats and the UI
 * labels the chip a "paper-trade score" rather than a backtest score.
 *
 * The 0-100 score weighs four dimensions, each normalised to [0, 1]:
 *   1. Win rate     (30%) — closed-trade hit rate.
 *   2. Profit factor (30%) — gross win / gross loss.
 *   3. Expectancy   (25%) — average P&L % per trade.
 *   4. Significance  (15%) — enough closed trades to trust the number.
 *
 * The shape (score / grade / recommendation / rationale) intentionally
 * matches the crypto `StrategyScoreBreakdown` so the picker chip renders
 * identically across markets, but the types live here so the India stack
 * stays self-contained.
 */

export type IndiaStrategyGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export type IndiaStrategyRecommendation =
  | "highly-recommended"
  | "recommended"
  | "use-cautiously"
  | "not-recommended";

/** Where the stats came from — a 5y OHLCV backtest (price strategies) or
 *  the live paper-trade journal (option-chain strategies). */
export type IndiaStrategyScoreSource = "backtest" | "paper-trade";

/** Structural subset of `IndiaStrategyStats` (from journal.ts) needed to
 *  score — kept local so this module stays free of `server-only`. The two
 *  risk fields are optional: when present (backtest equity curve, or the
 *  live journal's closed-trade series) the scorer switches to a richer,
 *  risk-aware weighting; when absent it uses the base 4-component model. */
export interface IndiaStrategyScoreInput {
  strategyId: IndiaScalpStrategyId;
  wins: number;
  losses: number;
  expired: number;
  winRate: number;
  profitFactor: number;
  avgPnlPct: number;
  totalPnlUsd: number;
  /** Peak-to-trough drawdown on the equity curve (0..1, lower = better). */
  maxDrawdownPct?: number;
  /** Annualised Sharpe-like ratio (higher = better). */
  sharpe?: number;
  /** Provenance — defaults to "paper-trade" when omitted. */
  source?: IndiaStrategyScoreSource;
}

export interface IndiaStrategyScore {
  score: number;
  grade: IndiaStrategyGrade;
  recommendation: IndiaStrategyRecommendation;
  recommendationLabel: string;
  rationale: string;
  source: IndiaStrategyScoreSource;
  components: {
    winRate: number;
    profitFactor: number;
    expectancy: number;
    significance: number;
    /** Only contribute when the input carries risk metrics. */
    drawdown: number;
    sharpe: number;
  };
}

/** Base weights — used when no equity-curve risk metrics are available. */
const BASE_WEIGHTS = {
  winRate: 0.3,
  profitFactor: 0.3,
  expectancy: 0.25,
  significance: 0.15,
} as const;

/** Risk-aware weights — used when drawdown + Sharpe are supplied. */
const RISK_WEIGHTS = {
  winRate: 0.25,
  profitFactor: 0.25,
  expectancy: 0.2,
  significance: 0.12,
  drawdown: 0.1,
  sharpe: 0.08,
} as const;

/** Below this many closed trades the sample is too thin to "recommend". */
const MIN_SAMPLE_TO_RECOMMEND = 6;

/**
 * Score a single strategy's paper-trade record. Returns null when the
 * strategy has no closed trades yet (the badge then renders its neutral
 * "pending" placeholder instead of a misleading 0/F).
 */
export function scoreIndiaStrategy(
  stats: IndiaStrategyScoreInput,
): IndiaStrategyScore | null {
  const closed = stats.wins + stats.losses + stats.expired;
  if (closed === 0) return null;

  const hasRiskMetrics =
    typeof stats.maxDrawdownPct === "number" || typeof stats.sharpe === "number";

  const components = {
    // 35% win rate = floor, 65% = full credit (50% is the breakeven line).
    winRate: normalise(stats.winRate, 0.35, 0.65),
    profitFactor: pfNormalised(stats.profitFactor),
    // Average P&L % per trade — intraday F&O: -1% = floor, +1.5% = full.
    expectancy: normalise(stats.avgPnlPct, -1, 1.5),
    // Confidence in the number — 3 closed = floor, 60+ = full credit.
    significance: normalise(closed, 3, 60),
    // Lower drawdown = better; 0% = full credit, 50%+ = none.
    drawdown: 1 - clamp01((stats.maxDrawdownPct ?? 0) / 0.5),
    // Sharpe: -0.5 = floor, 2.0 = full credit.
    sharpe: normalise(stats.sharpe ?? 0, -0.5, 2.0),
  };

  const raw = hasRiskMetrics
    ? components.winRate * RISK_WEIGHTS.winRate +
      components.profitFactor * RISK_WEIGHTS.profitFactor +
      components.expectancy * RISK_WEIGHTS.expectancy +
      components.significance * RISK_WEIGHTS.significance +
      components.drawdown * RISK_WEIGHTS.drawdown +
      components.sharpe * RISK_WEIGHTS.sharpe
    : components.winRate * BASE_WEIGHTS.winRate +
      components.profitFactor * BASE_WEIGHTS.profitFactor +
      components.expectancy * BASE_WEIGHTS.expectancy +
      components.significance * BASE_WEIGHTS.significance;

  const score = Math.round(clamp01(raw) * 100);
  const grade = gradeFor(score);
  const recommendation = recommendationFor(score, stats, closed);
  const source: IndiaStrategyScoreSource = stats.source ?? "paper-trade";

  return {
    score,
    grade,
    recommendation,
    recommendationLabel: recommendationLabel(recommendation),
    rationale: rationaleFor(stats, closed, score, recommendation, source),
    source,
    components,
  };
}

/**
 * Score a list of per-strategy journal stats into a lookup keyed by
 * strategy id. Strategies with no closed trades are omitted.
 */
export function scoreIndiaStrategies(
  perStrategy: ReadonlyArray<IndiaStrategyScoreInput>,
): Partial<Record<IndiaScalpStrategyId, IndiaStrategyScore>> {
  const out: Partial<Record<IndiaScalpStrategyId, IndiaStrategyScore>> = {};
  for (const s of perStrategy) {
    const scored = scoreIndiaStrategy(s);
    if (scored) out[s.strategyId] = scored;
  }
  return out;
}

function gradeFor(score: number): IndiaStrategyGrade {
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  if (score >= 30) return "D";
  return "F";
}

function recommendationFor(
  score: number,
  stats: IndiaStrategyScoreInput,
  closed: number,
): IndiaStrategyRecommendation {
  // Tiny samples can never clear the "recommended" bar, however pretty the
  // win rate looks — a 3-for-3 run isn't an edge.
  if (closed < MIN_SAMPLE_TO_RECOMMEND) {
    return score >= 35 ? "use-cautiously" : "not-recommended";
  }
  if (score >= 75 && stats.totalPnlUsd > 0) return "highly-recommended";
  if (score >= 55 && stats.totalPnlUsd > 0) return "recommended";
  if (score >= 35) return "use-cautiously";
  return "not-recommended";
}

function recommendationLabel(r: IndiaStrategyRecommendation): string {
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
  stats: IndiaStrategyScoreInput,
  closed: number,
  score: number,
  recommendation: IndiaStrategyRecommendation,
  source: IndiaStrategyScoreSource,
): string {
  const sampleLabel = source === "backtest" ? "backtested trades" : "paper trades";
  const pieces = [
    `${(stats.winRate * 100).toFixed(0)}% win rate over ${closed} ${sampleLabel}`,
    `PF ${formatPf(stats.profitFactor)}`,
    `${signedPct(stats.avgPnlPct)} avg/trade`,
  ];
  if (typeof stats.maxDrawdownPct === "number") {
    pieces.push(`${(stats.maxDrawdownPct * 100).toFixed(0)}% max DD`);
  }

  const prefix = source === "backtest" ? "5y backtest: " : "Paper record: ";

  let verdict = "Mixed signal — keep tracking before sizing up.";
  if (recommendation === "highly-recommended") {
    verdict = `Strong edge (score ${score}/100). Worth tracking live.`;
  } else if (recommendation === "recommended") {
    verdict = `Positive expectancy with a usable sample (score ${score}/100).`;
  } else if (recommendation === "use-cautiously") {
    verdict =
      closed < MIN_SAMPLE_TO_RECOMMEND
        ? `Early sample (${closed} trades, score ${score}/100) — let it build.`
        : `Marginal edge (score ${score}/100). Size small.`;
  } else {
    verdict = `No edge in the record yet (score ${score}/100).`;
  }

  return `${prefix}${pieces.join(" · ")}. ${verdict}`;
}

function formatPf(pf: number): string {
  if (!Number.isFinite(pf)) return "∞";
  if (pf === 0) return "—";
  return pf.toFixed(2);
}

function signedPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function normalise(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (max === min) return 0;
  return clamp01((value - min) / (max - min));
}

function pfNormalised(pf: number): number {
  if (!Number.isFinite(pf)) return 1;
  if (pf <= 0) return 0;
  return normalise(pf, 0.6, 3.0);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
