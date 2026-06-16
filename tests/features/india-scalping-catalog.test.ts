import { describe, expect, it } from "vitest";

import {
  ALL_INDIA_STRATEGY_IDS,
  INDIA_SCALP_STRATEGY_CATALOG,
  INDIA_SCALP_STRATEGY_IDS,
  getIndiaStrategyMeta,
  isIndiaScalpStrategyId,
} from "@/features/india/scalping/strategies/catalog";
import {
  INDIA_SCALP_TIMEFRAMES,
  buildIndiaTradeSource,
  parseIndiaTradeSource,
} from "@/features/india/scalping/types";

describe("features/india/scalping — strategy catalog", () => {
  it("ships the nine F&O strategies — six scanner-derived, two ILE-Pine ports, plus Opening Breakout", () => {
    expect([...INDIA_SCALP_STRATEGY_IDS]).toEqual([
      "RANGE_EXPANSION",
      "MOMENTUM",
      "VOLUME_BREAKOUT",
      "OI_BUILDUP",
      "PCR_EXTREME",
      "IV_SPIKE",
      "LIQUIDITY_EDGE",
      "MAX_PAIN_GRAVITY",
      "OPENING_BREAKOUT",
    ]);
    expect(INDIA_SCALP_STRATEGY_CATALOG).toHaveLength(9);
  });

  it("includes the Opening Breakout strategy with breakout metadata", () => {
    const orb = getIndiaStrategyMeta("OPENING_BREAKOUT");
    expect(orb.label).toMatch(/opening breakout/i);
    expect(orb.category).toBe("breakout");
    expect(orb.description).toMatch(/retest/i);
  });

  it("includes India Liquidity Edge + India Max-Pain Gravity with distinct categories", () => {
    const ile = getIndiaStrategyMeta("LIQUIDITY_EDGE");
    const impg = getIndiaStrategyMeta("MAX_PAIN_GRAVITY");
    expect(ile.label).toMatch(/liquidity edge/i);
    expect(impg.label).toMatch(/max.?pain/i);
    // Distinct monograms so the picker chips don't collide.
    const monograms = INDIA_SCALP_STRATEGY_CATALOG.map((m) => m.monogram);
    expect(new Set(monograms).size).toBe(monograms.length);
  });

  it("every catalog entry has the full metadata the picker needs", () => {
    for (const meta of INDIA_SCALP_STRATEGY_CATALOG) {
      expect(meta.id).toBeTruthy();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.label.length).toBeLessThanOrEqual(22);
      expect(meta.description.length).toBeGreaterThan(20);
      expect(meta.monogram.length).toBe(1);
      expect(meta.tags.length).toBeGreaterThan(0);
      expect(["neutral", "bull", "bear", "warning", "info", "outline"]).toContain(
        meta.badge,
      );
    }
  });

  it("getIndiaStrategyMeta resolves every id", () => {
    for (const id of ALL_INDIA_STRATEGY_IDS) {
      const meta = getIndiaStrategyMeta(id);
      expect(meta.id).toBe(id);
    }
  });

  it("isIndiaScalpStrategyId narrows correctly", () => {
    expect(isIndiaScalpStrategyId("MOMENTUM")).toBe(true);
    expect(isIndiaScalpStrategyId("PCR_EXTREME")).toBe(true);
    expect(isIndiaScalpStrategyId("UT_SMC")).toBe(false);
    expect(isIndiaScalpStrategyId("")).toBe(false);
  });
});

describe("features/india/scalping — trade source roundtrip", () => {
  it("builds the canonical `in:<id>:<tf>` source string", () => {
    expect(buildIndiaTradeSource("MOMENTUM", "5m")).toBe("in:MOMENTUM:5m");
    expect(buildIndiaTradeSource("PCR_EXTREME", "15m")).toBe(
      "in:PCR_EXTREME:15m",
    );
  });

  it("parses a canonical source string back into its parts", () => {
    expect(parseIndiaTradeSource("in:MOMENTUM:5m")).toEqual({
      strategyId: "MOMENTUM",
      timeframe: "5m",
    });
    expect(parseIndiaTradeSource("in:IV_SPIKE:1m")).toEqual({
      strategyId: "IV_SPIKE",
      timeframe: "1m",
    });
  });

  it("returns null for crypto sources (no `in:` prefix) — markets stay isolated", () => {
    expect(parseIndiaTradeSource("UT_SMC:5m")).toBeNull();
    expect(parseIndiaTradeSource("SMC_UTBOT:5m")).toBeNull();
    expect(parseIndiaTradeSource("VWAP_REVERSION:1m")).toBeNull();
  });

  it("returns null for malformed sources", () => {
    expect(parseIndiaTradeSource("in:MOMENTUM")).toBeNull();
    expect(parseIndiaTradeSource("in:MOMENTUM:99m")).toBeNull();
    expect(parseIndiaTradeSource("")).toBeNull();
  });

  it("round-trip preserves payload for every (strategy × timeframe) combo", () => {
    for (const id of ALL_INDIA_STRATEGY_IDS) {
      for (const tf of INDIA_SCALP_TIMEFRAMES) {
        const src = buildIndiaTradeSource(id, tf);
        const parsed = parseIndiaTradeSource(src);
        expect(parsed).toEqual({ strategyId: id, timeframe: tf });
      }
    }
  });
});
