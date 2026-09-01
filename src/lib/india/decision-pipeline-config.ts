/**
 * Decision Pipeline Configuration — Phase 13
 *
 * Configuration-based feature flags for the production decision pipeline.
 * Allows controlled disabling of components that add complexity or latency
 * without measurable OOS value.
 *
 * Each flag is controlled by an environment variable and defaults to the
 * safe "conservative" setting when unset.
 *
 * Components:
 *   Market Data → Feature Engine → ML Models → Meta Decision → Risk → Signal → Execution
 *
 * Feature flags:
 *   ENABLE_PRICE_FORECASTER       - TFT 1-hour price regime forecast
 *   ENABLE_RL_EXECUTOR            - RL-based execution timing model
 *   ENABLE_MICROSTRUCTURE         - Microstructure engine (VPIN, order flow)
 *   ENABLE_META_CALIBRATION       - Platt/isotonic meta calibration
 *   ENABLE_STOCK_RANKER           - ML stock ranking model
 *   ENABLE_REGIME_CLASSIFIER      - ML market regime classifier
 *   ENABLE_PORTFOLIO_OPTIMIZER    - ML portfolio optimization
 */

export type ComponentFlag =
  | "PRICE_FORECASTER"
  | "RL_EXECUTOR"
  | "MICROSTRUCTURE"
  | "META_CALIBRATION"
  | "STOCK_RANKER"
  | "REGIME_CLASSIFIER"
  | "PORTFOLIO_OPTIMIZER";

export interface DecisionPipelineConfig {
  /** Whether the TFT price forecaster is enabled. Default: false (NOT_EVALUATED). */
  enablePriceForecaster: boolean;
  /** Whether the RL execution model is enabled. Default: false (NOT_EVALUATED). */
  enableRlExecutor: boolean;
  /** Whether the microstructure engine is enabled. Default: false (NOT_EVALUATED). */
  enableMicrostructure: boolean;
  /** Whether Platt/isotonic meta calibration is applied. Default: true. */
  enableMetaCalibration: boolean;
  /** Whether the ML stock ranker is enabled. Default: true (MARGINAL_VALUE). */
  enableStockRanker: boolean;
  /** Whether the ML regime classifier is enabled. Default: true (POSITIVE_VALUE). */
  enableRegimeClassifier: boolean;
  /** Whether the portfolio optimizer is enabled. Default: false (NOT_EVALUATED). */
  enablePortfolioOptimizer: boolean;
}

/**
 * Read the decision pipeline configuration from environment variables.
 *
 * Environment variable naming: ENABLE_{FLAG_NAME}
 * Values: "true" | "false" | "1" | "0" (case-insensitive)
 * When unset, the safe conservative default is used.
 */
export function readDecisionPipelineConfig(): DecisionPipelineConfig {
  function flagValue(envKey: string, defaultValue: boolean): boolean {
    const raw = process.env[envKey];
    if (raw === undefined || raw === "") return defaultValue;
    const v = raw.toLowerCase().trim();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    console.warn(`[decision-pipeline] Unrecognized value for ${envKey}: "${raw}" — using default ${defaultValue}`);
    return defaultValue;
  }

  return {
    // Price forecaster: disabled by default (EXPERIMENTAL stage)
    enablePriceForecaster: flagValue("ENABLE_PRICE_FORECASTER", false),
    // RL executor: disabled by default (NOT_EVALUATED)
    enableRlExecutor: flagValue("ENABLE_RL_EXECUTOR", false),
    // Microstructure: disabled by default (NOT_EVALUATED)
    enableMicrostructure: flagValue("ENABLE_MICROSTRUCTURE", false),
    // Meta calibration: enabled by default (adds predictive value)
    enableMetaCalibration: flagValue("ENABLE_META_CALIBRATION", true),
    // Stock ranker: enabled at 50% weight (MARGINAL_VALUE)
    enableStockRanker: flagValue("ENABLE_STOCK_RANKER", true),
    // Regime classifier: enabled at full weight (POSITIVE_VALUE)
    enableRegimeClassifier: flagValue("ENABLE_REGIME_CLASSIFIER", true),
    // Portfolio optimizer: disabled by default (NOT_EVALUATED)
    enablePortfolioOptimizer: flagValue("ENABLE_PORTFOLIO_OPTIMIZER", false),
  };
}

/** Singleton config instance (read once per process). */
let _config: DecisionPipelineConfig | null = null;

export function getDecisionPipelineConfig(): DecisionPipelineConfig {
  if (!_config) {
    _config = readDecisionPipelineConfig();
  }
  return _config;
}

/** Invalidate cached config (for testing). */
export function invalidateDecisionPipelineConfig(): void {
  _config = null;
}

/**
 * Check if a specific component is enabled.
 */
export function isComponentEnabled(component: ComponentFlag): boolean {
  const config = getDecisionPipelineConfig();
  switch (component) {
    case "PRICE_FORECASTER": return config.enablePriceForecaster;
    case "RL_EXECUTOR": return config.enableRlExecutor;
    case "MICROSTRUCTURE": return config.enableMicrostructure;
    case "META_CALIBRATION": return config.enableMetaCalibration;
    case "STOCK_RANKER": return config.enableStockRanker;
    case "REGIME_CLASSIFIER": return config.enableRegimeClassifier;
    case "PORTFOLIO_OPTIMIZER": return config.enablePortfolioOptimizer;
  }
}
