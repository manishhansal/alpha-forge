/**
 * Phase 27 — Unit Tests: Strategy Correlation & Clustering
 */

import { describe, it, expect } from "vitest";
import {
  computePairCorrelation,
  buildCorrelationMatrix,
} from "@/lib/research/correlation/strategy-correlation";
import type { StrategyReturnSeries } from "@/lib/research/correlation/strategy-correlation";
import type { StrategyCategory } from "@/lib/research/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeReturnSeries(id: string, returns: number[]): StrategyReturnSeries {
  const baseDate = new Date("2024-01-01");
  return {
    strategyId: id,
    returns: returns.map((r, i) => {
      const d = new Date(baseDate.getTime() + i * 24 * 3600 * 1000);
      return { date: d.toISOString().split("T")[0], returnPct: r };
    }),
  };
}

// Perfectly correlated (same returns)
const A = makeReturnSeries("A", [0.02, -0.01, 0.015, -0.005, 0.01, 0.02, -0.01, 0.015, 0.01, -0.005]);
const B = makeReturnSeries("B", [0.02, -0.01, 0.015, -0.005, 0.01, 0.02, -0.01, 0.015, 0.01, -0.005]);

// Negatively correlated
const C = makeReturnSeries("C", [-0.02, 0.01, -0.015, 0.005, -0.01, -0.02, 0.01, -0.015, -0.01, 0.005]);

// Uncorrelated (random-ish)
const D = makeReturnSeries("D", [0.01, 0.01, -0.02, 0.01, -0.005, 0.01, 0.01, -0.02, 0.01, -0.005]);

describe("computePairCorrelation", () => {
  it("identical strategies have return correlation of 1", () => {
    const pair = computePairCorrelation(A, B);
    expect(pair.returnCorrelation).toBeCloseTo(1, 4);
  });

  it("opposite strategies have return correlation close to -1", () => {
    const pair = computePairCorrelation(A, C);
    expect(pair.returnCorrelation).toBeCloseTo(-1, 2);
  });

  it("correlation is between -1 and 1", () => {
    const pair = computePairCorrelation(A, D);
    expect(pair.returnCorrelation).toBeGreaterThanOrEqual(-1);
    expect(pair.returnCorrelation).toBeLessThanOrEqual(1);
  });

  it("is symmetric (A,B) = (B,A)", () => {
    const ab = computePairCorrelation(A, D);
    const ba = computePairCorrelation(D, A);
    expect(ab.returnCorrelation).toBeCloseTo(ba.returnCorrelation, 4);
  });

  it("trade overlap is 1 for identical strategies", () => {
    const pair = computePairCorrelation(A, B);
    expect(pair.tradeOverlap).toBeCloseTo(1, 2);
  });
});

describe("buildCorrelationMatrix", () => {
  const categories = new Map<string, StrategyCategory>([
    ["A", "MOMENTUM"],
    ["B", "MOMENTUM"],
    ["C", "MEAN_REVERSION"],
    ["D", "TREND_FOLLOWING"],
  ]);

  it("returns N×N matrix for N strategies", () => {
    const { matrix } = buildCorrelationMatrix([A, B, C, D], categories);
    expect(matrix).toHaveLength(4);
    for (const row of matrix) expect(row).toHaveLength(4);
  });

  it("diagonal is 1 (self-correlation)", () => {
    const { matrix } = buildCorrelationMatrix([A, B, C, D], categories);
    for (let i = 0; i < matrix.length; i++) {
      expect(matrix[i][i]).toBeCloseTo(1, 4);
    }
  });

  it("is symmetric", () => {
    const { matrix } = buildCorrelationMatrix([A, B, C, D], categories);
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix.length; j++) {
        expect(matrix[i][j]).toBeCloseTo(matrix[j][i], 4);
      }
    }
  });

  it("clusters A and B together (high correlation)", () => {
    const { clusters } = buildCorrelationMatrix([A, B, C, D], categories, 0.90);
    const abCluster = clusters.find((c) => c.strategies.includes("A") && c.strategies.includes("B"));
    expect(abCluster).toBeDefined();
  });

  it("clusters have allocation cap defined", () => {
    const { clusters } = buildCorrelationMatrix([A, B, C, D], categories, 0.90);
    for (const c of clusters) {
      expect(c.allocationCapPct).toBeGreaterThan(0);
      expect(c.allocationCapPct).toBeLessThanOrEqual(100);
    }
  });
});
