import { describe, expect, it } from "vitest";

import {
  fmtDuration,
  fmtIstClock,
  fmtIstTime,
  roundToNseTick,
} from "@/lib/india/format";

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

describe("lib/india/format — fmtIstTime", () => {
  it("renders epoch ms as IST HH:MM", () => {
    // 2026-06-15T04:00:00Z = 09:30 IST (market open).
    expect(fmtIstTime(Date.UTC(2026, 5, 15, 4, 0, 0))).toBe("09:30");
    // 2026-06-15T10:00:00Z = 15:30 IST (market close).
    expect(fmtIstTime(Date.UTC(2026, 5, 15, 10, 0, 0))).toBe("15:30");
  });

  it("returns an em-dash for missing / invalid input", () => {
    expect(fmtIstTime(null)).toBe("—");
    expect(fmtIstTime(Number.NaN)).toBe("—");
  });
});

describe("lib/india/format — fmtIstClock", () => {
  it("renders epoch ms as IST HH:MM:SS with an IST suffix", () => {
    // 2026-06-15T04:00:21Z = 09:30:21 IST.
    expect(fmtIstClock(Date.UTC(2026, 5, 15, 4, 0, 21))).toBe("09:30:21 IST");
    // Midnight UTC = 05:30:00 IST — verifies offset + zero-padding.
    expect(fmtIstClock(Date.UTC(2026, 5, 15, 0, 0, 0))).toBe("05:30:00 IST");
  });

  it("is deterministic regardless of host locale / timezone", () => {
    // The whole point of this helper: SSR (Node) and CSR (browser) MUST
    // produce identical strings or React hydration throws. The output must
    // therefore never depend on `toLocaleTimeString`.
    const ts = Date.UTC(2026, 5, 15, 15, 10, 21);
    expect(fmtIstClock(ts)).toBe("20:40:21 IST");
  });

  it("returns an em-dash for missing / invalid input", () => {
    expect(fmtIstClock(null)).toBe("—");
    expect(fmtIstClock(Number.NaN)).toBe("—");
  });
});

describe("lib/india/format — fmtDuration", () => {
  it("formats sub-minute, minute and hour spans compactly", () => {
    expect(fmtDuration(30_000)).toBe("30s");
    expect(fmtDuration(12 * 60_000)).toBe("12m");
    expect(fmtDuration(83 * 60_000)).toBe("1h 23m");
  });

  it("returns an em-dash for negative / invalid input", () => {
    expect(fmtDuration(-5)).toBe("—");
    expect(fmtDuration(null)).toBe("—");
  });
});
