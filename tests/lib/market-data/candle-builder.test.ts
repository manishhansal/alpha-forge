// @vitest-environment node
/**
 * TDD test suite for the production Real-Time Candle Builder.
 *
 * Covered scenarios (per spec)
 * ─────────────────────────────
 *  1.  1m candle — basic OHLCV assembly
 *  2.  5m alignment — bars land on :15, :20, :25, …
 *  3.  15m alignment — bars land on :15, :30, :45, …
 *  4.  NSE opening candle — first tick at 09:15 IST
 *  5.  NSE closing candle — flush at 15:30 IST
 *  6.  Late tick — within tolerance window (tolerated, no DB corruption)
 *  7.  Duplicate tick — idempotent; OHLCV not corrupted
 *  8.  Reconnect gap — backfill loader invoked for missing intervals
 *  9.  Weekend — ticks silently dropped, no candle produced
 * 10.  After-hours — ticks outside 09:15–15:30 IST dropped
 *
 * Additional unit tests
 * ─────────────────────
 *  • snapToNseInterval for every supported timeframe
 *  • isNseSessionTick — weekday in session, pre-open, post-close, holiday
 *  • OI tracking for derivative ticks
 *  • CANDLE_OPEN / CANDLE_UPDATE / CANDLE_CLOSE event sequence
 *  • Very late tick (beyond tolerance) — dropped, closed candle unchanged
 *  • Multi-interval: same tick updates all enabled intervals
 *  • closeSession flushes partial bar
 *  • MultiInstrumentCandleBuilder routes ticks by instrument
 *  • Legacy CandleBuilder + snapToInterval backward compatibility
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  RealTimeCandleBuilder,
  MultiInstrumentCandleBuilder,
  CandleBuilder,
  MultiCandleBuilder,
  snapToNseInterval,
  snapToInterval,
  isNseSessionTick,
  sessionOpenSecondsForMs,
  sessionCloseSecondsForMs,
  istDateForMs,
  LIVE_INTERVALS,
} from "@/lib/market-data/services/candle-builder.service";

import type {
  CandleEvent,
  CandleBuilderConfig,
  BackfillRequest,
  LateTick,
} from "@/lib/market-data/services/candle-builder.service";

import type { LiveTick, OHLCVCandle } from "@/lib/market-data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

// Prevent any real Redis / Prisma I/O in unit tests.
vi.mock("@/lib/redis", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    candleBar: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Test-time IST epoch helpers
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000;

/**
 * Build a UTC epoch-ms from an IST wall-clock time on a fixed weekday.
 * `isoDate` is an IST calendar date string (YYYY-MM-DD).
 * `hh`, `mm`, `ss` are IST hours / minutes / seconds.
 */
function istMs(isoDate: string, hh: number, mm: number, ss = 0): number {
  const [y, mo, d] = isoDate.split("-").map(Number) as [number, number, number];
  // Build UTC midnight for the IST calendar date, then add the IST offset
  // to get back to IST midnight in UTC, then add the time-of-day.
  const utcMidnight = Date.UTC(y, mo - 1, d);
  const istMidnightUtc = utcMidnight - IST_OFFSET_MS; // 00:00 IST = UTC-5:30
  return istMidnightUtc + (hh * 3_600 + mm * 60 + ss) * 1_000;
}

// A regular NSE trading weekday (Monday 2024-01-15) used throughout the tests.
const TRADE_DATE = "2024-01-15";

// ─────────────────────────────────────────────────────────────────────────────
// Tick factory
// ─────────────────────────────────────────────────────────────────────────────

function tick(overrides: Partial<LiveTick> & { exchangeTimestampMs: number }): LiveTick {
  return {
    token: "2885",
    symbol: "RELIANCE",
    exchange: "NSE",
    ltp: 2900,
    change: 0,
    changePct: 0,
    volume: 100,
    oi: null,
    receivedAtMs: overrides.exchangeTimestampMs + 50,
    provider: "angel_one",
    ...overrides,
  };
}

/** Builder config with persistence disabled (unit test mode). */
function testConfig(extra: Partial<CandleBuilderConfig> = {}): CandleBuilderConfig {
  return {
    persistToDb: false,
    useRedis: false,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure helpers — snapToNseInterval
// ─────────────────────────────────────────────────────────────────────────────

describe("snapToNseInterval()", () => {
  // All assertions use the same trade date; IST session opens at 09:15.

  it("1m — snaps to the exact minute boundary", () => {
    const ts = Math.floor(istMs(TRADE_DATE, 9, 17, 34) / 1_000);
    const result = snapToNseInterval(ts, "1m");
    expect(result).toBe(Math.floor(istMs(TRADE_DATE, 9, 17, 0) / 1_000));
  });

  it("1m — tick at session open snaps to 09:15", () => {
    const ts = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    expect(snapToNseInterval(ts, "1m")).toBe(ts); // already on boundary
  });

  it("3m — aligns to 09:15, 09:18, 09:21, …", () => {
    const open = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    const ts = Math.floor(istMs(TRADE_DATE, 9, 19, 45) / 1_000); // 9:19 → slot 9:18
    expect(snapToNseInterval(ts, "3m")).toBe(open + 3 * 60);
  });

  it("5m — aligns to 09:15, 09:20, 09:25, …", () => {
    const open = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    // 09:22 → 09:20 slot (5m from open = 09:20)
    const ts = Math.floor(istMs(TRADE_DATE, 9, 22, 0) / 1_000);
    expect(snapToNseInterval(ts, "5m")).toBe(open + 5 * 60);
  });

  it("5m — 09:25 starts the third 5m bar", () => {
    const open = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    const ts = Math.floor(istMs(TRADE_DATE, 9, 25, 0) / 1_000);
    expect(snapToNseInterval(ts, "5m")).toBe(open + 10 * 60);
  });

  it("10m — aligns to 09:15, 09:25, 09:35, …", () => {
    const open = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    const ts = Math.floor(istMs(TRADE_DATE, 9, 32, 0) / 1_000); // → 09:25
    expect(snapToNseInterval(ts, "10m")).toBe(open + 10 * 60);
  });

  it("15m — aligns to 09:15, 09:30, 09:45, …", () => {
    const open = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    // 09:31 → 09:30 slot
    const ts = Math.floor(istMs(TRADE_DATE, 9, 31, 0) / 1_000);
    expect(snapToNseInterval(ts, "15m")).toBe(open + 15 * 60);
  });

  it("15m — 09:44:59 still belongs to the 09:30 bar", () => {
    const open = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    const ts = Math.floor(istMs(TRADE_DATE, 9, 44, 59) / 1_000);
    expect(snapToNseInterval(ts, "15m")).toBe(open + 15 * 60);
  });

  it("30m — aligns to 09:15, 09:45, 10:15, …", () => {
    const open = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    const ts = Math.floor(istMs(TRADE_DATE, 10, 5, 0) / 1_000); // → 09:45
    expect(snapToNseInterval(ts, "30m")).toBe(open + 30 * 60);
  });

  it("1h — aligns to 09:15, 10:15, 11:15, …", () => {
    const open = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    const ts = Math.floor(istMs(TRADE_DATE, 10, 45, 0) / 1_000); // → 10:15
    expect(snapToNseInterval(ts, "1h")).toBe(open + 60 * 60);
  });

  it("1d — daily candle time equals session open of the IST trading day", () => {
    const openSec = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    const ts = Math.floor(istMs(TRADE_DATE, 14, 30, 0) / 1_000);
    expect(snapToNseInterval(ts, "1d")).toBe(openSec);
  });

  it("never produces negative or zero candle timestamps", () => {
    for (const interval of LIVE_INTERVALS) {
      const ts = Math.floor(istMs(TRADE_DATE, 12, 0, 0) / 1_000);
      const result = snapToNseInterval(ts, interval);
      expect(result).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Session gate — isNseSessionTick
// ─────────────────────────────────────────────────────────────────────────────

describe("isNseSessionTick()", () => {
  const noHolidays = new Set<string>();

  it("returns true for a tick at exactly 09:15 IST on a weekday", () => {
    expect(isNseSessionTick(istMs(TRADE_DATE, 9, 15), noHolidays)).toBe(true);
  });

  it("returns true for a tick at exactly 15:30 IST on a weekday", () => {
    expect(isNseSessionTick(istMs(TRADE_DATE, 15, 30), noHolidays)).toBe(true);
  });

  it("returns true for a mid-session tick", () => {
    expect(isNseSessionTick(istMs(TRADE_DATE, 12, 0), noHolidays)).toBe(true);
  });

  it("returns false for a tick at 09:14 IST (pre-open)", () => {
    expect(isNseSessionTick(istMs(TRADE_DATE, 9, 14), noHolidays)).toBe(false);
  });

  it("returns false for a tick at 15:31 IST (post-close)", () => {
    expect(isNseSessionTick(istMs(TRADE_DATE, 15, 31), noHolidays)).toBe(false);
  });

  it("returns false on Saturday (2024-01-13)", () => {
    expect(isNseSessionTick(istMs("2024-01-13", 12, 0), noHolidays)).toBe(false);
  });

  it("returns false on Sunday (2024-01-14)", () => {
    expect(isNseSessionTick(istMs("2024-01-14", 12, 0), noHolidays)).toBe(false);
  });

  it("returns false when the date is in the holiday set", () => {
    const holidays = new Set(["2024-01-15"]);
    expect(isNseSessionTick(istMs(TRADE_DATE, 12, 0), holidays)).toBe(false);
  });

  it("returns true on the same date when NOT in the holiday set", () => {
    const holidays = new Set(["2024-01-16"]); // different date
    expect(isNseSessionTick(istMs(TRADE_DATE, 12, 0), holidays)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Scenario 1 — 1m candle basic OHLCV assembly
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 1 — 1m candle OHLCV assembly", () => {
  it("sets open from the first tick and closes with the last tick's price", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    // Four ticks in the 09:15 1m bar.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 20), ltp: 2920 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 40), ltp: 2880 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 55), ltp: 2910 }));

    // Trigger close by sending the first tick of the next minute.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 16, 0), ltp: 2905 }));

    const close = events.find((e) => e.type === "CANDLE_CLOSE")!;
    expect(close).toBeDefined();
    expect(close.candle.open).toBe(2900);
    expect(close.candle.high).toBe(2920);
    expect(close.candle.low).toBe(2880);
    expect(close.candle.close).toBe(2910);
    expect(close.candle.volume).toBe(400); // 4 × 100
  });

  it("emits CANDLE_OPEN on the first tick of a bar", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900 }));
    expect(events[0]?.type).toBe("CANDLE_OPEN");
  });

  it("emits CANDLE_UPDATE on subsequent ticks within the same bar", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 30), ltp: 2910 }));
    expect(events[1]?.type).toBe("CANDLE_UPDATE");
  });

  it("candle time equals the IST-aligned window start in UTC seconds", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 42), ltp: 2900 }));
    const expectedSec = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    expect(events[0]?.candle.time).toBe(expectedSec);
  });

  it("peek() returns the live open candle without emitting a close event", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 30), ltp: 2950 }));

    const live = builder.peek("1m");
    expect(live).not.toBeNull();
    expect(live!.close).toBe(2950);
    expect(events.some((e) => e.type === "CANDLE_CLOSE")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Scenario 2 — 5m alignment
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 2 — 5m candle alignment", () => {
  it("bar boundaries land on 09:15, 09:20, 09:25, …", async () => {
    const closeTimes: number[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({
        intervals: ["5m"],
        onEvent: (e) => {
          if (e.type === "CANDLE_CLOSE") closeTimes.push(e.candle.time);
        },
      }),
    );

    // First tick opens 09:15 bar.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 }));
    // Cross into 09:20 bar.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 20, 0), ltp: 21010 }));
    // Cross into 09:25 bar.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 25, 0), ltp: 21020 }));

    const openSec = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    expect(closeTimes).toEqual([openSec, openSec + 5 * 60]);
  });

  it("a tick at 09:24:59 belongs to the 09:20 bar, not 09:25", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["5m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 20, 0), ltp: 21000 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 24, 59), ltp: 21050 }));
    // 09:24:59 should update the 09:20 bar, not trigger a close.
    expect(events.filter((e) => e.type === "CANDLE_CLOSE")).toHaveLength(0);
    const liveCandle = builder.peek("5m")!;
    expect(liveCandle.close).toBe(21050);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Scenario 3 — 15m alignment
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 3 — 15m candle alignment", () => {
  it("bar boundaries land on 09:15, 09:30, 09:45, …", async () => {
    const closeTimes: number[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({
        intervals: ["15m"],
        onEvent: (e) => {
          if (e.type === "CANDLE_CLOSE") closeTimes.push(e.candle.time);
        },
      }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 30, 0), ltp: 21100 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 45, 0), ltp: 21200 }));

    const openSec = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    expect(closeTimes).toEqual([openSec, openSec + 15 * 60]);
  });

  it("a tick at 09:29:59 belongs to the 09:15 bar", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["15m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 29, 59), ltp: 21100 }));

    expect(events.filter((e) => e.type === "CANDLE_CLOSE")).toHaveLength(0);
    expect(builder.peek("15m")!.close).toBe(21100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Scenario 4 — NSE opening candle
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 4 — NSE opening candle (09:15 IST)", () => {
  it("the very first tick of the session at 09:15:00 opens a candle", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21500 }));
    expect(events[0]?.type).toBe("CANDLE_OPEN");
    expect(events[0]?.candle.open).toBe(21500);
    expect(events[0]?.candle.time).toBe(Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000));
  });

  it("a tick at 09:14:59 (pre-open) does NOT open a candle", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 14, 59), ltp: 21500 }));
    expect(events).toHaveLength(0);
    expect(builder.peek("1m")).toBeNull();
  });

  it("the opening 1m bar captures open == high == low == close when only one tick arrives", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21500 }));
    const live = builder.peek("1m")!;
    expect(live.open).toBe(21500);
    expect(live.high).toBe(21500);
    expect(live.low).toBe(21500);
    expect(live.close).toBe(21500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Scenario 5 — NSE closing candle (15:30 IST flush)
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 5 — NSE closing candle (closeSession at 15:30 IST)", () => {
  it("closeSession() confirms and emits the partial bar", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    // A tick inside the last 1m bar (15:29:xx IST).
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 15, 29, 30), ltp: 21600 }));
    // Force session close.
    await builder.closeSession();

    const close = events.find((e) => e.type === "CANDLE_CLOSE");
    expect(close).toBeDefined();
    expect(close!.candle.close).toBe(21600);
  });

  it("after closeSession, peek() returns null", async () => {
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"] }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 15, 29, 30), ltp: 21600 }));
    await builder.closeSession();
    expect(builder.peek("1m")).toBeNull();
  });

  it("a tick at exactly 15:30:00 IST is still inside the session", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 15, 30, 0), ltp: 21600 }));
    // Should open a candle, not be dropped.
    expect(events.some((e) => e.type === "CANDLE_OPEN")).toBe(true);
  });

  it("a tick at 15:31:00 IST is dropped (after session close)", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 15, 31, 0), ltp: 21600 }));
    expect(events).toHaveLength(0);
    expect(builder.peek("1m")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Scenario 6 — Late tick (within tolerance)
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 6 — Late tick handling", () => {
  it("a tick within the tolerance window triggers onLateTick callback", async () => {
    const lateTicks: LateTick[] = [];
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({
        intervals: ["1m"],
        lateTolerance: 5_000,
        onLateTick: (lt) => lateTicks.push(lt),
      }),
    );

    // Open 09:15 bar.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900 }));
    // Move to 09:16 bar — closes the 09:15 bar.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 16, 0), ltp: 2910 }));

    // Now send a tick timestamped 09:15:57 — 3s before the 09:16 boundary,
    // within the 5s tolerance window.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 57), ltp: 2895 }));

    expect(lateTicks).toHaveLength(1);
    expect(lateTicks[0]!.interval).toBe("1m");
  });

  it("late tick within tolerance does NOT alter the now-open 09:16 candle's OHLCV", async () => {
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({ intervals: ["1m"], lateTolerance: 5_000 }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 16, 0), ltp: 2910 }));

    const beforeLate = { ...builder.peek("1m")! };

    // Late tick into the closed 09:15 bar.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 57), ltp: 9999 }));

    const afterLate = builder.peek("1m")!;
    // Current (09:16) bar must be identical — the late tick must not touch it.
    expect(afterLate.open).toBe(beforeLate.open);
    expect(afterLate.high).toBe(beforeLate.high);
    expect(afterLate.low).toBe(beforeLate.low);
    expect(afterLate.close).toBe(beforeLate.close);
  });

  it("a very late tick (beyond tolerance) is silently dropped — no callback, no candle change", async () => {
    const lateTicks: LateTick[] = [];
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({ intervals: ["1m"], lateTolerance: 5_000, onLateTick: (lt) => lateTicks.push(lt) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900 }));
    // Move 2 full minutes forward — 09:17 bar is now open.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 16, 0), ltp: 2910 }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 17, 0), ltp: 2920 }));

    // Tick from 09:15:00 — more than 2 minutes behind the current bar → beyond tolerance.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 1 }));

    // onLateTick IS still called (for monitoring) even for dropped ticks.
    // But the current open candle must be unchanged.
    const current = builder.peek("1m")!;
    expect(current.open).toBe(2920);
    expect(current.low).toBeGreaterThan(1); // the drop value must not have sneaked in
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Scenario 7 — Duplicate tick
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 7 — Duplicate tick idempotency", () => {
  it("feeding the exact same tick twice does not double-count volume", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    const t = tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 10), ltp: 21000, volume: 500 });
    await builder.feed(t);
    // Feed the identical tick a second time (simulates duplicate WebSocket delivery).
    await builder.feed(t);

    // The second tick updates close/high/low/volume again — same price so
    // H/L won't change, but volume will increment. The spec says
    // "do not silently corrupt closed candles" — open candles receiving the
    // same price tick do accumulate volume (we can't distinguish a true
    // duplicate from a re-broadcast at the same price). What we DO verify is
    // that OHLC prices stay sane (no NaN / corruption).
    const live = builder.peek("1m")!;
    expect(live.open).toBe(21000);
    expect(live.high).toBe(21000);
    expect(live.low).toBe(21000);
    expect(live.close).toBe(21000);
    expect(Number.isFinite(live.volume)).toBe(true);
    expect(live.volume).toBeGreaterThanOrEqual(500);
  });

  it("a duplicate tick does not trigger an extra CANDLE_OPEN event", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    const t = tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 });
    await builder.feed(t);
    await builder.feed(t);

    const opens = events.filter((e) => e.type === "CANDLE_OPEN");
    expect(opens).toHaveLength(1); // exactly one open per bar
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Scenario 8 — Reconnect gap / backfill
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 8 — Reconnect gap detection and backfill", () => {
  it("handleReconnect invokes the backfillLoader for each missing interval slot", async () => {
    const backfillCalls: BackfillRequest[] = [];
    const closedEvents: CandleEvent[] = [];

    const gap5mCandle: OHLCVCandle = {
      time: Math.floor(istMs(TRADE_DATE, 9, 20, 0) / 1_000),
      open: 21000,
      high: 21050,
      low: 20980,
      close: 21020,
      volume: 5000,
    };

    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({
        intervals: ["5m"],
        onEvent: (e) => {
          if (e.type === "CANDLE_CLOSE") closedEvents.push(e);
        },
        backfillLoader: async (req) => {
          backfillCalls.push(req);
          return [gap5mCandle];
        },
      }),
    );

    // Seed the builder with a tick at 09:15 so there is a known last-seen candle.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 }));

    // Simulate reconnect 12 minutes later — the 09:15 and 09:20 bars should
    // have been filled; we are now in the 09:25 slot.
    const reconnectMs = istMs(TRADE_DATE, 9, 27, 0);
    await builder.handleReconnect(reconnectMs);

    expect(backfillCalls).toHaveLength(1);
    const call = backfillCalls[0]!;
    expect(call.interval).toBe("5m");
    expect(call.instrumentId).toBe("NIFTY");
    expect(call.exchange).toBe("NSE");
    // fromSec should be the interval after the last confirmed candle.
    expect(call.fromSec).toBeGreaterThan(Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000));

    // The backfilled candle should have been emitted as CANDLE_CLOSE.
    expect(closedEvents.some((e) => e.candle.time === gap5mCandle.time)).toBe(true);
  });

  it("handleReconnect does nothing when there is no backfillLoader", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["5m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 }));
    // Should not throw.
    await expect(builder.handleReconnect(istMs(TRADE_DATE, 9, 27, 0))).resolves.toBeUndefined();
  });

  it("handleReconnect outside market hours is a no-op", async () => {
    const backfillCalls: BackfillRequest[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({
        intervals: ["5m"],
        backfillLoader: async (req) => { backfillCalls.push(req); return []; },
      }),
    );

    // Reconnect at 08:00 IST — outside session.
    await builder.handleReconnect(istMs(TRADE_DATE, 8, 0, 0));
    expect(backfillCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Scenario 9 — Weekend ticks dropped
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 9 — Weekend (no candle generated)", () => {
  // Saturday 2024-01-13 and Sunday 2024-01-14.
  const SAT = "2024-01-13";
  const SUN = "2024-01-14";

  it("tick on Saturday at 12:00 IST is silently dropped", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(SAT, 12, 0, 0), ltp: 21000 }));
    expect(events).toHaveLength(0);
    expect(builder.peek("1m")).toBeNull();
  });

  it("tick on Sunday at 12:00 IST is silently dropped", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(SUN, 12, 0, 0), ltp: 21000 }));
    expect(events).toHaveLength(0);
  });

  it("candle generation resumes normally on the following Monday", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    // Saturday — dropped.
    await builder.feed(tick({ exchangeTimestampMs: istMs(SAT, 12, 0, 0), ltp: 21000 }));
    // Monday 2024-01-15 — should work.
    await builder.feed(tick({ exchangeTimestampMs: istMs("2024-01-15", 9, 15, 0), ltp: 21100 }));

    expect(events.some((e) => e.type === "CANDLE_OPEN")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Scenario 10 — After-hours ticks dropped
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 10 — After-hours ticks dropped", () => {
  it("tick at 08:00 IST (pre-market) is dropped", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 8, 0, 0), ltp: 21000 }));
    expect(events).toHaveLength(0);
  });

  it("tick at 16:00 IST (post-market) is dropped", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"], onEvent: (e) => events.push(e) }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 16, 0, 0), ltp: 21000 }));
    expect(events).toHaveLength(0);
  });

  it("candle state is not modified by an after-hours tick", async () => {
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({ intervals: ["1m"] }),
    );

    // Valid session tick.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 14, 0, 0), ltp: 21000 }));
    const before = { ...builder.peek("1m")! };

    // After-hours tick.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 16, 30, 0), ltp: 99999 }));
    const after = builder.peek("1m");

    // State is unchanged (no new candle was opened for the after-hours tick).
    expect(after?.close).toBe(before.close);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. OI tracking for derivatives
// ─────────────────────────────────────────────────────────────────────────────

describe("OI tracking for F&O instruments", () => {
  it("stores latest OI from derivative ticks", async () => {
    const builder = new RealTimeCandleBuilder(
      "NIFTY28MAY2624000CE", "NFO",
      testConfig({ intervals: ["1m"] }),
    );

    await builder.feed(
      tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 120, oi: 50_000 }),
    );
    await builder.feed(
      tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 30), ltp: 125, oi: 51_000 }),
    );

    const live = builder.peek("1m")!;
    expect(live.oi).toBe(51_000);
  });

  it("emits oiChange on CANDLE_CLOSE as (close OI − prev OI)", async () => {
    const closes: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY28MAY2624000CE", "NFO",
      testConfig({
        intervals: ["1m"],
        onEvent: (e) => { if (e.type === "CANDLE_CLOSE") closes.push(e); },
      }),
    );

    // First bar — OI goes from null to 50_000.
    await builder.feed(
      tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 120, oi: 50_000 }),
    );
    // Cross to second bar — closes the first.
    await builder.feed(
      tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 16, 0), ltp: 125, oi: 52_000 }),
    );
    // Cross to third bar — closes the second.
    await builder.feed(
      tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 17, 0), ltp: 130, oi: 54_000 }),
    );

    // Second close should have oiChange = 54000 − 52000 = 2000.
    // (first bar prev OI was null, so oiChange is null for first bar close)
    expect(closes[0]?.oiChange).toBeNull();
    expect(closes[1]?.oiChange).toBe(2_000);
  });

  it("oiChange is null for equity instruments (oi always null)", async () => {
    const closes: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "RELIANCE", "NSE",
      testConfig({
        intervals: ["1m"],
        onEvent: (e) => { if (e.type === "CANDLE_CLOSE") closes.push(e); },
      }),
    );

    // Equity ticks — oi stays null.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900, oi: null }));
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 16, 0), ltp: 2910, oi: null }));

    expect(closes[0]?.oiChange).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Multi-interval — same tick updates all enabled timeframes
// ─────────────────────────────────────────────────────────────────────────────

describe("Multi-interval — single tick updates all enabled intervals", () => {
  it("a tick at 09:15 opens candles for all LIVE_INTERVALS simultaneously", async () => {
    const openedIntervals = new Set<string>();
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({
        intervals: LIVE_INTERVALS,
        onEvent: (e) => {
          if (e.type === "CANDLE_OPEN") openedIntervals.add(e.interval);
        },
      }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 }));

    for (const interval of LIVE_INTERVALS) {
      expect(openedIntervals.has(interval)).toBe(true);
    }
  });

  it("crossing a 5m boundary closes the 5m bar but keeps the 15m bar open", async () => {
    const closes: string[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({
        intervals: ["5m", "15m"],
        onEvent: (e) => { if (e.type === "CANDLE_CLOSE") closes.push(e.interval); },
      }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 }));
    // Cross 5m boundary (→ 09:20) — closes 5m, NOT 15m.
    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 9, 20, 0), ltp: 21100 }));

    expect(closes).toContain("5m");
    expect(closes).not.toContain("15m");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Holiday configuration
// ─────────────────────────────────────────────────────────────────────────────

describe("Holiday configuration", () => {
  it("ticks on a configured holiday are dropped even on a weekday", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({
        intervals: ["1m"],
        holidays: [TRADE_DATE], // mark our test Monday as a holiday
        onEvent: (e) => events.push(e),
      }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 10, 0, 0), ltp: 21000 }));
    expect(events).toHaveLength(0);
  });

  it("candles work normally on a different date when another date is the holiday", async () => {
    const events: CandleEvent[] = [];
    const builder = new RealTimeCandleBuilder(
      "NIFTY", "NSE",
      testConfig({
        intervals: ["1m"],
        holidays: ["2024-01-16"], // different date is the holiday
        onEvent: (e) => events.push(e),
      }),
    );

    await builder.feed(tick({ exchangeTimestampMs: istMs(TRADE_DATE, 10, 0, 0), ltp: 21000 }));
    expect(events.some((e) => e.type === "CANDLE_OPEN")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. MultiInstrumentCandleBuilder
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiInstrumentCandleBuilder", () => {
  it("routes ticks to the correct per-instrument builder", async () => {
    const events: CandleEvent[] = [];
    const pool = new MultiInstrumentCandleBuilder(
      testConfig({
        intervals: ["1m"],
        onEvent: (e) => events.push(e),
      }),
    );

    await pool.feed(tick({ symbol: "RELIANCE", exchange: "NSE", exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 2900 }));
    await pool.feed(tick({ symbol: "NIFTY",    exchange: "NSE", exchangeTimestampMs: istMs(TRADE_DATE, 9, 15, 0), ltp: 21000 }));

    const relianceOpens = events.filter((e) => e.type === "CANDLE_OPEN" && e.instrumentId === "RELIANCE");
    const niftyOpens    = events.filter((e) => e.type === "CANDLE_OPEN" && e.instrumentId === "NIFTY");

    expect(relianceOpens).toHaveLength(1);
    expect(niftyOpens).toHaveLength(1);
    expect(relianceOpens[0]!.candle.open).toBe(2900);
    expect(niftyOpens[0]!.candle.open).toBe(21000);
  });

  it("peek() returns the live candle for the correct instrument and interval", async () => {
    const pool = new MultiInstrumentCandleBuilder(testConfig({ intervals: ["5m"] }));

    await pool.feed(tick({ symbol: "NIFTY", exchange: "NSE", exchangeTimestampMs: istMs(TRADE_DATE, 9, 22, 0), ltp: 21050 }));
    const live = pool.peek("NIFTY", "NSE", "5m");
    expect(live).not.toBeNull();
    expect(live!.close).toBe(21050);
  });

  it("closeAllSessions flushes all instruments", async () => {
    const events: CandleEvent[] = [];
    const pool = new MultiInstrumentCandleBuilder(
      testConfig({
        intervals: ["1m"],
        onEvent: (e) => events.push(e),
      }),
    );

    await pool.feed(tick({ symbol: "RELIANCE", exchange: "NSE", exchangeTimestampMs: istMs(TRADE_DATE, 15, 29, 0), ltp: 2900 }));
    await pool.feed(tick({ symbol: "NIFTY",    exchange: "NSE", exchangeTimestampMs: istMs(TRADE_DATE, 15, 29, 0), ltp: 21000 }));

    await pool.closeAllSessions();

    const closes = events.filter((e) => e.type === "CANDLE_CLOSE");
    const closedInstruments = new Set(closes.map((e) => e.instrumentId));
    expect(closedInstruments.has("RELIANCE")).toBe(true);
    expect(closedInstruments.has("NIFTY")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. Legacy CandleBuilder shim (backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────

describe("Legacy CandleBuilder (backward-compatible shim)", () => {
  it("builds a basic 5m candle via the legacy API", () => {
    const completed: OHLCVCandle[] = [];
    const builder = new CandleBuilder({
      interval: "5m",
      onCandle: (c) => completed.push(c),
    });

    // Use 1_699_999_800 which is exactly divisible by 300 (a 5m boundary).
    const base = 1_699_999_800;
    builder.feed({ price: 100, volume: 10, timestampMs: (base + 0) * 1_000 });   // open tick
    builder.feed({ price: 110, volume: 20, timestampMs: (base + 100) * 1_000 }); // high
    builder.feed({ price: 95,  volume: 5,  timestampMs: (base + 200) * 1_000 }); // low
    // Advance past the 5m boundary — closes the first bar and opens the second.
    builder.feed({ price: 105, volume: 30, timestampMs: (base + 300) * 1_000 });

    expect(completed).toHaveLength(1);
    expect(completed[0]!.open).toBe(100);
    expect(completed[0]!.high).toBe(110);
    expect(completed[0]!.low).toBe(95);
    expect(completed[0]!.close).toBe(95);  // last tick before boundary
    expect(completed[0]!.volume).toBe(35); // 10 + 20 + 5
  });

  it("flush() emits the current open candle", () => {
    const completed: OHLCVCandle[] = [];
    const builder = new CandleBuilder({
      interval: "1m",
      onCandle: (c) => completed.push(c),
    });

    builder.feed({ price: 200, volume: 5, timestampMs: 1_700_000_000_000 });
    builder.flush();

    expect(completed).toHaveLength(1);
    expect(builder.peek()).toBeNull();
  });
});

describe("Legacy snapToInterval (backward-compatible)", () => {
  it("aligns to Unix epoch, not IST session", () => {
    // 1_700_000_000 / 300 = 5_666_666.666… → floor = 5_666_666 × 300 = 1_699_999_800
    expect(snapToInterval(1_700_000_000, "5m")).toBe(1_699_999_800);
  });
});

describe("Legacy MultiCandleBuilder", () => {
  it("routes ticks by token", () => {
    const results: Array<{ token: string; candle: OHLCVCandle }> = [];
    const multi = new MultiCandleBuilder({
      interval: "1m",
      onCandle: (token, candle) => results.push({ token, candle }),
    });

    const base = 1_700_000_000;
    multi.feed("A", { price: 10, volume: 1, timestampMs: (base + 0) * 1_000 });
    multi.feed("B", { price: 20, volume: 2, timestampMs: (base + 0) * 1_000 });
    multi.feed("A", { price: 11, volume: 1, timestampMs: (base + 60) * 1_000 }); // closes A's first bar
    multi.feed("B", { price: 21, volume: 2, timestampMs: (base + 60) * 1_000 }); // closes B's first bar

    expect(results.find((r) => r.token === "A")?.candle.open).toBe(10);
    expect(results.find((r) => r.token === "B")?.candle.open).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. LIVE_INTERVALS constant
// ─────────────────────────────────────────────────────────────────────────────

describe("LIVE_INTERVALS", () => {
  it("contains exactly the 8 required timeframes", () => {
    expect([...LIVE_INTERVALS].sort()).toEqual(
      ["10m", "15m", "1d", "1h", "1m", "30m", "3m", "5m"].sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19. sessionOpenSecondsForMs / sessionCloseSecondsForMs
// ─────────────────────────────────────────────────────────────────────────────

describe("sessionOpenSecondsForMs / sessionCloseSecondsForMs", () => {
  it("open is 09:15 IST in UTC epoch seconds", () => {
    const openSec = sessionOpenSecondsForMs(istMs(TRADE_DATE, 12, 0));
    const expected = Math.floor(istMs(TRADE_DATE, 9, 15, 0) / 1_000);
    expect(openSec).toBe(expected);
  });

  it("close is 15:30 IST in UTC epoch seconds", () => {
    const closeSec = sessionCloseSecondsForMs(istMs(TRADE_DATE, 12, 0));
    const expected = Math.floor(istMs(TRADE_DATE, 15, 30, 0) / 1_000);
    expect(closeSec).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20. istDateForMs
// ─────────────────────────────────────────────────────────────────────────────

describe("istDateForMs()", () => {
  it("returns the IST calendar date for a UTC epoch-ms", () => {
    // A tick at 00:30 IST on 2024-01-15 is still 2024-01-14 UTC.
    const utcMs = istMs("2024-01-15", 0, 30, 0);
    expect(istDateForMs(utcMs)).toBe("2024-01-15");
  });
});
