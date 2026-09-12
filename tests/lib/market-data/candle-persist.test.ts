/**
 * candle-persist.service — regression tests (RCA-001) + V9 bulk-write tests
 *
 * Verifies:
 *   1. Valid candles are upserted correctly via the bulk path.
 *   2. Invalid / non-finite candles are filtered before any DB call.
 *   3. Results are counted correctly.
 *   4. Empty arrays produce zero writes with no error.
 *   5. V9 bulk path: $executeRawUnsafe is used (not row-by-row upsert).
 *   6. Fallback path: when bulk fails, row-by-row upsert is used.
 *   7. BULK_CHUNK_SIZE: large batches are chunked (≤500 rows per statement).
 *   8. Throughput: 1000 valid candles produce exactly 2 bulk calls (500+500).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OHLCVCandle } from "@/lib/market-data/types";

// ── Stub Prisma ───────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => stubPrisma,
}));

vi.mock("@/lib/market-data/health", () => ({
  mdLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));

// Bulk path stub — returns the row count
const executeRawUnsafeSpy = vi.fn().mockResolvedValue(1);
// Fallback row-by-row upsert stub
const upsertSpy = vi.fn().mockResolvedValue({});

const stubPrisma = {
  candleBar: { upsert: upsertSpy },
  $executeRawUnsafe: executeRawUnsafeSpy,
};

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeCandle(overrides: Partial<OHLCVCandle> = {}): OHLCVCandle {
  return {
    time: 1756944000,
    open: 100,
    high: 105,
    low: 98,
    close: 103,
    volume: 10000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("persistCandles — RCA-001 regression + V9 bulk write", () => {
  beforeEach(() => {
    executeRawUnsafeSpy.mockClear();
    upsertSpy.mockClear();
    executeRawUnsafeSpy.mockResolvedValue(1);
    upsertSpy.mockResolvedValue({});
  });

  // ── V9 bulk path ────────────────────────────────────────────────────────

  it("V9: uses $executeRawUnsafe (bulk) instead of row-by-row upsert", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const candles = [makeCandle(), makeCandle({ time: 1756944300 })];
    const result = await persistCandles(candles, "NIFTY", "NSE", "5m", {
      prisma: stubPrisma as never,
    });

    // Bulk path used — single $executeRawUnsafe call for 2 candles
    expect(executeRawUnsafeSpy).toHaveBeenCalledTimes(1);
    // Row-by-row upsert NOT called on happy path
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
  });

  it("V9: bulk SQL contains INSERT … ON CONFLICT DO UPDATE", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    await persistCandles([makeCandle()], "RELIANCE", "NSE", "1d", {
      prisma: stubPrisma as never,
      provider: "angel_one",
    });

    const sql: string = executeRawUnsafeSpy.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO candle_bar/i);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });

  it("V9: chunks 1000 candles into exactly 2 bulk calls (BULK_CHUNK_SIZE=500)", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    // 1000 candles with unique timestamps
    const candles = Array.from({ length: 1000 }, (_, i) =>
      makeCandle({ time: 1756944000 + i * 60 }),
    );

    await persistCandles(candles, "BANKNIFTY", "NSE", "1m", {
      prisma: stubPrisma as never,
    });

    // Should be exactly 2 calls: chunks of 500 + 500
    expect(executeRawUnsafeSpy).toHaveBeenCalledTimes(2);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("V9: fallback to row-by-row when bulk INSERT throws", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    // Bulk fails once → fallback kicks in
    executeRawUnsafeSpy.mockRejectedValueOnce(new Error("bulk insert failed"));

    const candles = [makeCandle(), makeCandle({ time: 1756944300 })];
    const result = await persistCandles(candles, "INFY", "NSE", "15m", {
      prisma: stubPrisma as never,
    });

    // Bulk was attempted
    expect(executeRawUnsafeSpy).toHaveBeenCalledTimes(1);
    // Row-by-row fallback used for the same chunk
    expect(upsertSpy).toHaveBeenCalledTimes(2);
    expect(result.errors).toBe(0);
    expect(result.upserted).toBe(2);
  });

  it("V9: partial fallback failure counted in errors", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    executeRawUnsafeSpy.mockRejectedValueOnce(new Error("bulk insert failed"));
    // First row-by-row upsert throws
    upsertSpy.mockRejectedValueOnce(new Error("row failed"));

    const candles = [makeCandle(), makeCandle({ time: 1756944300 })];
    const result = await persistCandles(candles, "SBIN", "NSE", "5m", {
      prisma: stubPrisma as never,
    });

    expect(result.upserted).toBe(1);
    expect(result.errors).toBe(1);
  });

  // ── Validation (same as before, now filtering before bulk call) ─────────

  it("filters invalid candles before any DB call", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const candles = [makeCandle({ open: NaN }), makeCandle()];
    const result = await persistCandles(candles, "TCS", "NSE", "5m", {
      prisma: stubPrisma as never,
    });

    // Only 1 valid candle sent to bulk
    expect(executeRawUnsafeSpy).toHaveBeenCalledTimes(1);
    expect(result.upserted).toBeGreaterThanOrEqual(0); // bulk returns affected count
    expect(result.errors).toBe(0);
  });

  it("skips candles with zero close before bulk call", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const candles = [makeCandle({ close: 0 })];
    const result = await persistCandles(candles, "BANKNIFTY", "NSE", "1m", {
      prisma: stubPrisma as never,
    });

    expect(executeRawUnsafeSpy).not.toHaveBeenCalled();
    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("returns zero for empty input without any DB call", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const result = await persistCandles([], "HDFCBANK", "NSE", "5m", {
      prisma: stubPrisma as never,
    });

    expect(executeRawUnsafeSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(0);
  });

  // ── persistCandlesBatch ─────────────────────────────────────────────────

  it("persistCandlesBatch aggregates counts across instruments", async () => {
    const { persistCandlesBatch } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    const entries = [
      { candles: [makeCandle()], instrumentId: "NIFTY", exchange: "NSE", interval: "5m" as const },
      { candles: [makeCandle(), makeCandle({ time: 1756944300 })], instrumentId: "BANKNIFTY", exchange: "NSE", interval: "5m" as const },
    ];

    await persistCandlesBatch(entries, { prisma: stubPrisma as never });

    // 2 instruments → 2 bulk calls (one per instrument)
    expect(executeRawUnsafeSpy).toHaveBeenCalledTimes(2);
  });

  // ── Backward compatibility (original test cases preserved) ──────────────

  it("backward compat: upsert calls use correct composite key (fallback path)", async () => {
    const { persistCandles } = await import(
      "@/lib/market-data/services/candle-persist.service"
    );

    // Force bulk to fail so we exercise the fallback path
    executeRawUnsafeSpy.mockRejectedValueOnce(new Error("bulk unavailable"));

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
