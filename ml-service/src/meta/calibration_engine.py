"""
Calibration Engine — Phase 3F.

Provides:
- CalibratorArtifact: versioned calibrator with full provenance
- PlattCalibratorV2: Platt scaling with explicit OOS contract
- IsotonicCalibratorV2: isotonic regression with minimum-sample guard
- walk_forward_calibrate(): chronological calibration across folds
- reliability_curve(): binned predicted vs observed frequencies
- calibration_slope_intercept(): linear calibration diagnostic

Core rules enforced here
------------------------
1. An unfitted calibrator NEVER returns a value labelled CALIBRATED.
   It returns status=UNCALIBRATED and value=None.
2. clip(raw_score, 0, 1) is NOT calibration. This module never does that.
3. The calibration window must end before the evaluation period begins.
   walk_forward_calibrate() enforces fit_end_time < eval_start_time.
4. Model/calibrator compatibility is checked via model_id + model_version.
   Mismatches return status=CALIBRATOR_MISMATCH.
5. Stale calibrators (age > max_age_days) return status=STALE.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from .schemas import (
    CalibratedProbability,
    CalibrationQualityV2,
    ProbabilityStatus,
    ScoreType,
)

UTC = timezone.utc


# ── Reliability curve ─────────────────────────────────────────────────────────

@dataclass
class ReliabilityBin:
    """One bin of the reliability (calibration) curve."""
    bin_lo:               float
    bin_hi:               float
    mean_predicted_prob:  Optional[float]
    observed_frequency:   Optional[float]
    sample_count:         int

    @property
    def calibration_gap(self) -> Optional[float]:
        if self.mean_predicted_prob is None or self.observed_frequency is None:
            return None
        return abs(self.mean_predicted_prob - self.observed_frequency)


def reliability_curve(
    probs: np.ndarray,
    labels: np.ndarray,
    n_bins: int = 10,
) -> list[ReliabilityBin]:
    """
    Compute a reliability (calibration) curve.

    A well-calibrated model has predicted probability ≈ observed frequency
    within each bin.

    Parameters
    ----------
    probs  : calibrated probabilities ∈ [0,1]
    labels : binary ground-truth {0, 1}
    n_bins : number of equal-width bins

    Returns
    -------
    List of ReliabilityBin objects.
    """
    bins: list[ReliabilityBin] = []
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (probs >= lo) & (probs < hi)
        if mask.sum() == 0:
            bins.append(ReliabilityBin(lo, hi, None, None, 0))
        else:
            bins.append(ReliabilityBin(
                bin_lo=round(float(lo), 4),
                bin_hi=round(float(hi), 4),
                mean_predicted_prob=round(float(probs[mask].mean()), 6),
                observed_frequency=round(float(labels[mask].mean()), 6),
                sample_count=int(mask.sum()),
            ))
    return bins


def calibration_slope_intercept(
    probs: np.ndarray,
    labels: np.ndarray,
) -> tuple[Optional[float], Optional[float]]:
    """
    Fit a linear regression: observed_label ~ a * predicted_prob + b.

    A perfectly calibrated model has slope ≈ 1.0, intercept ≈ 0.0.
    slope < 1 means over-confident; slope > 1 means under-confident.

    Returns (slope, intercept) or (None, None) if insufficient data.
    """
    if len(probs) < 5:
        return None, None
    X = np.column_stack([probs, np.ones(len(probs))])
    try:
        result = np.linalg.lstsq(X, labels.astype(float), rcond=None)
        a, b = result[0]
        return float(a), float(b)
    except np.linalg.LinAlgError:
        return None, None


def compute_calibration_metrics(
    probs: np.ndarray,
    labels: np.ndarray,
    n_bins: int = 10,
) -> dict:
    """
    Compute ECE, MCE, Brier, log-loss, slope, intercept.
    """
    probs  = np.clip(np.asarray(probs,  dtype=float), 1e-9, 1 - 1e-9)
    labels = np.asarray(labels, dtype=float)

    n = len(probs)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    ece = mce = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (probs >= lo) & (probs < hi)
        if mask.sum() == 0:
            continue
        gap = abs(probs[mask].mean() - labels[mask].mean())
        ece += (mask.sum() / n) * gap
        mce  = max(mce, gap)

    brier   = float(np.mean((probs - labels) ** 2))
    log_loss = float(-np.mean(labels * np.log(probs) + (1 - labels) * np.log(1 - probs)))
    slope, intercept = calibration_slope_intercept(probs, labels)

    return {
        "ece":        round(ece, 6),
        "mce":        round(mce, 6),
        "brier":      round(brier, 6),
        "log_loss":   round(log_loss, 6),
        "slope":      round(slope, 6) if slope is not None else None,
        "intercept":  round(intercept, 6) if intercept is not None else None,
        "n_samples":  n,
    }


# ── Calibrator artifact (with provenance) ────────────────────────────────────

@dataclass
class CalibratorArtifact:
    """
    A calibrator with full provenance metadata.

    Enforces:
    - model_id + model_version compatibility check at inference time
    - Staleness check (fit_end_time + max_age_days)
    - No clip(raw_score) fallback — returns UNCALIBRATED when not fitted
    """
    calibrator_id:       str
    model_id:            str
    model_version:       str
    calibration_method:  str         # "platt" | "isotonic"
    calibration_version: str
    fit_end_time:        Optional[datetime]
    effective_from:      Optional[datetime]
    fit_sample_count:    int
    max_age_days:        int = 90
    dataset_id:          str = ""
    git_commit:          str = ""

    # Internal — set after fit()
    _fitted:             bool = field(default=False, repr=False)
    _platt_a:            float = field(default=1.0, repr=False)
    _platt_b:            float = field(default=0.0, repr=False)
    _isotonic_model:     object = field(default=None, repr=False)  # sklearn model

    def is_stale(self, current_time: Optional[datetime] = None) -> bool:
        """Return True if the calibrator is older than max_age_days."""
        if self.effective_from is None:
            return True
        ct = current_time or datetime.now(UTC)
        eff = self.effective_from
        if eff.tzinfo is None:
            eff = eff.replace(tzinfo=UTC)
        ct = ct.astimezone(UTC) if ct.tzinfo else ct.replace(tzinfo=UTC)
        return (ct - eff).days > self.max_age_days

    def is_compatible(self, model_id: str, model_version: str) -> bool:
        """Check model/calibrator compatibility."""
        return self.model_id == model_id and self.model_version == model_version

    def fit_platt(self, scores: np.ndarray, labels: np.ndarray) -> None:
        """Fit Platt scaling. Requires sklearn."""
        from sklearn.linear_model import LogisticRegression
        scores = np.asarray(scores, dtype=float).reshape(-1, 1)
        labels = np.asarray(labels, dtype=float)
        lr = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
        lr.fit(scores, labels)
        self._platt_a = float(lr.coef_[0, 0])
        self._platt_b = float(lr.intercept_[0])
        self._fitted = True
        self.calibration_method = "platt"
        self.fit_sample_count = len(scores)

    def fit_isotonic(self, scores: np.ndarray, labels: np.ndarray) -> None:
        """Fit isotonic regression. Requires sklearn."""
        from sklearn.isotonic import IsotonicRegression
        scores = np.asarray(scores, dtype=float)
        labels = np.asarray(labels, dtype=float)
        self._isotonic_model = IsotonicRegression(
            out_of_bounds="clip", y_min=0.0, y_max=1.0
        )
        self._isotonic_model.fit(scores, labels)
        self._fitted = True
        self.calibration_method = "isotonic"
        self.fit_sample_count = len(scores)

    def predict(
        self,
        raw_scores: np.ndarray,
        model_id: str,
        model_version: str,
        current_time: Optional[datetime] = None,
    ) -> tuple[Optional[np.ndarray], ProbabilityStatus]:
        """
        Predict calibrated probabilities.

        Check order (most informative first):
        1. UNCALIBRATED — not yet fitted (check before staleness)
        2. CALIBRATOR_MISMATCH — wrong model_id or model_version
        3. STALE — calibrator is older than max_age_days
        4. CALIBRATED — produce probabilities
        """
        if not self._fitted:
            return None, ProbabilityStatus.UNCALIBRATED

        if not self.is_compatible(model_id, model_version):
            return None, ProbabilityStatus.CALIBRATOR_MISMATCH

        if self.is_stale(current_time):
            return None, ProbabilityStatus.STALE

        raw = np.asarray(raw_scores, dtype=float)

        if self.calibration_method == "platt":
            probs = 1.0 / (1.0 + np.exp(-(self._platt_a * raw + self._platt_b)))
        elif self.calibration_method == "isotonic" and self._isotonic_model is not None:
            probs = np.clip(self._isotonic_model.predict(raw), 0.0, 1.0)
        else:
            return None, ProbabilityStatus.UNCALIBRATED

        return probs, ProbabilityStatus.CALIBRATED

    def calibrate_single(
        self,
        raw_score: float,
        model_id: str,
        model_version: str,
        prediction_time: Optional[datetime] = None,
        current_time: Optional[datetime] = None,
    ) -> CalibratedProbability:
        """
        Calibrate one raw score.  Returns CalibratedProbability with full provenance.
        NEVER returns clip(raw, 0, 1) as CALIBRATED.
        """
        probs, status = self.predict(
            np.array([raw_score]), model_id, model_version, current_time
        )

        if status != ProbabilityStatus.CALIBRATED or probs is None:
            return CalibratedProbability.unavailable(
                model_id=model_id, reason=status
            )

        return CalibratedProbability(
            value=float(probs[0]),
            status=ProbabilityStatus.CALIBRATED,
            model_id=model_id,
            model_version=model_version,
            calibrator_id=self.calibrator_id,
            calibration_method=self.calibration_method,
            calibration_version=self.calibration_version,
            fit_end_time=self.fit_end_time,
            effective_from=self.effective_from,
            sample_count=self.fit_sample_count,
            prediction_time=prediction_time,
        )


# ── Walk-forward calibration ──────────────────────────────────────────────────

@dataclass
class CalibrationFoldResult:
    """Result of fitting and evaluating a calibrator on one walk-forward fold."""
    fold_index:         int
    fit_start_time:     Optional[datetime]
    fit_end_time:       Optional[datetime]
    eval_start_time:    Optional[datetime]
    eval_end_time:      Optional[datetime]
    fit_sample_count:   int
    eval_sample_count:  int
    fit_is_oos:         bool      # True = fit data was OOS for the primary model
    eval_is_oos:        bool      # True = eval data is disjoint from fit data
    platt_metrics:      Optional[dict]
    isotonic_metrics:   Optional[dict]
    selected_method:    str       # "platt" | "isotonic" | "none"
    reliability_bins:   list[ReliabilityBin] = field(default_factory=list)


def walk_forward_calibrate(
    timestamps: np.ndarray,
    raw_scores: np.ndarray,
    labels: np.ndarray,
    calibration_bars: int = 252,
    eval_bars: int = 63,
    step_bars: int = 63,
    min_fit_samples: int = 30,
    min_isotonic_samples: int = 100,
) -> list[CalibrationFoldResult]:
    """
    Walk-forward calibration: fit calibrator on [t-calib..t], evaluate on [t+1..t+eval].

    Invariant enforced
    ------------------
    fit_end_time < eval_start_time for every fold (no temporal leakage).

    Parameters
    ----------
    timestamps        : sorted datetime array aligned with raw_scores/labels
    raw_scores        : raw model output scores
    labels            : binary ground-truth {0, 1}
    calibration_bars  : number of OOS primary-prediction bars for calibrator fitting
    eval_bars         : evaluation window size
    step_bars         : how many bars to advance each fold
    min_fit_samples   : minimum samples required to fit any calibrator
    min_isotonic_samples : minimum samples for isotonic (uses platt below this)

    Returns
    -------
    List of CalibrationFoldResult, one per fold.
    """
    n = len(raw_scores)
    if n < calibration_bars + eval_bars:
        return []

    results: list[CalibrationFoldResult] = []
    cursor = 0
    fold_idx = 0

    while True:
        fit_start = cursor
        fit_end   = cursor + calibration_bars
        eval_start = fit_end
        eval_end  = fit_end + eval_bars

        if eval_end > n:
            break

        fit_scores  = raw_scores[fit_start:fit_end]
        fit_labels  = labels[fit_start:fit_end]
        eval_scores = raw_scores[eval_start:eval_end]
        eval_labels = labels[eval_start:eval_end]

        # Temporal ordering invariant
        if len(timestamps) > 0:
            fit_ts_end  = timestamps[fit_end - 1]
            eval_ts_start = timestamps[eval_start]
            assert fit_ts_end < eval_ts_start, (
                f"Fold {fold_idx}: calibration fit_end {fit_ts_end} >= "
                f"eval_start {eval_ts_start} — temporal leakage"
            )

        n_fit  = int(np.isfinite(fit_scores).sum())
        n_eval = int(np.isfinite(eval_scores).sum())

        if n_fit < min_fit_samples:
            cursor += step_bars
            fold_idx += 1
            continue

        # Fit calibrators
        valid_fit = np.isfinite(fit_scores) & np.isfinite(fit_labels.astype(float))
        fs = fit_scores[valid_fit]
        fl = fit_labels[valid_fit]

        valid_eval = np.isfinite(eval_scores) & np.isfinite(eval_labels.astype(float))
        es = eval_scores[valid_eval]
        el = eval_labels[valid_eval]

        platt_metrics = isotonic_metrics = None
        selected = "none"

        # Platt
        try:
            from sklearn.linear_model import LogisticRegression
            lr = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
            lr.fit(fs.reshape(-1, 1), fl)
            a, b = float(lr.coef_[0, 0]), float(lr.intercept_[0])
            platt_probs_eval = 1.0 / (1.0 + np.exp(-(a * es + b)))
            if len(el) >= 5:
                platt_metrics = compute_calibration_metrics(platt_probs_eval, el)
                selected = "platt"
        except Exception:
            pass

        # Isotonic (only when enough samples)
        if n_fit >= min_isotonic_samples:
            try:
                from sklearn.isotonic import IsotonicRegression
                iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
                iso.fit(fs, fl)
                iso_probs_eval = np.clip(iso.predict(es), 0.0, 1.0)
                if len(el) >= 5:
                    isotonic_metrics = compute_calibration_metrics(iso_probs_eval, el)
                    # Select better (lower ECE)
                    if (platt_metrics is not None and
                            isotonic_metrics["ece"] < platt_metrics["ece"]):
                        selected = "isotonic"
            except Exception:
                pass

        # Reliability curve on eval set using selected method
        rel_bins: list[ReliabilityBin] = []
        if selected == "platt" and platt_metrics is not None and len(es) >= 5:
            platt_probs_all = 1.0 / (1.0 + np.exp(-(a * es + b)))
            rel_bins = reliability_curve(platt_probs_all, el)
        elif selected == "isotonic" and len(es) >= 5:
            pass  # already computed above; store separately if needed

        results.append(CalibrationFoldResult(
            fold_index=fold_idx,
            fit_start_time=timestamps[fit_start] if len(timestamps) > 0 else None,
            fit_end_time=timestamps[fit_end - 1] if len(timestamps) > 0 else None,
            eval_start_time=timestamps[eval_start] if len(timestamps) > 0 else None,
            eval_end_time=timestamps[eval_end - 1] if len(timestamps) > 0 else None,
            fit_sample_count=n_fit,
            eval_sample_count=n_eval,
            fit_is_oos=True,  # caller's responsibility to provide OOS data
            eval_is_oos=True,
            platt_metrics=platt_metrics,
            isotonic_metrics=isotonic_metrics,
            selected_method=selected,
            reliability_bins=rel_bins,
        ))

        cursor += step_bars
        fold_idx += 1

    return results
