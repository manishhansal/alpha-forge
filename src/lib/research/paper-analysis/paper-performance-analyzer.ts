/**
 * Phase 23 — Paper Performance Analyzer
 *
 * Paper trading is NOT equivalent to backtesting.
 * This module compares expected backtest performance against actual
 * shadow and paper performance to detect:
 *   - Signal drift (signals less predictive than expected)
 *   - Fill quality degradation
 *   - Slippage creep
 *   - Regime distribution shift (paper happened in different regimes)
 *   - Execution latency issues
 *
 * A material drift between backtest and paper MUST be investigated
 * before promoting to LIVE_CANDIDATE.
 */

import type {
  PerformanceDrift,
  PaperPerformanceComparison,
  PerformanceMetrics,
  MarketRegime,
} from "../types";

// ─── Drift Thresholds ─────────────────────────────────────────────────────────

const MATERIAL_DRIFT_THRESHOLDS: Record<string, number> = {
  sharpe: 0.30,           // >30% relative change
  expectancy: 0.50,       // >50% relative change
  winRate: 0.10,          // absolute change > 10 percentage points
  profitFactor: 0.25,     // >25% relative change
  maxDrawdown: 0.50,      // >50% relative change
};

// ─── Drift Computation ────────────────────────────────────────────────────────

function computeDrift(
  metric: string,
  backtestValue: number,
  actualValue: number,
  relativeThreshold: number,
): PerformanceDrift {
  const driftPct =
    backtestValue !== 0 ? (actualValue - backtestValue) / Math.abs(backtestValue) : 0;
  const materialDrift = Math.abs(driftPct) > relativeThreshold;

  let explanation = "";
  if (materialDrift) {
    const dir = driftPct > 0 ? "higher" : "lower";
    const pct = (Math.abs(driftPct) * 100).toFixed(1);
    explanation = `Paper ${metric} is ${pct}% ${dir} than backtest expectation. Investigate.`;
  } else {
    explanation = `Paper ${metric} within acceptable range of backtest expectation.`;
  }

  return {
    metric,
    backtestValue,
    shadowValue: null,
    paperValue: actualValue,
    driftPct,
    materialDrift,
    explanation,
  };
}

// ─── KL Divergence for Regime Distribution ────────────────────────────────────

/**
 * Compute KL divergence between two regime frequency distributions.
 * High value means the paper trading happened in materially different regimes
 * than the backtest.
 */
function klDivergence(
  p: Record<string, number>,
  q: Record<string, number>,
): number {
  const allKeys = new Set([...Object.keys(p), ...Object.keys(q)]);
  let kl = 0;
  for (const key of allKeys) {
    const pk = (p[key] ?? 0) + 1e-10; // smoothing
    const qk = (q[key] ?? 0) + 1e-10;
    kl += pk * Math.log(pk / qk);
  }
  return kl;
}

// ─── Paper Performance Analyzer ───────────────────────────────────────────────

export interface PaperAnalysisInput {
  strategyId: string;
  backtestMetrics: Partial<PerformanceMetrics>;
  shadowMetrics: Partial<PerformanceMetrics> | null;
  paperMetrics: Partial<PerformanceMetrics> | null;
  backtestRegimeDistribution: Partial<Record<MarketRegime, number>>;
  paperRegimeDistribution: Partial<Record<MarketRegime, number>>;
  avgSlippageBps: number; // basis points
  expectedSlippageBps: number; // from backtest model
  avgFillQuality: number; // 0-1
  avgLatencyMs: number;
}

export function analyzePaperPerformance(
  input: PaperAnalysisInput,
): PaperPerformanceComparison {
  const {
    strategyId,
    backtestMetrics,
    shadowMetrics,
    paperMetrics,
    backtestRegimeDistribution,
    paperRegimeDistribution,
    avgSlippageBps,
    expectedSlippageBps,
    avgFillQuality,
    avgLatencyMs,
  } = input;

  const compareTarget = paperMetrics ?? shadowMetrics;

  const drifts: PerformanceDrift[] = [];

  if (compareTarget) {
    // Sharpe drift
    if (backtestMetrics.sharpe !== undefined && compareTarget.sharpe !== undefined) {
      drifts.push(computeDrift("sharpe", backtestMetrics.sharpe, compareTarget.sharpe, MATERIAL_DRIFT_THRESHOLDS.sharpe));
    }
    // Expectancy drift
    if (backtestMetrics.expectancy !== undefined && compareTarget.expectancy !== undefined) {
      drifts.push(computeDrift("expectancy", backtestMetrics.expectancy, compareTarget.expectancy, MATERIAL_DRIFT_THRESHOLDS.expectancy));
    }
    // Win rate drift (absolute)
    if (backtestMetrics.winRate !== undefined && compareTarget.winRate !== undefined) {
      const absChange = Math.abs(compareTarget.winRate - backtestMetrics.winRate);
      drifts.push({
        metric: "winRate",
        backtestValue: backtestMetrics.winRate,
        shadowValue: null,
        paperValue: compareTarget.winRate,
        driftPct: absChange, // absolute for winRate
        materialDrift: absChange > MATERIAL_DRIFT_THRESHOLDS.winRate,
        explanation: absChange > MATERIAL_DRIFT_THRESHOLDS.winRate
          ? `Win rate shifted by ${(absChange * 100).toFixed(1)} percentage points from backtest.`
          : "Win rate within acceptable range.",
      });
    }
    // Profit factor drift
    if (backtestMetrics.profitFactor !== undefined && compareTarget.profitFactor !== undefined) {
      drifts.push(computeDrift("profitFactor", backtestMetrics.profitFactor, compareTarget.profitFactor, MATERIAL_DRIFT_THRESHOLDS.profitFactor));
    }
    // Max drawdown drift
    if (backtestMetrics.maxDrawdown !== undefined && compareTarget.maxDrawdown !== undefined) {
      drifts.push(computeDrift("maxDrawdown", backtestMetrics.maxDrawdown, compareTarget.maxDrawdown, MATERIAL_DRIFT_THRESHOLDS.maxDrawdown));
    }
  }

  // Signal drift score: fraction of metrics showing material drift
  const materialDriftCount = drifts.filter((d) => d.materialDrift).length;
  const signalDriftScore = drifts.length > 0 ? materialDriftCount / drifts.length : 0;

  // Slippage difference
  const slippageDifferencePct =
    expectedSlippageBps > 0 ? (avgSlippageBps - expectedSlippageBps) / expectedSlippageBps : 0;

  // Regime distribution drift
  const regimeDistributionDiff = klDivergence(
    backtestRegimeDistribution as Record<string, number>,
    paperRegimeDistribution as Record<string, number>,
  );

  // Requires investigation if:
  //   - Any sharpe drift > 30%
  //   - Signal drift > 40%
  //   - Slippage 2× expected
  //   - Fill quality < 0.5
  const requiresInvestigation =
    drifts.some((d) => d.metric === "sharpe" && d.materialDrift) ||
    signalDriftScore > 0.4 ||
    slippageDifferencePct > 1.0 || // actual 2× expected
    avgFillQuality < 0.5;

  return {
    strategyId,
    backtestMetrics,
    shadowMetrics,
    paperMetrics,
    drifts,
    signalDriftScore,
    fillQualityScore: avgFillQuality,
    slippageDifferencePct,
    latencyMs: avgLatencyMs,
    regimeDistributionDiff,
    requiresInvestigation,
    computedAt: new Date().toISOString(),
  };
}
