"""
Sample Weights — Label V2.

Computes event-overlap metadata and sample weights for training.

When labels use overlapping event windows (e.g. a 20-bar forward return at
bar t and at bar t+1 share 19 bars), treating them as independent samples
inflates effective sample size and destabilizes cross-validation.

We compute:
  - concurrency: how many events are active simultaneously at each bar
  - average_uniqueness: fraction of this event's window not overlapped by others
  - sample_weight: for model.fit(..., sample_weight=weights)

The t1 series (event_end_time per observation) is the key output for
integration with the existing PurgedKFold in validation/purged_kfold.py.

Reference
---------
López de Prado (2018), Advances in Financial Machine Learning,
Chapter 4 — "Fractionally Differentiated Features",
Chapter 7 — "Cross-Validation in Finance" (label overlap and sample weights).
"""

from __future__ import annotations

from datetime import datetime
from typing import Sequence

import numpy as np
import pandas as pd
import structlog

from .schemas import LabelEvent, SampleMetadata

logger = structlog.get_logger(__name__)


def _to_ts(dt: datetime | pd.Timestamp) -> pd.Timestamp:
    """Convert a tz-aware datetime to a UTC pd.Timestamp safely.

    Newer pandas (≥ 2.x) raises ValueError if you pass tz=UTC when the
    datetime already carries tzinfo.  Use tz_convert instead.
    """
    ts = pd.Timestamp(dt)
    if ts.tzinfo is None:
        return ts.tz_localize("UTC")
    return ts.tz_convert("UTC")


def compute_event_concurrency(
    events: Sequence[LabelEvent],
    bar_times: pd.DatetimeIndex,
) -> pd.Series:
    """
    Compute the number of simultaneously active events at each bar.

    An event is active at bar t if:
        event_start_time <= t < event_end_time

    Parameters
    ----------
    events    : List of LabelEvent (or subclass) with start/end times.
    bar_times : DatetimeIndex of all bars in the dataset.

    Returns
    -------
    pd.Series indexed by bar_times, values = concurrency count.
    """
    concurrency = pd.Series(0, index=bar_times, dtype=int)

    for ev in events:
        t0 = _to_ts(ev.event_start_time)
        t1 = _to_ts(ev.event_end_time)

        # Active bars: t0 <= bar < t1 (exclusive end)
        mask = (bar_times >= t0) & (bar_times < t1)
        concurrency[mask] += 1

    return concurrency


def compute_average_uniqueness(
    events: Sequence[LabelEvent],
    bar_times: pd.DatetimeIndex,
) -> list[float]:
    """
    Compute average uniqueness for each event.

    For event k active from t0_k to t1_k, the average uniqueness is:
        mean(1 / concurrency[t]) for t in [t0_k, t1_k)

    where concurrency[t] is the number of events active at bar t.

    A uniqueness of 1.0 means no overlap with other events.
    A uniqueness near 0.0 means highly overlapping.

    Parameters
    ----------
    events    : List of LabelEvent objects.
    bar_times : Full bar DatetimeIndex.

    Returns
    -------
    List of floats (average_uniqueness), one per event, same order as events.
    """
    concurrency = compute_event_concurrency(events, bar_times)

    uniqueness_list: list[float] = []

    for ev in events:
        t0 = _to_ts(ev.event_start_time)
        t1 = _to_ts(ev.event_end_time)

        mask   = (bar_times >= t0) & (bar_times < t1)
        c_vals = concurrency[mask]

        if len(c_vals) == 0 or c_vals.sum() == 0:
            uniqueness_list.append(1.0)
        else:
            # Average of 1/c across the active bars
            u = float(np.mean(1.0 / c_vals.clip(lower=1).values))
            uniqueness_list.append(u)

    return uniqueness_list


def compute_sample_metadata(
    events: Sequence[LabelEvent],
    bar_times: pd.DatetimeIndex,
) -> list[SampleMetadata]:
    """
    Compute per-event SampleMetadata including average_uniqueness, concurrency,
    and sample_weight.

    sample_weight = average_uniqueness (simple uniqueness-based weighting).
    The absolute scale matters less than the relative weights.

    Parameters
    ----------
    events    : List of LabelEvent objects.
    bar_times : Full bar DatetimeIndex.

    Returns
    -------
    list[SampleMetadata], one per event.
    """
    concurrency   = compute_event_concurrency(events, bar_times)
    uniqueness    = compute_average_uniqueness(events, bar_times)

    results: list[SampleMetadata] = []

    for ev, u in zip(events, uniqueness):
        t0 = _to_ts(ev.event_start_time)
        t1 = _to_ts(ev.event_end_time)

        mask = (bar_times >= t0) & (bar_times < t1)
        c_vals = concurrency[mask]
        max_conc = int(c_vals.max()) if len(c_vals) > 0 else 1

        results.append(SampleMetadata(
            symbol=ev.symbol,
            event_start_time=ev.event_start_time,
            event_end_time=ev.event_end_time,
            average_uniqueness=u,
            concurrency=max_conc,
            sample_weight=u,     # simple uniqueness-based weight
        ))

    return results


def build_t1_from_events(
    events: Sequence[LabelEvent],
    index: pd.DatetimeIndex,
) -> pd.Series:
    """
    Build a t1 Series for use with PurgedKFold from event objects.

    The t1 series maps each observation time (t0) to the label end time (t1).
    This is the event-aware replacement for build_t1_series(index, horizon_bars)
    when actual event end times are available from triple-barrier labels.

    Parameters
    ----------
    events : Completed LabelEvent objects with event_start_time and event_end_time.
    index  : DatetimeIndex of the full dataset (for alignment).

    Returns
    -------
    pd.Series indexed by event_start_time timestamps, values = event_end_time.
    Observations not represented by any event get NaT (excluded from purging).
    """
    t1_dict: dict[pd.Timestamp, pd.Timestamp] = {}
    for ev in events:
        t0 = _to_ts(ev.event_start_time)
        t1 = _to_ts(ev.event_end_time)
        t1_dict[t0] = t1

    t1 = pd.Series(pd.NaT, index=index, dtype="datetime64[ns, UTC]")
    for t0, end in t1_dict.items():
        if t0 in t1.index:
            t1[t0] = end

    return t1


def event_overlap_fraction(
    events: Sequence[LabelEvent],
    bar_times: pd.DatetimeIndex,
) -> float:
    """
    Return the fraction of bar-events that are simultaneously active with
    at least one other event.

    A value of 0.0 means no event overlap (e.g. point-in-time labels).
    A value near 1.0 means nearly all events overlap (e.g. 20-bar horizon on daily).
    """
    concurrency = compute_event_concurrency(events, bar_times)
    total_active = (concurrency > 0).sum()
    overlapping  = (concurrency > 1).sum()
    if total_active == 0:
        return 0.0
    return float(overlapping / total_active)
