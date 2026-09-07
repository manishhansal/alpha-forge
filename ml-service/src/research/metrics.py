"""
Phase 3S — Metric registry & primary-metric governance (spec §8, §9).

A canonical registry of research metrics. Each metric carries a definition,
direction (higher/lower is better), minimum sample requirement, uncertainty
method, and the experiment types it applies to. This avoids duplicated metric
implementations across the codebase (spec §9) and makes the choice of primary
metric explicit and auditable (spec §8).

Every experiment must define EXACTLY ONE primary metric (spec §8). A secondary
metric cannot silently replace it after results are seen — that requires a NEW
experiment specification.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional


class MetricDirection(str, Enum):
    """Whether higher or lower values of a metric are better."""
    HIGHER_IS_BETTER = "HIGHER_IS_BETTER"
    LOWER_IS_BETTER  = "LOWER_IS_BETTER"


class UncertaintyMethod(str, Enum):
    BOOTSTRAP        = "BOOTSTRAP"
    BLOCK_BOOTSTRAP  = "BLOCK_BOOTSTRAP"
    ANALYTIC         = "ANALYTIC"
    NONE             = "NONE"


class MetricError(ValueError):
    """Raised for unknown metrics or invalid primary-metric selection."""


@dataclass(frozen=True)
class MetricDefinition:
    """
    Canonical definition of one research metric (spec §9).
    """
    name:                   str
    definition:             str
    formula:                str
    inputs:                 tuple[str, ...]
    aggregation:            str
    direction:              MetricDirection
    min_sample:             int
    uncertainty_method:     UncertaintyMethod
    applicable_types:       tuple[str, ...]   # HypothesisType values, or ("*",) for all

    def applies_to(self, experiment_type: str) -> bool:
        return "*" in self.applicable_types or experiment_type in self.applicable_types

    def is_improvement(self, new: float, baseline: float) -> bool:
        """Direction-aware improvement check."""
        if self.direction == MetricDirection.HIGHER_IS_BETTER:
            return new > baseline
        return new < baseline

    def to_dict(self) -> dict:
        d = asdict(self)
        d["direction"] = self.direction.value
        d["uncertainty_method"] = self.uncertainty_method.value
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Canonical metric registry (spec §9)
# ══════════════════════════════════════════════════════════════════════════════

def _def(**kw) -> MetricDefinition:
    return MetricDefinition(**kw)


_METRICS: dict[str, MetricDefinition] = {
    "rank_ic": _def(
        name="rank_ic",
        definition="Spearman rank correlation between alpha scores and realized returns within each cross-section",
        formula="mean_t( spearman(score_t, realized_t) )",
        inputs=("scores", "realized"),
        aggregation="mean over timestamps",
        direction=MetricDirection.HIGHER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BLOCK_BOOTSTRAP,
        applicable_types=("RANKING", "ALPHA", "FEATURE"),
    ),
    "ic": _def(
        name="ic",
        definition="Pearson information coefficient between scores and realized returns per cross-section",
        formula="mean_t( pearson(score_t, realized_t) )",
        inputs=("scores", "realized"),
        aggregation="mean over timestamps",
        direction=MetricDirection.HIGHER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BLOCK_BOOTSTRAP,
        applicable_types=("RANKING", "ALPHA", "FEATURE"),
    ),
    "icir": _def(
        name="icir",
        definition="Information coefficient information ratio: mean(IC)/std(IC)",
        formula="mean(IC_series) / std(IC_series)",
        inputs=("ic_series",),
        aggregation="ratio",
        direction=MetricDirection.HIGHER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BOOTSTRAP,
        applicable_types=("RANKING", "ALPHA"),
    ),
    "brier": _def(
        name="brier",
        definition="Mean squared error between predicted probability and binary outcome",
        formula="mean( (p - y)^2 )",
        inputs=("prob", "outcome"),
        aggregation="mean",
        direction=MetricDirection.LOWER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BOOTSTRAP,
        applicable_types=("CALIBRATION", "MODEL"),
    ),
    "ece": _def(
        name="ece",
        definition="Expected calibration error (binned reliability gap)",
        formula="sum_b (n_b/N) * |acc_b - conf_b|",
        inputs=("prob", "outcome"),
        aggregation="weighted mean over bins",
        direction=MetricDirection.LOWER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BOOTSTRAP,
        applicable_types=("CALIBRATION",),
    ),
    "net_expected_value": _def(
        name="net_expected_value",
        definition="Expected value per decision net of transaction costs and slippage",
        formula="mean( gross_ev - costs - slippage )",
        inputs=("gross_ev", "costs", "slippage"),
        aggregation="mean",
        direction=MetricDirection.HIGHER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BLOCK_BOOTSTRAP,
        applicable_types=("ALPHA", "MODEL", "COST"),
    ),
    "net_risk_adjusted_return": _def(
        name="net_risk_adjusted_return",
        definition="Sharpe of net (post-cost) returns",
        formula="mean(net_r)/std(net_r) * sqrt(252)",
        inputs=("net_returns",),
        aggregation="ratio",
        direction=MetricDirection.HIGHER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BLOCK_BOOTSTRAP,
        applicable_types=("ALPHA", "PORTFOLIO", "MODEL"),
    ),
    "implementation_shortfall": _def(
        name="implementation_shortfall",
        definition="Difference between decision price and realized execution price incl. costs",
        formula="mean( decision_price - execution_price ) / decision_price",
        inputs=("decision_price", "execution_price"),
        aggregation="mean",
        direction=MetricDirection.LOWER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BOOTSTRAP,
        applicable_types=("EXECUTION", "SLIPPAGE"),
    ),
    "max_drawdown": _def(
        name="max_drawdown",
        definition="Largest peak-to-trough decline of the equity curve",
        formula="min_t( equity_t - running_max(equity)_t )",
        inputs=("returns",),
        aggregation="min",
        direction=MetricDirection.HIGHER_IS_BETTER,   # less negative is better
        min_sample=30,
        uncertainty_method=UncertaintyMethod.BLOCK_BOOTSTRAP,
        applicable_types=("PORTFOLIO", "RISK"),
    ),
    "turnover": _def(
        name="turnover",
        definition="Average fraction of the portfolio traded per rebalance",
        formula="mean_t( sum_i |w_{i,t} - w_{i,t-1}| / 2 )",
        inputs=("weights",),
        aggregation="mean",
        direction=MetricDirection.LOWER_IS_BETTER,
        min_sample=30,
        uncertainty_method=UncertaintyMethod.NONE,
        applicable_types=("PORTFOLIO", "COST"),
    ),
}


class MetricRegistry:
    """
    Canonical, read-only registry of research metrics (spec §9). A single source
    of truth for metric definitions/directions/sample requirements.
    """

    def __init__(self, metrics: Optional[dict[str, MetricDefinition]] = None):
        self._metrics = dict(metrics) if metrics is not None else dict(_METRICS)

    def get(self, name: str) -> MetricDefinition:
        if name not in self._metrics:
            raise MetricError(
                f"unknown metric '{name}' — register it in the canonical metric "
                f"registry before use (spec §9).")
        return self._metrics[name]

    def has(self, name: str) -> bool:
        return name in self._metrics

    def names(self) -> list[str]:
        return sorted(self._metrics.keys())

    def for_type(self, experiment_type: str) -> list[str]:
        return sorted(n for n, m in self._metrics.items() if m.applies_to(experiment_type))

    def validate_primary(self, metric_name: str, experiment_type: str) -> MetricDefinition:
        """
        Validate a primary-metric choice (spec §8): the metric must exist and be
        applicable to the experiment type. Returns its definition.
        """
        m = self.get(metric_name)
        if not m.applies_to(experiment_type):
            raise MetricError(
                f"metric '{metric_name}' is not applicable to experiment type "
                f"'{experiment_type}' (spec §8).")
        return m

    def to_dict(self) -> dict:
        return {n: m.to_dict() for n, m in sorted(self._metrics.items())}


# Module-level default registry
DEFAULT_METRIC_REGISTRY = MetricRegistry()
