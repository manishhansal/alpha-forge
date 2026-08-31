// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  validateCandle,
  validateCandleSequence,
  filterValidCandles,
} from "@/lib/market-data/validation/candle-validator";

import {
  validateTick,
  validateTicks,
  isWithinCircuitLimits,
} from "@/lib/market-data/validation/tick-validator";

import type { OHLCVCandle } from "@/lib/market-data/types";
import type { LiveTick } from "@/lib/market-data/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function candle(overrides: Partial<OHLCVCandle> = {}): OHLCVCandle {
  return {
    time: 1_700_000_000,
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 10_000,
    ...overrides,
  };
}

function tick(overrides: Partial<LiveTick> = {}): LiveTick {
  return {
    token: "2885",
    symbol: "RELIANCE",
    exchange: "NSE",
    ltp: 2900.55,
    change: 25.0,
    changePct: 0.87,
    volume: 1_234_567,
    oi: null,
    exchangeTimestampMs: Date.now() - 1_000,
    receivedAtMs: Date.now(),
    provider: "angel_one",
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CANDLE VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe("validateCandle()", () => {
  it("passes a valid candle", () => {
    expect(validateCandle(candle())).toEqual({ valid: true });
  });

  describe("timestamp validation", () => {
    it("rejects non-positive time", () => {
      const r = validateCandle(candle({ time: 0 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("INVALID_TIMESTAMP");
    });

    it("rejects negative time", () => {
      const r = validateCandle(candle({ time: -1 }));
      expect(r.valid).toBe(false);
    });

    it("rejects non-integer time", () => {
      const r = validateCandle(candle({ time: 1_700_000_000.5 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("INVALID_TIMESTAMP");
    });

    it("rejects NaN time", () => {
      const r = validateCandle(candle({ time: NaN }));
      expect(r.valid).toBe(false);
    });
  });

  describe("OHLC finiteness", () => {
    it("rejects NaN open", () => {
      const r = validateCandle(candle({ open: NaN }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("NON_FINITE_OHLC");
    });

    it("rejects Infinity high", () => {
      const r = validateCandle(candle({ high: Infinity }));
      expect(r.valid).toBe(false);
    });
  });

  describe("OHLC positivity", () => {
    it("rejects zero close", () => {
      const r = validateCandle(candle({ close: 0 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("NEGATIVE_PRICE");
    });

    it("rejects negative low", () => {
      const r = validateCandle(candle({ low: -1 }));
      expect(r.valid).toBe(false);
    });
  });

  describe("OHLC consistency", () => {
    it("rejects high < low", () => {
      const r = validateCandle(candle({ high: 90, low: 95 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("HIGH_BELOW_LOW");
    });

    it("rejects high < open", () => {
      const r = validateCandle(candle({ high: 99, open: 100, close: 98, low: 97 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("HIGH_BELOW_OPEN_OR_CLOSE");
    });

    it("rejects high < close", () => {
      const r = validateCandle(candle({ high: 100, open: 98, close: 105, low: 97 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("HIGH_BELOW_OPEN_OR_CLOSE");
    });

    it("rejects low > open", () => {
      const r = validateCandle(candle({ low: 105, open: 100, high: 110, close: 108 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("LOW_ABOVE_OPEN_OR_CLOSE");
    });

    it("rejects low > close", () => {
      const r = validateCandle(candle({ low: 110, open: 115, high: 120, close: 108 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("LOW_ABOVE_OPEN_OR_CLOSE");
    });

    it("accepts a doji candle (open == close)", () => {
      const r = validateCandle(candle({ open: 100, high: 105, low: 95, close: 100 }));
      expect(r.valid).toBe(true);
    });
  });

  describe("volume validation", () => {
    it("accepts candle with no volume field", () => {
      const { volume: _, ...c } = candle();
      expect(validateCandle(c as OHLCVCandle).valid).toBe(true);
    });

    it("rejects negative volume", () => {
      const r = validateCandle(candle({ volume: -1 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("NEGATIVE_VOLUME");
    });

    it("accepts zero volume (auction / no-trade candle)", () => {
      expect(validateCandle(candle({ volume: 0 })).valid).toBe(true);
    });
  });
});

// ── validateCandleSequence ────────────────────────────────────────────────────

describe("validateCandleSequence()", () => {
  it("passes a valid ascending sequence", () => {
    const cs = [
      candle({ time: 1_000 }),
      candle({ time: 2_000 }),
      candle({ time: 3_000 }),
    ];
    const r = validateCandleSequence(cs);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.validCount).toBe(3);
  });

  it("detects descending timestamps", () => {
    const cs = [
      candle({ time: 3_000 }),
      candle({ time: 2_000 }),
    ];
    const r = validateCandleSequence(cs);
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.error).toBe("TIMESTAMP_NOT_ASCENDING");
  });

  it("detects duplicate timestamps", () => {
    const cs = [
      candle({ time: 1_000 }),
      candle({ time: 1_000 }),
    ];
    const r = validateCandleSequence(cs);
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.error).toBe("DUPLICATE_TIMESTAMP");
  });

  it("reports index of the offending candle", () => {
    const cs = [
      candle({ time: 1_000 }),
      candle({ time: 2_000 }),
      candle({ time: 1_500 }), // out of order
    ];
    const r = validateCandleSequence(cs);
    expect(r.errors[0]!.index).toBe(2);
  });

  it("counts only structurally valid candles towards validCount", () => {
    const cs = [
      candle({ time: 1_000 }),
      candle({ time: 2_000, open: NaN }), // invalid
      candle({ time: 3_000 }),
    ];
    const r = validateCandleSequence(cs);
    expect(r.validCount).toBe(2);
  });

  it("passes an empty sequence", () => {
    const r = validateCandleSequence([]);
    expect(r.valid).toBe(true);
    expect(r.validCount).toBe(0);
  });
});

// ── filterValidCandles ────────────────────────────────────────────────────────

describe("filterValidCandles()", () => {
  it("keeps only valid, strictly ascending candles", () => {
    const cs = [
      candle({ time: 1_000 }),
      candle({ time: 2_000, open: NaN }), // invalid
      candle({ time: 3_000 }),
      candle({ time: 2_500 }), // out of order
      candle({ time: 4_000 }),
    ];
    const result = filterValidCandles(cs);
    expect(result.map((c) => c.time)).toEqual([1_000, 3_000, 4_000]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TICK VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe("validateTick()", () => {
  it("passes a valid tick", () => {
    const r = validateTick(tick());
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.stale).toBe(false);
  });

  describe("token validation", () => {
    it("rejects empty token", () => {
      const r = validateTick(tick({ token: "" }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("EMPTY_TOKEN");
    });

    it("rejects whitespace-only token", () => {
      const r = validateTick(tick({ token: "   " }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("EMPTY_TOKEN");
    });
  });

  describe("LTP validation", () => {
    it("rejects NaN ltp", () => {
      const r = validateTick(tick({ ltp: NaN }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("NON_FINITE_LTP");
    });

    it("rejects Infinity ltp", () => {
      const r = validateTick(tick({ ltp: Infinity }));
      expect(r.valid).toBe(false);
    });

    it("rejects negative ltp", () => {
      const r = validateTick(tick({ ltp: -1 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("NEGATIVE_LTP");
    });

    it("rejects zero ltp", () => {
      const r = validateTick(tick({ ltp: 0 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("ZERO_LTP");
    });
  });

  describe("timestamp validation", () => {
    it("rejects non-positive exchangeTimestampMs", () => {
      const r = validateTick(tick({ exchangeTimestampMs: 0 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("INVALID_TIMESTAMP");
    });

    it("rejects non-integer exchangeTimestampMs", () => {
      const r = validateTick(tick({ exchangeTimestampMs: Date.now() + 0.5 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("INVALID_TIMESTAMP");
    });

    it("rejects timestamp more than 5s in the future", () => {
      const r = validateTick(tick({ exchangeTimestampMs: Date.now() + 10_000 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("FUTURE_TIMESTAMP");
    });

    it("accepts a timestamp up to 5s in the future (clock skew tolerance)", () => {
      const r = validateTick(tick({ exchangeTimestampMs: Date.now() + 4_000 }));
      expect(r.valid).toBe(true);
    });
  });

  describe("volume and OI validation", () => {
    it("rejects negative volume", () => {
      const r = validateTick(tick({ volume: -1 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("NEGATIVE_VOLUME");
    });

    it("rejects negative OI", () => {
      const r = validateTick(tick({ oi: -500 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error).toBe("NEGATIVE_OI");
    });

    it("accepts null volume and OI", () => {
      expect(validateTick(tick({ volume: null, oi: null })).valid).toBe(true);
    });
  });

  describe("staleness detection", () => {
    it("marks a tick as stale when exchangeTimestampMs is older than threshold", () => {
      const old = tick({ exchangeTimestampMs: Date.now() - 10_000 });
      const r = validateTick(old);
      expect(r.valid).toBe(true);
      if (r.valid) expect(r.stale).toBe(true);
    });

    it("respects a custom stale threshold", () => {
      const ts = Date.now() - 3_000;
      const t = tick({ exchangeTimestampMs: ts });
      // 3s old, 2s threshold → stale
      expect((validateTick(t, 2_000) as { valid: true; stale: boolean }).stale).toBe(true);
      // 3s old, 10s threshold → fresh
      expect((validateTick(t, 10_000) as { valid: true; stale: boolean }).stale).toBe(false);
    });
  });
});

// ── validateTicks (batch) ─────────────────────────────────────────────────────

describe("validateTicks()", () => {
  it("separates valid, invalid, and stale ticks correctly", () => {
    const validTick = tick();
    const invalidTick = tick({ ltp: 0 });
    const staleTick = tick({ exchangeTimestampMs: Date.now() - 10_000 });

    const result = validateTicks([validTick, invalidTick, staleTick]);
    expect(result.valid).toHaveLength(2); // valid + stale are both in valid
    expect(result.invalid).toHaveLength(1);
    expect(result.stale).toHaveLength(1);
    expect(result.invalid[0]!.error).toBe("ZERO_LTP");
  });

  it("returns empty arrays for an empty input", () => {
    const r = validateTicks([]);
    expect(r.valid).toHaveLength(0);
    expect(r.invalid).toHaveLength(0);
    expect(r.stale).toHaveLength(0);
  });
});

// ── isWithinCircuitLimits ─────────────────────────────────────────────────────

describe("isWithinCircuitLimits()", () => {
  it("returns true when ltp is within limits", () => {
    expect(isWithinCircuitLimits(100, 80, 120)).toBe(true);
  });

  it("returns false when ltp is above upper circuit", () => {
    expect(isWithinCircuitLimits(125, 80, 120)).toBe(false);
  });

  it("returns false when ltp is below lower circuit", () => {
    expect(isWithinCircuitLimits(75, 80, 120)).toBe(false);
  });

  it("returns null when limits are null", () => {
    expect(isWithinCircuitLimits(100, null, null)).toBeNull();
    expect(isWithinCircuitLimits(100, null, 120)).toBeNull();
    expect(isWithinCircuitLimits(100, 80, null)).toBeNull();
  });

  it("returns null when limits are non-finite", () => {
    expect(isWithinCircuitLimits(100, NaN, 120)).toBeNull();
    expect(isWithinCircuitLimits(100, 80, Infinity)).toBeNull();
  });
});
