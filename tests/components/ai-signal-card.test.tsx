import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AiSignalCard } from "@/components/ai-signals/ai-signal-card";
import type { AiSignal } from "@/types/ai-signals";

function buildSignal(overrides: Partial<AiSignal> = {}): AiSignal {
  return {
    id: "test-sig-1",
    symbol: "BTC",
    displayName: "Bitcoin",
    market: "crypto",
    pair: "BTCUSDT",
    action: "LONG",
    direction: "BULLISH",
    horizon: "intraday",
    underlyingPrice: 100_000,
    entry: 100_000,
    entryZone: { min: 99_800, max: 100_050 },
    strike: 100_000,
    stopLoss: 98_500,
    takeProfits: [
      { level: 1, price: 101_500, percent: 1.5, allocation: 0.5 },
      { level: 2, price: 102_500, percent: 2.5, allocation: 0.3 },
      { level: 3, price: 104_000, percent: 4.0, allocation: 0.2 },
    ],
    riskReward: 1.0,
    riskRewardBlended: 1.4,
    expectedMovePct: 4.0,
    positionSizingPct: 5,
    riskLevel: "medium",
    confidence: 0.72,
    confidenceScore: 72,
    grade: "A",
    winProbability: 0.65,
    timing: {
      generatedAt: Date.now(),
      enterBy: Date.now() + 15 * 60 * 1000,
      exitBy: Date.now() + 4 * 60 * 60 * 1000,
      validForMs: 4 * 60 * 60 * 1000,
      bestEntryNote: "Enter now — inside Prime Futures Window.",
      bestExitNote: "Close any runner by session end.",
    },
    confluences: [],
    bullishCount: 5,
    bearishCount: 1,
    reasons: [
      { category: "technical", text: "RSI(14): Oversold 28 — bullish bias", bullish: true },
      { category: "derivatives", text: "Funding -0.04% APR — crowded short", bullish: true },
    ],
    invalidationCriteria:
      "Setup invalidates on a 15m close below 98500.00 — exit immediately.",
    modelVersion: "alphaforge-ai-v1",
    summary: "LONG BTC · 72% confidence · grade A — Strong RSI mean-revert read.",
    ...overrides,
  };
}

describe("components/AiSignalCard", () => {
  it("renders the symbol, action and confidence score", () => {
    render(<AiSignalCard signal={buildSignal()} />);
    expect(screen.getByText("Bitcoin")).toBeInTheDocument();
    expect(screen.getByText("LONG")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("renders all three take-profit levels", () => {
    render(<AiSignalCard signal={buildSignal()} />);
    expect(screen.getByText("TP1")).toBeInTheDocument();
    expect(screen.getByText("TP2")).toBeInTheDocument();
    expect(screen.getByText("TP3")).toBeInTheDocument();
  });

  it("renders the AI summary line", () => {
    render(<AiSignalCard signal={buildSignal()} />);
    expect(screen.getByText(/LONG BTC · 72% confidence/)).toBeInTheDocument();
  });

  it("renders rationale items with category chips", () => {
    render(<AiSignalCard signal={buildSignal()} />);
    expect(
      screen.getByText(/RSI\(14\): Oversold 28 — bullish bias/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Funding -0.04% APR — crowded short/),
    ).toBeInTheDocument();
  });

  it("includes invalidation criteria in the footer", () => {
    render(<AiSignalCard signal={buildSignal()} />);
    expect(screen.getByText(/Invalidation:/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Setup invalidates on a 15m close below 98500.00 — exit immediately\./,
      ),
    ).toBeInTheDocument();
  });

  it("uses ₹ when currency is inr", () => {
    render(
      <AiSignalCard
        signal={buildSignal({
          market: "india",
          symbol: "NIFTY",
          displayName: "NIFTY 50",
          pair: "NIFTY",
          underlyingPrice: 22_000,
          entry: 22_000,
          entryZone: { min: 21_950, max: 22_010 },
          strike: 22_000,
          stopLoss: 21_800,
          takeProfits: [
            { level: 1, price: 22_200, percent: 0.91, allocation: 0.5 },
            { level: 2, price: 22_350, percent: 1.59, allocation: 0.3 },
            { level: 3, price: 22_500, percent: 2.27, allocation: 0.2 },
          ],
        })}
        currency="inr"
      />,
    );
    // ₹ should appear in the rendered DOM (at minimum on entry)
    const matches = screen.getAllByText(/₹/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("renders WAIT state without crashing", () => {
    render(
      <AiSignalCard
        signal={buildSignal({
          action: "WAIT",
          direction: "NEUTRAL",
          riskLevel: "high",
        })}
      />,
    );
    expect(screen.getByText("WAIT")).toBeInTheDocument();
  });
});
