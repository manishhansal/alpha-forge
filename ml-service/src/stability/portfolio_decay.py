"""
Phase 3I — Portfolio Decay Analysis.

Tracks portfolio performance, concentration, turnover, and capacity
through time via configurable rolling windows.

Design rules
------------
1. Rolling windows are configurable — no hardcoded period sizes.
2. Sharpe, Sortino, max_dd, CVaR are computed from per-window return arrays.
3. Concentration (HHI, effective N) requires weight series through time.
4. Turnover and cost are tracked separately from alpha.
5. INSUFFICIENT_EVIDENCE when window has fewer than MIN_SAMPLE observations.
6. No np.random.* — deterministic.

Reuses
------
- `src.portfolio.analytics.PortfolioAnalytics.performance_metrics()` for per-window stats.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
from scipy.stats import linregress

from .schemas import (
    DecayStatus,
    EvidenceLevel,
    PortfolioDecayResult,
    PortfolioWindowMetrics,
)


MIN_SAMPLE = 10


def _evidence_level(n: int) -> EvidenceLevel:
    if n >= 60: return EvidenceLevel.STRONG
    if n >= 20: return EvidenceLevel.MODERATE
    if n >= 10: return EvidenceLevel.WEAK
    return EvidenceLevel.INSUFFICIENT


def _portfolio_metrics(
    returns: np.ndarray,
    turnover: Optional[np.ndarray],
    hhi_series: Optional[np.ndarray],
    risk_free_daily: float = 0.07 / 252,
    ann_factor: float = 252.0,
    window_label: str = "window",
) -> PortfolioWindowMetrics:
    """Compute portfolio metrics for one window."""
    n = len(returns)
    if n < MIN_SAMPLE:
        return PortfolioWindowMetrics(
            window_label=window_label, n_observations=n,
            gross_return=None, net_return=None, volatility_ann=None,
            sharpe=None, sortino=None, max_drawdown=None, cvar_95=None,
            turnover=None, cost_fraction=None, hhi=None, effective_n=None,
            evidence=EvidenceLevel.INSUFFICIENT,
        )

    ret = returns[np.isfinite(returns)]
    n_valid = len(ret)
    if n_valid < MIN_SAMPLE:
        return PortfolioWindowMetrics(
            window_label=window_label, n_observations=n,
            gross_return=None, net_return=None, volatility_ann=None,
            sharpe=None, sortino=None, max_drawdown=None, cvar_95=None,
            turnover=None, cost_fraction=None, hhi=None, effective_n=None,
            evidence=EvidenceLevel.INSUFFICIENT,
        )

    gross_ret = float(np.prod(1.0 + ret) - 1.0)
    vol_ann   = float(np.std(ret, ddof=1) * math.sqrt(ann_factor))

    excess    = ret - risk_free_daily
    sharpe    = float(np.mean(excess) / max(np.std(excess, ddof=1), 1e-12)) * math.sqrt(ann_factor)

    down = ret[ret < 0]
    down_std = float(np.std(down, ddof=1)) if len(down) > 1 else 0.0
    sortino  = float(np.mean(excess) / max(down_std, 1e-12)) * math.sqrt(ann_factor)

    cum = np.cumprod(1.0 + ret)
    running_max = np.maximum.accumulate(cum)
    dd = (cum - running_max) / running_max
    max_dd = float(np.min(dd))

    k = max(1, int(math.floor(0.05 * n_valid)))
    cvar_95 = float(-np.mean(np.sort(ret)[:k]))

    avg_turn = float(np.mean(turnover[np.isfinite(turnover)])) if turnover is not None and len(turnover) > 0 else None
    avg_hhi  = float(np.mean(hhi_series[np.isfinite(hhi_series)])) if hhi_series is not None and len(hhi_series) > 0 else None
    eff_n    = 1.0 / avg_hhi if avg_hhi and avg_hhi > 0 else None

    return PortfolioWindowMetrics(
        window_label=window_label,
        n_observations=n,
        gross_return=round(gross_ret, 6),
        net_return=None,       # net requires cost series
        volatility_ann=round(vol_ann, 6),
        sharpe=round(sharpe, 4),
        sortino=round(sortino, 4),
        max_drawdown=round(max_dd, 6),
        cvar_95=round(cvar_95, 6),
        turnover=round(avg_turn, 4) if avg_turn else None,
        cost_fraction=None,
        hhi=round(avg_hhi, 6) if avg_hhi else None,
        effective_n=round(eff_n, 2) if eff_n else None,
        evidence=_evidence_level(n_valid),
    )


def analyse_portfolio_decay(
    daily_returns: np.ndarray,
    strategy_id: str,
    turnover_series: Optional[np.ndarray] = None,
    hhi_series: Optional[np.ndarray] = None,
    cost_series: Optional[np.ndarray] = None,
    window_sizes: Optional[list[int]] = None,
    risk_free_daily: float = 0.07 / 252,
    ann_factor: float = 252.0,
) -> PortfolioDecayResult:
    """
    Rolling portfolio performance decay analysis.

    Parameters
    ----------
    daily_returns   : time-ordered daily portfolio returns (fraction)
    strategy_id     : strategy identifier
    turnover_series : daily turnover (optional, same length as daily_returns)
    hhi_series      : daily HHI (optional, same length)
    cost_series     : daily cost fraction (optional, same length)
    window_sizes    : rolling window sizes in bars (default [21, 63, 126, 252])
    risk_free_daily : risk-free rate per bar
    ann_factor      : annualisation factor

    PIT guarantee: daily_returns[t] is the return FOR day t — known AFTER
    day t. The analysis uses only past returns to compute rolling metrics.
    Rolling windows are left-aligned at each time point — no future returns
    enter the window computation.

    Returns
    -------
    PortfolioDecayResult
    """
    if window_sizes is None:
        window_sizes = [21, 63, 126, 252]

    n = len(daily_returns)
    windows: list[PortfolioWindowMetrics] = []

    # ── Full period ───────────────────────────────────────────────────────────
    full = _portfolio_metrics(
        daily_returns, turnover_series, hhi_series,
        risk_free_daily, ann_factor, "FULL",
    )
    windows.append(full)

    # ── Temporal splits ───────────────────────────────────────────────────────
    if n >= MIN_SAMPLE * 3:
        s1, s2 = n // 3, 2 * n // 3
        early_r   = daily_returns[:s1]
        middle_r  = daily_returns[s1:s2]
        recent_r  = daily_returns[s2:]
        early_t   = turnover_series[:s1] if turnover_series is not None else None
        middle_t  = turnover_series[s1:s2] if turnover_series is not None else None
        recent_t  = turnover_series[s2:] if turnover_series is not None else None
        early_h   = hhi_series[:s1] if hhi_series is not None else None
        middle_h  = hhi_series[s1:s2] if hhi_series is not None else None
        recent_h  = hhi_series[s2:] if hhi_series is not None else None

        windows.append(_portfolio_metrics(early_r,  early_t,  early_h,  risk_free_daily, ann_factor, "EARLY"))
        windows.append(_portfolio_metrics(middle_r, middle_t, middle_h, risk_free_daily, ann_factor, "MIDDLE"))
        windows.append(_portfolio_metrics(recent_r, recent_t, recent_h, risk_free_daily, ann_factor, "RECENT"))

    # ── Rolling windows ───────────────────────────────────────────────────────
    for w in window_sizes:
        if n < w:
            continue
        ret_w = daily_returns[n - w:]
        turn_w = turnover_series[n - w:] if turnover_series is not None else None
        hhi_w  = hhi_series[n - w:]      if hhi_series is not None else None
        windows.append(_portfolio_metrics(
            ret_w, turn_w, hhi_w, risk_free_daily, ann_factor,
            f"LAST_{w}D",
        ))

    # ── Trend slopes ─────────────────────────────────────────────────────────
    named = [w for w in windows if w.window_label in ("EARLY", "MIDDLE", "RECENT")]
    sharpe_slope   = None
    turnover_slope = None

    if len(named) >= 2:
        sharpes   = [w.sharpe for w in named if w.sharpe is not None]
        turnovers = [w.turnover for w in named if w.turnover is not None]

        if len(sharpes) >= 2:
            x = np.arange(len(sharpes), dtype=float)
            sharpe_slope = round(float(linregress(x, sharpes).slope), 6)
        if len(turnovers) >= 2:
            x = np.arange(len(turnovers), dtype=float)
            turnover_slope = round(float(linregress(x, turnovers).slope), 6)

    # ── Cost/edge ratio ───────────────────────────────────────────────────────
    cost_edge = None
    if cost_series is not None and full.gross_return is not None:
        avg_cost = float(np.nanmean(cost_series))
        edge     = full.gross_return
        cost_edge = round(avg_cost / max(abs(edge), 1e-10), 4) if edge != 0 else None

    # ── Decay status ──────────────────────────────────────────────────────────
    evidence = _evidence_level(n)
    if evidence == EvidenceLevel.INSUFFICIENT:
        decay = DecayStatus.INSUFFICIENT_EVIDENCE
    elif sharpe_slope is not None and sharpe_slope < -0.05:
        decay = DecayStatus.SIGNIFICANT_DECAY
    elif sharpe_slope is not None and sharpe_slope < -0.01:
        decay = DecayStatus.MILD_DECAY
    elif full.sharpe is not None and full.sharpe > 0.5:
        decay = DecayStatus.STABLE
    else:
        decay = DecayStatus.INSUFFICIENT_EVIDENCE

    return PortfolioDecayResult(
        strategy_id=strategy_id,
        windows=windows,
        sharpe_trend_slope=sharpe_slope,
        turnover_trend_slope=turnover_slope,
        cost_edge_ratio=cost_edge,
        decay_status=decay,
    )
