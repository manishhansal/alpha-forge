/**
 * Model-State Gate (remediation Phase 7)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prevents an UNTRAINED / uniform-prior model artifact from silently driving
 * live A+ decisions. Every scoring model carries an explicit lifecycle state,
 * and only VALIDATED or PRODUCTION models may influence a live A+ grade.
 *
 * The rule (absolute): a model that is UNTRAINED or in SHADOW MUST NOT be
 * treated as evidence for promotion. If the model backing a live decision is
 * not VALIDATED/PRODUCTION, the correct behaviour is to ABSTAIN — never to fall
 * back to an untrained prior masquerading as a calibrated signal.
 *
 * Pure + deterministic. This module makes the "untrained cannot drive A+"
 * invariant explicit and testable; it does not itself fetch or train anything.
 */

export const MODEL_STATE_GATE_VERSION = "msg-1.0.0";

/** Explicit model lifecycle states. */
export type ModelState = "UNTRAINED" | "SHADOW" | "VALIDATED" | "PRODUCTION";

/** States that are allowed to influence a LIVE A+ decision. */
export const LIVE_ELIGIBLE_STATES: ReadonlySet<ModelState> = new Set<ModelState>(["VALIDATED", "PRODUCTION"]);

/**
 * The minimal evidence a model needs to be considered VALIDATED. These are
 * conservative floors; a model that does not meet them stays SHADOW/UNTRAINED.
 */
export interface ModelValidationEvidence {
  /** True when the artifact was actually trained on real OOS data (not a prior). */
  trained: boolean;
  /** Provenance flag: uniform/untrained priors are never live-eligible. */
  provenance: "LEARNED_OOS" | "UNTRAINED_UNIFORM_PRIOR" | string;
  /** Does the model demonstrably add value over baseline on OOS data? */
  addsValueOOS: boolean;
  /** OOS sample count backing the validation. */
  oosSampleCount: number;
  /** OOS calibration quality [0,1] (0 = uncalibrated). */
  calibrationQuality: number;
  /** Passed its acceptance gate on untouched OOS data. */
  acceptancePassed: boolean;
}

export interface ModelStateConfig {
  minOosSample: number;
  minCalibrationQuality: number;
}
export const DEFAULT_MODEL_STATE_CONFIG: ModelStateConfig = {
  minOosSample: 100,
  minCalibrationQuality: 0.55,
};

/**
 * Classify a model's lifecycle state from its evidence. The ladder is
 * conservative: anything untrained/uniform is UNTRAINED; trained-but-unproven
 * is SHADOW; only genuinely OOS-validated evidence reaches VALIDATED.
 * PRODUCTION is never inferred automatically — it must be explicitly promoted
 * (via `promoteToProduction`) from a VALIDATED model.
 */
export function classifyModelState(
  ev: ModelValidationEvidence,
  cfg: ModelStateConfig = DEFAULT_MODEL_STATE_CONFIG,
): ModelState {
  if (!ev.trained || ev.provenance === "UNTRAINED_UNIFORM_PRIOR") return "UNTRAINED";
  const validated =
    ev.addsValueOOS &&
    ev.acceptancePassed &&
    ev.oosSampleCount >= cfg.minOosSample &&
    ev.calibrationQuality >= cfg.minCalibrationQuality;
  return validated ? "VALIDATED" : "SHADOW";
}

/** A VALIDATED model may be explicitly promoted to PRODUCTION; others cannot. */
export function promoteToProduction(state: ModelState): ModelState {
  return state === "VALIDATED" ? "PRODUCTION" : state;
}

/** May this model influence a LIVE A+ decision? Only VALIDATED/PRODUCTION. */
export function isLiveEligible(state: ModelState): boolean {
  return LIVE_ELIGIBLE_STATES.has(state);
}

export interface APlusEligibility {
  allowed: boolean;
  /** When not allowed, the required safe action. */
  fallbackDecision: "ABSTAIN" | null;
  state: ModelState;
  reason: string;
}

/**
 * The invariant enforcement point: given the model state backing a candidate
 * live A+ decision, return whether A+ may be assigned. If the model is not
 * live-eligible the decision MUST fall back to ABSTAIN — an untrained/shadow
 * model can never mint a live A+.
 */
export function evaluateAPlusEligibility(state: ModelState): APlusEligibility {
  if (isLiveEligible(state)) {
    return { allowed: true, fallbackDecision: null, state, reason: "model_live_eligible" };
  }
  return {
    allowed: false,
    fallbackDecision: "ABSTAIN",
    state,
    reason:
      state === "UNTRAINED"
        ? "untrained_or_uniform_prior_cannot_drive_live_a_plus"
        : "shadow_model_not_yet_validated_on_oos",
  };
}
