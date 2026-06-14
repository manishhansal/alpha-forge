import { describe, expect, it } from "vitest";

import { resolveHistorical, resolveQuotes } from "@/services/india/resolve";
import type { BrokerAdapter } from "@/services/india/broker/types";
import type { Candle, Quote } from "@/types/india";
import type { DataSourceId } from "@/features/settings/data-sources-shared";

function quote(symbol: string, price: number | null, source?: DataSourceId): Quote {
  return {
    symbol,
    name: null,
    price,
    change: null,
    changePct: null,
    prevClose: null,
    source: price == null ? undefined : source,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Build a stub adapter that serves quotes/candles from fixed maps. Anything
 * not in the map comes back as an empty placeholder, mirroring how a real
 * adapter behaves under `allowFallback: false`.
 */
function stub(
  id: DataSourceId,
  quotes: Record<string, number> = {},
  candles: Candle[] = [],
): BrokerAdapter {
  return {
    id: id as BrokerAdapter["id"],
    async getQuote(symbol: string) {
      return quote(symbol, quotes[symbol] ?? null, id);
    },
    async getQuotes(symbols: string[]) {
      return symbols.map((s) =>
        s in quotes ? quote(s, quotes[s], id) : quote(s, null),
      );
    },
    async getHistorical() {
      return candles;
    },
    async getOptionChain() {
      throw new Error("not supported");
    },
  };
}

const CANDLE: Candle = { time: 1, open: 1, high: 2, low: 0.5, close: 1.5 };

describe("services/india/resolve", () => {
  describe("resolveQuotes()", () => {
    it("returns empty placeholders for symbols the only selected source can't serve (no implicit Yahoo)", async () => {
      const angel = stub("angel", { RELIANCE: 100 });
      const { quotes, sources } = await resolveQuotes([angel], [
        "RELIANCE",
        "^CNXIT",
      ]);

      expect(quotes[0].price).toBe(100);
      expect(quotes[0].source).toBe("angel");
      // Sectoral index Angel can't serve stays blank — never silently Yahoo.
      expect(quotes[1].price).toBeNull();
      expect(quotes[1].source).toBeUndefined();
      expect(sources).toEqual(["angel"]);
    });

    it("backfills missing symbols only from later selected sources, tagging true provenance", async () => {
      const angel = stub("angel", { RELIANCE: 100 });
      const yahoo = stub("yahoo", { "^CNXIT": 42, RELIANCE: 999 });

      const { quotes, sources } = await resolveQuotes([angel, yahoo], [
        "RELIANCE",
        "^CNXIT",
      ]);

      // Angel is primary, so RELIANCE keeps Angel's value (not Yahoo's 999).
      expect(quotes[0].price).toBe(100);
      expect(quotes[0].source).toBe("angel");
      expect(quotes[1].price).toBe(42);
      expect(quotes[1].source).toBe("yahoo");
      expect(sources).toEqual(["angel", "yahoo"]);
    });

    it("returns empty arrays for an empty symbol list", async () => {
      const { quotes, sources } = await resolveQuotes([stub("yahoo")], []);
      expect(quotes).toEqual([]);
      expect(sources).toEqual([]);
    });
  });

  describe("resolveHistorical()", () => {
    it("uses the first selected source that returns a non-empty series", async () => {
      const angelEmpty = stub("angel", {}, []);
      const yahoo = stub("yahoo", {}, [CANDLE]);

      const { candles, source } = await resolveHistorical([angelEmpty, yahoo], {
        symbol: "RELIANCE",
        interval: "1d",
        range: "1mo",
      });

      expect(candles).toHaveLength(1);
      expect(source).toBe("yahoo");
    });

    it("returns the primary source's candles when it has data", async () => {
      const angel = stub("angel", {}, [CANDLE]);
      const yahoo = stub("yahoo", {}, [CANDLE, CANDLE]);

      const { candles, source } = await resolveHistorical([angel, yahoo], {
        symbol: "RELIANCE",
        interval: "1d",
        range: "1mo",
      });

      expect(candles).toHaveLength(1);
      expect(source).toBe("angel");
    });

    it("returns null source when no selected source has data", async () => {
      const { candles, source } = await resolveHistorical([stub("angel")], {
        symbol: "RELIANCE",
        interval: "1d",
        range: "1mo",
      });
      expect(candles).toEqual([]);
      expect(source).toBeNull();
    });
  });
});
