/**
 * NSE Trading Calendar — Unit Tests (Phase 11)
 *
 * Tests comprehensive session boundary logic including holidays,
 * weekends, Muhurat, and the exact 09:15/15:30 IST boundaries.
 * Updated for 2025/2026 holiday calendar (HOLIDAY_CALENDAR_VERSION 2026-v1).
 */

import { describe, expect, it } from "vitest";
import {
  NSETradingCalendar,
  NSE_HOLIDAYS_2024,
  NSE_HOLIDAYS_2025,
  NSE_HOLIDAYS_2026,
  NSE_HOLIDAYS_2024_2026,
  NSE_MUHURAT_2024,
  NSE_MUHURAT_2024_2026,
  HOLIDAY_CALENDAR_VERSION,
  SESSION_OPEN_MINUTES,
  SESSION_CLOSE_MINUTES,
  IST_OFFSET_MS,
  nseCalendar,
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

describe("NSETradingCalendar — NSE holidays 2024", () => {
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

describe("NSETradingCalendar — NSE holidays 2025 (regression: HOLIDAY_CALENDAR_VERSION 2026-v1)", () => {
  const cal = new NSETradingCalendar(NSE_HOLIDAYS_2024_2026, NSE_MUHURAT_2024_2026);

  it("NSE_HOLIDAYS_2025 should contain exactly 14 entries", () => {
    expect(NSE_HOLIDAYS_2025.length).toBe(14);
  });

  it("Holi 2025 (2025-03-14 Friday) is a holiday", () => {
    expect(cal.isTradingDay("2025-03-14")).toBe(false);
    const utcMs = istToUtcMs(2025, 3, 14, 11, 0);
    expect(cal.getSessionInfo(utcMs).sessionType).toBe("HOLIDAY");
  });

  it("Independence Day 2025 (2025-08-15 Friday) is a holiday", () => {
    expect(cal.isTradingDay("2025-08-15")).toBe(false);
  });

  it("Ganesh Chaturthi 2025 (2025-08-27 Wednesday) is a holiday", () => {
    expect(cal.isTradingDay("2025-08-27")).toBe(false);
  });

  it("Diwali Laxmi Pujan 2025 (2025-10-21 Tuesday) is a regular-session holiday", () => {
    // Regular NSE session is closed; Muhurat trading is in the evening
    expect(cal.isTradingDay("2025-10-21")).toBe(false);
    const utcMs = istToUtcMs(2025, 10, 21, 11, 0); // midday — regular session
    expect(cal.getSessionInfo(utcMs).sessionType).toBe("MUHURAT"); // muhurat overrides
  });

  it("Diwali Balipratipada 2025 (2025-10-22 Wednesday) is a holiday", () => {
    expect(cal.isTradingDay("2025-10-22")).toBe(false);
  });

  it("Christmas 2025 (2025-12-25 Thursday) is a holiday", () => {
    expect(cal.isTradingDay("2025-12-25")).toBe(false);
  });

  it("2025-08-28 (Thursday after Ganesh Chaturthi) is a trading day", () => {
    expect(cal.isTradingDay("2025-08-28")).toBe(true);
  });

  it("Republic Day 2025 falls on Sunday — 2025-01-27 (Monday) is a trading day", () => {
    // Jan 26 2025 = Sunday, so no weekday closure
    expect(cal.isTradingDay("2025-01-27")).toBe(true);
  });
});

describe("NSETradingCalendar — NSE holidays 2026 (regression: 20-session validation window)", () => {
  const cal = new NSETradingCalendar(NSE_HOLIDAYS_2024_2026, NSE_MUHURAT_2024_2026);

  it("NSE_HOLIDAYS_2026 should contain exactly 16 entries (15 weekday + Jan 15 election)", () => {
    expect(NSE_HOLIDAYS_2026.length).toBe(16);
  });

  it("Municipal Corporation Election 2026 (2026-01-15 Thursday) is a holiday", () => {
    expect(cal.isTradingDay("2026-01-15")).toBe(false);
  });

  it("Republic Day 2026 (2026-01-26 Monday) is a holiday", () => {
    expect(cal.isTradingDay("2026-01-26")).toBe(false);
  });

  it("Holi 2026 (2026-03-03 Tuesday) is a holiday", () => {
    expect(cal.isTradingDay("2026-03-03")).toBe(false);
  });

  it("Good Friday 2026 (2026-04-03 Friday) is a holiday", () => {
    expect(cal.isTradingDay("2026-04-03")).toBe(false);
  });

  it("Ganesh Chaturthi 2026 (2026-09-14 Monday) is a holiday", () => {
    expect(cal.isTradingDay("2026-09-14")).toBe(false);
  });

  it("Gandhi Jayanti 2026 (2026-10-02 Friday) is a holiday", () => {
    expect(cal.isTradingDay("2026-10-02")).toBe(false);
  });

  it("Dussehra 2026 (2026-10-20 Tuesday) is a holiday", () => {
    expect(cal.isTradingDay("2026-10-20")).toBe(false);
  });

  it("2026-09-01 (Tuesday) is a valid trading day — validation window endpoint", () => {
    expect(cal.isTradingDay("2026-09-01")).toBe(true);
  });

  it("2026-08-14 (Friday) is a valid trading day", () => {
    expect(cal.isTradingDay("2026-08-14")).toBe(true);
  });

  it("Independence Day 2026 (2026-08-15 Saturday) does NOT affect Friday 2026-08-14", () => {
    // Aug 15 falls on Saturday — no weekday closure; Friday 14 is open
    expect(cal.isTradingDay("2026-08-14")).toBe(true);
  });

  it("Muhurat 2026 on Sunday 2026-11-08: session type is MUHURAT in evening", () => {
    const utcMs = istToUtcMs(2026, 11, 8, 18, 30); // 18:30 IST evening
    const info = cal.getSessionInfo(utcMs);
    expect(info.sessionType).toBe("MUHURAT");
  });
});

describe("NSETradingCalendar — global nseCalendar instance uses 2024-2026 holidays", () => {
  it("HOLIDAY_CALENDAR_VERSION is 2026-v1", () => {
    expect(HOLIDAY_CALENDAR_VERSION).toBe("2026-v1");
  });

  it("nseCalendar recognizes 2025 Holi as holiday", () => {
    expect(nseCalendar.isTradingDay("2025-03-14")).toBe(false);
  });

  it("nseCalendar recognizes 2026 Holi as holiday", () => {
    expect(nseCalendar.isTradingDay("2026-03-03")).toBe(false);
  });

  it("nseCalendar correctly identifies 2026-09-01 as a trading day", () => {
    expect(nseCalendar.isTradingDay("2026-09-01")).toBe(true);
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

describe("NSETradingCalendar — 20-session window regression (ends 2026-09-01)", () => {
  // Verify that the 20 sessions identified in the validation window are
  // all correctly flagged as trading days by the multi-year calendar.
  const cal = new NSETradingCalendar(NSE_HOLIDAYS_2024_2026, NSE_MUHURAT_2024_2026);

  const VALIDATION_SESSIONS = [
    "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07",
    "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13",
    "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19",
    "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25",
    "2026-08-26", "2026-08-27", "2026-08-28", "2026-09-01",
  ];

  it("all 20 validation sessions are trading days", () => {
    for (const date of VALIDATION_SESSIONS) {
      expect(cal.isTradingDay(date), `Expected ${date} to be a trading day`).toBe(true);
    }
  });

  it("20 sessions count is exactly 20", () => {
    expect(VALIDATION_SESSIONS.length).toBe(20);
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

