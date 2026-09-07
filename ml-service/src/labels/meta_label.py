"""
Meta-Labels — Label V2.

Implements the meta-labeling framework from López de Prado (2018).

The meta-label separates two decisions:
  1. SIDE (direction): supplied by the primary signal (regime + ranker + strategy)
  2. TAKE/SKIP: decided by the meta-label model

The meta-label model is trained to answer:
  "Given that the primary strategy produced this side, was taking the trade profitable?"

meta_label = 1 (TAKE)  if net_return > outcome_threshold
meta_label = 0 (SKIP)  otherwise

Critical property: the meta-model NEVER independently chooses direction.
Direction belongs to the primary signal.  The meta-model only filters entries.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
import structlog

from .config import LabelConfig
from .schemas import (
    LabelFamily, MetaLabel, PriceBasis, Side,
    TripleBarrierLabel, FirstTouch,
)

logger = structlog.get_logger(__name__)


def generate_meta_labels(
    triple_barrier_events: list[TripleBarrierLabel],
    primary_signal_source: str = "primary_model",
    outcome_threshold: float = 0.0,
    use_net_return: bool = False,
    config: Optional[LabelConfig] = None,
) -> list[MetaLabel]:
    """
    Generate meta-labels from a set of completed triple-barrier events.

    Parameters
    ----------
    triple_barrier_events : Completed TripleBarrierLabel events.
    primary_signal_source : Name of the primary model that produced the side.
    outcome_threshold     : Net return must exceed this value for meta_label=1.
                            Default 0.0 means "any positive return = TAKE."
    use_net_return        : If True, use net_return (after costs) for the decision.
                            If False, use gross_return.
    config                : LabelConfig for hash tracking.

    Returns
    -------
    list[MetaLabel] — one per non-incomplete, non-DATA_INSUFFICIENT event.

    Excluded events (returned as None in the list):
      - is_incomplete=True
      - first_touch=DATA_INSUFFICIENT or DATA_MISSING
      - gross_return is None
    """
    if config is None:
        config = LabelConfig.default_daily()

    cfg_hash = config.hash
    results: list[MetaLabel] = []

    for ev in triple_barrier_events:
        # Only label events with a resolved outcome
        if ev.is_incomplete:
            continue
        if ev.first_touch in (FirstTouch.DATA_INSUFFICIENT, FirstTouch.DATA_MISSING):
            continue
        if ev.gross_return is None:
            continue

        # Choose return basis
        if use_net_return and ev.net_return is not None:
            decision_return = ev.net_return
            cost_status = ev.cost_status
        else:
            decision_return = ev.gross_return
            cost_status = "GROSS_ONLY" if not use_net_return else ev.cost_status

        # meta_label = 1 iff outcome exceeds threshold
        meta = 1 if decision_return > outcome_threshold else 0

        results.append(MetaLabel(
            symbol=ev.symbol,
            event_start_time=ev.event_start_time,
            event_end_time=ev.event_end_time,
            label_available_time=ev.event_end_time,
            label_family=LabelFamily.META_LABEL,
            label_version=config.version,
            label_config_hash=cfg_hash,
            side=ev.side,
            price_basis=ev.price_basis,
            bar_frequency=ev.bar_frequency,
            primary_side=ev.side,
            primary_signal_source=primary_signal_source,
            meta_label=meta,
            gross_return=ev.gross_return,
            net_return=ev.net_return,
            outcome_threshold=outcome_threshold,
            cost_status=cost_status,
        ))

    return results


def generate_meta_labels_series(
    triple_barrier_events: list[TripleBarrierLabel],
    index: pd.DatetimeIndex,
    primary_signal_source: str = "primary_model",
    outcome_threshold: float = 0.0,
    use_net_return: bool = False,
    config: Optional[LabelConfig] = None,
) -> pd.Series:
    """
    Return meta-labels aligned to an index for backward compatibility.

    Returns a pd.Series of {0, 1, NaN} aligned to `index`.
    NaN where the event was incomplete/insufficient.
    """
    meta_labels = generate_meta_labels(
        triple_barrier_events=triple_barrier_events,
        primary_signal_source=primary_signal_source,
        outcome_threshold=outcome_threshold,
        use_net_return=use_net_return,
        config=config,
    )

    result = pd.Series(np.nan, index=index, dtype=float)
    for ml in meta_labels:
        ts = ml.event_start_time
        if hasattr(ts, "to_pydatetime"):
            ts = ts.to_pydatetime()
        # Match to index
        ts_pd = pd.Timestamp(ts, tz="UTC")
        if ts_pd in result.index:
            result[ts_pd] = float(ml.meta_label) if ml.meta_label is not None else np.nan

    return result
