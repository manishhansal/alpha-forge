import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import * as fc from "fast-check";

// Framer Motion uses animations that require mocking in jsdom
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    useReducedMotion: vi.fn(() => false),
    useMotionValue: (initial: number) => {
      // Return a minimal MotionValue-like object
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
      // Immediately call onUpdate with the target value (0-duration animation)
      opts?.onUpdate?.(target);
      return { stop: vi.fn() };
    },
  };
});

import { NumberMorph, durationFor } from "@/components/trading/NumberMorph";

// ──────────────────────────────────────────────────────────────────────────────
// durationFor — pure-function unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe("durationFor", () => {
  it("returns 240 when prev is 0 (zero-guard)", () => {
    expect(durationFor(0, 100)).toBe(240);
    expect(durationFor(0, 0)).toBe(240);
  });

  it("returns 120 for very small changes (< 1%)", () => {
    // 0.5% change
    expect(durationFor(100, 100.5)).toBe(120);
    expect(durationFor(200, 199.8)).toBe(120);
  });

  it("returns 240 for moderate changes (1–10%)", () => {
    // exactly 1%
    expect(durationFor(100, 101)).toBe(240);
    // 5%
    expect(durationFor(100, 105)).toBe(240);
    // 9.9%
    expect(durationFor(100, 109.9)).toBe(240);
  });

  it("returns 360 for large changes (≥ 10%)", () => {
    // exactly 10%
    expect(durationFor(100, 110)).toBe(360);
    // 50%
    expect(durationFor(100, 150)).toBe(360);
    // negative direction
    expect(durationFor(100, 50)).toBe(360);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// NumberMorph — component render tests
// ──────────────────────────────────────────────────────────────────────────────

describe("NumberMorph", () => {
  it("renders the initial value with default 2 decimals", () => {
    render(<NumberMorph value={42.5} />);
    const el = screen.getByTestId("number-morph-display");
    expect(el).toBeInTheDocument();
    // Initial SSR-like render shows formatted value
    expect(el.textContent).toContain("42.50");
  });

  it("applies the tabular-nums class", () => {
    render(<NumberMorph value={1} />);
    expect(screen.getByTestId("number-morph-display")).toHaveClass("tabular-nums");
  });

  it("applies the --font-data CSS variable inline style", () => {
    render(<NumberMorph value={1} />);
    const el = screen.getByTestId("number-morph-display");
    expect(el.style.fontFamily).toBe("var(--font-data)");
  });

  it("renders prefix and suffix correctly", () => {
    render(<NumberMorph value={99.99} prefix="$" suffix="%" />);
    const el = screen.getByTestId("number-morph-display");
    // animate mock immediately updates textContent with target
    expect(el.textContent).toContain("$");
    expect(el.textContent).toContain("%");
  });

  it("respects custom decimals", () => {
    render(<NumberMorph value={3.14159} decimals={4} />);
    const el = screen.getByTestId("number-morph-display");
    expect(el.textContent).toContain("3.1416");
  });

  it("merges custom className", () => {
    render(<NumberMorph value={1} className="custom-class" />);
    const el = screen.getByTestId("number-morph-display");
    expect(el).toHaveClass("custom-class");
    expect(el).toHaveClass("tabular-nums");
  });

  it("renders 0 decimals correctly", () => {
    render(<NumberMorph value={42} decimals={0} />);
    const el = screen.getByTestId("number-morph-display");
    expect(el.textContent).toContain("42");
  });

  it("renders span element (not div or p)", () => {
    render(<NumberMorph value={1} />);
    const el = screen.getByTestId("number-morph-display");
    expect(el.tagName).toBe("SPAN");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Property 5: NumberMorph animation duration scales with change magnitude
// Feature: trading-ui-overhaul
// Validates: Requirements 16.4
// ──────────────────────────────────────────────────────────────────────────────

describe("Property 5: durationFor scales with change magnitude", () => {
  it("holds for any prev > 0 and any next", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 10_000, noNaN: true }),
        fc.float({ min: 1, max: 10_000, noNaN: true }),
        (prev, next) => {
          const change = Math.abs((next - prev) / prev);
          const result = durationFor(prev, next);
          if (change < 0.01) {
            return result === 120;
          } else if (change < 0.10) {
            return result === 240;
          } else {
            return result === 360;
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("always returns 240 when prev is exactly 0", () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true }),
        (next) => durationFor(0, next) === 240,
      ),
      { numRuns: 100 },
    );
  });
});
