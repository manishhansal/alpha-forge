/**
 * Production Promotion Gates + System-State Machine (remediation Phase 33)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Encodes the explicit system states and the 18 mandatory gates that must ALL
 * pass before AlphaForge may enter PRODUCTION. The default state is PAPER; the
 * machine refuses to return PRODUCTION unless every mandatory gate passes, and
 * drops to HALTED if a catastrophic (P0) gate fails.
 *
 * This makes "do not enter production unless the evidence supports it" a
 * mechanical, testable rule rather than a judgement call. Pure + deterministic.
 */

export const PROMOTION_GATES_VERSION = "pgate-1.0.0";

export type SystemState =
  | "RESEARCH"
  | "SHADOW"
  | "PAPER"
  | "PRODUCTION_CANDIDATE"
  | "PRODUCTION"
  | "HALTED";

/** The 18 mandatory production gates (Phase 33). */
export const MANDATORY_GATES = [
  "noP0Leakage",
  "noP0DataCorruption",
  "durablePredictionPersistence",
  "durableOutcomePersistence",
  "reproducibleInference",
  "oosCalibration",
  "qualityMonotonicity",
  "gradeMonotonicity",
  "positiveNetExpectancy",
  "positiveProfitFactor",
  "costRobustness",
  "noSevereModelDrift",
  "validModelProvenance",
  "runtimeIntegrationVerified",
  "endToEndTestsPass",
  "dataProviderFailoverVerified",
  "abstentionVerified",
  "riskControlsVerified",
] as const;
export type GateName = (typeof MANDATORY_GATES)[number];

/**
 * Catastrophic gates: if any of these FAIL, the system is HALTED (not merely
 * kept in PAPER). These map to P0 blockers.
 */
export const CATASTROPHIC_GATES: ReadonlySet<GateName> = new Set<GateName>([
  "noP0Leakage",
  "noP0DataCorruption",
]);

/** A gate result: pass/fail + human reason + evidence pointer. */
export interface GateResult {
  gate: GateName;
  passed: boolean;
  reason: string;
}

export type GateInputs = Record<GateName, { passed: boolean; reason: string }>;

export interface PromotionEvaluation {
  state: SystemState;
  gates: GateResult[];
  passedCount: number;
  failedGates: GateName[];
  /** True only when EVERY mandatory gate passes. */
  productionEligible: boolean;
  summary: string;
}

/**
 * Evaluate all mandatory gates and compute the system state.
 *
 * Decision ladder (conservative):
 *   • Any CATASTROPHIC gate fails            → HALTED
 *   • All mandatory gates pass               → PRODUCTION_CANDIDATE
 *       (PRODUCTION is a deliberate human promotion from CANDIDATE, never auto)
 *   • Otherwise                              → PAPER (the safe default)
 *
 * Note: this function never returns PRODUCTION on its own. Automatic promotion
 * to live is forbidden — the best a machine evaluation yields is
 * PRODUCTION_CANDIDATE, and only when all 18 gates pass.
 */
export function evaluatePromotion(inputs: GateInputs): PromotionEvaluation {
  const gates: GateResult[] = MANDATORY_GATES.map((g) => ({
    gate: g,
    passed: inputs[g]?.passed ?? false,
    reason: inputs[g]?.reason ?? "no_evidence_supplied",
  }));

  const failedGates = gates.filter((g) => !g.passed).map((g) => g.gate);
  const passedCount = gates.length - failedGates.length;
  const catastrophicFailure = failedGates.some((g) => CATASTROPHIC_GATES.has(g));
  const allPass = failedGates.length === 0;

  let state: SystemState;
  if (catastrophicFailure) {
    state = "HALTED";
  } else if (allPass) {
    state = "PRODUCTION_CANDIDATE";
  } else {
    state = "PAPER";
  }

  const summary = catastrophicFailure
    ? `HALTED — catastrophic gate(s) failed: ${failedGates.filter((g) => CATASTROPHIC_GATES.has(g)).join(", ")}`
    : allPass
      ? "All 18 mandatory gates pass — eligible for human promotion to PRODUCTION."
      : `PAPER — ${failedGates.length}/${MANDATORY_GATES.length} gate(s) failing: ${failedGates.join(", ")}`;

  return { state, gates, passedCount, failedGates, productionEligible: allPass, summary };
}

/**
 * Convenience: a fully-failing baseline (nothing proven). Every gate defaults
 * to failed with an explicit reason, so an unpopulated evaluation can never
 * accidentally look production-ready.
 */
export function emptyGateInputs(reason = "not_yet_demonstrated"): GateInputs {
  const out = {} as GateInputs;
  for (const g of MANDATORY_GATES) out[g] = { passed: false, reason };
  return out;
}
