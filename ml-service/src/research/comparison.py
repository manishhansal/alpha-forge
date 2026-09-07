"""
Phase 3S — Experiment comparison (apples-to-apples) & leaderboard (spec §38, §39).

Comparisons must be apples-to-apples: same universe, period, labels, cost model,
execution assumptions, benchmark, and compatible risk assumptions (spec §38). If
incompatible, the comparison is COMPARISON_INVALID and must NOT produce a
misleading leaderboard.

The leaderboard (spec §39) must NOT rank by return alone. It surfaces the primary
metric, net return, Sharpe, drawdown, turnover, costs, IC/Rank IC, calibration,
statistical confidence, stability, capacity, evidence tier, sample size, and
multiple-testing status, and visibly separates EXPERIMENTAL / VALIDATED /
CHALLENGER rows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class ComparabilityStatus(str, Enum):
    COMPARABLE        = "COMPARABLE"
    COMPARISON_INVALID = "COMPARISON_INVALID"


# The dimensions that must match for an apples-to-apples comparison (spec §38).
COMPARISON_KEYS = (
    "universe_id", "period", "label_version", "cost_config_hash",
    "execution_config_hash", "benchmark",
)


@dataclass
class ComparisonResult:
    status:          ComparabilityStatus
    mismatched_keys: list[str] = field(default_factory=list)
    detail:          str = ""

    @property
    def is_valid(self) -> bool:
        return self.status == ComparabilityStatus.COMPARABLE

    def to_dict(self) -> dict:
        return {"status": self.status.value, "mismatched_keys": self.mismatched_keys,
                "detail": self.detail}


def check_comparable(exp_a: dict, exp_b: dict) -> ComparisonResult:
    """
    Verify two experiments are comparable (spec §38). Both dicts must carry the
    COMPARISON_KEYS; any mismatch yields COMPARISON_INVALID. This prevents
    misleading leaderboards that compare experiments run on different universes /
    periods / cost models.
    """
    mismatched = []
    for key in COMPARISON_KEYS:
        if exp_a.get(key) != exp_b.get(key):
            mismatched.append(key)
    if mismatched:
        return ComparisonResult(
            ComparabilityStatus.COMPARISON_INVALID, mismatched,
            f"experiments differ on {mismatched} — not apples-to-apples (spec §38).")
    return ComparisonResult(ComparabilityStatus.COMPARABLE, [], "comparable")
