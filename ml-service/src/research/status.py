"""
Phase 3S — Research status & failure taxonomy (spec §40, §50).

Explicit research states (spec §40). Note there is NO standalone `SUCCESS` state:
"success" is not a scientific status. An experiment is EXPLORATORY, RESEARCH_
VALIDATED, OOS_VALIDATED, PAPER_VALIDATED, a CHALLENGER_CANDIDATE, or one of the
negative outcomes (REJECTED / INVALIDATED / INSUFFICIENT_EVIDENCE).

A standardized failure taxonomy (spec §50) makes rejection reasons explicit and
comparable — failed experiments are preserved, not deleted (spec §49).
"""

from __future__ import annotations

from enum import Enum


class ResearchStatus(str, Enum):
    """Explicit research states (spec §40). No standalone SUCCESS."""
    HYPOTHESIS            = "HYPOTHESIS"
    EXPLORATORY           = "EXPLORATORY"
    RESEARCH_VALIDATED    = "RESEARCH_VALIDATED"
    OOS_VALIDATED         = "OOS_VALIDATED"
    PAPER_VALIDATED       = "PAPER_VALIDATED"
    CHALLENGER_CANDIDATE  = "CHALLENGER_CANDIDATE"
    REJECTED              = "REJECTED"
    INVALIDATED           = "INVALIDATED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


# Positive research states in increasing strength (for leaderboard grouping).
_STATUS_RANK = {
    ResearchStatus.HYPOTHESIS: 0,
    ResearchStatus.EXPLORATORY: 1,
    ResearchStatus.RESEARCH_VALIDATED: 2,
    ResearchStatus.OOS_VALIDATED: 3,
    ResearchStatus.PAPER_VALIDATED: 4,
    ResearchStatus.CHALLENGER_CANDIDATE: 5,
}

NEGATIVE_STATES = frozenset({
    ResearchStatus.REJECTED,
    ResearchStatus.INVALIDATED,
    ResearchStatus.INSUFFICIENT_EVIDENCE,
})


def status_rank(s: ResearchStatus) -> int:
    """Rank of a positive status; negative states rank -1."""
    return _STATUS_RANK.get(s, -1)


class FailureReason(str, Enum):
    """Standardized research failure taxonomy (spec §50)."""
    DATA_LEAKAGE              = "DATA_LEAKAGE"
    LABEL_LEAKAGE             = "LABEL_LEAKAGE"
    SURVIVORSHIP_BIAS         = "SURVIVORSHIP_BIAS"
    PIT_FAILURE               = "PIT_FAILURE"
    OOS_FAILURE               = "OOS_FAILURE"
    NO_INCREMENTAL_ALPHA      = "NO_INCREMENTAL_ALPHA"
    COST_EROSION              = "COST_EROSION"
    INSTABILITY               = "INSTABILITY"
    OVERFITTING               = "OVERFITTING"
    MULTIPLE_TESTING_FAILURE  = "MULTIPLE_TESTING_FAILURE"
    INSUFFICIENT_SAMPLE       = "INSUFFICIENT_SAMPLE"
    CALIBRATION_FAILURE       = "CALIBRATION_FAILURE"
    CAPACITY_FAILURE          = "CAPACITY_FAILURE"
    EXECUTION_FAILURE         = "EXECUTION_FAILURE"
    REPRODUCTION_FAILURE      = "REPRODUCTION_FAILURE"
    STATISTICAL_FAILURE       = "STATISTICAL_FAILURE"
    OPERATIONAL_FAILURE       = "OPERATIONAL_FAILURE"


FAILURE_REASONS: tuple[FailureReason, ...] = tuple(FailureReason)
