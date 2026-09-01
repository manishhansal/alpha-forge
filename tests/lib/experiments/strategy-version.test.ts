/**
 * strategy-version.test.ts
 * Tests for StrategyVersionRegistry — registration, aliases, stamp validation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  StrategyVersionRegistry,
  type VersionStamp,
} from "@/lib/experiments/strategy-version";

function makeRegistry() {
  return new StrategyVersionRegistry();
}

describe("StrategyVersionRegistry", () => {
  let reg: StrategyVersionRegistry;

  beforeEach(() => {
    reg = makeRegistry();
    reg.registerStrategy({ version: "strat-v1", label: "Strategy v1", stage: "SHADOW", status: "ACTIVE" });
    reg.registerModel({ version: "model-v1", label: "Model v1", status: "ACTIVE" });
    reg.registerFeatures({ version: "feat-v1", label: "Features v1", status: "ACTIVE" });
  });

  it("registers and retrieves a strategy version", () => {
    const meta = reg.getStrategy("strat-v1");
    expect(meta).toBeDefined();
    expect(meta!.version).toBe("strat-v1");
    expect(meta!.stage).toBe("SHADOW");
    expect(meta!.registeredAtMs).toBeGreaterThan(0);
  });

  it("registers and retrieves a model version", () => {
    const meta = reg.getModel("model-v1");
    expect(meta).toBeDefined();
    expect(meta!.label).toBe("Model v1");
  });

  it("registers and retrieves a feature version", () => {
    const meta = reg.getFeatures("feat-v1");
    expect(meta).toBeDefined();
    expect(meta!.label).toBe("Features v1");
  });

  it("returns undefined for unknown versions", () => {
    expect(reg.getStrategy("nonexistent")).toBeUndefined();
    expect(reg.getModel("nonexistent")).toBeUndefined();
    expect(reg.getFeatures("nonexistent")).toBeUndefined();
  });

  it("resolves strategy alias to version string", () => {
    reg.setStrategyAlias("latest", "strat-v1");
    expect(reg.resolveStrategyAlias("latest")).toBe("strat-v1");
    expect(reg.getStrategy("latest")!.version).toBe("strat-v1");
  });

  it("throws when setting alias for unknown version", () => {
    expect(() => reg.setStrategyAlias("bad", "nonexistent")).toThrow();
  });

  it("builds a valid VersionStamp", () => {
    const stamp = reg.buildVersionStamp("strat-v1", "model-v1", "feat-v1", "exp_001");
    expect(stamp.strategyVersion).toBe("strat-v1");
    expect(stamp.modelVersion).toBe("model-v1");
    expect(stamp.featureVersion).toBe("feat-v1");
    expect(stamp.experimentId).toBe("exp_001");
  });

  it("resolves aliases in buildVersionStamp", () => {
    reg.setStrategyAlias("stable", "strat-v1");
    reg.setModelAlias("prod", "model-v1");
    const stamp = reg.buildVersionStamp("stable", "prod", "feat-v1", "exp_002");
    expect(stamp.strategyVersion).toBe("strat-v1");
    expect(stamp.modelVersion).toBe("model-v1");
  });

  it("validateStamp returns empty array for valid stamp", () => {
    const stamp: VersionStamp = {
      strategyVersion: "strat-v1",
      modelVersion: "model-v1",
      featureVersion: "feat-v1",
      experimentId: "exp_001",
    };
    expect(reg.validateStamp(stamp)).toHaveLength(0);
  });

  it("validateStamp returns errors for unknown versions", () => {
    const stamp: VersionStamp = {
      strategyVersion: "bad-strat",
      modelVersion: "bad-model",
      featureVersion: "feat-v1",
      experimentId: "exp_001",
    };
    const errors = reg.validateStamp(stamp);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("bad-strat");
    expect(errors[1]).toContain("bad-model");
  });

  it("updates strategy stage", () => {
    reg.updateStrategyStage("strat-v1", "PAPER");
    expect(reg.getStrategy("strat-v1")!.stage).toBe("PAPER");
  });

  it("updates strategy status", () => {
    reg.updateStrategyStatus("strat-v1", "PAUSED");
    expect(reg.getStrategy("strat-v1")!.status).toBe("PAUSED");
  });

  it("lists all registered versions", () => {
    reg.registerStrategy({ version: "strat-v2", label: "Strategy v2", stage: "RESEARCH", status: "ACTIVE" });
    expect(reg.listStrategies()).toHaveLength(2);
    expect(reg.listModels()).toHaveLength(1);
    expect(reg.listFeatures()).toHaveLength(1);
  });

  it("serialises to JSON with all sections", () => {
    const json = reg.toJSON();
    expect(json.strategies).toHaveLength(1);
    expect(json.models).toHaveLength(1);
    expect(json.features).toHaveLength(1);
  });
});
