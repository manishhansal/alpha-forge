"""
Cross-Sectional Neutralization — Phase 3E.

Decomposes return (or alpha score) into:
    target = factor_exposure + residual

and retains only the residual as the neutralized signal.

Available neutralizations
--------------------------
sector_neutralize  : Removes sector mean from each stock's return
beta_neutralize    : Removes market-beta-adjusted component
factor_neutralize  : General OLS neutralization against any factor matrix

PIT contract (MANDATORY)
-------------------------
All neutralization parameters (sector membership, beta estimates)
must be derived from data available at or before the training period
boundary.  Never estimate beta using future returns.

Leakage rule
------------
If neutralization uses cross-sectional regression at timestamp t:
    - Only information available at t (features, PIT sector) may define
      contemporaneous exposures.
    - Future target values CANNOT enter the exposure estimation.

Fold contract
-------------
Neutralization models (e.g. OLS beta) must be fitted on the training fold
ONLY and applied unchanged to val/test folds.  Never refit on val or test.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd


NEUTRALIZATION_VERSION = "cs_neutral-v1"


# ── Sector neutralization ─────────────────────────────────────────────────────

def sector_neutralize(
    returns: pd.Series,
    sector_map: dict[str, str],
    min_sector_size: int = 2,
) -> pd.Series:
    """
    Remove sector mean from each stock's return.

    Y_residual_i = Y_i - mean(Y_sector(i))

    Parameters
    ----------
    returns     : pd.Series indexed by instrument_id.
    sector_map  : {instrument_id: sector_name} — MUST be PIT (historical membership).
    min_sector_size : Minimum stocks per sector for mean computation.
                     Stocks in singleton sectors remain unneutralized.

    Returns
    -------
    pd.Series of residuals, same index as returns.
    NaN returns remain NaN.

    Leakage guarantee
    -----------------
    sector_map must represent membership at prediction timestamp t.
    A company reclassified in 2025 must NOT use its 2025 sector for 2020 data.
    """
    residuals = returns.copy()
    sector_groups: dict[str, list[str]] = {}
    for sym in returns.index:
        sec = sector_map.get(sym)
        if sec:
            sector_groups.setdefault(sec, []).append(sym)

    for sec, members in sector_groups.items():
        valid = [m for m in members if m in returns.index and _isfinite(returns[m])]
        if len(valid) < min_sector_size:
            continue
        sec_mean = float(np.mean([returns[m] for m in valid]))
        for m in valid:
            residuals[m] = returns[m] - sec_mean

    return residuals


def sector_neutralize_panel(
    df: pd.DataFrame,
    target_col: str,
    timestamp_col: str,
    sector_col: str,
    min_sector_size: int = 2,
) -> pd.DataFrame:
    """
    Apply sector neutralization to a panel DataFrame, independently per timestamp.

    Parameters
    ----------
    df           : Long panel with timestamp_col, sector_col, instrument_id, target_col.
    target_col   : Column to neutralize (e.g. 'raw_return' or 'excess_return').
    timestamp_col: Grouping column.
    sector_col   : PIT sector membership column.
    min_sector_size : Minimum stocks per sector.

    Returns
    -------
    DataFrame with an additional column `{target_col}_neutralized`.
    """
    result_parts = []
    for ts, group in df.groupby(timestamp_col, sort=True):
        g = group.copy()
        returns = pd.Series(g[target_col].values, index=g["instrument_id"].values)
        sector_map = dict(zip(g["instrument_id"], g[sector_col]))
        neutralized = sector_neutralize(returns, sector_map, min_sector_size)
        g[f"{target_col}_neutralized"] = g["instrument_id"].map(neutralized)
        result_parts.append(g)

    if not result_parts:
        return df.copy()
    return pd.concat(result_parts, axis=0).reset_index(drop=True)


# ── Beta neutralization ───────────────────────────────────────────────────────

@dataclass
class BetaEstimate:
    """
    Per-instrument rolling beta estimate, fitted on training data only.

    beta     : β = cov(stock, market) / var(market)
    r_squared: Goodness of fit
    lookback : Bars used for estimation
    """
    instrument_id: str
    beta:          float
    r_squared:     float
    lookback:      int


def estimate_rolling_betas(
    stock_close_map: dict[str, pd.Series],
    market_close: pd.Series,
    lookback: int = 60,
    min_obs: int = 20,
) -> dict[str, pd.Series]:
    """
    Estimate rolling market beta for each stock.

    beta_i(t) = cov(ret_i[t-lookback..t], ret_m[t-lookback..t]) /
                var(ret_m[t-lookback..t])

    Uses ONLY data up to and including t.  Never uses future returns.

    Parameters
    ----------
    stock_close_map : {symbol: close_series} — UTC DatetimeIndex.
    market_close    : Market (NIFTY) close series.
    lookback        : Rolling window in bars.
    min_obs         : Minimum finite returns required.

    Returns
    -------
    {symbol: pd.Series of beta values indexed like the stock close series}.
    NaN where insufficient history.
    """
    mkt_ret = market_close.pct_change()
    result: dict[str, pd.Series] = {}

    for sym, close in stock_close_map.items():
        stk_ret = close.pct_change()
        # Align to common index
        common = stk_ret.index.intersection(mkt_ret.index)
        s = stk_ret.reindex(common)
        m = mkt_ret.reindex(common)

        betas = pd.Series(np.nan, index=common)
        for i in range(lookback, len(common)):
            s_win = s.iloc[i - lookback : i].to_numpy()
            m_win = m.iloc[i - lookback : i].to_numpy()
            mask  = np.isfinite(s_win) & np.isfinite(m_win)
            if mask.sum() < min_obs:
                continue
            sv, mv = s_win[mask], m_win[mask]
            var_m  = float(np.var(mv, ddof=1))
            if var_m < 1e-12:
                continue
            betas.iloc[i] = float(np.cov(sv, mv)[0, 1] / var_m)

        result[sym] = betas.reindex(close.index)

    return result


def beta_neutralize(
    returns: pd.Series,
    market_return: float,
    beta_map: dict[str, float],
) -> pd.Series:
    """
    Remove market-beta component from each stock's return.

    Y_residual_i = Y_i - beta_i × market_return

    Parameters
    ----------
    returns       : {symbol: return} at a single timestamp t.
    market_return : Market (NIFTY) return over the same horizon.
    beta_map      : {symbol: beta} — must be estimated BEFORE t.

    Returns
    -------
    pd.Series of beta-neutralized residuals.

    Leakage guarantee
    -----------------
    beta_map must be the rolling beta AT t-1 (lagged one period relative
    to the returns being neutralized).  Never re-estimate beta using
    the same horizon as the target return.
    """
    residuals = returns.copy()
    for sym in returns.index:
        b = beta_map.get(sym)
        if b is None or not _isfinite(b):
            continue
        if not _isfinite(returns[sym]):
            continue
        residuals[sym] = returns[sym] - b * market_return
    return residuals


# ── General factor neutralization ────────────────────────────────────────────

def factor_neutralize(
    returns: np.ndarray,
    factor_matrix: np.ndarray,
    ridge_alpha: float = 1e-4,
) -> np.ndarray:
    """
    OLS (optionally ridge-penalized) neutralization of returns against factors.

    Y_residual = Y - F @ (F'F + αI)^{-1} F'Y

    Parameters
    ----------
    returns       : (n,) array of stock returns / scores.
    factor_matrix : (n, k) matrix of factor exposures (e.g. sector dummies,
                    beta, size).  Must NOT contain future information.
    ridge_alpha   : Ridge penalty for numerical stability.

    Returns
    -------
    (n,) residualized array.

    Fold contract
    -------------
    factor_matrix exposures must be derived from data available at or
    before the training/prediction timestamp.  Sector membership must be PIT.
    """
    F = factor_matrix.astype(float)
    Y = returns.astype(float)
    n, k = F.shape

    # Ridge: (F'F + αI)^{-1} F'Y
    FtF  = F.T @ F + ridge_alpha * np.eye(k)
    FtY  = F.T @ Y
    try:
        coeffs = np.linalg.solve(FtF, FtY)
    except np.linalg.LinAlgError:
        return Y  # cannot neutralize; return original

    return Y - F @ coeffs


def sector_dummies(
    symbols: list[str],
    sector_map: dict[str, str],
) -> np.ndarray:
    """
    Build sector dummy matrix (n_stocks × n_sectors).

    Each row has a 1 in the column corresponding to the stock's sector,
    and 0 elsewhere.  Stocks with no sector mapping get all-zero rows.
    """
    sectors = sorted(set(v for v in sector_map.values() if v))
    sec_idx = {s: i for i, s in enumerate(sectors)}
    F = np.zeros((len(symbols), len(sectors)), dtype=float)
    for i, sym in enumerate(symbols):
        sec = sector_map.get(sym)
        if sec and sec in sec_idx:
            F[i, sec_idx[sec]] = 1.0
    return F


def _isfinite(v) -> bool:
    import math
    return isinstance(v, (int, float)) and math.isfinite(v)
