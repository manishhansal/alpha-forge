import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { UnderlyingFlow } from "@/components/india/options/underlying-flow";
import type { Quote } from "@/types/india";

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "RELIANCE",
    price: 2900,
    change: 10,
    changePct: 0.3,
    prevClose: 2890,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("UnderlyingFlow", () => {
  it("renders nothing when the quote carries no FULL-mode enrichment", () => {
    const { container } = render(<UnderlyingFlow quote={quote()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a null quote", () => {
    const { container } = render(<UnderlyingFlow quote={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows buy-pressure imbalance and 52-week / circuit enrichment", () => {
    render(
      <UnderlyingFlow
        quote={quote({
          orderBookImbalance: 0.42,
          weekHigh52: 3200,
          weekLow52: 2100,
          upperCircuit: 3190,
          lowerCircuit: 2610,
        })}
      />,
    );
    expect(screen.getByText("+42%")).toBeInTheDocument();
    expect(screen.getByText(/buy pressure/i)).toBeInTheDocument();
    expect(screen.getByText("52W High")).toBeInTheDocument();
    expect(screen.getByText("52W Low")).toBeInTheDocument();
    expect(screen.getByText("Circuit")).toBeInTheDocument();
  });

  it("labels negative imbalance as sell pressure", () => {
    render(<UnderlyingFlow quote={quote({ orderBookImbalance: -0.5 })} />);
    expect(screen.getByText("-50%")).toBeInTheDocument();
    expect(screen.getByText(/sell pressure/i)).toBeInTheDocument();
  });
});
