import { describe, expect, it } from "vitest";

import type { ScalpBacktestStats } from "@/features/scalping/backtest";
import {
  aggregateStats,
  scoreStrategy,
  type StrategyGrade,
} from "@/features/scalping/strategy-score";

function makeStats(over: Partial<ScalpBacktestStats> = {}): ScalpBacktestStats {
  return {
    strategyId: "UT_SMC",
    symbol: "BTC",
    interval: "4h",
    startTs: 0,
    endTs: 0,
    startEquity: 10_000,
    endEquity: 12_000,
    totalReturnPct: 20,
    buyHoldReturnPct: 5,
    totalTrades: 100,
    wins: 60,
    losses: 35,
    expired: 5,
    winRate: 0.6,
    profitFactor: 1.8,
    avgWinPct: 1.2,
    avgLossPct: -0.8,
    largestWinPct: 5,
    largestLossPct: -3,
    maxDrawdownPct: 0.12,
    sharpe: 1.4,
    avgBarsHeld: 8,
    totalPnlUsd: 2000,
    barsScanned: 10_000,
    ...over,
  };
}

describe("features/scalping/strategy-score", () => {
  describe("scoreStrategy()", () => {
    it("returns an F grade with no trades", () => {
      const r = scoreStrategy(makeStats({ totalTrades: 0, wins: 0, losses: 0 }));
      expect(r.score).toBe(0);
      expect(r.grade).toBe("F");
      expect(r.recommendation).toBe("not-recommended");
    });

    it("publishes a high-recommended grade for a strong strategy", () => {
      const r = scoreStrategy(
        makeStats({
          winRate: 0.65,
          profitFactor: 2.5,
          totalReturnPct: 80,
          buyHoldReturnPct: 20,
          maxDrawdownPct: 0.08,
          sharpe: 1.8,
          totalTrades: 200,
          totalPnlUsd: 8_000,
        }),
      );
      expect(r.score).toBeGreaterThanOrEqual(75);
      expect(r.recommendation).toBe("highly-recommended");
      const validGrades: StrategyGrade[] = ["A+", "A"];
      expect(validGrades).toContain(r.grade);
    });

    it("downgrades when totalTrades < 10 even if score is high", () => {
      const r = scoreStrategy(
        makeStats({
          totalTrades: 5,
          wins: 5,
          losses: 0,
          winRate: 1,
          profitFactor: Number.POSITIVE_INFINITY,
        }),
      );
      expect(r.recommendation).toBe("not-recommended");
    });

    it("score is clamped to [0, 100]", () => {
      const r = scoreStrategy(
        makeStats({
          winRate: 1.5, // out-of-range input
          profitFactor: 999,
          totalReturnPct: 1_000_000,
          buyHoldReturnPct: 0,
          maxDrawdownPct: -0.5,
          sharpe: 99,
          totalTrades: 10_000,
        }),
      );
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.score).toBeGreaterThanOrEqual(0);
    });

    it("publishes a rationale string with win-rate and PF info", () => {
      const r = scoreStrategy(makeStats());
      expect(r.rationale).toMatch(/win rate/i);
      expect(r.rationale).toMatch(/PF/);
    });

    it("recommends 'use-cautiously' for marginal scores", () => {
      const r = scoreStrategy(
        makeStats({
          winRate: 0.45,
          profitFactor: 1.05,
          totalReturnPct: 5,
          buyHoldReturnPct: 8,
          maxDrawdownPct: 0.25,
          sharpe: 0.4,
          totalTrades: 80,
          totalPnlUsd: 200,
        }),
      );
      expect(["use-cautiously", "not-recommended"]).toContain(r.recommendation);
    });

    it("publishes per-component contributions in [0, 1]", () => {
      const r = scoreStrategy(makeStats());
      for (const v of Object.values(r.components)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("aggregateStats()", () => {
    it("returns null when given an empty list", () => {
      expect(aggregateStats([])).toBeNull();
    });

    it("preserves the strategyId / interval of the first entry", () => {
      const a = makeStats({ symbol: "BTC", strategyId: "UT_SMC" });
      const b = makeStats({ symbol: "ETH", strategyId: "UT_SMC" });
      const out = aggregateStats([a, b])!;
      expect(out.strategyId).toBe("UT_SMC");
      expect(out.interval).toBe("4h");
    });

    it("sums trades, wins, losses, expired", () => {
      const a = makeStats({ totalTrades: 50, wins: 30, losses: 18, expired: 2 });
      const b = makeStats({ totalTrades: 80, wins: 40, losses: 35, expired: 5 });
      const out = aggregateStats([a, b])!;
      expect(out.totalTrades).toBe(130);
      expect(out.wins).toBe(70);
      expect(out.losses).toBe(53);
      expect(out.expired).toBe(7);
    });

    it("computes aggregate winRate from sums", () => {
      const a = makeStats({ totalTrades: 50, wins: 30, losses: 20 });
      const b = makeStats({ totalTrades: 50, wins: 20, losses: 30 });
      const out = aggregateStats([a, b])!;
      expect(out.winRate).toBeCloseTo(0.5);
    });

    it("returns a clone of the first stats when no trades happened", () => {
      // No-trades short-circuit returns `{ ...first }` — same reference shape
      // as the input, including its (possibly seeded) winRate field.
      const a = makeStats({ totalTrades: 0, wins: 0, losses: 0, winRate: 0 });
      const out = aggregateStats([a])!;
      expect(out.totalTrades).toBe(0);
      expect(out.winRate).toBe(0);
    });

    it("aggregate maxDrawdownPct takes the worst across symbols", () => {
      const a = makeStats({ maxDrawdownPct: 0.1 });
      const b = makeStats({ maxDrawdownPct: 0.25 });
      const out = aggregateStats([a, b])!;
      expect(out.maxDrawdownPct).toBeCloseTo(0.25);
    });
  });
});
