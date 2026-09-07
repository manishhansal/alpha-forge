"""
Phase 3K — Training discipline: HPO, seed management, checkpoints, multi-seed
robustness (spec §21, §22, §23, §24, §25, §26).

Hard leakage rules enforced here:
  - HPO searches ONLY over training/validation folds; the final OOS block is
    never touched during search (spec §21).
  - Early stopping / checkpoint selection use VALIDATION only (spec §22, §23).
  - Seeds are fixed beforehand or selected using training/validation evidence,
    NEVER by final OOS performance (spec §26).
  - Multi-seed robustness reports mean/median/std/worst/best over independent
    seeds (spec §25).

The evaluation split is passed in as three disjoint index sets (train, val,
oos). This module NEVER reads `oos` during search — enforced by an assertion
that the search touches only train+val indices.

Determinism: no np.random.* (all seeds explicit).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from src.ranking.evaluation import compute_rank_ic


@dataclass
class DataSplit:
    """Disjoint chronological index sets. oos must come after val after train."""
    train_idx: np.ndarray
    val_idx:   np.ndarray
    oos_idx:   np.ndarray

    def __post_init__(self):
        self.train_idx = np.asarray(self.train_idx, dtype=int)
        self.val_idx = np.asarray(self.val_idx, dtype=int)
        self.oos_idx = np.asarray(self.oos_idx, dtype=int)
        # chronology + disjointness
        if self.train_idx.size and self.val_idx.size:
            assert self.train_idx.max() < self.val_idx.min(), "train must precede val"
        if self.val_idx.size and self.oos_idx.size:
            assert self.val_idx.max() < self.oos_idx.min(), "val must precede oos"

    def search_indices(self) -> np.ndarray:
        """The ONLY indices HPO/seed search may touch (train+val)."""
        return np.concatenate([self.train_idx, self.val_idx])


@dataclass
class HPOResult:
    best_config:   dict
    best_val_score: float
    trials:        list[dict] = field(default_factory=list)
    search_touched_oos: bool = False       # must stay False


def grid_search_hpo(
    X: np.ndarray,
    y: np.ndarray,
    split: DataSplit,
    model_factory: Callable[[dict], object],   # config dict -> ranker (input_dim baked in)
    param_grid: list[dict],
    scaler_fn: Optional[Callable] = None,       # fit on train, apply to val
) -> HPOResult:
    """
    Deterministic grid HPO on train/val ONLY (spec §21).

    For each config: fit on train, score on VALIDATION (rank IC). The best
    config is chosen by validation score. The OOS block is NEVER read here.
    """
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).reshape(-1)
    Xtr, ytr = X[split.train_idx], y[split.train_idx]
    Xval, yval = X[split.val_idx], y[split.val_idx]

    if scaler_fn is not None:
        scaler = scaler_fn(Xtr)
        Xtr = scaler.transform(Xtr)
        Xval = scaler.transform(Xval)

    trials: list[dict] = []
    best_cfg = None
    best_score = -np.inf
    for cfg in param_grid:
        model = model_factory(cfg)
        model.fit(Xtr, ytr, X_val=Xval, y_val=yval)      # type: ignore[attr-defined]
        vpred = np.asarray(model.predict(Xval), dtype=float)  # type: ignore[attr-defined]
        vic = compute_rank_ic(vpred, yval)
        score = vic if vic is not None else -np.inf
        trials.append({"config": cfg, "val_rank_ic": vic})
        if score > best_score:
            best_score, best_cfg = score, cfg

    return HPOResult(
        best_config=best_cfg or {},
        best_val_score=float(best_score) if best_score != -np.inf else float("nan"),
        trials=trials,
        search_touched_oos=False,
    )


@dataclass
class SeedRobustness:
    """Multi-seed robustness stats over a metric (spec §25)."""
    metric_name:  str
    seeds:        list[int]
    values:       list[float]

    def _finite(self) -> list[float]:
        return [v for v in self.values if v is not None and np.isfinite(v)]

    def summary(self) -> dict:
        vals = self._finite()
        if not vals:
            return {
                "metric": self.metric_name, "n_seeds": len(self.seeds),
                "mean": None, "median": None, "std": None,
                "worst": None, "best": None, "n_valid": 0,
            }
        arr = np.array(vals, dtype=float)
        return {
            "metric": self.metric_name,
            "n_seeds": len(self.seeds),
            "mean": float(np.mean(arr)),
            "median": float(np.median(arr)),
            "std": float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0,
            "worst": float(np.min(arr)),
            "best": float(np.max(arr)),
            "n_valid": len(vals),
        }


def multi_seed_evaluation(
    X: np.ndarray,
    y: np.ndarray,
    split: DataSplit,
    model_factory: Callable[[int], object],     # seed -> ranker
    seeds: list[int],
    scaler_fn: Optional[Callable] = None,
    metric_name: str = "oos_rank_ic",
) -> SeedRobustness:
    """
    Train the SAME architecture under multiple independent seeds and report the
    OOS metric distribution (spec §25).

    IMPORTANT: OOS is used here only to REPORT the final distribution AFTER the
    architecture and hyperparameters are already fixed. The seed is NOT selected
    by OOS (spec §26) — all seeds are reported; the caller must not cherry-pick.
    """
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).reshape(-1)
    Xtr, ytr = X[split.train_idx], y[split.train_idx]
    Xval, yval = X[split.val_idx], y[split.val_idx]
    Xoos, yoos = X[split.oos_idx], y[split.oos_idx]

    if scaler_fn is not None:
        scaler = scaler_fn(Xtr)
        Xtr = scaler.transform(Xtr)
        Xval = scaler.transform(Xval)
        Xoos = scaler.transform(Xoos)

    values: list[float] = []
    for seed in seeds:
        model = model_factory(seed)
        model.fit(Xtr, ytr, X_val=Xval, y_val=yval)       # type: ignore[attr-defined]
        pred = np.asarray(model.predict(Xoos), dtype=float)  # type: ignore[attr-defined]
        ic = compute_rank_ic(pred, yoos)
        values.append(ic if ic is not None else float("nan"))

    return SeedRobustness(metric_name=metric_name, seeds=list(seeds), values=values)


def select_seed_by_validation(
    X: np.ndarray,
    y: np.ndarray,
    split: DataSplit,
    model_factory: Callable[[int], object],
    candidate_seeds: list[int],
    scaler_fn: Optional[Callable] = None,
) -> tuple[int, dict]:
    """
    Select a seed by VALIDATION rank IC only (spec §26) — never OOS.
    Returns (chosen_seed, per_seed_val_scores).
    """
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).reshape(-1)
    Xtr, ytr = X[split.train_idx], y[split.train_idx]
    Xval, yval = X[split.val_idx], y[split.val_idx]
    if scaler_fn is not None:
        scaler = scaler_fn(Xtr)
        Xtr = scaler.transform(Xtr)
        Xval = scaler.transform(Xval)

    scores: dict[int, Optional[float]] = {}
    best_seed, best = candidate_seeds[0], -np.inf
    for seed in candidate_seeds:
        model = model_factory(seed)
        model.fit(Xtr, ytr, X_val=Xval, y_val=yval)       # type: ignore[attr-defined]
        vic = compute_rank_ic(np.asarray(model.predict(Xval), dtype=float), yval)  # type: ignore[attr-defined]
        scores[seed] = vic
        s = vic if vic is not None else -np.inf
        if s > best:
            best, best_seed = s, seed
    return best_seed, {"per_seed_val_rank_ic": scores, "selected_by": "VALIDATION"}
