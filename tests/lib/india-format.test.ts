import { describe, expect, it } from "vitest";

import { fmt, fmtCompact, fmtPct, tone } from "@/lib/india/format";

describe("lib/india/format", () => {
  describe("fmt()", () => {
    it("formats with the requested fractional digits", () => {
      expect(fmt(1.2345, 2)).toBe("1.23");
      expect(fmt(1.2345, 4)).toBe("1.2345");
    });

    it("returns em-dash for null / undefined / NaN", () => {
      expect(fmt(null)).toBe("—");
      expect(fmt(undefined)).toBe("—");
      expect(fmt(Number.NaN)).toBe("—");
    });

    it("defaults to 2 fractional digits", () => {
      expect(fmt(3.14159)).toBe("3.14");
    });
  });

  describe("fmtCompact() (Indian numeric notation)", () => {
    it("renders Cr / L / K bands", () => {
      expect(fmtCompact(2.5e7)).toBe("2.50 Cr");
      expect(fmtCompact(2.5e5)).toBe("2.50 L");
      expect(fmtCompact(2_500)).toBe("2.5 K");
      expect(fmtCompact(750)).toBe("750");
    });

    it("respects the sign on negative numbers", () => {
      expect(fmtCompact(-2.5e7)).toBe("-2.50 Cr");
      expect(fmtCompact(-2_500)).toBe("-2.5 K");
    });

    it("handles null / NaN with an em-dash", () => {
      expect(fmtCompact(null)).toBe("—");
      expect(fmtCompact(Number.NaN)).toBe("—");
    });
  });

  describe("fmtPct()", () => {
    it("prepends + on positive values", () => {
      expect(fmtPct(1.234)).toBe("+1.23%");
    });

    it("preserves the negative sign", () => {
      expect(fmtPct(-2.345)).toBe("-2.35%");
    });

    it("returns em-dash for null/NaN", () => {
      expect(fmtPct(null)).toBe("—");
      expect(fmtPct(Number.NaN)).toBe("—");
    });
  });

  describe("tone()", () => {
    it("is 'up' for positive change", () => {
      expect(tone(0.01)).toBe("up");
    });

    it("is 'down' for negative change", () => {
      expect(tone(-0.01)).toBe("down");
    });

    it("is 'flat' for zero / null / NaN", () => {
      expect(tone(0)).toBe("flat");
      expect(tone(null)).toBe("flat");
      expect(tone(Number.NaN)).toBe("flat");
    });
  });
});
