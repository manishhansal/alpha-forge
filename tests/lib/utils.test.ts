import { describe, expect, it } from "vitest";

import {
  classifyChange,
  cn,
  formatCompact,
  formatPercent,
  formatPrice,
  formatUsd,
} from "@/lib/utils";

describe("lib/utils", () => {
  describe("cn()", () => {
    it("merges class names with twMerge", () => {
      expect(cn("px-2", "px-4")).toBe("px-4");
    });

    it("supports conditional / falsy values", () => {
      expect(cn("a", false && "b", null, undefined, "c")).toBe("a c");
    });

    it("handles arrays and objects", () => {
      expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
    });

    it("returns an empty string for no arguments", () => {
      expect(cn()).toBe("");
    });
  });

  describe("formatCompact()", () => {
    it("renders large numbers in compact notation", () => {
      expect(formatCompact(1_500_000)).toBe("1.5M");
      expect(formatCompact(1_200_000_000)).toBe("1.2B");
    });

    it("returns an em-dash for non-finite inputs", () => {
      expect(formatCompact(Number.NaN)).toBe("—");
      expect(formatCompact(Infinity)).toBe("—");
    });

    it("renders small integers as-is", () => {
      expect(formatCompact(42)).toBe("42");
    });
  });

  describe("formatPrice()", () => {
    it("uses 2 fractional digits for prices ≥ 1000", () => {
      expect(formatPrice(45_678.123)).toBe("45,678.12");
    });

    it("uses 4 fractional digits for prices in [1, 1000)", () => {
      expect(formatPrice(1.23456)).toBe("1.2346");
    });

    it("uses 6 fractional digits for sub-1 prices", () => {
      expect(formatPrice(0.000123456)).toBe("0.000123");
    });

    it("respects explicit fractionDigits options", () => {
      expect(
        formatPrice(1234.5678, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
      ).toBe("1,235");
    });

    it("returns an em-dash for non-finite", () => {
      expect(formatPrice(Number.NaN)).toBe("—");
    });
  });

  describe("formatPercent()", () => {
    it("prepends a + sign for positive values", () => {
      expect(formatPercent(2.5)).toBe("+2.50%");
    });

    it("preserves the negative sign", () => {
      expect(formatPercent(-1.234)).toBe("-1.23%");
    });

    it("renders zero without a sign", () => {
      expect(formatPercent(0)).toBe("0.00%");
    });

    it("respects custom precision", () => {
      expect(formatPercent(3.14159, 4)).toBe("+3.1416%");
    });

    it("returns an em-dash for non-finite", () => {
      expect(formatPercent(Number.NaN)).toBe("—");
    });
  });

  describe("formatUsd()", () => {
    it("prepends a $ sign", () => {
      expect(formatUsd(1234.5)).toBe("$1,234.50");
    });

    it("returns em-dash for non-finite", () => {
      expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
    });
  });

  describe("classifyChange()", () => {
    it("returns 'bull' above the +5bps threshold", () => {
      expect(classifyChange(0.06)).toBe("bull");
      expect(classifyChange(10)).toBe("bull");
    });

    it("returns 'bear' below the -5bps threshold", () => {
      expect(classifyChange(-0.06)).toBe("bear");
      expect(classifyChange(-99)).toBe("bear");
    });

    it("returns 'neutral' inside [-0.05, 0.05]", () => {
      expect(classifyChange(0)).toBe("neutral");
      expect(classifyChange(0.05)).toBe("neutral");
      expect(classifyChange(-0.05)).toBe("neutral");
    });
  });
});
