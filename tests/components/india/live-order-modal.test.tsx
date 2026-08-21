/**
 * Failing tests for the LiveOrderModal component.
 *
 * Written BEFORE the implementation exists (Task 15.1 — TDD red phase).
 * These will fail with a module-not-found error until Task 15.3 is complete.
 *
 * The component (src/components/india/paper-trading/live-order-modal.tsx):
 *   - Shows signal details (symbol, direction, entry, stop, target)
 *   - Shows strategy paper-trade win rate as a percentage
 *   - Shows a warning badge when win rate < 50%
 *   - "Place Real Order" button disabled until user checks the confirm checkbox
 *   - Double-confirm UX: user must check "I understand this places a real order"
 *
 * Validates: Requirements 12.5, 12.6
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Import-under-test (will fail module-not-found until Task 15.3 is complete)
// ---------------------------------------------------------------------------
import { LiveOrderModal } from "@/components/india/paper-trading/live-order-modal";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A typical long signal with a healthy win rate. */
const HIGH_WIN_RATE_PROPS = {
  open: true,
  onClose: () => {},
  onConfirm: () => {},
  signal: {
    symbol: "NIFTY",
    direction: "LONG" as const,
    entry: 23_000,
    stop: 22_900,
    target: 23_200,
    strategyId: "orb-breakout",
  },
  paperWinRate: 0.65, // 65% — above 50%
};

/** Same signal but with a losing win rate to trigger the warning badge. */
const LOW_WIN_RATE_PROPS = {
  ...HIGH_WIN_RATE_PROPS,
  paperWinRate: 0.43, // 43% — below 50%
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiveOrderModal", () => {
  // ── Rendering ───────────────────────────────────────────────────────────

  it("renders with data-testid='live-order-modal' on the modal root", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const modal = screen.getByTestId("live-order-modal");
    expect(modal).toBeInTheDocument();
  });

  it("displays the signal symbol", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    expect(screen.getByText(/nifty/i)).toBeInTheDocument();
  });

  it("displays the signal direction", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    expect(screen.getByText(/long/i)).toBeInTheDocument();
  });

  it("displays the entry price", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    // 23000 formatted as a number
    const entryEl =
      screen.queryByText("23,000") ??
      screen.queryByText("23000") ??
      screen.queryByText(/23[\s,]?000/);
    expect(entryEl).not.toBeNull();
  });

  it("displays the stop price", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const stopEl =
      screen.queryByText("22,900") ??
      screen.queryByText("22900") ??
      screen.queryByText(/22[\s,]?900/);
    expect(stopEl).not.toBeNull();
  });

  it("displays the target price", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const targetEl =
      screen.queryByText("23,200") ??
      screen.queryByText("23200") ??
      screen.queryByText(/23[\s,]?200/);
    expect(targetEl).not.toBeNull();
  });

  it("displays the paper-trade win rate as a percentage", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    // 65% win rate
    const winRateEl =
      screen.queryByText(/65%/) ??
      screen.queryByText(/65\.0%/) ??
      screen.queryByText(/win.?rate/i);
    expect(winRateEl).not.toBeNull();
  });

  // ── Confirm checkbox ────────────────────────────────────────────────────

  it("renders the confirm checkbox with data-testid='confirm-checkbox'", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const checkbox = screen.getByTestId("confirm-checkbox");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute("type", "checkbox");
  });

  it("checkbox is unchecked by default", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const checkbox = screen.getByTestId("confirm-checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  // ── Place Order button ──────────────────────────────────────────────────

  it("renders the Place Real Order button with data-testid='place-order-btn'", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const btn = screen.getByTestId("place-order-btn");
    expect(btn).toBeInTheDocument();
  });

  it("the Place Real Order button is disabled when checkbox is unchecked", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const btn = screen.getByTestId("place-order-btn");
    expect(btn).toBeDisabled();
  });

  it("the Place Real Order button becomes enabled after checking the confirm checkbox", async () => {
    const user = userEvent.setup();
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const checkbox = screen.getByTestId("confirm-checkbox");
    const btn = screen.getByTestId("place-order-btn");

    // Button starts disabled
    expect(btn).toBeDisabled();

    // Check the confirmation
    await user.click(checkbox);

    // Button must now be enabled
    expect(btn).not.toBeDisabled();
  });

  it("the Place Real Order button becomes disabled again when checkbox is unchecked", async () => {
    const user = userEvent.setup();
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const checkbox = screen.getByTestId("confirm-checkbox");
    const btn = screen.getByTestId("place-order-btn");

    await user.click(checkbox); // check
    expect(btn).not.toBeDisabled();

    await user.click(checkbox); // uncheck
    expect(btn).toBeDisabled();
  });

  // ── Win rate warning ────────────────────────────────────────────────────

  it("does NOT show a warning badge when win rate is >= 50%", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const warning =
      screen.queryByText(/warning/i) ??
      screen.queryByTestId("win-rate-warning") ??
      screen.queryByRole("alert");

    // There may be no warning at all, or it may exist but should not reference
    // a low-win-rate-specific warning. We just check there's no "low win rate"
    // specific text.
    const lowWinRateWarning = screen.queryByText(/below.?50/i) ?? screen.queryByText(/win.?rate.*(low|below|warn)/i);
    expect(lowWinRateWarning).toBeNull();
  });

  it("shows a warning when win rate is below 50%", () => {
    render(<LiveOrderModal {...LOW_WIN_RATE_PROPS} />);

    const warning =
      screen.queryByText(/warning/i) ??
      screen.queryByText(/below.?50/i) ??
      screen.queryByText(/low.?win/i) ??
      screen.queryByTestId("win-rate-warning") ??
      screen.queryByRole("alert");

    expect(warning).not.toBeNull();
  });

  it("shows the low win rate value (43%) in the warning message", () => {
    render(<LiveOrderModal {...LOW_WIN_RATE_PROPS} />);

    const winRateEls = screen.queryAllByText(/43\.0%/);
    expect(winRateEls.length).toBeGreaterThan(0);
  });

  // ── Accessibility ───────────────────────────────────────────────────────

  it("confirm checkbox has an accessible label", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} />);

    const checkbox = screen.getByTestId("confirm-checkbox");
    // Must have a label via aria-label, aria-labelledby, or an associated <label>
    const hasLabel =
      checkbox.hasAttribute("aria-label") ||
      checkbox.hasAttribute("aria-labelledby") ||
      !!document.querySelector(`label[for="${checkbox.id}"]`);
    expect(hasLabel).toBe(true);
  });

  // ── Closed state ────────────────────────────────────────────────────────

  it("does not render the modal content when open=false", () => {
    render(<LiveOrderModal {...HIGH_WIN_RATE_PROPS} open={false} />);

    const modal = screen.queryByTestId("live-order-modal");
    // When closed, either the modal is not in the DOM or is not visible
    // We accept either pattern (conditional render vs CSS visibility).
    if (modal) {
      // If it exists, it should not be visible
      expect(modal).not.toBeVisible();
    } else {
      expect(modal).toBeNull();
    }
  });
});
