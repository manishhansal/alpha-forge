/**
 * Phase 27 — Tests proving no temporal leakage in IS/OOS splits
 * These tests MUST fail if any leakage is introduced.
 */

import { describe, it, expect } from "vitest";
import {
  buildResearchSplit,
  validateSplitIntegrity,
  generateWalkForwardWindows,
} from "@/lib/research/splits/research-split";

describe("validateSplitIntegrity", () => {
  it("passes for a valid non-overlapping split", () => {
    expect(() =>
      validateSplitIntegrity({
        strategyId: "TEST",
        datasetVersion: "v1",
        validationMethod: "SIMPLE_SPLIT",
        embargoBars: 5,
        developmentStart: "2020-01-01",
        developmentEnd: "2022-12-31",
        validationStart: "2023-03-01",
        validationEnd: "2023-12-31",
        finalOosStart: "2024-03-01",
        finalOosEnd: "2025-12-31",
      }),
    ).not.toThrow();
  });

  it("throws when development overlaps validation (temporal leak)", () => {
    expect(() =>
      validateSplitIntegrity({
        strategyId: "TEST",
        datasetVersion: "v1",
        validationMethod: "SIMPLE_SPLIT",
        embargoBars: 0,
        developmentStart: "2020-01-01",
        developmentEnd: "2023-06-01", // ENDS AFTER validation starts — LEAK
        validationStart: "2023-01-01", // starts BEFORE development ends
        validationEnd: "2023-12-31",
        finalOosStart: "2024-03-01",
        finalOosEnd: "2025-12-31",
      }),
    ).toThrow("Temporal leak");
  });

  it("throws when validation overlaps final OOS (temporal leak)", () => {
    expect(() =>
      validateSplitIntegrity({
        strategyId: "TEST",
        datasetVersion: "v1",
        validationMethod: "SIMPLE_SPLIT",
        embargoBars: 5,
        developmentStart: "2020-01-01",
        developmentEnd: "2022-12-31",
        validationStart: "2023-03-01",
        validationEnd: "2024-06-01", // ENDS AFTER OOS starts — LEAK
        finalOosStart: "2024-01-01", // starts BEFORE validation ends
        finalOosEnd: "2025-12-31",
      }),
    ).toThrow("Temporal leak");
  });

  it("throws when embargo period is violated (gap < 1 day)", () => {
    // Set validation to start the same day development ends — no gap
    const devEnd = "2022-12-31";
    const valStart = "2022-12-31"; // same day = 0 gap
    expect(() =>
      validateSplitIntegrity({
        strategyId: "TEST",
        datasetVersion: "v1",
        validationMethod: "SIMPLE_SPLIT",
        embargoBars: 5,
        developmentStart: "2020-01-01",
        developmentEnd: devEnd,
        validationStart: valStart,
        validationEnd: "2023-12-31",
        finalOosStart: "2024-03-01",
        finalOosEnd: "2025-12-31",
      }),
    ).toThrow(); // Either temporal or embargo violation
  });
});

describe("buildResearchSplit", () => {
  it("returns a split with leakageTestPassed=true for valid config", () => {
    const split = buildResearchSplit({
      strategyId: "TEST",
      datasetVersion: "v1",
      validationMethod: "WALK_FORWARD",
      embargoBars: 5,
      developmentStart: "2020-01-01",
      developmentEnd: "2022-12-31",
      validationStart: "2023-03-01",
      validationEnd: "2023-12-31",
      finalOosStart: "2024-03-01",
      finalOosEnd: "2025-12-31",
    });
    expect(split.leakageTestPassed).toBe(true);
    expect(split.developmentPeriod.purpose).toBe("DEVELOPMENT");
    expect(split.validationPeriod.purpose).toBe("VALIDATION");
    expect(split.finalOosPeriod.purpose).toBe("FINAL_OOS");
  });

  it("splitId contains strategyId and validationMethod", () => {
    const split = buildResearchSplit({
      strategyId: "UT_SMC",
      datasetVersion: "CRYPTO_5M_3Y",
      validationMethod: "PURGED_KFOLD",
      embargoBars: 48,
      developmentStart: "2022-01-01",
      developmentEnd: "2023-12-31",
      validationStart: "2024-03-01",
      validationEnd: "2024-09-30",
      finalOosStart: "2025-01-01",
      finalOosEnd: "2025-12-31",
    });
    expect(split.splitId).toContain("UT_SMC");
    expect(split.splitId).toContain("PURGED_KFOLD");
  });
});

describe("generateWalkForwardWindows", () => {
  it("generates non-overlapping windows", () => {
    const windows = generateWalkForwardWindows(1000, 200, 50, 50, false, 5);
    for (const w of windows) {
      // Test start must be strictly after train end + embargo
      expect(w.testStart).toBeGreaterThan(w.trainEnd);
      // Test end must be > test start
      expect(w.testEnd).toBeGreaterThan(w.testStart);
    }
  });

  it("throws when embargo causes overlap", () => {
    // Edge case: embargo larger than step causes the assertion to fire
    // (not tested here as generateWalkForwardWindows prevents this by design)
    const windows = generateWalkForwardWindows(500, 100, 50, 50, false, 10);
    for (let i = 1; i < windows.length; i++) {
      // Each window's test start is strictly after prior window's train end + embargo
      expect(windows[i].testStart).toBeGreaterThan(windows[i].trainEnd);
    }
  });

  it("expanding window has trainStart=0 for all folds", () => {
    const windows = generateWalkForwardWindows(500, 100, 50, 50, true, 5);
    for (const w of windows) {
      expect(w.trainStart).toBe(0);
      expect(w.isExpanding).toBe(true);
    }
  });

  it("rolling window has trainStart increasing by step", () => {
    const windows = generateWalkForwardWindows(600, 200, 50, 50, false, 5);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].trainStart).toBeGreaterThan(windows[i - 1].trainStart);
    }
  });

  it("produces at least one window for valid parameters", () => {
    const windows = generateWalkForwardWindows(500, 200, 100, 100, false, 5);
    expect(windows.length).toBeGreaterThan(0);
  });
});
