/**
 * TDD red phase — Task 1.1
 *
 * Verifies that the streaming indicator adapter (src/features/indicators/index.ts,
 * which does NOT exist yet) produces output that matches the hand-rolled
 * implementations in src/features/scalping/helpers.ts to within 0.01% on a
 * 200-bar OHLCV fixture.
 *
 * Requirements: 1.1
 */
import { describe, expect, it } from "vitest";

// Reference implementations (these already exist and are known-good)
import {
  atr as helpersAtr,
  bollinger as helpersBollinger,
  ema as helpersEma,
  rsi as helpersRsi,
} from "@/features/scalping/helpers";

// The module under test — does NOT exist yet, so every test in this file will
// fail at the module-resolution phase (red phase confirmed).
import {
  streamIndicators,
  type IndicatorConfig,
  type IndicatorOutput,
  type OHLCVBar,
} from "@/features/indicators";

// ─────────────────────────────────────────────────────────────────────────────
// Shared 200-bar OHLCV fixture
// ─────────────────────────────────────────────────────────────────────────────

function makeBars(count = 200): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  let price = 19_500; // NIFTY-ish seed price
  const rng = mulberry32(42); // deterministic PRNG

  for (let i = 0; i < count; i++) {
    const change = (rng() - 0.5) * 200; // ±100 pts per bar
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + rng() * 50;
    const low = Math.min(open, close) - rng() * 50;
    const volume = 10_000 + rng() * 90_000;
    bars.push({
      openTime: Date.UTC(2024, 0, 1) + i * 5 * 60 * 1_000,
      closeTime: Date.UTC(2024, 0, 1) + (i + 1) * 5 * 60 * 1_000 - 1,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return bars;
}

/** Simple deterministic 32-bit PRNG (Mulberry32) — no external dependencies. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const BARS = makeBars(200);

/** Candle-compatible view of the same fixture (for helpers.ts functions). */
const CANDLES = BARS.map((b) => ({
  openTime: b.openTime,
  closeTime: b.closeTime,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume,
}));

const CLOSES = BARS.map((b) => b.close);

/** Assert two arrays are equal to within 0.01% at every bar after warm-up. */
function assertWithin001Pct(
  actual: number[],
  expected: number[],
  warmUp: number,
  label: string,
): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = warmUp; i < expected.length; i++) {
    const ref = expected[i];
    const act = actual[i];
    if (ref === 0) {
      expect(Math.abs(act - ref)).toBeLessThan(1e-9);
      continue;
    }
    const pct = Math.abs((act - ref) / ref);
    expect(pct, `${label}[${i}]: actual=${act} expected=${ref} diff=${pct * 100}%`).toBeLessThan(
      0.0001,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default config — mirrors what Task 1.2 will expose
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: IndicatorConfig = {
  emaPeriod: 20,
  atrPeriod: 14,
  rsiPeriod: 14,
  bollingerPeriod: 20,
  bollingerK: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// ATR
// ─────────────────────────────────────────────────────────────────────────────

describe("streamIndicators — ATR vs helpers.atr()", () => {
  it("ATR output matches helpers.ts Wilder ATR to within 0.01% on 200-bar fixture", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    const reference = helpersAtr(CANDLES, DEFAULT_CONFIG.atrPeriod);

    // Warm-up: Wilder ATR needs `period` bars before it stabilises
    assertWithin001Pct(result.atr, reference, DEFAULT_CONFIG.atrPeriod + 1, "ATR");
  });

  it("ATR values are all positive after warm-up", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    for (let i = DEFAULT_CONFIG.atrPeriod + 1; i < result.atr.length; i++) {
      expect(result.atr[i]).toBeGreaterThan(0);
    }
  });

  it("ATR array length equals the number of input bars", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    expect(result.atr).toHaveLength(BARS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RSI
// ─────────────────────────────────────────────────────────────────────────────

describe("streamIndicators — RSI vs helpers.rsi()", () => {
  it("RSI output matches helpers.ts RSI to within 0.01% on 200-bar fixture", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    const reference = helpersRsi(CLOSES, DEFAULT_CONFIG.rsiPeriod);

    // Warm-up: RSI needs `period + 1` closes to emit a meaningful first value
    assertWithin001Pct(result.rsi, reference, DEFAULT_CONFIG.rsiPeriod + 1, "RSI");
  });

  it("RSI values are in [0, 100] for all bars", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    for (const v of result.rsi) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("RSI array length equals the number of input bars", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    expect(result.rsi).toHaveLength(BARS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EMA
// ─────────────────────────────────────────────────────────────────────────────

describe("streamIndicators — EMA vs helpers.ema()", () => {
  it("EMA output matches helpers.ts EMA to within 0.01% on 200-bar fixture", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    const reference = helpersEma(CLOSES, DEFAULT_CONFIG.emaPeriod);

    // EMA[0] === closes[0] by definition; meaningful from bar 1
    assertWithin001Pct(result.ema, reference, 1, "EMA");
  });

  it("EMA first value equals the first close price", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    expect(result.ema[0]).toBeCloseTo(BARS[0].close, 6);
  });

  it("EMA on a flat series converges to the constant", () => {
    const flatBars: OHLCVBar[] = Array.from({ length: 100 }, (_, i) => ({
      openTime: i * 60_000,
      closeTime: (i + 1) * 60_000 - 1,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
    }));
    const result: IndicatorOutput = streamIndicators(flatBars, DEFAULT_CONFIG);
    expect(result.ema[99]).toBeCloseTo(100, 4);
  });

  it("EMA array length equals the number of input bars", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    expect(result.ema).toHaveLength(BARS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bollinger Bands
// ─────────────────────────────────────────────────────────────────────────────

describe("streamIndicators — Bollinger Bands vs helpers.bollinger()", () => {
  it("Bollinger mid matches helpers.ts mid to within 0.01% after warm-up", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    const reference = helpersBollinger(CLOSES, DEFAULT_CONFIG.bollingerPeriod, DEFAULT_CONFIG.bollingerK);

    assertWithin001Pct(result.bollinger.mid, reference.mid, DEFAULT_CONFIG.bollingerPeriod, "BB mid");
  });

  it("Bollinger upper matches helpers.ts upper to within 0.01% after warm-up", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    const reference = helpersBollinger(CLOSES, DEFAULT_CONFIG.bollingerPeriod, DEFAULT_CONFIG.bollingerK);

    assertWithin001Pct(result.bollinger.upper, reference.upper, DEFAULT_CONFIG.bollingerPeriod, "BB upper");
  });

  it("Bollinger lower matches helpers.ts lower to within 0.01% after warm-up", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    const reference = helpersBollinger(CLOSES, DEFAULT_CONFIG.bollingerPeriod, DEFAULT_CONFIG.bollingerK);

    assertWithin001Pct(result.bollinger.lower, reference.lower, DEFAULT_CONFIG.bollingerPeriod, "BB lower");
  });

  it("upper >= mid >= lower at every bar after warm-up", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    for (let i = DEFAULT_CONFIG.bollingerPeriod; i < BARS.length; i++) {
      expect(result.bollinger.upper[i]).toBeGreaterThanOrEqual(result.bollinger.mid[i]);
      expect(result.bollinger.lower[i]).toBeLessThanOrEqual(result.bollinger.mid[i]);
    }
  });

  it("all Bollinger arrays have the same length as the input", () => {
    const result: IndicatorOutput = streamIndicators(BARS, DEFAULT_CONFIG);
    expect(result.bollinger.mid).toHaveLength(BARS.length);
    expect(result.bollinger.upper).toHaveLength(BARS.length);
    expect(result.bollinger.lower).toHaveLength(BARS.length);
  });
});
