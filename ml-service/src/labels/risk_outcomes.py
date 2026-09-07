"""
Risk Outcomes — MFE, MAE, Holding Period, Time-to-Event — Label V2.

These are OUTCOME fields, not features.
They describe what happened after an event was entered.
They must NEVER be used as model input features.

MFE: Maximum Favorable Excursion
  For LONG: the maximum intraday high relative to entry price, before event_end.
  For SHORT: the maximum favorable downward move relative to entry price.
  Always >= 0 under the signed convention used here.

MAE: Maximum Adverse Excursion
  For LONG: the worst intraday low relative to entry price, before event_end.
  For SHORT: the worst adverse upward move.
  Always <= 0 under the signed convention.

Holding period: actual bars held (from entry to first-touch or time limit).
Time-to-event:  bars until each barrier would have been touched.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
import structlog

from .config import LabelConfig
from .schemas import (
    LabelFamily, PriceBasis, RiskOutcomeLabel, Side,
    TripleBarrierLabel, FirstTouch,
)

logger = structlog.get_logger(__name__)


def _to_ts(dt) -> pd.Timestamp:
    """Convert a tz-aware datetime to a UTC pd.Timestamp safely."""
    ts = pd.Timestamp(dt)
    if ts.tzinfo is None:
        return ts.tz_localize("UTC")
    return ts.tz_convert("UTC")


def compute_risk_outcomes(
    triple_barrier_events: list[TripleBarrierLabel],
    ohlcv: pd.DataFrame,
    config: Optional[LabelConfig] = None,
) -> list[RiskOutcomeLabel]:
    """
    Compute MFE, MAE, holding period for a list of completed triple-barrier events.

    Parameters
    ----------
    triple_barrier_events : Completed TripleBarrierLabel events.
    ohlcv                 : Full OHLCV DataFrame (same as used to generate events).
    config                : LabelConfig for hash.

    Returns
    -------
    list[RiskOutcomeLabel] — one per event (including incomplete/insufficient).
    Incomplete events have mfe=None, mae=None.
    """
    if config is None:
        config = LabelConfig.default_daily()

    cfg_hash = config.hash
    idx      = ohlcv.index
    high     = ohlcv["high"].astype(float)
    low      = ohlcv["low"].astype(float)
    close    = ohlcv["close"].astype(float)

    # Build a timestamp → integer position lookup
    ts_to_pos: dict = {ts: pos for pos, ts in enumerate(idx)}

    results: list[RiskOutcomeLabel] = []

    for ev in triple_barrier_events:
        # Find entry bar position
        t0_pd = _to_ts(ev.event_start_time)
        pos0  = ts_to_pos.get(t0_pd)

        if pos0 is None:
            # Try without tz
            for ts, p in ts_to_pos.items():
                try:
                    if pd.Timestamp(ts).tz_localize(None) == pd.Timestamp(ev.event_start_time).tz_localize(None):
                        pos0 = p
                        break
                except Exception:
                    pass

        if pos0 is None:
            # Cannot locate entry bar — return empty outcome
            results.append(RiskOutcomeLabel(
                symbol=ev.symbol,
                event_start_time=ev.event_start_time,
                event_end_time=ev.event_end_time,
                label_available_time=ev.event_end_time,
                label_family=LabelFamily.MFE,
                label_version=config.version,
                label_config_hash=cfg_hash,
                side=ev.side,
                price_basis=ev.price_basis,
                bar_frequency=ev.bar_frequency,
            ))
            continue

        # Find event end bar position
        t1_pd = _to_ts(ev.event_end_time)
        pos1  = ts_to_pos.get(t1_pd, len(ohlcv) - 1)

        entry_price = ev.entry_price
        side_val    = ev.side.value  # +1 or -1

        if ev.is_incomplete or ev.first_touch in (
            FirstTouch.DATA_INSUFFICIENT, FirstTouch.DATA_MISSING
        ):
            results.append(RiskOutcomeLabel(
                symbol=ev.symbol,
                event_start_time=ev.event_start_time,
                event_end_time=ev.event_end_time,
                label_available_time=ev.event_end_time,
                label_family=LabelFamily.MFE,
                label_version=config.version,
                label_config_hash=cfg_hash,
                side=ev.side,
                price_basis=ev.price_basis,
                bar_frequency=ev.bar_frequency,
                holding_bars=max(0, pos1 - pos0),
            ))
            continue

        # Scan event window [pos0+1 .. pos1] for MFE and MAE
        scan_slice_high  = high.iloc[pos0 + 1 : pos1 + 1]
        scan_slice_low   = low.iloc[pos0 + 1 : pos1 + 1]
        scan_slice_times = idx[pos0 + 1 : pos1 + 1]

        mfe = mfe_time = mfe_bar_offset = None
        mae = mae_time = mae_bar_offset = None

        if len(scan_slice_high) > 0 and entry_price > 0:
            if side_val == 1:  # LONG
                # MFE: highest high relative to entry (positive)
                max_high_val = float(scan_slice_high.max())
                mfe_raw = (max_high_val - entry_price) / entry_price
                mfe = max(0.0, float(mfe_raw))
                mfe_bar_idx = int(scan_slice_high.argmax())
                mfe_bar_offset = mfe_bar_idx + 1
                mfe_ts = scan_slice_times[mfe_bar_idx]
                mfe_time = mfe_ts.to_pydatetime() if hasattr(mfe_ts, "to_pydatetime") else mfe_ts

                # MAE: lowest low relative to entry (negative)
                min_low_val = float(scan_slice_low.min())
                mae_raw = (min_low_val - entry_price) / entry_price
                mae = min(0.0, float(mae_raw))
                mae_bar_idx = int(scan_slice_low.argmin())
                mae_bar_offset = mae_bar_idx + 1
                mae_ts = scan_slice_times[mae_bar_idx]
                mae_time = mae_ts.to_pydatetime() if hasattr(mae_ts, "to_pydatetime") else mae_ts

            else:  # SHORT
                # MFE: lowest low (most favorable for short = price fell)
                min_low_val = float(scan_slice_low.min())
                mfe_raw = (entry_price - min_low_val) / entry_price
                mfe = max(0.0, float(mfe_raw))
                mfe_bar_idx = int(scan_slice_low.argmin())
                mfe_bar_offset = mfe_bar_idx + 1
                mfe_ts = scan_slice_times[mfe_bar_idx]
                mfe_time = mfe_ts.to_pydatetime() if hasattr(mfe_ts, "to_pydatetime") else mfe_ts

                # MAE: highest high (most adverse for short)
                max_high_val = float(scan_slice_high.max())
                mae_raw = -(max_high_val - entry_price) / entry_price
                mae = min(0.0, float(mae_raw))
                mae_bar_idx = int(scan_slice_high.argmax())
                mae_bar_offset = mae_bar_idx + 1
                mae_ts = scan_slice_times[mae_bar_idx]
                mae_time = mae_ts.to_pydatetime() if hasattr(mae_ts, "to_pydatetime") else mae_ts

        holding_bars = max(0, pos1 - pos0)

        # Time-to-event (bars to each barrier — from the scan)
        bars_to_tp = bars_to_sl = bars_to_time = None
        if ev.first_touch == FirstTouch.TAKE_PROFIT:
            bars_to_tp   = holding_bars
        elif ev.first_touch == FirstTouch.STOP_LOSS:
            bars_to_sl   = holding_bars
        elif ev.first_touch == FirstTouch.TIME_LIMIT:
            bars_to_time = holding_bars

        results.append(RiskOutcomeLabel(
            symbol=ev.symbol,
            event_start_time=ev.event_start_time,
            event_end_time=ev.event_end_time,
            label_available_time=ev.event_end_time,
            label_family=LabelFamily.MFE,
            label_version=config.version,
            label_config_hash=cfg_hash,
            side=ev.side,
            price_basis=ev.price_basis,
            bar_frequency=ev.bar_frequency,
            mfe=mfe,
            mfe_time=mfe_time,
            mfe_bar_offset=mfe_bar_offset,
            mae=mae,
            mae_time=mae_time,
            mae_bar_offset=mae_bar_offset,
            holding_bars=holding_bars,
            bars_to_tp=bars_to_tp,
            bars_to_sl=bars_to_sl,
            bars_to_time=bars_to_time,
        ))

    return results
