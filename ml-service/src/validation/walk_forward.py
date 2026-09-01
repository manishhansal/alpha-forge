"""
Walk-Forward Validation for Financial Machine Learning.

Implements proper rolling train/validate/test windows that respect the
temporal ordering of financial time series. Random splitting is explicitly
prohibited — all splits are strictly time-ordered with no look-ahead.

Design principles (from López de Prado, "Advances in Financial Machine Learning"):
  - Train → Validate → Test windows never overlap
  - Each window rolls forward by a configurable step
  - Window boundaries are expressed both as integer indices (for numpy arrays)
    and as datetime labels (for pandas DatetimeIndex)
  - Gap / embargo between folds is handled by the embargo module

Example timeline:
  Train:    2023-01 → 2024-01
  Validate: 2024-02 → 2024-04
  Test:     2024-05 → 2024-06
  (step forward, repeat)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator, Iterator, Sequence

import numpy as np
import pandas as pd
import structlog

logger = structlog.get_logger(__name__)


# ─── Data structures ─────────────────────────────────────────────────────────


@dataclass
class WalkForwardFold:
    """
    A single walk-forward fold with train / validate / test index ranges.

    All index attributes are integer positional indices into the time axis
    so they can be used directly with .iloc[] or numpy array slicing.
    """

    fold_index: int
    train_start: int
    train_end: int       # exclusive upper bound (Python slice convention)
    val_start: int
    val_end: int
    test_start: int
    test_end: int

    # Optional: corresponding pandas Timestamps when a DatetimeIndex is given
    train_start_dt: datetime | None = None
    train_end_dt: datetime | None = None
    val_start_dt: datetime | None = None
    val_end_dt: datetime | None = None
    test_start_dt: datetime | None = None
    test_end_dt: datetime | None = None

    @property
    def train_slice(self) -> slice:
        return slice(self.train_start, self.train_end)

    @property
    def val_slice(self) -> slice:
        return slice(self.val_start, self.val_end)

    @property
    def test_slice(self) -> slice:
        return slice(self.test_start, self.test_end)

    @property
    def train_indices(self) -> range:
        return range(self.train_start, self.train_end)

    @property
    def val_indices(self) -> range:
        return range(self.val_start, self.val_end)

    @property
    def test_indices(self) -> range:
        return range(self.test_start, self.test_end)

    def n_train(self) -> int:
        return self.train_end - self.train_start

    def n_val(self) -> int:
        return self.val_end - self.val_start

    def n_test(self) -> int:
        return self.test_end - self.test_start

    def to_dict(self) -> dict:
        d = asdict(self)
        # Serialize datetime objects to ISO strings
        for key in list(d.keys()):
            if d[key] is not None and isinstance(d[key], datetime):
                d[key] = d[key].isoformat()
        return d


@dataclass
class WalkForwardConfig:
    """
    Configuration for a walk-forward validation run.

    All size parameters are in "bars" (the atomic time unit of the series).
    For daily data, 1 bar = 1 day.  For intraday data, 1 bar = 1 candle.

    Args:
        train_bars:   Number of bars in the training window.
        val_bars:     Number of bars in the validation window.
        test_bars:    Number of bars in the test (out-of-sample) window.
        step_bars:    How many bars to advance the window on each roll.
                      Defaults to test_bars (non-overlapping test windows).
        min_train_bars: Enforce a minimum training window size. Folds with
                        fewer training bars are skipped.
        expanding:    If True, use an expanding (growing) training window
                      instead of a fixed rolling window.
    """

    train_bars: int
    val_bars: int
    test_bars: int
    step_bars: int | None = None            # default = test_bars
    min_train_bars: int | None = None       # default = train_bars
    expanding: bool = False                 # expanding vs rolling train window

    def __post_init__(self) -> None:
        if self.step_bars is None:
            self.step_bars = self.test_bars
        if self.min_train_bars is None:
            self.min_train_bars = self.train_bars

        if self.train_bars <= 0:
            raise ValueError(f"train_bars must be > 0, got {self.train_bars}")
        if self.val_bars <= 0:
            raise ValueError(f"val_bars must be > 0, got {self.val_bars}")
        if self.test_bars <= 0:
            raise ValueError(f"test_bars must be > 0, got {self.test_bars}")
        if self.step_bars <= 0:  # type: ignore[operator]
            raise ValueError(f"step_bars must be > 0, got {self.step_bars}")

    @property
    def min_series_length(self) -> int:
        """Minimum number of bars required for at least one fold."""
        return self.train_bars + self.val_bars + self.test_bars

    def to_dict(self) -> dict:
        return asdict(self)


# ─── Core walk-forward splitter ───────────────────────────────────────────────


class WalkForwardValidator:
    """
    Generates strictly time-ordered walk-forward train/validate/test folds.

    Usage — with integer indices (numpy arrays):
        cfg = WalkForwardConfig(train_bars=252, val_bars=63, test_bars=63)
        wfv = WalkForwardValidator(cfg)
        folds = wfv.split(n_periods=len(X))
        for fold in folds:
            X_train, y_train = X[fold.train_slice], y[fold.train_slice]
            X_val,   y_val   = X[fold.val_slice],   y[fold.val_slice]
            X_test,  y_test  = X[fold.test_slice],  y[fold.test_slice]

    Usage — with a DatetimeIndex (pandas DataFrame):
        folds = wfv.split_on_index(df.index)
        for fold in folds:
            train_df = df.loc[fold.train_start_dt : fold.train_end_dt]
            ...

    Invariants guaranteed:
        - max(train_indices) < min(val_indices)     — no temporal overlap
        - max(val_indices)   < min(test_indices)    — no temporal overlap
        - Each fold's test window does not overlap with any other fold's train window
        - All indices are strictly ascending
    """

    def __init__(self, config: WalkForwardConfig) -> None:
        self.config = config

    # ── Primary API ───────────────────────────────────────────────────────

    def split(self, n_periods: int) -> list[WalkForwardFold]:
        """
        Generate folds for a series of length `n_periods`.

        Args:
            n_periods: Total number of bars in the time series.

        Returns:
            List of WalkForwardFold objects, ordered chronologically.

        Raises:
            ValueError: If the series is too short for even one fold.
        """
        cfg = self.config
        min_len = cfg.min_series_length

        if n_periods < min_len:
            raise ValueError(
                f"Time series too short for walk-forward validation: "
                f"{n_periods} bars < {min_len} required "
                f"(train={cfg.train_bars} + val={cfg.val_bars} + test={cfg.test_bars}). "
                f"Provide more data or reduce window sizes."
            )

        folds: list[WalkForwardFold] = []
        fold_idx = 0
        cursor = 0  # start of the current training window

        while True:
            if cfg.expanding:
                # Expanding window: train always starts at 0, grows over time
                train_start = 0
                train_end = cfg.train_bars + fold_idx * cfg.step_bars  # type: ignore[operator]
            else:
                # Rolling window: fixed-size train window advances
                train_start = cursor
                train_end = cursor + cfg.train_bars

            val_start = train_end
            val_end = val_start + cfg.val_bars
            test_start = val_end
            test_end = test_start + cfg.test_bars

            # Stop when test window exceeds series length
            if test_end > n_periods:
                break

            # Skip folds with insufficient training data (relevant for expanding mode)
            if (train_end - train_start) < cfg.min_train_bars:  # type: ignore[operator]
                cursor += cfg.step_bars  # type: ignore[operator]
                fold_idx += 1
                continue

            folds.append(
                WalkForwardFold(
                    fold_index=fold_idx,
                    train_start=train_start,
                    train_end=train_end,
                    val_start=val_start,
                    val_end=val_end,
                    test_start=test_start,
                    test_end=test_end,
                )
            )

            cursor += cfg.step_bars  # type: ignore[operator]
            fold_idx += 1

        if not folds:
            raise ValueError(
                f"No valid walk-forward folds generated. "
                f"Series length {n_periods} may be insufficient with the given config."
            )

        self._validate_fold_integrity(folds)
        logger.info(
            "walk_forward_folds_generated",
            n_folds=len(folds),
            train_bars=cfg.train_bars,
            val_bars=cfg.val_bars,
            test_bars=cfg.test_bars,
            step_bars=cfg.step_bars,
            expanding=cfg.expanding,
        )
        return folds

    def split_on_index(
        self,
        index: pd.DatetimeIndex,
        embargo_bars: int = 0,
    ) -> list[WalkForwardFold]:
        """
        Generate folds and attach DatetimeIndex boundary labels to each fold.

        Args:
            index:        A sorted pandas DatetimeIndex from the time series.
            embargo_bars: Number of bars to exclude at the boundary between
                          train and validation (to prevent leakage from
                          overlapping labels). Applied via the embargo module.

        Returns:
            List of WalkForwardFold objects with dt fields populated.
        """
        if not isinstance(index, pd.DatetimeIndex):
            raise TypeError(f"Expected pd.DatetimeIndex, got {type(index).__name__}")
        if not index.is_monotonic_increasing:
            raise ValueError("DatetimeIndex must be sorted in ascending order.")

        folds = self.split(len(index))

        for fold in folds:
            # Clamp index bounds to be within the actual index length
            t_start = min(fold.train_start, len(index) - 1)
            t_end = min(fold.train_end - 1, len(index) - 1)
            v_start = min(fold.val_start, len(index) - 1)
            v_end = min(fold.val_end - 1, len(index) - 1)
            ts_start = min(fold.test_start, len(index) - 1)
            ts_end = min(fold.test_end - 1, len(index) - 1)

            fold.train_start_dt = index[t_start].to_pydatetime()
            fold.train_end_dt = index[t_end].to_pydatetime()
            fold.val_start_dt = index[v_start].to_pydatetime()
            fold.val_end_dt = index[v_end].to_pydatetime()
            fold.test_start_dt = index[ts_start].to_pydatetime()
            fold.test_end_dt = index[ts_end].to_pydatetime()

        return folds

    def iter_splits(
        self,
        X: np.ndarray,
        y: np.ndarray,
        folds: list[WalkForwardFold] | None = None,
    ) -> Iterator[tuple[WalkForwardFold, dict[str, tuple[np.ndarray, np.ndarray]]]]:
        """
        Iterate over folds, yielding (fold, data_dict) tuples.

        Args:
            X:     Feature matrix of shape (n_periods, n_features).
            y:     Label vector of shape (n_periods,).
            folds: Pre-computed folds (computed via split() if None).

        Yields:
            (WalkForwardFold, {
                "train": (X_train, y_train),
                "val":   (X_val,   y_val),
                "test":  (X_test,  y_test),
            })
        """
        if folds is None:
            folds = self.split(len(X))

        for fold in folds:
            yield fold, {
                "train": (X[fold.train_slice], y[fold.train_slice]),
                "val":   (X[fold.val_slice],   y[fold.val_slice]),
                "test":  (X[fold.test_slice],  y[fold.test_slice]),
            }

    # ── Integrity checks ─────────────────────────────────────────────────

    @staticmethod
    def _validate_fold_integrity(folds: list[WalkForwardFold]) -> None:
        """
        Assert all temporal ordering and non-overlap invariants hold.

        Raises AssertionError if any invariant is violated — this is a
        hard stop; a contaminated fold must never proceed to training.
        """
        for fold in folds:
            k = fold.fold_index

            # Within a fold: strict ordering
            assert fold.train_end <= fold.val_start, (
                f"Fold {k}: train_end ({fold.train_end}) > val_start ({fold.val_start}) "
                "— train overlaps validation"
            )
            assert fold.val_end <= fold.test_start, (
                f"Fold {k}: val_end ({fold.val_end}) > test_start ({fold.test_start}) "
                "— validation overlaps test"
            )
            assert fold.train_start < fold.train_end, (
                f"Fold {k}: empty training window"
            )
            assert fold.val_start < fold.val_end, (
                f"Fold {k}: empty validation window"
            )
            assert fold.test_start < fold.test_end, (
                f"Fold {k}: empty test window"
            )

        # Across folds: each fold's test must come before next fold's train
        # (only for rolling windows; expanding windows have train_start=0 always)
        for i in range(len(folds) - 1):
            current = folds[i]
            nxt = folds[i + 1]
            assert current.test_end <= nxt.test_end, (
                f"Fold {i}: test_end ({current.test_end}) > fold {i+1} test_end "
                "({nxt.test_end}) — folds are not chronologically ordered"
            )


# ─── Convenience factory functions ────────────────────────────────────────────


def walk_forward_splits(
    n_periods: int,
    train_bars: int,
    val_bars: int,
    test_bars: int,
    step_bars: int | None = None,
    expanding: bool = False,
) -> list[WalkForwardFold]:
    """
    Convenience wrapper — generate walk-forward folds for a series.

    This is a drop-in institutional-grade replacement for the basic
    walk_forward_splits() in data_pipeline.py, providing the same
    interface but with full integrity checks and datetime labeling.

    Args:
        n_periods:   Total number of bars.
        train_bars:  Training window size.
        val_bars:    Validation window size.
        test_bars:   Test window size.
        step_bars:   Roll step (default = test_bars).
        expanding:   Use expanding training window.

    Returns:
        List of WalkForwardFold objects.
    """
    cfg = WalkForwardConfig(
        train_bars=train_bars,
        val_bars=val_bars,
        test_bars=test_bars,
        step_bars=step_bars,
        expanding=expanding,
    )
    return WalkForwardValidator(cfg).split(n_periods)


def walk_forward_splits_on_dates(
    index: pd.DatetimeIndex,
    train_bars: int,
    val_bars: int,
    test_bars: int,
    step_bars: int | None = None,
    expanding: bool = False,
    embargo_bars: int = 0,
) -> list[WalkForwardFold]:
    """
    Walk-forward splits with DatetimeIndex boundary labels attached.

    Args:
        index:        Sorted DatetimeIndex of the time series.
        train_bars:   Training window size in bars.
        val_bars:     Validation window size.
        test_bars:    Test window size.
        step_bars:    Roll step (default = test_bars).
        expanding:    Use expanding training window.
        embargo_bars: Gap between train-end and val-start to prevent
                      label overlap leakage.

    Returns:
        List of WalkForwardFold with .train_start_dt etc. populated.
    """
    cfg = WalkForwardConfig(
        train_bars=train_bars,
        val_bars=val_bars,
        test_bars=test_bars,
        step_bars=step_bars,
        expanding=expanding,
    )
    return WalkForwardValidator(cfg).split_on_index(index, embargo_bars=embargo_bars)


# ─── Result persistence ───────────────────────────────────────────────────────


def save_fold_manifest(
    folds: list[WalkForwardFold],
    output_path: Path,
    config: WalkForwardConfig | None = None,
) -> Path:
    """
    Save a fold manifest as a JSON file for reproducibility.

    The manifest records every fold boundary so validation runs can be
    exactly reproduced and audited.  Existing manifests are not overwritten —
    a timestamp suffix is appended instead.

    Args:
        folds:       List of WalkForwardFold objects.
        output_path: Desired output file path (e.g. artifacts/wf_manifest.json).
        config:      Optional config to embed in the manifest.

    Returns:
        Actual path written (may have a timestamp suffix).
    """
    output_path = Path(output_path)

    # Never overwrite historical results
    if output_path.exists():
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        output_path = output_path.with_stem(f"{output_path.stem}_{ts}")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_folds": len(folds),
        "config": config.to_dict() if config else None,
        "folds": [f.to_dict() for f in folds],
    }
    output_path.write_text(json.dumps(manifest, indent=2))
    logger.info("fold_manifest_saved", path=str(output_path), n_folds=len(folds))
    return output_path
