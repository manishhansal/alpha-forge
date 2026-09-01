/**
 * Feature Contract Registry — Parity Tests (Phase 5)
 *
 * Verifies training/inference parity for all registered production models.
 */

import { describe, expect, it } from "vitest";
import {
  featureContractRegistry,
} from "@/lib/india/feature-contract-registry";

describe("FeatureContractRegistry", () => {
  it("has all three production models registered", () => {
    const models = featureContractRegistry.productionModels();
    const names = models.map((m) => m.modelName);

    expect(names).toContain("regime_classifier");
    expect(names).toContain("stock_ranker");
    expect(names).toContain("price_forecaster");
  });

  it("regime_classifier has correct feature count and version", () => {
    const reg = featureContractRegistry.get("regime_classifier", "v1");
    expect(reg).toBeDefined();
    expect(reg!.featureVersion).toBe("regime_v1");
    expect(reg!.contract.orderedFeatures).toHaveLength(10);
  });

  it("stock_ranker has correct feature count and version", () => {
    const reg = featureContractRegistry.get("stock_ranker", "v1");
    expect(reg).toBeDefined();
    expect(reg!.featureVersion).toBe("ranker_v1");
    expect(reg!.contract.orderedFeatures).toHaveLength(13);
  });

  it("price_forecaster requires exactly 60 5-minute candles", () => {
    const reg = featureContractRegistry.get("price_forecaster", "v1");
    expect(reg).toBeDefined();
    expect(reg!.lookbackRequirements.historicalCandles).toBe(60);
    expect(reg!.lookbackRequirements.candleInterval).toBe("5m");
  });

  it("verifyParity returns match when feature list matches contract", () => {
    const contractFeatures = featureContractRegistry
      .get("regime_classifier", "v1")!
      .contract.orderedFeatures.map((f) => f.featureName);

    const result = featureContractRegistry.verifyParity(
      "regime_classifier",
      "v1",
      contractFeatures,
    );

    expect(result.matches).toBe(true);
    expect(result.discrepancies).toHaveLength(0);
  });

  it("verifyParity detects wrong feature order", () => {
    const contractFeatures = featureContractRegistry
      .get("regime_classifier", "v1")!
      .contract.orderedFeatures.map((f) => f.featureName);

    // Swap first two features
    const scrambled = [...contractFeatures];
    [scrambled[0], scrambled[1]] = [scrambled[1]!, scrambled[0]!];

    const result = featureContractRegistry.verifyParity(
      "regime_classifier",
      "v1",
      scrambled,
    );

    expect(result.matches).toBe(false);
    expect(result.discrepancies.length).toBeGreaterThan(0);
  });

  it("verifyParity detects missing features", () => {
    const contractFeatures = featureContractRegistry
      .get("regime_classifier", "v1")!
      .contract.orderedFeatures.map((f) => f.featureName);

    // Remove last feature
    const incomplete = contractFeatures.slice(0, -1);

    const result = featureContractRegistry.verifyParity(
      "regime_classifier",
      "v1",
      incomplete,
    );

    expect(result.matches).toBe(false);
    expect(result.discrepancies.some((d) => d.includes("Missing feature"))).toBe(true);
  });

  it("verifyParity detects extra features in live pipeline", () => {
    const contractFeatures = featureContractRegistry
      .get("regime_classifier", "v1")!
      .contract.orderedFeatures.map((f) => f.featureName);

    // Add an extra feature not in the contract
    const withExtra = [...contractFeatures, "mystery_feature_xyz"];

    const result = featureContractRegistry.verifyParity(
      "regime_classifier",
      "v1",
      withExtra,
    );

    expect(result.matches).toBe(false);
    expect(result.discrepancies.some((d) => d.includes("Extra feature"))).toBe(true);
  });

  it("each production model has a consistent featureListHash", () => {
    const models = featureContractRegistry.productionModels();
    for (const model of models) {
      // Hash must be a non-empty hex string
      expect(model.featureListHash).toMatch(/^[0-9a-f]+$/);
      expect(model.featureListHash.length).toBeGreaterThan(0);
    }
  });
});
