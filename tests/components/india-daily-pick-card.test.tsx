import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DailyPickCard } from "@/components/india/daily-picks/daily-pick-card";
import type { DailyPick } from "@/features/india/daily-picks/engine";

function makePick(overrides: Partial<DailyPick> = {}): DailyPick {
  return {
    tradeDate: "2026-06-15",
    bucket: "MOMENTUM",
    rank: 1,
    symbol: "RELIANCE",
    displayName: "RELIANCE",
    pair: "RELIANCE.NS",
    direction: "BULLISH",
    action: "LONG",
    horizon: "intraday",
    grade: "A",
    confidence: 0.78,
    confidenceScore: 78,
    winProbability: 0.64,
    underlyingPrice: 100,
    entry: 100,
    stopLoss: 95,
    target: 105,
    canMoveUpto: 120,
    canExpectPct: 20,
    riskReward: 2,
    bucketScore: 0.8,
    rationale: ["Strong uptrend"],
    logic: "Momentum leader — trend and volume aligned to the upside.",
    status: "OPEN",
    lastPrice: 102,
    pnlPct: 2,
    achievedPct: 40,
    generatedAt: 0,
    resolvedAt: null,
    updatedAt: 0,
    optionContract: null,
    confluenceScore: 8,
    keyIndicators: ["RSI", "EMA stack", "OI buildup"],
    setupType: "Trend continuation pullback",
    researchNote:
      "Outperforming the tape into a multi-day breakout. Stop sits below the prior swing low so the structural invalidation is honest. Targets line up with the next supply pocket.",
    timeWindow: { start: "09:15", end: "15:30", label: "Intraday Window" },
    warnings: [],
    ...overrides,
  };
}

describe("DailyPickCard", () => {
  it("renders the frozen levels including can move upto + can expect", () => {
    render(<DailyPickCard pick={makePick()} />);
    expect(screen.getByText("RELIANCE")).toBeInTheDocument();
    expect(screen.getByText("Entry")).toBeInTheDocument();
    expect(screen.getByText("Stop loss")).toBeInTheDocument();
    expect(screen.getByText("Target")).toBeInTheDocument();
    expect(screen.getByText("Can move upto")).toBeInTheDocument();
    expect(screen.getByText("Can expect")).toBeInTheDocument();
    expect(screen.getByText("₹100.00")).toBeInTheDocument();
    expect(screen.getByText("₹120.00")).toBeInTheDocument();
    expect(screen.getAllByText("+20.00%").length).toBeGreaterThan(0);
  });

  it("shows the live P&L and why-here logic", () => {
    render(<DailyPickCard pick={makePick({ pnlPct: 3.5 })} />);
    expect(screen.getByLabelText("Live P&L")).toHaveTextContent("+3.50%");
    expect(screen.getByText(/Why here:/)).toBeInTheDocument();
    expect(screen.getByText(/Momentum leader/)).toBeInTheDocument();
  });

  it("flags a target-hit pick", () => {
    render(<DailyPickCard pick={makePick({ status: "TARGET_HIT" })} />);
    expect(screen.getByText("Target hit")).toBeInTheDocument();
  });

  it("shows when the signal appeared and how long it took to resolve", () => {
    // Appeared 09:30 IST (04:00 UTC), target hit 75 minutes later.
    const appeared = Date.UTC(2026, 5, 15, 4, 0, 0);
    render(
      <DailyPickCard
        pick={makePick({
          status: "TARGET_HIT",
          generatedAt: appeared,
          resolvedAt: appeared + 75 * 60_000,
        })}
      />,
    );
    expect(screen.getByText(/Appeared/)).toHaveTextContent("09:30");
    expect(screen.getByText(/Target hit in/)).toHaveTextContent("1h 15m");
  });

  it("renders SHORT direction for a bearish pick", () => {
    render(
      <DailyPickCard
        pick={makePick({
          direction: "BEARISH",
          action: "SHORT",
          target: 95,
          canMoveUpto: 80,
        })}
      />,
    );
    expect(screen.getByText("SHORT")).toBeInTheDocument();
  });
});
