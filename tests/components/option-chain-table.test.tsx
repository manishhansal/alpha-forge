import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OptionChainTable } from "@/components/india/options/option-chain-table";
import type { OptionChain, OptionLeg, OptionType } from "@/types/india";

function leg(type: OptionType, delta: number): OptionLeg {
  return {
    strike: 22000,
    type,
    oi: 1000,
    changeInOi: 50,
    volume: 100,
    iv: 12.5,
    ltp: 100,
    bid: null,
    ask: null,
    delta,
    gamma: 0.002,
    theta: -5,
    vega: 2,
  };
}

function chain(): OptionChain {
  return {
    symbol: "NIFTY",
    spot: 22000,
    expiry: "01-Jan-2026",
    expiries: ["01-Jan-2026"],
    rows: [{ strike: 22000, ce: leg("CE", 0.62), pe: leg("PE", -0.38) }],
    analytics: {
      pcrOi: 1.1,
      pcrVolume: null,
      maxCeOiStrike: 22500,
      maxPeOiStrike: 21500,
      totalCeOi: 1000,
      totalPeOi: 1100,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
      atmIv: 14,
      maxPain: 22000,
    },
    fetchedAt: new Date().toISOString(),
  };
}

describe("OptionChainTable greeks toggle", () => {
  it("hides per-strike delta until the greeks toggle is enabled", () => {
    render(<OptionChainTable data={chain()} />);
    expect(
      screen.getByRole("button", { name: /greeks/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("0.62")).not.toBeInTheDocument();
    expect(screen.queryByText("-0.38")).not.toBeInTheDocument();
  });

  it("reveals CE/PE delta columns when the greeks toggle is clicked", async () => {
    const user = userEvent.setup();
    render(<OptionChainTable data={chain()} />);
    await user.click(screen.getByRole("button", { name: /greeks/i }));
    expect(screen.getByText("0.62")).toBeInTheDocument();
    expect(screen.getByText("-0.38")).toBeInTheDocument();
  });
});
