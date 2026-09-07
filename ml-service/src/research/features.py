"""
Phase 3S — Research feature registry, provenance & leakage guards (spec §12-§15).

Every research feature must be documented (spec §12) and traceable to raw/
normalized data (provenance, spec §13). Before an experiment is trusted, its
features are inspected for future dependencies (spec §14) and normalization
leakage (spec §15). Any detected future dependency => EXPERIMENT_INVALIDATED.

This REUSES the existing leakage probes (`src.deep.leakage_tests`) rather than
reimplementing them: `future_scaler_probe` (§15) and `future_label_probe` (§14).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional

import numpy as np


class FeatureCategory(str, Enum):
    PRICE        = "PRICE"
    VOLUME       = "VOLUME"
    VOLATILITY   = "VOLATILITY"
    MOMENTUM     = "MOMENTUM"
    MEAN_REVERT  = "MEAN_REVERT"
    CROSS_SECTIONAL = "CROSS_SECTIONAL"
    DERIVATIVES  = "DERIVATIVES"
    REGIME       = "REGIME"
    FUNDAMENTAL  = "FUNDAMENTAL"
    CONTROL      = "CONTROL"       # deliberate negative-control / noise feature (§33)


class FeatureError(ValueError):
    """Raised for undocumented / malformed research features (spec §12)."""


class LeakageInvalidation(RuntimeError):
    """
    Raised when a feature/experiment exhibits a future dependency — the experiment
    must be INVALIDATED (spec §14). This is a fail-closed, non-silent signal.
    """


# ══════════════════════════════════════════════════════════════════════════════
# §12 Feature registry / §13 provenance
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class FeatureProvenance:
    """Traceability of a feature back to raw/normalized data (spec §13)."""
    source_data:      str            # e.g. "adjusted_ohlcv"
    transformation:   str            # e.g. "20d rolling zscore of close"
    parameters:       tuple = ()
    availability_time: str = ""      # when the value is known (as-of timestamp rule)
    version:          str = "v1"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["parameters"] = list(self.parameters)
        return d


@dataclass(frozen=True)
class ResearchFeature:
    """
    A documented research feature (spec §12). No undocumented ad-hoc features are
    allowed into production research.
    """
    feature_id:       str
    name:             str
    category:         FeatureCategory
    formula:          str                    # formula or reference id
    availability_timestamp: str              # rule for when it is known (PIT)
    min_history:      int                    # bars of history required
    dependencies:     tuple[str, ...]        # upstream feature/data ids
    missing_behavior: str                    # e.g. "propagate_nan"
    provenance:       FeatureProvenance
    expected_direction: str = ""             # if known
    version:          str = "v1"

    def __post_init__(self):
        for name, val in (("feature_id", self.feature_id), ("name", self.name),
                          ("formula", self.formula),
                          ("availability_timestamp", self.availability_timestamp)):
            if not (val and str(val).strip()):
                raise FeatureError(f"feature missing required field '{name}' (spec §12).")
        if self.min_history < 0:
            raise FeatureError("min_history must be >= 0 (spec §12).")

    def to_dict(self) -> dict:
        d = asdict(self)
        d["category"] = self.category.value
        d["dependencies"] = list(self.dependencies)
        d["provenance"] = self.provenance.to_dict()
        return d


class ResearchFeatureRegistry:
    """
    In-memory registry of documented research features (spec §12). Distinct from
    the production `features.registry` — this tracks research-experiment features
    with full provenance. Duplicate feature_id is rejected (append-only intent).
    """

    def __init__(self):
        self._features: dict[str, ResearchFeature] = {}

    def register(self, feature: ResearchFeature) -> ResearchFeature:
        if feature.feature_id in self._features:
            raise FeatureError(
                f"feature_id '{feature.feature_id}' already registered (spec §12).")
        self._features[feature.feature_id] = feature
        return feature

    def get(self, feature_id: str) -> ResearchFeature:
        if feature_id not in self._features:
            raise FeatureError(f"unknown feature '{feature_id}' (spec §12).")
        return self._features[feature_id]

    def has(self, feature_id: str) -> bool:
        return feature_id in self._features

    def ids(self) -> list[str]:
        return sorted(self._features.keys())

    def is_documented(self, feature_id: str) -> bool:
        return feature_id in self._features


# ══════════════════════════════════════════════════════════════════════════════
# §14 Feature leakage guard + §15 normalization leakage
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class LeakageReport:
    """Result of the feature/normalization leakage audit (spec §14, §15)."""
    passed:           bool
    probes:           list[dict] = field(default_factory=list)  # ProbeResult.to_dict()
    violations:       list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"passed": self.passed, "probes": self.probes, "violations": self.violations}


def audit_feature_leakage(
    *,
    feature_times: Optional[np.ndarray] = None,
    label_event_start: Optional[np.ndarray] = None,
    scaler_fit_indices: Optional[np.ndarray] = None,
    oos_indices: Optional[np.ndarray] = None,
    raise_on_violation: bool = True,
) -> LeakageReport:
    """
    Audit for future dependencies (spec §14) and normalization leakage (spec §15)
    by REUSING the existing probes:
      - future_label_probe: every feature time must be <= its label entry time (§14)
      - future_scaler_probe: scaler must be fit only on non-OOS data (§15)

    Any violation => LeakageInvalidation (fail-closed, spec §14) unless
    `raise_on_violation=False` (used by test-the-tests to inspect the report).
    """
    from src.deep.leakage_tests import future_label_probe, future_scaler_probe

    probes: list[dict] = []
    violations: list[str] = []

    if feature_times is not None and label_event_start is not None:
        p = future_label_probe(np.asarray(feature_times), np.asarray(label_event_start))
        probes.append(p.to_dict())
        if not p.passed:
            violations.append(f"FUTURE_FEATURE: {p.detail}")

    if scaler_fit_indices is not None and oos_indices is not None:
        p = future_scaler_probe(np.asarray(scaler_fit_indices), np.asarray(oos_indices))
        probes.append(p.to_dict())
        if not p.passed:
            violations.append(f"NORMALIZATION_LEAKAGE: {p.detail}")

    passed = len(violations) == 0
    report = LeakageReport(passed=passed, probes=probes, violations=violations)
    if not passed and raise_on_violation:
        raise LeakageInvalidation(
            f"EXPERIMENT_INVALIDATED — feature leakage detected (spec §14/§15): "
            f"{'; '.join(violations)}")
    return report


def check_normalization_causal(
    train_indices: np.ndarray,
    eval_indices: np.ndarray,
    scaler_fit_indices: np.ndarray,
    *,
    raise_on_violation: bool = True,
) -> LeakageReport:
    """
    Explicit normalization-leakage check (spec §15): the scaler must be fit ONLY
    on training indices, never on evaluation/OOS indices, and never on the full
    dataset before the split.
    """
    fit = set(np.asarray(scaler_fit_indices).tolist())
    train = set(np.asarray(train_indices).tolist())
    eval_ = set(np.asarray(eval_indices).tolist())

    violations: list[str] = []
    leaked = fit & eval_
    if leaked:
        violations.append(
            f"NORMALIZATION_LEAKAGE: scaler fit on {len(leaked)} evaluation indices (spec §15)")
    outside_train = fit - train
    if outside_train:
        violations.append(
            f"NORMALIZATION_LEAKAGE: scaler fit on {len(outside_train)} indices outside "
            f"the training set (full-dataset normalization before split, spec §15)")

    passed = len(violations) == 0
    report = LeakageReport(passed=passed, probes=[], violations=violations)
    if not passed and raise_on_violation:
        raise LeakageInvalidation(
            f"EXPERIMENT_INVALIDATED — normalization leakage (spec §15): "
            f"{'; '.join(violations)}")
    return report
