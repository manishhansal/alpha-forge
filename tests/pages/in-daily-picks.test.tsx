import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/india/daily-picks/builder", () => ({
  getIndiaDailyPicks: vi.fn().mockResolvedValue({
    market: "india",
    tradeDate: "2026-06-15",
    generatedAt: Date.now(),
    modelVersion: "test",
    context: {
      market: "india",
      regime: "mixed",
      regimeScore: 0,
      headline: "Mixed",
      bullets: [],
      inActiveWindow: true,
      windowLabel: "Morning Trend",
      dataFreshness: "live",
    },
    inActiveWindow: true,
    groups: [],
    persisted: true,
  }),
}));

import IndiaDailyPicksPage, {
  metadata,
} from "@/app/(dashboard)/in/daily-picks/page";

describe("/in/daily-picks page", () => {
  it("exposes NSE F&O Daily Picks metadata", () => {
    expect(metadata.title).toMatch(/Daily Picks/);
  });

  it("renders the page heading and the three bucket descriptions", () => {
    render(<IndiaDailyPicksPage />);
    expect(
      screen.getByRole("heading", { name: /Daily Picks · NSE F&O/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/How the Daily Picks are chosen/)).toBeInTheDocument();
  });
});
