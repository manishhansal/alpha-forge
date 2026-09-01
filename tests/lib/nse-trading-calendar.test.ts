/**
 * NSE Trading Calendar — Unit Tests (Phase 11)
 *
 * Tests comprehensive session boundary logic including holidays,
 * weekends, Muhurat, and the exact 09:15/15:30 IST boundaries.
 */

import { describe, expect, it } from "vitest";
import {
  NSETradingCalendar,
  NSE_HOLIDAYS_2024,
  NSE_MUHURAT_2024,
  SESSION_OPEN_MINUTES,
  SESSION_CLOSE_MINUTES,
  IST_OFFSET_MS,
} from "@/lib/india/nse-trading-calendar";

// ── IST to UTC conversion ─────────────────────────────────────────────────────

/** Build UTC epoch ms for a given IST datetime. */
function istToUtcMs(year: number, month: number, day: number, hour: number, minute: number): number {
  // IST = UTC + 5:30; to convert IST→UTC: subtract 5:30
  return Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MS;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("NSETradingCalendar — weekday session boundaries", () => {
  const cal = new NSETradingCalendar(NSE_HOLIDAYS_2024, NSE_MUHURAT_2024);

  // A regular weekday: Monday 2024-02-05 (not a holiday)
  const DATE = { y: 2024, m: 2, d: 5 };

  it("09:14:59 IST is NOT open (before session open)", () => {
    const utcMs = istToUtcMs(DATE.y, DATE.m, DATE.d, 9, 14);
    expect(cal.isMarketOpen(utcMs)).toBe(false);
  });

  it("09:15:00 IST is open (exact session open)", () => {
    const utcMs = istToUtcMs(DATE.y, DATE.m, DATE.d, 9, 15);
    expect(cal.isMarketOpen(utcMs)).toBe(true);
  });

  it("12:00 IST is open (midday)", () => {
    const utcMs = istToUtcMs(DATE.y, DATE.m, DATE.d, 12, 0);
    expect(cal.isMarketOpen(utcMs)).toBe(true);
  });

  it("15:29:00 IST is open (just before session close)", () => {
    const utcMs = istToUtcMs(DATE.y, DATE.m, DATE.d, 15, 29);
    expect(cal.isMarketOpen(utcMs)).toBe(true);
  });

  it("15:30:00 IST is open (exact session close — inclusive)", () => {
    const utcMs = istToUtcMs(DATE.y, DATE.m, DATE.d, 15, 30);
    expect(cal.isMarketOpen(utcMs)).toBe(true);
  });

  it("15:31:00 IST is NOT open (after session close)", () => {
    const utcMs = istToUtcMs(DATE.y, DATE.m, DATE.d, 15, 31);
    expect(cal.isMarketOpen(utcMs)).toBe(false);
  });
});

describe("NSETradingCalendar — weekends", () => {
  const cal = new NSETradingCalendar();

  it("Saturday is not open", () => {
    // 2024-02-03 = Saturday
    const utcMs = istToUtcMs(2024, 2, 3, 11, 0);
    expect(cal.isMarketOpen(utcMs)).toBe(false);
    const info = cal.getSessionInfo(utcMs);
    expect(info.sessionType).toBe("WEEKEND");
  });

  it("Sunday is not open", () => {
    // 2024-02-04 = Sunday
    const utcMs = istToUtcMs(2024, 2, 4, 11, 0);
    expect(cal.isMarketOpen(utcMs)).toBe(false);
    const info = cal.getSessionInfo(utcMs);
    expect(info.sessionType).toBe("WEEKEND");
  });
});

describe("NSETradingCalendar — NSE holidays", () => {
  const cal = new NSETradingCalendar(NSE_HOLIDAYS_2024);

  it("Republic Day (2024-01-26) is a holiday, not open", () => {
    // 2024-01-26 = Friday
    const utcMs = istToUtcMs(2024, 1, 26, 11, 0);
    expect(cal.isMarketOpen(utcMs)).toBe(false);
    const info = cal.getSessionInfo(utcMs);
    expect(info.sessionType).toBe("HOLIDAY");
  });

  it("Good Friday (2024-03-29) is a holiday", () => {
    const utcMs = istToUtcMs(2024, 3, 29, 11, 0);
    expect(cal.isMarketOpen(utcMs)).toBe(false);
    expect(cal.getSessionInfo(utcMs).sessionType).toBe("HOLIDAY");
  });

  it("a regular Monday after a holiday is open", () => {
    // 2024-01-29 = Monday (day after Republic Day weekend)
    const utcMs = istToUtcMs(2024, 1, 29, 11, 0);
    expect(cal.isMarketOpen(utcMs)).toBe(true);
    expect(cal.getSessionInfo(utcMs).sessionType).toBe("REGULAR");
  });
});

describe("NSETradingCalendar — isTradingDay", () => {
  const cal = new NSETradingCalendar(NSE_HOLIDAYS_2024);

  it("a regular weekday is a trading day", () => {
    expect(cal.isTradingDay("2024-02-05")).toBe(true); // Monday
  });

  it("Saturday is not a trading day", () => {
    expect(cal.isTradingDay("2024-02-03")).toBe(false);
  });

  it("Sunday is not a trading day", () => {
    expect(cal.isTradingDay("2024-02-04")).toBe(false);
  });

  it("NSE holiday is not a trading day", () => {
    expect(cal.isTradingDay("2024-01-26")).toBe(false); // Republic Day
  });
});

describe("NSETradingCalendar — prevTradingDay / nextTradingDay", () => {
  const cal = new NSETradingCalendar(NSE_HOLIDAYS_2024);

  it("prev trading day from Monday = Friday", () => {
    // 2024-02-05 = Monday; prev = 2024-02-02 (Friday)
    expect(cal.prevTradingDay("2024-02-05")).toBe("2024-02-02");
  });

  it("prev trading day from Tuesday after a holiday skips the holiday", () => {
    // 2024-01-27 = Saturday (after Republic Day 26th)
    // 2024-01-29 = Monday; prev = 2024-01-25 (Thursday, before Republic Day)
    expect(cal.prevTradingDay("2024-01-29")).toBe("2024-01-25");
  });

  it("next trading day from Friday = Monday", () => {
    // 2024-02-02 = Friday; next = 2024-02-05 (Monday)
    expect(cal.nextTradingDay("2024-02-02")).toBe("2024-02-05");
  });
});

describe("NSETradingCalendar — isSessionEndedForDate", () => {
  const cal = new NSETradingCalendar();

  it("session ended for a past trading day", () => {
    const yesterday = "2024-01-15";
    const nowMs = Date.now(); // well in the future
    expect(cal.isSessionEndedForDate(yesterday, nowMs)).toBe(true);
  });

  it("session ended returns false at 14:00 IST on the trade date", () => {
    const tradeDate = "2024-02-05";
    const utcMs = istToUtcMs(2024, 2, 5, 14, 0);
    expect(cal.isSessionEndedForDate(tradeDate, utcMs)).toBe(false);
  });

  it("session ended returns true at 15:30 IST on the trade date", () => {
    const tradeDate = "2024-02-05";
    const utcMs = istToUtcMs(2024, 2, 5, 15, 30);
    expect(cal.isSessionEndedForDate(tradeDate, utcMs)).toBe(true);
  });
});

describe("NSETradingCalendar — constants", () => {
  it("SESSION_OPEN_MINUTES is 555 (09:15)", () => {
    expect(SESSION_OPEN_MINUTES).toBe(9 * 60 + 15);
  });

  it("SESSION_CLOSE_MINUTES is 930 (15:30)", () => {
    expect(SESSION_CLOSE_MINUTES).toBe(15 * 60 + 30);
  });

  it("IST_OFFSET_MS is 5.5 hours in ms", () => {
    expect(IST_OFFSET_MS).toBe(5.5 * 60 * 60 * 1_000);
  });
});
