"""
Relative / Excess Return Labels — Label V2.

Produces labels that express performance relative to a benchmark or sector.

A. Excess return vs NIFTY (or BANKNIFTY for bank-heavy F&O)
   excess_return = stock_return_h - nifty_return_h

B. Sector-relative return
   sector_rel = stock_return_h - sector_avg_return_h

C. Volatility-normalised excess return
   vol_adj_excess = excess_return / (rolling_vol + epsilon)

DATA_UNAVAILABLE policy
-----------------------
Sector returns are frequently unavailable for historical periods.
Where sector data is absent, the function returns DATA_UNAVAILABLE=True
in the label metadata and NaN in the return value.
Never substitute sector returns with zero or with the NIFTY return.

Backward compatibility
----------------------
generate_ranking_labels_v2() in data_pipeline.py produced a pd.Series
of risk-adjusted excess returns.  This module replaces that logic with
full LabelEvent provenance.  The old function is preserved as a
compatibility alias in data_pipeline.py.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
import structlog

from .config import LabelConfig
from .schemas import (
    FixedHorizonLabel, LabelDiagnostics, LabelFamily,
    PriceBasis, Side,
)

logger = structlog.get_logger(__name__)

_DATA_UNAVAILABLE = "DATA_UNAVAILABLE"


# ── Excess return vs benchmark ────────────────────────────────────────────────

def generate_excess_return_labels(
    ohlcv: pd.DataFrame,
    benchmark_close: pd.Series,
    config: Optional[LabelConfig] = None,
    symbol: str = "UNKNOWN",
    benchmark_name: str = "NIFTY",
    side: Side = Side.LONG,
    price_basis: PriceBasis = PriceBasis.RAW,
    contract_expiry: Optional[datetime] = None,
) -> list[FixedHorizonLabel]:
    """
    Generate excess-return labels (stock return minus benchmark return).

    The excess return is normalised by trailing volatility (Sharpe-like):
        vol_adj_excess = excess / (rolling_vol + eps)
    clipped at ±5.

    Parameters
    ----------
    ohlcv           : Stock OHLCV DataFrame with UTC DatetimeIndex.
    benchmark_close : Benchmark (NIFTY) close series, aligned to ohlcv.index.
    config          : LabelConfig (defaults to ranking_daily with horizon=5).
    symbol          : Stock symbol.
    benchmark_name  : Name of benchmark for provenance.
    side            : LONG or SHORT.
    price_basis     : RAW or ADJUSTED.
    contract_expiry : Optional hard stop.

    Returns
    -------
    list[FixedHorizonLabel] with gross_return = excess return (vol-adjusted).
    Tail observations are marked is_incomplete=True.
    """
    if config is None:
        config = LabelConfig.ranking_daily()

    if isinstance(ohlcv.index, pd.DatetimeIndex) and ohlcv.index.tz is None:
        raise ValueError(
            f"ohlcv index for {symbol} has no timezone. Use tz_localize('UTC')."
        )

    cfg_hash  = config.hash
    horizon   = config.horizon_bars
    close     = ohlcv["close"].astype(float)
    n         = len(ohlcv)
    idx       = ohlcv.index

    # Align benchmark to our index
    bench = benchmark_close.reindex(idx).astype(float)

    # Compute rolling volatility for normalisation
    stock_ret  = close.pct_change()
    bench_ret  = bench.pct_change()
    roll_vol   = stock_ret.rolling(window=config.volatility_window * 2, min_periods=2).std()

    events: list[FixedHorizonLabel] = []

    for i in range(n):
        t0 = idx[i]
        entry_price = float(close.iloc[i])
        if not np.isfinite(entry_price) or entry_price <= 0:
            continue

        exit_bar    = i + horizon
        is_incomplete = exit_bar >= n

        if is_incomplete:
            exit_bar   = n - 1
        t1 = idx[exit_bar]

        # Respect contract expiry
        if contract_expiry is not None:
            t1_dt = t1.to_pydatetime() if hasattr(t1, "to_pydatetime") else t1
            if t1_dt > contract_expiry:
                t1 = pd.Timestamp(contract_expiry, tz="UTC")
                is_incomplete = True

        exit_price   = float(close.iloc[exit_bar])
        bench_entry  = float(bench.iloc[i])     if i < len(bench) else np.nan
        bench_exit   = float(bench.iloc[exit_bar]) if exit_bar < len(bench) else np.nan

        # Raw returns
        stock_fwd = (exit_price - entry_price) / entry_price if entry_price > 0 else np.nan
        bench_fwd = (bench_exit - bench_entry) / bench_entry \
            if (np.isfinite(bench_entry) and bench_entry > 0 and np.isfinite(bench_exit)) \
            else np.nan

        # Excess return
        if np.isfinite(stock_fwd) and np.isfinite(bench_fwd):
            excess = float(side.value) * (stock_fwd - bench_fwd)
        else:
            excess = np.nan

        # Volatility normalisation
        vol = float(roll_vol.iloc[i]) if i < len(roll_vol) else np.nan
        if np.isfinite(excess) and np.isfinite(vol) and vol > 1e-8:
            gross_return = float(np.clip(excess / vol, -5.0, 5.0))
        else:
            gross_return = excess  # unnormalised fallback

        t0_dt = t0.to_pydatetime() if hasattr(t0, "to_pydatetime") else t0
        t1_dt = t1.to_pydatetime() if hasattr(t1, "to_pydatetime") else t1

        events.append(FixedHorizonLabel(
            symbol=symbol,
            event_start_time=t0_dt,
            event_end_time=t1_dt,
            label_available_time=t1_dt,
            label_family=LabelFamily.EXCESS_RETURN,
            label_version=config.version,
            label_config_hash=cfg_hash,
            side=side,
            price_basis=price_basis,
            bar_frequency=config.bar_frequency,
            horizon_bars=horizon,
            entry_price=entry_price,
            exit_price=exit_price,
            gross_return=gross_return if np.isfinite(gross_return) else None,
            is_incomplete=is_incomplete,
        ))

    return events


# ── Sector-relative return ────────────────────────────────────────────────────

def generate_sector_relative_labels(
    ohlcv: pd.DataFrame,
    sector_close_map: Optional[dict[str, pd.Series]],
    config: Optional[LabelConfig] = None,
    symbol: str = "UNKNOWN",
    side: Side = Side.LONG,
    price_basis: PriceBasis = PriceBasis.RAW,
) -> list[FixedHorizonLabel]:
    """
    Generate sector-relative return labels.

    sector_return = average return of sector peers over horizon.
    sector_rel = stock_return - sector_return

    DATA_UNAVAILABLE policy
    -----------------------
    If sector_close_map is None or empty, returns DATA_UNAVAILABLE events
    (gross_return=None).  Never substitutes with NIFTY or zero.
    """
    if config is None:
        config = LabelConfig.ranking_daily()

    if isinstance(ohlcv.index, pd.DatetimeIndex) and ohlcv.index.tz is None:
        raise ValueError(
            f"ohlcv index for {symbol} has no timezone. Use tz_localize('UTC')."
        )

    cfg_hash = config.hash
    horizon  = config.horizon_bars
    close    = ohlcv["close"].astype(float)
    n        = len(ohlcv)
    idx      = ohlcv.index

    # Validate sector data
    if not sector_close_map:
        logger.warning(
            "sector_relative_data_unavailable",
            symbol=symbol,
            note="sector_close_map is None or empty. Returning DATA_UNAVAILABLE labels.",
        )
        events = []
        for i in range(n):
            t0   = idx[i]
            t1   = idx[min(i + horizon, n - 1)]
            t0_d = t0.to_pydatetime() if hasattr(t0, "to_pydatetime") else t0
            t1_d = t1.to_pydatetime() if hasattr(t1, "to_pydatetime") else t1
            events.append(FixedHorizonLabel(
                symbol=symbol,
                event_start_time=t0_d,
                event_end_time=t1_d,
                label_available_time=t1_d,
                label_family=LabelFamily.SECTOR_RELATIVE,
                label_version=config.version,
                label_config_hash=cfg_hash,
                side=side,
                price_basis=price_basis,
                bar_frequency=config.bar_frequency,
                horizon_bars=horizon,
                entry_price=float(close.iloc[i]),
                exit_price=None,
                gross_return=None,      # DATA_UNAVAILABLE
                is_incomplete=i + horizon >= n,
            ))
        return events

    # Compute sector average return over horizon
    sector_rets = []
    for peer_sym, peer_close in sector_close_map.items():
        peer = peer_close.reindex(idx).astype(float)
        peer_fwd = peer.shift(-horizon) / peer - 1.0
        sector_rets.append(peer_fwd)

    if sector_rets:
        sector_avg = pd.concat(sector_rets, axis=1).mean(axis=1)
    else:
        sector_avg = pd.Series(np.nan, index=idx)

    events = []
    for i in range(n):
        t0 = idx[i]
        entry_price = float(close.iloc[i])
        if not np.isfinite(entry_price) or entry_price <= 0:
            continue

        exit_bar    = min(i + horizon, n - 1)
        is_incomplete = (i + horizon) >= n
        t1 = idx[exit_bar]

        exit_price   = float(close.iloc[exit_bar])
        stock_ret    = (exit_price - entry_price) / entry_price
        sector_r     = float(sector_avg.iloc[i]) if i < len(sector_avg) else np.nan

        if np.isfinite(stock_ret) and np.isfinite(sector_r):
            gross_return = float(side.value) * (stock_ret - sector_r)
        else:
            gross_return = None

        t0_dt = t0.to_pydatetime() if hasattr(t0, "to_pydatetime") else t0
        t1_dt = t1.to_pydatetime() if hasattr(t1, "to_pydatetime") else t1

        events.append(FixedHorizonLabel(
            symbol=symbol,
            event_start_time=t0_dt,
            event_end_time=t1_dt,
            label_available_time=t1_dt,
            label_family=LabelFamily.SECTOR_RELATIVE,
            label_version=config.version,
            label_config_hash=cfg_hash,
            side=side,
            price_basis=price_basis,
            bar_frequency=config.bar_frequency,
            horizon_bars=horizon,
            entry_price=entry_price,
            exit_price=exit_price,
            gross_return=gross_return,
            is_incomplete=is_incomplete,
        ))

    return events


# ── Backward-compat adapter ────────────────────────────────────────────────────

def generate_ranking_labels_v2_compat(
    stock_df: pd.DataFrame,
    nifty_close: pd.Series,
    horizon: int = 5,
) -> pd.Series:
    """
    Backward-compatible wrapper matching the old generate_ranking_labels_v2 signature.

    Returns a pd.Series of vol-adjusted excess returns (same as before).
    DEPRECATED — use generate_excess_return_labels() directly.
    """
    cfg = LabelConfig(version="lv2", horizon_bars=horizon, bar_frequency="1D")
    events = generate_excess_return_labels(
        ohlcv=stock_df,
        benchmark_close=nifty_close,
        config=cfg,
        symbol="COMPAT",
        benchmark_name="NIFTY",
    )

    if not events:
        return pd.Series(dtype=float)

    series_vals = [ev.gross_return for ev in events]
    result = pd.Series(series_vals, index=stock_df.index[:len(series_vals)], dtype=float)
    return result.clip(-5, 5)
