/**
 * MetaCalibrationDatasetBuilder — Unit Tests (Phase 6)
 *
 * Tests that leakage is properly detected and OOS-only records are accepted.
 * Also includes the required "intentional leakage" tests that MUST FAIL
 * when leakage is introduced.
 */

import { describe, expect, it } from "vitest";
import {
  MetaCalibrationDatasetBuilder,
  LeakageDetectedError,
  assertNoLeakage,
  getCalibrationStatus,
  DEFAULT_PURGE_WINDOW_MS,
  DEFAULT_EMBARGO_WINDOW_MS,
  type CalibrationRecord,
  type CalibrationDataset,
} from "@/lib/india/meta-calibration";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1_000;
const TRAIN_END = 1_700_000_000_000; // arbitrary reference point

/** Build a valid OOS calibration record. */
function validRecord(overrides: Partial<CalibrationRecord> = {}): CalibrationRecord {
  const trainEnd = TRAIN_END;
  const validationStart = trainEnd + DEFAULT_PURGE_WINDOW_MS + DAY_MS;
  const timestamp = validationStart + DEFAULT_EMBARGO_WINDOW_MS + DAY_MS;
  return {
    timestamp,
    instrument: "NIFTY",
    baseModelPredictions: { regime_classifier: 0.72, stock_ranker: 0.65 },
    baseModelConfidence: { regime_classifier: 0.8, stock_ranker: 0.7 },
    modelAvailability: { regime_classifier: true, stock_ranker: true },
    regime: "bull",
    dataQuality: "VALID",
    actualOutcome: 1,
    foldId: 1,
    trainEnd,
    validationStart,
    ...overrides,
  };
}

const DUMMY_METRICS = {
  ece: 0.05,
  brier: 0.18,
  sharpeOos: 1.2,
  maxDrawdownOos: 0.08,
  winRate: 0.58,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("MetaCalibrationDatasetBuilder — valid OOS records", () => {
  it("accepts a valid OOS record without throwing", () => {
    const builder = new MetaCalibrationDatasetBuilder();
    expect(() => builder.addRecord(validRecord())).not.toThrow();
    expect(builder.recordCount).toBe(1);
  });

  it("builds a dataset with correct sampleCount = oosSampleCount", () => {
    const builder = new MetaCalibrationDatasetBuilder();
    for (let i = 0; i < 10; i++) {
      builder.addRecord(validRecord({ foldId: i }));
    }
    const dataset = builder.build({
      calibrationVersion: "v1",
      validationMethod: "walk_forward",
      metrics: DUMMY_METRICS,
    });

    expect(dataset.sampleCount).toBe(10);
    expect(dataset.oosSampleCount).toBe(10); // All OOS by construction
  });

  it("throws when trying to build with 0 records", () => {
    const builder = new MetaCalibrationDatasetBuilder();
    expect(() =>
      builder.build({ calibrationVersion: "v1", validationMethod: "walk_forward", metrics: DUMMY_METRICS }),
    ).toThrow();
  });
});

describe("MetaCalibrationDatasetBuilder — leakage detection", () => {
  it("LEAKAGE TEST: throws LeakageDetectedError when timestamp <= trainEnd", () => {
    const builder = new MetaCalibrationDatasetBuilder();
    const leakyRecord = validRecord({
      timestamp: TRAIN_END,          // Same as trainEnd — NOT OOS
    });
    expect(() => builder.addRecord(leakyRecord)).toThrow(LeakageDetectedError);
  });

  it("LEAKAGE TEST: throws when timestamp is BEFORE trainEnd", () => {
    const builder = new MetaCalibrationDatasetBuilder();
    const leakyRecord = validRecord({
      timestamp: TRAIN_END - DAY_MS, // Before trainEnd — definitely leakage
    });
    expect(() => builder.addRecord(leakyRecord)).toThrow(LeakageDetectedError);
  });

  it("LEAKAGE TEST: throws when validationStart < trainEnd + purgeWindow", () => {
    const builder = new MetaCalibrationDatasetBuilder();
    const leakyRecord = validRecord({
      validationStart: TRAIN_END + DAY_MS, // Only 1 day after trainEnd, not 5
      timestamp: TRAIN_END + 10 * DAY_MS,
    });
    expect(() => builder.addRecord(leakyRecord)).toThrow(LeakageDetectedError);
  });

  it("LEAKAGE TEST: throws when timestamp < validationStart + embargoWindow", () => {
    const builder = new MetaCalibrationDatasetBuilder();
    const validationStart = TRAIN_END + DEFAULT_PURGE_WINDOW_MS + DAY_MS;
    const leakyRecord = validRecord({
      validationStart,
      // Timestamp is in the embargo period
      timestamp: validationStart + (DEFAULT_EMBARGO_WINDOW_MS / 2),
    });
    expect(() => builder.addRecord(leakyRecord)).toThrow(LeakageDetectedError);
  });

  it("LeakageDetectedError carries correct diagnostic fields", () => {
    const builder = new MetaCalibrationDatasetBuilder();
    const leakyRecord = validRecord({ timestamp: TRAIN_END - 1 });

    let caught: LeakageDetectedError | null = null;
    try {
      builder.addRecord(leakyRecord);
    } catch (e) {
      if (e instanceof LeakageDetectedError) caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught!.recordIndex).toBe(0);
    expect(caught!.timestamp).toBe(TRAIN_END - 1);
    expect(caught!.trainEnd).toBe(TRAIN_END);
  });
});

describe("assertNoLeakage — dataset-level verification", () => {
  it("passes for a clean OOS dataset", () => {
    const records = Array.from({ length: 5 }, (_, i) => validRecord({ foldId: i }));
    const dataset: CalibrationDataset = {
      calibrationVersion: "v1",
      trainingWindow: { from: "2024-01-01", to: "2024-06-01" },
      validationMethod: "walk_forward",
      sampleCount: 5,
      oosSampleCount: 5,
      metrics: DUMMY_METRICS,
      records,
    };
    expect(() => assertNoLeakage(dataset)).not.toThrow();
  });

  it("detects leakage in a manually crafted bad dataset", () => {
    const leakyRecord = validRecord({ timestamp: TRAIN_END }); // leaky
    const dataset: CalibrationDataset = {
      calibrationVersion: "v1",
      trainingWindow: { from: "2024-01-01", to: "2024-06-01" },
      validationMethod: "walk_forward",
      sampleCount: 1,
      oosSampleCount: 1,
      metrics: DUMMY_METRICS,
      records: [leakyRecord],
    };
    expect(() => assertNoLeakage(dataset)).toThrow(LeakageDetectedError);
  });
});

describe("getCalibrationStatus", () => {
  it("returns UNAVAILABLE when dataset is null", () => {
    expect(getCalibrationStatus(null)).toBe("UNAVAILABLE");
  });

  it("returns CALIBRATED for a fresh dataset (< 7 days old)", () => {
    const now = Date.now();
    const record = validRecord({ timestamp: now - DAY_MS }); // 1 day old
    const dataset: CalibrationDataset = {
      calibrationVersion: "v1",
      trainingWindow: { from: "2024-01-01", to: "2024-06-01" },
      validationMethod: "walk_forward",
      sampleCount: 1,
      oosSampleCount: 1,
      metrics: DUMMY_METRICS,
      records: [record],
    };
    expect(getCalibrationStatus(dataset, now)).toBe("CALIBRATED");
  });

  it("returns STALE for an old dataset (> 7 days old)", () => {
    const now = Date.now();
    const record = validRecord({ timestamp: now - 10 * DAY_MS }); // 10 days old
    const dataset: CalibrationDataset = {
      calibrationVersion: "v1",
      trainingWindow: { from: "2024-01-01", to: "2024-06-01" },
      validationMethod: "walk_forward",
      sampleCount: 1,
      oosSampleCount: 1,
      metrics: DUMMY_METRICS,
      records: [record],
    };
    expect(getCalibrationStatus(dataset, now)).toBe("STALE");
  });
});
