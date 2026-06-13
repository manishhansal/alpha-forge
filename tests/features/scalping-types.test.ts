import { describe, expect, it } from "vitest";

import {
  buildTradeSource,
  parseTradeSource,
  PAPER_TRADE_STATUSES,
  SCALP_STRATEGY_IDS,
} from "@/features/scalping/types";

describe("features/scalping/types", () => {
  describe("SCALP_STRATEGY_IDS", () => {
    it("contains all 10 expected strategies", () => {
      expect(SCALP_STRATEGY_IDS).toEqual(
        expect.arrayContaining([
          "UT_SMC",
          "VWAP_SWEEP_TREND",
          "NEWS_MOMENTUM",
          "RANGE_SCALP",
          "EMA_PULLBACK",
          "VWAP_REVERSION",
          "ORDERFLOW_SWEEP",
          "FIB_PULLBACK",
          "INSTITUTIONAL_SMC",
          "AI_INSTITUTIONAL_PRO",
        ]),
      );
      expect(SCALP_STRATEGY_IDS).toHaveLength(10);
    });
  });

  describe("PAPER_TRADE_STATUSES", () => {
    it("publishes the five lifecycle states", () => {
      expect(PAPER_TRADE_STATUSES).toEqual([
        "OPEN",
        "WIN",
        "LOSS",
        "EXPIRED",
        "CANCELLED",
      ]);
    });
  });

  describe("parseTradeSource()", () => {
    it("parses a well-formed source", () => {
      expect(parseTradeSource("UT_SMC:5m")).toEqual({
        strategyId: "UT_SMC",
        timeframe: "5m",
      });
      expect(parseTradeSource("AI_INSTITUTIONAL_PRO:15m")).toEqual({
        strategyId: "AI_INSTITUTIONAL_PRO",
        timeframe: "15m",
      });
    });

    it("aliases legacy SMC_UTBOT to UT_SMC", () => {
      expect(parseTradeSource("SMC_UTBOT:5m")).toEqual({
        strategyId: "UT_SMC",
        timeframe: "5m",
      });
    });

    it("returns null for malformed sources", () => {
      expect(parseTradeSource("UT_SMC")).toBeNull();
      expect(parseTradeSource(":5m")).toBeNull();
      expect(parseTradeSource("UT_SMC:")).toBeNull();
      expect(parseTradeSource("UNKNOWN:5m")).toBeNull();
    });

    it("rejects unknown timeframes", () => {
      expect(parseTradeSource("UT_SMC:1h")).toBeNull();
      expect(parseTradeSource("UT_SMC:30m")).toBeNull();
    });
  });

  describe("buildTradeSource()", () => {
    it("formats id:timeframe joined by ':'", () => {
      expect(buildTradeSource("UT_SMC", "5m")).toBe("UT_SMC:5m");
      expect(buildTradeSource("INSTITUTIONAL_SMC", "15m")).toBe(
        "INSTITUTIONAL_SMC:15m",
      );
    });

    it("buildTradeSource ↔ parseTradeSource round-trips", () => {
      for (const id of SCALP_STRATEGY_IDS) {
        for (const tf of ["1m", "5m", "15m"] as const) {
          const src = buildTradeSource(id, tf);
          expect(parseTradeSource(src)).toEqual({ strategyId: id, timeframe: tf });
        }
      }
    });
  });
});
