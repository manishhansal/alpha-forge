/**
 * FeatureQualityValidator — Phase 4
 *
 * Replaces the unsafe generic NaN→0 / Infinity→999 sanitization with
 * model-specific feature policies. Every production ML model must have a
 * registered FeatureContract that specifies per-feature handling.
 *
 * DESIGN PRINCIPLES:
 *  - The policy used during LIVE inference must match the TRAINING pipeline.
 *  - INVALID data does NOT call the ML model unless the training policy
 *    explicitly supports imputation.
 *  - Every ML prediction must report dataQuality, invalidFeatureCount,
 *    imputedFeatureCount, and featureVersion.
 *  - No more silent NaN→0 unless ZERO_ONLY_IF_TRAINED_AS_ZERO.
 */

// ─── Data Quality Status ─────────────────────────────────────────────────────

export type DataQualityStatus =
  | "VALID"     // All features pass validation; no imputation required
  | "DEGRADED"  // Some features imputed; model can proceed with reduced confidence
  | "INVALID"   // Too many invalid features; model should NOT be called
  | "STALE";    // Data is too old for reliable inference

// ─── Feature Policies ────────────────────────────────────────────────────────

/**
 * How to handle a missing/invalid feature value at inference time.
 *
 * REJECT                  - Any NaN/Infinity for this feature invalidates the row.
 * TRAINING_MEDIAN         - Replace with the median computed during training.
 * FORWARD_FILL            - Use the last valid value in the time series.
 * ZERO_ONLY_IF_TRAINED    - Replace with 0.0 ONLY when the training set included 0.
 * MODEL_DEFAULT           - Use the model's internal default (e.g. XGBoost missing=NaN).
 */
export type ImputationPolicy =
  | "REJECT"
  | "TRAINING_MEDIAN"
  | "FORWARD_FILL"
  | "ZERO_ONLY_IF_TRAINED"
  | "MODEL_DEFAULT";

export type MissingPolicy = "REJECT" | "IMPUTE";

export interface FeatureSpec {
  featureName: string;
  dtype: "float32" | "float64" | "int32" | "bool";
  nullable: boolean;
  missingPolicy: MissingPolicy;
  imputationPolicy: ImputationPolicy;
  /** [min, max] inclusive range for valid values. Null = no bound check. */
  validRange: [number | null, number | null];
  /** Value to impute when imputationPolicy is TRAINING_MEDIAN. */
  trainingMedian?: number;
  /** Value to impute when imputationPolicy is ZERO_ONLY_IF_TRAINED. */
  zeroDefault?: 0;
}

// ─── Feature Contract ────────────────────────────────────────────────────────

export interface FeatureContract {
  modelName: string;
  modelVersion: string;
  featureVersion: string;
  /** Ordered list of features as they must appear in the input vector. */
  orderedFeatures: FeatureSpec[];
}

// ─── Validation Result ───────────────────────────────────────────────────────

export interface FeatureValidationResult {
  dataQuality: DataQualityStatus;
  /** The sanitized feature vector (same order as contract). */
  sanitized: Record<string, number>;
  invalidFeatureCount: number;
  imputedFeatureCount: number;
  featureVersion: string;
  /** Names of features that were invalid (NaN, out-of-range, etc.). */
  invalidFeatures: string[];
  /** Names of features that were imputed. */
  imputedFeatures: string[];
  /** Human-readable reason when status is INVALID. */
  reason: string | null;
}

// ─── Built-in Model Contracts ────────────────────────────────────────────────

/**
 * Feature contract for the market regime classifier.
 * Feature order must match the Python training pipeline exactly.
 */
export const REGIME_CLASSIFIER_CONTRACT: FeatureContract = {
  modelName: "regime_classifier",
  modelVersion: "v1",
  featureVersion: "regime_v1",
  orderedFeatures: [
    {
      featureName: "nifty_change_pct",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "ZERO_ONLY_IF_TRAINED",
      validRange: [-15, 15],
      zeroDefault: 0,
    },
    {
      featureName: "banknifty_change_pct",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "ZERO_ONLY_IF_TRAINED",
      validRange: [-20, 20],
      zeroDefault: 0,
    },
    {
      featureName: "india_vix",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "TRAINING_MEDIAN",
      validRange: [5, 100],
      trainingMedian: 14.5,
    },
    {
      featureName: "nifty_atr_pct",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "TRAINING_MEDIAN",
      validRange: [0, 10],
      trainingMedian: 0.8,
    },
    {
      featureName: "nifty_adx",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "TRAINING_MEDIAN",
      validRange: [0, 100],
      trainingMedian: 22,
    },
    {
      featureName: "advance_decline_ratio",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "ZERO_ONLY_IF_TRAINED",
      validRange: [-1, 1],
      zeroDefault: 0,
    },
    {
      featureName: "market_breadth",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "TRAINING_MEDIAN",
      validRange: [0, 100],
      trainingMedian: 50,
    },
    {
      featureName: "sector_strength",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "ZERO_ONLY_IF_TRAINED",
      validRange: [-5, 5],
      zeroDefault: 0,
    },
    {
      featureName: "volume_ratio",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "TRAINING_MEDIAN",
      validRange: [0, 20],
      trainingMedian: 1.0,
    },
    {
      featureName: "gap_pct",
      dtype: "float32",
      nullable: false,
      missingPolicy: "IMPUTE",
      imputationPolicy: "ZERO_ONLY_IF_TRAINED",
      validRange: [-10, 10],
      zeroDefault: 0,
    },
  ],
};

/**
 * Feature contract for the stock ranker model.
 */
export const STOCK_RANKER_CONTRACT: FeatureContract = {
  modelName: "stock_ranker",
  modelVersion: "v1",
  featureVersion: "ranker_v1",
  orderedFeatures: [
    { featureName: "relative_volume", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "TRAINING_MEDIAN", validRange: [0, 50], trainingMedian: 1.0 },
    { featureName: "atr_expansion", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "TRAINING_MEDIAN", validRange: [0, 10], trainingMedian: 1.0 },
    { featureName: "momentum_5d", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [-50, 50], zeroDefault: 0 },
    { featureName: "momentum_10d", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [-50, 50], zeroDefault: 0 },
    { featureName: "vwap_distance_pct", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [-20, 20], zeroDefault: 0 },
    { featureName: "ema_stack_score", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [-1, 1], zeroDefault: 0 },
    { featureName: "rsi_14", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "TRAINING_MEDIAN", validRange: [0, 100], trainingMedian: 50 },
    { featureName: "macd_histogram", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [-100, 100], zeroDefault: 0 },
    { featureName: "adx_14", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "TRAINING_MEDIAN", validRange: [0, 100], trainingMedian: 22 },
    { featureName: "sector_momentum", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [-5, 5], zeroDefault: 0 },
    { featureName: "relative_strength_vs_nifty", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "TRAINING_MEDIAN", validRange: [-10, 10], trainingMedian: 0 },
    { featureName: "market_breadth", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "TRAINING_MEDIAN", validRange: [0, 100], trainingMedian: 50 },
    { featureName: "gap_pct", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [-10, 10], zeroDefault: 0 },
  ],
};

// ─── Validator ───────────────────────────────────────────────────────────────

/**
 * Validate and sanitize a feature vector against a model's FeatureContract.
 *
 * Returns a FeatureValidationResult that includes the sanitized vector,
 * quality status, and a count of invalid/imputed features.
 *
 * The caller must check `dataQuality` before calling the ML model:
 *   - VALID    → call the model
 *   - DEGRADED → call the model with reduced confidence weight
 *   - INVALID  → do NOT call the model; use fallback
 *   - STALE    → do NOT call the model; use fallback
 */
export function validateFeatureVector(
  raw: Record<string, unknown>,
  contract: FeatureContract,
): FeatureValidationResult {
  const sanitized: Record<string, number> = {};
  const invalidFeatures: string[] = [];
  const imputedFeatures: string[] = [];

  for (const spec of contract.orderedFeatures) {
    const rawValue = raw[spec.featureName];
    const numValue = typeof rawValue === "number" ? rawValue : NaN;

    const isInvalid =
      !Number.isFinite(numValue) ||
      (spec.validRange[0] !== null && numValue < spec.validRange[0]) ||
      (spec.validRange[1] !== null && numValue > spec.validRange[1]);

    if (!isInvalid) {
      // Feature is valid — use as-is
      sanitized[spec.featureName] = numValue;
      continue;
    }

    // Feature is invalid
    invalidFeatures.push(spec.featureName);

    if (spec.missingPolicy === "REJECT") {
      // Mark as invalid — will cause INVALID status
      sanitized[spec.featureName] = NaN;
      continue;
    }

    // IMPUTE: apply the imputation policy
    imputedFeatures.push(spec.featureName);
    switch (spec.imputationPolicy) {
      case "TRAINING_MEDIAN":
        sanitized[spec.featureName] = spec.trainingMedian ?? 0;
        break;
      case "ZERO_ONLY_IF_TRAINED":
        sanitized[spec.featureName] = 0;
        break;
      case "MODEL_DEFAULT":
        // Leave as NaN for model-internal handling (e.g. XGBoost missing=NaN)
        sanitized[spec.featureName] = NaN;
        break;
      case "FORWARD_FILL":
        // Forward-fill requires time-series context — use training median as fallback
        sanitized[spec.featureName] = spec.trainingMedian ?? 0;
        break;
      case "REJECT":
        sanitized[spec.featureName] = NaN;
        break;
    }
  }

  // Check for any features in the raw input not in the contract
  const contractFeatureNames = new Set(contract.orderedFeatures.map((f) => f.featureName));
  const unexpectedFeatures = Object.keys(raw).filter((k) => !contractFeatureNames.has(k));
  if (unexpectedFeatures.length > 0) {
    console.warn(
      `[feature-quality] unexpected features (not in contract ${contract.featureVersion}): ` +
        unexpectedFeatures.join(", "),
    );
  }

  // Check for missing features (in contract but not in raw input)
  const missingFeatures = contract.orderedFeatures
    .filter((spec) => !(spec.featureName in raw))
    .map((spec) => spec.featureName);
  if (missingFeatures.length > 0) {
    console.warn(
      `[feature-quality] missing features (in contract but not in input): ` +
        missingFeatures.join(", "),
    );
    // Add to invalid features
    invalidFeatures.push(...missingFeatures);
    // Impute based on policy
    for (const name of missingFeatures) {
      const spec = contract.orderedFeatures.find((f) => f.featureName === name)!;
      if (spec.missingPolicy === "REJECT") {
        sanitized[name] = NaN;
      } else {
        imputedFeatures.push(name);
        sanitized[name] = spec.trainingMedian ?? spec.zeroDefault ?? 0;
      }
    }
  }

  // Determine data quality status
  const rejectedCount = invalidFeatures.filter(
    (name) => !imputedFeatures.includes(name),
  ).length;
  const totalFeatures = contract.orderedFeatures.length;

  let dataQuality: DataQualityStatus;
  let reason: string | null = null;

  if (rejectedCount > 0) {
    dataQuality = "INVALID";
    reason = `${rejectedCount} feature(s) have REJECT policy and are invalid: ${
      invalidFeatures.filter((n) => !imputedFeatures.includes(n)).join(", ")
    }`;
  } else if (imputedFeatures.length > totalFeatures * 0.3) {
    // More than 30% of features imputed → INVALID (too uncertain)
    dataQuality = "INVALID";
    reason = `${imputedFeatures.length}/${totalFeatures} features imputed (> 30% threshold)`;
  } else if (imputedFeatures.length > 0) {
    dataQuality = "DEGRADED";
  } else {
    dataQuality = "VALID";
  }

  return {
    dataQuality,
    sanitized,
    invalidFeatureCount: invalidFeatures.length,
    imputedFeatureCount: imputedFeatures.length,
    featureVersion: contract.featureVersion,
    invalidFeatures,
    imputedFeatures,
    reason,
  };
}

/**
 * Annotate a ML prediction result with data quality metadata.
 * Call this on every ML response before returning it to consumers.
 */
export interface AnnotatedPrediction<T> {
  prediction: T | null;
  dataQuality: DataQualityStatus;
  invalidFeatureCount: number;
  imputedFeatureCount: number;
  featureVersion: string;
}

export function annotatePrediction<T>(
  prediction: T | null,
  validationResult: FeatureValidationResult,
): AnnotatedPrediction<T> {
  return {
    prediction,
    dataQuality: validationResult.dataQuality,
    invalidFeatureCount: validationResult.invalidFeatureCount,
    imputedFeatureCount: validationResult.imputedFeatureCount,
    featureVersion: validationResult.featureVersion,
  };
}
