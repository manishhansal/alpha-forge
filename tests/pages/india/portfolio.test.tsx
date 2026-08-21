/**
 * Smoke test for the /in/portfolio page — Task 12.1.
 *
 * This test is written BEFORE Task 12.2 creates the page at
 * `src/app/(dashboard)/in/portfolio/page.tsx`. It will fail until that page
 * exists.
 *
 * The test renders the page with fetch mocked to return `{ available: false }`
 * (ML service offline) and verifies that the page does not crash. This
 * exercises the graceful-degradation path described in Requirement 13.4.
 *
 * Requirements covered: 10.7, 13.1, 13.4
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock fetch so the page never hits real network endpoints.
// Returns `{ available: false }` for all requests — simulates the ML service
// being offline.
// ---------------------------------------------------------------------------
vi.stubGlobal(
  "fetch",
  vi.fn(async () =>
    new Response(JSON.stringify({ available: false, reason: "ML service unreachable" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ),
);

// ---------------------------------------------------------------------------
// Import the page AFTER mocks are set up.
// This import FAILS until Task 12.2 creates the page file — that is the
// intended TDD red phase.
// ---------------------------------------------------------------------------
import PortfolioPage from "@/app/(dashboard)/in/portfolio/page";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/in/portfolio page", () => {
  it("renders without crashing when the ML service is unavailable", () => {
    // The smoke test: just render — any unhandled React error or throw causes
    // this test to fail. The page must handle `available: false` gracefully.
    expect(() => render(<PortfolioPage />)).not.toThrow();
  });

  it("mounts at least one element in the DOM", () => {
    // Confirms the page returns a non-null/non-empty React tree.
    const { container } = render(<PortfolioPage />);
    expect(container.firstChild).not.toBeNull();
  });
});
