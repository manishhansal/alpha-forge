"""
Phase 3S — Experiment tiers (spec §17).

Tiers classify how strong an experiment's evidence is and whether it can be
promoted:

    Tier A — Exploratory:        fast research, weak evidence, CANNOT be promoted.
    Tier B — Controlled Research: PIT-safe, walk-forward, cost-aware, stat-evaluated.
    Tier C — Validation Candidate: independent OOS, robustness, multiple-testing adj,
                                   economic rationale.
    Tier D — Challenger Candidate: full evidence package, independent validation,
                                   paper/shadow compatible, REQUIRES HUMAN APPROVAL,
                                   no automatic promotion.

A tier is *earned* from the evidence present; it is never asserted. Only Tier D
may be recommended as a challenger candidate — and even then only after human
review (spec §41, §52).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ExperimentTier(str, Enum):
    TIER_A = "TIER_A"   # exploratory
    TIER_B = "TIER_B"   # controlled research
    TIER_C = "TIER_C"   # validation candidate
    TIER_D = "TIER_D"   # challenger candidate


_TIER_ORDER = {ExperimentTier.TIER_A: 0, ExperimentTier.TIER_B: 1,
               ExperimentTier.TIER_C: 2, ExperimentTier.TIER_D: 3}


def tier_rank(t: ExperimentTier) -> int:
    return _TIER_ORDER[t]


# Only Tier D is promotable — and only via human review (§17, §41).
PROMOTABLE_TIER = ExperimentTier.TIER_D


@dataclass
class TierEvidence:
    """
    The evidence signals that determine which tier an experiment has EARNED.
    All default False so that missing evidence never inflates the tier.
    """
    pit_safe:                 bool = False
    walk_forward:             bool = False
    cost_aware:               bool = False
    statistically_evaluated:  bool = False
    independent_oos:          bool = False
    robustness_tested:        bool = False
    multiple_testing_adjusted: bool = False
    economic_rationale:       bool = False
    full_evidence_package:    bool = False
    independent_validation:   bool = False
    paper_shadow_compatible:  bool = False

    def to_dict(self) -> dict:
        return {
            "pit_safe": self.pit_safe, "walk_forward": self.walk_forward,
            "cost_aware": self.cost_aware,
            "statistically_evaluated": self.statistically_evaluated,
            "independent_oos": self.independent_oos,
            "robustness_tested": self.robustness_tested,
            "multiple_testing_adjusted": self.multiple_testing_adjusted,
            "economic_rationale": self.economic_rationale,
            "full_evidence_package": self.full_evidence_package,
            "independent_validation": self.independent_validation,
            "paper_shadow_compatible": self.paper_shadow_compatible,
        }


def classify_tier(ev: TierEvidence) -> ExperimentTier:
    """
    Classify the earned tier (spec §17). Requirements are cumulative — a higher
    tier requires everything a lower tier requires. Missing evidence caps the tier.
    """
    tier_b_ok = ev.pit_safe and ev.walk_forward and ev.cost_aware and ev.statistically_evaluated
    tier_c_ok = tier_b_ok and ev.independent_oos and ev.robustness_tested \
        and ev.multiple_testing_adjusted and ev.economic_rationale
    tier_d_ok = tier_c_ok and ev.full_evidence_package and ev.independent_validation \
        and ev.paper_shadow_compatible

    if tier_d_ok:
        return ExperimentTier.TIER_D
    if tier_c_ok:
        return ExperimentTier.TIER_C
    if tier_b_ok:
        return ExperimentTier.TIER_B
    return ExperimentTier.TIER_A


def is_promotable(tier: ExperimentTier) -> bool:
    """Only Tier D may be recommended as a challenger candidate (spec §17, §41)."""
    return tier == PROMOTABLE_TIER
