"""
Phase 3I — Feature Stability Analysis.

PSI time-series, KS test, Wasserstein distance, missingness drift.

Design rules
------------
1. PSI, KS, and Wasserstein are all computed with respect to a reference
   window (training period).  The reference must be at or before the
   production/evaluation period (PIT).
2. PSI binning uses reference-period percentile edges (prevents empty
   reference bins).
3. Wasserstein distance is the 1-D Earth Mover's Distance via sorted
   arrays — no scipy.stats.wasserstein_distance dependency issues.
4. INSUFFICIENT_EVIDENCE is returned when reference or comparison
   window has fewer than MIN_SAMPLE observations.
5. No np.random.* — deterministic.

Reuses
------
- `monitoring.drift_detector._compute_psi()` for PSI.
- `monitoring.drift_detector.detect_drift()` for the full PSI+KS+JS result.
- `scipy.stats.ks_2samp` (already in drift_detector) via reuse.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd
from scipy.stats import ks_2samp

from .schemas import (
    DriftSeverity,
    DriftType,
    EvidenceLevel,
    FeaturePeriodStats,
    FeatureStabilityResult,
)


MIN_SAMPLE = 10

# PSI severity thresholds (same as drift_detector.py)
PSI_NONE   = 0.10
PSI_MINOR  = 0.20

# Wasserstein severity (fraction of reference std)
WASS_MINOR    = 0.25
WASS_MODERATE = 0.50
WASS_HIGH     = 1.00


def _evidence_level(n: int) -> EvidenceLevel:
    if n >= 100: return EvidenceLevel.STRONG
    if n >= 30:  return EvidenceLevel.MODERATE
    if n >= 10:  return EvidenceLevel.WEAK
    return EvidenceLevel.INSUFFICIENT


def _period_stats(arr: np.ndarray, label: str) -> FeaturePeriodStats:
    """Compute distribution statistics for one period."""
    finite = arr[np.isfinite(arr)]
    n_total = len(arr)
    n_finite = len(finite)
    missingness = (n_total - n_finite) / max(n_total, 1)

    if n_finite == 0:
        return FeaturePeriodStats(
            period_label=label, n_observations=n_total,
            mean=None, median=None, std=None, p5=None, p95=None,
            missingness_pct=float(missingness), zero_rate=0.0,
        )

    return FeaturePeriodStats(
        period_label=label,
        n_observations=n_total,
        mean=round(float(np.mean(finite)), 6),
        median=round(float(np.median(finite)), 6),
        std=round(float(np.std(finite, ddof=1)), 6) if n_finite > 1 else 0.0,
        p5=round(float(np.percentile(finite, 5)), 6),
        p95=round(float(np.percentile(finite, 95)), 6),
        missingness_pct=round(float(missingness), 4),
        zero_rate=round(float((finite == 0).sum() / n_finite), 4),
    )


def _wasserstein_1d(p: np.ndarray, q: np.ndarray) -> float:
    """
    1-D Wasserstein distance (Earth Mover's Distance) via sorted arrays.

    W1(P, Q) = sum|CDF_P - CDF_Q| / n  (for equal-sized samples)
    For unequal sizes, use the sorted interpolation approach.
    """
    p_s = np.sort(p)
    q_s = np.sort(q)
    # Interpolate to common size
    n = max(len(p_s), len(q_s))
    t = np.linspace(0, 1, n)
    p_interp = np.interp(t, np.linspace(0, 1, len(p_s)), p_s)
    q_interp = np.interp(t, np.linspace(0, 1, len(q_s)), q_s)
    return float(np.mean(np.abs(p_interp - q_interp)))


def _psi(reference: np.ndarray, current: np.ndarray, n_bins: int = 10, eps: float = 1e-8) -> float:
    """Compute PSI using reference percentile edges."""
    percentiles = np.linspace(0, 100, n_bins + 1)
    bin_edges = np.percentile(reference, percentiles)
    bin_edges = np.unique(bin_edges)
    if len(bin_edges) < 2:
        return 0.0
    ref_c, _ = np.histogram(reference, bins=bin_edges)
    cur_c, _ = np.histogram(current, bins=bin_edges)
    ref_p = ref_c / (ref_c.sum() + eps)
    cur_p = cur_c / (cur_c.sum() + eps)
    ref_p = np.where(ref_p == 0, eps, ref_p)
    cur_p = np.where(cur_p == 0, eps, cur_p)
    return float(max(0.0, np.sum((cur_p - ref_p) * np.log(cur_p / ref_p))))


def _severity_from_psi(psi: float) -> DriftSeverity:
    if psi > PSI_MINOR * 2: return DriftSeverity.CRITICAL
    if psi > PSI_MINOR:     return DriftSeverity.HIGH
    if psi > PSI_NONE:      return DriftSeverity.MODERATE
    return DriftSeverity.NONE


def analyse_feature_stability(
    feature_series: pd.Series,
    timestamp_col: pd.Series,
    feature_name: str,
    feature_family: Optional[str] = None,
    n_bins: int = 10,
    min_reference_fraction: float = 0.3,
) -> FeatureStabilityResult:
    """
    Analyse one feature's distribution stability through time.

    Parameters
    ----------
    feature_series    : feature values (aligned with timestamp_col)
    timestamp_col     : timestamps aligned with feature_series
    feature_name      : feature identifier
    feature_family    : optional FeatureFamily.value
    n_bins            : histogram bins for PSI
    min_reference_fraction : fraction of data to use as reference (earliest)

    PIT guarantee: feature_series must only contain values computed at or
    before the corresponding timestamp. The stability analysis compares
    the feature distribution across time — no future values enter as
    current-period inputs.

    Returns
    -------
    FeatureStabilityResult
    """
    df = pd.DataFrame({"value": feature_series.values, "ts": timestamp_col.values})
    df = df.sort_values("ts").reset_index(drop=True)

    n_total = len(df)
    if n_total < MIN_SAMPLE * 2:
        empty_stats = _period_stats(np.array([np.nan]), "reference")
        return FeatureStabilityResult(
            feature_name=feature_name,
            feature_family=feature_family,
            n_periods=0,
            reference_period=empty_stats,
            comparison_periods=[],
            max_psi=None, max_ks_statistic=None, max_wasserstein=None,
            missingness_drift=None,
            drift_severity=DriftSeverity.NONE,
            evidence=EvidenceLevel.INSUFFICIENT,
            notes=f"Insufficient data: {n_total} < {MIN_SAMPLE * 2}.",
        )

    # Reference = earliest min_reference_fraction of the series
    ref_size   = max(MIN_SAMPLE, int(n_total * min_reference_fraction))
    ref_vals   = df["value"].iloc[:ref_size].to_numpy(dtype=float)
    comp_vals  = df["value"].iloc[ref_size:].to_numpy(dtype=float)

    ref_finite = ref_vals[np.isfinite(ref_vals)]
    comp_finite = comp_vals[np.isfinite(comp_vals)]

    ref_stats  = _period_stats(ref_vals, "reference")
    comp_stats = _period_stats(comp_vals, "comparison")

    if len(ref_finite) < MIN_SAMPLE or len(comp_finite) < MIN_SAMPLE:
        return FeatureStabilityResult(
            feature_name=feature_name, feature_family=feature_family,
            n_periods=2, reference_period=ref_stats,
            comparison_periods=[comp_stats],
            max_psi=None, max_ks_statistic=None, max_wasserstein=None,
            missingness_drift=None,
            drift_severity=DriftSeverity.NONE,
            evidence=EvidenceLevel.INSUFFICIENT,
            notes="Insufficient finite values in reference or comparison.",
        )

    # ── Compute drift statistics ──────────────────────────────────────────────
    psi     = _psi(ref_finite, comp_finite, n_bins)
    ks_stat, ks_p = ks_2samp(ref_finite, comp_finite)
    wass    = _wasserstein_1d(ref_finite, comp_finite)
    miss_drift = comp_stats.missingness_pct - ref_stats.missingness_pct

    # ── Severity ──────────────────────────────────────────────────────────────
    severity = _severity_from_psi(psi)

    # Also check KS
    if ks_p < 0.01 and severity.value < DriftSeverity.HIGH.value:
        severity = DriftSeverity.HIGH
    elif ks_p < 0.05 and severity == DriftSeverity.NONE:
        severity = DriftSeverity.MODERATE

    # Check missingness spike
    if miss_drift > 0.10 and severity == DriftSeverity.NONE:
        severity = DriftSeverity.MODERATE

    drift_type = DriftType.FEATURE_DRIFT if severity != DriftSeverity.NONE else DriftType.NONE

    return FeatureStabilityResult(
        feature_name=feature_name,
        feature_family=feature_family,
        n_periods=2,
        reference_period=ref_stats,
        comparison_periods=[comp_stats],
        max_psi=round(psi, 6),
        max_ks_statistic=round(float(ks_stat), 6),
        max_wasserstein=round(wass, 6),
        missingness_drift=round(miss_drift, 4),
        drift_severity=severity,
        drift_type=drift_type,
        evidence=_evidence_level(min(len(ref_finite), len(comp_finite))),
    )


def analyse_feature_family_stability(
    features_df: pd.DataFrame,
    timestamp_col: str,
    feature_cols: list[str],
    family_map: Optional[dict[str, str]] = None,
) -> list[FeatureStabilityResult]:
    """
    Analyse stability for multiple features and return a list of results.

    Parameters
    ----------
    features_df  : DataFrame with features and a timestamp column
    timestamp_col: name of the timestamp column (PIT-correct)
    feature_cols : list of feature column names to analyse
    family_map   : {feature_name: family_value} (optional)

    Returns
    -------
    List of FeatureStabilityResult, one per feature.
    """
    results = []
    ts = features_df[timestamp_col]
    for col in feature_cols:
        if col not in features_df.columns:
            continue
        family = family_map.get(col) if family_map else None
        result = analyse_feature_stability(
            feature_series=features_df[col],
            timestamp_col=ts,
            feature_name=col,
            feature_family=family,
        )
        results.append(result)
    return results
