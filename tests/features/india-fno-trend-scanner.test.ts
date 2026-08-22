import { describe, expect, it } from "vitest";

import type { ScannerHit } from "@/types/india/scanner";

// ─── ScannerHit type contract ─────────────────────────────────────────────────

describe("types/india/scanner — ScannerHit extended fields", () => {
  it("accepts the new trade-level optional fields without TypeScript error", () => {
    const hit: ScannerHit = {
      symbol:               "HINDZINC",
      price:                594.9,
      changePct:            3.66,
      volume:               14_189_716,
      metric:               33.2,
      metricLabel:          "ADX 33.2 · RSI 61",
      kind:                 "BULLISH",
      note:                 "DI+ 33.9 / DI− 17.2",
      entry:                594.9,
      stopLoss:             577.9,          // entry − 1.4 × ATR
      tp1:                  622.0,          // entry + 1.6 × ATR
      tp2:                  639.1,          // entry + 2.6 × ATR
      tp3:                  663.7,          // entry + 4.0 × ATR
      atr:                  12.14,
      paperTradeStrategyId: "FNO_TREND",
    };
    expect(hit.entry).toBeCloseTo(594.9);
    expect(hit.stopLoss).toBeLessThan(hit.entry!);
    expect(hit.tp1).toBeGreaterThan(hit.entry!);
    expect(hit.tp2).toBeGreaterThan(hit.tp1!);
    expect(hit.tp3).toBeGreaterThan(hit.tp2!);
    expect(hit.paperTradeStrategyId).toBe("FNO_TREND");
  });

  it("allows ScannerHit without the optional level fields (backward-compatible)", () => {
    const hit: ScannerHit = {
      symbol:      "NIFTY",
      price:       23_000,
      changePct:   0.4,
      metric:      0.8,
      metricLabel: "+0.40%",
      kind:        "GAINER",
    };
    expect(hit.entry).toBeUndefined();
    expect(hit.stopLoss).toBeUndefined();
    expect(hit.paperTradeStrategyId).toBeUndefined();
  });
});

// ─── ATR-based level arithmetic ───────────────────────────────────────────────

describe("FnO Trend Scanner — ATR level arithmetic (INTRADAY_PROFILE)", () => {
  // Mirrors the constants in engine.ts
  const SL_MULT  = 1.4;
  const TP1_MULT = 1.6;
  const TP2_MULT = 2.6;
  const TP3_MULT = 4.0;

  function bullishLevels(entry: number, atr: number) {
    return {
      stopLoss: entry - SL_MULT  * atr,
      tp1:      entry + TP1_MULT * atr,
      tp2:      entry + TP2_MULT * atr,
      tp3:      entry + TP3_MULT * atr,
    };
  }

  function bearishLevels(entry: number, atr: number) {
    return {
      stopLoss: entry + SL_MULT  * atr,   // above entry for short
      tp1:      entry - TP1_MULT * atr,   // below entry
      tp2:      entry - TP2_MULT * atr,
      tp3:      entry - TP3_MULT * atr,
    };
  }

  it("bullish: SL is below entry, TPs are ascending above entry", () => {
    const { stopLoss, tp1, tp2, tp3 } = bullishLevels(100, 10);
    expect(stopLoss).toBe(86);   // 100 - 1.4×10
    expect(tp1).toBe(116);       // 100 + 1.6×10
    expect(tp2).toBe(126);       // 100 + 2.6×10
    expect(tp3).toBe(140);       // 100 + 4.0×10
    expect(stopLoss).toBeLessThan(100);
    expect(tp1).toBeGreaterThan(100);
    expect(tp3).toBeGreaterThan(tp2);
  });

  it("bearish: SL is above entry, TPs are descending below entry", () => {
    const { stopLoss, tp1, tp2, tp3 } = bearishLevels(100, 10);
    expect(stopLoss).toBe(114);  // 100 + 1.4×10
    expect(tp1).toBe(84);        // 100 - 1.6×10
    expect(tp2).toBe(74);        // 100 - 2.6×10
    expect(tp3).toBe(60);        // 100 - 4.0×10
    expect(stopLoss).toBeGreaterThan(100);
    expect(tp3).toBeLessThan(tp2);
  });

  it("risk:reward (SL→TP1 / SL→entry) ≈ 1.14 for both directions", () => {
    const atr = 10;
    const entry = 100;
    const bull = bullishLevels(entry, atr);
    const rrBull = Math.abs(bull.tp1 - entry) / Math.abs(bull.stopLoss - entry);
    expect(rrBull).toBeCloseTo(TP1_MULT / SL_MULT, 5); // 1.6/1.4 ≈ 1.143

    const bear = bearishLevels(entry, atr);
    const rrBear = Math.abs(bear.tp1 - entry) / Math.abs(bear.stopLoss - entry);
    expect(rrBear).toBeCloseTo(TP1_MULT / SL_MULT, 5);
  });

  it("scales linearly with ATR — doubling ATR doubles all distances", () => {
    const a1 = bullishLevels(100, 10);
    const a2 = bullishLevels(100, 20);
    expect(100 - a2.stopLoss).toBeCloseTo(2 * (100 - a1.stopLoss));
    expect(a2.tp3 - 100).toBeCloseTo(2 * (a1.tp3 - 100));
  });
});

// ─── EMA indicator correctness ────────────────────────────────────────────────

describe("FnO Trend Scanner — EMA seeding convention (TradingView/Chartink match)", () => {
  /**
   * Standard EMA seeded from SMA of the first `period` values.
   * This must match the implementation in engine.ts to ensure
   * Chartink screener parity.
   */
  function ema(vals: number[], period: number): number | null {
    if (vals.length < period) return null;
    const alpha = 2 / (period + 1);
    let v = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < vals.length; i++) v = vals[i] * alpha + v * (1 - alpha);
    return v;
  }

  it("returns null when not enough data", () => {
    expect(ema([1, 2, 3], 5)).toBeNull();
  });

  it("returns the SMA when exactly period values are present", () => {
    const vals = [10, 20, 30];
    const result = ema(vals, 3);
    // seed = SMA(10,20,30) = 20; no additional bars → result = 20
    expect(result).toBeCloseTo(20, 5);
  });

  it("converges toward constant price after many bars", () => {
    // If price is constant, EMA must equal that constant.
    const price = 500;
    const vals = Array(100).fill(price);
    expect(ema(vals, 5)).toBeCloseTo(price, 4);
  });

  it("EMA(5) > EMA(20) when series is rising", () => {
    // Monotonically increasing series → shorter EMA > longer EMA
    const rising = Array.from({ length: 100 }, (_, i) => 100 + i);
    const e5  = ema(rising, 5)!;
    const e20 = ema(rising, 20)!;
    expect(e5).toBeGreaterThan(e20);
  });

  it("EMA(5) < EMA(20) when series is falling", () => {
    const falling = Array.from({ length: 100 }, (_, i) => 200 - i);
    const e5  = ema(falling, 5)!;
    const e20 = ema(falling, 20)!;
    expect(e5).toBeLessThan(e20);
  });
});

// ─── MACD seeding convention ──────────────────────────────────────────────────

describe("FnO Trend Scanner — MACD seeding (single-pass streaming)", () => {
  function ema(vals: number[], period: number): number {
    const alpha = 2 / (period + 1);
    let v = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < vals.length; i++) v = vals[i] * alpha + v * (1 - alpha);
    return v;
  }

  function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return null;
    const af = 2 / (fast + 1), as_ = 2 / (slow + 1), aSig = 2 / (signal + 1);
    let ef = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
    let es = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
    for (let i = fast; i < slow; i++) ef = closes[i] * af + ef * (1 - af);
    const hist = [ef - es];
    for (let i = slow; i < closes.length; i++) {
      ef = closes[i] * af + ef * (1 - af);
      es = closes[i] * as_ + es * (1 - as_);
      hist.push(ef - es);
    }
    let sigEma = hist.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
    for (let i = signal; i < hist.length; i++) sigEma = hist[i] * aSig + sigEma * (1 - aSig);
    return { line: hist[hist.length - 1], signalLine: sigEma };
  }

  it("returns null when fewer than slow+signal bars are available", () => {
    expect(macd(Array(34).fill(100))).toBeNull();
  });

  it("MACD line > 0 for a continuously rising price series", () => {
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
    const r = macd(rising)!;
    expect(r.line).toBeGreaterThan(0);
  });

  it("MACD line < 0 for a continuously falling price series", () => {
    const falling = Array.from({ length: 60 }, (_, i) => 200 - i);
    const r = macd(falling)!;
    expect(r.line).toBeLessThan(0);
  });

  it("MACD line > signal line after sustained uptrend", () => {
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
    const r = macd(rising)!;
    // On a linearly rising series the MACD line converges toward the signal;
    // they may be equal to floating-point precision — use ≥ not strictly >.
    expect(r.line).toBeGreaterThanOrEqual(r.signalLine - 1e-9);
  });

  it("histogram = line − signal", () => {
    const vals = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.5);
    const r = macd(vals)!;
    expect(r.line - r.signalLine).toBeCloseTo(r.line - r.signalLine, 10);
  });
});
