/**
 * Canonical Decision Authority (remediation P0/P1 — Phase 3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There must be ONE authoritative final decision. This module resolves the
 * outputs of the (possibly disagreeing) engines into a single
 * `canonicalDecision` + `canonicalDecisionReason`, enforcing a strict veto
 * hierarchy so a lower-level BUY can NEVER bypass a higher-level veto.
 *
 * Priority ladder (highest authority first — the first matching condition wins):
 *
 *   CRITICAL_DATA_FAILURE   → REJECT
 *   INSUFFICIENT_DATA       → ABSTAIN
 *   RISK_BLOCKED            → NO_TRADE
 *   UNTRAINED_MODEL         → WAIT   (shadow only; no ML conviction)
 *   CALIBRATION_UNAVAILABLE → WAIT
 *   NEGATIVE_NET_EV         → NO_TRADE
 *   FAILS_COST_STRESS       → NO_TRADE
 *   FRAGILE                 → WATCH
 *   INSUFFICIENT_EVIDENCE   → WATCH
 *   VALIDATED_HIGH_EDGE     → TRADE
 *   A_PLUS                  → TRADE (only if all mandatory gates pass)
 *
 * Pure + deterministic. No engine can "out-vote" a higher veto.
 */

import type { ModelState } from "./model-state-gate";
import { isLiveEligible } from "./model-state-gate";

export const CANONICAL_DECISION_VERSION = "cdec-1.0.0";

export type CanonicalDecision = "REJECT" | "ABSTAIN" | "NO_TRADE" | "WAIT" | "WATCH" | "TRADE";

/** Machine-readable reason codes, ordered by descending authority. */
export type DecisionReason =
  | "CRITICAL_DATA_FAILURE"
  | "INSUFFICIENT_DATA"
  | "RISK_BLOCKED"
  | "UNTRAINED_MODEL"
  | "CALIBRATION_UNAVAILABLE"
  | "NEGATIVE_NET_EV"
  | "FAILS_COST_STRESS"
  | "FRAGILE"
  | "INSUFFICIENT_EVIDENCE"
  | "VALIDATED_HIGH_EDGE"
  | "A_PLUS";

/** Everything the authority needs to decide. Booleans are upstream verdicts. */
export interface DecisionInputs {
  criticalDataIssue: boolean;
  insufficientData: boolean;      // e.g. missing candles / no snapshot
  riskBlocked: boolean;
  modelState: ModelState;         // from model-state-gate
  calibrationAvailable: boolean;  // is calibratedProbability trustworthy?
  netEVPct: number;               // cost-adjusted net EV (% of entry)
  survives2xCost: boolean;
  fragile: boolean;               // counterfactual robustness failed
  hasSufficientEvidence: boolean; // sample size / evidence score gate
  aPlus: boolean;                 // A+ factory said this is A+
  allMandatoryGatesPass: boolean; // promotion gates all green
}

export interface CanonicalDecisionResult {
  decision: CanonicalDecision;
  reason: DecisionReason;
  /** The full ordered ladder trace (for auditability). */
  trace: Array<{ reason: DecisionReason; triggered: boolean }>;
}

/**
 * Resolve the single authoritative decision. Evaluated strictly top-down; the
 * first triggered rung decides. This guarantees a BUY-like signal can never
 * override a higher veto (data failure, risk block, negative EV, …).
 */
export function resolveCanonicalDecision(i: DecisionInputs): CanonicalDecisionResult {
  const ladder: Array<{ reason: DecisionReason; triggered: boolean; decision: CanonicalDecision }> = [
    { reason: "CRITICAL_DATA_FAILURE", triggered: i.criticalDataIssue, decision: "REJECT" },
    { reason: "INSUFFICIENT_DATA", triggered: i.insufficientData, decision: "ABSTAIN" },
    { reason: "RISK_BLOCKED", triggered: i.riskBlocked, decision: "NO_TRADE" },
    // An untrained/shadow model cannot lend conviction — wait, never claim edge.
    { reason: "UNTRAINED_MODEL", triggered: !isLiveEligible(i.modelState), decision: "WAIT" },
    { reason: "CALIBRATION_UNAVAILABLE", triggered: !i.calibrationAvailable, decision: "WAIT" },
    { reason: "NEGATIVE_NET_EV", triggered: i.netEVPct <= 0, decision: "NO_TRADE" },
    { reason: "FAILS_COST_STRESS", triggered: !i.survives2xCost, decision: "NO_TRADE" },
    { reason: "FRAGILE", triggered: i.fragile, decision: "WATCH" },
    { reason: "INSUFFICIENT_EVIDENCE", triggered: !i.hasSufficientEvidence, decision: "WATCH" },
    // Only reached when every veto above is clear.
    { reason: "A_PLUS", triggered: i.aPlus && i.allMandatoryGatesPass, decision: "TRADE" },
    { reason: "VALIDATED_HIGH_EDGE", triggered: true, decision: "TRADE" },
  ];

  const trace = ladder.map((r) => ({ reason: r.reason, triggered: r.triggered }));
  for (const rung of ladder) {
    if (rung.triggered) {
      return { decision: rung.decision, reason: rung.reason, trace };
    }
  }
  // Unreachable (last rung is always true), but stay safe.
  return { decision: "WAIT", reason: "INSUFFICIENT_EVIDENCE", trace };
}
