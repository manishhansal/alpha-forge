"""
Embargo Period for Financial Machine Learning Cross-Validation.

After a training window ends, a configurable embargo period is applied before
the validation (or test) window begins.  This prevents information leakage
from labels that span multiple bars — a label computed at bar t may depend on
data from bars t+1 … t+h (the prediction horizon).  If bars t+1 … t+h sit
inside the training window's boundary, their raw price data is also in the
training set, creating a subtle overlap.

The embargo removes these contaminated bars from validation/test consideration.

Reference: López de Prado (2018), "Advances in Financial Machine Learning",
Chapter 7 — "Cross-Validation in Finance".

Embargo unit support:
  - bars:    a fixed number of time-series observations
  - minutes: converted to bars using a bars-per-minute resolution
  - days:    converted to bars using a bars-per-day resolution
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from enum import Enum
from typing import Sequence

import numpy as np
import pandas as pd
import structlog

logger = structlog.get_logger(__name__)


# ─── Embargo unit ─────────────────────────────────────────────────────────────


class EmbargoUnit(str, Enum):
    """Unit for expressing embargo duration."""

    BARS = "bars"
    MINUTES = "minutes"
    DAYS = "days"


# ─── Configuration ────────────────────────────────────────────────────────────


@dataclass
class EmbargoConfig:
    """
    Configuration for the embargo period.

    Args:
        size:       Embargo duration in the specified unit.
        unit:       Unit of the embargo (bars / minutes / days).
        bars_per_minute: Bars per minute, used when unit=MINUTES.
                         E.g. for 5-min bars: bars_per_minute = 0.2
                              for 1-min bars: bars_per_minute = 1.0
        bars_per_day:    Bars per trading day, used when unit=DAYS.
                         NSE trading session = 375 minutes:
                           5-min bars: 75 bars/day
                           1-min bars: 375 bars/day
                           Daily bars: 1 bar/day
    """

    size: int
    unit: EmbargoUnit = EmbargoUnit.BARS
    bars_per_minute: float = 1.0       # default: 1-min bars
    bars_per_day: int = 75             # default: 5-min NSE bars (375 min / 5)

    def __post_init__(self) -> None:
        if self.size < 0:
            raise ValueError(f"Embargo size must be >= 0, got {self.size}")
        if self.unit == EmbargoUnit.MINUTES and self.bars_per_minute <= 0:
            raise ValueError("bars_per_minute must be > 0")
        if self.unit == EmbargoUnit.DAYS and self.bars_per_day <= 0:
            raise ValueError("bars_per_day must be > 0")

    def to_bars(self) -> int:
        """Convert the embargo duration to an integer number of bars."""
        if self.unit == EmbargoUnit.BARS:
            return self.size
        elif self.unit == EmbargoUnit.MINUTES:
            return max(1, int(self.size * self.bars_per_minute))
        elif self.unit == EmbargoUnit.DAYS:
            return max(1, self.size * self.bars_per_day)
        else:
            raise ValueError(f"Unknown EmbargoUnit: {self.unit}")

    @classmethod
    def none(cls) -> "EmbargoConfig":
        """Zero-length embargo (no embargo applied)."""
        return cls(size=0, unit=EmbargoUnit.BARS)

    @classmethod
    def bars(cls, n: int) -> "EmbargoConfig":
        """Convenience: embargo of exactly n bars."""
        return cls(size=n, unit=EmbargoUnit.BARS)

    @classmethod
    def minutes(cls, n: int, bars_per_minute: float = 1.0) -> "EmbargoConfig":
        """Convenience: embargo of n minutes."""
        return cls(size=n, unit=EmbargoUnit.MINUTES, bars_per_minute=bars_per_minute)

    @classmethod
    def days(cls, n: int, bars_per_day: int = 75) -> "EmbargoConfig":
        """Convenience: embargo of n trading days."""
        return cls(size=n, unit=EmbargoUnit.DAYS, bars_per_day=bars_per_day)


# ─── Embargo applier ──────────────────────────────────────────────────────────


class EmbargoApplier:
    """
    Applies an embargo period to walk-forward and cross-validation splits.

    The embargo is applied at the boundary between the training window
    and the validation/test window.  Specifically, the first `embargo_bars`
    observations immediately following the training window are excluded from
    the validation set.

    This prevents the following leakage scenario:
      - Label at bar t is computed from bars t+1 … t+horizon
      - Bars t+1 … t+horizon may overlap with the start of the val window
      - These bars appear in both train features AND val labels → leakage

    The embargo gap absorbs the contaminated bars.
    """

    def __init__(self, config: EmbargoConfig) -> None:
        self.config = config
        self._embargo_bars = config.to_bars()

    @property
    def embargo_bars(self) -> int:
        return self._embargo_bars

    def apply_to_indices(
        self,
        train_indices: Sequence[int] | range,
        candidate_indices: Sequence[int] | range,
    ) -> np.ndarray:
        """
        Remove embargoed observations from candidate_indices.

        The embargo is applied after the last training index.  Any candidate
        index within `embargo_bars` of the last training index is removed.

        Args:
            train_indices:     Integer indices of the training set.
            candidate_indices: Integer indices to filter (val or test set).

        Returns:
            Filtered numpy array of candidate indices with embargoed
            observations removed.
        """
        if self._embargo_bars == 0:
            return np.array(list(candidate_indices), dtype=np.intp)

        last_train_idx = max(train_indices)
        embargo_cutoff = last_train_idx + self._embargo_bars

        filtered = np.array(
            [i for i in candidate_indices if i > embargo_cutoff],
            dtype=np.intp,
        )

        n_removed = len(list(candidate_indices)) - len(filtered)
        if n_removed > 0:
            logger.debug(
                "embargo_applied",
                embargo_bars=self._embargo_bars,
                last_train_idx=last_train_idx,
                embargo_cutoff=embargo_cutoff,
                n_observations_removed=n_removed,
                n_observations_remaining=len(filtered),
            )

        return filtered

    def apply_to_datetimes(
        self,
        train_times: pd.DatetimeIndex | pd.Series,
        candidate_times: pd.DatetimeIndex | pd.Series,
        t1_series: pd.Series | None = None,
    ) -> pd.DatetimeIndex:
        """
        Remove embargoed observations from candidate_times based on
        the label end-time series (t1_series).

        This is the López de Prado formulation: each training observation
        has an associated label end time t1[i].  Any candidate observation
        whose start time falls within max(t1[train]) + embargo is excluded.

        Args:
            train_times:     DatetimeIndex of training observation start times.
            candidate_times: DatetimeIndex of candidate observation start times.
            t1_series:       Series indexed by observation time, values are
                             label end times (t1 in AFML notation).
                             If None, the embargo is applied purely by bar count
                             using the positional fallback.

        Returns:
            Filtered DatetimeIndex of candidate times.
        """
        if self._embargo_bars == 0:
            return candidate_times if isinstance(candidate_times, pd.DatetimeIndex) else pd.DatetimeIndex(candidate_times)

        if t1_series is not None:
            # Use label end times to compute the embargo boundary precisely
            train_t1 = t1_series.reindex(train_times).dropna()
            if len(train_t1) > 0:
                max_label_end = train_t1.max()
                # Estimate bar duration from the candidate index spacing
                if len(candidate_times) > 1:
                    bar_duration = candidate_times[1] - candidate_times[0]
                else:
                    bar_duration = pd.Timedelta(days=1)
                embargo_end = max_label_end + bar_duration * self._embargo_bars
                filtered = candidate_times[candidate_times > embargo_end]
                logger.debug(
                    "embargo_applied_datetime",
                    max_label_end=str(max_label_end),
                    embargo_end=str(embargo_end),
                    n_removed=len(candidate_times) - len(filtered),
                )
                return filtered

        # Positional fallback: find the position of the last training time,
        # then exclude the next embargo_bars candidate observations
        if len(candidate_times) <= self._embargo_bars:
            return pd.DatetimeIndex([])

        return candidate_times[self._embargo_bars:]

    def apply_to_fold(
        self,
        train_indices: Sequence[int] | range,
        val_indices: Sequence[int] | range,
        test_indices: Sequence[int] | range,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Apply embargo to both validation and test windows of a single fold.

        The embargo is applied:
          - Between train and validation
          - Between validation and test (to prevent val→test contamination)

        Returns:
            (train_indices, purged_val_indices, purged_test_indices)
            Train indices are returned unchanged.
        """
        train_arr = np.array(list(train_indices), dtype=np.intp)
        purged_val = self.apply_to_indices(train_indices, val_indices)

        # Also embargo between val and test
        if len(purged_val) > 0:
            purged_test = self.apply_to_indices(purged_val, test_indices)
        else:
            purged_test = np.array(list(test_indices), dtype=np.intp)

        return train_arr, purged_val, purged_test


# ─── Label-based embargo (López de Prado formulation) ─────────────────────────


def compute_embargo_times(
    times: pd.DatetimeIndex,
    pct: float = 0.01,
) -> pd.Series:
    """
    Compute the per-observation embargo end time.

    The López de Prado approach expresses embargo as a percentage of the
    total sample span rather than a fixed bar count.  This scales naturally
    when the sample size changes between folds.

    Args:
        times: DatetimeIndex of all observation times.
        pct:   Fraction of the total span to use as the embargo duration.
               Default 0.01 = 1% of the total sample span.

    Returns:
        Series indexed by observation time, values are embargo end times.
        That is, embargo[t] is the earliest time at which a new observation
        can be included in a validation set after t appears in training.
    """
    if len(times) == 0:
        return pd.Series(dtype="datetime64[ns, UTC]")

    step = int(max(1, len(times) * pct))
    embargo_times = times[min(step, len(times) - 1) :]

    # Map: times[i] → embargo ends at times[i + step]
    # For the last `step` training observations, use the final time
    result = pd.Series(index=times, dtype=object)
    for i, t in enumerate(times):
        result[t] = times[min(i + step, len(times) - 1)]

    return result


def purge_train_indices_by_t1(
    train_indices: np.ndarray,
    val_indices: np.ndarray,
    t0: pd.DatetimeIndex,
    t1: pd.Series,
) -> np.ndarray:
    """
    Remove training observations whose label spans overlap with validation times.

    This is the purging step (distinct from embargo).  An observation in the
    training set is contaminated if its label end time t1[i] falls inside the
    validation window.

    Args:
        train_indices: Integer indices of training observations.
        val_indices:   Integer indices of validation observations.
        t0:            DatetimeIndex of all observation start times.
        t1:            Series: observation start time → label end time.

    Returns:
        Purged training indices (contaminated observations removed).
    """
    if len(val_indices) == 0 or len(train_indices) == 0:
        return train_indices

    val_start_time = t0[val_indices[0]]
    val_end_time = t0[val_indices[-1]]

    purged = []
    for idx in train_indices:
        obs_t0 = t0[idx]
        obs_t1 = t1.get(obs_t0, obs_t0)  # if no t1, assume point-in-time label

        # Keep only observations whose label does NOT overlap with the val window
        if obs_t1 < val_start_time:
            purged.append(idx)

    n_removed = len(train_indices) - len(purged)
    if n_removed > 0:
        logger.debug(
            "purge_by_t1",
            n_removed=n_removed,
            val_start=str(val_start_time),
            val_end=str(val_end_time),
        )

    return np.array(purged, dtype=np.intp)
