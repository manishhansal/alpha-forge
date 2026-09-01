/**
 * Analytics metrics — pure function unit tests.
 *
 * Every test is self-contained with fixed inputs. No engine, no DB, no network.
 */

import { describe, it, expect } from "vitest";
import {
  cagr,
  sharpeRatio,
  sortinoRatio,
  calmarRatio,
  profitFactor,
  expectancy,
  payoffRatio,
  sqn,
  ulcerIndex,
  historicalVaR,
  cvar,
  winRate,
  calcDrawdown,
  maxConsecutive,
  mean,
  stddev,
} from "@/lib/backtesting-v2/analytics/metrics";

describe("mean / stddev", () => {
  it("mean of empty array is 0", () => expect(mean([])).toBe(0));
  it("mean of [1,2,3] is 2", () => expect(mean([1, 2, 3])).toBeCloseTo(2));
  it("stddev of [2,2,2] is 0", () => expect(stddev([2, 2, 2])).toBe(0));
  it("stddev of [0,1] is 0.5", () => expect(stddev([0, 1])).toBeCloseTo(0.5));
});

describe("cagr", () => {
  it("zero for zero trading days", () => expect(cagr(1000, 1200, 0)).toBe(0));
  it("zero for non-positive start equity", () => expect(cagr(0, 1200, 252)).toBe(0));
  it("doubles in one year → 100% CAGR ≈ 1", () =>
    expect(cagr(1_000, 2_000, 252)).toBeCloseTo(1, 2));
  it("flat equity → 0% CAGR", () => expect(cagr(1_000, 1_000, 252)).toBeCloseTo(0));
  it("loss equity → negative CAGR", () => expect(cagr(1_000, 500, 252)).toBeLessThan(0));
});

describe("sharpeRatio", () => {
  it("returns 0 for empty returns", () => expect(sharpeRatio([])).toBe(0));
  it("returns 0 for constant returns (zero volatility)", () =>
    expect(sharpeRatio([0.01, 0.01, 0.01])).toBe(0));
  it("positive returns with positive mean → positive sharpe", () => {
    const returns = Array(30).fill(0.005);
    returns[0] = -0.001;
    expect(sharpeRatio(returns)).toBeGreaterThan(0);
  });
  it("negative mean returns → negative sharpe", () => {
    const returns = Array(20).fill(-0.01);
    expect(sharpeRatio(returns)).toBeLessThan(0);
  });
});

describe("sortinoRatio", () => {
  it("returns 0 for empty returns", () => expect(sortinoRatio([])).toBe(0));
  it("all positive returns → high sortino", () => {
    const returns = Array(20).fill(0.01);
    // No downside deviation → Infinity or very high
    expect(sortinoRatio(returns)).toBeGreaterThanOrEqual(0);
  });
});

describe("profitFactor", () => {
  it("no trades → 0", () => expect(profitFactor([])).toBe(0));
  it("no losses → Infinity", () => expect(profitFactor([10, 20, 30])).toBe(Infinity));
  it("wins = losses → 1", () => expect(profitFactor([10, -10])).toBeCloseTo(1));
  it("2:1 ratio", () => expect(profitFactor([20, -10])).toBeCloseTo(2));
});

describe("winRate", () => {
  it("no trades → 0", () => expect(winRate([])).toBe(0));
  it("all wins → 1", () => expect(winRate([5, 10, 20])).toBe(1));
  it("all losses → 0", () => expect(winRate([-5, -10])).toBe(0));
  it("half wins → 0.5", () => expect(winRate([10, -10])).toBeCloseTo(0.5));
});

describe("expectancy", () => {
  it("no trades → 0", () => expect(expectancy([])).toBe(0));
  it("all wins → positive", () => expect(expectancy([10, 20])).toBeGreaterThan(0));
  it("all losses → negative", () => expect(expectancy([-5, -10])).toBeLessThan(0));
  it("50% WR, avgWin=20, avgLoss=10 → 5", () =>
    expect(expectancy([20, -10])).toBeCloseTo(5));
});

describe("payoffRatio", () => {
  it("no trades → 0", () => expect(payoffRatio([])).toBe(0));
  it("no losses → Infinity", () => expect(payoffRatio([10])).toBe(Infinity));
  it("avgWin=20, avgLoss=10 → 2", () => expect(payoffRatio([20, -10])).toBeCloseTo(2));
});

describe("calcDrawdown", () => {
  it("flat equity → zero drawdown", () => {
    const { maxDrawdown } = calcDrawdown([100, 100, 100]);
    expect(maxDrawdown).toBe(0);
  });

  it("50% drawdown", () => {
    const { maxDrawdown } = calcDrawdown([100, 50]);
    expect(maxDrawdown).toBeCloseTo(0.5);
  });

  it("drawdown then recovery", () => {
    const { maxDrawdown } = calcDrawdown([100, 80, 120]);
    expect(maxDrawdown).toBeCloseTo(0.2); // 20% drawdown at trough
  });

  it("empty array returns zeros", () => {
    const r = calcDrawdown([]);
    expect(r.maxDrawdown).toBe(0);
  });
});

describe("ulcerIndex", () => {
  it("flat equity → 0", () => expect(ulcerIndex([100, 100, 100])).toBe(0));
  it("monotone decline → positive ulcer", () => expect(ulcerIndex([100, 90, 80])).toBeGreaterThan(0));
});

describe("historicalVaR / CVaR", () => {
  const returns = [-0.05, -0.03, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06];

  it("VaR is positive (represents a loss)", () => expect(historicalVaR(returns)).toBeGreaterThanOrEqual(0));
  it("CVaR >= VaR", () =>
    expect(cvar(returns)).toBeGreaterThanOrEqual(historicalVaR(returns)));
  it("empty array → 0 VaR", () => expect(historicalVaR([])).toBe(0));
});

describe("SQN", () => {
  it("returns 0 for fewer than 2 trades", () => expect(sqn([1])).toBe(0));
  it("positive R-multiples → positive SQN", () => {
    const rMults = Array(25).fill(1.5);
    rMults[0] = -0.5;
    expect(sqn(rMults)).toBeGreaterThan(0);
  });
});

describe("maxConsecutive", () => {
  it("all wins → maxWinStreak = N", () => {
    const { maxWinStreak, maxLossStreak } = maxConsecutive([true, true, true]);
    expect(maxWinStreak).toBe(3);
    expect(maxLossStreak).toBe(0);
  });

  it("alternating → max streak = 1", () => {
    const { maxWinStreak, maxLossStreak } = maxConsecutive([true, false, true, false]);
    expect(maxWinStreak).toBe(1);
    expect(maxLossStreak).toBe(1);
  });

  it("win-win-loss-loss-loss → maxLoss = 3", () => {
    const { maxLossStreak } = maxConsecutive([true, true, false, false, false]);
    expect(maxLossStreak).toBe(3);
  });
});

describe("calmarRatio", () => {
  it("zero drawdown → Infinity for positive cagr", () =>
    expect(calmarRatio(0.2, 0)).toBe(Infinity));
  it("negative cagr and zero drawdown → 0", () =>
    expect(calmarRatio(-0.1, 0)).toBe(0));
  it("cagr=0.3, maxDD=0.15 → 2", () =>
    expect(calmarRatio(0.3, 0.15)).toBeCloseTo(2));
});
