"""
Phase 3S — Research leaderboard (spec §39).

The leaderboard must NOT rank experiments by return alone. Each row carries the
primary metric plus net return, Sharpe, drawdown, turnover, costs, IC/Rank IC,
calibration, statistical confidence, stability, capacity, evidence tier, sample
size, and multiple-testing status. Rows are grouped into EXPERIMENTAL / VALIDATED
/ CHALLENGER classes so an exploratory row is never confused with a validated one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class LeaderboardClass(str, Enum):
    EXPERIMENTAL = "EXPERIMENTAL"
    VALIDATED    = "VALIDATED"
    CHALLENGER   = "CHALLENGER"


# The columns a leaderboard row must expose (spec §39). Deliberately NOT just return.
LEADERBOARD_COLUMNS = (
    "experiment_id", "primary_metric_name", "primary_metric_value", "net_return",
    "sharpe", "max_drawdown", "turnover", "costs", "ic", "rank_ic", "calibration",
    "statistical_confidence", "stability", "capacity", "evidence_tier",
    "sample_size", "multiple_testing_status", "leaderboard_class",
)


@dataclass
class LeaderboardRow:
    experiment_id:          str
    primary_metric_name:    str
    primary_metric_value:   Optional[float]
    leaderboard_class:      LeaderboardClass
    net_return:             Optional[float] = None
    sharpe:                 Optional[float] = None
    max_drawdown:           Optional[float] = None
    turnover:               Optional[float] = None
    costs:                  Optional[float] = None
    ic:                     Optional[float] = None
    rank_ic:                Optional[float] = None
    calibration:            Optional[float] = None
    statistical_confidence: Optional[float] = None
    stability:              Optional[str] = None
    capacity:               Optional[float] = None
    evidence_tier:          Optional[str] = None
    sample_size:            int = 0
    multiple_testing_status: str = "NOT_CORRECTED"

    def to_dict(self) -> dict:
        return {
            "experiment_id":          self.experiment_id,
            "primary_metric_name":    self.primary_metric_name,
            "primary_metric_value":   self.primary_metric_value,
            "net_return":             self.net_return,
            "sharpe":                 self.sharpe,
            "max_drawdown":           self.max_drawdown,
            "turnover":               self.turnover,
            "costs":                  self.costs,
            "ic":                     self.ic,
            "rank_ic":                self.rank_ic,
            "calibration":            self.calibration,
            "statistical_confidence": self.statistical_confidence,
            "stability":              self.stability,
            "capacity":               self.capacity,
            "evidence_tier":          self.evidence_tier,
            "sample_size":            self.sample_size,
            "multiple_testing_status": self.multiple_testing_status,
            "leaderboard_class":      self.leaderboard_class.value,
        }


class Leaderboard:
    """
    A research leaderboard (spec §39). Rows are grouped by class; within a class
    they are ordered by the primary metric (NOT by return). The public view keeps
    EXPERIMENTAL / VALIDATED / CHALLENGER visibly separated.
    """

    def __init__(self):
        self._rows: list[LeaderboardRow] = []

    def add(self, row: LeaderboardRow) -> None:
        self._rows.append(row)

    def rows(self, cls: Optional[LeaderboardClass] = None) -> list[LeaderboardRow]:
        rows = [r for r in self._rows if cls is None or r.leaderboard_class == cls]
        # order by primary metric descending; None last
        return sorted(rows, key=lambda r: (r.primary_metric_value is None,
                                           -(r.primary_metric_value or 0.0)))

    def grouped(self) -> dict:
        """Return rows grouped by class (spec §39) — experimental never mixed with
        validated/challenger."""
        return {
            cls.value: [r.to_dict() for r in self.rows(cls)]
            for cls in LeaderboardClass
        }

    def to_dict(self) -> dict:
        return {"columns": list(LEADERBOARD_COLUMNS), "groups": self.grouped()}
