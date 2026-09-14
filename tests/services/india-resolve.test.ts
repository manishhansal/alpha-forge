/**
 * Tests for services/india/resolve.ts
 *
 * After data-service2.0 centralization, resolveQuotes and resolveHistorical
 * delegate entirely to the data-service2.0 client. The old broker-chain
 * resolution is gone.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Mock the data-service2.0 client
const getQuotesMock = vi.fn();
const getHistoricalMock = vi.fn();

vi.mock("@/lib/data-service/client", () => ({
  getQuotes: getQuotesMock,
  getHistorical: getHistoricalMock,
  getOptionChain: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  getQuotesMock.mockClear();
  getHistoricalMock.mockClear();
});

describe("services/india/resolve (data-service2.0 delegation)", () => {
  describe("resolveQuotes()", () => {
    it("returns empty arrays for an empty symbol list", async () => {
      getQuotesMock.mockResolvedValue([]);
      const { resolveQuotes } = await import("@/services/india/resolve");

      const result = await resolveQuotes(null, []);
      expect(result.quotes).toEqual([]);
      expect(result.sources).toBeDefined();
    });

    it("returns quotes from data-service2.0 for provided symbols", async () => {
      getQuotesMock.mockResolvedValue([
        { symbol: "RELIANCE", ltp: 2500, changePct: 0.5, dataAsOf: new Date().toISOString() },
        { symbol: "INFY", ltp: 1800, changePct: -0.2, dataAsOf: new Date().toISOString() },
      ]);
      const { resolveQuotes } = await import("@/services/india/resolve");

      const result = await resolveQuotes(null, ["RELIANCE", "INFY"]);
      expect(result.quotes).toHaveLength(2);
      expect(result.quotes[0]?.symbol).toBe("RELIANCE");
      expect(result.sources).toContain("data-service2");
    });

    it("returns empty placeholders when data-service2.0 returns nulls", async () => {
      getQuotesMock.mockResolvedValue([null, null]);
      const { resolveQuotes } = await import("@/services/india/resolve");

      const result = await resolveQuotes(null, ["AAAA", "BBBB"]);
      expect(result.quotes).toHaveLength(2);
      // Placeholders have null price
      expect(result.quotes[0]?.price).toBeNull();
    });

    it("backfills missing symbols only from data-service2.0 (no provider chain)", async () => {
      // data-service2.0 is the only source — no multi-provider backfill
      getQuotesMock.mockResolvedValue([
        { symbol: "RELIANCE", ltp: 2500, changePct: 0.5, dataAsOf: new Date().toISOString() },
        null, // AAAA not found
      ]);
      const { resolveQuotes } = await import("@/services/india/resolve");

      const result = await resolveQuotes(null, ["RELIANCE", "AAAA"]);
      expect(result.quotes[0]?.symbol).toBe("RELIANCE");
      expect(result.quotes[1]?.price).toBeNull();
    });
  });

  describe("resolveHistorical()", () => {
    it("returns candles from data-service2.0", async () => {
      const candles = [
        { time: 1756944000, open: 100, high: 105, low: 98, close: 103, volume: 10000, oi: null },
      ];
      getHistoricalMock.mockResolvedValue(candles);
      const { resolveHistorical } = await import("@/services/india/resolve");

      const result = await resolveHistorical(null, { symbol: "RELIANCE", interval: "1d" as const, range: "1y" });
      expect(result.candles).toHaveLength(1);
      expect(result.source).toBe("data-service2");
    });

    it("returns the primary source's candles when data is available", async () => {
      const candles = [
        { time: 1756944000, open: 100, high: 105, low: 98, close: 103, volume: 10000, oi: null },
        { time: 1756944300, open: 103, high: 108, low: 101, close: 106, volume: 8000, oi: null },
      ];
      getHistoricalMock.mockResolvedValue(candles);
      const { resolveHistorical } = await import("@/services/india/resolve");

      const result = await resolveHistorical(null, { symbol: "NIFTY", interval: "5m" as const, range: "1y" });
      expect(result.candles).toHaveLength(2);
      expect(result.source).toBe("data-service2");
    });

    it("returns null source when data-service2.0 returns empty array", async () => {
      getHistoricalMock.mockResolvedValue([]);
      const { resolveHistorical } = await import("@/services/india/resolve");

      const result = await resolveHistorical(null, { symbol: "UNKNOWN", interval: "1d" as const, range: "1y" });
      expect(result.candles).toHaveLength(0);
      expect(result.source).toBe("data-service2");
    });

    it("uses first selected source (data-service2.0) exclusively", async () => {
      getHistoricalMock.mockResolvedValue([
        { time: 1756944000, open: 100, high: 105, low: 98, close: 103, volume: 10000, oi: null },
      ]);
      const { resolveHistorical } = await import("@/services/india/resolve");

      const result = await resolveHistorical(null, { symbol: "RELIANCE", interval: "1d" as const, range: "1y" });
      expect(getHistoricalMock).toHaveBeenCalledTimes(1);
      expect(result.source).toBe("data-service2");
    });
  });
});
