"""
Phase 3S — Validation engine with an untouched final OOS (spec §16).

Research experiments must support chronological / walk-forward / purged / embargo
/ nested (for HPO) validation, and the FINAL OOS block must remain inaccessible to
HPO, feature selection, threshold tuning, model selection, and experiment
iteration (spec §16).

This REUSES the existing `validation.walk_forward.WalkForwardValidator` for the
train/val/test folds and enforces OOS discipline via a research-facing split that
carves off a final, sealed OOS segment. The sealed OOS is only ever revealed via
`reveal_final_oos()` which RECORDS the reveal — any use for selection is flagged
through `deep.leakage_tests.final_oos_contamination_check`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


class ValidationScheme(str, Enum):
    CHRONOLOGICAL = "CHRONOLOGICAL"
    WALK_FORWARD  = "WALK_FORWARD"
    PURGED        = "PURGED"
    EMBARGO       = "EMBARGO"
    NESTED        = "NESTED"       # nested CV for HPO


class OOSAccessError(RuntimeError):
    """
    Raised when the sealed final OOS is used for a forbidden purpose (HPO, feature
    selection, threshold/model selection, iteration) — spec §16, §64.
    """


@dataclass(frozen=True)
class ResearchSplit:
    """
    A research split that separates the SEARCH region (train+val, usable for HPO /
    feature / model selection) from a SEALED final OOS region (spec §16).

    The search region is where all iteration happens; the OOS region is revealed
    exactly once, at final evaluation. Indices are integer positional.
    """
    train_idx:   tuple[int, ...]
    val_idx:     tuple[int, ...]
    oos_idx:     tuple[int, ...]
    scheme:      ValidationScheme

    def search_indices(self) -> np.ndarray:
        """Train + validation only — the ONLY indices HPO/selection may touch (§16)."""
        return np.array(sorted(set(self.train_idx) | set(self.val_idx)), dtype=int)

    def oos_indices(self) -> np.ndarray:
        return np.array(sorted(self.oos_idx), dtype=int)

    def is_sealed(self) -> bool:
        """OOS is sealed iff it does not overlap the search region (§16)."""
        return len(set(self.oos_idx) & (set(self.train_idx) | set(self.val_idx))) == 0

    def to_dict(self) -> dict:
        return {
            "scheme":    self.scheme.value,
            "n_train":   len(self.train_idx),
            "n_val":     len(self.val_idx),
            "n_oos":     len(self.oos_idx),
            "sealed":    self.is_sealed(),
        }


def build_research_split(
    n_periods: int,
    *,
    oos_fraction: float = 0.2,
    val_fraction: float = 0.2,
    scheme: ValidationScheme = ValidationScheme.CHRONOLOGICAL,
) -> ResearchSplit:
    """
    Carve a chronological train/val/OOS split. The final `oos_fraction` of the
    series is SEALED as OOS; the remainder is split chronologically into train and
    val. All splits are strictly time-ordered (no shuffling) — spec §16.
    """
    if n_periods < 5:
        raise ValueError("n_periods too small for a research split (need >= 5).")
    if not (0 < oos_fraction < 1) or not (0 <= val_fraction < 1):
        raise ValueError("fractions must be in (0,1) / [0,1).")
    n_oos = max(1, int(round(n_periods * oos_fraction)))
    n_search = n_periods - n_oos
    n_val = max(1, int(round(n_search * val_fraction)))
    n_train = n_search - n_val
    if n_train < 1:
        raise ValueError("not enough periods for a non-empty training set.")
    train_idx = tuple(range(0, n_train))
    val_idx = tuple(range(n_train, n_search))
    oos_idx = tuple(range(n_search, n_periods))
    return ResearchSplit(train_idx=train_idx, val_idx=val_idx, oos_idx=oos_idx, scheme=scheme)


def walk_forward_folds(n_periods: int, *, train_bars: int, val_bars: int,
                       test_bars: int, expanding: bool = False):
    """
    Thin wrapper over the existing WalkForwardValidator (spec §16). Returns the
    list of WalkForwardFold objects; the LAST fold's test window can be treated as
    the untouched OOS for the walk-forward scheme.
    """
    from src.validation.walk_forward import WalkForwardConfig, WalkForwardValidator
    cfg = WalkForwardConfig(train_bars=train_bars, val_bars=val_bars,
                            test_bars=test_bars, expanding=expanding)
    return WalkForwardValidator(cfg).split(n_periods)


class SealedOOS:
    """
    A one-shot sealed OOS handle (spec §16). The OOS data is only accessible via
    `reveal(purpose="final_evaluation")`. Revealing for any selection purpose
    records the contamination and raises OOSAccessError.

    This makes the OOS *procedurally* inaccessible to HPO/selection/iteration:
    code that tries to peek at OOS for tuning must declare a forbidden purpose and
    is refused.
    """

    _ALLOWED_PURPOSE = "final_evaluation"
    _FORBIDDEN = {
        "hpo", "feature_selection", "model_selection", "threshold",
        "architecture", "seed", "checkpoint", "ensemble_weight", "iteration",
        "promotion",
    }

    def __init__(self, oos_indices: np.ndarray):
        self._oos = np.array(sorted(set(np.asarray(oos_indices).tolist())), dtype=int)
        self._revealed_for: list[str] = []

    @property
    def revealed_for(self) -> list[str]:
        return list(self._revealed_for)

    def reveal(self, purpose: str) -> np.ndarray:
        """Reveal the OOS indices for a declared purpose. Only final evaluation is
        allowed; any selection/tuning purpose is refused and recorded (§16)."""
        purpose = str(purpose).strip().lower()
        self._revealed_for.append(purpose)
        if purpose in self._FORBIDDEN:
            raise OOSAccessError(
                f"final OOS accessed for forbidden purpose '{purpose}' — the OOS "
                f"must remain inaccessible to HPO/feature/model/threshold selection "
                f"and iteration (spec §16, §64).")
        if purpose != self._ALLOWED_PURPOSE:
            raise OOSAccessError(
                f"final OOS may only be revealed for '{self._ALLOWED_PURPOSE}', "
                f"got '{purpose}' (spec §16).")
        return self._oos.copy()

    def contamination_check(self):
        """
        Map recorded reveals to the existing contamination checker
        (deep.leakage_tests.final_oos_contamination_check). Returns a
        ContaminationCheck whose `.contaminated` reflects any forbidden reveal.
        """
        from src.deep.leakage_tests import final_oos_contamination_check
        used = set(self._revealed_for)
        return final_oos_contamination_check(
            oos_used_for_architecture="architecture" in used,
            oos_used_for_hpo="hpo" in used,
            oos_used_for_seed="seed" in used,
            oos_used_for_checkpoint="checkpoint" in used,
            oos_used_for_ensemble_weight="ensemble_weight" in used,
            oos_used_for_feature_selection="feature_selection" in used,
            oos_used_for_threshold="threshold" in used,
            oos_used_for_promotion="promotion" in used,
        )
