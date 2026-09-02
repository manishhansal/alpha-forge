/**
 * Signal Quality Evaluation — Public API
 *
 * Re-exports the engine, types, and ground truth definitions for
 * use by API routes and frontend components.
 */

export { computeSignalQualityReport } from "./engine";
export { ALL_GROUND_TRUTH_DEFINITIONS, GROUND_TRUTH_BY_STRATEGY, getEvaluationHorizonMs } from "./ground-truth";
export * from "./types";
export {
  mean,
  median,
  stdDev,
  percentile,
  safeDiv,
  brierScore,
  expectedCalibrationError,
  bootstrapMeanCI,
  bootstrapWinRateCI,
  assessSignificance,
  profitFactor,
  expectancy,
  maxDrawdown,
  BASE_COST_BPS,
  MIN_SAMPLE_FOR_VERDICT,
  MIN_SAMPLE_FOR_PRECISION,
} from "./stats";
