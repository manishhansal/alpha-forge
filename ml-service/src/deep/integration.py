"""
Phase 3K — Integration with Phases 3F/3G/3H/3I + complexity & latency profiling.

Deep models plug into the EXISTING downstream machinery — they do not invent
parallel calibration / EV / execution / portfolio / decay logic (spec §35–§39).

Provided here:
  - calibrate_deep_probabilities: route a deep model's RAW probabilities through
    Phase 3F calibration (spec §35). A raw sigmoid is NEVER treated as calibrated.
  - overfit_report: train/val/OOS gaps + parameter/sample ratio (spec §53, §54)
  - measure_latency: inference latency profile mean/median/p95/p99 (spec §42)
  - profile_complexity: structured complexity class (spec §41)
  - ic_decay_for_deep: route a deep signal's IC series through Phase 3I
    analyse_ic_decay (spec §39)

3G execution and 3H portfolio integration are exposed as thin adapters that hand
deep-model decisions to the existing BacktestEngine / PortfolioOptimizer using
the SAME configs as the classical baseline (fair comparison, spec §37, §38).
Because those engines require full market fixtures, the adapters are documented
entry points; the research harness uses them where fixtures exist and otherwise
records INSUFFICIENT_EVIDENCE.

Determinism: no np.random.*.
"""

from __future__ import annotations

import time
from typing import Callable, Optional

import numpy as np

from .schemas import (
    ComplexityClass, ComplexityProfile, LatencyProfile, OverfitStatus,
)


# ══════════════════════════════════════════════════════════════════════════════
# Calibration (spec §35) — via Phase 3F
# ══════════════════════════════════════════════════════════════════════════════

def _isotonic_calibrate(
    scores_fit: np.ndarray,
    labels_fit: np.ndarray,
    scores_apply: np.ndarray,
) -> np.ndarray:
    """
    Deterministic isotonic regression (Pool-Adjacent-Violators) fit on the
    calibration block, applied to new scores by monotone interpolation. Used
    only when the sklearn-backed Phase 3F calibrator is unavailable in the
    environment. Pure NumPy, no external dependency.
    """
    s = np.asarray(scores_fit, dtype=float)
    y = np.asarray(labels_fit, dtype=float)
    order = np.argsort(s, kind="mergesort")
    s_sorted = s[order]
    y_sorted = y[order]

    # PAV: produce a non-decreasing fit g(s)
    g = y_sorted.astype(float).copy()
    w = np.ones_like(g)
    # merge adjacent violators
    i = 0
    blocks = [[g[k], w[k], k, k] for k in range(len(g))]  # value, weight, lo, hi
    merged = []
    for b in blocks:
        merged.append(b)
        while len(merged) > 1 and merged[-2][0] > merged[-1][0]:
            v2, w2, lo2, hi2 = merged.pop()
            v1, w1, lo1, hi1 = merged.pop()
            nw = w1 + w2
            nv = (v1 * w1 + v2 * w2) / nw
            merged.append([nv, nw, lo1, hi2])
    fitted = np.empty_like(g)
    for v, wt, lo, hi in merged:
        fitted[lo:hi + 1] = v

    # apply by interpolation over the sorted score->fitted mapping
    out = np.interp(np.asarray(scores_apply, dtype=float), s_sorted, fitted)
    return np.clip(out, 0.0, 1.0)


def calibrate_deep_probabilities(
    raw_probs_calib: np.ndarray,
    labels_calib: np.ndarray,
    raw_probs_oos: np.ndarray,
    labels_oos: np.ndarray,
    n_bins: int = 10,
) -> dict:
    """
    Calibrate a deep model's RAW probabilities using Phase 3F and report OOS
    calibration metrics (spec §35). Calibration data must be CHRONOLOGICALLY
    separated from OOS by the caller.

    Returns before/after calibration metrics. A raw sigmoid output is never
    reported as a calibrated probability without this step.
    """
    from src.meta.calibration_engine import compute_calibration_metrics

    rc = np.asarray(raw_probs_calib, dtype=float)
    lc = np.asarray(labels_calib, dtype=float)
    ro = np.asarray(raw_probs_oos, dtype=float)
    lo = np.asarray(labels_oos, dtype=float)

    before = compute_calibration_metrics(ro, lo, n_bins=n_bins)

    # Prefer the Phase 3F CalibratorArtifact (isotonic via sklearn) when the
    # sklearn stack imports cleanly; otherwise use a pure-NumPy isotonic (PAV)
    # fallback so the calibration DISCIPLINE (fit on separated block, apply to
    # OOS) still holds in this environment. A raw sigmoid is NEVER reported as
    # calibrated (spec §35).
    method_used = "UNCALIBRATED_FALLBACK"
    calibrated_oos = ro
    try:
        from src.meta.calibration_engine import CalibratorArtifact
        art = CalibratorArtifact(
            calibrator_id="deep-calibrator", model_id="deep-model",
            model_version="v1", calibration_method="isotonic",
            calibration_version="cal-v1", fit_end_time=None, effective_from=None,
            fit_sample_count=int(rc.size),
        )
        art.fit_isotonic(rc, lc)
        probs, status = art.predict(ro, "deep-model", "v1")
        if probs is not None:
            calibrated_oos = np.asarray(probs, dtype=float)
            method_used = "isotonic_phase3f"
    except Exception:
        # Pure-NumPy isotonic fallback (Pool-Adjacent-Violators)
        try:
            calibrated_oos = _isotonic_calibrate(rc, lc, ro)
            method_used = "isotonic_numpy_fallback"
        except Exception:
            method_used = "UNCALIBRATED_FALLBACK"

    after = compute_calibration_metrics(calibrated_oos, lo, n_bins=n_bins)
    return {
        "method": method_used,
        "before_calibration": before,
        "after_calibration": after,
        "improved_brier": bool(after.get("brier", 1e9) <= before.get("brier", 1e9)),
        "note": "Raw deep output is NOT a calibrated probability until this step (spec §35).",
    }


# ══════════════════════════════════════════════════════════════════════════════
# Overfitting diagnostics (spec §53, §54)
# ══════════════════════════════════════════════════════════════════════════════

def overfit_report(
    train_ic: Optional[float],
    val_ic: Optional[float],
    oos_ic: Optional[float],
    trainable_parameters: int,
    training_samples: int,
    mild_gap: float = 0.10,
    large_gap: float = 0.25,
) -> dict:
    """
    Compare train/val/OOS performance and flag large gaps (spec §53). Also
    reports the parameter/sample ratio diagnostic (spec §54) WITHOUT claiming any
    ratio is universally safe.
    """
    def gap(a, b):
        if a is None or b is None:
            return None
        return float(a - b)

    tv = gap(train_ic, val_ic)
    vo = gap(val_ic, oos_ic)
    status = OverfitStatus.INSUFFICIENT_EVIDENCE
    if tv is not None and vo is not None:
        worst = max(abs(tv), abs(vo))
        if worst >= large_gap:
            status = OverfitStatus.LARGE_GAP
        elif worst >= mild_gap:
            status = OverfitStatus.MILD_GAP
        else:
            status = OverfitStatus.OK

    ratio = (trainable_parameters / training_samples) if training_samples > 0 else None
    return {
        "train_ic": train_ic, "val_ic": val_ic, "oos_ic": oos_ic,
        "train_minus_val": tv, "val_minus_oos": vo,
        "status": status.value,
        "trainable_parameters": trainable_parameters,
        "training_samples": training_samples,
        "parameter_sample_ratio": ratio,
        "ratio_note": "No parameter/sample ratio is universally safe; interpret with the gap.",
    }


# ══════════════════════════════════════════════════════════════════════════════
# Latency profiling (spec §42)
# ══════════════════════════════════════════════════════════════════════════════

def measure_latency(
    predict_fn: Callable[[np.ndarray], np.ndarray],
    X_sample: np.ndarray,
    n_trials: int = 50,
    batch_size: int = 1,
) -> LatencyProfile:
    """
    Measure single-inference latency. Reports mean/median/p95/p99 in ms; fields
    are None when there are too few observations to be meaningful (spec §42).
    Timing is wall-clock; this is a research-machine measurement, and the
    complexity report notes that production hardware may differ (spec §42).
    """
    X = np.asarray(X_sample, dtype=float)
    if X.shape[0] == 0:
        return LatencyProfile(n_observations=0)
    times_ms: list[float] = []
    n = X.shape[0]
    for i in range(n_trials):
        start = (i * batch_size) % n
        xb = X[start:start + batch_size]
        if xb.shape[0] == 0:
            xb = X[:batch_size]
        t0 = time.perf_counter()
        predict_fn(xb)
        times_ms.append((time.perf_counter() - t0) * 1000.0)

    arr = np.array(times_ms)
    has_tail = len(arr) >= 20
    return LatencyProfile(
        n_observations=len(arr),
        mean_ms=float(np.mean(arr)),
        median_ms=float(np.median(arr)),
        p95_ms=float(np.percentile(arr, 95)) if has_tail else None,
        p99_ms=float(np.percentile(arr, 99)) if has_tail else None,
    )


# ══════════════════════════════════════════════════════════════════════════════
# Complexity classification (spec §41) — structured, NOT a numeric penalty
# ══════════════════════════════════════════════════════════════════════════════

def profile_complexity(
    parameter_count: int,
    trainable_parameters: int,
    model_size_bytes: int,
    training_time_s: Optional[float] = None,
    inference_time_ms: Optional[float] = None,
    memory_mb: Optional[float] = None,
    requires_gpu: bool = False,
    dependencies: Optional[list[str]] = None,
    is_sequential: bool = False,
    has_attention: bool = False,
) -> ComplexityProfile:
    """
    Classify production complexity into LOW/MODERATE/HIGH/VERY_HIGH from
    documented criteria (spec §41). No subjective numeric score.

    Heuristic (documented, not a black box):
      - GPU requirement or attention -> at least HIGH
      - sequential (RNN) -> at least MODERATE
      - >100k params -> at least MODERATE; >1M -> HIGH
      - otherwise LOW
    """
    deps = dependencies or []
    criteria: list[str] = []
    level = 0  # 0 LOW, 1 MODERATE, 2 HIGH, 3 VERY_HIGH

    if parameter_count > 1_000_000:
        level = max(level, 2); criteria.append("param_count>1M")
    elif parameter_count > 100_000:
        level = max(level, 1); criteria.append("param_count>100k")
    if is_sequential:
        level = max(level, 1); criteria.append("sequential_recurrence")
    if has_attention:
        level = max(level, 2); criteria.append("attention_mechanism")
    if requires_gpu:
        level = max(level, 2); criteria.append("requires_gpu")
    if len(deps) > 3:
        level = max(level, 1); criteria.append("many_dependencies")
    if requires_gpu and has_attention and parameter_count > 1_000_000:
        level = 3; criteria.append("large_gpu_attention_model")

    cls = [ComplexityClass.LOW, ComplexityClass.MODERATE,
           ComplexityClass.HIGH, ComplexityClass.VERY_HIGH][level]

    debug = {0: "high", 1: "moderate", 2: "moderate", 3: "low"}[level]
    oprisk = {0: "low", 1: "low", 2: "moderate", 3: "high"}[level]

    return ComplexityProfile(
        complexity_class=cls,
        parameter_count=parameter_count,
        trainable_parameters=trainable_parameters,
        model_size_bytes=model_size_bytes,
        training_time_s=training_time_s,
        inference_time_ms=inference_time_ms,
        memory_mb=memory_mb,
        requires_gpu=requires_gpu,
        dependencies=deps,
        hardware_notes="Latency measured on research machine (CPU, arm64); "
                       "production hardware may differ (spec §42).",
        debuggability=debug,
        operational_risk=oprisk,
        criteria=criteria or ["small_model"],
    )


# ══════════════════════════════════════════════════════════════════════════════
# Decay (spec §39) — via Phase 3I
# ══════════════════════════════════════════════════════════════════════════════

def ic_decay_for_deep(
    ic_series,           # pd.Series indexed by timestamp
    rank_ic_series,      # pd.Series indexed by timestamp
    signal_id: str,
    horizon_bars: int,
):
    """
    Route a deep signal's IC time series through the Phase 3I decay analyser
    (spec §39). Returns the Phase 3I ICDecayResult (no duplication).
    """
    from src.stability import analyse_ic_decay
    return analyse_ic_decay(ic_series, rank_ic_series, signal_id=signal_id,
                            horizon_bars=horizon_bars)


# ══════════════════════════════════════════════════════════════════════════════
# 3G / 3H adapters (spec §37, §38) — thin, fair, documented entry points
# ══════════════════════════════════════════════════════════════════════════════

def execution_adapter_available() -> bool:
    """True if the Phase 3G BacktestEngine imports in this environment."""
    try:
        from src.execution.backtest_engine import BacktestEngine  # noqa: F401
        return True
    except Exception:
        return False


def portfolio_adapter_available() -> bool:
    """True if the Phase 3H PortfolioOptimizer imports in this environment."""
    try:
        from src.portfolio.optimizer import PortfolioOptimizer  # noqa: F401
        return True
    except Exception:
        return False
