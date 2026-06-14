import { describe, expect, it } from "vitest";

import {
  INDIA_PRICE_STRATEGY_MODULES,
  momentumModule,
  rangeExpansionModule,
  volumeBreakoutModule,
} from "@/features/india/scalping/strategies/price-modules";
import type { Candle } from "@/types/india";

/** Build a flat window of `n` candles, optionally overriding the last bar. */
function flat(n: number, close = 100, volume = 100_000): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 86_400,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  }));
}

describe("india/scalping/price-modules — momentum", () => {
  it("fires LONG on a strong up day and SHORT on a strong down day", () => {
    const up = flat(30, 100);
    up[up.length - 1] = { time: 30 * 86_400, open: 100, high: 104, low: 100, close: 104, volume: 120_000 };
    const longSig = momentumModule.run(up);
    expect(longSig?.direction).toBe("LONG");
    expect(longSig?.entry).toBe(104);
    expect(longSig!.target).toBeGreaterThan(longSig!.entry);
    expect(longSig!.stopLoss).toBeLessThan(longSig!.entry);
    expect(longSig!.triggeredAtSec).toBe(30 * 86_400);

    const down = flat(30, 100);
    down[down.length - 1] = { time: 30 * 86_400, open: 100, high: 100, low: 96, close: 96, volume: 120_000 };
    expect(momentumModule.run(down)?.direction).toBe("SHORT");
  });

  it("returns null when the move is too small", () => {
    const quiet = flat(30, 100);
    quiet[quiet.length - 1] = { time: 30 * 86_400, open: 100, high: 100.5, low: 99.5, close: 100.3, volume: 100_000 };
    expect(momentumModule.run(quiet)).toBeNull();
  });
});

describe("india/scalping/price-modules — volume breakout", () => {
  it("fires when volume clears 1.5x the 20-day average with a directional move", () => {
    const w = flat(30, 100, 100_000);
    w[w.length - 1] = { time: 30 * 86_400, open: 100, high: 102.5, low: 100, close: 102, volume: 300_000 };
    const sig = volumeBreakoutModule.run(w);
    expect(sig?.direction).toBe("LONG");
  });

  it("returns null when volume is ordinary", () => {
    const w = flat(30, 100, 100_000);
    w[w.length - 1] = { time: 30 * 86_400, open: 100, high: 102.5, low: 100, close: 102, volume: 110_000 };
    expect(volumeBreakoutModule.run(w)).toBeNull();
  });
});

describe("india/scalping/price-modules — range expansion", () => {
  /** A clean multi-year uptrend with a wide bullish breakout on the last bar. */
  function bullishTrend(): Candle[] {
    const n = 230;
    const out: Candle[] = [];
    let price = 50;
    for (let i = 0; i < n - 1; i++) {
      const open = price;
      price = price * 1.004; // steady uptrend so SMA20>50>200
      const close = price;
      out.push({
        time: i * 86_400,
        open,
        high: close + 0.3,
        low: open - 0.3,
        close,
        volume: 100_000,
      });
    }
    const open = price;
    const close = price * 1.03;
    out.push({
      time: (n - 1) * 86_400,
      open,
      // Widest range of the last 8 sessions + close in the upper half.
      high: close + 0.1,
      low: open - 6,
      close,
      volume: 400_000,
    });
    return out;
  }

  it("fires LONG on a WR8 breakout inside a bullish SMA stack", () => {
    const sig = rangeExpansionModule.run(bullishTrend());
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("LONG");
  });

  it("returns null on a flat market (no expansion, no trend)", () => {
    expect(rangeExpansionModule.run(flat(230, 100))).toBeNull();
  });
});

describe("india/scalping/price-modules — registry", () => {
  it("exposes exactly the three price-derivable strategies", () => {
    expect(Object.keys(INDIA_PRICE_STRATEGY_MODULES).sort()).toEqual([
      "MOMENTUM",
      "RANGE_EXPANSION",
      "VOLUME_BREAKOUT",
    ]);
  });
});
