"""
Phase 3S — Baseline-first rule (spec §18).

Every experiment must define a baseline. A complex model that cannot beat an
appropriate baseline is NOT a discovery. This module enumerates the canonical
baselines and provides a direction-aware comparison that reuses the metric
registry so "beating the baseline" always respects whether higher or lower is
better.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class BaselineType(str, Enum):
    """Canonical baselines (spec §18)."""
    NAIVE_RETURN     = "NAIVE_RETURN"
    BUY_AND_HOLD     = "BUY_AND_HOLD"
    SECTOR_BENCHMARK = "SECTOR_BENCHMARK"
    MARKET_BENCHMARK = "MARKET_BENCHMARK"
    EXISTING_CHAMPION = "EXISTING_CHAMPION"
    SIMPLE_MOMENTUM  = "SIMPLE_MOMENTUM"
    SIMPLE_TREND     = "SIMPLE_TREND"
    LOGISTIC_REGRESSION = "LOGISTIC_REGRESSION"
    RIDGE            = "RIDGE"
    RANDOM_SIGNAL    = "RANDOM_SIGNAL"
    SHUFFLED_LABEL   = "SHUFFLED_LABEL"


ALL_BASELINES: tuple[BaselineType, ...] = tuple(BaselineType)


class BaselineError(ValueError):
    """Raised when a baseline is missing or invalid (spec §18)."""


@dataclass(frozen=True)
class BaselineResult:
    """A baseline's score on the primary metric."""
    baseline_type:  BaselineType
    metric_name:    str
    value:          float
    n_observations: int

    def to_dict(self) -> dict:
        d = {"baseline_type": self.baseline_type.value, "metric_name": self.metric_name,
             "value": self.value, "n_observations": self.n_observations}
        return d


@dataclass
class BaselineComparison:
    """Result of comparing a candidate against its baseline (spec §18)."""
    metric_name:      str
    candidate_value:  float
    baseline:         BaselineResult
    beats_baseline:   bool
    margin:           float             # candidate - baseline (signed, raw)

    def to_dict(self) -> dict:
        return {
            "metric_name":     self.metric_name,
            "candidate_value": self.candidate_value,
            "baseline":        self.baseline.to_dict(),
            "beats_baseline":  self.beats_baseline,
            "margin":          self.margin,
        }


def compare_to_baseline(
    *,
    metric_name: str,
    candidate_value: float,
    baseline: BaselineResult,
    metric_registry=None,
) -> BaselineComparison:
    """
    Direction-aware comparison of a candidate to its baseline (spec §18). Uses the
    canonical metric registry so "beats" respects the metric's direction.
    """
    from src.research.metrics import DEFAULT_METRIC_REGISTRY
    reg = metric_registry or DEFAULT_METRIC_REGISTRY
    if metric_name != baseline.metric_name:
        raise BaselineError(
            f"candidate metric '{metric_name}' != baseline metric "
            f"'{baseline.metric_name}' — comparison invalid (spec §18).")
    mdef = reg.get(metric_name)
    beats = mdef.is_improvement(candidate_value, baseline.value)
    return BaselineComparison(
        metric_name=metric_name,
        candidate_value=candidate_value,
        baseline=baseline,
        beats_baseline=beats,
        margin=candidate_value - baseline.value,
    )


def require_baseline(baselines: list[BaselineResult]) -> None:
    """
    Enforce the baseline-first rule (spec §18): an experiment must declare at least
    one baseline. Raises BaselineError otherwise.
    """
    if not baselines:
        raise BaselineError(
            "no baseline declared — every experiment must define a baseline "
            "(spec §18). A model with no baseline is not a discovery.")
