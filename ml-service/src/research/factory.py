"""
Phase 3S — Research factory orchestrator & promotion boundary (spec §41, §52, §56).

The ResearchFactory ties the pieces together and enforces the boundary:

  - §41 The factory may RECOMMEND a `CHALLENGER_CANDIDATE` but must NEVER promote a
    champion, replace a champion, deploy live, or modify a paper champion. The
    existing lifecycle/human-approval process remains authoritative.
  - §52 A challenger recommendation ALWAYS requires human review — never automatic.
  - §56 Experiment isolation: running an experiment must not mutate champion /
    challenger / paper session / production configuration / historical evidence.

The factory produces a RecommendationDecision. Even when all nine gates pass and
the tier is Tier D, the recommendation is CHALLENGER_CANDIDATE with
`requires_human_review=True` and `promoted=False`. There is deliberately NO method
on this class that promotes, retrains, recalibrates, or trades.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from src.research.gates import GateReport
from src.research.experiment_tiers import ExperimentTier, is_promotable
from src.research.status import ResearchStatus, FailureReason


class RecommendationOutcome(str, Enum):
    CHALLENGER_CANDIDATE  = "CHALLENGER_CANDIDATE"   # eligible, pending human review
    DO_NOT_RECOMMEND      = "DO_NOT_RECOMMEND"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    REJECTED              = "REJECTED"


class PromotionBoundaryError(RuntimeError):
    """
    Raised if any caller attempts to promote/deploy through the research factory.
    The research factory has no authority to promote (spec §41).
    """


@dataclass
class RecommendationDecision:
    """
    The factory's recommendation (spec §41, §52). It NEVER promotes — the strongest
    outcome is CHALLENGER_CANDIDATE with requires_human_review=True, promoted=False.
    """
    outcome:              RecommendationOutcome
    experiment_id:        str
    tier:                 ExperimentTier
    gates_all_pass:       bool
    requires_human_review: bool
    promoted:             bool                       # ALWAYS False (invariant)
    reasons:              list[str] = field(default_factory=list)
    failed_gates:         list[str] = field(default_factory=list)

    def __post_init__(self):
        # Invariant: the research factory never promotes (spec §41).
        if self.promoted:
            raise PromotionBoundaryError(
                "RecommendationDecision.promoted must be False — the research "
                "factory never promotes (spec §41).")

    def to_dict(self) -> dict:
        return {
            "outcome":               self.outcome.value,
            "experiment_id":         self.experiment_id,
            "tier":                  self.tier.value,
            "gates_all_pass":        self.gates_all_pass,
            "requires_human_review": self.requires_human_review,
            "promoted":              self.promoted,
            "reasons":               self.reasons,
            "failed_gates":          self.failed_gates,
        }


class ResearchFactory:
    """
    Research factory orchestrator (spec §41, §52, §56).

    `recommend()` is the ONLY decision surface. It reads a gate report and an earned
    tier and returns a RecommendationDecision. It has NO ability to promote, deploy,
    retrain, recalibrate, or trade — those live in the authoritative lifecycle /
    human-approval process.
    """

    def recommend(
        self,
        *,
        experiment_id: str,
        gate_report: GateReport,
        tier: ExperimentTier,
    ) -> RecommendationDecision:
        """
        Decide whether to RECOMMEND an experiment as a challenger candidate. Even
        when eligible, the decision requires human review and never promotes (§41,
        §52).
        """
        gates_pass = gate_report.all_pass
        failed = gate_report.failed_gates()

        if not gates_pass:
            return RecommendationDecision(
                outcome=RecommendationOutcome.DO_NOT_RECOMMEND,
                experiment_id=experiment_id, tier=tier, gates_all_pass=False,
                requires_human_review=False, promoted=False,
                reasons=["one or more research gates did not pass (spec §51)"],
                failed_gates=failed,
            )
        if not is_promotable(tier):
            return RecommendationDecision(
                outcome=RecommendationOutcome.DO_NOT_RECOMMEND,
                experiment_id=experiment_id, tier=tier, gates_all_pass=True,
                requires_human_review=False, promoted=False,
                reasons=[f"tier {tier.value} is not challenger-eligible; only Tier D "
                         f"may be recommended (spec §17, §41)"],
                failed_gates=[],
            )
        # All gates pass AND tier D -> eligible, but ALWAYS pending human review.
        return RecommendationDecision(
            outcome=RecommendationOutcome.CHALLENGER_CANDIDATE,
            experiment_id=experiment_id, tier=tier, gates_all_pass=True,
            requires_human_review=True, promoted=False,
            reasons=["all research gates passed and tier is D — eligible as a "
                     "CHALLENGER_CANDIDATE, subject to mandatory human review "
                     "(spec §41, §52). The research factory does not promote."],
            failed_gates=[],
        )

    # NOTE: there is intentionally no promote()/deploy()/retrain()/recalibrate()
    # method. Promotion is the authoritative lifecycle's responsibility (spec §41).


@dataclass
class IsolationGuard:
    """
    Experiment isolation guard (spec §56). Records the pre-experiment fingerprints
    of champion / challenger / paper-session / production-config / historical-
    evidence and verifies they are UNCHANGED after an experiment runs. A change
    means the experiment leaked out of its isolated research space.
    """
    champion_fingerprint:      str = ""
    challenger_fingerprint:    str = ""
    paper_session_fingerprint: str = ""
    production_config_fingerprint: str = ""
    historical_evidence_fingerprint: str = ""

    def verify_unchanged(self, after: "IsolationGuard") -> tuple[bool, list[str]]:
        """Return (ok, changed_domains). ok=True means nothing external mutated."""
        changed = []
        for field_name in ("champion_fingerprint", "challenger_fingerprint",
                           "paper_session_fingerprint", "production_config_fingerprint",
                           "historical_evidence_fingerprint"):
            if getattr(self, field_name) != getattr(after, field_name):
                changed.append(field_name.replace("_fingerprint", ""))
        return (len(changed) == 0), changed

    def to_dict(self) -> dict:
        return {
            "champion":            self.champion_fingerprint,
            "challenger":          self.challenger_fingerprint,
            "paper_session":       self.paper_session_fingerprint,
            "production_config":   self.production_config_fingerprint,
            "historical_evidence": self.historical_evidence_fingerprint,
        }
