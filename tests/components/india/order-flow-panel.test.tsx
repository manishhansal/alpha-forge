/**
 * Failing tests for the OrderFlowPanel component.
 *
 * Written BEFORE the implementation exists (Task 9.1 — TDD).
 * These will fail with a module-not-found error until Task 9.3 is complete.
 *
 * Validates: Requirements 7.5, 7.7
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The component will consume data via a React hook (e.g. useOrderFlow or
// similar). We mock the hook so the component test never touches the network
// and is deterministic.
//
// Adjust the mock path when the hook is implemented — mirror wherever the
// component imports it from.
// ---------------------------------------------------------------------------

vi.mock("@/hooks/india/use-order-flow", () => ({
  useOrderFlow: vi.fn(),
}));

import { useOrderFlow } from "@/hooks/india/use-order-flow";
import { OrderFlowPanel } from "@/components/india/dashboard/order-flow-panel";

// Cast for mock manipulation
const mockUseOrderFlow = useOrderFlow as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Shared VpinResponse fixtures
// ---------------------------------------------------------------------------

const BENIGN_DATA = {
  available: true,
  symbol: "NIFTY",
  vpin: 0.2,
  bucketHistory: Array.from({ length: 20 }, () => 0.2),
  classification: "benign" as const,
};

const ELEVATED_DATA = {
  available: true,
  symbol: "NIFTY",
  vpin: 0.5,
  bucketHistory: Array.from({ length: 20 }, (_, i) => 0.3 + i * 0.01),
  classification: "elevated" as const,
};

const TOXIC_DATA = {
  available: true,
  symbol: "NIFTY",
  vpin: 0.8,
  bucketHistory: Array.from({ length: 20 }, () => 0.8),
  classification: "toxic" as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrderFlowPanel", () => {
  it("renders a VPIN gauge element", () => {
    mockUseOrderFlow.mockReturnValue({ data: BENIGN_DATA, isLoading: false, error: null });

    render(<OrderFlowPanel symbol="NIFTY" />);

    // The gauge should be present in the DOM — by role, aria-label, or
    // data-testid. We use a flexible query so the implementation can choose
    // any accessible approach.
    const gauge =
      screen.queryByRole("meter") ??
      screen.queryByLabelText(/vpin/i) ??
      screen.queryByTestId("vpin-gauge");

    expect(gauge).not.toBeNull();
  });

  it("renders a sparkline for the bucket history", () => {
    mockUseOrderFlow.mockReturnValue({ data: BENIGN_DATA, isLoading: false, error: null });

    render(<OrderFlowPanel symbol="NIFTY" />);

    // The sparkline can be an SVG, canvas, or an element with a known testid / role.
    const sparkline =
      screen.queryByTestId("vpin-sparkline") ??
      screen.queryByRole("img", { name: /vpin history/i }) ??
      document.querySelector("svg[data-sparkline]") ??
      document.querySelector("[data-testid='vpin-sparkline']");

    expect(sparkline).not.toBeNull();
  });

  it("shows the 'Toxic' label when VPIN > 0.7", () => {
    mockUseOrderFlow.mockReturnValue({ data: TOXIC_DATA, isLoading: false, error: null });

    render(<OrderFlowPanel symbol="NIFTY" />);

    expect(screen.getByText(/toxic/i)).toBeInTheDocument();
  });

  it("does NOT show the 'Toxic' label when VPIN ≤ 0.3 (benign)", () => {
    mockUseOrderFlow.mockReturnValue({ data: BENIGN_DATA, isLoading: false, error: null });

    render(<OrderFlowPanel symbol="NIFTY" />);

    // Should show "Benign" instead
    expect(screen.queryByText(/\btoxic\b/i)).not.toBeInTheDocument();
    expect(screen.getByText(/benign/i)).toBeInTheDocument();
  });

  it("shows the 'Elevated' label when VPIN is between 0.3 and 0.7", () => {
    mockUseOrderFlow.mockReturnValue({ data: ELEVATED_DATA, isLoading: false, error: null });

    render(<OrderFlowPanel symbol="NIFTY" />);

    expect(screen.getByText(/elevated/i)).toBeInTheDocument();
  });

  it("renders an unavailable badge when data.available is false", () => {
    mockUseOrderFlow.mockReturnValue({
      data: { available: false, reason: "ML service unreachable" },
      isLoading: false,
      error: null,
    });

    render(<OrderFlowPanel symbol="NIFTY" />);

    // Should degrade gracefully — show some unavailable indicator, not crash
    const unavailableBadge =
      screen.queryByText(/unavailable/i) ??
      screen.queryByText(/ml service/i) ??
      screen.queryByTestId("unavailable-badge");

    expect(unavailableBadge).not.toBeNull();
  });

  it("renders a loading skeleton while data is being fetched", () => {
    mockUseOrderFlow.mockReturnValue({ data: null, isLoading: true, error: null });

    render(<OrderFlowPanel symbol="NIFTY" />);

    // Skeleton or loading indicator should be present
    const skeleton =
      screen.queryByTestId("skeleton") ??
      screen.queryByRole("status") ??
      screen.queryByLabelText(/loading/i) ??
      document.querySelector("[data-testid='skeleton']");

    expect(skeleton).not.toBeNull();
  });

  it("displays the current VPIN numeric value", () => {
    mockUseOrderFlow.mockReturnValue({ data: TOXIC_DATA, isLoading: false, error: null });

    render(<OrderFlowPanel symbol="NIFTY" />);

    // The component should show the VPIN value somewhere (e.g. "0.80" or "80%")
    const vpinText =
      screen.queryByText("0.80") ??
      screen.queryByText("0.8") ??
      screen.queryByText(/80%/);

    expect(vpinText).not.toBeNull();
  });
});
