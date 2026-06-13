import { describe, expect, it } from "vitest";

import {
  DAY_RECOMMENDATIONS,
  formatDuration,
  formatWindowRange,
  getBestTimeStatus,
  getNextTradingSessionOpen,
  getOverlappingWindows,
  STYLE_RECOMMENDATIONS,
  toIstParts,
  TRADING_WINDOWS,
} from "@/features/india/best-time/engine";

function istDate(opts: {
  hour: number;
  minute?: number;
  dayOfWeek?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}): Date {
  const { hour, minute = 0, dayOfWeek = 3 } = opts;
  const baseByDay: Record<number, [number, number, number]> = {
    0: [2024, 0, 7],
    1: [2024, 0, 1],
    2: [2024, 0, 2],
    3: [2024, 0, 3],
    4: [2024, 0, 4],
    5: [2024, 0, 5],
    6: [2024, 0, 6],
  };
  const [y, m, d] = baseByDay[dayOfWeek];
  const utcMinutes = hour * 60 + minute - (5 * 60 + 30);
  return new Date(Date.UTC(y, m, d, 0, 0, 0) + utcMinutes * 60_000);
}

describe("features/india/best-time/engine", () => {
  describe("TRADING_WINDOWS catalogue", () => {
    it("publishes seven NSE-anchored windows", () => {
      // Pre-Open / Opening Vol / Morning Trend / Midday Lull / Afternoon Trend
      // / Power Hour / Closing Auction.
      expect(TRADING_WINDOWS.length).toBe(7);
    });

    it("first window starts at 09:00 (Pre-Open Auction)", () => {
      const sorted = [...TRADING_WINDOWS].sort((a, b) => a.startMin - b.startMin);
      expect(sorted[0].startMin).toBe(9 * 60);
    });

    it("last window ends by 15:40 IST (Closing Auction)", () => {
      const sorted = [...TRADING_WINDOWS].sort((a, b) => a.endMin - b.endMin);
      const last = sorted[sorted.length - 1];
      expect(last.endMin).toBeLessThanOrEqual(15 * 60 + 40);
    });

    it("Power Hour wins priority among intraday windows", () => {
      const power = TRADING_WINDOWS.find((w) => w.label === "Power Hour")!;
      const others = TRADING_WINDOWS.filter((w) => w.label !== "Power Hour");
      for (const o of others) {
        expect(power.priority).toBeGreaterThanOrEqual(o.priority);
      }
    });
  });

  describe("DAY_RECOMMENDATIONS", () => {
    it("Saturday and Sunday are tagged 'off'", () => {
      expect(DAY_RECOMMENDATIONS.find((d) => d.day === 0)?.quality).toBe("off");
      expect(DAY_RECOMMENDATIONS.find((d) => d.day === 6)?.quality).toBe("off");
    });

    it("Tuesday and Wednesday are 'ideal'", () => {
      expect(DAY_RECOMMENDATIONS.find((d) => d.day === 2)?.quality).toBe("ideal");
      expect(DAY_RECOMMENDATIONS.find((d) => d.day === 3)?.quality).toBe("ideal");
    });

    it("Thursday note mentions weekly expiry", () => {
      const thu = DAY_RECOMMENDATIONS.find((d) => d.day === 4);
      expect(thu?.note.toLowerCase()).toContain("expiry");
    });
  });

  describe("STYLE_RECOMMENDATIONS", () => {
    it("every style maps to a known window slug or 'off'", () => {
      const slugs = new Set(TRADING_WINDOWS.map((w) => w.slug));
      slugs.add("off");
      for (const s of STYLE_RECOMMENDATIONS) {
        expect(slugs.has(s.matches)).toBe(true);
      }
    });
  });

  describe("getOverlappingWindows()", () => {
    it("returns Power Hour at 15:15 IST", () => {
      // 15*60+15 = 915
      const slugs = getOverlappingWindows(915).map((w) => w.label);
      expect(slugs).toContain("Power Hour");
    });

    it("returns nothing at 02:00 IST (well outside NSE hours)", () => {
      expect(getOverlappingWindows(120)).toHaveLength(0);
    });
  });

  describe("getBestTimeStatus()", () => {
    it("forces OFF on Saturday regardless of clock", () => {
      const sat = getBestTimeStatus(istDate({ hour: 11, dayOfWeek: 6 }));
      expect(sat.active.slug).toBe("off");
      expect(sat.verdict).toMatch(/closed/i);
    });

    it("forces OFF on Sunday regardless of clock", () => {
      const sun = getBestTimeStatus(istDate({ hour: 11, dayOfWeek: 0 }));
      expect(sun.active.slug).toBe("off");
      expect(sun.verdict).toMatch(/closed/i);
    });

    it("returns Power Hour on a Wednesday at 15:15 IST", () => {
      const status = getBestTimeStatus(istDate({ hour: 15, minute: 15, dayOfWeek: 3 }));
      expect(status.active.label).toBe("Power Hour");
      expect(status.score).toBeGreaterThanOrEqual(85);
    });

    it("publishes Closing Auction with 'avoid' verdict at 15:35", () => {
      const status = getBestTimeStatus(istDate({ hour: 15, minute: 35, dayOfWeek: 3 }));
      expect(status.active.label).toBe("Closing Auction");
      expect(status.verdict).toMatch(/avoid/i);
    });

    it("score is always in [0, 100]", () => {
      for (const h of [9, 10, 12, 14, 15]) {
        for (const d of [1, 2, 3, 4, 5] as const) {
          const s = getBestTimeStatus(istDate({ hour: h, dayOfWeek: d })).score;
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(100);
        }
      }
    });

    it("nextWindow is null on the weekend", () => {
      const status = getBestTimeStatus(istDate({ hour: 11, dayOfWeek: 6 }));
      expect(status.nextWindow).toBeNull();
    });
  });

  describe("getNextTradingSessionOpen()", () => {
    it("returns today's 09:15 IST when called pre-open on a weekday", () => {
      // Wed 08:00 IST — market hasn't opened yet, today's open is still in
      // the future, so `dayLabel` should be "today" and `isOpenNow` false.
      const at = istDate({ hour: 8, dayOfWeek: 3 });
      const next = getNextTradingSessionOpen(at);
      expect(next.dayLabel).toBe("today");
      expect(next.isOpenNow).toBe(false);
      const parts = toIstParts(new Date(next.opensAt));
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(15);
      expect(parts.dayOfWeek).toBe(3);
    });

    it("returns tomorrow's 09:15 IST after the close on a weekday", () => {
      // Tue 16:00 IST — past the close, next session is Wednesday's open.
      const at = istDate({ hour: 16, dayOfWeek: 2 });
      const next = getNextTradingSessionOpen(at);
      expect(next.dayLabel).toBe("tomorrow");
      expect(next.weekdayLabel).toBe("Wednesday");
      expect(next.isOpenNow).toBe(false);
      const parts = toIstParts(new Date(next.opensAt));
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(15);
      expect(parts.dayOfWeek).toBe(3);
    });

    it("rolls Friday afternoon → Monday open, skipping the weekend", () => {
      // Fri 17:00 IST — after-hours; next trading day is Monday.
      const at = istDate({ hour: 17, dayOfWeek: 5 });
      const next = getNextTradingSessionOpen(at);
      expect(next.weekdayLabel).toBe("Monday");
      expect(next.dayLabel).toBe("Monday");
      const parts = toIstParts(new Date(next.opensAt));
      expect(parts.dayOfWeek).toBe(1);
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(15);
    });

    it("rolls Saturday → Monday open", () => {
      const at = istDate({ hour: 11, dayOfWeek: 6 });
      const next = getNextTradingSessionOpen(at);
      expect(next.weekdayLabel).toBe("Monday");
      expect(next.isOpenNow).toBe(false);
    });

    it("rolls Sunday → Monday open", () => {
      const at = istDate({ hour: 11, dayOfWeek: 0 });
      const next = getNextTradingSessionOpen(at);
      expect(next.weekdayLabel).toBe("Monday");
      expect(next.isOpenNow).toBe(false);
    });

    it("flags isOpenNow=true inside the 09:15–15:30 IST cash window", () => {
      // Wednesday 12:00 IST — squarely in-session.
      const next = getNextTradingSessionOpen(istDate({ hour: 12, dayOfWeek: 3 }));
      expect(next.isOpenNow).toBe(true);
    });

    it("returns a UTC ms timestamp that is always strictly after `at`", () => {
      const samples: Date[] = [
        istDate({ hour: 8, dayOfWeek: 1 }),
        istDate({ hour: 16, dayOfWeek: 3 }),
        istDate({ hour: 23, dayOfWeek: 4 }),
        istDate({ hour: 11, dayOfWeek: 6 }),
      ];
      for (const at of samples) {
        const next = getNextTradingSessionOpen(at);
        expect(next.opensAt).toBeGreaterThan(at.getTime());
      }
    });
  });

  describe("formatters", () => {
    it("formatDuration handles common cases", () => {
      expect(formatDuration(0)).toBe("soon");
      expect(formatDuration(45)).toBe("45m");
      expect(formatDuration(120)).toBe("2h");
      expect(formatDuration(150)).toBe("2h 30m");
    });

    it("formatWindowRange ends with 'IST'", () => {
      const w = TRADING_WINDOWS.find((x) => x.label === "Power Hour")!;
      expect(formatWindowRange(w)).toMatch(/IST$/);
    });
  });
});
