import { describe, expect, it } from "vitest";

import {
  mapOiBuildupKind,
  parseGainersLosers,
  parseGreekRows,
  parseOiBuildup,
  parsePcr,
  underlyingFromFutSymbol,
} from "@/services/india/angelone/derivatives";

describe("services/india/angelone/derivatives", () => {
  describe("underlyingFromFutSymbol()", () => {
    it("strips the expiry + FUT suffix off an index future", () => {
      expect(underlyingFromFutSymbol("NIFTY29MAY25FUT")).toBe("NIFTY");
      expect(underlyingFromFutSymbol("BANKNIFTY24APR2025FUT")).toBe("BANKNIFTY");
    });

    it("handles stock futures, including names with & and -", () => {
      expect(underlyingFromFutSymbol("RELIANCE24APR25FUT")).toBe("RELIANCE");
      expect(underlyingFromFutSymbol("M&M28AUG25FUT")).toBe("M&M");
      expect(underlyingFromFutSymbol("BAJAJ-AUTO28AUG25FUT")).toBe("BAJAJ-AUTO");
    });

    it("returns the input (trimmed of a bare FUT) when no expiry pattern matches", () => {
      expect(underlyingFromFutSymbol("WEIRD")).toBe("WEIRD");
      expect(underlyingFromFutSymbol("")).toBe("");
    });
  });

  describe("mapOiBuildupKind()", () => {
    it("maps SmartAPI build-up labels to the canonical OiBuildupKind", () => {
      expect(mapOiBuildupKind("Long Built Up")).toBe("LONG_BUILDUP");
      expect(mapOiBuildupKind("Short Built Up")).toBe("SHORT_BUILDUP");
      expect(mapOiBuildupKind("Short Covering")).toBe("SHORT_COVERING");
      expect(mapOiBuildupKind("Long Unwinding")).toBe("LONG_UNWINDING");
    });

    it("is case- and whitespace-insensitive", () => {
      expect(mapOiBuildupKind("long built up")).toBe("LONG_BUILDUP");
      expect(mapOiBuildupKind("  SHORT   COVERING  ")).toBe("SHORT_COVERING");
    });

    it("returns null for an unknown label", () => {
      expect(mapOiBuildupKind("garbage")).toBeNull();
    });
  });

  describe("parseGainersLosers()", () => {
    it("normalises FUT rows into underlying-keyed records (numeric coercion)", () => {
      const rows = parseGainersLosers([
        {
          tradingSymbol: "RELIANCE24APR25FUT",
          symbolToken: "57000",
          ltp: "2950.5",
          netChange: 40.5,
          percentChange: "1.39",
          opnInterest: "120000",
        },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        symbol: "RELIANCE",
        tradingSymbol: "RELIANCE24APR25FUT",
        token: "57000",
        ltp: 2950.5,
        netChange: 40.5,
        percentChange: 1.39,
        oi: 120000,
      });
    });

    it("returns [] for non-array / empty input", () => {
      expect(parseGainersLosers(null)).toEqual([]);
      expect(parseGainersLosers(undefined)).toEqual([]);
      expect(parseGainersLosers([])).toEqual([]);
    });

    it("skips rows with no resolvable trading symbol", () => {
      expect(parseGainersLosers([{ ltp: 10 }])).toEqual([]);
    });
  });

  describe("parsePcr()", () => {
    it("maps {pcr, tradingSymbol} rows to {symbol, pcr}", () => {
      const rows = parsePcr([
        { pcr: 1.24, tradingSymbol: "NIFTY29MAY25FUT" },
        { pcr: "0.82", tradingSymbol: "BANKNIFTY29MAY25FUT" },
      ]);
      expect(rows).toEqual([
        { symbol: "NIFTY", pcr: 1.24 },
        { symbol: "BANKNIFTY", pcr: 0.82 },
      ]);
    });

    it("drops rows with a non-finite PCR", () => {
      const rows = parsePcr([
        { pcr: "x", tradingSymbol: "NIFTY29MAY25FUT" },
        { pcr: 1.1, tradingSymbol: "TCS29MAY25FUT" },
      ]);
      expect(rows).toEqual([{ symbol: "TCS", pcr: 1.1 }]);
    });

    it("returns [] for non-array input", () => {
      expect(parsePcr({})).toEqual([]);
    });
  });

  describe("parseOiBuildup()", () => {
    it("tags every row with the kind derived from the request datatype", () => {
      const rows = parseOiBuildup(
        [
          {
            tradingSymbol: "RELIANCE24APR25FUT",
            symbolToken: "57000",
            ltp: 2950,
            percentChange: 1.2,
            opnInterest: 120000,
          },
        ],
        "Long Built Up",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        symbol: "RELIANCE",
        tradingSymbol: "RELIANCE24APR25FUT",
        token: "57000",
        ltp: 2950,
        percentChange: 1.2,
        oi: 120000,
        kind: "LONG_BUILDUP",
      });
    });

    it("returns [] when the datatype is not a recognised build-up label", () => {
      expect(
        parseOiBuildup([{ tradingSymbol: "RELIANCE24APR25FUT" }], "nonsense"),
      ).toEqual([]);
    });

    it("returns [] for non-array rows", () => {
      expect(parseOiBuildup(null, "Long Built Up")).toEqual([]);
    });
  });

  describe("parseGreekRows()", () => {
    it("maps SmartAPI greek rows to a strike:type → full-greeks map", () => {
      const m = parseGreekRows([
        {
          strikePrice: "3900.000000",
          optionType: "CE",
          delta: "0.4924",
          gamma: "0.0028",
          theta: "-4.0918",
          vega: "2.2967",
          impliedVolatility: "16.33",
        },
        {
          strikePrice: "3900.000000",
          optionType: "PE",
          delta: "-0.5076",
          gamma: "0.0028",
          theta: "-3.9",
          vega: "2.29",
          impliedVolatility: "17.1",
        },
      ]);
      expect(m.get("3900:CE")).toEqual({
        delta: 0.4924,
        gamma: 0.0028,
        theta: -4.0918,
        vega: 2.2967,
        iv: 16.33,
      });
      expect(m.get("3900:PE")?.delta).toBe(-0.5076);
    });

    it("coerces missing / non-numeric greeks to null but still keys the row", () => {
      const m = parseGreekRows([
        { strikePrice: "100", optionType: "CE", impliedVolatility: "12" },
      ]);
      expect(m.get("100:CE")).toEqual({
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
        iv: 12,
      });
    });

    it("skips rows missing a strike or option type, and tolerates non-arrays", () => {
      expect(parseGreekRows([{ optionType: "CE" }]).size).toBe(0);
      expect(parseGreekRows([{ strikePrice: "100" }]).size).toBe(0);
      expect(parseGreekRows(null).size).toBe(0);
    });
  });
});
