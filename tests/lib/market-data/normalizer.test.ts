// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  utcToIst,
  istToUtc,
  toSmartApiDateTime,
  fromSmartApiDateTime,
  parseExpiryToUtcMs,
  normaliseExpiry,
  formatExpiryDmy,
  stripYahooSuffix,
  toYahooSymbol,
  normaliseCandlesFromAngel,
  normaliseCandlesFromUpstox,
  intervalToSmartApi,
  intervalToUpstox,
  intervalToYahoo,
  finiteOrNull,
  paisaToRupee,
} from "@/lib/market-data/normalizer";

import type { AngelCandleTuple } from "@/lib/market-data/normalizer";

// ── UTC ↔ IST conversion ──────────────────────────────────────────────────────

describe("utcToIst()", () => {
  it("adds +05:30 to a UTC timestamp", () => {
    // 2024-01-01 00:00:00 UTC → 2024-01-01 05:30:00 IST
    const result = utcToIst("2024-01-01T00:00:00.000Z");
    expect(result).toBe("2024-01-01T05:30:00.000+05:30");
  });

  it("handles midnight UTC correctly", () => {
    const result = utcToIst("2024-05-28T18:30:00.000Z");
    // 18:30 UTC + 5:30 = 00:00 next day IST
    expect(result).toBe("2024-05-29T00:00:00.000+05:30");
  });

  it("returns input unchanged for unparseable string", () => {
    const bad = "not-a-date";
    expect(utcToIst(bad)).toBe(bad);
  });
});

describe("istToUtc()", () => {
  it("converts a +05:30 offset string to UTC", () => {
    const result = istToUtc("2024-01-01T05:30:00.000+05:30");
    expect(result).toBe("2024-01-01T00:00:00.000Z");
  });

  it("round-trips utcToIst → istToUtc", () => {
    const utcOriginal = "2024-06-15T09:15:00.000Z";
    const roundTripped = istToUtc(utcToIst(utcOriginal));
    expect(roundTripped).toBe(utcOriginal);
  });
});

// ── SmartAPI datetime ─────────────────────────────────────────────────────────

describe("toSmartApiDateTime()", () => {
  it("formats UTC epoch ms as YYYY-MM-DD HH:mm in IST", () => {
    // 2024-01-01 00:00:00 UTC = 2024-01-01 05:30:00 IST
    const utcMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    expect(toSmartApiDateTime(utcMs)).toBe("2024-01-01 05:30");
  });

  it("formats a mid-session IST time correctly", () => {
    // 09:15 IST = 03:45 UTC
    const utcMs = Date.UTC(2024, 0, 15, 3, 45, 0);
    expect(toSmartApiDateTime(utcMs)).toBe("2024-01-15 09:15");
  });
});

describe("fromSmartApiDateTime()", () => {
  it("parses a SmartAPI YYYY-MM-DD HH:mm IST string back to UTC epoch ms", () => {
    // "2024-01-01 05:30" IST = 2024-01-01 00:00 UTC
    const utcMs = fromSmartApiDateTime("2024-01-01 05:30");
    expect(utcMs).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
  });

  it("round-trips toSmartApiDateTime → fromSmartApiDateTime", () => {
    const utcMs = Date.UTC(2024, 4, 28, 6, 0, 0); // 11:30 IST
    const formatted = toSmartApiDateTime(utcMs);
    const parsed = fromSmartApiDateTime(formatted);
    // Allow 1 second tolerance for minute-boundary rounding
    expect(Math.abs(parsed - utcMs)).toBeLessThanOrEqual(60_000);
  });
});

// ── Expiry normalisation ──────────────────────────────────────────────────────

describe("parseExpiryToUtcMs()", () => {
  it("parses SmartAPI format 28MAY2026", () => {
    const ms = parseExpiryToUtcMs("28MAY2026");
    expect(new Date(ms).toISOString().slice(0, 10)).toBe("2026-05-28");
  });

  it("parses NSE canonical format 28-MAY-2026", () => {
    const ms = parseExpiryToUtcMs("28-MAY-2026");
    expect(new Date(ms).toISOString().slice(0, 10)).toBe("2026-05-28");
  });

  it("parses two-digit year 28-MAY-26", () => {
    const ms = parseExpiryToUtcMs("28-MAY-26");
    expect(new Date(ms).toISOString().slice(0, 10)).toBe("2026-05-28");
  });

  it("parses ISO-8601 YYYY-MM-DD passthrough", () => {
    const ms = parseExpiryToUtcMs("2026-05-28");
    expect(new Date(ms).toISOString().slice(0, 10)).toBe("2026-05-28");
  });

  it("returns Infinity for invalid input", () => {
    expect(parseExpiryToUtcMs("not-a-date")).toBe(Infinity);
    expect(parseExpiryToUtcMs("")).toBe(Infinity);
  });
});

describe("normaliseExpiry()", () => {
  it("normalises all formats to YYYY-MM-DD", () => {
    expect(normaliseExpiry("28MAY2026")).toBe("2026-05-28");
    expect(normaliseExpiry("28-MAY-2026")).toBe("2026-05-28");
    expect(normaliseExpiry("28-MAY-26")).toBe("2026-05-28");
    expect(normaliseExpiry("2026-05-28")).toBe("2026-05-28");
  });

  it("returns the input unchanged when it cannot be parsed", () => {
    expect(normaliseExpiry("INVALID")).toBe("INVALID");
  });
});

describe("formatExpiryDmy()", () => {
  it("formats epoch ms to DD-MMM-YYYY", () => {
    const ms = Date.UTC(2026, 4, 28); // May is month index 4
    expect(formatExpiryDmy(ms)).toBe("28-MAY-2026");
  });

  it("zero-pads single-digit days", () => {
    const ms = Date.UTC(2026, 0, 5);
    expect(formatExpiryDmy(ms)).toBe("05-JAN-2026");
  });
});

// ── Symbol helpers ────────────────────────────────────────────────────────────

describe("stripYahooSuffix()", () => {
  it("strips .NS suffix", () => {
    expect(stripYahooSuffix("RELIANCE.NS")).toBe("RELIANCE");
  });

  it("strips .BO suffix", () => {
    expect(stripYahooSuffix("RELIANCE.BO")).toBe("RELIANCE");
  });

  it("is case-insensitive", () => {
    expect(stripYahooSuffix("TCS.ns")).toBe("TCS");
  });

  it("returns unchanged symbols without a suffix", () => {
    expect(stripYahooSuffix("RELIANCE")).toBe("RELIANCE");
    expect(stripYahooSuffix("^NSEI")).toBe("^NSEI");
  });
});

describe("toYahooSymbol()", () => {
  it("appends .NS to plain NSE symbols", () => {
    expect(toYahooSymbol("RELIANCE")).toBe("RELIANCE.NS");
    expect(toYahooSymbol("INFY")).toBe("INFY.NS");
  });

  it("leaves index proxy symbols unchanged", () => {
    expect(toYahooSymbol("^NSEI")).toBe("^NSEI");
    expect(toYahooSymbol("^NSEBANK")).toBe("^NSEBANK");
  });

  it("leaves already-suffixed symbols unchanged", () => {
    expect(toYahooSymbol("RELIANCE.NS")).toBe("RELIANCE.NS");
  });
});

// ── Candle normalisation ──────────────────────────────────────────────────────

describe("normaliseCandlesFromAngel()", () => {
  const validTuple: AngelCandleTuple = [
    "2024-01-15 09:15", // IST
    100.0, 105.0, 99.5, 103.0, 12345,
  ];

  it("converts IST timestamp to UTC epoch seconds", () => {
    const candles = normaliseCandlesFromAngel([validTuple]);
    expect(candles).toHaveLength(1);
    // "2024-01-15 09:15" is IST. Node.js parses this as local-time.
    // On this machine Date.parse gives the local interpretation; we then
    // subtract IST_OFFSET (5.5h) to get true UTC.
    // The concrete UTC time for 09:15 IST = 03:45 UTC on 2024-01-15.
    const rawMs = Date.parse("2024-01-15 09:15");
    const expectedUtcSec = Math.floor((rawMs - 5.5 * 60 * 60 * 1_000) / 1_000);
    expect(candles[0]!.time).toBe(expectedUtcSec);
  });

  it("maps OHLCV fields correctly", () => {
    const [c] = normaliseCandlesFromAngel([validTuple]);
    expect(c!.open).toBe(100.0);
    expect(c!.high).toBe(105.0);
    expect(c!.low).toBe(99.5);
    expect(c!.close).toBe(103.0);
    expect(c!.volume).toBe(12345);
  });

  it("silently skips rows with insufficient length", () => {
    const short = ["2024-01-15 09:15", 100] as unknown as AngelCandleTuple;
    expect(normaliseCandlesFromAngel([short])).toHaveLength(0);
  });

  it("silently skips rows with non-finite OHLC values", () => {
    const bad: AngelCandleTuple = ["2024-01-15 09:15", NaN, 105, 99, 103, 100];
    expect(normaliseCandlesFromAngel([bad])).toHaveLength(0);
  });

  it("processes multiple valid rows", () => {
    const tuples: AngelCandleTuple[] = [
      ["2024-01-15 09:15", 100, 105, 99, 103, 1000],
      ["2024-01-15 09:20", 103, 108, 102, 107, 2000],
    ];
    expect(normaliseCandlesFromAngel(tuples)).toHaveLength(2);
  });
});

describe("normaliseCandlesFromUpstox()", () => {
  it("parses UTC ISO-8601 timestamps", () => {
    const rows = [
      { timestamp: "2024-01-15T03:45:00+05:30", open: 100, high: 105, low: 99, close: 103, volume: 500 },
    ];
    const candles = normaliseCandlesFromUpstox(rows);
    expect(candles).toHaveLength(1);
    expect(candles[0]!.open).toBe(100);
  });

  it("includes OI when present", () => {
    const rows = [
      { timestamp: "2024-01-15T09:15:00Z", open: 100, high: 105, low: 99, close: 103, volume: 500, oi: 12000 },
    ];
    const [c] = normaliseCandlesFromUpstox(rows);
    expect(c!.oi).toBe(12000);
  });

  it("skips rows with invalid timestamps", () => {
    const rows = [
      { timestamp: "not-a-date", open: 100, high: 105, low: 99, close: 103, volume: 0 },
    ];
    expect(normaliseCandlesFromUpstox(rows)).toHaveLength(0);
  });
});

// ── Interval mapping ──────────────────────────────────────────────────────────

describe("intervalToSmartApi()", () => {
  it("maps supported intervals correctly", () => {
    expect(intervalToSmartApi("1m")).toBe("ONE_MINUTE");
    expect(intervalToSmartApi("5m")).toBe("FIVE_MINUTE");
    expect(intervalToSmartApi("15m")).toBe("FIFTEEN_MINUTE");
    expect(intervalToSmartApi("30m")).toBe("THIRTY_MINUTE");
    expect(intervalToSmartApi("1h")).toBe("ONE_HOUR");
    expect(intervalToSmartApi("1d")).toBe("ONE_DAY");
  });

  it("returns null for unsupported intervals (1w, 1M)", () => {
    expect(intervalToSmartApi("1w")).toBeNull();
    expect(intervalToSmartApi("1M")).toBeNull();
  });
});

describe("intervalToUpstox()", () => {
  it("maps daily and weekly intervals", () => {
    expect(intervalToUpstox("1d")).toBe("day");
    expect(intervalToUpstox("1w")).toBe("week");
    expect(intervalToUpstox("1M")).toBe("month");
  });
});

describe("intervalToYahoo()", () => {
  it("maps weekly to 1wk", () => {
    expect(intervalToYahoo("1w")).toBe("1wk");
  });
  it("maps monthly to 1mo", () => {
    expect(intervalToYahoo("1M")).toBe("1mo");
  });
  it("maps 3m (unsupported on Yahoo) to 5m", () => {
    expect(intervalToYahoo("3m")).toBe("5m");
  });
});

// ── Number helpers ────────────────────────────────────────────────────────────

describe("finiteOrNull()", () => {
  it("returns the value when finite", () => {
    expect(finiteOrNull(42.5)).toBe(42.5);
    expect(finiteOrNull(0)).toBe(0);
    expect(finiteOrNull(-100)).toBe(-100);
  });

  it("returns null for non-finite numbers", () => {
    expect(finiteOrNull(NaN)).toBeNull();
    expect(finiteOrNull(Infinity)).toBeNull();
    expect(finiteOrNull(-Infinity)).toBeNull();
  });

  it("returns null for non-number values", () => {
    expect(finiteOrNull("42")).toBeNull();
    expect(finiteOrNull(null)).toBeNull();
    expect(finiteOrNull(undefined)).toBeNull();
  });
});

describe("paisaToRupee()", () => {
  it("divides paisa by 100", () => {
    expect(paisaToRupee(245_000)).toBe(2450);
    expect(paisaToRupee(100)).toBe(1);
    expect(paisaToRupee(0)).toBe(0);
  });
});
