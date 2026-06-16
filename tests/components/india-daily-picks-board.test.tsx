import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyPicksBoard } from "@/components/india/daily-picks/daily-picks-board";
import { buildDailyPicks, groupDailyPicks } from "@/features/india/daily-picks/engine";
import type { DailyPicksResponse } from "@/features/india/daily-picks/builder";
import type { AiSignal } from "@/types/ai-signals";

function makeSignal(symbol: string): AiSignal {
  return {
    id: symbol,
    symbol,
    displayName: symbol,
    market: "india",
    pair: `${symbol}.NS`,
    action: "LONG",
    direction: "BULLISH",
    horizon: "intraday",
    underlyingPrice: 100,
    entry: 100,
    entryZone: { min: 99, max: 101 },
    strike: 100,
    stopLoss: 95,
    takeProfits: [
      { level: 1, price: 105, percent: 5, allocation: 0.5 },
      { level: 2, price: 110, percent: 10, allocation: 0.3 },
      { level: 3, price: 120, percent: 20, allocation: 0.2 },
    ],
    riskReward: 2,
    riskRewardBlended: 2.5,
    expectedMovePct: 4,
    positionSizingPct: 5,
    riskLevel: "medium",
    confidence: 0.7,
    confidenceScore: 70,
    grade: "B",
    winProbability: 0.6,
    timing: { generatedAt: 0, enterBy: 0, exitBy: 0, validForMs: 0, bestEntryNote: "", bestExitNote: "" },
    confluences: [
      { id: "trend", category: "technical", label: "trend", description: "", weight: 0.1, score: 0.8, contribution: 0.08, available: true },
      { id: "momentum", category: "technical", label: "momentum", description: "", weight: 0.1, score: 0.7, contribution: 0.07, available: true },
      { id: "volume", category: "flow", label: "volume", description: "", weight: 0.1, score: 0.6, contribution: 0.06, available: true },
    ],
    bullishCount: 3,
    bearishCount: 0,
    reasons: [{ category: "technical", text: "Uptrend", bullish: true }],
    invalidationCriteria: "x",
    modelVersion: "test",
    summary: "s",
  };
}

function makeData(): DailyPicksResponse {
  const picks = buildDailyPicks({
    signals: Array.from({ length: 12 }, (_, i) => makeSignal(`S${i}`)),
    tradeDate: "2026-06-15",
    now: 0,
  });
  return {
    market: "india",
    tradeDate: "2026-06-15",
    generatedAt: Date.now(),
    modelVersion: "test",
    context: {
      market: "india",
      regime: "mixed",
      regimeScore: 0,
      headline: "Mixed — pick spots only.",
      bullets: ["NIFTY +0.2%", "India VIX 12.3"],
      inActiveWindow: true,
      windowLabel: "Morning Trend",
      dataFreshness: "live",
    },
    inActiveWindow: true,
    groups: groupDailyPicks(picks),
    persisted: true,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => makeData() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DailyPicksBoard", () => {
  it("renders every bucket section, including indices scalping", () => {
    render(<DailyPicksBoard initialData={makeData()} />);
    expect(screen.getByText("Indices Scalping")).toBeInTheDocument();
    expect(screen.getByText("Opening Breakout")).toBeInTheDocument();
    expect(screen.getByText("Highly Momentum Stocks")).toBeInTheDocument();
    expect(screen.getByText("Highly Scalping Stocks")).toBeInTheDocument();
    expect(screen.getByText("Highly Potential Stocks")).toBeInTheDocument();
  });

  it("shows the market context headline and trade date", () => {
    render(<DailyPicksBoard initialData={makeData()} />);
    expect(screen.getByText("Mixed — pick spots only.")).toBeInTheDocument();
    expect(screen.getByText("2026-06-15")).toBeInTheDocument();
  });
});
