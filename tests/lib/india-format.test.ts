import { describe, expect, it } from "vitest";

import { roundToNseTick } from "@/lib/india/format";

describe("lib/india/format — roundToNseTick", () => {
  it("rounds to the nearest 0.05 NSE tick by default", () => {
    expect(roundToNseTick(2000.07)).toBeCloseTo(2000.05, 5);
    expect(roundToNseTick(2000.08)).toBeCloseTo(2000.1, 5);
    expect(roundToNseTick(2000.0)).toBeCloseTo(2000.0, 5);
    expect(roundToNseTick(99.99)).toBeCloseTo(100.0, 5);
  });

  it("honours a custom tick size (e.g. index points)", () => {
    expect(roundToNseTick(22013.3, 1)).toBeCloseTo(22013, 5);
    expect(roundToNseTick(22013.6, 1)).toBeCloseTo(22014, 5);
  });

  it("returns the input unchanged for non-finite / non-positive ticks", () => {
    expect(roundToNseTick(123.456, 0)).toBeCloseTo(123.456, 5);
    expect(Number.isNaN(roundToNseTick(Number.NaN))).toBe(true);
  });
});
