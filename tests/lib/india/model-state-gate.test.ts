/**
 * Tests for the Model-State Gate (Phase 7).
 *
 * The core invariant: an UNTRAINED / uniform-prior model can NEVER drive a live
 * A+ decision — it must fall back to ABSTAIN. Only VALIDATED/PRODUCTION are
 * live-eligible.
 */

import { describe, it, expect } from "vitest";
import {
  classifyModelState,
  promoteToProduction,
  isLiveEligible,
  evaluateAPlusEligibility,
  type ModelValidationEvidence,
} from "@/lib/india/model-state-gate";

const untrained: ModelValidationEvidence = {
  trained: false, provenance: "UNTRAINED_UNIFORM_PRIOR", addsValueOOS: false,
  oosSampleCount: 0, calibrationQuality: 0.5, acceptancePassed: false,
};
const shadow: ModelValidationEvidence = {
  trained: true, provenance: "LEARNED_OOS", addsValueOOS: false,
  oosSampleCount: 40, calibrationQuality: 0.5, acceptancePassed: false,
};
const validated: ModelValidationEvidence = {
  trained: true, provenance: "LEARNED_OOS", addsValueOOS: true,
  oosSampleCount: 500, calibrationQuality: 0.8, acceptancePassed: true,
};

describe("classifyModelState", () => {
  it("uniform prior → UNTRAINED", () => {
    expect(classifyModelState(untrained)).toBe("UNTRAINED");
  });
  it("trained but unproven → SHADOW", () => {
    expect(classifyModelState(shadow)).toBe("SHADOW");
  });
  it("OOS-validated evidence → VALIDATED", () => {
    expect(classifyModelState(validated)).toBe("VALIDATED");
  });
  it("insufficient OOS sample keeps it out of VALIDATED", () => {
    expect(classifyModelState({ ...validated, oosSampleCount: 10 })).toBe("SHADOW");
  });
  it("poor calibration keeps it out of VALIDATED", () => {
    expect(classifyModelState({ ...validated, calibrationQuality: 0.2 })).toBe("SHADOW");
  });
});

describe("live eligibility invariant", () => {
  it("UNTRAINED cannot drive live A+ → ABSTAIN", () => {
    const e = evaluateAPlusEligibility("UNTRAINED");
    expect(e.allowed).toBe(false);
    expect(e.fallbackDecision).toBe("ABSTAIN");
  });
  it("SHADOW cannot drive live A+ → ABSTAIN", () => {
    const e = evaluateAPlusEligibility("SHADOW");
    expect(e.allowed).toBe(false);
    expect(e.fallbackDecision).toBe("ABSTAIN");
  });
  it("VALIDATED and PRODUCTION are live-eligible", () => {
    expect(isLiveEligible("VALIDATED")).toBe(true);
    expect(isLiveEligible("PRODUCTION")).toBe(true);
    expect(evaluateAPlusEligibility("VALIDATED").allowed).toBe(true);
    expect(evaluateAPlusEligibility("PRODUCTION").allowed).toBe(true);
  });
});

describe("promotion", () => {
  it("only VALIDATED can be promoted to PRODUCTION", () => {
    expect(promoteToProduction("VALIDATED")).toBe("PRODUCTION");
    expect(promoteToProduction("SHADOW")).toBe("SHADOW");
    expect(promoteToProduction("UNTRAINED")).toBe("UNTRAINED");
  });
});
