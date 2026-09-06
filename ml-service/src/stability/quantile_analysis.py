"""
Phase 3I — Quantile / Decile Stability Analysis.

Tracks whether quantile ordering is monotonic and stable through time.
Extends the existing Phase 3E decile analysis with temporal decay.

Design rules
------------
1. Quantile assignment is per-timestamp (cross-sectional) — no lookahead.
2. Temporal split into early/middle/recent is determined by the data only.
3. Top-bottom spread is reported in gross AND net-of-cost terms.
4. INSUFFICIENT_EVIDENCE is returned when sample size < MIN_SAMPLE.
5. No np.random.* — deterministic.

Reuses
------
- `src.ranking.evaluation.compute_decile_report()` for per-window analysis.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd
from scipy.stats import linregress

from .schemas import (
    DecayStatus,
    EvidenceLevel,
    MonotonicityState,
    QuantileDecayResult,
    QuantileWindowResult,
)


MIN_SAMPLE       = 10
MIN_TREND_SAMPLE = 5


def _evidence_level(n: int) -> EvidenceLevel:
    if n >= 100: return EvidenceLevel.STRONG
    if n >= 30:  return EvidenceLevel.MODERATE
    if n >= 10:  return EvidenceLevel.WEAK
    return EvidenceLevel.INSUFFICIENT


def _monotonicity_state(score: Optional[float]) -> MonotonicityState:
    """Classify monotonicity from Spearman correlation."""
    if score is None:
        return MonotonicityState.INSUFFICIENT_EVIDENCE
    if score >= 0.80:
        return MonotonicityState.MONOTONIC
    if score >= 0.50:
        return MonotonicityState.WEAKENING
    if score >= 0:
        return MonotonicityState.NON_MONOTONIC
    return MonotonicityState.REVERSED


def _build_window_result(
    panel_df: pd.DataFrame,
    score_col: str,
    realized_col: str,
    timestamp_col: str,
    window_label: str,
    n_quantiles: int,
    cost_col: Optional[str],
) -> QuantileWindowResult:
    """Compute quantile stats for a subset of the panel DataFrame."""
    from src.ranking.evaluation import compute_decile_report

    n_obs = len(panel_df.dropna(subset=[score_col, realized_col]))

    if n_obs < MIN_SAMPLE:
        empty_q = {i: None for i in range(1, n_quantiles + 1)}
        return QuantileWindowResult(
            window_label=window_label,
            n_observations=n_obs,
            q_returns=empty_q,
            top_bottom_spread=None,
            monotonicity_score=None,
            monotonicity_state=MonotonicityState.INSUFFICIENT_EVIDENCE,
        )

    report = compute_decile_report(
        panel_df=panel_df,
        score_col=score_col,
        realized_col=realized_col,
        timestamp_col=timestamp_col,
        n_deciles=n_quantiles,
        min_cs_size=MIN_SAMPLE,
    )

    q_returns = {s.decile: s.mean_return for s in report.deciles}
    mono = _monotonicity_state(report.monotonicity_score)

    return QuantileWindowResult(
        window_label=window_label,
        n_observations=n_obs,
        q_returns=q_returns,
        top_bottom_spread=report.top_bottom_spread,
        monotonicity_score=report.monotonicity_score,
        monotonicity_state=mono,
    )


def analyse_quantile_decay(
    panel_df: pd.DataFrame,
    score_col: str,
    realized_col: str,
    timestamp_col: str,
    signal_id: str,
    horizon_bars: int,
    n_quantiles: int = 5,
    cost_col: Optional[str] = None,
) -> QuantileDecayResult:
    """
    Full quantile stability analysis through time.

    Parameters
    ----------
    panel_df      : long-format DataFrame with scores, realized returns, timestamps
    score_col     : alpha score column
    realized_col  : realized return column (PIT: T+horizon returns, aligned to signal T)
    timestamp_col : signal timestamp column
    signal_id     : identifier
    horizon_bars  : prediction horizon
    n_quantiles   : number of quantile buckets (default 5 = quintiles)
    cost_col      : cost column for net spread (optional)

    PIT invariant
    -------------
    realized_col must already be the T+horizon return for the T-timestamp signal.
    The panel_df is the caller's responsibility to be PIT-correct.
    Future realized returns are ONLY used as evaluation labels, not as inputs
    to the cross-sectional score assignment (which uses score_col at time T only).

    Returns
    -------
    QuantileDecayResult
    """
    panel_df = panel_df.copy()
    valid = panel_df.dropna(subset=[score_col, realized_col])
    n_total = len(valid)

    # ── Full period ───────────────────────────────────────────────────────────
    full = _build_window_result(
        valid, score_col, realized_col, timestamp_col,
        "FULL", n_quantiles, cost_col,
    )

    # ── Temporal split ────────────────────────────────────────────────────────
    timestamps = sorted(valid[timestamp_col].unique())
    n_ts = len(timestamps)
    early = middle = recent = None

    if n_ts >= 6:  # need at least 2 per split for meaningful analysis
        s1, s2 = n_ts // 3, 2 * n_ts // 3
        ts_early  = timestamps[:s1]
        ts_mid    = timestamps[s1:s2]
        ts_recent = timestamps[s2:]

        df_early  = valid[valid[timestamp_col].isin(ts_early)]
        df_mid    = valid[valid[timestamp_col].isin(ts_mid)]
        df_recent = valid[valid[timestamp_col].isin(ts_recent)]

        early  = _build_window_result(df_early,  score_col, realized_col, timestamp_col, "EARLY",  n_quantiles, cost_col)
        middle = _build_window_result(df_mid,    score_col, realized_col, timestamp_col, "MIDDLE", n_quantiles, cost_col)
        recent = _build_window_result(df_recent, score_col, realized_col, timestamp_col, "RECENT", n_quantiles, cost_col)

    # ── Spread decay trend ────────────────────────────────────────────────────
    spreads = []
    for w in [early, middle, recent]:
        if w is not None and w.top_bottom_spread is not None:
            spreads.append(w.top_bottom_spread)

    spread_slope = None
    if len(spreads) >= MIN_TREND_SAMPLE:
        x = np.arange(len(spreads), dtype=float)
        result = linregress(x, spreads)
        spread_slope = float(result.slope)

    # ── Net spread ────────────────────────────────────────────────────────────
    net_spread = full.top_bottom_spread
    cost_adj_spread = None
    if cost_col and cost_col in panel_df.columns and full.top_bottom_spread is not None:
        avg_cost = float(panel_df[cost_col].dropna().mean())
        cost_adj_spread = full.top_bottom_spread - 2 * avg_cost

    # ── Decay status ──────────────────────────────────────────────────────────
    evidence = _evidence_level(n_total)

    if evidence == EvidenceLevel.INSUFFICIENT:
        decay = DecayStatus.INSUFFICIENT_EVIDENCE
    elif full.monotonicity_state == MonotonicityState.REVERSED:
        decay = DecayStatus.FAILED
    elif full.monotonicity_state == MonotonicityState.NON_MONOTONIC:
        decay = DecayStatus.SIGNIFICANT_DECAY
    elif full.monotonicity_state == MonotonicityState.WEAKENING:
        decay = DecayStatus.MILD_DECAY
    elif full.monotonicity_state == MonotonicityState.MONOTONIC:
        decay = DecayStatus.STABLE
    else:
        decay = DecayStatus.INSUFFICIENT_EVIDENCE

    return QuantileDecayResult(
        signal_id=signal_id,
        horizon_bars=horizon_bars,
        n_quantiles=n_quantiles,
        full_period=full,
        early=early,
        middle=middle,
        recent=recent,
        spread_trend_slope=spread_slope,
        net_spread=net_spread,
        cost_adjusted_spread=cost_adj_spread,
        decay_status=decay,
        evidence=evidence,
    )
