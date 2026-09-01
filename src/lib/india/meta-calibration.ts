/**
 * MetaCalibrationDatasetBuilder — Phase 6
 *
 * Ensures the meta decision layer is NEVER trained using in-sample
 * base-model predictions. Every record in the calibration dataset must
 * contain ONLY out-of-sample (OOS) predictions — i.e., predictions made
 * by a model version that was NOT trained on the data point's timestamp.
 *
 * Required architecture:
 *   Historical Dataset
 *   ↓
 *   Walk-Forward / Purged CV
 *   ↓
 *   Train Base Models (per fold)
 *   ↓
 *   Generate OOS Predictions (on held-out fold only)
 *   ↓
 *   Collect ONLY OOS Predictions
 *   ↓
 *   MetaCalibrationDatasetBuilder
 *   ↓
 *   fit_meta_layer()
 *   ↓
 *   Persist Calibration
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type CalibrationRecord = {
  /** UTC epoch ms. The timestamp of the data point. */
  timestamp: number;
  /** NSE instrument symbol. */
  instrument: string;
  /** Map of model_name → predicted probability. */
  baseModelPredictions: Record<string, number>;
  /** Map of model_name → confidence score [0, 1]. */
  baseModelConfidence: Record<string, number>;
  /** Which models were available at this timestamp (may differ over time). */
  modelAvailability: Record<string, boolean>;
  /** Market regime at this timestamp. */
  regime: string;
  /** Data quality status at inference time. */
  dataQuality: "VALID" | "DEGRADED" | "INVALID" | "STALE";
  /** Actual outcome (1=positive, 0=negative, null=not yet resolved). */
  actualOutcome: 1 | 0 | null;
  /**
   * The walk-forward fold this record belongs to.
   * Used to verify no future leakage.
   */
  foldId: number;
  /**
   * The end of the training window that produced the base model used here.
   * The data point's timestamp MUST be strictly after trainEnd.
   */
  trainEnd: number; // UTC epoch ms
  /**
   * Start of the validation window (with purge buffer).
   * Must be strictly after trainEnd + purgeWindowMs.
   */
  validationStart: number; // UTC epoch ms
};

export type CalibrationDataset = {
  calibrationVersion: string;
  /** ISO-8601 range of the dataset. */
  trainingWindow: { from: string; to: string };
  validationMethod: "walk_forward" | "purged_kfold" | "embargo";
  sampleCount: number;
  /** OOS sample count (must equal sampleCount — no IS leakage). */
  oosSampleCount: number;
  /** Metrics from the calibrated meta layer. */
  metrics: {
    ece: number;           // Expected Calibration Error
    brier: number;         // Brier Score
    sharpeOos: number;     // OOS Sharpe
    maxDrawdownOos: number; // OOS Max Drawdown
    winRate: number;
  };
  records: CalibrationRecord[];
};

export type CalibrationStatus =
  | "CALIBRATED"    // Calibration is fresh and valid
  | "STALE"         // Calibration is outdated (> maxAgeMs)
  | "UNAVAILABLE";  // No calibration exists

// ─── Leakage Detection ───────────────────────────────────────────────────────

export class LeakageDetectedError extends Error {
  constructor(
    message: string,
    public readonly recordIndex: number,
    public readonly timestamp: number,
    public readonly trainEnd: number,
  ) {
    super(message);
    this.name = "LeakageDetectedError";
  }
}

/**
 * Minimum time gap between trainEnd and validationStart.
 * This "purge window" prevents look-ahead bias from label formation.
 * For daily bars: at least 5 trading days.
 */
export const DEFAULT_PURGE_WINDOW_MS = 5 * 24 * 60 * 60 * 1_000; // 5 days

/**
 * Embargo window: additional buffer after the purge window to prevent
 * auto-correlation from leaking through the validation period boundaries.
 * For daily bars: at least 2 trading days.
 */
export const DEFAULT_EMBARGO_WINDOW_MS = 2 * 24 * 60 * 60 * 1_000; // 2 days

// ─── Builder ────────────────────────────────────────────────────────────────

export class MetaCalibrationDatasetBuilder {
  private readonly records: CalibrationRecord[] = [];
  private readonly purgeWindowMs: number;
  private readonly embargoWindowMs: number;

  constructor(opts: {
    purgeWindowMs?: number;
    embargoWindowMs?: number;
  } = {}) {
    this.purgeWindowMs = opts.purgeWindowMs ?? DEFAULT_PURGE_WINDOW_MS;
    this.embargoWindowMs = opts.embargoWindowMs ?? DEFAULT_EMBARGO_WINDOW_MS;
  }

  /**
   * Add a calibration record.
   *
   * Validates:
   *   1. timestamp > trainEnd (data point must be AFTER training cutoff)
   *   2. validationStart >= trainEnd + purgeWindowMs
   *   3. timestamp >= validationStart + embargoWindowMs
   *
   * Throws LeakageDetectedError if any constraint is violated.
   */
  addRecord(record: CalibrationRecord): void {
    const idx = this.records.length;

    // Assertion 1: data point must be strictly after training window end
    if (record.timestamp <= record.trainEnd) {
      throw new LeakageDetectedError(
        `LEAKAGE DETECTED: Record at index ${idx} has timestamp (${record.timestamp}) ` +
          `≤ trainEnd (${record.trainEnd}). ` +
          `Data point must be AFTER the model's training cutoff.`,
        idx,
        record.timestamp,
        record.trainEnd,
      );
    }

    // Assertion 2: validation window starts after purge buffer
    const minValidationStart = record.trainEnd + this.purgeWindowMs;
    if (record.validationStart < minValidationStart) {
      throw new LeakageDetectedError(
        `LEAKAGE DETECTED: Record at index ${idx} has validationStart (${record.validationStart}) ` +
          `before trainEnd + purgeWindow (${minValidationStart}). ` +
          `Purge window: ${this.purgeWindowMs / (24 * 60 * 60 * 1_000)}d`,
        idx,
        record.timestamp,
        record.trainEnd,
      );
    }

    // Assertion 3: timestamp must be at or after validationStart + embargoWindow
    const minTimestamp = record.validationStart + this.embargoWindowMs;
    if (record.timestamp < minTimestamp) {
      throw new LeakageDetectedError(
        `LEAKAGE DETECTED: Record at index ${idx} has timestamp (${record.timestamp}) ` +
          `before validationStart + embargoWindow (${minTimestamp}). ` +
          `Embargo window: ${this.embargoWindowMs / (24 * 60 * 60 * 1_000)}d`,
        idx,
        record.timestamp,
        record.trainEnd,
      );
    }

    this.records.push(record);
  }

  /**
   * Build the calibration dataset. Returns the dataset with all OOS records.
   * All records are verified to be OOS before being included.
   */
  build(opts: {
    calibrationVersion: string;
    validationMethod: CalibrationDataset["validationMethod"];
    metrics: CalibrationDataset["metrics"];
  }): CalibrationDataset {
    if (this.records.length === 0) {
      throw new Error("Cannot build calibration dataset with 0 records");
    }

    const timestamps = this.records.map((r) => r.timestamp);
    const from = new Date(Math.min(...timestamps)).toISOString();
    const to = new Date(Math.max(...timestamps)).toISOString();

    return {
      calibrationVersion: opts.calibrationVersion,
      trainingWindow: { from, to },
      validationMethod: opts.validationMethod,
      sampleCount: this.records.length,
      oosSampleCount: this.records.length, // All records are OOS by construction
      metrics: opts.metrics,
      records: [...this.records],
    };
  }

  get recordCount(): number {
    return this.records.length;
  }
}

// ─── Calibration Status ──────────────────────────────────────────────────────

/** Maximum age for a calibration to be considered fresh. */
const MAX_CALIBRATION_AGE_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

/**
 * Determine the calibration status of a dataset.
 */
export function getCalibrationStatus(
  dataset: CalibrationDataset | null,
  nowMs: number = Date.now(),
): CalibrationStatus {
  if (!dataset) return "UNAVAILABLE";

  const newestTimestamp = Math.max(...dataset.records.map((r) => r.timestamp));
  const ageMs = nowMs - newestTimestamp;

  if (ageMs > MAX_CALIBRATION_AGE_MS) return "STALE";
  return "CALIBRATED";
}

/**
 * Verify that a calibration dataset has no leakage.
 * Throws LeakageDetectedError if leakage is found.
 * Used in tests to intentionally detect leakage in bad datasets.
 */
export function assertNoLeakage(
  dataset: CalibrationDataset,
  purgeWindowMs: number = DEFAULT_PURGE_WINDOW_MS,
  embargoWindowMs: number = DEFAULT_EMBARGO_WINDOW_MS,
): void {
  for (let i = 0; i < dataset.records.length; i++) {
    const r = dataset.records[i]!;

    if (r.timestamp <= r.trainEnd) {
      throw new LeakageDetectedError(
        `LEAKAGE in record ${i}: timestamp ≤ trainEnd`,
        i,
        r.timestamp,
        r.trainEnd,
      );
    }

    const minValidationStart = r.trainEnd + purgeWindowMs;
    if (r.validationStart < minValidationStart) {
      throw new LeakageDetectedError(
        `LEAKAGE in record ${i}: validationStart before trainEnd + purgeWindow`,
        i,
        r.timestamp,
        r.trainEnd,
      );
    }

    const minTimestamp = r.validationStart + embargoWindowMs;
    if (r.timestamp < minTimestamp) {
      throw new LeakageDetectedError(
        `LEAKAGE in record ${i}: timestamp before validationStart + embargo`,
        i,
        r.timestamp,
        r.trainEnd,
      );
    }
  }
}
