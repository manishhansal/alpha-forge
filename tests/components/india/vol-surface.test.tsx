/**
 * Failing tests for the VolSurface component.
 *
 * Written BEFORE the implementation exists at
 * `src/components/india/options/vol-surface.tsx` (Task 6.1 — TDD red phase).
 * These tests will fail with a module-not-found error until the component is
 * created.
 *
 * The component is expected to:
 *  - Accept a `VolSurfaceResponse` (or `{ available: false }`) as a prop or
 *    fetch it via a hook.
 *  - Render an IV Smile 2D chart (one line per expiry).
 *  - Render a Term Structure area chart.
 *  - Render a 3D Surface canvas toggle.
 *  - Show an <UnavailableBadge> when data.available === false.
 *
 * Validates: Requirements 5.5, 13.4
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the data hook so the component never touches the network and tests
// remain deterministic. Adjust the mock path when the hook is implemented —
// mirror wherever the component imports it from.
// ---------------------------------------------------------------------------

vi.mock("@/hooks/india/use-vol-surface", () => ({
  useVolSurface: vi.fn(),
}));

import { useVolSurface } from "@/hooks/india/use-vol-surface";
import { VolSurface } from "@/components/india/options/vol-surface";

// Cast for mock manipulation
const mockUseVolSurface = useVolSurface as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Shared VolSurfaceResponse fixtures (two expiries, five strikes each)
// ---------------------------------------------------------------------------

const TWO_EXPIRY_DATA = {
  available: true,
  symbol: "NIFTY",
  expiries: ["2025-07-10", "2025-07-24"],
  ivByExpiry: {
    "2025-07-10": [
      { strike: 22500, iv: 0.17 },
      { strike: 22800, iv: 0.155 },
      { strike: 23000, iv: 0.15 },
      { strike: 23200, iv: 0.153 },
      { strike: 23500, iv: 0.162 },
    ],
    "2025-07-24": [
      { strike: 22500, iv: 0.175 },
      { strike: 22800, iv: 0.162 },
      { strike: 23000, iv: 0.16 },
      { strike: 23200, iv: 0.163 },
      { strike: 23500, iv: 0.172 },
    ],
  },
  termStructure: [
    { daysToExpiry: 7, atmIv: 0.15 },
    { daysToExpiry: 21, atmIv: 0.16 },
  ],
  sviParams: {
    "2025-07-10": { a: 0.01, b: 0.05, rho: -0.3, m: 0.0, sigma: 0.2 },
    "2025-07-24": { a: 0.012, b: 0.06, rho: -0.28, m: 0.0, sigma: 0.21 },
  },
};

const THREE_EXPIRY_DATA = {
  ...TWO_EXPIRY_DATA,
  expiries: ["2025-07-10", "2025-07-24", "2025-08-07"],
  ivByExpiry: {
    ...TWO_EXPIRY_DATA.ivByExpiry,
    "2025-08-07": [
      { strike: 22500, iv: 0.18 },
      { strike: 22800, iv: 0.168 },
      { strike: 23000, iv: 0.165 },
      { strike: 23200, iv: 0.168 },
      { strike: 23500, iv: 0.178 },
    ],
  },
  termStructure: [
    { daysToExpiry: 7, atmIv: 0.15 },
    { daysToExpiry: 21, atmIv: 0.16 },
    { daysToExpiry: 35, atmIv: 0.165 },
  ],
  sviParams: {
    ...TWO_EXPIRY_DATA.sviParams,
    "2025-08-07": { a: 0.014, b: 0.065, rho: -0.25, m: 0.0, sigma: 0.22 },
  },
};

const UNAVAILABLE_DATA = {
  available: false,
  reason: "ML service unreachable",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VolSurface", () => {
  // ── 1. Renders without crash ──────────────────────────────────────────────

  it("renders without crash when given valid two-expiry surface data", () => {
    mockUseVolSurface.mockReturnValue({
      data: TWO_EXPIRY_DATA,
      isLoading: false,
      error: null,
    });

    // If this throws, the test fails — that is the expected TDD red behaviour.
    expect(() => render(<VolSurface symbol="NIFTY" />)).not.toThrow();
  });

  it("renders without crash in the unavailable state", () => {
    mockUseVolSurface.mockReturnValue({
      data: UNAVAILABLE_DATA,
      isLoading: false,
      error: null,
    });

    expect(() => render(<VolSurface symbol="NIFTY" />)).not.toThrow();
  });

  it("renders without crash while loading (data is null)", () => {
    mockUseVolSurface.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
    });

    expect(() => render(<VolSurface symbol="NIFTY" />)).not.toThrow();
  });

  // ── 2. Correct number of expiry lines ──────────────────────────────────────

  it("renders exactly 2 expiry lines for two-expiry surface data", () => {
    mockUseVolSurface.mockReturnValue({
      data: TWO_EXPIRY_DATA,
      isLoading: false,
      error: null,
    });

    render(<VolSurface symbol="NIFTY" />);

    // The component should render one chart line / legend item per expiry.
    // We look for elements labelled or identified by the expiry dates.
    // Accept either data-testid or aria-label patterns.
    const expiryLines =
      screen.queryAllByTestId(/expiry-line/) ??
      screen.queryAllByRole("img", { name: /expiry/i });

    // Alternatively the component may render the expiry labels as text
    const expiry1 = screen.queryByText(/2025-07-10/) ?? screen.queryByText(/Jul 10/i);
    const expiry2 = screen.queryByText(/2025-07-24/) ?? screen.queryByText(/Jul 24/i);

    // Either the dedicated line elements are present, or the labels are shown
    const twoLinesRendered =
      expiryLines.length === 2 ||
      (expiry1 !== null && expiry2 !== null);

    expect(twoLinesRendered).toBe(true);
  });

  it("renders exactly 3 expiry lines for three-expiry surface data", () => {
    mockUseVolSurface.mockReturnValue({
      data: THREE_EXPIRY_DATA,
      isLoading: false,
      error: null,
    });

    render(<VolSurface symbol="NIFTY" />);

    const expiryLines = screen.queryAllByTestId(/expiry-line/);

    // If testids aren't used, count expiry date text occurrences
    const expiry1 = screen.queryByText(/2025-07-10/) ?? screen.queryByText(/Jul 10/i);
    const expiry2 = screen.queryByText(/2025-07-24/) ?? screen.queryByText(/Jul 24/i);
    const expiry3 = screen.queryByText(/2025-08-07/) ?? screen.queryByText(/Aug 07/i);

    const threeLinesRendered =
      expiryLines.length === 3 ||
      (expiry1 !== null && expiry2 !== null && expiry3 !== null);

    expect(threeLinesRendered).toBe(true);
  });

  // ── 3. Unavailable badge when data.available === false ───────────────────

  it("shows an unavailable indicator when data.available is false", () => {
    mockUseVolSurface.mockReturnValue({
      data: UNAVAILABLE_DATA,
      isLoading: false,
      error: null,
    });

    render(<VolSurface symbol="NIFTY" />);

    // Must render graceful unavailable state — not crash, not blank
    const unavailableIndicator =
      screen.queryByText(/unavailable/i) ??
      screen.queryByText(/ml service/i) ??
      screen.queryByTestId("unavailable-badge") ??
      screen.queryByRole("status");

    expect(unavailableIndicator).not.toBeNull();
  });

  // ── 4. Loading state ──────────────────────────────────────────────────────

  it("renders a loading skeleton while data is being fetched", () => {
    mockUseVolSurface.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
    });

    render(<VolSurface symbol="NIFTY" />);

    const skeleton =
      screen.queryByTestId("skeleton") ??
      screen.queryByRole("status") ??
      screen.queryByLabelText(/loading/i) ??
      document.querySelector("[data-testid='skeleton']");

    expect(skeleton).not.toBeNull();
  });
});
