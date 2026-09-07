"""
Fixed-Horizon Labels — Label V2.

Produces raw forward-return labels over a fixed number of bars.
These are the simplest labels and serve as a benchmark against which
event-based (triple-barrier) labels are compared.

PIT rule
--------
Feature data: available at t0 (event_start_time)
Label data:   uses close[t0+1 .. t0+horizon] — intentionally future
The future price is the TARGET, not a feature.

Limitations vs triple-barrier
------------------------------
Fixed-horizon labels do not model:
  - stop-loss execution
  - profit-taking execution
  - path dependence
  - trade viability

They measure: "what was the gross price change over horizon bars?"
regardless of what happened intraday.  Use triple-barrier for trading labels.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
import structlog

from .config import LabelConfig
from .schemas import (
    DirectionClass, FixedHorizonLabel, LabelDiagnostics,
    LabelFamily, PriceBasis, Side,
)

logger = structlog.get_logger(__name__)

UTC = timezone.utc


# ── Volatility helpers ────────────────────────────────────────────────────────

def _compute_atr(
    high: pd.Series, low: pd.Series, close: pd.Series, window: int = 20
) -> pd.Series:
    """Trailing ATR as a fraction of close price."""
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low  - close.shift(1)).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(window=window, min_periods=1).mean()


def _compute_rolling_vol(close: pd.Series, window: int = 20) -> pd.Series:
    """Rolling standard deviation of log returns."""
    log_ret = np.log(close / close.shift(1))
    return log_ret.rolling(window=window, min_periods=2).std()


# ── Core fixed-horizon label engine ──────────────────────────────────────────

def generate_fixed_horizon_labels(
    ohlcv: pd.DataFrame,
    config: Optional[LabelConfig] = None,
    symbol: str = "UNKNOWN",
    side: Side = Side.LONG,
    price_basis: PriceBasis = PriceBasis.RAW,
    contract_expiry: Optional[datetime] = None,
) -> list[FixedHorizonLabel]:
    """
    Generate fixed-horizon forward-return labels.

    Parameters
    ----------
    ohlcv          : DataFrame with columns [open, high, low, close, volume].
                     Index must be a UTC-aware DatetimeIndex.
    config         : LabelConfig (defaults to LabelConfig.default_daily()).
    symbol         : Trading symbol for label provenance.
    side           : LONG (+1) or SHORT (-1). Affects sign of gross_return.
    price_basis    : Whether prices are raw or adjusted.
    contract_expiry: If set, events cannot extend past this datetime.

    Returns
    -------
    List of FixedHorizonLabel, one per valid bar.
    Tail bars where t+horizon exceeds the dataset are marked is_incomplete=True.
    """
    if config is None:
        config = LabelConfig.default_daily()

    cfg_hash  = config.hash
    horizon   = config.horizon_bars
    close     = ohlcv["close"].astype(float)
    n         = len(ohlcv)
    events: list[FixedHorizonLabel] = []

    # Ensure UTC-aware index
    idx = ohlcv.index
    if isinstance(idx, pd.DatetimeIndex) and idx.tz is None:
        raise ValueError(
            f"ohlcv index for {symbol} has no timezone. "
            "Use tz_localize('UTC') before generating labels."
        )

    # Volatility for vol-normalised labels
    high  = ohlcv.get("high",  close)
    low   = ohlcv.get("low",   close)
    atr   = _compute_atr(high, low, close, window=config.volatility_window)
    roll_vol = _compute_rolling_vol(close, window=config.volatility_window)

    for i in range(n):
        t0 = idx[i]
        entry_price = float(close.iloc[i])
        if not np.isfinite(entry_price) or entry_price <= 0:
            continue

        exit_bar = i + horizon
        is_incomplete = exit_bar >= n

        if is_incomplete:
            # Tail of dataset — mark as incomplete but still produce the label
            exit_price = float(close.iloc[-1])
            t1 = idx[-1]
        else:
            exit_price = float(close.iloc[exit_bar])
            t1 = idx[exit_bar]

        # Respect contract expiry
        if contract_expiry is not None:
            t1_aware = t1.to_pydatetime() if hasattr(t1, "to_pydatetime") else t1
            if t1_aware > contract_expiry:
                t1 = contract_expiry
                is_incomplete = True

        # Side-adjusted gross return
        raw_ret = (exit_price - entry_price) / entry_price
        gross_return = float(side.value) * raw_ret

        # Directional classification
        thresh = config.directional_threshold
        if gross_return > thresh:
            dir_class = DirectionClass.UP
        elif gross_return < -thresh:
            dir_class = DirectionClass.DOWN
        else:
            dir_class = DirectionClass.FLAT

        t0_dt = t0.to_pydatetime() if hasattr(t0, "to_pydatetime") else t0
        t1_dt = t1.to_pydatetime() if hasattr(t1, "to_pydatetime") else t1

        events.append(FixedHorizonLabel(
            symbol=symbol,
            event_start_time=t0_dt,
            event_end_time=t1_dt,
            label_available_time=t1_dt,
            label_family=LabelFamily.FIXED_RETURN,
            label_version=config.version,
            label_config_hash=cfg_hash,
            side=side,
            price_basis=price_basis,
            bar_frequency=config.bar_frequency,
            horizon_bars=horizon,
            entry_price=entry_price,
            exit_price=exit_price,
            gross_return=gross_return,
            direction_class=dir_class,
            is_incomplete=is_incomplete,
        ))

    return events


# ── Volatility-normalised return ───────────────────────────────────────────────

def compute_vol_adjusted_return(
    gross_return: float,
    entry_atr_pct: float,
    min_atr: float = 0.001,
) -> float:
    """
    Normalise gross_return by the trailing ATR at entry.

    vol_adj_return = gross_return / (atr_pct + epsilon)

    Captures: "how many ATRs did this trade earn?"
    Capped at ±10 to avoid extreme outliers on low-vol days.
    """
    denom = max(entry_atr_pct, min_atr)
    return float(np.clip(gross_return / denom, -10.0, 10.0))


# ── DataFrame convenience API ─────────────────────────────────────────────────

def generate_fixed_horizon_series(
    ohlcv: pd.DataFrame,
    config: Optional[LabelConfig] = None,
    symbol: str = "UNKNOWN",
    side: Side = Side.LONG,
) -> pd.DataFrame:
    """
    Generate fixed-horizon labels as a DataFrame aligned to ohlcv.index.

    Returns a DataFrame with columns:
      gross_return, direction_class, is_incomplete,
      event_start_time, event_end_time, label_config_hash

    The caller slices df.iloc[i-lookback : i+1] for features and uses
    this label DataFrame to get the outcome for row i.

    Backward compatibility
    ----------------------
    The old generate_ranking_labels_v2() returned a pd.Series of excess returns.
    This function returns the full label record.  Use the 'gross_return' column
    for backward-compatible access.
    """
    if config is None:
        config = LabelConfig.default_daily()

    events = generate_fixed_horizon_labels(
        ohlcv=ohlcv, config=config, symbol=symbol, side=side
    )

    rows = []
    for ev in events:
        rows.append({
            "gross_return":       ev.gross_return,
            "direction_class":    ev.direction_class.value if ev.direction_class else None,
            "is_incomplete":      ev.is_incomplete,
            "event_start_time":   ev.event_start_time,
            "event_end_time":     ev.event_end_time,
            "label_config_hash":  ev.label_config_hash,
            "label_version":      ev.label_version,
        })

    if not rows:
        return pd.DataFrame()

    result = pd.DataFrame(rows, index=ohlcv.index[:len(rows)])
    return result


# ── Label diagnostics ─────────────────────────────────────────────────────────

def label_diagnostics_fixed(
    events: list[FixedHorizonLabel],
    config: LabelConfig,
) -> LabelDiagnostics:
    """Compute diagnostic statistics for a set of fixed-horizon labels."""
    returns = [e.gross_return for e in events if e.gross_return is not None and not e.is_incomplete]

    diag = LabelDiagnostics(
        label_family=LabelFamily.FIXED_RETURN.value,
        label_version=config.version,
        label_config_hash=config.hash,
        sample_count=len(events),
        incomplete_count=sum(1 for e in events if e.is_incomplete),
    )

    if returns:
        arr = np.array(returns)
        diag.positive_count = int((arr > 0).sum())
        diag.negative_count = int((arr < 0).sum())
        diag.neutral_count  = int((arr == 0).sum())
        diag.mean_gross_return   = round(float(np.mean(arr)), 6)
        diag.median_gross_return = round(float(np.median(arr)), 6)
        diag.std_gross_return    = round(float(np.std(arr)), 6)

    return diag
