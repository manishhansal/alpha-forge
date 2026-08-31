"""
Combinatorial Purged Cross-Validation (CPCV) for Financial Machine Learning.

Standard walk-forward CV produces only one unique test path through the data,
which makes it difficult to assess whether observed performance is genuine
or the result of overfitting to a specific historical path.

CPCV generates C(N, k) train/test splits from N folds, testing k folds at a
time and training on the remaining N-k folds.  This creates multiple
overlapping test paths, enabling:
  1. High-confidence strategy/model evaluation — performance is estimated
     across many independent paths rather than a single path.
  2. Backtest overfitting detection — variance of performance across paths
     reveals whether good results are path-dependent.
  3. Sharpe ratio distribution — a distribution of Sharpe ratios (not just
     one point estimate) can be computed.

Reference: López de Prado (2018), "Advances in Financial Machine Learning",
Chapter 12 — "Backtesting through Cross-Validation".
Also: Bailey & López de Prado (2014), "The Deflated Sharpe Ratio".

Notation:
  N  — number of groups (sequential folds in the time axis)
  k  — number of test groups per split (typically 2)
  C(N,k) — binomial coefficient, number of unique splits
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Iterator, Sequence

import numpy as np
import pandas as pd
import structlog

from .embargo import EmbargoConfig, EmbargoApplier
from .purged_kfold import PurgedKFold, build_t1_series

logger = structlog.get_logger(__name__)


# ─── Data structures ─────────────────────────────────────────────────────────


@dataclass
class CPCVFold:
    """
    A single CPCV train/test split.

    Attributes:
        split_index:      Index of this split among all C(N,k) splits.
        train_groups:     Which of the N groups form the training set.
        test_groups:      Which of the N groups form the test set.
        train_indices:    Flat integer index array for training observations.
        test_indices:     Flat integer index array for test observations.
        n_purged:         Number of training observations purged (label overlap).
        n_embargoed:      Number of observations removed by embargo.
        test_path_id:     Identifier for the "backtest path" this fold contributes to.
    """

    split_index: int
    train_groups: tuple[int, ...]
    test_groups: tuple[int, ...]
    train_indices: np.ndarray
    test_indices: np.ndarray
    n_purged: int = 0
    n_embargoed: int = 0
    test_path_id: int = 0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["train_indices"] = self.train_indices.tolist()
        d["test_indices"] = self.test_indices.tolist()
        d["train_groups"] = list(self.train_groups)
        d["test_groups"] = list(self.test_groups)
        return d


@dataclass
class CPCVConfig:
    """
    Configuration for Combinatorial Purged Cross-Validation.

    Args:
        n_splits:      Number of sequential groups N to partition the data into.
        n_test_splits: Number of groups k to hold out as test per split.
                       C(n_splits, n_test_splits) total unique splits are created.
        embargo_config: Embargo period to apply at fold boundaries.
        purge:         If True, apply label-overlap purging to training sets.
    """

    n_splits: int = 6
    n_test_splits: int = 2
    embargo_config: EmbargoConfig | None = None
    purge: bool = True

    def __post_init__(self) -> None:
        if self.n_splits < 2:
            raise ValueError(f"n_splits must be >= 2, got {self.n_splits}")
        if self.n_test_splits < 1:
            raise ValueError(f"n_test_splits must be >= 1, got {self.n_test_splits}")
        if self.n_test_splits >= self.n_splits:
            raise ValueError(
                f"n_test_splits ({self.n_test_splits}) must be < n_splits ({self.n_splits})"
            )
        if self.embargo_config is None:
            self.embargo_config = EmbargoConfig.bars(0)

    @property
    def n_combinations(self) -> int:
        """Total number of unique train/test splits: C(n_splits, n_test_splits)."""
        from math import comb
        return comb(self.n_splits, self.n_test_splits)

    def to_dict(self) -> dict:
        d = {
            "n_splits": self.n_splits,
            "n_test_splits": self.n_test_splits,
            "n_combinations": self.n_combinations,
            "purge": self.purge,
            "embargo_bars": self.embargo_config.to_bars() if self.embargo_config else 0,
        }
        return d


# ─── CPCV engine ─────────────────────────────────────────────────────────────


class CombinatorialPurgedCV:
    """
    Combinatorial Purged Cross-Validation engine.

    Generates all C(N, k) unique train/test splits for high-confidence
    strategy evaluation.  Each split applies purging and embargo to prevent
    information leakage.

    Usage:
        cpcv = CombinatorialPurgedCV(
            CPCVConfig(n_splits=6, n_test_splits=2, purge=True,
                       embargo_config=EmbargoConfig.days(5))
        )
        # With a numpy array
        for fold in cpcv.split(X, y, t1=t1_series, t0=index):
            X_train, y_train = X[fold.train_indices], y[fold.train_indices]
            X_test,  y_test  = X[fold.test_indices],  y[fold.test_indices]

    Path construction:
        The C(N,k) test splits collectively form C(N,k) * k / N unique
        "backtest paths".  Performance on each path is an independent
        estimate of the strategy's out-of-sample performance.
    """

    def __init__(self, config: CPCVConfig) -> None:
        self.config = config

    def split(
        self,
        X: np.ndarray,
        y: np.ndarray | None = None,
        t1: pd.Series | None = None,
        t0: pd.DatetimeIndex | None = None,
    ) -> list[CPCVFold]:
        """
        Generate all C(N, k) CPCV splits.

        Args:
            X:  Feature matrix of shape (n_samples, n_features).
            y:  Labels of shape (n_samples,). Optional but recommended.
            t1: Series of label end times (t0 → t1). Required for purging.
                Build with build_t1_series() for fixed-horizon labels.
            t0: DatetimeIndex of observation start times. Required for embargo.

        Returns:
            List of CPCVFold objects, one per unique train/test split.
        """
        n_samples = len(X)
        cfg = self.config

        # Build groups: partition the time axis into N sequential groups
        groups = self._build_groups(n_samples, cfg.n_splits)

        # Resolve t0
        if t0 is None:
            t0 = pd.DatetimeIndex(
                pd.date_range("2000-01-01", periods=n_samples, freq="D", tz="UTC")
            )

        # Embargo applier
        embargo_bars = cfg.embargo_config.to_bars() if cfg.embargo_config else 0  # type: ignore[union-attr]
        embargo = EmbargoApplier(cfg.embargo_config or EmbargoConfig.bars(0))  # type: ignore[arg-type]

        folds: list[CPCVFold] = []
        path_counter: dict[tuple[int, ...], int] = {}

        # Enumerate all C(N, k) combinations of groups to use as test
        for split_idx, test_group_combo in enumerate(
            itertools.combinations(range(cfg.n_splits), cfg.n_test_splits)
        ):
            test_groups = tuple(sorted(test_group_combo))
            train_groups = tuple(g for g in range(cfg.n_splits) if g not in test_groups)

            # Collect raw indices for train and test
            raw_train_idx = np.concatenate([groups[g] for g in train_groups])
            raw_test_idx = np.concatenate([groups[g] for g in test_groups])

            n_purged = 0
            n_embargoed = 0

            # Purge: remove training obs whose labels overlap any test group
            if cfg.purge and t1 is not None:
                purged_train = self._purge_training_set(
                    raw_train_idx, raw_test_idx, t0, t1
                )
                n_purged = len(raw_train_idx) - len(purged_train)
                raw_train_idx = purged_train

            # Embargo: remove observations adjacent to train/test boundaries
            if embargo_bars > 0:
                embargoed_train = self._apply_embargo(
                    raw_train_idx, raw_test_idx, embargo_bars
                )
                n_embargoed = len(raw_train_idx) - len(embargoed_train)
                raw_train_idx = embargoed_train

            # Assign a path ID: track which "backtest path" this test fold forms
            path_id = path_counter.get(test_groups, len(path_counter))
            path_counter[test_groups] = path_id

            folds.append(
                CPCVFold(
                    split_index=split_idx,
                    train_groups=train_groups,
                    test_groups=test_groups,
                    train_indices=np.sort(raw_train_idx),
                    test_indices=np.sort(raw_test_idx),
                    n_purged=n_purged,
                    n_embargoed=n_embargoed,
                    test_path_id=path_id,
                )
            )

        logger.info(
            "cpcv_splits_generated",
            n_splits=cfg.n_splits,
            n_test_splits=cfg.n_test_splits,
            n_combinations=len(folds),
            purge=cfg.purge,
            embargo_bars=embargo_bars,
            n_samples=n_samples,
        )

        return folds

    def iter_splits(
        self,
        X: np.ndarray,
        y: np.ndarray,
        t1: pd.Series | None = None,
        t0: pd.DatetimeIndex | None = None,
    ) -> Iterator[tuple[CPCVFold, dict[str, tuple[np.ndarray, np.ndarray]]]]:
        """
        Iterate over CPCV folds, yielding (fold, data_dict) tuples.

        Yields:
            (CPCVFold, {
                "train": (X_train, y_train),
                "test":  (X_test,  y_test),
            })
        """
        folds = self.split(X, y=y, t1=t1, t0=t0)
        for fold in folds:
            yield fold, {
                "train": (X[fold.train_indices], y[fold.train_indices]),
                "test":  (X[fold.test_indices],  y[fold.test_indices]),
            }

    # ── Path construction ─────────────────────────────────────────────────

    def build_backtest_paths(
        self,
        folds: list[CPCVFold],
    ) -> list[list[CPCVFold]]:
        """
        Group CPCV folds into backtest paths.

        A backtest path is a sequence of non-overlapping test windows that
        together cover the full time axis exactly once.  With N=6 and k=2,
        there are C(6,2)=15 splits, forming C(6,2) * 2 / 6 = 5 unique paths.

        Each path provides an independent estimate of out-of-sample performance.

        Args:
            folds: List of CPCVFold objects from split().

        Returns:
            List of paths, each path being an ordered list of CPCVFold objects
            whose test groups partition the full time axis without overlap.
        """
        cfg = self.config

        # A valid path is a set of n_splits / n_test_splits test group combos
        # that together cover all n_splits groups with no overlap.
        # We build paths greedily by covering all groups.
        groups_per_path = cfg.n_splits // cfg.n_test_splits
        all_groups = set(range(cfg.n_splits))

        # Group folds by their test_groups
        by_test_groups: dict[tuple[int, ...], CPCVFold] = {
            f.test_groups: f for f in folds
        }

        paths: list[list[CPCVFold]] = []
        # Find all combinations of test_group_combos that partition [0..N-1]
        test_group_combinations = list(itertools.combinations(
            range(cfg.n_splits), cfg.n_test_splits
        ))

        # A "path" is a selection of (n_splits / n_test_splits) test combos
        # that are pairwise disjoint and cover all n_splits groups
        if cfg.n_splits % cfg.n_test_splits == 0:
            for path_combo in itertools.combinations(
                test_group_combinations, groups_per_path
            ):
                # Check that this combination of test groups covers all groups exactly once
                covered = []
                for combo in path_combo:
                    covered.extend(combo)
                if set(covered) == all_groups and len(covered) == cfg.n_splits:
                    path_folds = []
                    for combo in sorted(path_combo):
                        if combo in by_test_groups:
                            path_folds.append(by_test_groups[combo])
                    if path_folds:
                        paths.append(path_folds)
        else:
            # N not divisible by k: do best-effort path construction
            # by greedily picking non-overlapping test combos
            for start_fold in folds:
                path: list[CPCVFold] = [start_fold]
                covered = set(start_fold.test_groups)
                for candidate_fold in folds:
                    if candidate_fold.split_index == start_fold.split_index:
                        continue
                    if set(candidate_fold.test_groups).isdisjoint(covered):
                        path.append(candidate_fold)
                        covered |= set(candidate_fold.test_groups)
                if len(covered) >= cfg.n_splits // 2:
                    paths.append(path)

        logger.info("backtest_paths_built", n_paths=len(paths))
        return paths

    # ── Internal helpers ──────────────────────────────────────────────────

    @staticmethod
    def _build_groups(n_samples: int, n_groups: int) -> list[np.ndarray]:
        """
        Partition n_samples into n_groups sequential, non-overlapping groups.

        The last group absorbs any remainder.
        """
        base_size = n_samples // n_groups
        remainder = n_samples % n_groups
        groups = []
        start = 0
        for g in range(n_groups):
            size = base_size + (1 if g < remainder else 0)
            groups.append(np.arange(start, start + size, dtype=np.intp))
            start += size
        return groups

    @staticmethod
    def _purge_training_set(
        train_idx: np.ndarray,
        test_idx: np.ndarray,
        t0: pd.DatetimeIndex,
        t1: pd.Series,
    ) -> np.ndarray:
        """
        Remove training observations whose labels overlap any test observation.

        An observation at train_idx[i] is purged if its label end time t1[t0[i]]
        is >= the start time of the first test observation (t0[test_idx[0]]).
        """
        if len(test_idx) == 0 or len(train_idx) == 0:
            return train_idx

        # Find the earliest test time
        test_start_time = t0[test_idx[0]] if test_idx[0] < len(t0) else t0[-1]

        purged = []
        for idx in train_idx:
            obs_t0 = t0[idx] if idx < len(t0) else t0[-1]

            if obs_t0 in t1.index:
                obs_t1 = t1[obs_t0]
            elif idx < len(t1):
                obs_t1 = t1.iloc[idx]
            else:
                purged.append(idx)
                continue

            # Keep only if label ends BEFORE the test window starts
            if obs_t1 < test_start_time:
                purged.append(idx)

        return np.array(purged, dtype=np.intp)

    @staticmethod
    def _apply_embargo(
        train_idx: np.ndarray,
        test_idx: np.ndarray,
        embargo_bars: int,
    ) -> np.ndarray:
        """
        Remove training observations that are within embargo_bars of any
        test observation boundary.

        Observations are embargoed if they fall immediately before or after
        the test window (at train/test boundaries).
        """
        if embargo_bars == 0 or len(test_idx) == 0:
            return train_idx

        # Identify boundary regions around each contiguous test block
        test_set = set(test_idx.tolist())

        # Find where test blocks start and end
        sorted_test = sorted(test_set)
        # Embargo zone: embargo_bars before each test block start
        embargo_zone: set[int] = set()
        for ti in sorted_test:
            for j in range(1, embargo_bars + 1):
                embargo_zone.add(ti - j)  # before test
                embargo_zone.add(ti + j)  # after test (belt and suspenders)

        filtered = np.array(
            [idx for idx in train_idx if idx not in embargo_zone],
            dtype=np.intp,
        )
        return filtered


# ─── Convenience wrappers ─────────────────────────────────────────────────────


def cpcv_splits(
    X: np.ndarray,
    y: np.ndarray | None = None,
    n_splits: int = 6,
    n_test_splits: int = 2,
    t1: pd.Series | None = None,
    t0: pd.DatetimeIndex | None = None,
    embargo_bars: int = 0,
) -> list[CPCVFold]:
    """
    Convenience function: generate all CPCV splits in one call.

    Args:
        X:              Feature matrix.
        y:              Labels (optional).
        n_splits:       Number of sequential groups (N).
        n_test_splits:  Number of groups held out per split (k).
        t1:             Label end time series for purging.
        t0:             Observation start time index for embargo.
        embargo_bars:   Number of bars to embargo at fold boundaries.

    Returns:
        List of CPCVFold objects.
    """
    cfg = CPCVConfig(
        n_splits=n_splits,
        n_test_splits=n_test_splits,
        embargo_config=EmbargoConfig.bars(embargo_bars),
        purge=t1 is not None,
    )
    engine = CombinatorialPurgedCV(cfg)
    return engine.split(X, y=y, t1=t1, t0=t0)
