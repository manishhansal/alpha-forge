"""
Purged K-Fold Cross-Validation for Financial Machine Learning.

Standard K-Fold CV is invalid for financial time series because:
  1. Labels overlap across adjacent bars (e.g. a 5-day forward return computed
     at bar t uses price data from bars t+1..t+5, which also appear in the
     training set for bars t+1..t+5).
  2. Standard shuffling destroys the temporal ordering, allowing future
     information to leak into training via any time-dependent feature.

PurgedKFold addresses both issues:
  - Purging:  Remove training observations whose labels overlap with the
              validation window's time span.
  - Embargo:  After the validation window, skip a configurable gap before
              including the next observation in training (prevents correlation
              between the last training observation and the first test obs).

Reference: López de Prado (2018), "Advances in Financial Machine Learning",
Chapter 7 — "Cross-Validation in Finance".

This implementation is scikit-learn compatible (implements the BaseCrossValidator
interface) so it can be used as a drop-in replacement in GridSearchCV,
cross_val_score, etc.
"""

from __future__ import annotations

from typing import Generator, Iterator

import numpy as np
import pandas as pd
import structlog
from sklearn.model_selection import BaseCrossValidator
from sklearn.utils.validation import _num_samples

logger = structlog.get_logger(__name__)


# ─── Purged K-Fold ────────────────────────────────────────────────────────────


class PurgedKFold(BaseCrossValidator):
    """
    K-Fold Cross-Validation with purging and optional embargo.

    Splits the data into k consecutive (non-shuffled) folds.  For each fold:
      1. The validation fold is held out.
      2. Training observations whose label end time (t1) overlaps with the
         validation fold are PURGED (removed from training).
      3. An optional embargo gap is applied after the validation fold to
         prevent serial correlation leakage.

    Parameters
    ----------
    n_splits : int
        Number of folds (k). Must be >= 2.
    t1 : pd.Series
        Series of label end times, indexed by observation time (t0).
        t1[t0] is the time at which the label for observation at t0 ends.
        For a 5-day forward return label: t1[t] = t + 5 trading days.
        If None, the splitter falls back to standard (non-purged) time-series
        CV, which is only appropriate for point-in-time labels.
    embargo_pct : float
        Fraction of the total sample span to use as the embargo gap after
        each validation fold. Default 0.01 (1%).
        Set to 0.0 to disable the embargo.
    pct_embargo : float
        Alias for embargo_pct (backward compatibility).

    sklearn-compatible interface:
        wfv = PurgedKFold(n_splits=5, t1=t1_series, embargo_pct=0.01)
        for train_idx, test_idx in wfv.split(X, y, groups=t0_series):
            X_train, X_test = X[train_idx], X[test_idx]

    Notes
    -----
    The `groups` parameter in `.split(X, y, groups)` is repurposed to pass the
    t0 DatetimeIndex / Series of observation start times.  If groups=None,
    integer range indices are used as a fallback.
    """

    def __init__(
        self,
        n_splits: int = 5,
        t1: pd.Series | None = None,
        embargo_pct: float = 0.01,
    ) -> None:
        super().__init__()
        if n_splits < 2:
            raise ValueError(f"n_splits must be >= 2, got {n_splits}")
        if not (0.0 <= embargo_pct < 0.5):
            raise ValueError(f"embargo_pct must be in [0, 0.5), got {embargo_pct}")

        self.n_splits = n_splits
        self.t1 = t1
        self.embargo_pct = embargo_pct

    def get_n_splits(
        self,
        X: np.ndarray | None = None,
        y: np.ndarray | None = None,
        groups=None,
    ) -> int:
        return self.n_splits

    def _iter_test_masks(
        self,
        X=None,
        y=None,
        groups=None,
    ) -> Generator[np.ndarray, None, None]:
        """Yield boolean masks for each test fold."""
        n_samples = _num_samples(X)
        fold_size = n_samples // self.n_splits

        for k in range(self.n_splits):
            test_start = k * fold_size
            test_end = test_start + fold_size if k < self.n_splits - 1 else n_samples
            mask = np.zeros(n_samples, dtype=bool)
            mask[test_start:test_end] = True
            yield mask

    def split(
        self,
        X: np.ndarray,
        y: np.ndarray | None = None,
        groups: pd.DatetimeIndex | pd.Series | None = None,
    ) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        """
        Generate (train_indices, test_indices) pairs.

        Args:
            X:      Feature matrix of shape (n_samples, n_features).
            y:      Labels (unused directly, present for sklearn compat).
            groups: DatetimeIndex or Series of observation start times (t0).
                    When provided, enables label-based purging and embargo.
                    When None, integer indices are used as time proxies.

        Yields:
            (train_idx, test_idx) — integer index arrays.
            train_idx has contaminated observations removed (purged).
        """
        n_samples = _num_samples(X)

        if n_samples < self.n_splits:
            raise ValueError(
                f"Cannot have n_splits={self.n_splits} with only {n_samples} samples."
            )

        # Resolve t0 (observation start times)
        if groups is not None:
            if isinstance(groups, pd.DatetimeIndex):
                t0 = groups
            elif isinstance(groups, pd.Series):
                t0 = pd.DatetimeIndex(groups.values)
            else:
                t0 = pd.DatetimeIndex(groups)
        else:
            # Fallback: synthetic integer-based times
            t0 = pd.DatetimeIndex(
                pd.date_range("2000-01-01", periods=n_samples, freq="D", tz="UTC")
            )

        # Resolve t1 (label end times)
        t1 = self.t1

        # Compute embargo duration in bars
        embargo_bars = max(1, int(n_samples * self.embargo_pct)) if self.embargo_pct > 0 else 0

        fold_size = n_samples // self.n_splits

        for k in range(self.n_splits):
            # Test fold boundaries
            test_start = k * fold_size
            test_end = test_start + fold_size if k < self.n_splits - 1 else n_samples
            test_idx = np.arange(test_start, test_end)

            # Initial training set: everything outside the test fold
            train_idx = np.concatenate([
                np.arange(0, test_start),
                np.arange(test_end + embargo_bars, n_samples),
            ])

            # Purge: remove training obs whose labels overlap the test window
            if t1 is not None:
                train_idx = self._purge(train_idx, test_idx, t0, t1)

            logger.debug(
                "purged_kfold_split",
                fold=k,
                n_train_before_purge=len(train_idx) + (
                    len(self._purge_count_only(train_idx, test_idx, t0, t1))
                    if t1 is not None else 0
                ),
                n_train_after_purge=len(train_idx),
                n_test=len(test_idx),
                n_embargo=embargo_bars,
            )

            yield train_idx, test_idx

    def _purge(
        self,
        train_idx: np.ndarray,
        test_idx: np.ndarray,
        t0: pd.DatetimeIndex,
        t1: pd.Series,
    ) -> np.ndarray:
        """
        Remove training observations whose label end time overlaps
        with the test window's start time.

        An observation at time t0[i] with label end time t1[t0[i]] is
        PURGED if t1[t0[i]] >= t0[test_idx[0]].

        That is: any training observation whose label extends into or beyond
        the test window start is removed from training.
        """
        if len(test_idx) == 0 or len(train_idx) == 0:
            return train_idx

        test_start_time = t0[test_idx[0]]
        # Also purge if the training obs starts after the test window ends
        test_end_time = t0[min(test_idx[-1], len(t0) - 1)]

        purged = []
        n_purged = 0

        for idx in train_idx:
            obs_t0 = t0[idx] if idx < len(t0) else t0[-1]

            # Look up this observation's label end time from t1
            if obs_t0 in t1.index:
                obs_t1 = t1[obs_t0]
            elif isinstance(t1.index, pd.DatetimeIndex) and len(t1) > idx:
                obs_t1 = t1.iloc[idx]
            else:
                # No t1 info: assume point-in-time label, no purging needed
                purged.append(idx)
                continue

            # PURGE if label end time overlaps test window
            if obs_t1 >= test_start_time:
                n_purged += 1
                continue

            # Also exclude observations that START after the test window
            # (future leakage — should not be in training)
            if obs_t0 > test_end_time:
                continue

            purged.append(idx)

        if n_purged > 0:
            logger.debug(
                "purged_observations",
                n_purged=n_purged,
                test_start=str(test_start_time),
            )

        return np.array(purged, dtype=np.intp)

    def _purge_count_only(
        self,
        train_idx: np.ndarray,
        test_idx: np.ndarray,
        t0: pd.DatetimeIndex,
        t1: pd.Series,
    ) -> np.ndarray:
        """Return the observations that WOULD be purged (for logging)."""
        if len(test_idx) == 0 or len(train_idx) == 0 or t1 is None:
            return np.array([], dtype=np.intp)

        test_start_time = t0[test_idx[0]]
        to_purge = []
        for idx in train_idx:
            obs_t0 = t0[idx] if idx < len(t0) else t0[-1]
            if obs_t0 in t1.index:
                obs_t1 = t1[obs_t0]
                if obs_t1 >= test_start_time:
                    to_purge.append(idx)
        return np.array(to_purge, dtype=np.intp)

    def __repr__(self) -> str:
        return (
            f"PurgedKFold(n_splits={self.n_splits}, "
            f"embargo_pct={self.embargo_pct}, "
            f"has_t1={self.t1 is not None})"
        )


# ─── Helper: build t1 series from a labeled DataFrame ─────────────────────────


def build_t1_series(
    index: pd.DatetimeIndex,
    horizon_bars: int,
) -> pd.Series:
    """
    Build a t1 (label end time) Series for a uniform forward-label horizon.

    For each observation at time t, the label end time is t + horizon_bars.
    This is the standard case for fixed-horizon labeling (e.g. 5-day forward
    return labels).

    Args:
        index:        DatetimeIndex of observation start times.
        horizon_bars: Number of bars in the label horizon.

    Returns:
        pd.Series indexed by t0, values are t1 (label end time).
    """
    t1 = pd.Series(index=index, dtype=object)
    for i, t in enumerate(index):
        end_idx = min(i + horizon_bars, len(index) - 1)
        t1[t] = index[end_idx]
    return t1


def build_t1_series_from_events(
    events_df: pd.DataFrame,
    t1_col: str = "t1",
) -> pd.Series:
    """
    Extract t1 from a DataFrame that has an explicit label-end column.

    This is used when labels are event-driven (e.g. triple-barrier method)
    rather than fixed-horizon.  The events DataFrame should have a DatetimeIndex
    of observation times and a column (default "t1") with the label end times.

    Args:
        events_df: DataFrame with DatetimeIndex and a t1 column.
        t1_col:    Name of the column containing label end times.

    Returns:
        pd.Series indexed by t0, values are t1.
    """
    if t1_col not in events_df.columns:
        raise KeyError(f"Column '{t1_col}' not found in events_df. Available: {list(events_df.columns)}")

    return events_df[t1_col].dropna()


# ─── Leakage detection ────────────────────────────────────────────────────────


def detect_label_overlap(
    t0: pd.DatetimeIndex,
    t1: pd.Series,
    tolerance_bars: int = 0,
) -> dict[str, int | float]:
    """
    Quantify label overlap across all adjacent observation pairs.

    Reports the fraction of observation pairs (i, i+1) where the label of
    observation i extends beyond the start of observation i+1.

    Args:
        t0:              DatetimeIndex of observation start times.
        t1:              Series: t0 → label end time.
        tolerance_bars:  Number of bars of overlap to tolerate before flagging.
                         0 = flag any overlap.

    Returns:
        Dict with:
          - n_overlapping_pairs: count of pairs with label overlap
          - total_pairs: total adjacent pairs checked
          - overlap_fraction: fraction that overlap
          - max_overlap_bars: worst-case overlap in bars
    """
    if len(t0) < 2:
        return {"n_overlapping_pairs": 0, "total_pairs": 0, "overlap_fraction": 0.0, "max_overlap_bars": 0}

    overlapping = 0
    max_overlap = 0
    bar_duration = t0[1] - t0[0]  # infer bar duration from first two observations

    for i in range(len(t0) - 1):
        obs_t0 = t0[i]
        next_t0 = t0[i + 1]
        if obs_t0 in t1.index:
            obs_t1 = t1[obs_t0]
            if obs_t1 > next_t0:
                overlap_td = obs_t1 - next_t0
                overlap_bars = int(overlap_td / bar_duration) if bar_duration.total_seconds() > 0 else 1
                if overlap_bars > tolerance_bars:
                    overlapping += 1
                    max_overlap = max(max_overlap, overlap_bars)

    total_pairs = len(t0) - 1
    return {
        "n_overlapping_pairs": overlapping,
        "total_pairs": total_pairs,
        "overlap_fraction": overlapping / total_pairs if total_pairs > 0 else 0.0,
        "max_overlap_bars": max_overlap,
    }
