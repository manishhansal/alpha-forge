/**
 * Tests — Signal Source Registry (Phase 1 & 2)
 *
 * Regression tests for every known validation problem:
 *   - Generic 'technical' signals must not contaminate strategy metrics
 *   - UNKNOWN source must trigger error bucket
 *   - AI_SIGNAL must be MANUAL, not STRATEGY or TECHNICAL_BASELINE
 *   - Only official 9 India strategies are leaderboard-eligible
 */

import { describe, it, expect } from "vitest";
import {
  SignalSourceRegistry,
  assertOfficialStrategy,
  isOfficialStrategySource,
  getPaperTradeReportingBucket,
} from "@/lib/signal-intelligence/signal-source-registry";
import {
  OFFICIAL_INDIA_STRATEGY_IDS,
  isOfficialIndiaStrategy,
} from "@/lib/signal-intelligence/types";

describe("SignalSourceRegistry", () => {
  describe("official India strategies", () => {
    it("all 9 official strategies are registered", () => {
      for (const id of OFFICIAL_INDIA_STRATEGY_IDS) {
        const entry = SignalSourceRegistry.get(id);
        expect(entry.sourceId).toBe(id);
        expect(entry.sourceType).toBe("STRATEGY");
        expect(entry.leaderboardEligible).toBe(true);
      }
    });

    it("all official strategies are in OFFICIAL_STRATEGIES reporting bucket", () => {
      for (const id of OFFICIAL_INDIA_STRATEGY_IDS) {
        expect(SignalSourceRegistry.classifyBucket(id)).toBe("OFFICIAL_STRATEGIES");
      }
    });

    it("officialStrategies() returns exactly 9 entries", () => {
      const official = SignalSourceRegistry.officialStrategies();
      expect(official).toHaveLength(9);
      expect(official.map((s) => s.sourceId).sort()).toEqual(
        [...OFFICIAL_INDIA_STRATEGY_IDS].sort(),
      );
    });
  });

  describe("REGRESSION: generic technical signal masking (Phase 2)", () => {
    it("'technical' source is classified as TECHNICAL_BASELINE", () => {
      expect(SignalSourceRegistry.isGenericTechnical("technical")).toBe(true);
      expect(SignalSourceRegistry.isGenericTechnical("TECHNICAL")).toBe(true);
    });

    it("'generic' source is classified as generic technical", () => {
      expect(SignalSourceRegistry.isGenericTechnical("generic")).toBe(true);
    });

    it("'fallback' source is classified as generic technical", () => {
      expect(SignalSourceRegistry.isGenericTechnical("fallback")).toBe(true);
    });

    it("'heuristic' source is classified as generic technical", () => {
      expect(SignalSourceRegistry.isGenericTechnical("heuristic")).toBe(true);
    });

    it("TECHNICAL_BASELINE is NOT leaderboard-eligible", () => {
      expect(SignalSourceRegistry.isLeaderboardEligible("TECHNICAL_BASELINE")).toBe(false);
    });

    it("TECHNICAL_BASELINE routes to RESEARCH_ONLY", () => {
      expect(SignalSourceRegistry.getFlowDestination("TECHNICAL_BASELINE")).toBe("RESEARCH_ONLY");
    });
  });

  describe("REGRESSION: AI_SIGNAL must be MANUAL not STRATEGY (Phase 2)", () => {
    it("AI_SIGNAL has sourceType MANUAL", () => {
      expect(SignalSourceRegistry.getSourceType("AI_SIGNAL")).toBe("MANUAL");
    });

    it("AI_SIGNAL is NOT leaderboard-eligible", () => {
      expect(SignalSourceRegistry.isLeaderboardEligible("AI_SIGNAL")).toBe(false);
    });

    it("AI_SIGNAL bucket is MANUAL not OFFICIAL_STRATEGIES", () => {
      expect(SignalSourceRegistry.classifyBucket("AI_SIGNAL")).toBe("MANUAL");
    });

    it("AI_SIGNAL is not an official India strategy", () => {
      expect(isOfficialIndiaStrategy("AI_SIGNAL")).toBe(false);
    });

    it("AI_SIGNAL is not generic technical", () => {
      // AI_SIGNAL is MANUAL — not in generic technical bucket
      expect(SignalSourceRegistry.isGenericTechnical("AI_SIGNAL")).toBe(false);
    });
  });

  describe("REGRESSION: UNKNOWN source must be an error (Phase 1)", () => {
    it("UNKNOWN source returns error bucket", () => {
      expect(SignalSourceRegistry.classifyBucket("UNKNOWN")).toBe("UNKNOWN");
    });

    it("unregistered source returns UNKNOWN bucket", () => {
      expect(SignalSourceRegistry.classifyBucket("SOME_MADE_UP_STRATEGY")).toBe("UNKNOWN");
    });

    it("UNKNOWN source fails validation", () => {
      const result = SignalSourceRegistry.validate("UNKNOWN");
      expect(result.valid).toBe(false);
      expect(result.error).not.toBeNull();
    });

    it("UNKNOWN source routes to ERROR_INVESTIGATE", () => {
      expect(SignalSourceRegistry.getFlowDestination("UNKNOWN")).toBe("ERROR_INVESTIGATE");
    });

    it("unregistered source routes to ERROR_INVESTIGATE", () => {
      expect(SignalSourceRegistry.getFlowDestination("MADE_UP_STRATEGY")).toBe("ERROR_INVESTIGATE");
    });
  });

  describe("paper trade source classification", () => {
    it("India paper trade source 'in:RANGE_EXPANSION:5m' classifies correctly", () => {
      const result = SignalSourceRegistry.classifyPaperTradeSource("in:RANGE_EXPANSION:5m");
      expect(result.isIndia).toBe(true);
      expect(result.strategyId).toBe("RANGE_EXPANSION");
      expect(result.timeframe).toBe("5m");
      expect(result.sourceType).toBe("STRATEGY");
      expect(result.bucket).toBe("OFFICIAL_STRATEGIES");
    });

    it("India paper trade source 'in:AI_SIGNAL:1d' classifies as MANUAL", () => {
      const result = SignalSourceRegistry.classifyPaperTradeSource("in:AI_SIGNAL:1d");
      expect(result.isIndia).toBe(true);
      expect(result.strategyId).toBe("AI_SIGNAL");
      expect(result.sourceType).toBe("MANUAL");
      expect(result.bucket).toBe("MANUAL");
    });

    it("crypto paper trade source 'UT_SMC:5m' classifies as non-India", () => {
      const result = SignalSourceRegistry.classifyPaperTradeSource("UT_SMC:5m");
      expect(result.isIndia).toBe(false);
    });

    it("getPaperTradeReportingBucket returns correct bucket for India OPENING_BREAKOUT", () => {
      expect(getPaperTradeReportingBucket("in:OPENING_BREAKOUT:5m")).toBe("OFFICIAL_STRATEGIES");
    });

    it("getPaperTradeReportingBucket returns MANUAL for AI_SIGNAL", () => {
      expect(getPaperTradeReportingBucket("in:AI_SIGNAL:1d")).toBe("MANUAL");
    });

    it("getPaperTradeReportingBucket returns UNKNOWN for unregistered source", () => {
      expect(getPaperTradeReportingBucket("in:GHOST_STRATEGY:5m")).toBe("UNKNOWN");
    });
  });

  describe("assertOfficialStrategy", () => {
    it("does not throw for RANGE_EXPANSION", () => {
      expect(() => assertOfficialStrategy("RANGE_EXPANSION")).not.toThrow();
    });

    it("throws for AI_SIGNAL", () => {
      expect(() => assertOfficialStrategy("AI_SIGNAL")).toThrow();
    });

    it("throws for 'technical'", () => {
      expect(() => assertOfficialStrategy("technical")).toThrow();
    });

    it("throws for UNKNOWN", () => {
      expect(() => assertOfficialStrategy("UNKNOWN")).toThrow();
    });
  });

  describe("isOfficialStrategySource", () => {
    it("returns true for all 9 official strategy IDs", () => {
      for (const id of OFFICIAL_INDIA_STRATEGY_IDS) {
        expect(isOfficialStrategySource(id)).toBe(true);
      }
    });

    it("returns false for SCANNER_HIT", () => {
      expect(isOfficialStrategySource("SCANNER_HIT")).toBe(false);
    });

    it("returns false for DAILY_PICK", () => {
      expect(isOfficialStrategySource("DAILY_PICK")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isOfficialStrategySource("")).toBe(false);
    });
  });
});
