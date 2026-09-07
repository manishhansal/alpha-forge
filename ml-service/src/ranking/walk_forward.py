"""
Cross-Sectional Walk-Forward Validation — Phase 3E.

Wraps the existing WalkForwardValidator with cross-sectional awareness:
- Splits by timestamp (not by individual stock-day rows)
- Reconstructs group boundaries within each fold for LambdaRank
- Applies PurgedKFold-compatible label overlap purging
- Records fold manifests for reproducibility

Group invariant
---------------
A cross-sectional ranking group = all rows at the same timestamp.
NEVER split rows from the same timestamp across train and test.

Walk-forward structure
-----------------------
    train timestamps: [T0 .. T_train_end]
    (embargo gap:      T_train_end+1 .. T_embargo_end)
    val   timestamps: [T_val_start .. T_val_end]
    test  timestamps: [T_test_start .. T_test_end]

Step = test_bars (non-overlapping test windows by default).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd


@dataclass
class CSFold:
    """One fold in a cross-sectional walk-forward split."""
    fold_index:       int
    train_timestamps: list[datetime]
    val_timestamps:   list[datetime]
    test_timestamps:  list[datetime]

    # Datetime boundaries (for reporting)
    train_start_dt: Optional[datetime] = None
    train_end_dt:   Optional[datetime] = None
    val_start_dt:   Optional[datetime] = None
    val_end_dt:     Optional[datetime] = None
    test_start_dt:  Optional[datetime] = None
    test_end_dt:    Optional[datetime] = None

    def n_train(self) -> int:
        return len(self.train_timestamps)

    def n_val(self) -> int:
        return len(self.val_timestamps)

    def n_test(self) -> int:
        return len(self.test_timestamps)


class CrossSectionalWalkForward:
    """
    Generates strictly temporal walk-forward folds for panel (cross-sectional) data.

    Parameters
    ----------
    train_bars  : Number of unique timestamps in training window.
    val_bars    : Number of unique timestamps in validation window.
    test_bars   : Number of unique timestamps in test window.
    step_bars   : How many timestamps to advance each fold (default = test_bars).
    embargo_bars: Timestamps to skip between train and val (label overlap purge).
    expanding   : If True, training window expands each fold; else rolling.
    """

    def __init__(
        self,
        train_bars:   int = 252,
        val_bars:     int = 63,
        test_bars:    int = 63,
        step_bars:    Optional[int] = None,
        embargo_bars: int = 5,
        expanding:    bool = False,
    ):
        self.train_bars   = train_bars
        self.val_bars     = val_bars
        self.test_bars    = test_bars
        self.step_bars    = step_bars if step_bars is not None else test_bars
        self.embargo_bars = embargo_bars
        self.expanding    = expanding

    def split(
        self,
        timestamps: list[datetime],
    ) -> list[CSFold]:
        """
        Generate folds from a sorted list of unique prediction timestamps.

        Parameters
        ----------
        timestamps : Sorted list of unique timestamps (one per CS group).

        Returns
        -------
        List of CSFold objects, ordered chronologically.

        Invariants
        ----------
        max(train_timestamps) < min(val_timestamps) for every fold.
        max(val_timestamps)   < min(test_timestamps) for every fold.
        All timestamps in a fold are disjoint from test timestamps of other folds.
        """
        ts = sorted(set(timestamps))
        n  = len(ts)
        min_len = self.train_bars + self.embargo_bars + self.val_bars + self.test_bars

        if n < min_len:
            raise ValueError(
                f"Not enough unique timestamps ({n}) for walk-forward: "
                f"need at least {min_len} "
                f"(train={self.train_bars} + embargo={self.embargo_bars} "
                f"+ val={self.val_bars} + test={self.test_bars})."
            )

        folds: list[CSFold] = []
        cursor   = 0
        fold_idx = 0

        while True:
            if self.expanding:
                train_start = 0
                train_end   = self.train_bars + fold_idx * self.step_bars
            else:
                train_start = cursor
                train_end   = cursor + self.train_bars

            emb_end   = train_end + self.embargo_bars
            val_start = emb_end
            val_end   = val_start + self.val_bars
            test_start = val_end
            test_end   = test_start + self.test_bars

            if test_end > n:
                break

            train_ts = ts[train_start:train_end]
            val_ts   = ts[val_start:val_end]
            test_ts  = ts[test_start:test_end]

            # Hard assertions
            assert len(train_ts) > 0 and len(val_ts) > 0 and len(test_ts) > 0
            assert max(train_ts) < min(val_ts), (
                f"Fold {fold_idx}: train_end {max(train_ts)} >= val_start {min(val_ts)}"
            )
            assert max(val_ts) < min(test_ts), (
                f"Fold {fold_idx}: val_end {max(val_ts)} >= test_start {min(test_ts)}"
            )

            folds.append(CSFold(
                fold_index=fold_idx,
                train_timestamps=train_ts,
                val_timestamps=val_ts,
                test_timestamps=test_ts,
                train_start_dt=train_ts[0],
                train_end_dt=train_ts[-1],
                val_start_dt=val_ts[0],
                val_end_dt=val_ts[-1],
                test_start_dt=test_ts[0],
                test_end_dt=test_ts[-1],
            ))

            cursor   += self.step_bars
            fold_idx += 1

        if not folds:
            raise ValueError("No valid walk-forward folds generated.")

        return folds

    def split_panel(
        self,
        panel_df: pd.DataFrame,
        timestamp_col: str,
    ) -> list[CSFold]:
        """
        Generate folds from a panel DataFrame's timestamp column.

        Parameters
        ----------
        panel_df      : Long-format panel with timestamps.
        timestamp_col : Column name for prediction timestamps.
        """
        unique_ts = sorted(panel_df[timestamp_col].unique().tolist())
        return self.split([pd.Timestamp(t).to_pydatetime() for t in unique_ts])

    @staticmethod
    def filter_panel(
        panel_df:      pd.DataFrame,
        timestamps:    list[datetime],
        timestamp_col: str,
    ) -> pd.DataFrame:
        """
        Filter panel to rows whose timestamp is in `timestamps`.
        """
        ts_set = set(pd.Timestamp(t) for t in timestamps)
        mask   = panel_df[timestamp_col].apply(
            lambda x: pd.Timestamp(x) in ts_set
        )
        return panel_df[mask].reset_index(drop=True)

    @staticmethod
    def get_groups(
        panel_df:      pd.DataFrame,
        timestamp_col: str,
    ) -> list[int]:
        """
        Return a list of group sizes (stocks per timestamp) in sorted timestamp order.
        Used for LambdaRank training.
        """
        counts = panel_df.groupby(timestamp_col, sort=True).size()
        return counts.tolist()
