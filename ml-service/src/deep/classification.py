"""
Phase 3K — Model value classification (spec §58, §75, §76, §77, §78, §79).

Classifies an advanced model against the classical baseline using a DOCUMENTED,
multi-criteria rule — never a single metric and never a subjective numeric score
(spec §58, §79). Also encodes the research hierarchy (spec §75): data integrity
and OOS validity dominate raw performance.

Classes (spec §58):
  SUPERIOR              — dominates the baseline across the hierarchy
  COMPLEMENTARY         — improves the ensemble though not a standalone champion
  REDUNDANT             — ~ same predictions/errors as the champion
  UNSTABLE              — good mean but fails seed/fold/regime stability
  WORSE                 — inferior to the baseline
  INSUFFICIENT_EVIDENCE — not enough valid OOS to judge

Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .schemas import ModelValueClass


@dataclass
class ClassificationInputs:
    """Structured evidence fed to the classifier. Any None => degrade toward INSUFFICIENT."""
    # OOS validity / data integrity (hierarchy top — spec §75)
    data_integrity_ok:      bool = False
    oos_valid:              bool = False
    n_oos_observations:     int = 0
    contaminated:           bool = False       # final-OOS contamination (spec §69)

    # Predictive
    champion_rank_ic:       Optional[float] = None
    challenger_rank_ic:     Optional[float] = None
    incremental_rank_ic:    Optional[float] = None
    prediction_correlation: Optional[float] = None

    # Ensemble
    ensemble_rank_ic:       Optional[float] = None

    # Stability (spec §51)
    seed_std:               Optional[float] = None
    seed_worst:             Optional[float] = None
    overfit_status:         str = ""           # OverfitStatus value

    # Economics (spec §75 lower priority than validity)
    net_return_positive:    Optional[bool] = None

    # thresholds (documented, configurable)
    min_oos:                int = 60
    min_incremental_ic:     float = 0.005
    near_identical_corr:    float = 0.99
    max_seed_std:           float = 0.05
    superiority_margin:     float = 0.01       # challenger IC must beat champion by this


@dataclass
class ModelValueDecision:
    value_class:  ModelValueClass
    reasons:      list[str] = field(default_factory=list)
    criteria:     dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "value_class": self.value_class.value,
            "reasons": self.reasons,
            "criteria": self.criteria,
        }


def classify_model_value(inp: ClassificationInputs) -> ModelValueDecision:
    """
    Apply the documented multi-criteria rule (spec §58). Order matters and
    follows the research hierarchy (spec §75): integrity/validity gate first.
    """
    reasons: list[str] = []
    crit: dict = {}

    # ── Hierarchy gate 1: data integrity + OOS validity (spec §75 #1, #2) ──
    if inp.contaminated:
        return ModelValueDecision(
            ModelValueClass.INSUFFICIENT_EVIDENCE,
            ["FINAL_OOS_CONTAMINATED — evidence cannot support a classification (spec §69)"],
            {"contaminated": True},
        )
    if not inp.data_integrity_ok or not inp.oos_valid:
        return ModelValueDecision(
            ModelValueClass.INSUFFICIENT_EVIDENCE,
            ["Data integrity or OOS validity not established (spec §75 #1/#2)"],
            {"data_integrity_ok": inp.data_integrity_ok, "oos_valid": inp.oos_valid},
        )
    if inp.n_oos_observations < inp.min_oos:
        return ModelValueDecision(
            ModelValueClass.INSUFFICIENT_EVIDENCE,
            [f"Only {inp.n_oos_observations} OOS obs (< {inp.min_oos})"],
            {"n_oos": inp.n_oos_observations},
        )
    if inp.challenger_rank_ic is None or inp.champion_rank_ic is None:
        return ModelValueDecision(
            ModelValueClass.INSUFFICIENT_EVIDENCE,
            ["Missing champion or challenger IC"],
            {},
        )

    ch_ic = inp.challenger_rank_ic
    cp_ic = inp.champion_rank_ic
    crit["champion_rank_ic"] = cp_ic
    crit["challenger_rank_ic"] = ch_ic
    crit["prediction_correlation"] = inp.prediction_correlation
    crit["incremental_rank_ic"] = inp.incremental_rank_ic
    crit["seed_std"] = inp.seed_std

    # ── Stability gate (spec §51, §58 UNSTABLE) ──
    unstable = False
    if inp.seed_std is not None and inp.seed_std > inp.max_seed_std:
        unstable = True
        reasons.append(f"seed_std {inp.seed_std:.3f} > {inp.max_seed_std} (UNSTABLE)")
    if inp.overfit_status == "LARGE_GAP":
        unstable = True
        reasons.append("LARGE train/val/OOS gap (UNSTABLE)")

    # ── WORSE: challenger clearly inferior ──
    if ch_ic < cp_ic - inp.superiority_margin:
        reasons.append(f"challenger IC {ch_ic:.4f} < champion {cp_ic:.4f} - margin")
        return ModelValueDecision(ModelValueClass.WORSE, reasons, crit)

    # ── REDUNDANT: near-identical predictions & no incremental value ──
    near = (inp.prediction_correlation is not None
            and inp.prediction_correlation > inp.near_identical_corr)
    weak_incr = (inp.incremental_rank_ic is None
                 or inp.incremental_rank_ic < inp.min_incremental_ic)
    if near and weak_incr:
        reasons.append("predictions near-identical to champion + no incremental IC")
        return ModelValueDecision(ModelValueClass.REDUNDANT, reasons, crit)

    # ── SUPERIOR: beats champion beyond margin AND stable AND (if known) net+ ──
    beats = ch_ic > cp_ic + inp.superiority_margin
    net_ok = inp.net_return_positive is not False   # None tolerated, False blocks
    if beats and not unstable and net_ok:
        reasons.append(f"challenger IC {ch_ic:.4f} beats champion {cp_ic:.4f} + stable")
        return ModelValueDecision(ModelValueClass.SUPERIOR, reasons, crit)

    # ── UNSTABLE: would be superior/complementary but fails stability ──
    if unstable and (beats or (inp.incremental_rank_ic or 0) >= inp.min_incremental_ic):
        return ModelValueDecision(ModelValueClass.UNSTABLE, reasons, crit)

    # ── COMPLEMENTARY: not standalone-superior, but improves the ensemble ──
    ens_improves = (inp.ensemble_rank_ic is not None
                    and inp.ensemble_rank_ic > cp_ic + inp.superiority_margin)
    has_incr = (inp.incremental_rank_ic is not None
                and inp.incremental_rank_ic >= inp.min_incremental_ic)
    if (ens_improves or has_incr) and not unstable:
        reasons.append("improves ensemble / positive incremental IC though not standalone champion")
        return ModelValueDecision(ModelValueClass.COMPLEMENTARY, reasons, crit)

    # ── default: not clearly better, not redundant, no incremental value ──
    reasons.append("no clear incremental value over champion")
    return ModelValueDecision(ModelValueClass.WORSE, reasons, crit)
