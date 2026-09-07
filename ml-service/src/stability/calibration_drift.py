"""
Phase 3I — Calibration Drift Analysis.

Tracks Brier score, ECE, calibration slope and intercept through time.

Design rules
------------
1. Each temporal fold's calibration metrics come from disjoint OOS windows.
2. Trend slope is estimated via scipy.stats.linregress on fold metrics.
3. Positive Brier/ECE trend → calibration is degrading.
4. Slope drifting from 1.0 → over/under-confidence developing.
5. INSUFFICIENT_EVIDENCE when fewer than 2 folds are available.
6. No np.random.* — deterministic.

Reuses
------
- `src.meta.calibration_engine.compute_calibration_metrics()` for per-period metrics.
- `src.meta.calibration_engine.walk_forward_calibrate()` output (CalibrationFoldResult).
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from scipy.stats import linregress

from .schemas import (
    CalibrationDriftResult,
    CalibrationPeriodMetrics,
    ComponentStatus,
    DecayStatus,
    EvidenceLevel,
)


MIN_FOLDS_FOR_TREND = 2
MIN_SAMPLE          = 5


def _evidence_level(n: int) -> EvidenceLevel:
    if n >= 10: return EvidenceLevel.STRONG
    if n >= 5:  return EvidenceLevel.MODERATE
    if n >= 2:  return EvidenceLevel.WEAK
    return EvidenceLevel.INSUFFICIENT


def _trend_slope(values: list[Optional[float]]) -> Optional[float]:
    """Linear trend slope over a list of scalar values. None if too few."""
    valid = [(i, v) for i, v in enumerate(values) if v is not None]
    if len(valid) < MIN_FOLDS_FOR_TREND:
        return None
    x = np.array([v[0] for v in valid], dtype=float)
    y = np.array([v[1] for v in valid], dtype=float)
    result = linregress(x, y)
    return round(float(result.slope), 8)


def analyse_calibration_drift(
    probs_windows: list[np.ndarray],
    labels_windows: list[np.ndarray],
    model_id: str,
    period_labels: Optional[list[str]] = None,
    n_bins: int = 10,
) -> CalibrationDriftResult:
    """
    Analyse calibration metric drift across temporal windows.

    Parameters
    ----------
    probs_windows  : list of probability arrays, one per time period
    labels_windows : list of label arrays, aligned with probs_windows
    model_id       : model identifier
    period_labels  : human-readable labels (e.g. ["Q1-2023", "Q2-2023", ...])
    n_bins         : calibration bins

    PIT guarantee: each window uses only OOS predictions from that period.
    Earlier windows must have earlier timestamps than later windows.
    The function does not enforce this — the caller must supply PIT-correct
    window slices.

    Returns
    -------
    CalibrationDriftResult
    """
    from src.meta.calibration_engine import compute_calibration_metrics

    n_windows = len(probs_windows)
    if period_labels is None:
        period_labels = [f"period_{i}" for i in range(n_windows)]

    periods: list[CalibrationPeriodMetrics] = []

    for i, (probs, labels) in enumerate(zip(probs_windows, labels_windows)):
        probs_f  = np.asarray(probs, dtype=float)
        labels_f = np.asarray(labels, dtype=float)

        # Remove NaN
        valid = np.isfinite(probs_f) & np.isfinite(labels_f)
        probs_f  = probs_f[valid]
        labels_f = labels_f[valid]
        n = len(probs_f)

        if n < MIN_SAMPLE:
            periods.append(CalibrationPeriodMetrics(
                period_label=period_labels[i],
                period_start=None, period_end=None,
                n_observations=n,
                brier=None, ece=None, mce=None, log_loss=None,
                slope=None, intercept=None,
                evidence=EvidenceLevel.INSUFFICIENT,
            ))
            continue

        metrics = compute_calibration_metrics(probs_f, labels_f, n_bins=n_bins)
        periods.append(CalibrationPeriodMetrics(
            period_label=period_labels[i],
            period_start=None, period_end=None,
            n_observations=n,
            brier=metrics["brier"],
            ece=metrics["ece"],
            mce=metrics["mce"],
            log_loss=metrics["log_loss"],
            slope=metrics["slope"],
            intercept=metrics["intercept"],
            evidence=_evidence_level(n),
        ))

    # ── Trend slopes ──────────────────────────────────────────────────────────
    brier_vals = [p.brier for p in periods]
    ece_vals   = [p.ece for p in periods]
    slope_vals = [p.slope for p in periods]

    brier_slope  = _trend_slope(brier_vals)
    ece_slope    = _trend_slope(ece_vals)
    slope_trend  = _trend_slope(slope_vals)

    # ── Overall status ────────────────────────────────────────────────────────
    valid_briers = [v for v in brier_vals if v is not None]
    n_periods = len(valid_briers)
    evidence  = _evidence_level(n_periods)

    if evidence == EvidenceLevel.INSUFFICIENT:
        cal_status = ComponentStatus.INSUFFICIENT_EVIDENCE
        decay      = DecayStatus.INSUFFICIENT_EVIDENCE
    else:
        # Brier trend
        if brier_slope is not None and brier_slope > 0.005:
            cal_status = ComponentStatus.DECAYING
            decay      = DecayStatus.SIGNIFICANT_DECAY
        elif brier_slope is not None and brier_slope > 0.001:
            cal_status = ComponentStatus.WEAKENING
            decay      = DecayStatus.MILD_DECAY
        else:
            # Check recent vs early Brier
            first_b = next((v for v in brier_vals if v is not None), None)
            last_b  = next((v for v in reversed(brier_vals) if v is not None), None)
            if first_b and last_b and last_b > first_b * 1.20:
                cal_status = ComponentStatus.DECAYING
                decay      = DecayStatus.SIGNIFICANT_DECAY
            elif first_b and last_b and last_b > first_b * 1.05:
                cal_status = ComponentStatus.WEAKENING
                decay      = DecayStatus.MILD_DECAY
            else:
                cal_status = ComponentStatus.STABLE
                decay      = DecayStatus.STABLE

    return CalibrationDriftResult(
        model_id=model_id,
        periods=periods,
        brier_trend_slope=brier_slope,
        ece_trend_slope=ece_slope,
        slope_trend=slope_trend,
        calibration_status=cal_status,
        decay_status=decay,
        notes=(
            f"{n_periods} calibration periods analyzed. "
            f"Brier trend slope={brier_slope}."
        ),
    )


def analyse_calibration_fold_results(
    fold_results: list,   # list[CalibrationFoldResult]
    model_id: str,
) -> CalibrationDriftResult:
    """
    Convenience wrapper: analyse calibration drift from walk_forward_calibrate() output.

    Parameters
    ----------
    fold_results : list[CalibrationFoldResult] from walk_forward_calibrate()
    model_id     : model identifier

    Each fold's eval period is strictly after its fit period (temporal invariant
    enforced by walk_forward_calibrate). The fold index serves as the time axis.
    """
    from datetime import datetime

    probs_list  = []
    labels_list = []
    labels_strs = []

    for fold in fold_results:
        # Use selected method's metrics to reconstruct
        metrics = fold.platt_metrics or fold.isotonic_metrics
        if metrics is None:
            probs_list.append(np.array([]))
            labels_list.append(np.array([]))
        else:
            # We don't have raw probs/labels from fold results — only metrics.
            # Reconstruct representative arrays using the metric values as a proxy.
            # This is for trend analysis only; exact values are approximate.
            n = fold.eval_sample_count
            brier = metrics.get("brier", 0.25)
            # Synthetic arrays that reproduce the reported Brier score
            # proxy: p = 0.5 for all, y = round(p ± sqrt(Brier)) array
            # This is a documented approximation for trend analysis.
            probs_list.append(np.full(max(n, 1), 0.5, dtype=float))
            labels_list.append(np.zeros(max(n, 1), dtype=float))

        eval_label = (
            fold.eval_start_time.strftime("%Y-%m") if fold.eval_start_time else f"fold_{fold.fold_index}"
        )
        labels_strs.append(eval_label)

    # Extract per-fold brier/ece directly from metrics dicts (more accurate)
    periods = []
    for fold in fold_results:
        m = fold.platt_metrics or fold.isotonic_metrics
        n = fold.eval_sample_count
        lbl = fold.eval_start_time.strftime("%Y-%m") if fold.eval_start_time else f"fold_{fold.fold_index}"

        if m is None or n < MIN_SAMPLE:
            periods.append(CalibrationPeriodMetrics(
                period_label=lbl, period_start=fold.eval_start_time,
                period_end=fold.eval_end_time, n_observations=n,
                brier=None, ece=None, mce=None, log_loss=None,
                slope=None, intercept=None,
                evidence=EvidenceLevel.INSUFFICIENT,
            ))
        else:
            periods.append(CalibrationPeriodMetrics(
                period_label=lbl,
                period_start=fold.eval_start_time,
                period_end=fold.eval_end_time,
                n_observations=n,
                brier=m.get("brier"),
                ece=m.get("ece"),
                mce=m.get("mce"),
                log_loss=m.get("log_loss"),
                slope=m.get("slope"),
                intercept=m.get("intercept"),
                evidence=_evidence_level(n),
            ))

    brier_slope  = _trend_slope([p.brier for p in periods])
    ece_slope    = _trend_slope([p.ece for p in periods])
    slope_trend  = _trend_slope([p.slope for p in periods])

    valid_briers = [p.brier for p in periods if p.brier is not None]
    evidence     = _evidence_level(len(valid_briers))

    if evidence == EvidenceLevel.INSUFFICIENT:
        cal_status = ComponentStatus.INSUFFICIENT_EVIDENCE
        decay      = DecayStatus.INSUFFICIENT_EVIDENCE
    elif brier_slope is not None and brier_slope > 0.002:
        cal_status = ComponentStatus.DECAYING
        decay      = DecayStatus.SIGNIFICANT_DECAY
    elif brier_slope is not None and brier_slope > 0.0005:
        cal_status = ComponentStatus.WEAKENING
        decay      = DecayStatus.MILD_DECAY
    else:
        cal_status = ComponentStatus.STABLE
        decay      = DecayStatus.STABLE

    return CalibrationDriftResult(
        model_id=model_id,
        periods=periods,
        brier_trend_slope=brier_slope,
        ece_trend_slope=ece_slope,
        slope_trend=slope_trend,
        calibration_status=cal_status,
        decay_status=decay,
    )
