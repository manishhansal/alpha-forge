import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INDEX_TOKENS,
  angel,
  buildEqTokenMap,
  candlesFromCandleData,
  intervalToSmartApi,
  quoteFromQuoteRow,
  resolveAngelToken,
  type AngelCandleTuple,
  type AngelQuoteRow,
  type AngelScripRow,
} from "@/services/india/angelone";

const SMARTAPI_VARS = [
  "SMARTAPI_API_KEY",
  "SMARTAPI_CLIENT_CODE",
  "SMARTAPI_PIN",
  "SMARTAPI_TOTP_SECRET",
] as const;

const cashRows: AngelScripRow[] = [
  {
    symbol: "RELIANCE-EQ",
    token: "2885",
    name: "RELIANCE",
    expiry: "",
    strike: "-1.000000",
    instrumenttype: "",
    exch_seg: "NSE",
  },
  {
    symbol: "TCS-EQ",
    token: "11536",
    name: "TCS",
    expiry: "",
    strike: "-1.000000",
    instrumenttype: "",
    exch_seg: "NSE",
  },
  // A non-EQ NFO future row for the same name — must be ignored by the EQ map.
  {
    symbol: "RELIANCE26JUN25FUT",
    token: "57000",
    name: "RELIANCE",
    expiry: "26JUN2025",
    strike: "-1.000000",
    instrumenttype: "FUTSTK",
    exch_seg: "NFO",
  },
];

describe("services/india/angelone helpers", () => {
  describe("buildEqTokenMap()", () => {
    it("maps NSE cash (-EQ) names to their numeric tokens", () => {
      const map = buildEqTokenMap(cashRows);
      expect(map.get("RELIANCE")).toEqual({ token: "2885", exchange: "NSE" });
      expect(map.get("TCS")).toEqual({ token: "11536", exchange: "NSE" });
    });

    it("ignores non-EQ rows (e.g. NFO futures)", () => {
      const map = buildEqTokenMap(cashRows);
      // The only RELIANCE entry must be the cash token, not the future token.
      expect(map.get("RELIANCE")?.token).toBe("2885");
    });

    it("returns an empty map for no rows", () => {
      expect(buildEqTokenMap([]).size).toBe(0);
    });
  });

  describe("resolveAngelToken()", () => {
    const map = buildEqTokenMap(cashRows);

    it("resolves index proxy symbols to their hardcoded index tokens", () => {
      expect(resolveAngelToken("^NSEI", map)).toEqual(INDEX_TOKENS.NIFTY);
      expect(resolveAngelToken("^NSEBANK", map)).toEqual(INDEX_TOKENS.BANKNIFTY);
    });

    it("resolves a bare stock symbol to its cash token", () => {
      expect(resolveAngelToken("RELIANCE", map)).toEqual({
        token: "2885",
        exchange: "NSE",
      });
    });

    it("strips a Yahoo .NS suffix before resolving", () => {
      expect(resolveAngelToken("RELIANCE.NS", map)).toEqual({
        token: "2885",
        exchange: "NSE",
      });
    });

    it("returns null for symbols Angel One cannot resolve", () => {
      expect(resolveAngelToken("^BSESN", map)).toBeNull();
      expect(resolveAngelToken("DOESNOTEXIST", map)).toBeNull();
    });
  });

  describe("intervalToSmartApi()", () => {
    it("maps supported intervals to SmartAPI enum strings", () => {
      expect(intervalToSmartApi("1m")).toBe("ONE_MINUTE");
      expect(intervalToSmartApi("5m")).toBe("FIVE_MINUTE");
      expect(intervalToSmartApi("15m")).toBe("FIFTEEN_MINUTE");
      expect(intervalToSmartApi("30m")).toBe("THIRTY_MINUTE");
      expect(intervalToSmartApi("1h")).toBe("ONE_HOUR");
      expect(intervalToSmartApi("1d")).toBe("ONE_DAY");
    });

    it("returns null for intervals SmartAPI does not support (weekly)", () => {
      expect(intervalToSmartApi("1w")).toBeNull();
    });
  });

  describe("quoteFromQuoteRow()", () => {
    const row: AngelQuoteRow = {
      exchange: "NSE",
      tradingSymbol: "RELIANCE-EQ",
      symbolToken: "2885",
      ltp: 2950.5,
      open: 2900,
      high: 2960,
      low: 2890,
      close: 2910,
      netChange: 40.5,
      percentChange: 1.39,
      tradeVolume: 1234567,
    };

    it("maps a FULL-mode quote row into the canonical Quote shape", () => {
      const q = quoteFromQuoteRow("RELIANCE", row);
      expect(q.symbol).toBe("RELIANCE");
      expect(q.price).toBe(2950.5);
      expect(q.prevClose).toBe(2910);
      expect(q.change).toBe(40.5);
      expect(q.changePct).toBe(1.39);
      expect(q.open).toBe(2900);
      expect(q.high).toBe(2960);
      expect(q.low).toBe(2890);
      expect(q.volume).toBe(1234567);
      expect(q.name).toBe("RELIANCE-EQ");
      expect(typeof q.fetchedAt).toBe("string");
    });

    it("tolerates missing optional numeric fields", () => {
      const q = quoteFromQuoteRow("X", {
        tradingSymbol: "X-EQ",
        symbolToken: "1",
        ltp: 10,
      });
      expect(q.price).toBe(10);
      expect(q.change).toBeNull();
      expect(q.changePct).toBeNull();
      expect(q.prevClose).toBeNull();
    });
  });

  describe("candlesFromCandleData()", () => {
    it("parses [ts,o,h,l,c,v] tuples into Candle objects with epoch-second time", () => {
      const tuples: AngelCandleTuple[] = [
        ["2026-06-12T09:15:00+05:30", 100, 105, 99, 102, 5000],
        ["2026-06-12T09:16:00+05:30", 102, 108, 101, 107, 6200],
      ];
      const candles = candlesFromCandleData(tuples);
      expect(candles).toHaveLength(2);
      expect(candles[0]).toEqual({
        time: Math.floor(Date.parse("2026-06-12T09:15:00+05:30") / 1000),
        open: 100,
        high: 105,
        low: 99,
        close: 102,
        volume: 5000,
      });
      expect(candles[1].close).toBe(107);
    });

    it("skips malformed tuples", () => {
      const tuples = [
        ["2026-06-12T09:15:00+05:30", 100, 105, 99, 102, 5000],
        // Deliberately malformed (bad date + non-numeric fields).
        ["bad-date", "x", null, undefined, 0, 0],
      ] as unknown as AngelCandleTuple[];
      const candles = candlesFromCandleData(tuples);
      expect(candles).toHaveLength(1);
    });

    it("returns an empty array for no rows", () => {
      expect(candlesFromCandleData([])).toEqual([]);
    });
  });

  describe("INDEX_TOKENS", () => {
    it("carries the four F&O index tokens on the NSE exchange", () => {
      expect(INDEX_TOKENS.NIFTY.exchange).toBe("NSE");
      expect(INDEX_TOKENS.BANKNIFTY.token).toMatch(/^\d+$/);
      expect(INDEX_TOKENS.FINNIFTY.token).toMatch(/^\d+$/);
      expect(INDEX_TOKENS.MIDCPNIFTY.token).toMatch(/^\d+$/);
    });
  });

  describe("getQuotes({ allowFallback: false })", () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of SMARTAPI_VARS) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      for (const k of SMARTAPI_VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("returns empty placeholders (never Yahoo) when unconfigured and fallback is disabled", async () => {
      const quotes = await angel.getQuotes(["RELIANCE", "^CNXIT"], {
        allowFallback: false,
      });
      expect(quotes).toHaveLength(2);
      for (const q of quotes) {
        expect(q.price).toBeNull();
        expect(q.source).toBeUndefined();
      }
    });
  });
});
