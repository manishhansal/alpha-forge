/**
 * Feature Contract Registry — Phase 5
 *
 * Strict registry of every production ML model's feature contract.
 * Used to verify training/inference parity and prevent silent feature drift.
 *
 * For every model this stores:
 *   - modelName / modelVersion / featureVersion
 *   - orderedFeatureList (EXACT order features are fed to the model)
 *   - dtypeMetadata
 *   - imputationPolicy
 *   - lookbackRequirements
 *
 * A deterministic parity test runs the same raw market data through both
 * TRAINING and LIVE feature pipelines and compares:
 *   - feature names
 *   - order
 *   - dtype
 *   - values
 *   - missing handling
 */

import {
  REGIME_CLASSIFIER_CONTRACT,
  STOCK_RANKER_CONTRACT,
  type FeatureContract,
} from "./feature-quality-validator";

// ─── Extended Model Registration ─────────────────────────────────────────────

export interface ModelRegistration {
  modelName: string;
  modelVersion: string;
  featureVersion: string;
  lookbackRequirements: {
    /** Number of historical candles required (0 = no lookback needed). */
    historicalCandles: number;
    /** Timeframe for the historical candles (e.g. "5m", "1d"). */
    candleInterval: string;
  };
  contract: FeatureContract;
  /** Hash of the ordered feature list for quick parity detection. */
  featureListHash: string;
  /** Whether this model is active in production. */
  isProduction: boolean;
}

function computeFeatureListHash(contract: FeatureContract): string {
  // Simple deterministic hash: join feature names in order with their dtypes
  const signature = contract.orderedFeatures
    .map((f) => `${f.featureName}:${f.dtype}`)
    .join("|");
  // Simple djb2-style hash (no crypto needed for this use case)
  let hash = 5381;
  for (let i = 0; i < signature.length; i++) {
    hash = (hash * 33) ^ signature.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ─── Registry ────────────────────────────────────────────────────────────────

class FeatureContractRegistry {
  private readonly models = new Map<string, ModelRegistration>();

  register(reg: Omit<ModelRegistration, "featureListHash">): void {
    const featureListHash = computeFeatureListHash(reg.contract);
    const key = `${reg.modelName}:${reg.modelVersion}`;
    this.models.set(key, { ...reg, featureListHash });
  }

  get(modelName: string, modelVersion: string): ModelRegistration | undefined {
    return this.models.get(`${modelName}:${modelVersion}`);
  }

  getLatest(modelName: string): ModelRegistration | undefined {
    // Return the first registered version (in a real system, order by semver)
    for (const [key, reg] of this.models) {
      if (key.startsWith(`${modelName}:`)) return reg;
    }
    return undefined;
  }

  all(): ModelRegistration[] {
    return [...this.models.values()];
  }

  productionModels(): ModelRegistration[] {
    return this.all().filter((r) => r.isProduction);
  }

  /**
   * Verify that a proposed feature vector matches the registered contract.
   * Returns { matches: true } or { matches: false, discrepancies: string[] }.
   */
  verifyParity(
    modelName: string,
    modelVersion: string,
    proposedFeatures: string[],
  ): { matches: boolean; discrepancies: string[] } {
    const reg = this.get(modelName, modelVersion);
    if (!reg) {
      return {
        matches: false,
        discrepancies: [`Model not registered: ${modelName}:${modelVersion}`],
      };
    }

    const contractFeatures = reg.contract.orderedFeatures.map((f) => f.featureName);
    const discrepancies: string[] = [];

    // Check order
    for (let i = 0; i < Math.max(contractFeatures.length, proposedFeatures.length); i++) {
      const expected = contractFeatures[i];
      const actual = proposedFeatures[i];
      if (expected !== actual) {
        discrepancies.push(
          `Position ${i}: expected "${expected ?? "(missing)"}" but got "${actual ?? "(missing)"}"`,
        );
      }
    }

    // Check for extra features
    for (const f of proposedFeatures) {
      if (!contractFeatures.includes(f)) {
        discrepancies.push(`Extra feature in live pipeline (not in contract): "${f}"`);
      }
    }

    // Check for missing features
    for (const f of contractFeatures) {
      if (!proposedFeatures.includes(f)) {
        discrepancies.push(`Missing feature from live pipeline (required by contract): "${f}"`);
      }
    }

    return { matches: discrepancies.length === 0, discrepancies };
  }
}

// ─── Global registry instance ────────────────────────────────────────────────

export const featureContractRegistry = new FeatureContractRegistry();

// ─── Register production models ──────────────────────────────────────────────

featureContractRegistry.register({
  modelName: "regime_classifier",
  modelVersion: "v1",
  featureVersion: "regime_v1",
  lookbackRequirements: {
    historicalCandles: 0, // Uses current-session features only
    candleInterval: "5m",
  },
  contract: REGIME_CLASSIFIER_CONTRACT,
  isProduction: true,
});

featureContractRegistry.register({
  modelName: "stock_ranker",
  modelVersion: "v1",
  featureVersion: "ranker_v1",
  lookbackRequirements: {
    historicalCandles: 14, // 14-bar ATR lookback
    candleInterval: "1d",
  },
  contract: STOCK_RANKER_CONTRACT,
  isProduction: true,
});

featureContractRegistry.register({
  modelName: "price_forecaster",
  modelVersion: "v1",
  featureVersion: "tft_v1",
  lookbackRequirements: {
    historicalCandles: 60, // Exact 60 5-minute bars required
    candleInterval: "5m",
  },
  contract: {
    modelName: "price_forecaster",
    modelVersion: "v1",
    featureVersion: "tft_v1",
    orderedFeatures: [
      // Bar-level features (per-timestep in the TFT sequence)
      { featureName: "open", dtype: "float32", nullable: false, missingPolicy: "REJECT", imputationPolicy: "REJECT", validRange: [0, null] },
      { featureName: "high", dtype: "float32", nullable: false, missingPolicy: "REJECT", imputationPolicy: "REJECT", validRange: [0, null] },
      { featureName: "low", dtype: "float32", nullable: false, missingPolicy: "REJECT", imputationPolicy: "REJECT", validRange: [0, null] },
      { featureName: "close", dtype: "float32", nullable: false, missingPolicy: "REJECT", imputationPolicy: "REJECT", validRange: [0, null] },
      { featureName: "volume", dtype: "float32", nullable: false, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [0, null], zeroDefault: 0 },
      { featureName: "vpin", dtype: "float32", nullable: true, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [0, 1], zeroDefault: 0 },
      { featureName: "atm_iv", dtype: "float32", nullable: true, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [0, 200], zeroDefault: 0 },
      { featureName: "pcr", dtype: "float32", nullable: true, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [0, 10], zeroDefault: 0 },
      { featureName: "oi_buildup", dtype: "float32", nullable: true, missingPolicy: "IMPUTE", imputationPolicy: "ZERO_ONLY_IF_TRAINED", validRange: [-1, 1], zeroDefault: 0 },
    ],
  },
  isProduction: true,
});
