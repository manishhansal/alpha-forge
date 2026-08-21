/**
 * TDD red phase — Task 1.1
 *
 * Verifies the dumpState / restoreState round-trip: resuming from a serialised
 * snapshot must produce identical output to a continuous run for all bars fed
 * after the restore point.
 *
 * The module under test (src/features/indicators/index.ts) does NOT exist yet,
 * so these tests will fail at module resolution (red phase).
 *
 * Requirements: 1.4, 1.5
 */
import { describe, expect, it } from "vitest";

import {
  createIndicators,
  dumpState,
  feedBar,
  restoreState,
  type IndicatorConfig,
  type IndicatorHandle,
  type OHLCVBar,
  type SerializedState,
} from "@/features/indicators";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function makeBars(count: number, seed = 1): OHLCVBar[] {
  const rng = mulberry32(seed);
  const bars: OHLCVBar[] = [];
  let price = 19_500;
  for (let i = 0; i < count; i++) {
    const change = (rng() - 0.5) * 200;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + rng() * 50;
    const low = Math.min(open, close) - rng() * 50;
    bars.push({
      openTime: i * 5 * 60_000,
      closeTime: (i + 1) * 5 * 60_000 - 1,
      open,
      high,
      low: Math.max(1, low),
      close,
      volume: 10_000 + rng() * 90_000,
    });
    price = close;
  }
  return bars;
}

const DEFAULT_CONFIG: IndicatorConfig = {
  emaPeriod: 20,
  atrPeriod: 14,
  rsiPeriod: 14,
  bollingerPeriod: 20,
  bollingerK: 2,
};

/** Run all bars through a fresh indicator handle and collect per-bar snapshots. */
function continuousRun(bars: OHLCVBar[], config: IndicatorConfig): ReturnType<typeof feedBar>[] {
  const handle: IndicatorHandle = createIndicators(config);
  return bars.map((bar) => feedBar(handle, bar));
}

/** Feed bars up to `splitAt`, dump state, restore, then continue. */
function splitRun(
  bars: OHLCVBar[],
  config: IndicatorConfig,
  splitAt: number,
): ReturnType<typeof feedBar>[] {
  // Phase 1: feed up to splitAt
  const handle1: IndicatorHandle = createIndicators(config);
  for (let i = 0; i < splitAt; i++) {
    feedBar(handle1, bars[i]);
  }

  // Serialise and restore
  const snapshot: SerializedState = dumpState(handle1);
  const snapshotJson = JSON.stringify(snapshot); // simulate Redis round-trip
  const restored: SerializedState = JSON.parse(snapshotJson) as SerializedState;
  const handle2: IndicatorHandle = restoreState(restored, config);

  // Phase 2: continue from splitAt and collect results
  const results: ReturnType<typeof feedBar>[] = [];
  for (let i = splitAt; i < bars.length; i++) {
    results.push(feedBar(handle2, bars[i]));
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip correctness
// ─────────────────────────────────────────────────────────────────────────────

describe("dumpState → restoreState → continue produces identical output", () => {
  it("EMA output after restore matches continuous run — split at bar 50", () => {
    const bars = makeBars(150, 1);
    const continuous = continuousRun(bars, DEFAULT_CONFIG);
    const split = splitRun(bars, DEFAULT_CONFIG, 50);

    // split[0] corresponds to continuous[50], split[1] to continuous[51], etc.
    for (let i = 0; i < split.length; i++) {
      expect(split[i].ema).toBeCloseTo(continuous[50 + i].ema, 6);
    }
  });

  it("ATR output after restore matches continuous run — split at bar 50", () => {
    const bars = makeBars(150, 2);
    const continuous = continuousRun(bars, DEFAULT_CONFIG);
    const split = splitRun(bars, DEFAULT_CONFIG, 50);

    for (let i = 0; i < split.length; i++) {
      expect(split[i].atr).toBeCloseTo(continuous[50 + i].atr, 6);
    }
  });

  it("RSI output after restore matches continuous run — split at bar 50", () => {
    const bars = makeBars(150, 3);
    const continuous = continuousRun(bars, DEFAULT_CONFIG);
    const split = splitRun(bars, DEFAULT_CONFIG, 50);

    for (let i = 0; i < split.length; i++) {
      expect(split[i].rsi).toBeCloseTo(continuous[50 + i].rsi, 4);
    }
  });

  it("Bollinger mid/upper/lower after restore matches continuous run — split at bar 50", () => {
    const bars = makeBars(150, 4);
    const continuous = continuousRun(bars, DEFAULT_CONFIG);
    const split = splitRun(bars, DEFAULT_CONFIG, 50);

    for (let i = 0; i < split.length; i++) {
      expect(split[i].bollinger.mid).toBeCloseTo(continuous[50 + i].bollinger.mid, 6);
      expect(split[i].bollinger.upper).toBeCloseTo(continuous[50 + i].bollinger.upper, 6);
      expect(split[i].bollinger.lower).toBeCloseTo(continuous[50 + i].bollinger.lower, 6);
    }
  });

  it("all indicators match continuous run when split at bar 100 out of 200", () => {
    const bars = makeBars(200, 5);
    const continuous = continuousRun(bars, DEFAULT_CONFIG);
    const split = splitRun(bars, DEFAULT_CONFIG, 100);

    for (let i = 0; i < split.length; i++) {
      const idx = 100 + i;
      expect(split[i].ema, `EMA[${idx}]`).toBeCloseTo(continuous[idx].ema, 5);
      expect(split[i].atr, `ATR[${idx}]`).toBeCloseTo(continuous[idx].atr, 5);
      expect(split[i].rsi, `RSI[${idx}]`).toBeCloseTo(continuous[idx].rsi, 3);
      expect(split[i].bollinger.mid, `BB.mid[${idx}]`).toBeCloseTo(continuous[idx].bollinger.mid, 5);
    }
  });

  it("split at the warm-up boundary (bar 20) still produces correct output", () => {
    const bars = makeBars(100, 6);
    const continuous = continuousRun(bars, DEFAULT_CONFIG);
    // Split right after the EMA period
    const split = splitRun(bars, DEFAULT_CONFIG, 20);

    for (let i = 0; i < split.length; i++) {
      const idx = 20 + i;
      expect(split[i].ema, `EMA[${idx}]`).toBeCloseTo(continuous[idx].ema, 4);
      expect(split[i].rsi, `RSI[${idx}]`).toBeCloseTo(continuous[idx].rsi, 3);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Serialisation fidelity
// ─────────────────────────────────────────────────────────────────────────────

describe("dumpState / restoreState — serialisation contract", () => {
  it("dumpState returns a JSON-serialisable object", () => {
    const bars = makeBars(50, 7);
    const handle: IndicatorHandle = createIndicators(DEFAULT_CONFIG);
    for (const bar of bars) feedBar(handle, bar);

    const state: SerializedState = dumpState(handle);
    expect(() => JSON.stringify(state)).not.toThrow();
    const json = JSON.stringify(state);
    expect(json.length).toBeGreaterThan(0);
  });

  it("restoreState accepts the exact JSON.parse output of dumpState", () => {
    const bars = makeBars(50, 8);
    const handle: IndicatorHandle = createIndicators(DEFAULT_CONFIG);
    for (const bar of bars) feedBar(handle, bar);

    const json = JSON.stringify(dumpState(handle));
    expect(() => restoreState(JSON.parse(json) as SerializedState, DEFAULT_CONFIG)).not.toThrow();
  });

  it("two independent restoreState calls from the same snapshot produce identical output", () => {
    const bars = makeBars(100, 9);
    const handle: IndicatorHandle = createIndicators(DEFAULT_CONFIG);
    for (let i = 0; i < 60; i++) feedBar(handle, bars[i]);

    const snapshot = JSON.stringify(dumpState(handle));

    const h1: IndicatorHandle = restoreState(JSON.parse(snapshot) as SerializedState, DEFAULT_CONFIG);
    const h2: IndicatorHandle = restoreState(JSON.parse(snapshot) as SerializedState, DEFAULT_CONFIG);

    for (let i = 60; i < bars.length; i++) {
      const r1 = feedBar(h1, bars[i]);
      const r2 = feedBar(h2, bars[i]);
      expect(r1.ema).toBeCloseTo(r2.ema, 10);
      expect(r1.atr).toBeCloseTo(r2.atr, 10);
      expect(r1.rsi).toBeCloseTo(r2.rsi, 10);
    }
  });

  it("feeding zero post-restore bars does not throw", () => {
    const bars = makeBars(30, 10);
    const handle: IndicatorHandle = createIndicators(DEFAULT_CONFIG);
    for (const bar of bars) feedBar(handle, bar);

    const snapshot: SerializedState = dumpState(handle);
    expect(() => restoreState(snapshot, DEFAULT_CONFIG)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Warm-up after restore (Requirement 1.6: ≤ 5 bars)
// ─────────────────────────────────────────────────────────────────────────────

describe("warm-up after restoreState — completes in ≤ 5 bars", () => {
  it("indicator output is finite within 5 bars of restoration", () => {
    const bars = makeBars(200, 11);
    const handle: IndicatorHandle = createIndicators(DEFAULT_CONFIG);

    // Feed enough bars to fully warm up all indicators
    for (let i = 0; i < 100; i++) feedBar(handle, bars[i]);

    const snapshot: SerializedState = dumpState(handle);
    const restored: IndicatorHandle = restoreState(snapshot, DEFAULT_CONFIG);

    // Feed at most 5 bars and verify output is finite (not NaN/Infinity)
    for (let i = 100; i < Math.min(105, bars.length); i++) {
      const out = feedBar(restored, bars[i]);
      expect(Number.isFinite(out.ema), `EMA NaN at bar ${i - 100} post-restore`).toBe(true);
      expect(Number.isFinite(out.atr), `ATR NaN at bar ${i - 100} post-restore`).toBe(true);
      expect(Number.isFinite(out.rsi), `RSI NaN at bar ${i - 100} post-restore`).toBe(true);
      expect(Number.isFinite(out.bollinger.mid), `BB.mid NaN at bar ${i - 100} post-restore`).toBe(
        true,
      );
    }
  });
});
