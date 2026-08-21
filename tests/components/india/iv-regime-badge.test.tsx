/**
 * Failing tests for the IV Regime Badge component.
 *
 * These tests are written BEFORE the implementation exists at
 * src/components/india/options/iv-regime-badge.tsx.
 * They will fail with a module-not-found error until Task 11.3 is complete.
 *
 * This is the TDD red phase — all tests are expected to FAIL initially.
 *
 * Validates: Requirements 9.8
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Import-under-test
// This import will fail with module-not-found until the component is created.
// That is intentional — it confirms the TDD red phase.
// ---------------------------------------------------------------------------
import { IvRegimeBadge } from "@/components/india/options/iv-regime-badge";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IvRegimeBadge", () => {
  // ── Requirement 9.8: badge shows "Crush" in green ──────────────────────
  it("shows 'Crush' text when iv_regime is CRUSH", () => {
    render(<IvRegimeBadge ivRegime="CRUSH" />);
    // The badge must contain the text "Crush" (case may vary: Crush / CRUSH)
    const badge =
      screen.queryByText(/crush/i);
    expect(badge).not.toBeNull();
  });

  it("has a green colour when iv_regime is CRUSH", () => {
    render(<IvRegimeBadge ivRegime="CRUSH" />);
    const badge =
      screen.queryByText(/crush/i) ??
      screen.queryByTestId("iv-regime-badge");
    expect(badge).not.toBeNull();
    // Green styling: could be a class, data-variant, or inline style.
    // We accept any of these patterns the codebase uses.
    const el = badge as HTMLElement;
    const isGreen =
      el.className?.includes("green") ||
      el.className?.includes("success") ||
      el.dataset["variant"] === "green" ||
      el.dataset["variant"] === "success" ||
      el.dataset["regime"] === "CRUSH" ||
      el.style?.color?.includes("green") ||
      // Check parent if badge is wrapped
      el.closest("[data-variant='green']") !== null ||
      el.closest("[data-variant='success']") !== null ||
      el.closest("[data-regime='CRUSH']") !== null;
    expect(isGreen).toBe(true);
  });

  // ── Requirement 9.8: badge shows "Spike" in red ────────────────────────
  it("shows 'Spike' text when iv_regime is SPIKE", () => {
    render(<IvRegimeBadge ivRegime="SPIKE" />);
    const badge = screen.queryByText(/spike/i);
    expect(badge).not.toBeNull();
  });

  it("has a red colour when iv_regime is SPIKE", () => {
    render(<IvRegimeBadge ivRegime="SPIKE" />);
    const badge =
      screen.queryByText(/spike/i) ??
      screen.queryByTestId("iv-regime-badge");
    expect(badge).not.toBeNull();
    const el = badge as HTMLElement;
    const isRed =
      el.className?.includes("red") ||
      el.className?.includes("destructive") ||
      el.className?.includes("danger") ||
      el.dataset["variant"] === "red" ||
      el.dataset["variant"] === "destructive" ||
      el.dataset["regime"] === "SPIKE" ||
      el.style?.color?.includes("red") ||
      el.closest("[data-variant='red']") !== null ||
      el.closest("[data-variant='destructive']") !== null ||
      el.closest("[data-regime='SPIKE']") !== null;
    expect(isRed).toBe(true);
  });

  // ── STABLE regime ───────────────────────────────────────────────────────
  it("shows 'Stable' text when iv_regime is STABLE", () => {
    render(<IvRegimeBadge ivRegime="STABLE" />);
    const badge = screen.queryByText(/stable/i);
    expect(badge).not.toBeNull();
  });

  // ── Null / undefined ────────────────────────────────────────────────────
  it("renders nothing (or a placeholder) when iv_regime is null", () => {
    // Requirement 9.6: iv_regime may be null when model is untrained.
    // The badge must not crash.
    expect(() => render(<IvRegimeBadge ivRegime={null} />)).not.toThrow();
  });

  it("does not crash when iv_regime is undefined", () => {
    expect(() => render(<IvRegimeBadge ivRegime={undefined} />)).not.toThrow();
  });
});
