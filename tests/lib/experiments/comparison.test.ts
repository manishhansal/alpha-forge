/**
 * comparison.test.ts
 *
 * Covers:
 *   • Per-arm metrics: win rate, profit factor, Sharpe, drawdown
 *   • Pairwise comparison with t-test and CI
 *   • bestArmId selection by Sharpe
 *   • Benchmark comparison with alpha and IR
 *   • Insufficient samples: no crash, null p-values
 */

import { describe, it, expect } from "vitest";
import { ComparisonEngine } from "@/lib/experiments/comparison";
import type { ArmComparisonInput, ComparisonInput } from "@/lib/experiments/comparison";
import type { ShadowTrade } from "@/lib/experiments/shadow-trader";
import type { ExperimentSignal } from "@/lib/experiments/experiment-manager";

// ── Fixture builders ───────────────────────────────────────────────────────────

const STAMP = {
  strategyVersion: "strat-v1", modelVersion: "model-v1",
  featureVersion: "feat-v1", experimentId: "exp_001",
};

function makeTrade(netPnl: number, idx: number): ShadowTrade {
  const entry = 21_000;
  const exit = netPnl >= 0 ? entry + netPnl : entry + netPnl;
  return {
    id: `t${idx}`,
    positionId: `t${idx}`,
    experimentId: "exp_001",
    armId: "arm",
    versionStamp: STAMP,
    symbol: "NIFTY",
    direction: "LONG",
    entryPrice: entry,
    exitPrice: exit,
    qty: 1,
    lotSize: 1,
    grossPnl: netPnl,
    commission: 0,
    netPnl,
    pnlPct: netPnl / (entry * 1),
    openedAtMs: 1_700_000_000_000 + idx * 60_000,
    closedAtMs: 1_700_000_000_000 + idx * 60_000 + 3_600_000,
    barsHeld: 4,
    closeReason: netPnl >= 0 ? "TARGET_HIT" : "STOP_HIT",
    stopLoss: entry * 0.99,
    target: entry * 1.02,
    plannedRR: 2.0,
    actualRR: netPnl >= 0 ? 1.5 : -1.0,
  };
}

function makeSignal(confidence = 0.8, idx = 0): ExperimentSignal {
  return {
    id: `sig_${idx}`,
    experimentId: "exp_001",
    armId: "arm",
    versionStamp: STAMP,
    timestampMs: 1_700_000_000_000 + idx * 60_000,
    symbol: "NIFTY",
    direction: "LONG",
    entryPrice: 21_000,
    stopLoss: 20_790,
    target: 21_420,
    confidence,
    riskReward: 2.0,
    mode: "SHADOW",
    acted: false,
  };
}

function makeSummary(armId: string, totalTrades: number) {
  return {
    experimentId: "exp_001",
    armId,
    totalTrades,
    openPositions: 0,
    wins: 0, losses: 0, winRate: 0,
    totalNetPnlINR: 0, avgReturnPct: 0, profitFactor: 0,
    sharpe: 0, maxDrawdownPct: 0,
    initialCapital: 1_000_000, currentEquity: 1_000_000,
    totalReturnPct: 0, totalCommissionINR: 0,
    equityCurvePoints: totalTrades,
    benchmarkPoints: 0, lastUpdatedAtMs: null,
  };
}

/** Build an arm input with `nWins` winning trades (+100 each) and `nLoss` losing trades (-50 each). */
function makeArmInput(
  armId: string,
  role: "CONTROL" | "EXPERIMENT",
  nWins: number,
  nLoss: number,
): ArmComparisonInput {
  const trades: ShadowTrade[] = [];
  let idx = 0;
  for (let i = 0; i < nWins; i++) trades.push(makeTrade(100, idx++));
  for (let i = 0; i < nLoss; i++) trades.push(makeTrade(-50, idx++));

  const signals = trades.map((_, i) => makeSignal(0.75, i));
  const equityValues = trades.reduce<number[]>((acc, t) => {
    const prev = acc.length > 0 ? acc[acc.length - 1] : 1_000_000;
    acc.push(prev + t.netPnl);
    return acc;
  }, []);

  return {
    armId, label: armId, role,
    trades, signals,
    summary: makeSummary(armId, trades.length),
    equityValues,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ComparisonEngine — per-arm metrics", () => {
  const engine = new ComparisonEngine();

  it("computes win rate correctly", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [makeArmInput("control", "CONTROL", 6, 4)], // 60% win rate
    };
    const report = engine.compare(input);
    expect(report.arms[0].winRate).toBeCloseTo(0.6, 5);
    expect(report.arms[0].wins).toBe(6);
    expect(report.arms[0].losses).toBe(4);
  });

  it("computes profit factor (gross wins / |gross losses|)", () => {
    // 6 wins × 100 = 600, 4 losses × 50 = 200 → PF = 3.0
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [makeArmInput("control", "CONTROL", 6, 4)],
    };
    const report = engine.compare(input);
    expect(report.arms[0].profitFactor).toBeCloseTo(3.0, 4);
  });

  it("computes non-zero Sharpe when returns vary", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [makeArmInput("control", "CONTROL", 20, 10)],
    };
    const report = engine.compare(input);
    // We only assert it's a finite number — sign depends on returns vs RF
    expect(Number.isFinite(report.arms[0].sharpe)).toBe(true);
  });

  it("computes max drawdown from equity curve", () => {
    // Build a declining equity curve: 1000 → 900 → 800 → 1000
    const arm: ArmComparisonInput = {
      armId: "dd", label: "DD", role: "CONTROL",
      trades: [],
      signals: [],
      summary: makeSummary("dd", 0),
      equityValues: [1000, 900, 800, 1000],
    };
    const report = engine.compare({ experimentId: "exp_001", arms: [arm] });
    // peak=1000, trough=800 → maxDD = 0.20
    expect(report.arms[0].maxDrawdown).toBeCloseTo(0.20, 4);
  });

  it("handles zero-trade arm without crashing", () => {
    const arm: ArmComparisonInput = {
      armId: "empty", label: "Empty", role: "CONTROL",
      trades: [], signals: [],
      summary: makeSummary("empty", 0),
      equityValues: [],
    };
    const report = engine.compare({ experimentId: "exp_001", arms: [arm] });
    expect(report.arms[0].totalTrades).toBe(0);
    expect(report.arms[0].winRate).toBe(0);
    expect(report.arms[0].sharpe).toBe(0);
  });

  it("fill rate = trades / signals", () => {
    const arm = makeArmInput("fr", "CONTROL", 3, 2); // 5 trades
    // Add 5 extra signals that didn't fill
    for (let i = 5; i < 10; i++) arm.signals.push(makeSignal(0.5, i));
    const report = engine.compare({ experimentId: "exp_001", arms: [arm] });
    expect(report.arms[0].fillRate).toBeCloseTo(5 / 10, 5);
  });
});

describe("ComparisonEngine — pairwise A/B comparison", () => {
  const engine = new ComparisonEngine(0.05);

  it("produces one pairwise entry for control vs one experiment arm", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [
        makeArmInput("control", "CONTROL", 30, 20),
        makeArmInput("expv2",   "EXPERIMENT", 40, 10),
      ],
    };
    const report = engine.compare(input);
    expect(report.pairwise).toHaveLength(1);
    expect(report.pairwise[0].baseArmId).toBe("control");
    expect(report.pairwise[0].compareArmId).toBe("expv2");
  });

  it("t-statistic and p-value are finite numbers when both arms have trades", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [
        makeArmInput("control", "CONTROL",    30, 20),
        makeArmInput("expv2",   "EXPERIMENT", 40, 10),
      ],
    };
    const { pairwise } = engine.compare(input);
    expect(Number.isFinite(pairwise[0].tStatistic)).toBe(true);
    expect(pairwise[0].pValue).not.toBeNull();
    expect(pairwise[0].pValue!).toBeGreaterThanOrEqual(0);
    expect(pairwise[0].pValue!).toBeLessThanOrEqual(1);
  });

  it("p-value is null when either arm has fewer than 2 trades", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [
        makeArmInput("control", "CONTROL",  1, 0),
        makeArmInput("expv2",   "EXPERIMENT", 40, 10),
      ],
    };
    const { pairwise } = engine.compare(input);
    expect(pairwise[0].pValue).toBeNull();
    expect(pairwise[0].isSignificant).toBe(false);
  });

  it("CI contains zero when arms have identical performance", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [
        makeArmInput("a", "CONTROL",    20, 20),
        makeArmInput("b", "EXPERIMENT", 20, 20),
      ],
    };
    const { pairwise } = engine.compare(input);
    // Arms are identical — CI should straddle zero
    expect(pairwise[0].ciLow).toBeLessThanOrEqual(0.001);
    expect(pairwise[0].ciHigh).toBeGreaterThanOrEqual(-0.001);
  });

  it("positive sharpeDiff when experiment arm is better", () => {
    // Experiment arm: all wins. Control arm: mostly losses.
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [
        makeArmInput("control", "CONTROL",    5, 45),  // poor
        makeArmInput("expv2",   "EXPERIMENT", 45, 5),  // good
      ],
    };
    const { pairwise } = engine.compare(input);
    expect(pairwise[0].sharpeDiff).toBeGreaterThan(0);
    expect(pairwise[0].winRateDiff).toBeGreaterThan(0);
    expect(pairwise[0].totalPnlDiff).toBeGreaterThan(0);
  });

  it("minRecommendedSampleSize is always positive", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [
        makeArmInput("control", "CONTROL",    20, 10),
        makeArmInput("expv2",   "EXPERIMENT", 25, 10),
      ],
    };
    const { pairwise } = engine.compare(input);
    expect(pairwise[0].minRecommendedSampleSize).toBeGreaterThan(0);
  });
});

describe("ComparisonEngine — bestArmId and winnerConfidence", () => {
  const engine = new ComparisonEngine();

  it("selects arm with highest Sharpe as best", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [
        makeArmInput("poor", "CONTROL",    5, 45),
        makeArmInput("good", "EXPERIMENT", 45, 5),
      ],
    };
    const report = engine.compare(input);
    expect(report.bestArmId).toBe("good");
  });

  it("winnerConfidence is in [0, 1]", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [
        makeArmInput("control", "CONTROL",    30, 20),
        makeArmInput("expv2",   "EXPERIMENT", 40, 10),
      ],
    };
    const { winnerConfidence } = engine.compare(input);
    expect(winnerConfidence).toBeGreaterThanOrEqual(0);
    expect(winnerConfidence).toBeLessThanOrEqual(1);
  });
});

describe("ComparisonEngine — benchmark comparison", () => {
  const engine = new ComparisonEngine();

  it("computes alpha correctly", () => {
    // Arm: 1000 → 1100 = +10%. Benchmark: 1000 → 1050 = +5%. Alpha = +5%.
    const armEquity = [1000, 1050, 1100];
    const benchEquity = [1000, 1025, 1050];
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [makeArmInput("control", "CONTROL", 5, 5)],
      benchmarks: [{ armId: "control", source: "NIFTY50", armEquityValues: armEquity, benchmarkValues: benchEquity }],
    };
    const { benchmarks } = engine.compare(input);
    expect(benchmarks[0].alphaPct).toBeCloseTo(5.0, 1);
    expect(benchmarks[0].armReturnPct).toBeCloseTo(10.0, 1);
    expect(benchmarks[0].benchmarkReturnPct).toBeCloseTo(5.0, 1);
  });

  it("informationRatio is null when fewer than 2 data points", () => {
    const input: ComparisonInput = {
      experimentId: "exp_001",
      arms: [makeArmInput("control", "CONTROL", 1, 0)],
      benchmarks: [{ armId: "control", source: "bench", armEquityValues: [1000], benchmarkValues: [1000] }],
    };
    const { benchmarks } = engine.compare(input);
    expect(benchmarks[0].informationRatio).toBeNull();
  });
});
