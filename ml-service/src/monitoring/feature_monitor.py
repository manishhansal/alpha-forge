"""
Feature Monitor — AlphaForge ML Monitoring.

Tracks per-feature drift for each deployed model using rolling production
windows compared against stored reference (training) distributions.

Responsibilities
----------------
1. Maintain a reference distribution per (model, feature) pair.
2. Collect incoming production feature vectors into a rolling buffer.
3. Run ``DriftDetector`` on each buffered feature when the buffer reaches
   the configured window size.
4. Forward drift alerts to ``AlertSystem`` and state updates to
   ``ModelRegistry``.

Architecture
------------
- Each (model_name, feature_name) pair has an independent circular buffer.
- ``FeatureMonitor.observe()`` is the hot path — called once per prediction.
  It enqueues feature values and triggers a check when the buffer is full.
- ``FeatureMonitor.force_check()`` runs an immediate check regardless of
  buffer fill level (useful for testing / manual ops).
- Thread-safe: per-model lock, global lock for registry access.

Integration note
----------------
Call ``feature_monitor.set_reference(model_name, feature_name, training_values)``
once per feature after training.  Then call ``feature_monitor.observe(model_name,
feature_vectors)`` on each batch of incoming predictions.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import numpy as np
import structlog

from .drift_detector import DriftDetector, DriftResult, DriftSeverity
from .alerts import AlertCategory, AlertSystem, emit_drift_alert

logger = structlog.get_logger()

# Default production window size before triggering a drift check
_DEFAULT_WINDOW = 200


# ---------------------------------------------------------------------------
# FeatureDriftReport — aggregated drift summary for one model
# ---------------------------------------------------------------------------

@dataclass
class FeatureDriftReport:
    """
    Aggregated drift report for a single model at one point in time.

    Attributes
    ----------
    model_name     : which model this report belongs to
    timestamp      : UTC ISO-8601
    feature_results: per-feature DriftResult objects
    n_drifted      : number of features with detected drift
    max_psi        : worst PSI across all features
    overall_severity: worst severity across all features
    """

    model_name:       str
    timestamp:        str
    feature_results:  dict[str, DriftResult]
    n_drifted:        int
    max_psi:          float
    overall_severity: DriftSeverity

    def to_dict(self) -> dict[str, Any]:
        return {
            "modelName":       self.model_name,
            "timestamp":       self.timestamp,
            "nFeatures":       len(self.feature_results),
            "nDrifted":        self.n_drifted,
            "maxPsi":          round(self.max_psi, 5),
            "overallSeverity": self.overall_severity.value,
            "features":        {k: v.to_dict() for k, v in self.feature_results.items()},
        }


# ---------------------------------------------------------------------------
# FeatureMonitor
# ---------------------------------------------------------------------------

class FeatureMonitor:
    """
    Per-feature drift monitor for all AlphaForge ML models.

    Parameters
    ----------
    drift_detector  : shared DriftDetector instance (or new one if None)
    alert_system    : AlertSystem for forwarding alerts
    model_registry  : ModelRegistry for state updates
    window_size     : number of production observations before a drift check
    min_check_size  : minimum observations required to run a check
    """

    def __init__(
        self,
        drift_detector: DriftDetector | None = None,
        alert_system: AlertSystem | None = None,
        model_registry: Any | None = None,   # ModelRegistry — avoid circular import
        window_size: int = _DEFAULT_WINDOW,
        min_check_size: int = 30,
    ) -> None:
        self._detector       = drift_detector or DriftDetector()
        self._alert_system   = alert_system
        self._model_registry = model_registry
        self._window_size    = window_size
        self._min_check_size = min_check_size

        # {model_name: {feature_name: deque[float]}}
        self._buffers: dict[str, dict[str, deque]] = {}
        # {model_name: threading.Lock}
        self._locks: dict[str, threading.Lock] = {}
        # {model_name: FeatureDriftReport}  — last report per model
        self._last_reports: dict[str, FeatureDriftReport] = {}
        self._global_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Reference distribution setup
    # ------------------------------------------------------------------

    def set_reference(
        self,
        model_name: str,
        feature_name: str,
        training_values: np.ndarray | list,
        n_bins: int | None = None,
    ) -> None:
        """
        Register the training distribution for one (model, feature) pair.

        This must be called for every feature you want to monitor before
        observations are collected.
        """
        key = self._key(model_name, feature_name)
        self._detector.set_reference(key, training_values, n_bins=n_bins)
        self._ensure_buffer(model_name, feature_name)
        logger.info(
            "feature_reference_set",
            model=model_name,
            feature=feature_name,
            n=len(training_values) if hasattr(training_values, "__len__") else "?",
        )

    def set_references_bulk(
        self,
        model_name: str,
        reference_data: dict[str, np.ndarray | list],
        n_bins: int | None = None,
    ) -> None:
        """
        Register multiple features at once for *model_name*.

        Parameters
        ----------
        model_name     : model identifier
        reference_data : {feature_name: training_values}
        """
        for feature_name, values in reference_data.items():
            self.set_reference(model_name, feature_name, values, n_bins=n_bins)

    # ------------------------------------------------------------------
    # Observation ingestion
    # ------------------------------------------------------------------

    def observe(
        self,
        model_name: str,
        feature_vector: dict[str, float],
    ) -> FeatureDriftReport | None:
        """
        Record one observation (a single prediction's feature values).

        When the internal buffer for *model_name* reaches ``window_size``,
        a drift check is automatically triggered and a ``FeatureDriftReport``
        is returned.  Otherwise returns ``None``.

        Parameters
        ----------
        model_name     : which model produced this prediction
        feature_vector : {feature_name: value} dict for this observation
        """
        self._ensure_model_buffers(model_name)
        lock = self._get_lock(model_name)

        triggered = False
        with lock:
            for fname, val in feature_vector.items():
                key = self._key(model_name, fname)
                if not self._detector.has_reference(key):
                    continue  # skip unmonitored features silently
                self._buffers[model_name].setdefault(fname, deque(maxlen=self._window_size))
                self._buffers[model_name][fname].append(float(val) if val is not None else float("nan"))

            # Check if any feature buffer has reached window_size
            max_buf = max(
                (len(buf) for buf in self._buffers[model_name].values()),
                default=0,
            )
            triggered = max_buf >= self._window_size

        if triggered:
            return self._run_check(model_name)
        return None

    def observe_batch(
        self,
        model_name: str,
        feature_vectors: list[dict[str, float]],
    ) -> FeatureDriftReport | None:
        """
        Record a batch of observations.  Returns the report from the last
        triggered check (if any).
        """
        report = None
        for fv in feature_vectors:
            r = self.observe(model_name, fv)
            if r is not None:
                report = r
        return report

    # ------------------------------------------------------------------
    # Forced / manual check
    # ------------------------------------------------------------------

    def force_check(
        self,
        model_name: str,
    ) -> FeatureDriftReport | None:
        """
        Run a drift check immediately using whatever is in the buffer,
        regardless of fill level.

        Returns ``None`` if there is insufficient data.
        """
        lock = self._get_lock(model_name)
        with lock:
            buffers = {
                fname: list(buf)
                for fname, buf in self._buffers.get(model_name, {}).items()
                if len(buf) >= self._min_check_size
            }

        if not buffers:
            logger.debug(
                "feature_check_insufficient_data",
                model=model_name,
                min_size=self._min_check_size,
            )
            return None

        return self._check_features(model_name, buffers)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def get_last_report(self, model_name: str) -> FeatureDriftReport | None:
        with self._global_lock:
            return self._last_reports.get(model_name)

    def get_all_reports(self) -> dict[str, FeatureDriftReport]:
        with self._global_lock:
            return dict(self._last_reports)

    def get_buffer_fill(self, model_name: str) -> dict[str, int]:
        """Return current buffer fill counts per feature."""
        lock = self._get_lock(model_name)
        with lock:
            return {
                fname: len(buf)
                for fname, buf in self._buffers.get(model_name, {}).items()
            }

    def monitored_features(self, model_name: str) -> list[str]:
        """Return feature names being monitored for *model_name*."""
        with self._global_lock:
            return list(self._buffers.get(model_name, {}).keys())

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _key(self, model_name: str, feature_name: str) -> str:
        return f"{model_name}::{feature_name}"

    def _ensure_model_buffers(self, model_name: str) -> None:
        with self._global_lock:
            if model_name not in self._buffers:
                self._buffers[model_name] = {}
                self._locks[model_name]   = threading.Lock()

    def _ensure_buffer(self, model_name: str, feature_name: str) -> None:
        self._ensure_model_buffers(model_name)
        with self._locks.get(model_name, threading.Lock()):
            if feature_name not in self._buffers.get(model_name, {}):
                self._buffers.setdefault(model_name, {})[feature_name] = deque(
                    maxlen=self._window_size
                )

    def _get_lock(self, model_name: str) -> threading.Lock:
        with self._global_lock:
            if model_name not in self._locks:
                self._locks[model_name] = threading.Lock()
            return self._locks[model_name]

    def _run_check(self, model_name: str) -> FeatureDriftReport:
        """Drain buffers, run checks, reset buffers."""
        lock = self._get_lock(model_name)
        with lock:
            buffers = {
                fname: list(buf)
                for fname, buf in self._buffers.get(model_name, {}).items()
                if len(buf) >= self._min_check_size
            }
            # Reset full buffers after check
            for fname in buffers:
                self._buffers[model_name][fname] = deque(maxlen=self._window_size)

        return self._check_features(model_name, buffers)

    def _check_features(
        self,
        model_name: str,
        buffers: dict[str, list],
    ) -> FeatureDriftReport:
        """Run drift detection on buffered data and build a report."""
        results: dict[str, DriftResult] = {}

        for fname, values in buffers.items():
            key = self._key(model_name, fname)
            result = self._detector.detect(key, values)
            if result is not None:
                results[fname] = result

        if not results:
            # No monitored features had references — return empty report
            report = FeatureDriftReport(
                model_name=model_name,
                timestamp=_now(),
                feature_results={},
                n_drifted=0,
                max_psi=0.0,
                overall_severity=DriftSeverity.NONE,
            )
            with self._global_lock:
                self._last_reports[model_name] = report
            return report

        drifted      = [r for r in results.values() if r.has_drift]
        max_psi      = max((r.psi for r in results.values()), default=0.0)
        severity_ord = {DriftSeverity.NONE: 0, DriftSeverity.MINOR: 1, DriftSeverity.MAJOR: 2}
        overall      = max(results.values(), key=lambda r: severity_ord[r.severity]).severity

        report = FeatureDriftReport(
            model_name=model_name,
            timestamp=_now(),
            feature_results=results,
            n_drifted=len(drifted),
            max_psi=max_psi,
            overall_severity=overall,
        )

        with self._global_lock:
            self._last_reports[model_name] = report

        logger.info(
            "feature_drift_check_complete",
            model=model_name,
            n_features=len(results),
            n_drifted=len(drifted),
            max_psi=round(max_psi, 4),
            overall_severity=overall.value,
        )

        self._handle_report(model_name, report)
        return report

    def _handle_report(
        self,
        model_name: str,
        report: FeatureDriftReport,
    ) -> None:
        """Forward results to AlertSystem and ModelRegistry."""
        if report.overall_severity == DriftSeverity.NONE:
            if self._model_registry and self._model_registry.is_registered(model_name):
                self._model_registry.mark_healthy(model_name)
            return

        # Collect the worst drifted features for alert metadata
        drifted = {
            fname: res
            for fname, res in report.feature_results.items()
            if res.has_drift
        }

        drift_meta = {
            fname: {"psi": round(res.psi, 4), "severity": res.severity.value}
            for fname, res in drifted.items()
        }

        if self._alert_system:
            worst = max(drifted.values(), key=lambda r: r.psi)
            emit_drift_alert(
                alert_system=self._alert_system,
                model_name=model_name,
                feature_name=worst.feature_name,
                psi=worst.psi,
                ks_p=worst.ks_p_value,
                js=worst.js_divergence,
                severity_str=report.overall_severity.value,
            )

        if self._model_registry and self._model_registry.is_registered(model_name):
            reasons = [
                f"Feature drift ({res.severity.value}): {fname} PSI={res.psi:.4f}"
                for fname, res in drifted.items()
            ]
            psi_values = {fname: res.psi for fname, res in drifted.items()}

            if report.overall_severity == DriftSeverity.MAJOR:
                self._model_registry.set_degraded(
                    model_name,
                    reasons=reasons,
                    drift_metrics=psi_values,
                )
            else:
                self._model_registry.set_warning(
                    model_name,
                    reasons=reasons,
                    drift_metrics=psi_values,
                )


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
