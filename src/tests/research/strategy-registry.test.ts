/**
 * Phase 27 — Unit Tests: Strategy Registry & Hypothesis
 */

import { describe, it, expect } from "vitest";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";
import { HypothesisRegistry } from "@/lib/research/hypothesis/strategy-hypothesis";

describe("StrategyRegistry", () => {
  it("has more than 0 strategies registered", () => {
    expect(StrategyRegistry.getAll().length).toBeGreaterThan(0);
  });

  it("contains all expected crypto scalp strategies", () => {
    const expected = [
      "UT_SMC", "VWAP_SWEEP_TREND", "NEWS_MOMENTUM", "RANGE_SCALP",
      "EMA_PULLBACK", "VWAP_REVERSION", "ORDERFLOW_SWEEP", "FIB_PULLBACK",
      "INSTITUTIONAL_SMC", "AI_INSTITUTIONAL_PRO",
    ];
    for (const id of expected) {
      expect(StrategyRegistry.has(id)).toBe(true);
    }
  });

  it("contains all expected India F&O strategies", () => {
    const expected = [
      "FNO_TREND", "FNO_RANGE_EXPANSION", "INDIA_MOMENTUM",
      "INDIA_VOLUME_BREAKOUT", "INDIA_OI_BUILDUP", "INDIA_AI_SIGNALS",
      "INDIA_SUPER_CONFLUENCE",
    ];
    for (const id of expected) {
      expect(StrategyRegistry.has(id)).toBe(true);
    }
  });

  it("getOrThrow throws for unknown strategy", () => {
    expect(() => StrategyRegistry.getOrThrow("NOT_A_REAL_STRATEGY")).toThrow();
  });

  it("all strategies have required fields", () => {
    for (const s of StrategyRegistry.getAll()) {
      expect(s.strategyId).toBeTruthy();
      expect(s.strategyName).toBeTruthy();
      expect(s.market).toBeTruthy();
      expect(s.instrumentType).toBeTruthy();
      expect(s.timeframe).toBeTruthy();
      expect(s.entryLogic).toBeTruthy();
      expect(s.exitLogic).toBeTruthy();
      expect(s.strategyCategory).toBeTruthy();
      expect(s.status).toBeTruthy();
    }
  });

  it("no two strategies share the same strategyId", () => {
    const ids = StrategyRegistry.ids();
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("byMarket returns only strategies for the requested market", () => {
    const crypto = StrategyRegistry.byMarket("CRYPTO");
    for (const s of crypto) {
      expect(s.market).toBe("CRYPTO");
    }
  });
});

describe("HypothesisRegistry", () => {
  it("has hypotheses for all non-STRATEGY_LAB strategies", () => {
    const allStrategies = StrategyRegistry.getAll().filter(
      (s) => s.strategyId !== "STRATEGY_LAB_USER",
    );
    for (const s of allStrategies) {
      const h = HypothesisRegistry.get(s.strategyId);
      expect(h).toBeDefined();
      expect(h?.status).toBe("DEFINED");
    }
  });

  it("getOrDefault returns UNVALIDATED for unknown strategy", () => {
    const h = HypothesisRegistry.getOrDefault("NOT_A_REAL_STRATEGY");
    expect(h.status).toBe("UNVALIDATED");
    expect(h.hypothesis).toBe("NO HYPOTHESIS DECLARED");
  });

  it("isValidated returns true for strategies with DEFINED hypothesis", () => {
    expect(HypothesisRegistry.isValidated("UT_SMC")).toBe(true);
    expect(HypothesisRegistry.isValidated("INDIA_AI_SIGNALS")).toBe(true);
  });

  it("all defined hypotheses have non-empty required fields", () => {
    for (const h of HypothesisRegistry.getAll()) {
      if (h.status !== "DEFINED") continue;
      expect(h.hypothesis.length).toBeGreaterThan(50);
      expect(h.marketInefficiency.length).toBeGreaterThan(20);
      expect(h.expectedEdge.length).toBeGreaterThan(20);
      expect(h.expectedFailureMode.length).toBeGreaterThan(20);
      expect(h.whatWouldInvalidate.length).toBeGreaterThan(20);
      expect(h.expectedRegime.length).toBeGreaterThan(0);
    }
  });
});
