"""
Cross-Sectional Normalization — Phase 3E.

All normalization MUST be:
1. Computed WITHIN a single timestamp's cross-section.
2. Using only the eligible universe U_t at that timestamp.
3. Never referencing future timestamps or future universe members.

Available methods
-----------------
winsorize           : Cap outliers at configurable percentiles
cs_zscore           : (x - mean) / std within U_t
cs_robust_zscore    : (x - median) / IQR within U_t
cs_rank_pct         : percentile rank within U_t [0, 1]
cs_rank_normal      : normal-score transform (Blom formula)

The normalization_version string must change when any formula changes.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd


NORMALIZATION_VERSION = "cs_norm-v1"


def winsorize(
    values: np.ndarray,
    pct: float = 1.0,
) -> np.ndarray:
    """
    Winsorize a 1-D array by capping at the `pct`th and `(100-pct)`th percentiles.

    Parameters
    ----------
    values : 1-D float array; NaN values are ignored for percentile computation
             but preserved in the output.
    pct    : Tail percentage to cap (1.0 → cap at 1st and 99th percentiles).

    Returns
    -------
    Winsorized array, same shape, NaN preserved.
    """
    if pct <= 0:
        return values.copy()
    finite = values[np.isfinite(values)]
    if len(finite) < 2:
        return values.copy()
    lo = float(np.percentile(finite, pct))
    hi = float(np.percentile(finite, 100.0 - pct))
    out = values.copy()
    out = np.where(np.isfinite(out), np.clip(out, lo, hi), out)
    return out


def cs_zscore(
    values: np.ndarray,
    min_obs: int = 5,
) -> np.ndarray:
    """
    Cross-sectional z-score: (x - mean) / std within the current cross-section.

    NaN values are excluded from mean/std computation and preserved as NaN
    in the output.  Never uses future cross-sections.

    Parameters
    ----------
    values  : 1-D float array (one entry per stock in U_t).
    min_obs : Minimum finite values needed; returns NaN array if below threshold.
    """
    finite_mask = np.isfinite(values)
    if finite_mask.sum() < min_obs:
        return np.full_like(values, np.nan)
    mu  = float(np.mean(values[finite_mask]))
    sig = float(np.std(values[finite_mask], ddof=1))
    if sig < 1e-10:
        result = np.zeros_like(values, dtype=float)
        result[~finite_mask] = np.nan
        return result
    out = (values - mu) / sig
    out[~finite_mask] = np.nan
    return out


def cs_robust_zscore(
    values: np.ndarray,
    min_obs: int = 5,
) -> np.ndarray:
    """
    Cross-sectional robust z-score: (x - median) / IQR.

    More resistant to outliers than standard z-score.
    """
    finite_mask = np.isfinite(values)
    if finite_mask.sum() < min_obs:
        return np.full_like(values, np.nan)
    finite = values[finite_mask]
    med = float(np.median(finite))
    q1, q3 = float(np.percentile(finite, 25)), float(np.percentile(finite, 75))
    iqr = q3 - q1
    if iqr < 1e-10:
        result = np.zeros_like(values, dtype=float)
        result[~finite_mask] = np.nan
        return result
    out = (values - med) / iqr
    out[~finite_mask] = np.nan
    return out


def cs_rank_pct(
    values: np.ndarray,
    min_obs: int = 5,
) -> np.ndarray:
    """
    Cross-sectional percentile rank in [0, 1].

    Ties are broken by average rank.
    NaN values are excluded and return NaN.
    """
    finite_mask = np.isfinite(values)
    n_finite = finite_mask.sum()
    if n_finite < min_obs:
        return np.full_like(values, np.nan)

    result = np.full_like(values, np.nan)
    idx = np.where(finite_mask)[0]
    finite_vals = values[finite_mask]

    # Average rank (consistent with scipy.stats.rankdata('average'))
    sorted_idx = np.argsort(finite_vals, kind="stable")
    ranks = np.empty(len(finite_vals), dtype=float)
    i = 0
    while i < len(sorted_idx):
        j = i
        while j < len(sorted_idx) - 1 and finite_vals[sorted_idx[j]] == finite_vals[sorted_idx[j + 1]]:
            j += 1
        avg_rank = (i + j) / 2.0
        for k in range(i, j + 1):
            ranks[sorted_idx[k]] = avg_rank
        i = j + 1

    pcts = ranks / (n_finite - 1) if n_finite > 1 else np.zeros(n_finite)
    result[idx] = pcts
    return result


def cs_rank_normal(
    values: np.ndarray,
    min_obs: int = 5,
) -> np.ndarray:
    """
    Normal-score transform (Blom formula): Φ⁻¹((rank - 3/8) / (n + 1/4)).

    Maps ranks to approximate standard normal quantiles.
    Useful for tree models where absolute scale matters less.
    """
    from scipy.special import ndtri  # type: ignore[import]

    finite_mask = np.isfinite(values)
    n_finite = finite_mask.sum()
    if n_finite < min_obs:
        return np.full_like(values, np.nan)

    result = np.full_like(values, np.nan)
    idx    = np.where(finite_mask)[0]
    fvals  = values[finite_mask]
    sorted_pos = np.argsort(np.argsort(fvals, kind="stable"), kind="stable")  # 0-based rank
    pcts   = (sorted_pos + 1 - 0.375) / (n_finite + 0.25)
    pcts   = np.clip(pcts, 1e-6, 1 - 1e-6)
    result[idx] = ndtri(pcts)
    return result


def normalize_cross_section(
    df: pd.DataFrame,
    feature_cols: list[str],
    method: str = "zscore",
    winsorize_pct: float = 1.0,
    min_obs: int = 5,
) -> pd.DataFrame:
    """
    Normalize a cross-sectional feature matrix where each row is a stock
    and all rows belong to the same timestamp.

    Parameters
    ----------
    df           : DataFrame with shape (n_stocks, n_features).
    feature_cols : Columns to normalize.
    method       : 'zscore' | 'robust_zscore' | 'rank_pct' | 'rank_normal'.
    winsorize_pct: Winsorize tails before normalization (0 = skip).
    min_obs      : Minimum finite values per feature; otherwise NaN.

    Returns
    -------
    DataFrame with normalized columns; non-feature columns unchanged.

    Causal guarantee
    ----------------
    This function operates on a single timestamp's rows only.
    The caller is responsible for not mixing multiple timestamps.
    """
    out = df.copy()
    fn_map = {
        "zscore":        cs_zscore,
        "robust_zscore": cs_robust_zscore,
        "rank_pct":      cs_rank_pct,
        "rank_normal":   cs_rank_normal,
    }
    if method not in fn_map:
        raise ValueError(f"Unknown normalization method '{method}'. "
                         f"Choose from {list(fn_map)}")
    fn = fn_map[method]

    for col in feature_cols:
        if col not in df.columns:
            continue
        vals = df[col].to_numpy(dtype=float)
        if winsorize_pct > 0:
            vals = winsorize(vals, winsorize_pct)
        out[col] = fn(vals, min_obs=min_obs)

    return out


def normalize_panel(
    df: pd.DataFrame,
    timestamp_col: str,
    feature_cols: list[str],
    method: str = "zscore",
    winsorize_pct: float = 1.0,
    min_obs: int = 5,
) -> pd.DataFrame:
    """
    Apply cross-sectional normalization to a panel DataFrame with multiple timestamps.

    Each timestamp's rows are normalized independently — normalization statistics
    from one timestamp NEVER influence another timestamp's values.

    Parameters
    ----------
    df            : Long-format panel with `timestamp_col` and feature columns.
    timestamp_col : Column name for the grouping timestamp.
    feature_cols  : Features to normalize.
    method        : See normalize_cross_section().
    winsorize_pct : Winsorize percentile.
    min_obs       : Minimum stocks per timestamp for valid normalization.

    Returns
    -------
    Panel with normalized features; shape unchanged.
    """
    result_parts = []
    for ts, group in df.groupby(timestamp_col, sort=True):
        normalized = normalize_cross_section(
            group.reset_index(drop=True),
            feature_cols=feature_cols,
            method=method,
            winsorize_pct=winsorize_pct,
            min_obs=min_obs,
        )
        result_parts.append(normalized)

    if not result_parts:
        return df.copy()

    return pd.concat(result_parts, axis=0).reset_index(drop=True)
