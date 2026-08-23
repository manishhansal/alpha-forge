/**
 * Integration smoke tests for refactored Trading UI Overhaul layout primitives
 * and core trading components.
 *
 * These tests verify the component tree structure (exports, rendered elements,
 * styles, children) without rendering full server-component pages.
 *
 * Task: 19.2 — Add integration smoke tests for all refactored pages
 * Requirements: 14.1
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Framer Motion mock — keeps animations synchronous so jsdom tests are stable
// ---------------------------------------------------------------------------
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    useReducedMotion: vi.fn(() => false),
    motion: {
      ...actual.motion,
      div: ({ children, className, style, ...rest }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
        <div className={className} style={style} data-testid={rest["data-testid" as keyof typeof rest]}>
          {children}
        </div>
      ),
      span: ({ children, className, style, ...rest }: React.HTMLAttributes<HTMLSpanElement> & { children?: React.ReactNode }) => (
        <span className={className} style={style}>
          {children}
        </span>
      ),
    },
    useMotionValue: (initial: number) => {
      let _val = initial;
      return {
        get: () => _val,
        set: (v: number) => { _val = v; },
        on: () => () => {},
        destroy: () => {},
      };
    },
    animate: (
      _mv: unknown,
      target: number,
      opts: { onUpdate?: (v: number) => void; duration?: number },
    ) => {
      opts?.onUpdate?.(target);
      return { stop: vi.fn() };
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import React from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { BentoGrid, BentoCell } from "@/components/layout/BentoGrid";
import { SignalBadge } from "@/components/trading/SignalBadge";
import { ConfidenceBar } from "@/components/trading/ConfidenceBar";
import { RegimeBadge } from "@/components/trading/RegimeBadge";
import { NumberMorph } from "@/components/trading/NumberMorph";

// ─────────────────────────────────────────────────────────────────────────────
// 1. PageHeader — <h1> with title text
// ─────────────────────────────────────────────────────────────────────────────

describe("PageHeader", () => {
  it("renders <h1> with the title text", () => {
    render(<PageHeader title="Dashboard Overview" />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent("Dashboard Overview");
  });

  it("renders RegimeBadge when regime prop is provided", () => {
    render(<PageHeader title="India Overview" regime="BULL" />);
    // RegimeBadge renders the regime label text
    expect(screen.getByText("BULL")).toBeInTheDocument();
  });

  it("does NOT render RegimeBadge when regime is undefined", () => {
    render(<PageHeader title="No Regime" />);
    expect(screen.queryByText("BULL")).not.toBeInTheDocument();
    expect(screen.queryByText("BEAR")).not.toBeInTheDocument();
  });

  it("does NOT render RegimeBadge when regime is UNKNOWN", () => {
    render(<PageHeader title="Unknown Regime" regime="UNKNOWN" />);
    // PageHeader skips RegimeBadge for UNKNOWN
    const badge = screen.queryByText("UNKNOWN");
    expect(badge).not.toBeInTheDocument();
  });

  it("renders subtitle when provided", () => {
    render(<PageHeader title="Main" subtitle="Live market data" />);
    expect(screen.getByText("Live market data")).toBeInTheDocument();
  });

  it("renders action slot content when provided", () => {
    render(<PageHeader title="Main" action={<button>Refresh</button>} />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PageTransition — wraps children in a motion div
// ─────────────────────────────────────────────────────────────────────────────

describe("PageTransition", () => {
  it("renders children", () => {
    render(
      <PageTransition>
        <p>Page content</p>
      </PageTransition>,
    );
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("renders a wrapper element around children", () => {
    const { container } = render(
      <PageTransition>
        <span>Inner</span>
      </PageTransition>,
    );
    // The motion.div (mocked to <div>) wraps the child
    const wrapper = container.firstElementChild;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.tagName).toBe("DIV");
    expect(wrapper?.textContent).toBe("Inner");
  });

  it("applies w-full class by default", () => {
    const { container } = render(
      <PageTransition>
        <span>content</span>
      </PageTransition>,
    );
    expect(container.firstElementChild).toHaveClass("w-full");
  });

  it("merges custom className", () => {
    const { container } = render(
      <PageTransition className="custom-wrapper">
        <span>content</span>
      </PageTransition>,
    );
    expect(container.firstElementChild).toHaveClass("custom-wrapper");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BentoGrid — correct gridTemplateColumns style
// ─────────────────────────────────────────────────────────────────────────────

describe("BentoGrid", () => {
  it("renders with default 12-column gridTemplateColumns", () => {
    const { container } = render(<BentoGrid><div /></BentoGrid>);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(12, minmax(0, 1fr))");
  });

  it("renders with custom cols value", () => {
    const { container } = render(<BentoGrid cols={6}><div /></BentoGrid>);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(6, minmax(0, 1fr))");
  });

  it("renders children", () => {
    render(
      <BentoGrid>
        <span>cell one</span>
        <span>cell two</span>
      </BentoGrid>,
    );
    expect(screen.getByText("cell one")).toBeInTheDocument();
    expect(screen.getByText("cell two")).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. BentoCell — children with gridColumn: span N style
// ─────────────────────────────────────────────────────────────────────────────

describe("BentoCell", () => {
  it("renders children", () => {
    render(<BentoCell><p>Cell content</p></BentoCell>);
    expect(screen.getByText("Cell content")).toBeInTheDocument();
  });

  it("applies gridColumn: span 1 by default", () => {
    const { container } = render(<BentoCell><div /></BentoCell>);
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.style.gridColumn).toBe("span 1");
  });

  it("applies gridColumn: span N for custom colSpan", () => {
    const { container } = render(<BentoCell colSpan={4}><div /></BentoCell>);
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.style.gridColumn).toBe("span 4");
  });

  it("applies gridRow: span N when rowSpan > 1", () => {
    const { container } = render(<BentoCell rowSpan={3}><div /></BentoCell>);
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.style.gridRow).toBe("span 3");
  });

  it("does not set gridRow for rowSpan=1 (default)", () => {
    const { container } = render(<BentoCell><div /></BentoCell>);
    const cell = container.firstElementChild as HTMLElement;
    // gridRow should be empty/unset for default rowSpan=1
    expect(cell.style.gridRow).toBeFalsy();
  });

  it("sets data-bento-cell attribute", () => {
    const { container } = render(<BentoCell><div /></BentoCell>);
    expect(container.firstElementChild).toHaveAttribute("data-bento-cell");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SignalBadge — renders for LONG action
// ─────────────────────────────────────────────────────────────────────────────

describe("SignalBadge", () => {
  it("renders LONG action label", () => {
    render(<SignalBadge action="LONG" />);
    expect(screen.getByText("LONG")).toBeInTheDocument();
  });

  it("renders SHORT action label", () => {
    render(<SignalBadge action="SHORT" />);
    expect(screen.getByText("SHORT")).toBeInTheDocument();
  });

  it("renders WAIT action label", () => {
    render(<SignalBadge action="WAIT" />);
    expect(screen.getByText("WAIT")).toBeInTheDocument();
  });

  it("uses positive CSS token for LONG", () => {
    render(<SignalBadge action="LONG" />);
    const badge = screen.getByText("LONG").closest("span");
    expect(badge?.style.color).toBe("var(--color-data-positive)");
  });

  it("uses negative CSS token for SHORT", () => {
    render(<SignalBadge action="SHORT" />);
    const badge = screen.getByText("SHORT").closest("span");
    expect(badge?.style.color).toBe("var(--color-data-negative)");
  });

  it("uses muted CSS token for WAIT", () => {
    render(<SignalBadge action="WAIT" />);
    const badge = screen.getByText("WAIT").closest("span");
    expect(badge?.style.color).toBe("var(--color-fg-muted)");
  });

  it("does not render an icon when showIcon=false", () => {
    const { container } = render(<SignalBadge action="LONG" showIcon={false} />);
    // No SVG element should be present
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders as a <span> element", () => {
    render(<SignalBadge action="BUY" />);
    const el = screen.getByText("BUY");
    expect(el.tagName).toBe("SPAN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ConfidenceBar — fill width matches value
// ─────────────────────────────────────────────────────────────────────────────

describe("ConfidenceBar", () => {
  it("renders fill element with data-testid", () => {
    render(<ConfidenceBar value={75} />);
    expect(screen.getByTestId("confidence-bar-fill")).toBeInTheDocument();
  });

  it("sets fill width to value% for value=75", () => {
    render(<ConfidenceBar value={75} />);
    const fill = screen.getByTestId("confidence-bar-fill") as HTMLElement;
    expect(fill.style.width).toBe("75%");
  });

  it("sets fill width to 0% for value=0", () => {
    render(<ConfidenceBar value={0} />);
    const fill = screen.getByTestId("confidence-bar-fill") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("sets fill width to 100% for value=100", () => {
    render(<ConfidenceBar value={100} />);
    const fill = screen.getByTestId("confidence-bar-fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("clamps values above 100 to 100%", () => {
    render(<ConfidenceBar value={150} />);
    const fill = screen.getByTestId("confidence-bar-fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("clamps values below 0 to 0%", () => {
    render(<ConfidenceBar value={-10} />);
    const fill = screen.getByTestId("confidence-bar-fill") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("renders label when showLabel=true", () => {
    render(<ConfidenceBar value={42} showLabel />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("has progressbar role with correct aria values", () => {
    render(<ConfidenceBar value={60} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "60");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. RegimeBadge — BULL renders with correct CSS token
// ─────────────────────────────────────────────────────────────────────────────

describe("RegimeBadge", () => {
  it("renders BULL label", () => {
    render(<RegimeBadge regime="BULL" />);
    expect(screen.getByText("BULL")).toBeInTheDocument();
  });

  it("renders BEAR label", () => {
    render(<RegimeBadge regime="BEAR" />);
    expect(screen.getByText("BEAR")).toBeInTheDocument();
  });

  it("renders SIDEWAYS label", () => {
    render(<RegimeBadge regime="SIDEWAYS" />);
    expect(screen.getByText("SIDEWAYS")).toBeInTheDocument();
  });

  it("renders HIGH VOL label for HIGH_VOL regime", () => {
    render(<RegimeBadge regime="HIGH_VOL" />);
    expect(screen.getByText("HIGH VOL")).toBeInTheDocument();
  });

  it("applies bull regime CSS token as background for BULL", () => {
    render(<RegimeBadge regime="BULL" />);
    const badge = screen.getByText("BULL").closest("span");
    expect(badge?.style.background).toBe("var(--color-regime-bull)");
  });

  it("applies bear regime CSS token as background for BEAR", () => {
    render(<RegimeBadge regime="BEAR" />);
    const badge = screen.getByText("BEAR").closest("span");
    expect(badge?.style.background).toBe("var(--color-regime-bear)");
  });

  it("applies positive color token for BULL", () => {
    render(<RegimeBadge regime="BULL" />);
    const badge = screen.getByText("BULL").closest("span");
    expect(badge?.style.color).toBe("var(--color-data-positive)");
  });

  it("applies negative color token for BEAR", () => {
    render(<RegimeBadge regime="BEAR" />);
    const badge = screen.getByText("BEAR").closest("span");
    expect(badge?.style.color).toBe("var(--color-data-negative)");
  });

  it("renders as a <span> element", () => {
    render(<RegimeBadge regime="BULL" />);
    const el = screen.getByText("BULL");
    expect(el.tagName).toBe("SPAN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. NumberMorph — renders the formatted value string
// ─────────────────────────────────────────────────────────────────────────────

describe("NumberMorph", () => {
  it("renders the display element", () => {
    render(<NumberMorph value={42.5} />);
    expect(screen.getByTestId("number-morph-display")).toBeInTheDocument();
  });

  it("renders the formatted value with 2 decimals by default", () => {
    render(<NumberMorph value={42.5} />);
    const el = screen.getByTestId("number-morph-display");
    expect(el.textContent).toContain("42.50");
  });

  it("respects custom decimals", () => {
    render(<NumberMorph value={3.14159} decimals={3} />);
    const el = screen.getByTestId("number-morph-display");
    expect(el.textContent).toContain("3.142");
  });

  it("renders prefix and suffix", () => {
    render(<NumberMorph value={100} prefix="₹" suffix=" INR" />);
    const el = screen.getByTestId("number-morph-display");
    expect(el.textContent).toContain("₹");
    expect(el.textContent).toContain("INR");
  });

  it("renders as a <span> element", () => {
    render(<NumberMorph value={1} />);
    const el = screen.getByTestId("number-morph-display");
    expect(el.tagName).toBe("SPAN");
  });

  it("applies tabular-nums class", () => {
    render(<NumberMorph value={1} />);
    expect(screen.getByTestId("number-morph-display")).toHaveClass("tabular-nums");
  });
});
