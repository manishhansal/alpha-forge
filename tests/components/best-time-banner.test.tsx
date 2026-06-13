import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { BestTimeStatus } from "@/features/best-time/types";

function makeStatus(over: Partial<BestTimeStatus> = {}): BestTimeStatus {
  return {
    computedAt: new Date(Date.UTC(2024, 0, 3, 14, 30)).toISOString(),
    istTime: "20:00",
    istDay: { day: 3, label: "Wednesday", quality: "ideal", note: "" },
    active: {
      slug: "golden",
      label: "Golden Scalp Zone",
      headline: "Peak liquidity",
      startMin: 19 * 60,
      endMin: 22 * 60,
      priority: 5,
      quality: "ideal",
      styles: ["1m scalping"],
      insight: "High liquidity insight",
    },
    score: 92,
    verdict: "Ideal time to trade",
    overlapping: [],
    nextWindow: null,
    activeEndsInMinutes: 90,
    ...over,
  };
}

// The banner's `useEffect` immediately overwrites the `initial` prop with
// `getBestTimeStatus()` (the live, wall-clock-derived status). Stub the
// engine so every test sees a deterministic snapshot.
const STATUS_REF = { current: makeStatus() };
vi.mock("@/features/best-time/engine", async () => {
  const actual =
    await vi.importActual<typeof import("@/features/best-time/engine")>(
      "@/features/best-time/engine",
    );
  return {
    ...actual,
    getBestTimeStatus: () => STATUS_REF.current,
  };
});

// Stop framer-motion animations from polluting the test snapshot.
vi.mock("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get: () => (props: Record<string, unknown>) => {
        const React = require("react") as typeof import("react");
        const { children, ...rest } = props as { children?: React.ReactNode };
        return React.createElement("span", rest, children);
      },
    },
  ),
}));

import { BestTimeBanner } from "@/components/best-time/best-time-banner";

describe("components/best-time/best-time-banner", () => {
  it("renders the verdict and the active window label", () => {
    STATUS_REF.current = makeStatus();
    render(<BestTimeBanner initial={STATUS_REF.current} />);
    expect(screen.getByText("Ideal time to trade")).toBeInTheDocument();
    expect(screen.getByText("Golden Scalp Zone")).toBeInTheDocument();
  });

  it("renders the IST clock", () => {
    STATUS_REF.current = makeStatus();
    render(<BestTimeBanner initial={STATUS_REF.current} />);
    // The clock string is split across whitespace ("20:00" + " IST"), so use
    // a function matcher to reassemble the text content.
    // The clock pill renders the digits and " IST" as siblings so the
    // text node split lands inside a single span.
    const matches = screen.getAllByText(
      (_, node) => node?.textContent?.replace(/\s+/g, " ").trim() === "20:00 IST",
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it("links through to the Best Time breakdown page", () => {
    STATUS_REF.current = makeStatus();
    render(<BestTimeBanner initial={STATUS_REF.current} />);
    const link = screen.getByText(/Full breakdown/i).closest("a");
    expect(link).toHaveAttribute("href", "/best-time");
  });

  it("renders the day badge label", () => {
    STATUS_REF.current = makeStatus();
    render(<BestTimeBanner initial={STATUS_REF.current} />);
    expect(screen.getByText("Wednesday")).toBeInTheDocument();
  });

  it("shows the next-window pointer when one exists", () => {
    STATUS_REF.current = makeStatus({
      nextWindow: {
        slug: "golden",
        label: "Golden Scalp Zone",
        startsInMinutes: 60,
        startsAt: "19:00",
        quality: "ideal",
      },
    });
    render(<BestTimeBanner initial={STATUS_REF.current} />);
    expect(
      screen.getByText((_, node) => node?.textContent?.startsWith("Next:") ?? false),
    ).toBeInTheDocument();
  });
});
