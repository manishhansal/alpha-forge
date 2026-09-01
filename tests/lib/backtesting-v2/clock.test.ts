/**
 * SimulationClock — deterministic unit tests.
 *
 * Tests: chronological order, IST session boundaries, weekends,
 * holidays, expiry detection, anti-lookahead guard.
 */

import { describe, it, expect } from "vitest";
import {
  SimulationClock,
  isExpiryDay,
  isWeeklyExpiryDay,
  isMonthlyExpiryDay,
  istDateStr,
  toIst,
  NSE_OPEN_MINUTES,
  NSE_CLOSE_MINUTES,
} from "@/lib/backtesting-v2/engine/clock";
import { makeBar, niftyInstrument, istToUtcMs } from "./helpers";
import type { OHLCVBar } from "@/lib/backtesting-v2/events/market-event";

// ── IST helpers ───────────────────────────────────────────────────────────────

describe("toIst / istDateStr", () => {
  it("converts UTC ms to correct IST date", () => {
    // 2024-01-08 03:45 UTC = 2024-01-08 09:15 IST
    const utcMs = Date.UTC(2024, 0, 8, 3, 45);
    const ist = toIst(utcMs);
    expect(ist.year).toBe(2024);
    expect(ist.month).toBe(1);
    expect(ist.day).toBe(8);
    expect(ist.hours).toBe(9);
    expect(ist.minutes).toBe(15);
    expect(ist.totalMinutes).toBe(NSE_OPEN_MINUTES);
  });

  it("istDateStr returns YYYY-MM-DD in IST", () => {
    // 2024-01-08 10:00 UTC = 2024-01-08 15:30 IST
    const utcMs = Date.UTC(2024, 0, 8, 10, 0);
    expect(istDateStr(utcMs)).toBe("2024-01-08");
  });

  it("date crosses midnight in IST: 2024-01-08 18:31 UTC = 2024-01-09 00:01 IST", () => {
    const utcMs = Date.UTC(2024, 0, 8, 18, 31);
    expect(istDateStr(utcMs)).toBe("2024-01-09");
  });
});

// ── Expiry detection ──────────────────────────────────────────────────────────

describe("isExpiryDay", () => {
  it("returns false for equity instrument (no expiry)", () => {
    const instrument = { ...niftyInstrument(), expiry: null };
    const utcMs = istToUtcMs(2024, 1, 25, 15, 30);
    expect(isExpiryDay(utcMs, instrument)).toBe(false);
  });

  it("returns true on expiry date for futures instrument", () => {
    const utcMs = istToUtcMs(2024, 1, 25, 15, 30);
    const instrument = niftyInstrument({ expiry: "2024-01-25" });
    expect(isExpiryDay(utcMs, instrument)).toBe(true);
  });

  it("returns false the day before expiry", () => {
    const utcMs = istToUtcMs(2024, 1, 24, 15, 30);
    const instrument = niftyInstrument({ expiry: "2024-01-25" });
    expect(isExpiryDay(utcMs, instrument)).toBe(false);
  });
});

describe("isWeeklyExpiryDay", () => {
  it("Thursday 2024-01-11 is a NIFTY weekly expiry", () => {
    const utcMs = istToUtcMs(2024, 1, 11, 15, 30); // Thursday
    expect(isWeeklyExpiryDay(utcMs, "NIFTY", new Set())).toBe(true);
  });

  it("Wednesday is not a weekly expiry when Thursday is open", () => {
    const utcMs = istToUtcMs(2024, 1, 10, 15, 30); // Wednesday
    expect(isWeeklyExpiryDay(utcMs, "NIFTY", new Set())).toBe(false);
  });

  it("Wednesday becomes expiry when Thursday is a holiday", () => {
    const utcMs = istToUtcMs(2024, 1, 10, 15, 30); // Wednesday
    const holidays = new Set(["2024-01-11"]); // Thursday is holiday
    expect(isWeeklyExpiryDay(utcMs, "NIFTY", holidays)).toBe(true);
  });

  it("equity symbol (RELIANCE) is never a weekly expiry", () => {
    const utcMs = istToUtcMs(2024, 1, 11, 15, 30);
    expect(isWeeklyExpiryDay(utcMs, "RELIANCE")).toBe(false);
  });
});

describe("isMonthlyExpiryDay", () => {
  it("last Thursday of January 2024 is 2024-01-25", () => {
    const utcMs = istToUtcMs(2024, 1, 25, 15, 30);
    expect(isMonthlyExpiryDay(utcMs, new Set())).toBe(true);
  });

  it("second Thursday of January 2024 (2024-01-11) is NOT monthly expiry", () => {
    const utcMs = istToUtcMs(2024, 1, 11, 15, 30);
    expect(isMonthlyExpiryDay(utcMs, new Set())).toBe(false);
  });
});

// ── Clock chronological order enforcement ─────────────────────────────────────

describe("SimulationClock ordering", () => {
  it("throws if bars are not in strict chronological order", () => {
    const clock = new SimulationClock({ filterToSession: false, filterWeekends: false, filterHolidays: false });
    const instrument = niftyInstrument();
    const bars: OHLCVBar[] = [
      { openMs: 2000, closeMs: 2999, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { openMs: 1000, closeMs: 1999, open: 100, high: 101, low: 99, close: 100, volume: 1 }, // earlier!
    ];
    expect(() => clock.load(bars, instrument)).toThrow(/chronological/i);
  });

  it("processes bars in insertion order", () => {
    const clock = new SimulationClock({ filterToSession: false, filterWeekends: false, filterHolidays: false });
    const instrument = niftyInstrument();
    const closes = [100, 101, 102];
    const bars: OHLCVBar[] = closes.map((c, i) => ({
      openMs: 1000 + i * 1000,
      closeMs: 1999 + i * 1000,
      open: c,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 100,
    }));

    clock.load(bars, instrument);
    const results = [];
    for (let t = clock.next(); t !== null; t = clock.next()) {
      results.push(t.event.bar.close);
    }
    expect(results).toEqual([100, 101, 102]);
  });
});

// ── Anti-lookahead guard ──────────────────────────────────────────────────────

describe("SimulationClock anti-lookahead", () => {
  function makeClock(n: number) {
    const clock = new SimulationClock({ filterToSession: false, filterWeekends: false, filterHolidays: false });
    const bars: OHLCVBar[] = Array.from({ length: n }, (_, i) => ({
      openMs: 1000 + i * 1000,
      closeMs: 1999 + i * 1000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    clock.load(bars, niftyInstrument());
    return clock;
  }

  it("candleSlice(0) is valid after advancing to bar 0", () => {
    const clock = makeClock(3);
    clock.next(); // bar 0
    expect(() => clock.candleSlice(0)).not.toThrow();
    expect(clock.candleSlice(0)).toHaveLength(1);
  });

  it("candleSlice(1) throws when only bar 0 has been processed", () => {
    const clock = makeClock(3);
    clock.next(); // bar 0
    expect(() => clock.candleSlice(1)).toThrow(/anti-lookahead/i);
  });

  it("candleSlice(N) is valid after advancing N+1 times", () => {
    const clock = makeClock(5);
    for (let i = 0; i < 4; i++) clock.next();
    // currentBarIndex = 3
    expect(() => clock.candleSlice(3)).not.toThrow();
    expect(clock.candleSlice(3)).toHaveLength(4);
  });

  it("barAt() throws for future index", () => {
    const clock = makeClock(3);
    clock.next(); // bar 0
    expect(() => clock.barAt(1)).toThrow(/anti-lookahead/i);
  });
});

// ── Session filtering ─────────────────────────────────────────────────────────

describe("Session filtering", () => {
  it("skips bars outside 09:15–15:30 IST when filterToSession=true", () => {
    const instrument = niftyInstrument();
    const clock = new SimulationClock({ filterToSession: true, filterWeekends: false, filterHolidays: false });

    // Build bars: one at 08:00 IST (outside), one at 10:00 IST (inside), one at 16:00 IST (outside)
    const before = istToUtcMs(2024, 1, 8, 8, 0);
    const during = istToUtcMs(2024, 1, 8, 10, 0);
    const after = istToUtcMs(2024, 1, 8, 16, 0);

    const bars: OHLCVBar[] = [before, during, after].map((openMs) => ({
      openMs,
      closeMs: openMs + 59_999,
      open: 100, high: 101, low: 99, close: 100, volume: 100,
    }));

    clock.load(bars, instrument);
    const ticks = [];
    for (let t = clock.next(); t !== null; t = clock.next()) ticks.push(t);

    // Only the "during" bar should be processed
    expect(ticks).toHaveLength(1);
    expect(ticks[0].event.bar.openMs).toBe(during);
  });

  it("marks isSessionOpen true for the first bar of a new IST day", () => {
    const instrument = niftyInstrument();
    const clock = new SimulationClock({ filterToSession: false, filterWeekends: false, filterHolidays: false });

    const bars: OHLCVBar[] = [
      makeBar({ openMs: istToUtcMs(2024, 1, 8, 9, 15), close: 100 }),
      makeBar({ openMs: istToUtcMs(2024, 1, 8, 9, 16), close: 101 }),
      makeBar({ openMs: istToUtcMs(2024, 1, 9, 9, 15), close: 102 }),
    ];

    clock.load(bars, instrument);
    const ticks = [];
    for (let t = clock.next(); t !== null; t = clock.next()) ticks.push(t);

    expect(ticks[0].isNewSession).toBe(true);  // first bar of day 1
    expect(ticks[1].isNewSession).toBe(false); // same day
    expect(ticks[2].isNewSession).toBe(true);  // first bar of day 2
  });
});
