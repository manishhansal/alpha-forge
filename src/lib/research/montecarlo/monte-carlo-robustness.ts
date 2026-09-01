/**
 * Phase 11 — Monte Carlo Robustness Testing
 *
 * Every validated strategy must pass Monte Carlo stress testing before
 * advancing to SHADOW status.  The tests reveal whether a strategy's
 * historical performance is stable or dependent on a specific sequence
 * of trades.
 *
 * Simulations run (default 10,000 iterations each):
 *   1. TRADE_SHUFFLE    — random ordering of the historical trade sequence
 *   2. BOOTSTRAP        — sample with replacement from historical trades
 *   3. RETURN_PERTURB   — add Gaussian noise to each trade return
 *   4. SLIPPAGE_PERTURB — add random extra slippage per trade
 *   5. COST_PERTURB     — scale costs by Uniform(0.8, 2.5) per trade
 *   6. MISSED_TRADES    — randomly skip 10-30% of trades
 *   7. PARTIAL_FILL     — reduce position size by 30-70% on random trades
 *
 * Robustness score components:
 *   - Probability of loss (lower is better)
 *   - Probability of ruin (lower is better)
 *   - 95th pct drawdown (lower is better)
 *   - Sharpe median vs original (closer to 1.0 is better)
 */

import type {
  MonteCarloResult,
  MonteCarloRobustnessScore,
} from "../types";
import type { AnalyzerTrade } from "../performance/strategy-performance-analyzer";
import { computePerformanceMetrics } from "../performance/strategy-performance-analyzer";

// ─── Pseudo-Random Number Generator ──────────────────────────────────────────
// Using a simple seeded LCG so tests are reproducible.

export class SeededRNG {
  private seed: number;
  constructor(seed: number = 42) {
    this.seed = seed;
  }
  /** Returns a float in [0, 1) */
  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) & 0xffffffff;
    return (this.seed >>> 0) / 4294967296;
  }
  /** Returns a standard normal sample via Box-Muller */
  nextNormal(mean = 0, stdDev = 1): number {
    const u1 = Math.max(this.next(), 1e-10);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * stdDev;
  }
  /** Shuffle in place (Fisher-Yates) */
  shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// ─── Simulation Runner ────────────────────────────────────────────────────────

interface SimulationStats {
  totalReturn: number;
  sharpe: number;
  maxDrawdown: number;
}

/**
 * Run a single simulation and return basic stats.
 */
function runSingleSimulation(
  trades: AnalyzerTrade[],
  annualFactor: number,
  riskFreeRate: number,
): SimulationStats {
  if (trades.length === 0) return { totalReturn: 0, sharpe: 0, maxDrawdown: 0 };
  const metrics = computePerformanceMetrics(trades, "FINAL_OOS", annualFactor, riskFreeRate);
  return {
    totalReturn: metrics.totalReturn,
    sharpe: metrics.sharpe,
    maxDrawdown: metrics.maxDrawdown,
  };
}

/**
 * Run N Monte Carlo simulations for a given simulation type.
 * Returns a MonteCarloResult with aggregate statistics.
 */
export function runMonteCarlo(
  simulationType: MonteCarloResult["simulationType"],
  originalTrades: AnalyzerTrade[],
  iterations: number = 10_000,
  rng: SeededRNG = new SeededRNG(42),
  annualFactor: number = 252,
  riskFreeRate: number = 0.065,
): MonteCarloResult {
  const returns: number[] = [];
  const sharpes: number[] = [];
  const drawdowns: number[] = [];
  let lossCount = 0;
  let ruinCount = 0;

  for (let i = 0; i < iterations; i++) {
    let simulatedTrades: AnalyzerTrade[];

    switch (simulationType) {
      case "TRADE_SHUFFLE": {
        simulatedTrades = rng.shuffle(originalTrades);
        break;
      }
      case "BOOTSTRAP": {
        simulatedTrades = Array.from({ length: originalTrades.length }, () => {
          const idx = Math.floor(rng.next() * originalTrades.length);
          return { ...originalTrades[idx] };
        });
        break;
      }
      case "RETURN_PERTURB": {
        const tradeStd = stdDevOf(originalTrades.map((t) => t.returnPct));
        simulatedTrades = originalTrades.map((t) => ({
          ...t,
          returnPct: t.returnPct + rng.nextNormal(0, tradeStd * 0.3),
        }));
        break;
      }
      case "SLIPPAGE_PERTURB": {
        simulatedTrades = originalTrades.map((t) => ({
          ...t,
          // Add extra slippage: Uniform(0, 0.3%) per side, round-trip
          returnPct: t.returnPct - rng.next() * 0.003,
        }));
        break;
      }
      case "COST_PERTURB": {
        // Scale total costs by Uniform(0.8, 2.5)
        const costMultiplier = 0.8 + rng.next() * 1.7;
        const avgReturn = originalTrades.reduce((s, t) => s + t.returnPct, 0) / originalTrades.length;
        const avgCostProxy = Math.abs(avgReturn) * 0.1; // 10% of avg return as cost proxy
        simulatedTrades = originalTrades.map((t) => ({
          ...t,
          returnPct: t.returnPct - avgCostProxy * (costMultiplier - 1),
        }));
        break;
      }
      case "MISSED_TRADES": {
        // Skip 10-30% of trades randomly
        const skipRate = 0.1 + rng.next() * 0.2;
        simulatedTrades = originalTrades.filter(() => rng.next() > skipRate);
        if (simulatedTrades.length === 0) simulatedTrades = [originalTrades[0]];
        break;
      }
      case "PARTIAL_FILL": {
        // Reduce position size by 30-70% on random trades
        simulatedTrades = originalTrades.map((t) => {
          if (rng.next() < 0.3) {
            const fillFraction = 0.3 + rng.next() * 0.4;
            return { ...t, returnPct: t.returnPct * fillFraction };
          }
          return t;
        });
        break;
      }
      default:
        simulatedTrades = originalTrades;
    }

    const stats = runSingleSimulation(simulatedTrades, annualFactor, riskFreeRate);
    returns.push(stats.totalReturn);
    sharpes.push(stats.sharpe);
    drawdowns.push(stats.maxDrawdown);

    if (stats.totalReturn < 0) lossCount++;
    if (stats.maxDrawdown > 0.5) ruinCount++; // ruin = >50% drawdown
  }

  returns.sort((a, b) => a - b);
  sharpes.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);

  const pct = (arr: number[], p: number) => arr[Math.floor(arr.length * p)] ?? 0;

  return {
    simulationType,
    iterations,
    probabilityOfLoss: lossCount / iterations,
    probabilityOfRuin: ruinCount / iterations,
    expectedDrawdown: drawdowns.reduce((a, b) => a + b, 0) / iterations,
    drawdown95thPct: pct(drawdowns, 0.95),
    drawdown99thPct: pct(drawdowns, 0.99),
    sharpeDistribution: {
      p5: pct(sharpes, 0.05),
      p25: pct(sharpes, 0.25),
      median: pct(sharpes, 0.5),
      p75: pct(sharpes, 0.75),
      p95: pct(sharpes, 0.95),
    },
    terminalWealthDistribution: {
      p5: pct(returns, 0.05),
      p25: pct(returns, 0.25),
      median: pct(returns, 0.5),
      p75: pct(returns, 0.75),
      p95: pct(returns, 0.95),
    },
    worstCaseScenario: pct(returns, 0.01),
  };
}

function stdDevOf(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

// ─── Robustness Score ─────────────────────────────────────────────────────────

/**
 * Run all 7 Monte Carlo simulation types and compute an overall robustness score.
 *
 * Score (0-100):
 *   Each of the 7 simulations contributes equally (14.3 points).
 *   A simulation contributes its full share when:
 *     - Probability of loss < 0.25
 *     - Probability of ruin < 0.05
 *     - Median Sharpe > 0.5
 *     - 95th pct drawdown < 0.25
 */
export function computeMonteCarloRobustness(
  strategyId: string,
  trades: AnalyzerTrade[],
  iterations: number = 10_000,
  seed: number = 42,
  annualFactor: number = 252,
  riskFreeRate: number = 0.065,
): MonteCarloRobustnessScore {
  const SIMULATION_TYPES: MonteCarloResult["simulationType"][] = [
    "TRADE_SHUFFLE",
    "BOOTSTRAP",
    "RETURN_PERTURB",
    "SLIPPAGE_PERTURB",
    "COST_PERTURB",
    "MISSED_TRADES",
    "PARTIAL_FILL",
  ];

  const rng = new SeededRNG(seed);
  const results: MonteCarloResult[] = SIMULATION_TYPES.map((type) =>
    runMonteCarlo(type, trades, iterations, rng, annualFactor, riskFreeRate),
  );

  // Score each simulation: 0-100 where 100 = fully robust
  let totalScore = 0;
  for (const r of results) {
    let simScore = 100;
    // Penalise high probability of loss
    simScore -= Math.min(50, r.probabilityOfLoss * 200);
    // Penalise any ruin probability
    simScore -= Math.min(20, r.probabilityOfRuin * 200);
    // Penalise low median Sharpe
    if (r.sharpeDistribution.median < 0.5) {
      simScore -= Math.min(20, (0.5 - r.sharpeDistribution.median) * 40);
    }
    // Penalise high 95th pct drawdown
    if (r.drawdown95thPct > 0.25) {
      simScore -= Math.min(10, (r.drawdown95thPct - 0.25) * 40);
    }
    totalScore += Math.max(0, simScore);
  }

  const overallScore = Math.round(totalScore / results.length);
  const robustLabel: "ROBUST" | "MODERATE" | "FRAGILE" =
    overallScore >= 70 ? "ROBUST" : overallScore >= 45 ? "MODERATE" : "FRAGILE";

  return {
    strategyId,
    overallScore,
    results,
    robustLabel,
    computedAt: new Date().toISOString(),
  };
}
