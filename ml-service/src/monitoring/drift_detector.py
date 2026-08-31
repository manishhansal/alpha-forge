"""
Drift Detector — AlphaForge ML Monitoring.

Detects statistical distribution shift between a reference window
(training / baseline) and a production window using three complementary
statistics:

  PSI  (Population Stability Index)
       Industry-standard credit-risk statistic.  Measures how much a
       distribution has shifted bucket-by-bucket.
         < 0.10  → NONE    (stable)
         0.10–0.20 → MINOR (monitor)
         > 0.20  → MAJOR   (act)

  KS   (Kolmogorov-Smirnov two-sample statistic)
       Non-parametric: compares the empirical CDFs.
       p-value < 0.05 is flagged at WARNING; p-value < 0.01 at CRITICAL.

  JS   (Jensen-Shannon divergence)
       Symmetric, bounded [0, 1] generalisation of KL divergence.
       > 0.10 → WARNING; > 0.25 → CRITICAL.

Design decisions
----------------
- All detectors are pure functions that operate on numpy arrays.
- ``DriftDetector`` is a stateful wrapper that stores the reference
  distribution and exposes a ``.detect()`` method for production windows.
- No external database dependency — results are returned as plain dataclasses
  and may be forwarded to the ``ModelRegistry`` or ``AlertSystem`` by the
  caller.
- Thread-safe via a simple ``threading.Lock`` on reference updates.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Literal

import numpy as np
import structlog
from scipy import stats

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Severity levels
# ---------------------------------------------------------------------------

class DriftSeverity(str, Enum):
    """Severity of a detected distribution shift."""

    NONE     = "none"      # PSI < 0.10, KS p > 0.05, JS < 0.10
    MINOR    = "minor"     # PSI 0.10–0.20 or KS p 0.01–0.05 or JS 0.10–0.25
    MAJOR    = "major"     # PSI > 0.20 or KS p < 0.01 or JS > 0.25


# ---------------------------------------------------------------------------
# PSI thresholds
# ---------------------------------------------------------------------------

PSI_NONE   = 0.10
PSI_MINOR  = 0.20

KS_P_WARN  = 0.05
KS_P_CRIT  = 0.01

JS_WARN    = 0.10
JS_CRIT    = 0.25

_N_BINS    = 10   # default number of bins for PSI computation


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------

@dataclass
class DriftResult:
    """
    Result of a single drift detection check.

    Attributes
    ----------
    feature_name  : name of the feature / prediction being tested
    severity      : NONE | MINOR | MAJOR
    psi           : Population Stability Index (lower = more stable)
    ks_statistic  : KS two-sample statistic ∈ [0, 1]
    ks_p_value    : KS p-value (low → significant shift)
    js_divergence : Jensen-Shannon divergence ∈ [0, 1]
    ref_mean      : reference distribution mean
    cur_mean      : current window mean
    ref_std       : reference distribution std-dev
    cur_std       : current window std-dev
    ref_n         : number of reference samples
    cur_n         : number of current samples
    details       : human-readable summary
    """

    feature_name:  str
    severity:      DriftSeverity
    psi:           float
    ks_statistic:  float
    ks_p_value:    float
    js_divergence: float
    ref_mean:      float
    cur_mean:      float
    ref_std:       float
    cur_std:       float
    ref_n:         int
    cur_n:         int
    details:       str = ""

    @property
    def has_drift(self) -> bool:
        return self.severity != DriftSeverity.NONE

    def to_dict(self) -> dict:
        return {
            "feature_name":  self.feature_name,
            "severity":      self.severity.value,
            "psi":           round(self.psi, 5),
            "ks_statistic":  round(self.ks_statistic, 5),
            "ks_p_value":    round(self.ks_p_value, 5),
            "js_divergence": round(self.js_divergence, 5),
            "ref_mean":      round(self.ref_mean, 5),
            "cur_mean":      round(self.cur_mean, 5),
            "ref_std":       round(self.ref_std, 5),
            "cur_std":       round(self.cur_std, 5),
            "ref_n":         self.ref_n,
            "cur_n":         self.cur_n,
            "details":       self.details,
        }


# ---------------------------------------------------------------------------
# Pure-function statistical helpers
# ---------------------------------------------------------------------------

def _compute_psi(
    reference: np.ndarray,
    current: np.ndarray,
    n_bins: int = _N_BINS,
    eps: float = 1e-8,
) -> float:
    """
    Compute Population Stability Index between two 1-D arrays.

    Both arrays are jointly binned using the reference distribution's
    percentile edges so the buckets are always well-populated on the
    reference side.
    """
    reference = np.asarray(reference, dtype=float)
    current   = np.asarray(current,   dtype=float)

    # Build bin edges from reference
    percentiles = np.linspace(0, 100, n_bins + 1)
    bin_edges = np.percentile(reference, percentiles)
    bin_edges = np.unique(bin_edges)          # remove duplicate edges

    if len(bin_edges) < 2:
        return 0.0

    ref_counts, _ = np.histogram(reference, bins=bin_edges)
    cur_counts, _ = np.histogram(current,   bins=bin_edges)

    ref_pct = ref_counts / (ref_counts.sum() + eps)
    cur_pct = cur_counts / (cur_counts.sum() + eps)

    ref_pct = np.where(ref_pct == 0, eps, ref_pct)
    cur_pct = np.where(cur_pct == 0, eps, cur_pct)

    psi = float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))
    return max(0.0, psi)


def _compute_js_divergence(
    reference: np.ndarray,
    current: np.ndarray,
    n_bins: int = _N_BINS,
    eps: float = 1e-8,
) -> float:
    """
    Compute Jensen-Shannon divergence (bounded [0, 1]) between two arrays.
    """
    reference = np.asarray(reference, dtype=float)
    current   = np.asarray(current,   dtype=float)

    all_vals  = np.concatenate([reference, current])
    bin_edges = np.percentile(all_vals, np.linspace(0, 100, n_bins + 1))
    bin_edges = np.unique(bin_edges)

    if len(bin_edges) < 2:
        return 0.0

    p, _ = np.histogram(reference, bins=bin_edges, density=True)
    q, _ = np.histogram(current,   bins=bin_edges, density=True)

    p = p + eps
    q = q + eps
    p = p / p.sum()
    q = q / q.sum()

    m = 0.5 * (p + q)
    js = 0.5 * (
        np.sum(p * np.log(p / m)) + np.sum(q * np.log(q / m))
    )
    return float(np.clip(js, 0.0, 1.0))


def _drift_severity_from_stats(
    psi: float,
    ks_p: float,
    js: float,
) -> DriftSeverity:
    """Combine three statistics into a single DriftSeverity verdict."""
    if psi > PSI_MINOR or ks_p < KS_P_CRIT or js > JS_CRIT:
        return DriftSeverity.MAJOR
    if psi > PSI_NONE or ks_p < KS_P_WARN or js > JS_WARN:
        return DriftSeverity.MINOR
    return DriftSeverity.NONE


def detect_drift(
    feature_name: str,
    reference: np.ndarray,
    current: np.ndarray,
    n_bins: int = _N_BINS,
) -> DriftResult:
    """
    Run PSI + KS + JS drift detection on two samples.

    Parameters
    ----------
    feature_name : label for the result
    reference    : baseline / training distribution (1-D numeric array)
    current      : production window distribution (1-D numeric array)
    n_bins       : histogram bins for PSI / JS (default 10)

    Returns
    -------
    DriftResult
    """
    reference = np.asarray(reference, dtype=float)
    current   = np.asarray(current,   dtype=float)

    # Remove NaN / Inf
    reference = reference[np.isfinite(reference)]
    current   = current[np.isfinite(current)]

    if len(reference) < 5 or len(current) < 5:
        logger.warning(
            "drift_check_insufficient_samples",
            feature=feature_name,
            ref_n=len(reference),
            cur_n=len(current),
        )
        return DriftResult(
            feature_name=feature_name,
            severity=DriftSeverity.NONE,
            psi=0.0, ks_statistic=0.0, ks_p_value=1.0, js_divergence=0.0,
            ref_mean=float(np.mean(reference)) if len(reference) else 0.0,
            cur_mean=float(np.mean(current))   if len(current)   else 0.0,
            ref_std=float(np.std(reference))   if len(reference) else 0.0,
            cur_std=float(np.std(current))     if len(current)   else 0.0,
            ref_n=len(reference), cur_n=len(current),
            details="Insufficient samples for drift detection.",
        )

    psi   = _compute_psi(reference, current, n_bins)
    ks_stat, ks_p = stats.ks_2samp(reference, current)
    js    = _compute_js_divergence(reference, current, n_bins)

    severity = _drift_severity_from_stats(psi, ks_p, js)

    details = (
        f"PSI={psi:.4f}, KS={ks_stat:.4f}(p={ks_p:.4f}), JS={js:.4f} → {severity.value}"
    )

    result = DriftResult(
        feature_name=feature_name,
        severity=severity,
        psi=psi,
        ks_statistic=float(ks_stat),
        ks_p_value=float(ks_p),
        js_divergence=js,
        ref_mean=float(np.mean(reference)),
        cur_mean=float(np.mean(current)),
        ref_std=float(np.std(reference)),
        cur_std=float(np.std(current)),
        ref_n=len(reference),
        cur_n=len(current),
        details=details,
    )

    if severity != DriftSeverity.NONE:
        logger.warning(
            "drift_detected",
            feature=feature_name,
            severity=severity.value,
            psi=round(psi, 4),
            ks_p=round(ks_p, 4),
            js=round(js, 4),
        )
    else:
        logger.debug("drift_check_stable", feature=feature_name)

    return result


# ---------------------------------------------------------------------------
# Stateful DriftDetector — stores reference distribution per feature
# ---------------------------------------------------------------------------

@dataclass
class _ReferenceStore:
    data: np.ndarray
    n_bins: int = _N_BINS


class DriftDetector:
    """
    Stateful drift detector.

    Stores a reference distribution for each named feature and exposes
    ``.set_reference()`` / ``.detect()`` for production use.

    Parameters
    ----------
    n_bins : int
        Default number of histogram bins for PSI / JS computation.

    Example
    -------
    ::

        detector = DriftDetector()
        detector.set_reference("rsi_14", training_rsi_values)
        result = detector.detect("rsi_14", production_rsi_window)
        if result.severity == DriftSeverity.MAJOR:
            ...

    Thread safety
    -------------
    Reference updates and detections are protected by a ``threading.Lock``
    so the detector is safe to use in concurrent FastAPI request handlers.
    """

    def __init__(self, n_bins: int = _N_BINS) -> None:
        self._n_bins = n_bins
        self._refs: dict[str, _ReferenceStore] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Reference management
    # ------------------------------------------------------------------

    def set_reference(
        self,
        feature_name: str,
        data: np.ndarray | list,
        n_bins: int | None = None,
    ) -> None:
        """
        Register / update the reference distribution for *feature_name*.

        Parameters
        ----------
        feature_name : unique identifier for this feature/signal
        data         : baseline samples (training distribution)
        n_bins       : override default bin count for this feature
        """
        arr = np.asarray(data, dtype=float)
        arr = arr[np.isfinite(arr)]
        with self._lock:
            self._refs[feature_name] = _ReferenceStore(
                data=arr,
                n_bins=n_bins if n_bins is not None else self._n_bins,
            )
        logger.info(
            "drift_reference_set",
            feature=feature_name,
            n_samples=len(arr),
        )

    def has_reference(self, feature_name: str) -> bool:
        with self._lock:
            return feature_name in self._refs

    def reference_features(self) -> list[str]:
        with self._lock:
            return list(self._refs.keys())

    # ------------------------------------------------------------------
    # Detection
    # ------------------------------------------------------------------

    def detect(
        self,
        feature_name: str,
        current: np.ndarray | list,
    ) -> DriftResult | None:
        """
        Detect drift for *feature_name* against its stored reference.

        Returns ``None`` if no reference has been set for the feature.
        """
        with self._lock:
            ref = self._refs.get(feature_name)

        if ref is None:
            logger.debug("drift_no_reference", feature=feature_name)
            return None

        return detect_drift(
            feature_name=feature_name,
            reference=ref.data,
            current=np.asarray(current, dtype=float),
            n_bins=ref.n_bins,
        )

    def detect_all(
        self,
        current_data: dict[str, np.ndarray | list],
    ) -> dict[str, DriftResult]:
        """
        Detect drift for every feature present in *current_data* that has
        a stored reference.

        Parameters
        ----------
        current_data : mapping of feature_name → 1-D array of current values

        Returns
        -------
        dict mapping feature_name → DriftResult  (only features with references)
        """
        results: dict[str, DriftResult] = {}
        for name, values in current_data.items():
            result = self.detect(name, values)
            if result is not None:
                results[name] = result
        return results

    # ------------------------------------------------------------------
    # Prediction / confidence drift helpers
    # ------------------------------------------------------------------

    def detect_prediction_drift(
        self,
        model_name: str,
        ref_predictions: np.ndarray | list,
        cur_predictions: np.ndarray | list,
    ) -> DriftResult:
        """
        One-shot prediction drift check (no stored reference needed).
        Useful for comparing two rolling windows of prediction scores.
        """
        return detect_drift(
            feature_name=f"{model_name}:predictions",
            reference=np.asarray(ref_predictions, dtype=float),
            current=np.asarray(cur_predictions, dtype=float),
        )

    def detect_confidence_drift(
        self,
        model_name: str,
        ref_confidences: np.ndarray | list,
        cur_confidences: np.ndarray | list,
    ) -> DriftResult:
        """One-shot confidence distribution drift check."""
        return detect_drift(
            feature_name=f"{model_name}:confidence",
            reference=np.asarray(ref_confidences, dtype=float),
            current=np.asarray(cur_confidences, dtype=float),
        )

    # ------------------------------------------------------------------
    # Prediction distribution summary
    # ------------------------------------------------------------------

    @staticmethod
    def prediction_distribution_summary(
        actions: list[str],
        confidences: list[float],
    ) -> dict:
        """
        Summarise a window of MetaOutput predictions.

        Parameters
        ----------
        actions     : list of action strings ("BUY", "SELL", "WAIT", "NO_TRADE")
        confidences : corresponding confidence values ∈ [0, 1]

        Returns
        -------
        dict with counts, ratios, and confidence stats per action class
        """
        if not actions:
            return {}

        action_list = [str(a).upper() for a in actions]
        confs = np.asarray(confidences, dtype=float)
        total = len(action_list)

        counts: dict[str, int] = {}
        for a in action_list:
            counts[a] = counts.get(a, 0) + 1

        ratios = {a: round(c / total, 4) for a, c in counts.items()}

        return {
            "total_predictions": total,
            "counts":  counts,
            "ratios":  ratios,
            "confidence_mean":   round(float(np.mean(confs)), 4),
            "confidence_std":    round(float(np.std(confs)),  4),
            "confidence_p10":    round(float(np.percentile(confs, 10)), 4),
            "confidence_p50":    round(float(np.percentile(confs, 50)), 4),
            "confidence_p90":    round(float(np.percentile(confs, 90)), 4),
            "buy_sell_ratio": round(
                counts.get("BUY", 0) / max(counts.get("SELL", 1), 1), 4
            ),
        }
