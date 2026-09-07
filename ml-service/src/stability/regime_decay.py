"""
Phase 3I — Regime-Conditional Decay Analysis.

Evaluates alpha IC, EV, and returns separately by market regime.
Also analyses regime transitions and sector-conditional stability.

Design rules
------------
1. Each regime is treated as an independent stratification — no look-ahead.
   Regime label at timestamp T must come from data ≤ T.
2. Regime statistics are only reported when n >= MIN_SAMPLE.
   Smaller samples return INSUFFICIENT_EVIDENCE.
3. Regime transitions use adjacent (T, T+1) pairs where the regime changes.
4. Sector IC requires per-sector grouping — sector label at T must be PIT.
5. No np.random.* — deterministic.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from .schemas import (
    DecayStatus,
    EvidenceLevel,
    RegimeDecayResult,
    RegimeICStats,
    RegimeTransitionResult,
)


MIN_SAMPLE  = 10
MIN_REGIME_DATES = 5


def _evidence_level(n: int) -> EvidenceLevel:
    if n >= 100: return EvidenceLevel.STRONG
    if n >= 30:  return EvidenceLevel.MODERATE
    if n >= 10:  return EvidenceLevel.WEAK
    return EvidenceLevel.INSUFFICIENT


def _compute_ic(scores: np.ndarray, realized: np.ndarray) -> Optional[float]:
    from src.ranking.evaluation import compute_rank_ic
    mask = np.isfinite(scores) & np.isfinite(realized)
    if mask.sum() < 5:
        return None
    return compute_rank_ic(scores[mask], realized[mask])


def analyse_regime_decay(
    panel_df: pd.DataFrame,
    score_col: str,
    realized_col: str,
    regime_col: str,
    timestamp_col: str,
    signal_id: str,
    horizon_bars: int,
    ev_col: Optional[str] = None,
    sector_col: Optional[str] = None,
) -> RegimeDecayResult:
    """
    Compute IC statistics stratified by market regime.

    Parameters
    ----------
    panel_df      : long-format panel with scores, returns, regime labels
    score_col     : alpha score column
    realized_col  : realized return column (T+horizon, PIT-correct)
    regime_col    : market regime label at signal timestamp T (PIT: regime ≤ T)
    timestamp_col : signal timestamp column
    signal_id     : identifier
    horizon_bars  : prediction horizon
    ev_col        : expected value column (optional)
    sector_col    : sector column for sector IC (optional)

    PIT invariant
    -------------
    regime_col must be the regime AT timestamp T, not T+horizon.
    The regime labels must have been computed from data available at T.
    realized_col is only used for evaluation — not as input to scores/regime.

    Returns
    -------
    RegimeDecayResult
    """
    valid = panel_df.dropna(subset=[score_col, realized_col, regime_col]).copy()

    # ── Per-regime IC ─────────────────────────────────────────────────────────
    regime_stats: list[RegimeICStats] = []
    regimes = sorted(valid[regime_col].unique())

    for regime in regimes:
        mask = valid[regime_col] == regime
        grp  = valid[mask]
        n    = len(grp)
        n_dates = grp[timestamp_col].nunique() if timestamp_col in grp.columns else n

        if n < MIN_SAMPLE:
            regime_stats.append(RegimeICStats(
                regime=str(regime), n_observations=n, n_unique_dates=n_dates,
                mean_ic=None, mean_rank_ic=None, icir=None, positive_ic_pct=None,
                mean_ev=None, mean_net_return=None,
                evidence=EvidenceLevel.INSUFFICIENT,
            ))
            continue

        s = grp[score_col].to_numpy(dtype=float)
        r = grp[realized_col].to_numpy(dtype=float)
        ic = _compute_ic(s, r)

        # Per-timestamp IC within regime
        ts_ic_vals = []
        if timestamp_col in grp.columns:
            for ts, sub in grp.groupby(timestamp_col, sort=True):
                if len(sub) >= 5:
                    sub_ic = _compute_ic(
                        sub[score_col].to_numpy(dtype=float),
                        sub[realized_col].to_numpy(dtype=float),
                    )
                    if sub_ic is not None:
                        ts_ic_vals.append(sub_ic)

        icir = None
        pos_pct = None
        if len(ts_ic_vals) >= 3:
            arr = np.array(ts_ic_vals)
            mu  = float(np.mean(arr))
            sig = float(np.std(arr, ddof=1))
            icir    = mu / sig if sig > 1e-10 else None
            pos_pct = float((arr > 0).sum() / len(arr) * 100.0)

        mean_ev = None
        if ev_col and ev_col in grp.columns:
            ev_valid = grp[ev_col].dropna().to_numpy(dtype=float)
            if len(ev_valid) > 0:
                mean_ev = round(float(np.mean(ev_valid)), 6)

        regime_stats.append(RegimeICStats(
            regime=str(regime),
            n_observations=n,
            n_unique_dates=n_dates,
            mean_ic=round(ic, 6) if ic else None,
            mean_rank_ic=round(ic, 6) if ic else None,
            icir=round(icir, 6) if icir else None,
            positive_ic_pct=round(pos_pct, 2) if pos_pct else None,
            mean_ev=mean_ev,
            mean_net_return=None,  # net return requires cost data
            evidence=_evidence_level(n),
        ))

    # ── Regime transition analysis ────────────────────────────────────────────
    transitions: list[RegimeTransitionResult] = []
    if timestamp_col in valid.columns:
        ts_regimes = (
            valid.drop_duplicates(subset=[timestamp_col])
                 .sort_values(timestamp_col)[[timestamp_col, regime_col]]
        )
        ts_regimes = ts_regimes.reset_index(drop=True)

        from collections import defaultdict
        trans_data: dict = defaultdict(list)

        for i in range(len(ts_regimes) - 1):
            r_from = str(ts_regimes.iloc[i][regime_col])
            r_to   = str(ts_regimes.iloc[i + 1][regime_col])
            if r_from != r_to:
                trans_data[(r_from, r_to)].append(i)

        for (r_from, r_to), idxs in trans_data.items():
            n_trans = len(idxs)

            # IC in a window around transitions
            before_ics = []
            after_ics  = []
            for idx in idxs:
                ts_b = ts_regimes.iloc[max(0, idx - 5):idx + 1][timestamp_col].tolist()
                ts_a = ts_regimes.iloc[idx + 1:idx + 6][timestamp_col].tolist()
                for ts_list, ic_list in [(ts_b, before_ics), (ts_a, after_ics)]:
                    sub = valid[valid[timestamp_col].isin(ts_list)]
                    if len(sub) >= 5:
                        sub_ic = _compute_ic(
                            sub[score_col].to_numpy(dtype=float),
                            sub[realized_col].to_numpy(dtype=float),
                        )
                        if sub_ic is not None:
                            ic_list.append(sub_ic)

            ic_b = float(np.mean(before_ics)) if before_ics else None
            ic_a = float(np.mean(after_ics))  if after_ics  else None
            ic_chg = (ic_a - ic_b) if (ic_a is not None and ic_b is not None) else None

            status = "INSUFFICIENT_EVIDENCE"
            if ic_b is not None and ic_a is not None:
                if ic_a >= ic_b * 0.90:
                    status = "SURVIVES"
                elif ic_a >= 0:
                    status = "WEAKENS"
                else:
                    status = "REVERSES"

            transitions.append(RegimeTransitionResult(
                from_regime=r_from, to_regime=r_to,
                n_transitions=n_trans,
                ic_before=round(ic_b, 6) if ic_b else None,
                ic_after=round(ic_a, 6) if ic_a else None,
                ic_change=round(ic_chg, 6) if ic_chg else None,
                status=status,
            ))

    # ── Sector IC ─────────────────────────────────────────────────────────────
    sector_ic: dict[str, Optional[float]] = {}
    dominant_sector = None

    if sector_col and sector_col in valid.columns:
        for sector, sub in valid.groupby(sector_col):
            if len(sub) < MIN_SAMPLE:
                sector_ic[str(sector)] = None
                continue
            ic = _compute_ic(
                sub[score_col].to_numpy(dtype=float),
                sub[realized_col].to_numpy(dtype=float),
            )
            sector_ic[str(sector)] = round(ic, 6) if ic else None

        # Dominant sector: highest IC with sufficient data
        valid_sector_ics = {k: v for k, v in sector_ic.items() if v is not None}
        if valid_sector_ics:
            dominant_sector = max(valid_sector_ics, key=lambda k: abs(valid_sector_ics[k]))

    return RegimeDecayResult(
        signal_id=signal_id,
        horizon_bars=horizon_bars,
        regime_stats=regime_stats,
        transitions=transitions,
        sector_ic=sector_ic,
        dominant_sector=dominant_sector,
        notes=f"{len(regime_stats)} regimes analyzed; {len(transitions)} transition pairs.",
    )
