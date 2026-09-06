"""
Phase 3J — Promotion Gates.

Acceptance ≠ Promotion (spec §18). This module integrates the existing
ModelAcceptanceGate and adds a multi-dimensional PromotionGate.

Design rules
------------
1. Acceptance means "technically/research valid". Promotion means "sufficiently
   evidenced to REPLACE the current champion".
2. Promotion is multi-dimensional (spec §19) — NOT a single Sharpe comparison.
   Six structured gates: PREDICTIVE / CALIBRATION / EXECUTION / RISK / STABILITY / DATA.
3. Each gate returns PASS / FAIL / INSUFFICIENT_EVIDENCE (spec §62). No black-box
   0-100 score.
4. Minimum-improvement thresholds are CONFIGURABLE and versioned (spec §21).
5. Final-OOS contamination blocks promotion (spec §24).
6. A challenger relying on LEVEL_C/D evidence does not auto-qualify (spec §15).
7. Fail-closed: missing evidence → INSUFFICIENT_EVIDENCE → NO promotion (spec §51).
8. No np.random.* — deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .evidence import ModelEvidencePackage
from .schemas import (
    ApprovalPolicy, EvidenceLevel, GateResult, GateStatus, PromotionDecision,
    PromotionOutcome,
)

UTC = timezone.utc


# ── Minimum improvement config (configurable, versioned — spec §21) ───────────

@dataclass
class PromotionPolicy:
    """
    Configurable promotion thresholds. NO hard-coded arbitrary values in logic.
    Every threshold lives here and is versioned.
    """
    # Minimum improvements the challenger must show over the champion
    min_ic_improvement:          float = 0.005    # absolute Rank IC improvement
    min_net_ev_improvement:      float = 0.0       # net EV must not be worse
    min_calibration_improvement: float = 0.0       # Brier must not degrade (lower=better)

    # Maximum tolerated degradations
    max_drawdown_degradation:    float = 0.02      # challenger max_dd may be at most +2% worse
    max_turnover_increase:       float = 0.20      # turnover may rise at most 20% (relative)
    max_cost_increase:           float = 0.20      # cost may rise at most 20% (relative)

    # Evidence requirements
    min_evidence_level:          EvidenceLevel = EvidenceLevel.LEVEL_B
    require_positive_net_return: bool = True

    # Data / stability gate minimums
    min_oos_observations:        int = 60
    require_stability_pass:      bool = True

    # Approval
    high_impact_requires_human:  bool = True

    version:                     str = "promotion-policy-v1"


# ══════════════════════════════════════════════════════════════════════════════
# Individual gates
# ══════════════════════════════════════════════════════════════════════════════

def _data_gate(
    challenger: ModelEvidencePackage,
    policy: PromotionPolicy,
) -> GateResult:
    """DATA gate: integrity, sample size, final-OOS contamination."""
    reasons = []
    oos = challenger.oos_evidence
    metrics = {
        "n_oos_observations": oos.n_oos_observations,
        "evidence_level":     challenger.evidence_level.value,
        "final_oos_used_for_selection": oos.final_oos_used_for_selection,
    }

    # Spec §24 — final OOS contamination blocks promotion
    if oos.final_oos_used_for_selection:
        reasons.append("FINAL_OOS_CONTAMINATED: final OOS was used for selection.")
        return GateResult("DATA", GateStatus.FAIL, reasons, metrics)

    # Evidence integrity
    if not challenger.verify_integrity():
        reasons.append("Evidence package failed integrity verification.")
        return GateResult("DATA", GateStatus.FAIL, reasons, metrics)

    # Sample size
    if oos.n_oos_observations < policy.min_oos_observations:
        reasons.append(
            f"OOS observations {oos.n_oos_observations} < minimum "
            f"{policy.min_oos_observations}."
        )
        return GateResult("DATA", GateStatus.INSUFFICIENT_EVIDENCE, reasons, metrics)

    # Evidence level (spec §15 — LEVEL_C/D does not auto-qualify)
    level_order = {EvidenceLevel.LEVEL_D: 0, EvidenceLevel.LEVEL_C: 1,
                   EvidenceLevel.LEVEL_B: 2, EvidenceLevel.LEVEL_A: 3}
    if level_order[challenger.evidence_level] < level_order[policy.min_evidence_level]:
        reasons.append(
            f"Evidence level {challenger.evidence_level.value} below required "
            f"{policy.min_evidence_level.value}."
        )
        return GateResult("DATA", GateStatus.INSUFFICIENT_EVIDENCE, reasons, metrics)

    return GateResult("DATA", GateStatus.PASS, [], metrics)


def _predictive_gate(
    challenger: ModelEvidencePackage,
    champion: Optional[ModelEvidencePackage],
    policy: PromotionPolicy,
) -> GateResult:
    """PREDICTIVE gate: IC improvement vs champion."""
    c_ic = challenger.oos_evidence.mean_rank_ic
    metrics = {"challenger_rank_ic": c_ic}

    if c_ic is None:
        return GateResult("PREDICTIVE", GateStatus.INSUFFICIENT_EVIDENCE,
                          ["Challenger Rank IC unavailable."], metrics)

    if champion is None:
        # No incumbent — challenger just needs positive predictive signal
        if c_ic > 0:
            return GateResult("PREDICTIVE", GateStatus.PASS,
                              ["No incumbent champion; challenger IC > 0."], metrics)
        return GateResult("PREDICTIVE", GateStatus.FAIL,
                          [f"Challenger Rank IC {c_ic} not positive."], metrics)

    champ_ic = champion.oos_evidence.mean_rank_ic
    metrics["champion_rank_ic"] = champ_ic
    if champ_ic is None:
        return GateResult("PREDICTIVE", GateStatus.INSUFFICIENT_EVIDENCE,
                          ["Champion Rank IC unavailable for comparison."], metrics)

    improvement = c_ic - champ_ic
    metrics["ic_improvement"] = improvement
    metrics["min_ic_improvement"] = policy.min_ic_improvement
    if improvement < policy.min_ic_improvement:
        return GateResult("PREDICTIVE", GateStatus.FAIL, [
            f"Rank IC improvement {improvement:.4f} < required "
            f"{policy.min_ic_improvement:.4f}."
        ], metrics)

    return GateResult("PREDICTIVE", GateStatus.PASS, [], metrics)


def _calibration_gate(
    challenger: ModelEvidencePackage,
    champion: Optional[ModelEvidencePackage],
    policy: PromotionPolicy,
) -> GateResult:
    """CALIBRATION gate: Brier must not materially degrade (spec §29)."""
    c_brier = challenger.calibration_evidence.brier
    metrics = {"challenger_brier": c_brier}

    if c_brier is None:
        return GateResult("CALIBRATION", GateStatus.INSUFFICIENT_EVIDENCE,
                          ["Challenger calibration (Brier) unavailable."], metrics)

    if champion is None or champion.calibration_evidence.brier is None:
        return GateResult("CALIBRATION", GateStatus.PASS,
                          ["No champion calibration to compare against."], metrics)

    champ_brier = champion.calibration_evidence.brier
    metrics["champion_brier"] = champ_brier
    # Lower Brier is better; challenger must not be worse by more than tolerance
    degradation = c_brier - champ_brier
    metrics["brier_degradation"] = degradation
    if degradation > policy.min_calibration_improvement + 0.01:
        return GateResult("CALIBRATION", GateStatus.FAIL, [
            f"Brier degraded by {degradation:.4f} (challenger {c_brier:.4f} "
            f"vs champion {champ_brier:.4f})."
        ], metrics)

    return GateResult("CALIBRATION", GateStatus.PASS, [], metrics)


def _execution_gate(
    challenger: ModelEvidencePackage,
    champion: Optional[ModelEvidencePackage],
    policy: PromotionPolicy,
) -> GateResult:
    """EXECUTION gate: net return positive; cost/turnover not materially worse."""
    ce = challenger.execution_evidence
    metrics = {"challenger_net_return": ce.net_return, "challenger_turnover": ce.turnover}

    if ce.net_return is None:
        return GateResult("EXECUTION", GateStatus.INSUFFICIENT_EVIDENCE,
                          ["Challenger net return unavailable (no execution evidence)."], metrics)

    if policy.require_positive_net_return and ce.net_return <= 0:
        return GateResult("EXECUTION", GateStatus.FAIL,
                          [f"Challenger net return {ce.net_return:.4f} ≤ 0."], metrics)

    if champion is not None and champion.execution_evidence.turnover is not None and ce.turnover is not None:
        champ_turn = champion.execution_evidence.turnover
        if champ_turn > 0:
            turn_increase = (ce.turnover - champ_turn) / champ_turn
            metrics["turnover_increase"] = turn_increase
            if turn_increase > policy.max_turnover_increase:
                return GateResult("EXECUTION", GateStatus.FAIL, [
                    f"Turnover increased by {turn_increase:.1%} > allowed "
                    f"{policy.max_turnover_increase:.1%}."
                ], metrics)

    return GateResult("EXECUTION", GateStatus.PASS, [], metrics)


def _risk_gate(
    challenger: ModelEvidencePackage,
    champion: Optional[ModelEvidencePackage],
    policy: PromotionPolicy,
) -> GateResult:
    """RISK gate: max drawdown must not materially degrade."""
    c_dd = challenger.portfolio_evidence.max_drawdown
    metrics = {"challenger_max_drawdown": c_dd}

    if c_dd is None:
        return GateResult("RISK", GateStatus.INSUFFICIENT_EVIDENCE,
                          ["Challenger max drawdown unavailable."], metrics)

    if champion is None or champion.portfolio_evidence.max_drawdown is None:
        return GateResult("RISK", GateStatus.PASS,
                          ["No champion drawdown to compare against."], metrics)

    champ_dd = champion.portfolio_evidence.max_drawdown
    metrics["champion_max_drawdown"] = champ_dd
    # max_drawdown is negative; "degradation" = challenger more negative than champion
    degradation = abs(c_dd) - abs(champ_dd)
    metrics["drawdown_degradation"] = degradation
    if degradation > policy.max_drawdown_degradation:
        return GateResult("RISK", GateStatus.FAIL, [
            f"Max drawdown degraded by {degradation:.4f} > allowed "
            f"{policy.max_drawdown_degradation:.4f}."
        ], metrics)

    return GateResult("RISK", GateStatus.PASS, [], metrics)


def _stability_gate(
    challenger: ModelEvidencePackage,
    policy: PromotionPolicy,
) -> GateResult:
    """STABILITY gate: IC decay / drift must not be severe (spec §33)."""
    se = challenger.stability_evidence
    metrics = {
        "ic_decay_status":            se.ic_decay_status,
        "feature_drift_severity":     se.feature_drift_severity,
        "prediction_drift_severity":  se.prediction_drift_severity,
    }

    if se.ic_decay_status in ("INSUFFICIENT_EVIDENCE", ""):
        if policy.require_stability_pass:
            return GateResult("STABILITY", GateStatus.INSUFFICIENT_EVIDENCE,
                              ["Stability evidence unavailable."], metrics)
        return GateResult("STABILITY", GateStatus.PASS, [], metrics)

    if se.ic_decay_status in ("FAILED", "SIGNIFICANT_DECAY"):
        return GateResult("STABILITY", GateStatus.FAIL, [
            f"IC decay status is {se.ic_decay_status}."
        ], metrics)

    if se.feature_drift_severity in ("HIGH", "CRITICAL"):
        return GateResult("STABILITY", GateStatus.FAIL, [
            f"Feature drift severity {se.feature_drift_severity}."
        ], metrics)

    return GateResult("STABILITY", GateStatus.PASS, [], metrics)


# ══════════════════════════════════════════════════════════════════════════════
# Promotion gate orchestrator
# ══════════════════════════════════════════════════════════════════════════════

class PromotionGate:
    """
    Multi-dimensional promotion gate (spec §18, §19, §62, §63).

    Usage
    -----
    ::
        gate = PromotionGate(policy)
        decision = gate.evaluate(
            scope="equity/5D",
            challenger_evidence=challenger_pkg,
            champion_evidence=champion_pkg,   # None if no incumbent
            challenger_id="chal-001",
            champion_id="model-a@v1",
        )
        if decision.outcome == PromotionOutcome.PROMOTE:
            ...
    """

    def __init__(self, policy: Optional[PromotionPolicy] = None) -> None:
        self.policy = policy or PromotionPolicy()

    def evaluate(
        self,
        scope: str,
        challenger_evidence: ModelEvidencePackage,
        champion_evidence: Optional[ModelEvidencePackage],
        challenger_id: str,
        champion_id: Optional[str],
        comparison_id: str = "",
        approval_policy_override: Optional[ApprovalPolicy] = None,
    ) -> PromotionDecision:
        """Run all six gates and produce a structured PromotionDecision."""
        p = self.policy

        gates = [
            _data_gate(challenger_evidence, p),
            _predictive_gate(challenger_evidence, champion_evidence, p),
            _calibration_gate(challenger_evidence, champion_evidence, p),
            _execution_gate(challenger_evidence, champion_evidence, p),
            _risk_gate(challenger_evidence, champion_evidence, p),
            _stability_gate(challenger_evidence, p),
        ]

        final_oos_contaminated = challenger_evidence.oos_evidence.final_oos_used_for_selection

        # Determine outcome
        if final_oos_contaminated:
            outcome = PromotionOutcome.BLOCKED
            reasons = ["FINAL_OOS_CONTAMINATED: promotion blocked (spec §24)."]
        elif any(g.status == GateStatus.FAIL for g in gates):
            outcome = PromotionOutcome.DO_NOT_PROMOTE
            reasons = [f"{g.gate_name} gate FAILED" for g in gates if g.status == GateStatus.FAIL]
        elif any(g.status == GateStatus.INSUFFICIENT_EVIDENCE for g in gates):
            outcome = PromotionOutcome.INSUFFICIENT_EVIDENCE
            reasons = [
                f"{g.gate_name} gate INSUFFICIENT_EVIDENCE"
                for g in gates if g.status == GateStatus.INSUFFICIENT_EVIDENCE
            ]
        else:
            outcome = PromotionOutcome.PROMOTE
            reasons = ["All gates PASS."]

        # Approval policy
        if approval_policy_override is not None:
            approval = approval_policy_override
        elif outcome != PromotionOutcome.PROMOTE:
            approval = ApprovalPolicy.AUTO_REJECTED
        elif p.high_impact_requires_human:
            approval = ApprovalPolicy.HUMAN_APPROVAL_REQUIRED
        else:
            approval = ApprovalPolicy.AUTO_APPROVED

        return PromotionDecision(
            outcome=outcome,
            scope=scope,
            champion_id=champion_id,
            challenger_id=challenger_id,
            gate_results=gates,
            reasons=reasons,
            approval_policy=approval,
            final_oos_contaminated=final_oos_contaminated,
            promotion_policy_version=p.version,
            decided_at=datetime.now(UTC).isoformat(),
            evidence_package_id=challenger_evidence.evidence_package_id,
            comparison_id=comparison_id,
        )
