"""
Phase 3I — IC Decay Analysis.

Computes IC decay, rolling ICIR, forward-horizon decay, and half-life.

Design rules
------------
1. IC is computed CROSS-SECTIONALLY per timestamp (not globally).
   Temporal analysis layers ON TOP of the per-timestamp IC series.
2. Rolling windows are configurable — no hardcoded values.
3. Half-life is estimated only when the autocorrelation fit is valid;
   otherwise HALF_LIFE_INSUFFICIENT_EVIDENCE is returned.
4. PIT: realized returns at timestamp T must come from T + horizon.
   The caller is responsible for supplying PIT-correct realized_col values.
5. No np.random.* — all analysis is deterministic.
6. INSUFFICIENT_EVIDENCE is returned when sample size < MIN_SAMPLE.

Reuses
------
- `src.ranking.evaluation.compute_ic_series()` for the IC time series.
- `scipy.stats.linregress` for IC trend slope and p-value.
- `scipy.stats.pearsonr` for lag-1 autocorrelation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
from scipy.stats import linregress, pearsonr

from .schemas import (
    ChangePointStatus,
    DecayStatus,
    EvidenceLevel,
    HalfLifeStatus,
    ICDecayResult,
    RollingICWindow,
    TemporalPeriod,
)


# ── Constants ─────────────────────────────────────────────────────────────────

MIN_IC_SAMPLE             = 10    # minimum observations for any IC statistic
MIN_HALF_LIFE_SAMPLE      = 20    # minimum for autocorrelation-based half-life
MIN_TREND_SAMPLE          = 15    # minimum for linregress
MIN_CHANGEPOINT_SAMPLE    = 20    # minimum for CUSUM
CUSUM_SENSITIVITY         = 0.5   # CUSUM threshold multiplier (× std)


# ── Evidence level classifier ────────────────────────────────────────────────

def _evidence_level(n: int) -> EvidenceLevel:
    if n >= 100:
        return EvidenceLevel.STRONG
    if n >= 30:
        return EvidenceLevel.MODERATE
    if n >= 10:
        return EvidenceLevel.WEAK
    return EvidenceLevel.INSUFFICIENT


# ── IC summary helpers ────────────────────────────────────────────────────────

def _ic_stats(ic_vals: np.ndarray) -> tuple:
    """Return (mean, icir, positive_pct) or (None, None, None)."""
    valid = ic_vals[np.isfinite(ic_vals)]
    n = len(valid)
    if n < MIN_IC_SAMPLE:
        return None, None, None
    mu  = float(np.mean(valid))
    sig = float(np.std(valid, ddof=1)) if n > 1 else 0.0
    icir = mu / sig if sig > 1e-10 else None
    pos_pct = float((valid > 0).sum() / n * 100.0)
    return mu, icir, pos_pct


# ── Rolling ICIR ─────────────────────────────────────────────────────────────

def rolling_ic_windows(
    ic_series: pd.Series,
    window: int,
) -> list[RollingICWindow]:
    """
    Compute rolling ICIR over a moving window of `window` observations.

    Parameters
    ----------
    ic_series : pd.Series indexed by timestamp (NaN where no valid IC)
    window    : number of observations per window

    Returns
    -------
    List of RollingICWindow, one per valid rolling position.
    PIT guarantee: each window uses only the IC values in [t-window, t],
    which are themselves computed from features ≤ t and returns > t.
    """
    results: list[RollingICWindow] = []
    timestamps = list(ic_series.index)
    values     = ic_series.to_numpy(dtype=float)
    n          = len(values)

    for end in range(window - 1, n):
        start = end - window + 1
        window_vals = values[start:end + 1]
        valid = window_vals[np.isfinite(window_vals)]
        n_valid = len(valid)

        if n_valid < MIN_IC_SAMPLE:
            continue

        mu   = float(np.mean(valid))
        sig  = float(np.std(valid, ddof=1)) if n_valid > 1 else 0.0
        icir = mu / sig if sig > 1e-10 else None
        pos  = float((valid > 0).sum() / n_valid * 100.0)

        results.append(RollingICWindow(
            window_start=timestamps[start],
            window_end=timestamps[end],
            n_observations=n_valid,
            mean_ic=round(mu, 6),
            mean_rank_ic=None,   # caller can pass rank_ic_series separately
            icir=round(icir, 6) if icir else None,
            positive_ic_pct=round(pos, 2),
            evidence=_evidence_level(n_valid),
        ))

    return results


def rolling_rank_ic_windows(
    ic_series: pd.Series,
    rank_ic_series: pd.Series,
    window: int,
) -> list[RollingICWindow]:
    """
    Compute rolling windows for both Pearson IC and Rank IC.
    Both series must share the same index.
    """
    results: list[RollingICWindow] = []
    timestamps = list(ic_series.index)
    ic_vals  = ic_series.reindex(timestamps).to_numpy(dtype=float)
    ric_vals = rank_ic_series.reindex(timestamps).to_numpy(dtype=float)
    n = len(ic_vals)

    for end in range(window - 1, n):
        start = end - window + 1
        ic_w   = ic_vals[start:end + 1]
        ric_w  = ric_vals[start:end + 1]
        valid_ic  = ic_w[np.isfinite(ic_w)]
        valid_ric = ric_w[np.isfinite(ric_w)]

        n_valid = min(len(valid_ic), len(valid_ric))
        if n_valid < MIN_IC_SAMPLE:
            continue

        mu_ic   = float(np.mean(valid_ic)) if len(valid_ic) >= MIN_IC_SAMPLE else None
        mu_ric  = float(np.mean(valid_ric)) if len(valid_ric) >= MIN_IC_SAMPLE else None
        sig_ric = float(np.std(valid_ric, ddof=1)) if len(valid_ric) > 1 else 0.0
        icir    = (mu_ric / sig_ric) if (mu_ric is not None and sig_ric > 1e-10) else None
        pos_ric = float((valid_ric > 0).sum() / len(valid_ric) * 100.0) if len(valid_ric) > 0 else None

        results.append(RollingICWindow(
            window_start=timestamps[start],
            window_end=timestamps[end],
            n_observations=n_valid,
            mean_ic=round(mu_ic, 6) if mu_ic is not None else None,
            mean_rank_ic=round(mu_ric, 6) if mu_ric is not None else None,
            icir=round(icir, 6) if icir else None,
            positive_ic_pct=round(pos_ric, 2) if pos_ric is not None else None,
            evidence=_evidence_level(n_valid),
        ))

    return results


# ── IC trend (linear regression) ─────────────────────────────────────────────

def ic_trend_slope(ic_series: pd.Series) -> tuple[Optional[float], Optional[float]]:
    """
    Fit a linear regression on the IC time series to estimate IC trend.

    Returns (slope, p_value).
    - Negative slope → IC is decaying over time
    - p_value < 0.05 → statistically significant trend

    PIT: uses only the IC values already computed cross-sectionally.
    No future information enters here.
    """
    valid = ic_series.dropna().to_numpy(dtype=float)
    n = len(valid)
    if n < MIN_TREND_SAMPLE:
        return None, None

    x = np.arange(n, dtype=float)
    result = linregress(x, valid)
    return float(result.slope), float(result.pvalue)


# ── IC autocorrelation (lag-1) ────────────────────────────────────────────────

def ic_autocorrelation(
    ic_series: pd.Series,
    max_lag: int = 5,
) -> dict[int, Optional[float]]:
    """
    Compute Pearson autocorrelation of the IC series at lags 1..max_lag.

    High positive autocorrelation → IC is persistent (good).
    Near-zero / negative autocorrelation → IC is noisy or reversing.

    PIT: each IC[t] was computed from data ≤ t; autocorrelation analyzes
    the sequence of these values — no future leakage.
    """
    valid = ic_series.dropna().to_numpy(dtype=float)
    n = len(valid)
    result: dict[int, Optional[float]] = {}

    for lag in range(1, max_lag + 1):
        if n - lag < MIN_IC_SAMPLE:
            result[lag] = None
            continue
        r, _ = pearsonr(valid[:-lag], valid[lag:])
        result[lag] = round(float(r), 6)

    return result


# ── Half-life estimation ──────────────────────────────────────────────────────

def ic_half_life(
    ic_series: pd.Series,
    method: str = "autocorrelation",
) -> tuple[HalfLifeStatus, Optional[float]]:
    """
    Estimate alpha decay half-life.

    Method: autocorrelation decay
        Fit AR(1) on IC series: IC[t] = α + β × IC[t-1] + ε
        half_life = -log(2) / log(|β|)

    If β ≥ 1.0 (non-stationary) or β ≤ 0 (anti-persistent):
        HALF_LIFE_INSUFFICIENT_EVIDENCE

    Parameters
    ----------
    ic_series : pd.Series of IC values (NaN-filtered internally)
    method    : only "autocorrelation" supported currently

    Returns
    -------
    (HalfLifeStatus, half_life_in_bars | None)
    """
    valid = ic_series.dropna().to_numpy(dtype=float)
    n = len(valid)
    if n < MIN_HALF_LIFE_SAMPLE:
        return HalfLifeStatus.INSUFFICIENT_EVIDENCE, None

    # AR(1) regression: IC[t] ~ beta * IC[t-1]
    y = valid[1:]
    x = valid[:-1]
    result = linregress(x, y)
    beta = float(result.slope)

    # Valid only when 0 < |beta| < 1 (stationary, persistent)
    if abs(beta) >= 1.0 or beta <= 0:
        return HalfLifeStatus.INSUFFICIENT_EVIDENCE, None

    hl = -math.log(2) / math.log(beta)
    return HalfLifeStatus.ESTIMABLE, round(hl, 2)


# ── CUSUM change-point detection ──────────────────────────────────────────────

def cusum_changepoint(
    series: np.ndarray,
    sensitivity: float = CUSUM_SENSITIVITY,
) -> tuple[ChangePointStatus, Optional[int]]:
    """
    CUSUM-based change-point detection on a time series.

    Algorithm
    ---------
    Cumulative sum of (x[t] - mean(x)).  A large positive deviation
    followed by a large negative deviation indicates a level shift.
    The change-point is at the index where CUSUM achieves its extremum
    AND the CUSUM range exceeds sensitivity × std(series).

    Parameters
    ----------
    series      : 1-D array (NaN-filtered before calling)
    sensitivity : multiplier on std; larger = less sensitive

    Returns
    -------
    (ChangePointStatus, change_point_index | None)
    """
    n = len(series)
    if n < MIN_CHANGEPOINT_SAMPLE:
        return ChangePointStatus.INSUFFICIENT_EVIDENCE, None

    mu    = float(np.mean(series))
    sigma = float(np.std(series, ddof=1))
    if sigma < 1e-12:
        return ChangePointStatus.NOT_DETECTED, None

    cusum = np.cumsum(series - mu)
    cusum_range = float(np.max(cusum) - np.min(cusum))

    if cusum_range < sensitivity * sigma:
        return ChangePointStatus.NOT_DETECTED, None

    # Change-point at maximum deviation
    cp_idx = int(np.argmax(np.abs(cusum)))
    return ChangePointStatus.DETECTED, cp_idx


# ── Forward-horizon decay ─────────────────────────────────────────────────────

@dataclass
class ForwardHorizonResult:
    """IC and return statistics for one forward horizon."""
    horizon_bars:       int
    n_observations:     int
    mean_ic:            Optional[float]
    mean_rank_ic:       Optional[float]
    icir:               Optional[float]
    hit_rate:           Optional[float]     # fraction of positive realized returns
    mean_return:        Optional[float]
    median_return:      Optional[float]
    mean_net_return:    Optional[float]
    evidence:           EvidenceLevel


def forward_horizon_decay(
    observations: "list",    # list[AlphaDecayObservation] — avoid circular import
    horizons: list[int],
    score_col: str = "alpha_score",
) -> list[ForwardHorizonResult]:
    """
    Evaluate IC and return statistics at multiple forward horizons.

    PIT invariant: realized_return at horizon H comes from T+H;
    the signal was generated at T — no lookahead possible by construction.

    Parameters
    ----------
    observations : list of AlphaDecayObservation with horizon_bars set
    horizons     : list of horizon values to evaluate
    score_col    : which score field to use ('alpha_score' or 'expected_value')

    Returns
    -------
    List of ForwardHorizonResult, one per horizon.
    """
    from .schemas import AlphaDecayObservation

    results = []
    for h in horizons:
        obs_h = [o for o in observations if o.horizon_bars == h and o.is_realized]
        n = len(obs_h)

        if n < MIN_IC_SAMPLE:
            results.append(ForwardHorizonResult(
                horizon_bars=h, n_observations=n,
                mean_ic=None, mean_rank_ic=None, icir=None,
                hit_rate=None, mean_return=None, median_return=None,
                mean_net_return=None, evidence=EvidenceLevel.INSUFFICIENT,
            ))
            continue

        # Build arrays — use NaN (not 0.0) for missing so they are excluded
        # from IC computation.  Spec §58: never replace missing evidence with 0.
        def _val(x):
            return float(x) if x is not None else np.nan

        scores    = np.array([_val(getattr(o, score_col)) for o in obs_h])
        realized  = np.array([_val(o.realized_return) for o in obs_h])
        net_rets  = np.array([_val(o.net_return) for o in obs_h])

        # Cross-sectional IC (treat all obs as one batch — horizon-specific).
        # compute_ic / compute_rank_ic mask non-finite pairs internally.
        from src.ranking.evaluation import compute_ic, compute_rank_ic
        ic      = compute_ic(scores, realized)
        rank_ic = compute_rank_ic(scores, realized)

        valid_r = realized[np.isfinite(realized)]
        hit_rate = float((valid_r > 0).sum() / len(valid_r)) if len(valid_r) > 0 else None

        # Simple ICIR from single-batch ic
        mu_ric  = rank_ic
        icir_v  = None  # single cross-section; ICIR requires a series

        results.append(ForwardHorizonResult(
            horizon_bars=h,
            n_observations=n,
            mean_ic=round(ic, 6) if ic else None,
            mean_rank_ic=round(rank_ic, 6) if rank_ic else None,
            icir=icir_v,
            hit_rate=round(hit_rate, 4) if hit_rate else None,
            mean_return=round(float(np.mean(valid_r)), 6) if len(valid_r) > 0 else None,
            median_return=round(float(np.median(valid_r)), 6) if len(valid_r) > 0 else None,
            mean_net_return=round(float(np.mean(net_rets[np.isfinite(net_rets)])), 6)
                            if len(net_rets[np.isfinite(net_rets)]) > 0 else None,
            evidence=_evidence_level(n),
        ))

    return results


# ── Temporal split helper ─────────────────────────────────────────────────────

def split_ic_series(
    ic_series: pd.Series,
) -> tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]:
    """
    Split IC series into early (first third), middle, recent (last third).
    Returns (early_vals, middle_vals, recent_vals).
    None if a slice has fewer than MIN_IC_SAMPLE observations.
    """
    vals = ic_series.dropna().to_numpy(dtype=float)
    n = len(vals)
    if n < MIN_IC_SAMPLE * 3:
        return None, None, None
    s1, s2 = n // 3, 2 * n // 3
    def _safe(arr):
        return arr if len(arr) >= MIN_IC_SAMPLE else None
    return _safe(vals[:s1]), _safe(vals[s1:s2]), _safe(vals[s2:])


# ── Main IC decay analysis ────────────────────────────────────────────────────

def analyse_ic_decay(
    ic_series: pd.Series,
    rank_ic_series: pd.Series,
    signal_id: str,
    horizon_bars: int,
    rolling_windows: list[int] = None,
) -> ICDecayResult:
    """
    Full IC decay analysis for one signal at one horizon.

    Parameters
    ----------
    ic_series       : pd.Series indexed by timestamp; Pearson IC per timestamp
    rank_ic_series  : pd.Series indexed by timestamp; Spearman Rank IC per timestamp
    signal_id       : signal identifier
    horizon_bars    : prediction horizon
    rolling_windows : list of window sizes for rolling ICIR (default [20, 60, 120])

    Returns
    -------
    ICDecayResult with all decay diagnostics.

    PIT guarantee: IC series values are computed from cross-sectional scores
    at timestamp T vs realized returns at T+horizon — no future data enters.
    """
    if rolling_windows is None:
        rolling_windows = [20, 60, 120]

    ic_vals  = ic_series.dropna().to_numpy(dtype=float)
    ric_vals = rank_ic_series.dropna().to_numpy(dtype=float)
    n_ts     = len(ic_series)

    # ── Full-period summary ───────────────────────────────────────────────────
    mean_ic, icir, pos_pct = _ic_stats(ic_vals)
    mean_ric, _, _ = _ic_stats(ric_vals)

    # ── Temporal splits ───────────────────────────────────────────────────────
    early_v, mid_v, recent_v = split_ic_series(rank_ic_series)

    def _safe_mean(arr):
        return round(float(np.mean(arr)), 6) if arr is not None else None

    early_mean  = _safe_mean(early_v)
    middle_mean = _safe_mean(mid_v)
    recent_mean = _safe_mean(recent_v)

    # ── IC trend (linregress) ─────────────────────────────────────────────────
    slope, pval = ic_trend_slope(rank_ic_series)

    # ── Autocorrelation ───────────────────────────────────────────────────────
    autocorr = ic_autocorrelation(rank_ic_series, max_lag=1)
    ac_lag1  = autocorr.get(1)

    # ── Half-life ─────────────────────────────────────────────────────────────
    hl_status, hl = ic_half_life(rank_ic_series)

    # ── CUSUM change-point ────────────────────────────────────────────────────
    valid_ric = rank_ic_series.dropna().to_numpy(dtype=float)
    cp_status, cp_idx = cusum_changepoint(valid_ric)

    # ── Rolling windows ───────────────────────────────────────────────────────
    rolling = []
    for w in rolling_windows:
        rolling.extend(rolling_ic_windows(rank_ic_series, window=w))

    # ── Decay status ──────────────────────────────────────────────────────────
    n_valid = len(ic_vals)
    evidence = _evidence_level(n_valid)

    if evidence == EvidenceLevel.INSUFFICIENT:
        decay = DecayStatus.INSUFFICIENT_EVIDENCE
    elif slope is not None and pval is not None and slope < -0.001 and pval < 0.05:
        decay = DecayStatus.SIGNIFICANT_DECAY
    elif recent_mean is not None and early_mean is not None:
        if early_mean > 0 and recent_mean < 0:
            decay = DecayStatus.FAILED
        elif early_mean > 0 and recent_mean < early_mean * 0.5:
            decay = DecayStatus.SIGNIFICANT_DECAY
        elif early_mean > 0 and recent_mean < early_mean * 0.75:
            decay = DecayStatus.MILD_DECAY
        else:
            decay = DecayStatus.STABLE
    elif mean_ic is not None and abs(mean_ic) > 0.02:
        decay = DecayStatus.STABLE
    else:
        decay = DecayStatus.INSUFFICIENT_EVIDENCE

    return ICDecayResult(
        signal_id=signal_id,
        horizon_bars=horizon_bars,
        n_timestamps=n_ts,
        mean_ic=round(mean_ic, 6) if mean_ic else None,
        mean_rank_ic=round(mean_ric, 6) if mean_ric else None,
        icir=round(icir, 6) if icir else None,
        positive_ic_pct=round(pos_pct, 2) if pos_pct else None,
        early_mean_ic=early_mean,
        middle_mean_ic=middle_mean,
        recent_mean_ic=recent_mean,
        ic_trend_slope=round(slope, 8) if slope else None,
        ic_trend_pvalue=round(pval, 6) if pval else None,
        ic_autocorr_lag1=ac_lag1,
        half_life_bars=hl,
        half_life_status=hl_status,
        change_point_status=cp_status,
        change_point_index=cp_idx,
        rolling_windows=rolling,
        decay_status=decay,
        evidence=evidence,
    )
