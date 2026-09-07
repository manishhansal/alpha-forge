"""
Cross-Sectional Target Labels — Phase 3E.

Implements canonical cross-sectional targets A–F as defined in Phase 3E spec.
These labels are computed WITHIN the eligible universe at each timestamp t.

Target definitions
------------------
A  future_raw_return_h           raw close-to-close return over horizon h
B  future_excess_return_h        stock return minus benchmark (NIFTY) return
C  future_sector_relative_h      stock return minus sector-average return
D  future_cs_percentile_h        cross-sectional percentile rank of A [0,100]
E  future_cs_zscore_h            cross-sectional z-score of A
F  future_cs_rank_h              ordinal rank within cross-section (1=lowest)

Timing invariant
----------------
Features at t use only data available at t.
Targets use future data strictly after t (bars t+1 to t+h).
Targets NEVER affect universe construction, feature normalization,
feature selection, or model fitting at t.

Survivorship safety
-------------------
All cross-sectional statistics (percentile, zscore, rank) are computed
within `eligible_symbols` — the universe at t as returned by UniverseResolver.
Never use the current live F&O universe for historical timestamps.

Missing data policy
-------------------
If a stock's future return cannot be computed (price absent after t):
  value = NaN, status = DATA_UNAVAILABLE
Never substitute 0 or mean for missing future data.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd


# ── Target specification ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class CSTargetConfig:
    """
    Configuration for cross-sectional target construction.

    horizon_bars  : Number of bars forward for the label window.
    benchmark     : Benchmark series identifier ('nifty' or 'none').
    vol_normalize : If True, divide excess return by rolling std.
    vol_window    : Lookback for rolling volatility (bars before t).
    vol_clip      : Clip vol-normalized return to ±vol_clip.
    min_cs_size   : Minimum eligible stocks to compute CS statistics.
    winsorize_pct : Winsorization percentile for outlier capping (0–50).
    """
    horizon_bars:   int   = 5
    benchmark:      str   = "nifty"
    vol_normalize:  bool  = True
    vol_window:     int   = 20
    vol_clip:       float = 5.0
    min_cs_size:    int   = 5
    winsorize_pct:  float = 1.0   # 1% each tail


# ── Per-stock target row ──────────────────────────────────────────────────────

@dataclass
class CSTargetRow:
    """
    One row of cross-sectional target labels for one stock at one timestamp.

    All six target types share a single timestamp and horizon so they can
    be directly compared or jointly optimised.
    """
    instrument_id:  str
    timestamp:      datetime      # prediction timestamp t
    horizon_bars:   int

    # Target A — raw forward return (%)
    raw_return:           Optional[float] = None
    # Target B — excess return vs benchmark (%)
    excess_return:        Optional[float] = None
    # Target C — sector-relative return (%)
    sector_relative:      Optional[float] = None
    # Target D — cross-sectional percentile [0, 100]
    cs_percentile:        Optional[float] = None
    # Target E — cross-sectional z-score
    cs_zscore:            Optional[float] = None
    # Target F — ordinal rank within cross-section (1 = lowest raw return)
    cs_rank:              Optional[int]   = None

    # Availability flags
    raw_return_available:      bool = False
    excess_return_available:   bool = False
    sector_relative_available: bool = False
    cs_stats_available:        bool = False

    # CS metadata
    cross_section_size: int = 0
    benchmark_return:   Optional[float] = None
    sector_return:      Optional[float] = None


# ── Core computation ──────────────────────────────────────────────────────────

def compute_cross_sectional_targets(
    stock_close_map: dict[str, pd.Series],
    timestamp: datetime,
    config: CSTargetConfig,
    eligible_symbols: list[str],
    benchmark_close: Optional[pd.Series] = None,
    sector_map: Optional[dict[str, str]] = None,
    sector_close_map: Optional[dict[str, pd.Series]] = None,
) -> list[CSTargetRow]:
    """
    Compute cross-sectional targets A–F for all eligible stocks at `timestamp`.

    Parameters
    ----------
    stock_close_map  : {symbol: close_series}, all with UTC DatetimeIndex.
    timestamp        : Prediction timestamp t.
    config           : Target configuration (horizon, benchmark, etc.).
    eligible_symbols : PIT-eligible universe at t from UniverseResolver.
                       NEVER pass current universe for historical timestamps.
    benchmark_close  : NIFTY 50 (or other index) close series.
    sector_map       : {symbol: sector_name} — PIT sector membership at t.
    sector_close_map : {symbol: close_series} for sector peers.

    Returns
    -------
    List[CSTargetRow] — one per eligible symbol at this timestamp.
    Symbols with unavailable future data return NaN targets.
    """
    ts = pd.Timestamp(timestamp).tz_convert("UTC") if pd.Timestamp(timestamp).tzinfo else \
         pd.Timestamp(timestamp).tz_localize("UTC")
    h  = config.horizon_bars

    # ── Compute raw forward return for each eligible symbol ─────────────
    raw_returns: dict[str, Optional[float]] = {}
    for sym in eligible_symbols:
        if sym not in stock_close_map:
            raw_returns[sym] = None
            continue
        s = stock_close_map[sym]
        if ts not in s.index:
            raw_returns[sym] = None
            continue
        pos = s.index.get_loc(ts)
        if pos + h >= len(s):
            raw_returns[sym] = None
            continue
        p0 = float(s.iloc[pos])
        ph = float(s.iloc[pos + h])
        if p0 <= 0:
            raw_returns[sym] = None
            continue
        raw_returns[sym] = (ph - p0) / p0 * 100.0

    # ── Benchmark return ─────────────────────────────────────────────────
    bmark_ret: Optional[float] = None
    if benchmark_close is not None and config.benchmark != "none":
        bts = pd.Timestamp(timestamp)
        bts = bts.tz_convert("UTC") if bts.tzinfo else bts.tz_localize("UTC")
        if bts in benchmark_close.index:
            bpos = benchmark_close.index.get_loc(bts)
            if bpos + h < len(benchmark_close):
                b0 = float(benchmark_close.iloc[bpos])
                bh = float(benchmark_close.iloc[bpos + h])
                if b0 > 0:
                    bmark_ret = (bh - b0) / b0 * 100.0

    # ── Sector returns ────────────────────────────────────────────────────
    sector_returns: dict[str, Optional[float]] = {}
    if sector_map and sector_close_map:
        # Group peers by sector and compute sector average
        sector_groups: dict[str, list[str]] = {}
        for sym in eligible_symbols:
            sec = sector_map.get(sym)
            if sec:
                sector_groups.setdefault(sec, []).append(sym)
        sector_avg: dict[str, Optional[float]] = {}
        for sec, members in sector_groups.items():
            rets = [raw_returns.get(m) for m in members if raw_returns.get(m) is not None]
            sector_avg[sec] = float(np.mean(rets)) if len(rets) >= 2 else None
        for sym in eligible_symbols:
            sec = sector_map.get(sym)
            sector_returns[sym] = sector_avg.get(sec) if sec else None

    # ── Cross-sectional statistics (D, E, F) ─────────────────────────────
    valid_syms = [s for s in eligible_symbols if raw_returns.get(s) is not None]
    cs_stats_ok = len(valid_syms) >= config.min_cs_size
    cs_pct: dict[str, float] = {}
    cs_z:   dict[str, float] = {}
    cs_rk:  dict[str, int]   = {}

    if cs_stats_ok:
        vals = np.array([raw_returns[s] for s in valid_syms], dtype=float)

        # Winsorize
        if config.winsorize_pct > 0:
            lo_pct = config.winsorize_pct
            hi_pct = 100.0 - config.winsorize_pct
            lo = float(np.percentile(vals, lo_pct))
            hi = float(np.percentile(vals, hi_pct))
            vals = np.clip(vals, lo, hi)

        # Percentile rank (Target D)
        n = len(vals)
        sort_idx = np.argsort(vals)         # ascending
        ranks    = np.empty(n, dtype=float)
        ranks[sort_idx] = np.arange(n)
        pcts = (ranks / (n - 1) * 100.0) if n > 1 else np.full(n, 50.0)
        for sym, pct in zip(valid_syms, pcts):
            cs_pct[sym] = float(pct)

        # Z-score (Target E)
        mu  = float(np.mean(vals))
        sig = float(np.std(vals, ddof=1)) if n > 1 else 0.0
        zs  = (vals - mu) / sig if sig > 1e-10 else np.zeros(n)
        for sym, z in zip(valid_syms, zs):
            cs_z[sym] = float(z)

        # Ordinal rank (Target F), 1-indexed, 1=lowest
        ord_ranks = np.argsort(np.argsort(vals)) + 1   # stable argsort
        for sym, r in zip(valid_syms, ord_ranks):
            cs_rk[sym] = int(r)

    # ── Assemble rows ─────────────────────────────────────────────────────
    rows: list[CSTargetRow] = []
    for sym in eligible_symbols:
        rr   = raw_returns.get(sym)
        ex   = (rr - bmark_ret) if (rr is not None and bmark_ret is not None) else None
        sr   = (rr - sector_returns.get(sym)) if (
            rr is not None and sector_returns.get(sym) is not None
        ) else None

        row = CSTargetRow(
            instrument_id=sym,
            timestamp=timestamp,
            horizon_bars=h,
            raw_return=rr,
            excess_return=ex,
            sector_relative=sr,
            cs_percentile=cs_pct.get(sym),
            cs_zscore=cs_z.get(sym),
            cs_rank=cs_rk.get(sym),
            raw_return_available=(rr is not None),
            excess_return_available=(ex is not None),
            sector_relative_available=(sr is not None),
            cs_stats_available=cs_stats_ok and sym in valid_syms,
            cross_section_size=len(valid_syms),
            benchmark_return=bmark_ret,
            sector_return=sector_returns.get(sym),
        )
        rows.append(row)
    return rows


def cs_targets_to_dataframe(rows: list[CSTargetRow]) -> pd.DataFrame:
    """Convert a list of CSTargetRow objects to a DataFrame."""
    records = []
    for r in rows:
        records.append({
            "instrument_id":    r.instrument_id,
            "timestamp":        r.timestamp,
            "horizon_bars":     r.horizon_bars,
            "raw_return":       r.raw_return,
            "excess_return":    r.excess_return,
            "sector_relative":  r.sector_relative,
            "cs_percentile":    r.cs_percentile,
            "cs_zscore":        r.cs_zscore,
            "cs_rank":          r.cs_rank,
            "cross_section_size": r.cross_section_size,
            "benchmark_return": r.benchmark_return,
        })
    return pd.DataFrame(records)
