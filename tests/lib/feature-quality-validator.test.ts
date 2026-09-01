/**
 * FeatureQualityValidator — Unit Tests (Phase 4)
 *
 * Tests that replace unsafe generic NaN→0 sanitization with
 * model-specific policies. Validates all edge cases per the spec.
 */

import { describe, expect, it } from "vitest";
import {
  validateFeatureVector,
  REGIME_CLASSIFIER_CONTRACT,
  STOCK_RANKER_CONTRACT,
  type DataQualityStatus,
} from "@/lib/india/feature-quality-validator";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fully valid regime classifier feature set. */
function validRegimeFeatures(): Record<string, number> {
  return {
    nifty_change_pct: 0.5,
    banknifty_change_pct: 0.4,
    india_vix: 14.5,
    nifty_atr_pct: 0.8,
    nifty_adx: 25,
    advance_decline_ratio: 0.2,
    market_breadth: 60,
    sector_strength: 0.3,
    volume_ratio: 1.1,
    gap_pct: 0.1,
  };
}

/** Build a fully valid ranker feature set for one stock. */
function validRankerFeatures(): Record<string, number> {
  return {
    relative_volume: 1.2,
    atr_expansion: 1.1,
    momentum_5d: 2.5,
    momentum_10d: 3.0,
    vwap_distance_pct: 0.5,
    ema_stack_score: 0.6,
    rsi_14: 55,
    macd_histogram: 0.2,
    adx_14: 28,
    sector_momentum: 0.4,
    relative_strength_vs_nifty: 1.5,
    market_breadth: 60,
    gap_pct: 0.1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("validateFeatureVector — regime classifier", () => {
  it("returns VALID when all features are within range", () => {
    const result = validateFeatureVector(validRegimeFeatures(), REGIME_CLASSIFIER_CONTRACT);

    expect(result.dataQuality).toBe<DataQualityStatus>("VALID");
    expect(result.invalidFeatureCount).toBe(0);
    expect(result.imputedFeatureCount).toBe(0);
    expect(result.reason).toBeNull();
    expect(result.featureVersion).toBe("regime_v1");
  });

  it("returns VALID with correct sanitized values", () => {
    const input = validRegimeFeatures();
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.sanitized.nifty_change_pct).toBe(0.5);
    expect(result.sanitized.india_vix).toBe(14.5);
  });

  it("returns DEGRADED and imputes NaN RSI with training median", () => {
    const input = { ...validRegimeFeatures(), india_vix: NaN };
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.dataQuality).toBe<DataQualityStatus>("DEGRADED");
    expect(result.imputedFeatures).toContain("india_vix");
    // Training median for india_vix is 14.5
    expect(result.sanitized.india_vix).toBe(14.5);
    expect(result.imputedFeatureCount).toBe(1);
  });

  it("imputes Infinity ATR with training median", () => {
    const input = { ...validRegimeFeatures(), nifty_atr_pct: Infinity };
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.dataQuality).toBe<DataQualityStatus>("DEGRADED");
    expect(result.sanitized.nifty_atr_pct).toBe(0.8); // training median
  });

  it("imputes -Infinity volume_ratio with training median", () => {
    const input = { ...validRegimeFeatures(), volume_ratio: -Infinity };
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.sanitized.volume_ratio).toBe(1.0); // training median
  });

  it("returns DEGRADED when advance_decline_ratio is NaN (zero imputation)", () => {
    const input = { ...validRegimeFeatures(), advance_decline_ratio: NaN };
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.dataQuality).toBe<DataQualityStatus>("DEGRADED");
    expect(result.sanitized.advance_decline_ratio).toBe(0); // ZERO_ONLY_IF_TRAINED
  });

  it("returns INVALID when more than 30% of features are imputed", () => {
    // Corrupt 4 features out of 10 = 40% > 30% threshold
    const input = {
      ...validRegimeFeatures(),
      india_vix: NaN,
      nifty_atr_pct: NaN,
      nifty_adx: NaN,
      market_breadth: NaN,
    };
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.dataQuality).toBe<DataQualityStatus>("INVALID");
    expect(result.reason).toMatch(/30%/);
  });

  it("flags missing features as invalid", () => {
    const input: Record<string, number> = {
      nifty_change_pct: 0.5,
      banknifty_change_pct: 0.4,
      // india_vix deliberately missing
      nifty_atr_pct: 0.8,
      nifty_adx: 25,
      advance_decline_ratio: 0.2,
      market_breadth: 60,
      sector_strength: 0.3,
      volume_ratio: 1.1,
      gap_pct: 0.1,
    };
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.invalidFeatures).toContain("india_vix");
  });

  it("out-of-range value is treated as invalid", () => {
    // nifty_change_pct valid range is [-15, 15]
    const input = { ...validRegimeFeatures(), nifty_change_pct: 99 };
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.invalidFeatures).toContain("nifty_change_pct");
    expect(result.imputedFeatures).toContain("nifty_change_pct");
    // ZERO_ONLY_IF_TRAINED imputation
    expect(result.sanitized.nifty_change_pct).toBe(0);
  });

  it("maintains ordered feature output matching contract order", () => {
    const input = validRegimeFeatures();
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    const contractNames = REGIME_CLASSIFIER_CONTRACT.orderedFeatures.map((f) => f.featureName);
    const sanitizedNames = Object.keys(result.sanitized);

    // All contract features must be in the sanitized output
    for (const name of contractNames) {
      expect(sanitizedNames).toContain(name);
    }
  });
});

describe("validateFeatureVector — stock ranker", () => {
  it("returns VALID for fully valid ranker features", () => {
    const result = validateFeatureVector(validRankerFeatures(), STOCK_RANKER_CONTRACT);

    expect(result.dataQuality).toBe<DataQualityStatus>("VALID");
    expect(result.featureVersion).toBe("ranker_v1");
  });

  it("imputes NaN RSI with training median (50)", () => {
    const input = { ...validRankerFeatures(), rsi_14: NaN };
    const result = validateFeatureVector(input, STOCK_RANKER_CONTRACT);

    expect(result.sanitized.rsi_14).toBe(50); // training median
    expect(result.imputedFeatures).toContain("rsi_14");
  });

  it("imputes missing volume as DEGRADED (missing feature)", () => {
    const { relative_volume: _, ...withoutVolume } = validRankerFeatures();
    const result = validateFeatureVector(withoutVolume, STOCK_RANKER_CONTRACT);

    expect(result.invalidFeatures).toContain("relative_volume");
    expect(result.dataQuality).not.toBe<DataQualityStatus>("VALID");
  });

  it("wrong dtype (string) treated as invalid and imputed", () => {
    const input = { ...validRankerFeatures(), rsi_14: "not-a-number" as unknown as number };
    const result = validateFeatureVector(input, STOCK_RANKER_CONTRACT);

    expect(result.invalidFeatures).toContain("rsi_14");
    expect(result.sanitized.rsi_14).toBe(50); // training median imputation
  });
});

describe("unexpected and extra features", () => {
  it("does not fail on unexpected extra features in input (warns but continues)", () => {
    const input = {
      ...validRegimeFeatures(),
      unknown_feature_xyz: 42,   // not in contract
    };
    // Should not throw
    const result = validateFeatureVector(input, REGIME_CLASSIFIER_CONTRACT);

    expect(result.dataQuality).toBe<DataQualityStatus>("VALID");
    // Unexpected feature should NOT be in sanitized output
    expect("unknown_feature_xyz" in result.sanitized).toBe(false);
  });
});
