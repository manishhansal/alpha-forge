/**
 * Phase 27 — Unit Tests: Monte Carlo Robustness
 */

import { describe, it, expect } from "vitest";
import {
  runMonteCarlo,
  computeMonteCarloRobustness,
  SeededRNG,
} from "@/lib/research/montecarlo/monte-carlo-robustness";
import type { AnalyzerTrade } from "@/lib/research/performance/strategy-performance-analyzer";

function makeTrades(returns: number[]): AnalyzerTrade[] {
  return returns.map((r) => ({ returnPct: r, holdBars: 5, notionalValue: 100_000 }));
}

const GOOD_TRADES = makeTrades([0.02, 0.015, 0.01, 0.02, 0.025, 0.01, -0.005, 0.02, 0.015, 0.01]);
const BAD_TRADES = makeTrades([-0.02, -0.01, -0.015, -0.02, -0.01, 0.005, -0.015, -0.01, -0.02, -0.005]);

describe("SeededRNG", () => {
  it("produces deterministic results with same seed", () => {
    const rng1 = new SeededRNG(123);
    const rng2 = new SeededRNG(123);
    const vals1 = Array.from({ length: 10 }, () => rng1.next());
    const vals2 = Array.from({ length: 10 }, () => rng2.next());
    expect(vals1).toEqual(vals2);
  });

  it("produces values in [0, 1)", () => {
    const rng = new SeededRNG(42);
    for (let i = 0; i < 100; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("shuffle produces same-length array", () => {
    const rng = new SeededRNG(42);
    const arr = [1, 2, 3, 4, 5];
    const shuffled = rng.shuffle(arr);
    expect(shuffled).toHaveLength(arr.length);
    expect(shuffled.sort()).toEqual([...arr].sort());
  });
});

describe("runMonteCarlo", () => {
  it("returns probability of loss between 0 and 1", () => {
    const result = runMonteCarlo("TRADE_SHUFFLE", GOOD_TRADES, 100, new SeededRNG(42));
    expect(result.probabilityOfLoss).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfLoss).toBeLessThanOrEqual(1);
  });

  it("returns probability of ruin between 0 and 1", () => {
    const result = runMonteCarlo("BOOTSTRAP", GOOD_TRADES, 100, new SeededRNG(42));
    expect(result.probabilityOfRuin).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfRuin).toBeLessThanOrEqual(1);
  });

  it("bad strategy has higher probability of loss than good strategy", () => {
    const goodResult = runMonteCarlo("BOOTSTRAP", GOOD_TRADES, 500, new SeededRNG(42));
    const badResult = runMonteCarlo("BOOTSTRAP", BAD_TRADES, 500, new SeededRNG(42));
    expect(badResult.probabilityOfLoss).toBeGreaterThan(goodResult.probabilityOfLoss);
  });

  it("sharpe distribution has correct percentile ordering", () => {
    const result = runMonteCarlo("TRADE_SHUFFLE", GOOD_TRADES, 200, new SeededRNG(42));
    const dist = result.sharpeDistribution;
    expect(dist.p5).toBeLessThanOrEqual(dist.p25);
    expect(dist.p25).toBeLessThanOrEqual(dist.median);
    expect(dist.median).toBeLessThanOrEqual(dist.p75);
    expect(dist.p75).toBeLessThanOrEqual(dist.p95);
  });

  it("returns correct simulation type", () => {
    const result = runMonteCarlo("MISSED_TRADES", GOOD_TRADES, 50, new SeededRNG(42));
    expect(result.simulationType).toBe("MISSED_TRADES");
    expect(result.iterations).toBe(50);
  });
});

describe("computeMonteCarloRobustness", () => {
  it("returns score between 0 and 100", () => {
    const result = computeMonteCarloRobustness("TEST", GOOD_TRADES, 100, 42);
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
  });

  it("runs all 7 simulation types", () => {
    const result = computeMonteCarloRobustness("TEST", GOOD_TRADES, 50, 42);
    expect(result.results).toHaveLength(7);
  });

  it("good strategy scores higher than bad strategy", () => {
    const goodScore = computeMonteCarloRobustness("GOOD", GOOD_TRADES, 100, 42);
    const badScore = computeMonteCarloRobustness("BAD", BAD_TRADES, 100, 42);
    expect(goodScore.overallScore).toBeGreaterThan(badScore.overallScore);
  });

  it("bad strategy is FRAGILE or MODERATE", () => {
    const result = computeMonteCarloRobustness("BAD", BAD_TRADES, 200, 42);
    expect(["FRAGILE", "MODERATE"]).toContain(result.robustLabel);
  });
});
