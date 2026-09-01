/**
 * Phase 10 — Alpha Decay Detection
 *
 * Monitors rolling performance metrics to detect when a strategy's
 * performance is deteriorating.  A strategy should NEVER be trusted
 * indefinitely based on historical backtests.
 *
 * States (ascending severity):
 *   HEALTHY   — rolling metrics within 1σ of historical OOS baseline
 *   WARNING   — rolling metrics 1-2σ below baseline
 *   DEGRADED  — rolling metrics 2-3σ below baseline; reduce capital
 *   CRITICAL  — rolling metrics >3σ below baseline; PAPER only
 *   DISABLED  — strategy has been disabled by the demotion engine
 *
 * Decay is detected across all 6 tracked metrics:
 *   Sharpe, Expectancy, Win Rate, Profit Factor, Max Drawdown, Signal Quality
 */

import type {
  RollingMetrics,
  DecayAlert,
  DecayMonitorState,
  DecayState,
} from "../types";
import type { AnalyzerTrade } from "../performance/strategy-performance-analyzer";
import { computePerformanceMetrics } from "../performance/strategy-performance-analyzer";

// ─── Rolling Metrics Computation ─────────────────────────────────────────────

/**
 * Compute rolling metrics from a window of recent trades.
 * The windowBars parameter is informational only — the trades
 * array already represents the window.
 */
export function computeRollingMetrics(
  trades: AnalyzerTrade[],
  windowBars: number,
  annualFactor: number = 252,
  riskFreeRate: number = 0.065,
): RollingMetrics {
  if (trades.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      windowBars,
      sharpe: 0,
      expectancy: 0,
      winRate: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      signalQuality: 0,
    };
  }

  const metrics = computePerformanceMetrics(trades, "FINAL_OOS", annualFactor, riskFreeRate);

  // Signal quality: composite of statistical significance + calibration proxy
  // Approximated as: (1 - p_value) × (1 - kurtosis_penalty)
  const kurtosisPenalty = Math.max(0, Math.min(0.5, (metrics.kurtosis - 3) * 0.05));
  const signalQuality = (1 - metrics.pValue) * (1 - kurtosisPenalty);

  return {
    timestamp: new Date().toISOString(),
    windowBars,
    sharpe: metrics.sharpe,
    expectancy: metrics.expectancy,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    maxDrawdown: metrics.maxDrawdown,
    signalQuality,
  };
}

// ─── Baseline Statistics ──────────────────────────────────────────────────────

export interface MetricBaseline {
  mean: number;
  stdDev: number;
}

function computeBaseline(values: number[]): MetricBaseline {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(values.length - 1, 1);
  return { mean: m, stdDev: Math.sqrt(variance) };
}

// ─── Decay State Classifier ───────────────────────────────────────────────────

/**
 * Classify current metric vs baseline into a decay state.
 * For Sharpe and Expectancy: lower is worse.
 * For MaxDrawdown: higher is worse.
 */
function classifyMetricDeviation(
  current: number,
  baseline: MetricBaseline,
  direction: "lower_is_worse" | "higher_is_worse",
): { sigma: number; state: DecayState } {
  if (baseline.stdDev <= 0) return { sigma: 0, state: "HEALTHY" };

  const delta =
    direction === "lower_is_worse"
      ? baseline.mean - current // positive = current is below mean
      : current - baseline.mean; // positive = current is above mean (bad)

  const sigma = delta / baseline.stdDev;

  let state: DecayState;
  if (sigma < 1) state = "HEALTHY";
  else if (sigma < 2) state = "WARNING";
  else if (sigma < 3) state = "DEGRADED";
  else state = "CRITICAL";

  return { sigma, state };
}

function metricStateOrdinal(state: DecayState): number {
  const order: Record<DecayState, number> = {
    HEALTHY: 0,
    WARNING: 1,
    DEGRADED: 2,
    CRITICAL: 3,
    DISABLED: 4,
  };
  return order[state];
}

// ─── Decay Monitor ────────────────────────────────────────────────────────────

export interface DecayMonitorInput {
  strategyId: string;
  recentTrades: AnalyzerTrade[];
  windowBars: number;
  historicalRollingMetrics: RollingMetrics[];
  currentState?: DecayState;
  annualFactor?: number;
  riskFreeRate?: number;
}

/**
 * Update the decay monitor state for a strategy.
 *
 * This should be called periodically (e.g. weekly or after each 20-trade
 * batch) with the most recent trades.
 */
export function updateDecayMonitor(input: DecayMonitorInput): DecayMonitorState {
  const {
    strategyId,
    recentTrades,
    windowBars,
    historicalRollingMetrics,
    currentState = "HEALTHY",
    annualFactor = 252,
    riskFreeRate = 0.065,
  } = input;

  const latestMetrics = computeRollingMetrics(recentTrades, windowBars, annualFactor, riskFreeRate);

  // Build baselines from historical rolling metrics
  const sharpeBaseline = computeBaseline(historicalRollingMetrics.map((m) => m.sharpe));
  const expectancyBaseline = computeBaseline(historicalRollingMetrics.map((m) => m.expectancy));
  const winRateBaseline = computeBaseline(historicalRollingMetrics.map((m) => m.winRate));
  const pfBaseline = computeBaseline(historicalRollingMetrics.map((m) => m.profitFactor));
  const ddBaseline = computeBaseline(historicalRollingMetrics.map((m) => m.maxDrawdown));
  const sqBaseline = computeBaseline(historicalRollingMetrics.map((m) => m.signalQuality));

  const alerts: DecayAlert[] = [];

  const checks: {
    metric: keyof RollingMetrics;
    current: number;
    baseline: MetricBaseline;
    direction: "lower_is_worse" | "higher_is_worse";
  }[] = [
    { metric: "sharpe", current: latestMetrics.sharpe, baseline: sharpeBaseline, direction: "lower_is_worse" },
    { metric: "expectancy", current: latestMetrics.expectancy, baseline: expectancyBaseline, direction: "lower_is_worse" },
    { metric: "winRate", current: latestMetrics.winRate, baseline: winRateBaseline, direction: "lower_is_worse" },
    { metric: "profitFactor", current: latestMetrics.profitFactor, baseline: pfBaseline, direction: "lower_is_worse" },
    { metric: "maxDrawdown", current: latestMetrics.maxDrawdown, baseline: ddBaseline, direction: "higher_is_worse" },
    { metric: "signalQuality", current: latestMetrics.signalQuality, baseline: sqBaseline, direction: "lower_is_worse" },
  ];

  let worstState: DecayState = "HEALTHY";

  for (const check of checks) {
    // Skip metrics with insufficient history
    if (check.baseline.stdDev === 0) continue;

    const { sigma, state } = classifyMetricDeviation(
      check.current,
      check.baseline,
      check.direction,
    );

    if (metricStateOrdinal(state) > metricStateOrdinal(worstState)) {
      worstState = state;
    }

    if (state === "WARNING" || state === "DEGRADED" || state === "CRITICAL") {
      alerts.push({
        strategyId,
        metric: check.metric,
        currentValue: check.current,
        historicalBaseline: check.baseline.mean,
        deviationSigma: sigma,
        alertLevel: state === "WARNING" ? "WARNING" : "CRITICAL",
        detectedAt: new Date().toISOString(),
      });
    }
  }

  // DISABLED state can only be set by the demotion engine, not here
  const newState = currentState === "DISABLED" ? "DISABLED" : worstState;
  const stateChanged = newState !== currentState;

  // Update rolling history (keep last 52 weeks)
  const updatedHistory = [
    ...historicalRollingMetrics.slice(-51),
    latestMetrics,
  ];

  return {
    strategyId,
    state: newState,
    rollingHistory: updatedHistory,
    latestMetrics,
    historicalBaseline: {
      sharpe: sharpeBaseline.mean,
      expectancy: expectancyBaseline.mean,
      winRate: winRateBaseline.mean,
      profitFactor: pfBaseline.mean,
      maxDrawdown: ddBaseline.mean,
      signalQuality: sqBaseline.mean,
    },
    alerts,
    lastCheckedAt: new Date().toISOString(),
    stateChangedAt: stateChanged ? new Date().toISOString() : new Date().toISOString(),
  };
}
