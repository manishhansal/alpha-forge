import { describe, expect, it } from "vitest";

import {
  atrFromCandles,
  buildIndiaTradeLevels,
  indiaPnlPercent,
  isExpiryCooldownIST,
  resolveAgainstCandles,
} from "@/features/india/scalping/paper-trader-core";
import type { Candle } from "@/types/india";

describe("india/scalping/paper-trader-core — buildIndiaTradeLevels", () => {
  it("sizes a LONG stop/target from ATR and preserves the strategy RR", () => {
    const levels = buildIndiaTradeLevels({
      entry: 22000,
      direction: "LONG",
      atr: 50,
      slMult: 1,
      riskReward: 2,
    });
    expect(levels).not.toBeNull();
    expect(levels!.stopLoss).toBeCloseTo(21950, 5);
    expect(levels!.target).toBeCloseTo(22100, 5);
    expect(levels!.riskReward).toBeCloseTo(2, 5);
  });

  it("sizes a SHORT stop above / target below entry", () => {
    const levels = buildIndiaTradeLevels({
      entry: 22000,
      direction: "SHORT",
      atr: 40,
      slMult: 1,
      riskReward: 2.5,
    });
    expect(levels!.stopLoss).toBeCloseTo(22040, 5);
    expect(levels!.target).toBeCloseTo(21900, 5);
  });

  it("rounds levels to the NSE tick", () => {
    const levels = buildIndiaTradeLevels({
      entry: 2000,
      direction: "LONG",
      atr: 3.33,
      slMult: 1,
      riskReward: 2,
      tick: 0.05,
    });
    // 2000 - 3.33 = 1996.67 → 1996.65 ; 2000 + 6.66 = 2006.66 → 2006.65
    expect(levels!.stopLoss).toBeCloseTo(1996.65, 5);
    expect(levels!.target).toBeCloseTo(2006.65, 5);
  });

  it("returns null when ATR is unusable (≤ 0 / non-finite)", () => {
    expect(
      buildIndiaTradeLevels({ entry: 100, direction: "LONG", atr: 0, slMult: 1, riskReward: 2 }),
    ).toBeNull();
    expect(
      buildIndiaTradeLevels({
        entry: 100,
        direction: "LONG",
        atr: Number.NaN,
        slMult: 1,
        riskReward: 2,
      }),
    ).toBeNull();
  });
});

describe("india/scalping/paper-trader-core — atrFromCandles", () => {
  it("returns null when there aren't enough candles", () => {
    expect(atrFromCandles([], 14)).toBeNull();
    expect(atrFromCandles([{ time: 1, open: 1, high: 2, low: 0, close: 1 }], 14)).toBeNull();
  });

  it("averages the true range over the period", () => {
    // Flat 10-wide ranges, prevClose inside → TR = high-low = 10 each.
    const candles: Candle[] = Array.from({ length: 5 }, (_, i) => ({
      time: i,
      open: 100,
      high: 105,
      low: 95,
      close: 100,
    }));
    const atr = atrFromCandles(candles, 3);
    expect(atr).toBeCloseTo(10, 5);
  });
});

describe("india/scalping/paper-trader-core — resolveAgainstCandles", () => {
  const base = { direction: "LONG" as const, stopLoss: 95, target: 110 };

  it("marks WIN when a candle high reaches the target (LONG)", () => {
    const res = resolveAgainstCandles(
      [{ time: 1, open: 100, high: 111, low: 99, close: 108 }],
      base,
    );
    expect(res?.outcome).toBe("WIN");
    expect(res?.exitPrice).toBe(110);
  });

  it("marks LOSS when a candle low reaches the stop (LONG)", () => {
    const res = resolveAgainstCandles(
      [{ time: 1, open: 100, high: 101, low: 94, close: 96 }],
      base,
    );
    expect(res?.outcome).toBe("LOSS");
    expect(res?.exitPrice).toBe(95);
  });

  it("breaks ties conservatively — stop wins when a candle touches both", () => {
    const res = resolveAgainstCandles(
      [{ time: 1, open: 100, high: 111, low: 94, close: 100 }],
      base,
    );
    expect(res?.outcome).toBe("LOSS");
  });

  it("mirrors the logic for SHORT trades", () => {
    const short = { direction: "SHORT" as const, stopLoss: 105, target: 90 };
    expect(
      resolveAgainstCandles([{ time: 1, open: 100, high: 101, low: 89, close: 92 }], short)
        ?.outcome,
    ).toBe("WIN");
    expect(
      resolveAgainstCandles([{ time: 1, open: 100, high: 106, low: 99, close: 104 }], short)
        ?.outcome,
    ).toBe("LOSS");
  });

  it("returns null when neither level is touched", () => {
    expect(
      resolveAgainstCandles([{ time: 1, open: 100, high: 102, low: 98, close: 100 }], base),
    ).toBeNull();
  });
});

describe("india/scalping/paper-trader-core — isExpiryCooldownIST", () => {
  it("is active on a Thursday afternoon (≥ 14:30 IST)", () => {
    // 2026-06-11 is a Thursday. 09:30 UTC = 15:00 IST.
    expect(isExpiryCooldownIST(new Date("2026-06-11T09:30:00Z"))).toBe(true);
  });

  it("is NOT active on a Thursday morning (before 14:30 IST)", () => {
    // 04:00 UTC = 09:30 IST.
    expect(isExpiryCooldownIST(new Date("2026-06-11T04:00:00Z"))).toBe(false);
  });

  it("is NOT active on a non-Thursday", () => {
    // 2026-06-10 is a Wednesday, 10:00 UTC = 15:30 IST.
    expect(isExpiryCooldownIST(new Date("2026-06-10T10:00:00Z"))).toBe(false);
  });
});

describe("india/scalping/paper-trader-core — indiaPnlPercent", () => {
  it("computes signed % for long and short", () => {
    expect(indiaPnlPercent(100, 110, true)).toBeCloseTo(10, 5);
    expect(indiaPnlPercent(100, 90, true)).toBeCloseTo(-10, 5);
    expect(indiaPnlPercent(100, 90, false)).toBeCloseTo(10, 5);
    expect(indiaPnlPercent(0, 90, true)).toBe(0);
  });
});
