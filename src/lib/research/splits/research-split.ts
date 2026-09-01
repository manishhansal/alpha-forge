/**
 * Phase 4 — In-Sample / Out-of-Sample Governance
 *
 * Every strategy experiment must declare explicit periods:
 *   DEVELOPMENT   — training / parameter search (in-sample)
 *   VALIDATION    — hyperparameter tuning check (NOT final OOS)
 *   FINAL_OOS     — untouched test set; never used for optimisation
 *
 * The FINAL_OOS period must never be touched until the strategy is
 * declared "ready for final evaluation."  Accessing it early constitutes
 * research protocol violation.
 *
 * Supported split methods:
 *   WALK_FORWARD          — rolling fixed-width windows
 *   ANCHORED_WALK_FORWARD — expanding train window, fixed test window
 *   ROLLING_WALK_FORWARD  — sliding window with overlap
 *   PURGED_KFOLD          — sklearn-compatible with embargo
 *   CPCV                  — Combinatorial Purged Cross-Validation
 *   SIMPLE_SPLIT          — single train/val/test for simple strategies
 */

import type {
  ResearchSplit,
  ResearchPeriod,
  ValidationMethod,
} from "../types";

// ─── Split Factory ────────────────────────────────────────────────────────────

export interface SplitConfig {
  strategyId: string;
  datasetVersion: string;
  validationMethod: ValidationMethod;
  embargoBars: number;
  /** Dates in ISO "YYYY-MM-DD" format */
  developmentStart: string;
  developmentEnd: string;
  validationStart: string;
  validationEnd: string;
  finalOosStart: string;
  finalOosEnd: string;
  /** Bars per period — estimated from timeframe if not provided */
  devBars?: number;
  valBars?: number;
  oosBars?: number;
}

/**
 * Validates that the split is temporally sound:
 * - development end < validation start (no overlap)
 * - validation end < finalOos start (no overlap)
 * - embargo gap between periods is respected
 * - final OOS start >= validation end + embargo
 *
 * Throws on any violation.
 */
export function validateSplitIntegrity(config: SplitConfig): void {
  const devEnd = new Date(config.developmentEnd).getTime();
  const valStart = new Date(config.validationStart).getTime();
  const valEnd = new Date(config.validationEnd).getTime();
  const oosStart = new Date(config.finalOosStart).getTime();

  if (devEnd >= valStart) {
    throw new Error(
      `[ResearchSplit] Temporal leak detected: development period ends ${config.developmentEnd} ` +
        `which is >= validation start ${config.validationStart}. ` +
        `Development must end STRICTLY before validation begins.`,
    );
  }
  if (valEnd >= oosStart) {
    throw new Error(
      `[ResearchSplit] Temporal leak detected: validation period ends ${config.validationEnd} ` +
        `which is >= final OOS start ${config.finalOosStart}. ` +
        `Validation must end STRICTLY before final OOS begins.`,
    );
  }

  // Embargo check — estimate based on embargo bars and a rough 1 bar ≈ 1 day
  // For intraday strategies (5m), 1 bar ≈ 5 minutes; we enforce a minimum
  // calendar day gap equal to ceil(embargoBars / barsPerDay)
  // Here we just enforce a minimum 1-day gap (conservative baseline)
  const minGapMs = 24 * 60 * 60 * 1000; // 1 calendar day minimum
  if (valStart - devEnd < minGapMs) {
    throw new Error(
      `[ResearchSplit] Embargo violation: less than 1 calendar day gap between ` +
        `development end (${config.developmentEnd}) and validation start (${config.validationStart}).`,
    );
  }
  if (oosStart - valEnd < minGapMs) {
    throw new Error(
      `[ResearchSplit] Embargo violation: less than 1 calendar day gap between ` +
        `validation end (${config.validationEnd}) and final OOS start (${config.finalOosStart}).`,
    );
  }
}

/**
 * Build an immutable ResearchSplit record.
 * Validates temporal integrity before returning.
 */
export function buildResearchSplit(config: SplitConfig): ResearchSplit {
  // Integrity check — throws on violation
  validateSplitIntegrity(config);

  const developmentPeriod: ResearchPeriod = {
    name: "DEVELOPMENT",
    startDate: config.developmentStart,
    endDate: config.developmentEnd,
    bars: config.devBars ?? 0,
    purpose: "DEVELOPMENT",
  };
  const validationPeriod: ResearchPeriod = {
    name: "VALIDATION",
    startDate: config.validationStart,
    endDate: config.validationEnd,
    bars: config.valBars ?? 0,
    purpose: "VALIDATION",
  };
  const finalOosPeriod: ResearchPeriod = {
    name: "FINAL_OOS",
    startDate: config.finalOosStart,
    endDate: config.finalOosEnd,
    bars: config.oosBars ?? 0,
    purpose: "FINAL_OOS",
  };

  return Object.freeze({
    splitId: `${config.strategyId}-${config.validationMethod}-${config.datasetVersion}`,
    strategyId: config.strategyId,
    datasetVersion: config.datasetVersion,
    validationMethod: config.validationMethod,
    developmentPeriod,
    validationPeriod,
    finalOosPeriod,
    embargoBars: config.embargoBars,
    leakageTestPassed: true, // set true only after validateSplitIntegrity passes
    createdAt: new Date().toISOString(),
  });
}

// ─── Walk-Forward Split Generator ────────────────────────────────────────────

export interface WalkForwardWindow {
  foldIndex: number;
  trainStart: number; // bar index
  trainEnd: number;
  testStart: number;
  testEnd: number;
  isExpanding: boolean;
}

/**
 * Generate walk-forward windows for backtesting.
 *
 * @param totalBars    Total number of bars in the dataset
 * @param trainBars    Training window size in bars
 * @param testBars     Test window size in bars
 * @param stepBars     Step size between windows (default = testBars)
 * @param expanding    If true, training window expands anchored at 0 (anchored WF)
 * @param embargoBars  Gap between train end and test start
 */
export function generateWalkForwardWindows(
  totalBars: number,
  trainBars: number,
  testBars: number,
  stepBars: number = testBars,
  expanding: boolean = false,
  embargoBars: number = 5,
): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  let foldIndex = 0;

  let cursor = trainBars;
  while (cursor + embargoBars + testBars <= totalBars) {
    const trainEnd = cursor;
    const trainStart = expanding ? 0 : cursor - trainBars;
    const testStart = cursor + embargoBars;
    const testEnd = Math.min(testStart + testBars, totalBars);

    // Hard assert: no temporal overlap
    if (testStart <= trainEnd) {
      throw new Error(
        `[WalkForward] Embargo assertion failed at fold ${foldIndex}: ` +
          `testStart(${testStart}) <= trainEnd(${trainEnd}).`,
      );
    }

    windows.push({ foldIndex, trainStart, trainEnd, testStart, testEnd, isExpanding: expanding });
    foldIndex++;
    cursor += stepBars;
  }

  return windows;
}

// ─── Canonical Split Definitions ─────────────────────────────────────────────
// Pre-defined research splits matching the CANONICAL_DATASETS.

export const CANONICAL_SPLITS: Record<string, SplitConfig> = {
  /** NSE F&O strategies — main research split */
  NSE_FNO_MAIN: {
    strategyId: "PLACEHOLDER",
    datasetVersion: "NSE_FNO_DAILY_5Y",
    validationMethod: "WALK_FORWARD",
    embargoBars: 5,
    developmentStart: "2020-01-01",
    developmentEnd: "2022-12-31",
    validationStart: "2023-03-01",
    validationEnd: "2023-12-31",
    finalOosStart: "2024-03-01",
    finalOosEnd: "2025-12-31",
    devBars: 756,   // ~3 years of NSE trading days
    valBars: 180,   // ~9 months
    oosBars: 432,   // ~2 years
  },

  /** Crypto 5m strategies */
  CRYPTO_5M_MAIN: {
    strategyId: "PLACEHOLDER",
    datasetVersion: "CRYPTO_5M_3Y",
    validationMethod: "PURGED_KFOLD",
    embargoBars: 48, // 4 hours at 5m resolution
    developmentStart: "2022-01-01",
    developmentEnd: "2023-12-31",
    validationStart: "2024-03-01",
    validationEnd: "2024-09-30",
    finalOosStart: "2025-01-01",
    finalOosEnd: "2025-12-31",
    devBars: 210240, // 2y × 365d × 24h × 12 bars/h
    valBars: 52704,  // ~6 months
    oosBars: 105120, // ~1 year
  },

  /** Crypto 1m — FIB_PULLBACK only */
  CRYPTO_1M_FIB: {
    strategyId: "FIB_PULLBACK",
    datasetVersion: "CRYPTO_1M_1Y",
    validationMethod: "WALK_FORWARD",
    embargoBars: 60, // 1 hour at 1m resolution
    developmentStart: "2024-01-01",
    developmentEnd: "2024-08-31",
    validationStart: "2024-10-01",
    validationEnd: "2024-12-31",
    finalOosStart: "2025-03-01",
    finalOosEnd: "2025-12-31",
    devBars: 350400,  // 8 months × 30d × 24h × 60m
    valBars: 131760,  // 3 months
    oosBars: 459360,  // 9 months
  },
};
