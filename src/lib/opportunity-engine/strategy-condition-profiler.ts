/**
 * StrategyConditionProfiler + StrategyWeightEngine + Champion/Challenger
 *
 * StrategyConditionProfiler:
 *   For each strategy, find the conditional subsets where edge is strongest.
 *   Example: VOLUME_BREAKOUT works best when:
 *     - Bull/Bear regime (not range)
 *     - RVOL > 1.5×
 *     - Sector supports direction
 *     - ATR percentile 40-70 (normal volatility)
 *   The profiler learns WHEN to trade the strategy, not just which strategy.
 *
 * StrategyWeightEngine:
 *   Computes dynamic allocation weights based on:
 *   - Recent OOS performance (rolling 20/50 trade windows)
 *   - Regime-specific performance
 *   - Sample size awareness
 *   - Drawdown
 *   - Calibration quality
 *   Uses slow adaptation to prevent one-period chasing.
 *
 * Champion/Challenger:
 *   Every live strategy has a CHAMPION (protected baseline) and optionally
 *   a CHALLENGER (new configuration being tested). Challenger must
 *   beat Champion in OOS before promotion. Challenger NEVER replaces
 *   Champion based on in-sample performance alone.
 *
 * This module is I/O-free.
 */

import type { MarketRegimeState, QualityTier } from "./types";

// ─── Conditional Performance Profile ─────────────────────────────────────────

export interface ConditionDimension {
  name: string;
  type: "CATEGORICAL" | "CONTINUOUS";
  values?: string[];         // for categorical
  low?: number;              // for continuous (below this = "LOW")
  high?: number;             // for continuous (above this = "HIGH")
}

export interface ConditionalPerformance {
  condition: string;         // e.g. "regime=STRONG_BULL_TREND"
  dimensionName: string;
  dimensionValue: string;
  sampleSize: number;
  winRate: number;
  expectancy: number;        // avg % P&L
  profitFactor: number;
  avgR: number;
  recommendation: "TRADE_NORMALLY" | "INCREASE_SIZE" | "REDUCE_SIZE" | "AVOID";
  edgeMultiplier: number;    // relative to overall strategy expectancy
  reliable: boolean;         // sampleSize >= 30
}

export interface StrategyConditionProfile {
  strategyId: string;
  computedAt: number;
  totalTrades: number;
  overallWinRate: number;
  overallExpectancy: number;
  overallProfitFactor: number;

  /** Best conditions (top 3 by edge multiplier) */
  bestConditions: ConditionalPerformance[];
  /** Worst conditions (bottom 3 by edge multiplier — should avoid) */
  worstConditions: ConditionalPerformance[];

  /** All conditional breakdowns */
  allConditions: ConditionalPerformance[];

  /** Summary: WHEN to trade this strategy */
  whenToTrade: string;
  /** Summary: WHEN to avoid */
  whenToAvoid: string;
}

// ─── Trade Record for Profiling ───────────────────────────────────────────────

export interface ProfileTrade {
  strategyId: string;
  regime: MarketRegimeState;
  qualityTier: QualityTier;
  rvol: number | null;
  sectorSupported: boolean;
  timeOfDay: string;
  atrPercentile: number | null;
  mlScoreAboveMedian: boolean;
  won: boolean;
  pnlPct: number;
}

// ─── Condition Profiler ───────────────────────────────────────────────────────

function computeConditionStats(
  trades: ProfileTrade[],
  allTrades: ProfileTrade[],
  dimensionName: string,
  dimensionValue: string,
): ConditionalPerformance {
  const overall = allTrades.length > 0 ? {
    winRate: allTrades.filter(t => t.won).length / allTrades.length,
    expectancy: allTrades.reduce((s, t) => s + t.pnlPct, 0) / allTrades.length,
  } : { winRate: 0.5, expectancy: 0 };

  const wins = trades.filter(t => t.won).length;
  const losses = trades.length - wins;
  const winPnls = trades.filter(t => t.won).map(t => t.pnlPct);
  const lossPnls = trades.filter(t => !t.won).map(t => Math.abs(t.pnlPct));
  const avgWin = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length > 0 ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;

  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const expectancy = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
  const profitFactor = avgLoss > 0 && wins > 0 ? (avgWin * wins) / (avgLoss * losses) : 0;
  const avgR = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;

  const edgeMultiplier = overall.expectancy !== 0
    ? expectancy / Math.abs(overall.expectancy)
    : expectancy > 0 ? 1.5 : 0.5;

  let recommendation: ConditionalPerformance["recommendation"] = "TRADE_NORMALLY";
  if (edgeMultiplier >= 1.4) recommendation = "INCREASE_SIZE";
  else if (edgeMultiplier <= 0.6) recommendation = "REDUCE_SIZE";
  else if (expectancy < 0) recommendation = "AVOID";

  return {
    condition: `${dimensionName}=${dimensionValue}`,
    dimensionName, dimensionValue, sampleSize: trades.length,
    winRate, expectancy, profitFactor, avgR, recommendation, edgeMultiplier,
    reliable: trades.length >= 20,
  };
}

/**
 * Build a conditional performance profile for a strategy.
 * Analyzes performance across regime, quality tier, time-of-day, etc.
 */
export function buildStrategyConditionProfile(
  strategyId: string,
  trades: ProfileTrade[],
): StrategyConditionProfile {
  if (trades.length === 0) {
    return {
      strategyId, computedAt: Date.now(), totalTrades: 0,
      overallWinRate: 0, overallExpectancy: 0, overallProfitFactor: 0,
      bestConditions: [], worstConditions: [], allConditions: [],
      whenToTrade: "Insufficient data", whenToAvoid: "Insufficient data",
    };
  }

  const allConditions: ConditionalPerformance[] = [];

  // ── By regime ────────────────────────────────────────────────────────────
  const regimes: MarketRegimeState[] = [
    "STRONG_BULL_TREND", "WEAK_BULL", "RANGE", "HIGH_VOLATILITY_RANGE",
    "STRONG_BEAR_TREND", "WEAK_BEAR", "PANIC", "TRANSITION",
  ];
  for (const regime of regimes) {
    const inRegime = trades.filter(t => t.regime === regime);
    if (inRegime.length >= 5) {
      allConditions.push(computeConditionStats(inRegime, trades, "regime", regime));
    }
  }

  // ── By quality tier ───────────────────────────────────────────────────────
  const tiers: QualityTier[] = ["A_PLUS", "A", "B", "C", "D"];
  for (const tier of tiers) {
    const inTier = trades.filter(t => t.qualityTier === tier);
    if (inTier.length >= 5) {
      allConditions.push(computeConditionStats(inTier, trades, "qualityTier", tier));
    }
  }

  // ── By sector support ─────────────────────────────────────────────────────
  const sectorSupported = trades.filter(t => t.sectorSupported);
  const sectorNotSupported = trades.filter(t => !t.sectorSupported);
  if (sectorSupported.length >= 5) {
    allConditions.push(computeConditionStats(sectorSupported, trades, "sectorSupported", "true"));
  }
  if (sectorNotSupported.length >= 5) {
    allConditions.push(computeConditionStats(sectorNotSupported, trades, "sectorSupported", "false"));
  }

  // ── By RVOL ───────────────────────────────────────────────────────────────
  const highRvol = trades.filter(t => t.rvol !== null && t.rvol >= 1.5);
  const lowRvol = trades.filter(t => t.rvol !== null && t.rvol < 1.0);
  if (highRvol.length >= 5) {
    allConditions.push(computeConditionStats(highRvol, trades, "rvol", "HIGH(≥1.5x)"));
  }
  if (lowRvol.length >= 5) {
    allConditions.push(computeConditionStats(lowRvol, trades, "rvol", "LOW(<1.0x)"));
  }

  // ── By time of day ────────────────────────────────────────────────────────
  const morning = trades.filter(t => t.timeOfDay.startsWith("09:") || t.timeOfDay.startsWith("10:"));
  const midday = trades.filter(t => t.timeOfDay.startsWith("12:") || t.timeOfDay.startsWith("13:"));
  const afternoon = trades.filter(t => t.timeOfDay.startsWith("14:") || t.timeOfDay.startsWith("15:"));
  if (morning.length >= 5) allConditions.push(computeConditionStats(morning, trades, "timeOfDay", "MORNING"));
  if (midday.length >= 5) allConditions.push(computeConditionStats(midday, trades, "timeOfDay", "MIDDAY"));
  if (afternoon.length >= 5) allConditions.push(computeConditionStats(afternoon, trades, "timeOfDay", "AFTERNOON"));

  // ── By ML score ───────────────────────────────────────────────────────────
  const mlHigh = trades.filter(t => t.mlScoreAboveMedian);
  const mlLow = trades.filter(t => !t.mlScoreAboveMedian);
  if (mlHigh.length >= 5) allConditions.push(computeConditionStats(mlHigh, trades, "mlScore", "ABOVE_MEDIAN"));
  if (mlLow.length >= 5) allConditions.push(computeConditionStats(mlLow, trades, "mlScore", "BELOW_MEDIAN"));

  // Sort and extract best/worst
  const reliable = allConditions.filter(c => c.reliable);
  const sorted = [...reliable].sort((a, b) => b.edgeMultiplier - a.edgeMultiplier);
  const bestConditions = sorted.slice(0, 3);
  const worstConditions = sorted.slice(-3).reverse();

  const wins = trades.filter(t => t.won).length;
  const overallWinRate = wins / trades.length;
  const overallExpectancy = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const winPnls = trades.filter(t => t.won).map(t => t.pnlPct);
  const lossPnls = trades.filter(t => !t.won).map(t => Math.abs(t.pnlPct));
  const avgWin = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length > 0 ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0.01;
  const overallProfitFactor = (avgWin * wins) / (avgLoss * (trades.length - wins) || 1);

  const whenToTrade = bestConditions.map(c => `${c.condition} (${c.edgeMultiplier.toFixed(1)}× edge)`).join("; ");
  const whenToAvoid = worstConditions.filter(c => c.recommendation === "AVOID" || c.edgeMultiplier < 0.6)
    .map(c => c.condition).join("; ") || "No clear avoid conditions yet";

  return {
    strategyId, computedAt: Date.now(), totalTrades: trades.length,
    overallWinRate, overallExpectancy, overallProfitFactor,
    bestConditions, worstConditions, allConditions,
    whenToTrade: whenToTrade || "Insufficient data",
    whenToAvoid,
  };
}

// ─── Strategy Weight Engine ───────────────────────────────────────────────────

export interface StrategyWeightInput {
  strategyId: string;
  recentTrades: { won: boolean; pnlPct: number; regime: MarketRegimeState }[];
  currentRegime: MarketRegimeState;
  sampleSize: number;
  calibrationEce: number | null;   // [0, 1], lower = better
  drawdownPct: number;
  baseWeight: number;              // initial allocation weight
}

export interface StrategyWeightResult {
  strategyId: string;
  finalWeight: number;
  recentPerformanceMultiplier: number;
  regimeMultiplier: number;
  sampleSizeMultiplier: number;
  calibrationMultiplier: number;
  drawdownMultiplier: number;
  reasoning: string[];
}

/**
 * Compute dynamic allocation weight for a strategy.
 * Uses slow adaptation (long lookback windows) to prevent chasing.
 * Never reduces below 20% of base weight.
 */
export function computeStrategyWeight(input: StrategyWeightInput): StrategyWeightResult {
  const reasoning: string[] = [];

  // ── Recent performance (last 20 trades) ──────────────────────────────────
  const recent20 = input.recentTrades.slice(-20);
  let recentPerformanceMultiplier = 1.0;
  if (recent20.length >= 10) {
    const recentWins = recent20.filter(t => t.won).length;
    const recentWr = recentWins / recent20.length;
    const recentExp = recent20.reduce((s, t) => s + t.pnlPct, 0) / recent20.length;

    if (recentWr > 0.60 && recentExp > 1.0) {
      recentPerformanceMultiplier = 1.2;
      reasoning.push(`Recent 20: WR=${(recentWr*100).toFixed(0)}%, Exp=${recentExp.toFixed(1)}% → boost`);
    } else if (recentWr < 0.40 || recentExp < -0.5) {
      recentPerformanceMultiplier = 0.6;
      reasoning.push(`Recent 20: WR=${(recentWr*100).toFixed(0)}%, Exp=${recentExp.toFixed(1)}% → reduce`);
    }
  }

  // ── Regime performance ────────────────────────────────────────────────────
  const inRegime = input.recentTrades.filter(t => t.regime === input.currentRegime).slice(-10);
  let regimeMultiplier = 1.0;
  if (inRegime.length >= 5) {
    const regimeWr = inRegime.filter(t => t.won).length / inRegime.length;
    const overall = input.recentTrades.filter(t => t.won).length / Math.max(input.recentTrades.length, 1);
    if (regimeWr > overall + 0.10) {
      regimeMultiplier = 1.15;
      reasoning.push(`Regime ${input.currentRegime}: above-average performance`);
    } else if (regimeWr < overall - 0.15) {
      regimeMultiplier = 0.75;
      reasoning.push(`Regime ${input.currentRegime}: below-average performance`);
    }
  }

  // ── Sample size shrinkage ─────────────────────────────────────────────────
  const sampleSizeMultiplier =
    input.sampleSize >= 200 ? 1.0 :
    input.sampleSize >= 100 ? 0.9 :
    input.sampleSize >= 50 ? 0.80 :
    input.sampleSize >= 20 ? 0.65 : 0.50;
  if (sampleSizeMultiplier < 1.0) {
    reasoning.push(`Sample size ${input.sampleSize}: shrinkage ×${sampleSizeMultiplier}`);
  }

  // ── Calibration quality ───────────────────────────────────────────────────
  const calibrationMultiplier = input.calibrationEce === null ? 0.9 :
    input.calibrationEce < 0.05 ? 1.0 :
    input.calibrationEce < 0.10 ? 0.9 :
    input.calibrationEce < 0.15 ? 0.8 : 0.7;

  // ── Drawdown ──────────────────────────────────────────────────────────────
  const drawdownMultiplier =
    input.drawdownPct >= 10 ? 0.5 :
    input.drawdownPct >= 5 ? 0.75 : 1.0;

  const rawWeight = input.baseWeight
    * recentPerformanceMultiplier
    * regimeMultiplier
    * sampleSizeMultiplier
    * calibrationMultiplier
    * drawdownMultiplier;

  // Never reduce below 20% of base weight (protect against complete removal)
  const finalWeight = Math.max(input.baseWeight * 0.20, rawWeight);

  return {
    strategyId: input.strategyId,
    finalWeight,
    recentPerformanceMultiplier,
    regimeMultiplier,
    sampleSizeMultiplier,
    calibrationMultiplier,
    drawdownMultiplier,
    reasoning,
  };
}

// ─── Champion / Challenger Framework ─────────────────────────────────────────

export type ChampionChallengerStatus =
  | "CHAMPION_ONLY"   // No challenger running
  | "CHALLENGER_RUNNING" // Challenger in shadow/paper mode
  | "CHALLENGER_PROMOTED" // Challenger beat Champion
  | "CHALLENGER_REJECTED" // Challenger failed OOS test
  | "CHAMPION_PROTECTED"; // Champion frozen, challenger suspended

export interface ChampionChallengerRecord {
  strategyId: string;
  status: ChampionChallengerStatus;

  champion: {
    configId: string;
    description: string;
    oosWinRate: number;
    oosExpectancy: number;
    oosSharpe: number;
    oosMaxDrawdown: number;
    tradeCount: number;
    frozenAt: number;
  };

  challenger: {
    configId: string;
    description: string;
    currentWinRate: number;
    currentExpectancy: number;
    tradeCount: number;
    startedAt: number;
    minTradesRequired: number;
    minOOSImprovementPct: number; // challenger must beat champion by this % to promote
  } | null;

  lastDecision: "PENDING" | "PROMOTE" | "REJECT" | "CONTINUE";
  lastDecisionAt: number | null;
  lastDecisionReason: string | null;
}

/**
 * Evaluate whether a challenger should be promoted to replace the champion.
 *
 * Rules:
 *   1. Challenger needs minimum trade count
 *   2. Challenger must beat Champion on OOS expectancy by at least minImprovement
 *   3. Challenger must not have significantly worse drawdown
 *   4. Champion is never replaced based on in-sample performance
 */
export function evaluateChampionChallenger(
  record: ChampionChallengerRecord,
): { decision: ChampionChallengerRecord["lastDecision"]; reason: string } {
  if (!record.challenger) {
    return { decision: "CONTINUE", reason: "No challenger running" };
  }

  const { champion, challenger } = record;

  if (challenger.tradeCount < challenger.minTradesRequired) {
    return {
      decision: "CONTINUE",
      reason: `Insufficient trades: ${challenger.tradeCount}/${challenger.minTradesRequired} required`,
    };
  }

  const improvementPct =
    champion.oosExpectancy !== 0
      ? ((challenger.currentExpectancy - champion.oosExpectancy) / Math.abs(champion.oosExpectancy)) * 100
      : challenger.currentExpectancy > 0 ? 100 : -100;

  if (improvementPct >= challenger.minOOSImprovementPct) {
    return {
      decision: "PROMOTE",
      reason: `Challenger outperforms Champion by ${improvementPct.toFixed(1)}% on expectancy (threshold: ${challenger.minOOSImprovementPct}%)`,
    };
  }

  if (challenger.currentExpectancy < champion.oosExpectancy - 0.5) {
    return {
      decision: "REJECT",
      reason: `Challenger significantly underperforms Champion (exp: ${challenger.currentExpectancy.toFixed(2)} vs ${champion.oosExpectancy.toFixed(2)})`,
    };
  }

  return {
    decision: "CONTINUE",
    reason: `Challenger improvement ${improvementPct.toFixed(1)}% below ${challenger.minOOSImprovementPct}% threshold — continue monitoring`,
  };
}
