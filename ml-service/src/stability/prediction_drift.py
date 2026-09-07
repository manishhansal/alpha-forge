"""
Phase 3I — Prediction Distribution Drift.

Tracks distribution shift in alpha scores, calibrated probabilities, and EV.
Implements CUSUM change-point detection on prediction streams.

Design rules
------------
1. Reference period = earliest fraction of the series (PIT-correct).
2. CUSUM is deterministic — no np.random.
3. Multiple drift types are reported separately (spec §37).
4. INSUFFICIENT_EVIDENCE when n < MIN_SAMPLE.
5. PSI and KS reuse from monitoring.drift_detector (already in codebase).
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd
from scipy.stats import ks_2samp

from .ic_decay import cusum_changepoint
from .schemas import (
    ChangePointStatus,
    DriftSeverity,
    DriftType,
    EvidenceLevel,
    PredictionDriftResult,
)


MIN_SAMPLE = 10
PSI_NONE  = 0.10
PSI_MINOR = 0.20
PSI_EPS   = 1e-8


def _evidence_level(n: int) -> EvidenceLevel:
    if n >= 100: return EvidenceLevel.STRONG
    if n >= 30:  return EvidenceLevel.MODERATE
    if n >= 10:  return EvidenceLevel.WEAK
    return EvidenceLevel.INSUFFICIENT


def _psi(ref: np.ndarray, cur: np.ndarray, n_bins: int = 10, eps: float = PSI_EPS) -> float:
    bin_edges = np.percentile(ref, np.linspace(0, 100, n_bins + 1))
    bin_edges = np.unique(bin_edges)
    if len(bin_edges) < 2:
        return 0.0
    rp, _ = np.histogram(ref, bins=bin_edges)
    cp, _ = np.histogram(cur, bins=bin_edges)
    rp = rp / (rp.sum() + eps); cp = cp / (cp.sum() + eps)
    rp[rp == 0] = eps; cp[cp == 0] = eps
    return float(max(0.0, np.sum((cp - rp) * np.log(cp / rp))))


def _severity(psi: float, ks_p: float) -> DriftSeverity:
    if psi > PSI_MINOR * 2 or ks_p < 0.001: return DriftSeverity.CRITICAL
    if psi > PSI_MINOR    or ks_p < 0.01:   return DriftSeverity.HIGH
    if psi > PSI_NONE     or ks_p < 0.05:   return DriftSeverity.MODERATE
    return DriftSeverity.NONE


def _js_div(p: np.ndarray, q: np.ndarray, n_bins: int = 10, eps: float = PSI_EPS) -> float:
    all_v = np.concatenate([p, q])
    edges = np.percentile(all_v, np.linspace(0, 100, n_bins + 1))
    edges = np.unique(edges)
    if len(edges) < 2:
        return 0.0
    pp, _ = np.histogram(p, bins=edges, density=True)
    qq, _ = np.histogram(q, bins=edges, density=True)
    pp = pp + eps; qq = qq + eps
    pp /= pp.sum(); qq /= qq.sum()
    m = 0.5 * (pp + qq)
    return float(np.clip(0.5 * (np.sum(pp * np.log(pp / m)) + np.sum(qq * np.log(qq / m))), 0, 1))


def analyse_prediction_drift(
    values: np.ndarray,
    signal_id: str,
    metric_name: str,
    reference_fraction: float = 0.3,
    n_bins: int = 10,
    cusum_sensitivity: float = 0.5,
) -> PredictionDriftResult:
    """
    Analyse distribution drift for one prediction metric over time.

    Parameters
    ----------
    values             : time-ordered array of prediction values (NaN allowed)
    signal_id          : signal identifier
    metric_name        : "alpha_score" | "calibrated_probability" | "expected_value"
    reference_fraction : fraction of data to use as reference (earliest)
    n_bins             : PSI histogram bins
    cusum_sensitivity  : CUSUM sensitivity multiplier

    PIT guarantee: values[t] must be the signal output at time t.
    The reference window uses only early values — no future data is
    used in constructing the reference distribution.

    Returns
    -------
    PredictionDriftResult
    """
    finite = values[np.isfinite(values)]
    n = len(finite)

    if n < MIN_SAMPLE * 2:
        return PredictionDriftResult(
            signal_id=signal_id, metric_name=metric_name,
            change_point_status=ChangePointStatus.INSUFFICIENT_EVIDENCE,
            change_point_index=None, cusum_max_deviation=None,
            psi=None, ks_statistic=None, ks_p_value=None, js_divergence=None,
            ref_mean=None, ref_std=None, cur_mean=None, cur_std=None,
            drift_severity=DriftSeverity.NONE,
            evidence=EvidenceLevel.INSUFFICIENT,
        )

    ref_size = max(MIN_SAMPLE, int(n * reference_fraction))
    ref = finite[:ref_size]
    cur = finite[ref_size:]

    if len(cur) < MIN_SAMPLE:
        return PredictionDriftResult(
            signal_id=signal_id, metric_name=metric_name,
            change_point_status=ChangePointStatus.INSUFFICIENT_EVIDENCE,
            change_point_index=None, cusum_max_deviation=None,
            psi=None, ks_statistic=None, ks_p_value=None, js_divergence=None,
            ref_mean=float(np.mean(ref)), ref_std=float(np.std(ref, ddof=1)),
            cur_mean=None, cur_std=None,
            drift_severity=DriftSeverity.NONE,
            evidence=EvidenceLevel.INSUFFICIENT,
        )

    # ── CUSUM ─────────────────────────────────────────────────────────────────
    cp_status, cp_idx = cusum_changepoint(finite, sensitivity=cusum_sensitivity)
    cusum_dev = None
    if len(finite) > 0:
        mu = float(np.mean(finite))
        cs = np.abs(np.cumsum(finite - mu))
        cusum_dev = round(float(cs.max()), 6) if len(cs) > 0 else None

    # ── Distribution drift ────────────────────────────────────────────────────
    psi  = _psi(ref, cur, n_bins)
    ks_s, ks_p = ks_2samp(ref, cur)
    js   = _js_div(ref, cur, n_bins)

    severity = _severity(psi, ks_p)

    return PredictionDriftResult(
        signal_id=signal_id,
        metric_name=metric_name,
        change_point_status=cp_status,
        change_point_index=cp_idx,
        cusum_max_deviation=cusum_dev,
        psi=round(psi, 6),
        ks_statistic=round(float(ks_s), 6),
        ks_p_value=round(float(ks_p), 6),
        js_divergence=round(js, 6),
        ref_mean=round(float(np.mean(ref)), 6),
        ref_std=round(float(np.std(ref, ddof=1)), 6) if len(ref) > 1 else 0.0,
        cur_mean=round(float(np.mean(cur)), 6),
        cur_std=round(float(np.std(cur, ddof=1)), 6) if len(cur) > 1 else 0.0,
        drift_severity=severity,
        drift_type=DriftType.PREDICTION_DRIFT,
        evidence=_evidence_level(min(len(ref), len(cur))),
    )
