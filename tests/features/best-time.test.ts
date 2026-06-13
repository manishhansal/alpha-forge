import { describe, expect, it } from "vitest";

import {
  DAY_RECOMMENDATIONS,
  formatDuration,
  formatWindowRange,
  getBestTimeStatus,
  getOverlappingWindows,
  QUALITY_TOKENS,
  STYLE_RECOMMENDATIONS,
  TRADING_WINDOWS,
  toIstParts,
} from "@/features/best-time/engine";

/**
 * Construct a Date that lands on the requested IST wall-clock minute on a
 * given UTC weekday. We pick the UTC origin that, after the +5:30 IST shift,
 * lands on `dayOfWeek` so the engine resolves the desired day.
 */
function istDate(opts: {
  hour: number;
  minute?: number;
  dayOfWeek?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}): Date {
  const { hour, minute = 0, dayOfWeek = 3 } = opts;
  // UTC day 0..6 — find a UTC date whose +5:30 shift lands on dayOfWeek.
  // 2024-01-03 is a Wednesday in UTC -> after +5:30 = Wednesday in IST.
  const baseByDay: Record<number, [number, number, number]> = {
    0: [2024, 0, 7], // Sun
    1: [2024, 0, 1], // Mon
    2: [2024, 0, 2], // Tue
    3: [2024, 0, 3], // Wed
    4: [2024, 0, 4], // Thu
    5: [2024, 0, 5], // Fri
    6: [2024, 0, 6], // Sat
  };
  const [y, m, d] = baseByDay[dayOfWeek];
  // Convert IST wall-clock to UTC by subtracting 5:30.
  const utcMinutes = hour * 60 + minute - (5 * 60 + 30);
  const ms = Date.UTC(y, m, d, 0, 0, 0) + utcMinutes * 60_000;
  return new Date(ms);
}

describe("features/best-time/engine", () => {
  describe("toIstParts()", () => {
    it("shifts UTC midnight to 05:30 IST", () => {
      const parts = toIstParts(new Date(Date.UTC(2024, 0, 3, 0, 0)));
      expect(parts.hour).toBe(5);
      expect(parts.minute).toBe(30);
      expect(parts.minuteOfDay).toBe(330);
    });

    it("rolls past midnight in IST when UTC is late evening", () => {
      // 19:00 UTC + 5:30 = 00:30 IST next day.
      const parts = toIstParts(new Date(Date.UTC(2024, 0, 3, 19, 0)));
      expect(parts.hour).toBe(0);
      expect(parts.minute).toBe(30);
    });

    it("returns dayOfWeek in [0..6]", () => {
      const parts = toIstParts(new Date());
      expect(parts.dayOfWeek).toBeGreaterThanOrEqual(0);
      expect(parts.dayOfWeek).toBeLessThanOrEqual(6);
    });
  });

  describe("TRADING_WINDOWS catalogue", () => {
    it("contains all six expected windows with valid bounds", () => {
      const slugs = TRADING_WINDOWS.map((w) => w.slug);
      expect(slugs).toEqual(
        expect.arrayContaining(["worst", "range", "breakout", "prime", "golden", "swing"]),
      );
      for (const w of TRADING_WINDOWS) {
        expect(w.startMin).toBeGreaterThanOrEqual(0);
        expect(w.endMin).toBeGreaterThan(w.startMin);
        expect(w.endMin).toBeLessThanOrEqual(1440);
        expect(w.styles.length).toBeGreaterThan(0);
        expect(w.insight).not.toBe("");
      }
    });

    it("Golden has the strictly highest priority (5 > everything else)", () => {
      const golden = TRADING_WINDOWS.find((w) => w.slug === "golden")!;
      const others = TRADING_WINDOWS.filter((w) => w.slug !== "golden");
      for (const o of others) {
        expect(golden.priority).toBeGreaterThan(o.priority);
      }
    });
  });

  describe("DAY_RECOMMENDATIONS", () => {
    it("covers all seven weekdays exactly once", () => {
      const days = DAY_RECOMMENDATIONS.map((d) => d.day);
      expect(days.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("rates Tue/Wed/Thu as 'ideal'", () => {
      for (const target of [2, 3, 4]) {
        const d = DAY_RECOMMENDATIONS.find((x) => x.day === target)!;
        expect(d.quality).toBe("ideal");
      }
    });
  });

  describe("STYLE_RECOMMENDATIONS", () => {
    it("matches each style to a known window slug", () => {
      const slugs = new Set(TRADING_WINDOWS.map((w) => w.slug));
      slugs.add("off");
      for (const s of STYLE_RECOMMENDATIONS) {
        expect(slugs.has(s.matches)).toBe(true);
      }
    });
  });

  describe("getOverlappingWindows()", () => {
    it("returns the Worst Zone in the early morning", () => {
      // 03:00 IST = 180 minutes
      const out = getOverlappingWindows(180);
      expect(out.map((w) => w.slug)).toContain("worst");
    });

    it("returns Golden + Prime around 8:30 PM IST", () => {
      // 20:30 IST = 1230
      const slugs = getOverlappingWindows(1230).map((w) => w.slug);
      expect(slugs).toContain("golden");
      expect(slugs).toContain("prime");
    });

    it("is sorted by priority descending (Golden first when overlapping)", () => {
      const out = getOverlappingWindows(1230);
      for (let i = 1; i < out.length; i += 1) {
        expect(out[i - 1].priority).toBeGreaterThanOrEqual(out[i].priority);
      }
    });

    it("returns an empty array deep in the off-hours", () => {
      // 01:00 IST = 60 — covered by no window (Worst starts at 02:00).
      expect(getOverlappingWindows(60)).toHaveLength(0);
    });
  });

  describe("getBestTimeStatus()", () => {
    it("returns the Golden window at 8 PM IST on a Wednesday", () => {
      const at = istDate({ hour: 20, dayOfWeek: 3 });
      const status = getBestTimeStatus(at);
      expect(status.active.slug).toBe("golden");
      expect(status.istTime).toBe("20:00");
      expect(status.istDay.day).toBe(3);
      expect(status.score).toBeGreaterThanOrEqual(85);
      expect(status.verdict).toMatch(/ideal|strong/i);
    });

    it("falls back to OFF when no window applies", () => {
      const at = istDate({ hour: 1, minute: 0, dayOfWeek: 3 });
      const status = getBestTimeStatus(at);
      expect(status.active.slug).toBe("off");
      expect(status.activeEndsInMinutes).toBeNull();
    });

    it("computes a non-null activeEndsInMinutes for finite windows", () => {
      const at = istDate({ hour: 19, minute: 30, dayOfWeek: 3 });
      const status = getBestTimeStatus(at);
      expect(status.activeEndsInMinutes).toBeGreaterThan(0);
    });

    it("publishes a nextWindow when an upgrade exists later today", () => {
      // 18:00 IST = breakout starts; golden upgrade follows at 19:00.
      const at = istDate({ hour: 17, minute: 0, dayOfWeek: 3 });
      const status = getBestTimeStatus(at);
      expect(status.nextWindow).not.toBeNull();
      expect(status.nextWindow?.startsInMinutes).toBeGreaterThan(0);
    });

    it("scales the score down on a Sunday", () => {
      const wed = getBestTimeStatus(istDate({ hour: 20, dayOfWeek: 3 }));
      const sun = getBestTimeStatus(istDate({ hour: 20, dayOfWeek: 0 }));
      expect(sun.score).toBeLessThan(wed.score);
    });

    it("score is always clamped to [0, 100]", () => {
      for (let h = 0; h < 24; h += 2) {
        for (let d = 0; d < 7; d += 1) {
          const s = getBestTimeStatus(
            istDate({ hour: h, dayOfWeek: d as 0 | 1 | 2 | 3 | 4 | 5 | 6 }),
          ).score;
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(100);
        }
      }
    });

    it("uses the Worst verdict during the avoid window", () => {
      const at = istDate({ hour: 3, dayOfWeek: 3 });
      const status = getBestTimeStatus(at);
      expect(status.active.slug).toBe("worst");
      expect(status.verdict).toMatch(/avoid/i);
    });

    it("publishes computedAt as a parseable ISO timestamp", () => {
      const at = istDate({ hour: 12, dayOfWeek: 3 });
      const status = getBestTimeStatus(at);
      expect(new Date(status.computedAt).getTime()).toBe(at.getTime());
    });
  });

  describe("formatDuration()", () => {
    it("returns 'soon' for sub-1 minutes / non-finite", () => {
      expect(formatDuration(0)).toBe("soon");
      expect(formatDuration(0.5)).toBe("soon");
      expect(formatDuration(Number.NaN)).toBe("soon");
    });

    it("formats minute-only ranges", () => {
      expect(formatDuration(45)).toBe("45m");
    });

    it("formats hour-only ranges", () => {
      expect(formatDuration(60)).toBe("1h");
      expect(formatDuration(120)).toBe("2h");
    });

    it("formats hours-and-minutes ranges", () => {
      expect(formatDuration(84)).toBe("1h 24m");
    });
  });

  describe("formatWindowRange()", () => {
    it("renders 12-hour AM/PM IST labels", () => {
      const w = TRADING_WINDOWS.find((x) => x.slug === "golden")!;
      expect(formatWindowRange(w)).toMatch(/IST$/);
      expect(formatWindowRange(w)).toMatch(/PM/);
    });
  });

  describe("QUALITY_TOKENS", () => {
    it("publishes a token bag for every quality bucket", () => {
      for (const q of ["ideal", "good", "moderate", "off", "poor"] as const) {
        const t = QUALITY_TOKENS[q];
        expect(t).toBeDefined();
        expect(t.text).toMatch(/text-/);
        expect(["bull", "bear", "warning", "info", "neutral"]).toContain(t.badge);
      }
    });
  });
});
