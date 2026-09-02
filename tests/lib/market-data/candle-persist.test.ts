/**
 * candle-persist.service — regression tests (RCA-001)
 *
 * Verifies that:
 *   1. Valid candles are upserted correctly.
 *   2. Invalid / non-finite candles are silently skipped.
 *   3. Results are counted correctly.
 *   4. Empty arrays produce zero writes with no error.
 *
 * Uses an in-process stub Prisma client — no real DB required.
 */

import { describe, expect, it, vi } from "vitest";
import type { OHLCVCandle } from "@/lib/market-data/types";

// ── Stub Prisma ───────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => stubPrisma,
}));

// We also need to stub the mdLog import to avoid server-only side effects.
vi.mock("@/lib/market-data/health", () => ({
  mdLog: vi.fn(),
}));

// server-only mock so tests run outside Next.js server context.
vi.mock("server-only", () => ({}));

const upsertSpy = vi.fn().mockResolvedValue({});

const stubPrisma = {
  candleBar: {
    upsert: upsertSpy,
  },
};

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeCandle(overrides: Partial<OHLCVCandle> = {}): OHLCVCandle {
  return {
    time: 1756944000, // arbitrary UTC epoch seconds
    open: 100,
    high: 105,
    low: 98,
    close: 103,
    volume: 10000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("persistCandles — RCA-001 regression", () => {
  beforeEach(() => {
    upsertSpy.mockClear();
  });

  it("upserts valid candles and returns correct count", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const candles = [makeCandle(), makeCandle({ time: 1756944300 })];
    const result = await persistCandles(candles, "NIFTY", "NSE", "5m", {
      prisma: stubPrisma as never,
    });

    expect(result.upserted).toBe(2);
    expect(result.errors).toBe(0);
    expect(upsertSpy).toHaveBeenCalledTimes(2);
  });

  it("skips candles with non-finite open", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const candles = [makeCandle({ open: NaN }), makeCandle()];
    const result = await persistCandles(candles, "RELIANCE", "NSE", "5m", {
      prisma: stubPrisma as never,
    });

    expect(result.upserted).toBe(1); // only the valid one
    expect(result.errors).toBe(0);
  });

  it("skips candles with zero close", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const candles = [makeCandle({ close: 0 })];
    const result = await persistCandles(candles, "BANKNIFTY", "NSE", "1m", {
      prisma: stubPrisma as never,
    });

    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(0);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("skips candles with negative time", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const candles = [makeCandle({ time: -1 })];
    const result = await persistCandles(candles, "INFY", "NSE", "15m", {
      prisma: stubPrisma as never,
    });

    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("returns zero upserted and zero errors for empty input", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const result = await persistCandles([], "HDFCBANK", "NSE", "5m", {
      prisma: stubPrisma as never,
    });

    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(0);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("counts DB errors separately from skips", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    upsertSpy.mockRejectedValueOnce(new Error("DB connection lost"));
    const candles = [makeCandle(), makeCandle({ time: 1756944300 })];
    const result = await persistCandles(candles, "MARUTI", "NSE", "5m", {
      prisma: stubPrisma as never,
    });

    expect(result.upserted).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("persistCandlesBatch aggregates counts across instruments", async () => {
    const { persistCandlesBatch } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const entries = [
      { candles: [makeCandle()], instrumentId: "NIFTY", exchange: "NSE", interval: "5m" as const },
      { candles: [makeCandle(), makeCandle({ time: 1756944300 })], instrumentId: "BANKNIFTY", exchange: "NSE", interval: "5m" as const },
    ];

    const result = await persistCandlesBatch(entries, { prisma: stubPrisma as never });

    expect(result.totalUpserted).toBe(3);
    expect(result.totalErrors).toBe(0);
  });

  it("upsert uses correct composite key fields", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const candle = makeCandle({ time: 1756944000 });
    await persistCandles([candle], "FINNIFTY", "NSE", "15m", {
      prisma: stubPrisma as never,
    });

    const call = upsertSpy.mock.calls[0][0];
    expect(call.where.instrumentId_exchange_intervalStr_time).toEqual({
      instrumentId: "FINNIFTY",
      exchange: "NSE",
      intervalStr: "15m",
      time: 1756944000,
    });
    expect(call.create.open).toBe(candle.open);
    expect(call.create.close).toBe(candle.close);
    expect(call.create.volume).toBe(candle.volume);
  });
});
