/**
 * Tests — FNO Universe Service & Coverage (Phases 3 & 4)
 *
 * Regression tests for:
 *   - Incomplete F&O universe coverage (known validation bug)
 *   - Coverage score must be computed and validated
 *   - Universe must include all 4 F&O indices
 *   - Signal report invalid when coverage unknown
 */

import { describe, it, expect } from "vitest";
import {
  FNOUniverseService,
  buildUniverseCoverageSnapshot,
  buildUnavailableCoverageSnapshot,
  formatCoverageSummary,
  MIN_VALID_COVERAGE,
} from "@/lib/signal-intelligence/fno-universe";
import { FNO_INDICES, FNO_STOCKS } from "@/lib/india/fno-symbols";

describe("FNOUniverseService", () => {
  describe("universe composition", () => {
    it("includes all 4 F&O index underlyings", () => {
      const indices = FNOUniverseService.getIndexUnderlyings();
      expect(indices).toContain("NIFTY");
      expect(indices).toContain("BANKNIFTY");
      expect(indices).toContain("FINNIFTY");
      expect(indices).toContain("MIDCPNIFTY");
    });

    it("includes F&O stocks from sectors.ts", () => {
      const stocks = FNOUniverseService.getFNOStockSymbols();
      expect(stocks.length).toBeGreaterThan(100);
      expect(stocks).toContain("RELIANCE");
      expect(stocks).toContain("HDFCBANK");
      expect(stocks).toContain("TATASTEEL");
    });

    it("total universe count is indices + stocks", () => {
      const summary = FNOUniverseService.getSummary();
      expect(summary.indices).toBe(4);
      expect(summary.stocks).toBeGreaterThan(100);
      expect(summary.total).toBe(summary.indices + summary.stocks);
    });

    it("NIFTY category is NIFTY", () => {
      expect(FNOUniverseService.getCategoryForSymbol("NIFTY")).toBe("NIFTY");
    });

    it("BANKNIFTY category is BANKNIFTY", () => {
      expect(FNOUniverseService.getCategoryForSymbol("BANKNIFTY")).toBe("BANKNIFTY");
    });

    it("RELIANCE category is FNO_STOCK", () => {
      expect(FNOUniverseService.getCategoryForSymbol("RELIANCE")).toBe("FNO_STOCK");
    });

    it("unknown symbol is not in universe", () => {
      expect(FNOUniverseService.isInUniverse("FAKECORP123")).toBe(false);
    });

    it("NIFTY is in universe", () => {
      expect(FNOUniverseService.isInUniverse("NIFTY")).toBe(true);
    });
  });

  describe("sector map", () => {
    it("returns sector map with Bank sector", () => {
      const sectorMap = FNOUniverseService.getSectorMap();
      expect(sectorMap["Bank"]).toBeDefined();
      expect(sectorMap["Bank"]).toContain("HDFCBANK");
    });
  });
});

describe("buildUniverseCoverageSnapshot", () => {
  const sessionDate = "2026-09-02";
  const allStocks = FNO_STOCKS.slice(0, 200);
  const scanned = FNO_STOCKS.slice(0, 195);
  const complete = FNO_STOCKS.slice(0, 190);
  const evaluated = FNO_STOCKS.slice(0, 188);
  const eligible = FNO_STOCKS.slice(0, 185);

  const snap = buildUniverseCoverageSnapshot(
    sessionDate,
    scanned,
    allStocks,
    complete,
    evaluated,
    eligible,
    [{ instrument: "YESBANK", reason: "Below minimum liquidity threshold" }],
  );

  it("sets sessionDate correctly", () => {
    expect(snap.sessionDate).toBe(sessionDate);
  });

  it("computes coverageScore as evaluated/expected", () => {
    const expected = FNOUniverseService.getTotalExpected();
    expect(snap.coverageScore).toBeCloseTo(evaluated.length / expected, 2);
  });

  it("includes exclusion reasons", () => {
    expect(snap.exclusionReasons).toHaveLength(1);
    expect(snap.exclusionReasons[0].instrument).toBe("YESBANK");
  });

  it("is valid when coverage >= 80%", () => {
    const highCoverage = buildUniverseCoverageSnapshot(
      sessionDate,
      allStocks,
      allStocks,
      allStocks,
      allStocks,
      allStocks,
      [],
    );
    // Coverage depends on total expected instruments; if scanned > 80%, valid
    if (highCoverage.coverageScore >= MIN_VALID_COVERAGE) {
      expect(highCoverage.isValid).toBe(true);
    }
  });
});

describe("REGRESSION: coverage validity gate (Phase 4)", () => {
  it("buildUnavailableCoverageSnapshot marks report as INVALID", () => {
    const snap = buildUnavailableCoverageSnapshot("2026-09-02", "Scanner not run");
    expect(snap.isValid).toBe(false);
    expect(snap.coverageScore).toBe(0);
  });

  it("formatCoverageSummary includes INVALID label for zero coverage", () => {
    const snap = buildUnavailableCoverageSnapshot("2026-09-02", "Scanner not run");
    const summary = formatCoverageSummary(snap);
    expect(summary).toContain("INVALID");
    expect(summary).toContain("0/");
  });

  it("formatCoverageSummary includes VALID label for full coverage", () => {
    const total = FNOUniverseService.getTotalExpected();
    const allSymbols = Array.from({ length: total }, (_, i) => `SYM${i}`);
    const snap = buildUniverseCoverageSnapshot(
      "2026-09-02",
      allSymbols,
      allSymbols,
      allSymbols,
      allSymbols,
      allSymbols,
      [],
    );
    const summary = formatCoverageSummary(snap);
    // With 100% coverage the report should be VALID
    expect(snap.coverageScore).toBe(1);
    expect(summary).toContain("VALID");
  });
});
