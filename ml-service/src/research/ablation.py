"""
Phase 3S — Ablation framework (spec §19).

To establish incremental contribution, each experiment reports the full model, an
appropriate baseline, and the effect of removing individual components:
feature / feature-family / model-component / signal-family / regime / execution /
cost ablations. The ablation reports the DELTA on the primary metric when a
component is removed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class AblationKind(str, Enum):
    FEATURE          = "FEATURE"
    FEATURE_FAMILY   = "FEATURE_FAMILY"
    MODEL_COMPONENT  = "MODEL_COMPONENT"
    SIGNAL_FAMILY    = "SIGNAL_FAMILY"
    REGIME           = "REGIME"
    EXECUTION        = "EXECUTION"
    COST             = "COST"


@dataclass(frozen=True)
class AblationCase:
    """One ablation: remove `component` and measure the primary metric (spec §19)."""
    kind:            AblationKind
    component:       str            # what was removed
    metric_name:     str
    metric_value:    float          # metric of the ablated model

    def to_dict(self) -> dict:
        d = {"kind": self.kind.value, "component": self.component,
             "metric_name": self.metric_name, "metric_value": self.metric_value}
        return d


@dataclass
class AblationContribution:
    """Contribution of a component = full-model metric - ablated metric (spec §19)."""
    kind:            AblationKind
    component:       str
    metric_name:    str
    full_value:      float
    ablated_value:   float
    contribution:    float          # direction-aware (positive => component helps)

    def to_dict(self) -> dict:
        return {
            "kind":          self.kind.value,
            "component":     self.component,
            "metric_name":   self.metric_name,
            "full_value":    self.full_value,
            "ablated_value": self.ablated_value,
            "contribution":  self.contribution,
        }


@dataclass
class AblationReport:
    """Full-model vs baseline vs component ablations (spec §19)."""
    metric_name:     str
    full_model_value: float
    baseline_value:  float
    contributions:   list[AblationContribution] = field(default_factory=list)

    @property
    def full_vs_baseline(self) -> float:
        return self.full_model_value - self.baseline_value

    def to_dict(self) -> dict:
        return {
            "metric_name":      self.metric_name,
            "full_model_value": self.full_model_value,
            "baseline_value":   self.baseline_value,
            "full_vs_baseline": self.full_vs_baseline,
            "contributions":    [c.to_dict() for c in self.contributions],
        }


def build_ablation_report(
    *,
    metric_name: str,
    full_model_value: float,
    baseline_value: float,
    ablation_cases: list[AblationCase],
    metric_registry=None,
) -> AblationReport:
    """
    Compute per-component contribution (spec §19). Contribution is direction-aware:
    for a higher-is-better metric it is (full - ablated); for lower-is-better it is
    (ablated - full), so a positive contribution always means "the component helps".
    """
    from src.research.metrics import DEFAULT_METRIC_REGISTRY, MetricDirection
    reg = metric_registry or DEFAULT_METRIC_REGISTRY
    mdef = reg.get(metric_name)

    contribs: list[AblationContribution] = []
    for case in ablation_cases:
        if case.metric_name != metric_name:
            continue
        if mdef.direction == MetricDirection.HIGHER_IS_BETTER:
            contribution = full_model_value - case.metric_value
        else:
            contribution = case.metric_value - full_model_value
        contribs.append(AblationContribution(
            kind=case.kind, component=case.component, metric_name=metric_name,
            full_value=full_model_value, ablated_value=case.metric_value,
            contribution=contribution,
        ))
    return AblationReport(metric_name=metric_name, full_model_value=full_model_value,
                          baseline_value=baseline_value, contributions=contribs)
