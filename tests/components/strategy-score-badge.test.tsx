import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { StrategyScoreBadge } from "@/components/scalper/strategy-score-badge";
import type { StrategyScoreBreakdown } from "@/features/scalping/strategy-score";

function makeScore(over: Partial<StrategyScoreBreakdown> = {}): StrategyScoreBreakdown {
  return {
    score: 78,
    grade: "A",
    recommendation: "highly-recommended",
    recommendationLabel: "Highly recommended",
    rationale: "60% win rate over 100 trades",
    components: {
      winRate: 0.7,
      profitFactor: 0.7,
      netReturn: 0.7,
      drawdown: 0.7,
      sharpe: 0.7,
      significance: 0.7,
    },
    ...over,
  };
}

describe("components/scalper/strategy-score-badge", () => {
  it("renders a placeholder when score is undefined", () => {
    render(<StrategyScoreBadge />);
    expect(screen.getByText(/backtest pending/i)).toBeInTheDocument();
  });

  it("renders an em-dash placeholder in compact mode without a score", () => {
    render(<StrategyScoreBadge compact />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders the score and grade when provided", () => {
    render(<StrategyScoreBadge score={makeScore()} />);
    expect(screen.getByText("78/100")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("includes the rationale as a tooltip title", () => {
    render(<StrategyScoreBadge score={makeScore()} />);
    const span = screen.getByText("78/100").closest("span");
    expect(span?.parentElement).toHaveAttribute("title");
  });

  it.each([
    ["highly-recommended"] as const,
    ["recommended"] as const,
    ["use-cautiously"] as const,
    ["not-recommended"] as const,
  ])("renders %s recommendation with no crashes", (recommendation) => {
    render(
      <StrategyScoreBadge
        score={makeScore({ recommendation, recommendationLabel: "ok" })}
      />,
    );
    expect(screen.getByText(/\/100$/)).toBeInTheDocument();
  });

  it("hides the recommendation label in compact mode", () => {
    const { container } = render(
      <StrategyScoreBadge score={makeScore()} compact />,
    );
    expect(container.textContent).not.toContain("Highly recommended");
  });
});
