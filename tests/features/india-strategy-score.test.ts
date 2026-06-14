import { describe, expect, it } from "vitest";

import {
  scoreIndiaStrategies,
  scoreIndiaStrategy,
  type IndiaStrategyScoreInput,
} from "@/features/india/scalping/strategy-score";

function stats(over: Partial<IndiaStrategyScoreInput> = {}): IndiaStrategyScoreInput {
  return {
    strategyId: "MOMENTUM",
    wins: 0,
    losses: 0,
    expired: 0,
    winRate: 0,
    profitFactor: 0,
    avgPnlPct: 0,
    totalPnlUsd: 0,
    ...over,
  };
}

describe("india/scalping/strategy-score — scoreIndiaStrategy", () => {
  it("returns null when there are no closed trades yet", () => {
    expect(scoreIndiaStrategy(stats({ wins: 0, losses: 0, expired: 0 }))).toBeNull();
  });

  it("grades a strong, well-sampled track record highly", () => {
    const score = scoreIndiaStrategy(
      stats({
        wins: 14,
        losses: 6,
        winRate: 0.7,
        profitFactor: 2.5,
        avgPnlPct: 0.8,
        totalPnlUsd: 5000,
      }),
    );
    expect(score).not.toBeNull();
    expect(score!.score).toBeGreaterThanOrEqual(70);
    expect(["A+", "A", "B"]).toContain(score!.grade);
    expect(["highly-recommended", "recommended"]).toContain(score!.recommendation);
    expect(score!.rationale).toContain("win");
  });

  it("grades a losing track record poorly and not-recommended", () => {
    const score = scoreIndiaStrategy(
      stats({
        wins: 6,
        losses: 14,
        winRate: 0.3,
        profitFactor: 0.5,
        avgPnlPct: -0.5,
        totalPnlUsd: -2000,
      }),
    );
    expect(score!.score).toBeLessThan(45);
    expect(score!.recommendation).toBe("not-recommended");
  });

  it("treats an infinite profit factor (no losers) as full credit", () => {
    const score = scoreIndiaStrategy(
      stats({
        wins: 12,
        losses: 0,
        winRate: 1,
        profitFactor: Number.POSITIVE_INFINITY,
        avgPnlPct: 1,
        totalPnlUsd: 8000,
      }),
    );
    expect(score!.score).toBeGreaterThan(70);
  });

  it("never recommends a tiny sample — caps at use-cautiously", () => {
    const score = scoreIndiaStrategy(
      stats({
        wins: 3,
        losses: 0,
        winRate: 1,
        profitFactor: Number.POSITIVE_INFINITY,
        avgPnlPct: 2,
        totalPnlUsd: 3000,
      }),
    );
    expect(["use-cautiously", "not-recommended"]).toContain(score!.recommendation);
  });
});

describe("india/scalping/strategy-score — enriched (drawdown / Sharpe / source)", () => {
  it("carries the source tag through to the score", () => {
    const score = scoreIndiaStrategy(
      stats({ wins: 10, losses: 5, winRate: 0.66, profitFactor: 2, avgPnlPct: 0.6, totalPnlUsd: 3000, source: "backtest" }),
    );
    expect(score!.source).toBe("backtest");
  });

  it("rewards a clean equity curve (low drawdown, high Sharpe) over a choppy one", () => {
    const base = {
      wins: 30,
      losses: 15,
      winRate: 0.66,
      profitFactor: 2,
      avgPnlPct: 0.6,
      totalPnlUsd: 8000,
    };
    const clean = scoreIndiaStrategy(stats({ ...base, maxDrawdownPct: 0.05, sharpe: 1.8 }));
    const choppy = scoreIndiaStrategy(stats({ ...base, maxDrawdownPct: 0.4, sharpe: 0.1 }));
    expect(clean!.score).toBeGreaterThan(choppy!.score);
  });

  it("still scores with the base model when no risk metrics are supplied", () => {
    const score = scoreIndiaStrategy(
      stats({ wins: 14, losses: 6, winRate: 0.7, profitFactor: 2.5, avgPnlPct: 0.8, totalPnlUsd: 5000 }),
    );
    expect(score!.score).toBeGreaterThanOrEqual(70);
    expect(score!.source).toBe("paper-trade");
  });
});

describe("india/scalping/strategy-score — scoreIndiaStrategies", () => {
  it("maps each strategy id to its score, omitting those with no closed trades", () => {
    const map = scoreIndiaStrategies([
      stats({ strategyId: "MOMENTUM", wins: 10, losses: 5, winRate: 0.66, profitFactor: 2, avgPnlPct: 0.6, totalPnlUsd: 3000 }),
      stats({ strategyId: "PCR_EXTREME", wins: 0, losses: 0, expired: 0 }),
    ]);
    expect(map.MOMENTUM).toBeDefined();
    expect(map.PCR_EXTREME).toBeUndefined();
  });
});
