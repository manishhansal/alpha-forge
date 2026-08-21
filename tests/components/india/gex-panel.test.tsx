/**
 * Failing tests for the GexPanel component.
 *
 * Written BEFORE the implementation exists (Task 5.1 — TDD red phase).
 * These will fail with a module-not-found error until Task 5.2 is complete.
 *
 * The component (src/components/india/options/gex-panel.tsx):
 *   - Renders a bar chart of per-strike GEX values
 *   - Shows a "Gamma Flip" label with the flip strike level
 *   - Shows an expected move subtitle
 *   - Degrades gracefully when data.available === false
 *
 * Test strategy:
 *   - Mock the useGex hook so this test never touches the network.
 *   - Pass a complete GexResult fixture and verify bar chart + gamma flip label.
 *
 * Validates: Requirements 4.7, 4.6
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// GexResult shape (from the design document Data Models section):
//
//   interface GexResult {
//     symbol: string;
//     spot: number;
//     strikes: number[];
//     gexPerStrike: number[];
//     aggregateGex: number;
//     gammaFlip: number;
//     expectedMovePct: number;
//     positiveGexWall: number;
//     negativeGexWall: number;
//     computedAt: string;
//     available: boolean;
//   }
// ---------------------------------------------------------------------------

// Mock the data hook — the component will import this to get its data.
// We mock before importing the component so the module graph resolves correctly.
vi.mock("@/hooks/india/use-gex", () => ({
  useGex: vi.fn(),
}));

import { useGex } from "@/hooks/india/use-gex";
import { GexPanel } from "@/components/india/options/gex-panel";

// Cast for mock manipulation
const mockUseGex = useGex as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Full GexResult with a clear gamma flip crossing between indices 4 and 5. */
const NIFTY_GEX_DATA = {
  available: true,
  symbol: "NIFTY",
  spot: 23_000,
  strikes: [22700, 22800, 22900, 23000, 23100, 23200, 23300, 23400, 23500],
  // Negative (CE-heavy) below spot, positive (PE-heavy) above → flip near 23100
  gexPerStrike: [-500e6, -400e6, -300e6, -100e6, 200e6, 400e6, 600e6, 700e6, 800e6],
  aggregateGex: 1_400e6,
  gammaFlip: 23_100,
  expectedMovePct: 0.85,
  positiveGexWall: 23_500,
  negativeGexWall: 22_700,
  computedAt: new Date().toISOString(),
};

/** Same shape but available: false for degradation tests. */
const UNAVAILABLE_DATA = {
  available: false,
  reason: "ML service unreachable",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GexPanel", () => {
  it("renders a bar chart element when data is available", () => {
    mockUseGex.mockReturnValue({ data: NIFTY_GEX_DATA, isLoading: false, error: null });

    render(<GexPanel symbol="NIFTY" />);

    // The chart can be an SVG, canvas, or a div with a known testid / role.
    // We accept any of the common patterns used in this codebase (Recharts SVG,
    // a canvas element, or a data-testid).
    const chart =
      screen.queryByTestId("gex-chart") ??
      screen.queryByRole("img", { name: /gex/i }) ??
      document.querySelector("svg") ??
      document.querySelector("canvas[data-testid]");

    expect(chart).not.toBeNull();
  });

  it("shows a 'Gamma Flip' label", () => {
    mockUseGex.mockReturnValue({ data: NIFTY_GEX_DATA, isLoading: false, error: null });

    render(<GexPanel symbol="NIFTY" />);

    // Must contain some text identifying the gamma flip level
    const gammaFlipLabel =
      screen.queryByText(/gamma.?flip/i) ??
      screen.queryByTestId("gamma-flip-label") ??
      screen.queryByLabelText(/gamma.?flip/i);

    expect(gammaFlipLabel).not.toBeNull();
  });

  it("displays the numeric gamma flip strike value", () => {
    mockUseGex.mockReturnValue({ data: NIFTY_GEX_DATA, isLoading: false, error: null });

    render(<GexPanel symbol="NIFTY" />);

    // The component should render the flip strike (23100) somewhere visible
    const flipStrikeText =
      screen.queryByText("23,100") ??
      screen.queryByText("23100") ??
      screen.queryByText(/23[\s,]?100/);

    expect(flipStrikeText).not.toBeNull();
  });

  it("renders an unavailable badge when data.available is false", () => {
    mockUseGex.mockReturnValue({
      data: UNAVAILABLE_DATA,
      isLoading: false,
      error: null,
    });

    render(<GexPanel symbol="NIFTY" />);

    // Must degrade gracefully — show an unavailable indicator, not crash
    const unavailableBadge =
      screen.queryByText(/unavailable/i) ??
      screen.queryByText(/ml service/i) ??
      screen.queryByTestId("unavailable-badge");

    expect(unavailableBadge).not.toBeNull();
  });

  it("does not crash when data.available is false (no unhandled errors)", () => {
    mockUseGex.mockReturnValue({
      data: UNAVAILABLE_DATA,
      isLoading: false,
      error: null,
    });

    // render should not throw
    expect(() => render(<GexPanel symbol="NIFTY" />)).not.toThrow();
  });

  it("renders a loading skeleton while data is being fetched", () => {
    mockUseGex.mockReturnValue({ data: null, isLoading: true, error: null });

    render(<GexPanel symbol="NIFTY" />);

    // Any loading indicator — skeleton, spinner, or aria role=status
    const skeleton =
      screen.queryByTestId("skeleton") ??
      screen.queryByRole("status") ??
      screen.queryByLabelText(/loading/i) ??
      document.querySelector("[data-testid='skeleton']");

    expect(skeleton).not.toBeNull();
  });

  it("shows the expected move subtitle when data is available", () => {
    mockUseGex.mockReturnValue({ data: NIFTY_GEX_DATA, isLoading: false, error: null });

    render(<GexPanel symbol="NIFTY" />);

    // Expected move percentage should be surfaced somewhere in the panel
    const expectedMoveLabel =
      screen.queryByText(/expected.?move/i) ??
      screen.queryByText(/0\.85/i) ??
      screen.queryByTestId("expected-move");

    expect(expectedMoveLabel).not.toBeNull();
  });
});
