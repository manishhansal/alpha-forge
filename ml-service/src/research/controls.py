"""
Phase 3S — Placebo / negative controls, multi-seed, degrees-of-freedom, data-
snooping lineage & HPO governance (spec §32-§37, §45, §46).

REUSES the existing probes where possible:
  - placebo (§32): deep.leakage_tests.label_permutation_probe (shuffled labels)
  - negative control (§33): deep.leakage_tests.negative_control_probe +
    permutation_importance
  - HPO governance (§34): validates that HPO never touched the sealed OOS via
    deep.leakage_tests.final_oos_contamination_check.

Adds:
  - multi-seed evaluation (§45, §46): mean/median/std/worst/best + CI.
  - research degrees-of-freedom tracking (§37).
  - data-snooping lineage summary (§36) over the experiment registry.
  - HPO run record (§34): search space, n_trials, seeds, best config, selection
    metric — recorded so the registry preserves that HPO occurred.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np


# ══════════════════════════════════════════════════════════════════════════════
# §32 Placebo test
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PlaceboResult:
    passed:          bool          # True => real signal beats placebo (no leakage)
    detail:          str
    metrics:         dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"passed": self.passed, "detail": self.detail, "metrics": self.metrics}


def placebo_test(
    fit_predict_fn,
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_oos: np.ndarray,
    y_oos: np.ndarray,
    *,
    seed: int = 0,
    collapse_threshold: float = 0.10,
) -> PlaceboResult:
    """
    Placebo/shuffled-label control (spec §32). REUSES
    deep.leakage_tests.label_permutation_probe: shuffling TRAIN labels must
    collapse OOS skill. If it does not, suspect leakage and the intended signal
    does not outperform its placebo defensibly.
    """
    from src.deep.leakage_tests import label_permutation_probe
    probe = label_permutation_probe(fit_predict_fn, X_train, y_train, X_oos, y_oos,
                                    seed=seed, collapse_threshold=collapse_threshold)
    return PlaceboResult(passed=probe.passed, detail=probe.detail, metrics=probe.metrics)


# ══════════════════════════════════════════════════════════════════════════════
# §33 Negative control features
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class NegativeControlResult:
    passed:          bool          # True => noise feature not over-weighted
    detail:          str
    metrics:         dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"passed": self.passed, "detail": self.detail, "metrics": self.metrics}


def negative_control_test(
    importance_scores: dict,
    noise_feature_name: str,
    *,
    max_relative_importance: float = 0.30,
) -> NegativeControlResult:
    """
    Negative-control check (spec §33). REUSES
    deep.leakage_tests.negative_control_probe: a deliberately meaningless feature
    must NOT receive strong importance.
    """
    from src.deep.leakage_tests import negative_control_probe
    probe = negative_control_probe(importance_scores, noise_feature_name,
                                   max_relative_importance=max_relative_importance)
    return NegativeControlResult(passed=probe.passed, detail=probe.detail, metrics=probe.metrics)


# ══════════════════════════════════════════════════════════════════════════════
# §45, §46 Multi-seed evaluation
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class MultiSeedResult:
    n_seeds:         int
    mean:            float
    median:          float
    std:             float
    worst:           float
    best:            float
    ci_low:          Optional[float]
    ci_high:         Optional[float]
    per_seed:        dict = field(default_factory=dict)   # seed -> value

    @property
    def single_seed_dependent(self) -> bool:
        """
        True if the result exists essentially only under the best seed — a fragile
        result to treat cautiously (§46). Detected by removing the best seed and
        checking whether the remaining seeds are far below it: if the best is well
        separated from the mean of the OTHERS (so its own outlier value does not
        inflate the reference dispersion), the result is single-seed-dependent.
        """
        if self.n_seeds < 3:
            return False
        vals = np.asarray(list(self.per_seed.values()), dtype=float)
        best = float(vals.max())
        others = vals[vals < best] if np.any(vals < best) else vals
        if len(others) < 2:
            return False
        others_mean = float(others.mean())
        others_std = float(others.std(ddof=1)) if len(others) > 1 else 0.0
        spread = best - others_mean
        # Fragile if the best is a large multiple of the others' dispersion above
        # them, OR the others are near zero while the best is materially positive.
        if others_std > 0 and spread > 3.0 * others_std:
            return True
        if abs(others_mean) < 1e-3 and best > 0.05:
            return True
        return False

    def to_dict(self) -> dict:
        d = asdict(self)
        d["single_seed_dependent"] = self.single_seed_dependent
        return d


def multi_seed_evaluate(per_seed_values: dict, *, ci_level: float = 0.95) -> MultiSeedResult:
    """
    Aggregate a metric over multiple seeds (spec §45, §46). Reports mean / median /
    std / worst / best and a normal-approx CI on the mean. A result that exists
    only under one lucky seed is flagged via `single_seed_dependent`.
    """
    if not per_seed_values:
        return MultiSeedResult(0, 0.0, 0.0, 0.0, 0.0, 0.0, None, None, {})
    vals = np.asarray(list(per_seed_values.values()), dtype=float)
    n = len(vals)
    mean = float(vals.mean())
    median = float(np.median(vals))
    std = float(vals.std(ddof=1)) if n > 1 else 0.0
    worst = float(vals.min())
    best = float(vals.max())
    ci_low = ci_high = None
    if n > 1 and std > 0:
        from src.research.statistics import _norm_ppf
        z = _norm_ppf(1.0 - (1.0 - ci_level) / 2.0)
        se = std / math.sqrt(n)
        ci_low, ci_high = mean - z * se, mean + z * se
    return MultiSeedResult(
        n_seeds=n, mean=mean, median=median, std=std, worst=worst, best=best,
        ci_low=ci_low, ci_high=ci_high,
        per_seed={str(k): float(v) for k, v in per_seed_values.items()},
    )


# ══════════════════════════════════════════════════════════════════════════════
# §37 Research degrees of freedom
# ══════════════════════════════════════════════════════════════════════════════

# The researcher choices that create hidden degrees of freedom (spec §37).
DEGREES_OF_FREEDOM = (
    "universe", "timeframe", "horizon", "features", "model", "threshold",
    "transaction_cost", "stop_target", "portfolio_construction",
    "rebalance_frequency", "benchmark", "evaluation_window",
)


@dataclass
class DegreesOfFreedomReport:
    """
    Exposes the researcher choices for one experiment (spec §37). Research reports
    must surface these so hidden multiplicity is visible.
    """
    choices:         dict = field(default_factory=dict)

    @property
    def n_documented(self) -> int:
        return sum(1 for k in DEGREES_OF_FREEDOM if self.choices.get(k) not in (None, ""))

    @property
    def undocumented(self) -> list[str]:
        return [k for k in DEGREES_OF_FREEDOM if self.choices.get(k) in (None, "")]

    def to_dict(self) -> dict:
        return {
            "choices":       {k: self.choices.get(k) for k in DEGREES_OF_FREEDOM},
            "n_documented":  self.n_documented,
            "undocumented":  self.undocumented,
            "total_dimensions": len(DEGREES_OF_FREEDOM),
        }


# ══════════════════════════════════════════════════════════════════════════════
# §36 Data-snooping lineage
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class DataSnoopingReport:
    """
    Lineage/reuse summary for data-snooping control (spec §36). Counts how many
    PRIOR experiments reused the same dataset / OOS window / features / target, so
    the effective number of trials for multiple-testing is not undercounted.
    """
    experiment_id:       str
    parent_chain:        list[str]
    prior_experiment_count: int
    reused_dataset:      int
    reused_oos_window:   int
    reused_features:     int
    reused_target:       int

    def to_dict(self) -> dict:
        return asdict(self)


def data_snooping_report(registry, experiment_id: str) -> DataSnoopingReport:
    """
    Build a data-snooping report from the ResearchExperimentRegistry (spec §36).
    Counts prior REGISTER events that reused the same dataset_hash / universe /
    feature_version / label_version as the target experiment.
    """
    reg_events = [r for r in registry.all() if r.get("event") == "REGISTER"]
    target = next((r for r in reg_events if r.get("experiment_id") == experiment_id), None)
    parent_chain = registry.lineage(experiment_id)
    if target is None:
        return DataSnoopingReport(experiment_id, parent_chain, 0, 0, 0, 0, 0)

    def _count(field_name: str) -> int:
        tv = target.get(field_name)
        if tv in (None, ""):
            return 0
        return sum(1 for r in reg_events
                   if r.get("experiment_id") != experiment_id and r.get(field_name) == tv)

    prior = sum(1 for r in reg_events if r.get("experiment_id") != experiment_id)
    return DataSnoopingReport(
        experiment_id=experiment_id,
        parent_chain=parent_chain,
        prior_experiment_count=prior,
        reused_dataset=_count("dataset_hash"),
        reused_oos_window=_count("universe_id"),
        reused_features=_count("feature_version"),
        reused_target=_count("label_version"),
    )


# ══════════════════════════════════════════════════════════════════════════════
# §34 HPO governance
# ══════════════════════════════════════════════════════════════════════════════

class HPOGovernanceError(RuntimeError):
    """Raised when an HPO run touched the sealed final OOS (spec §34)."""


@dataclass
class HPORunRecord:
    """
    A recorded HPO run (spec §34). The registry must preserve that HPO occurred:
    search space, number of trials, seeds, best configuration, selection metric,
    and the validation result. The OOS must never have been touched.
    """
    search_space:    dict
    n_trials:        int
    seeds:           list[int]
    best_config:     dict
    selection_metric: str
    validation_score: float
    touched_oos:     bool = False

    def validate(self) -> "HPORunRecord":
        """Fail-closed: an HPO run that touched the final OOS is invalid (§34)."""
        from src.deep.leakage_tests import final_oos_contamination_check
        check = final_oos_contamination_check(oos_used_for_hpo=self.touched_oos)
        if check.contaminated:
            raise HPOGovernanceError(
                "HPO touched the sealed final OOS — forbidden (spec §34). The OOS "
                "must remain untouched by hyperparameter search.")
        return self

    def to_dict(self) -> dict:
        return asdict(self)
