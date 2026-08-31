"""
Alert System — AlphaForge ML Monitoring.

Defines alert severity levels, alert data structures, and a centralised
``AlertSystem`` that routes alerts to structured log sinks and maintains
an in-memory history for the dashboard API.

Design
------
- Alerts are *immutable* dataclasses created at detection time.
- ``AlertSystem`` stores the last N alerts in a deque for the API.
- Every alert is emitted via ``structlog`` so it appears in log pipelines.
- External webhook dispatch (Slack, PagerDuty) can be wired by overriding
  ``AlertSystem.dispatch_external()``.
- No database dependency — all state is in-process.
- Thread-safe via a ``threading.Lock`` on the history deque.

Alert severity ladder
---------------------
  INFO     → normal operating event worth logging (e.g. model recovered)
  WARNING  → minor drift or performance degradation — monitor closely
  CRITICAL → major drift, model degraded — automatic weight reduction applied
  DISABLED → model has been disabled and removed from the ensemble
"""

from __future__ import annotations

import threading
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

import structlog

logger = structlog.get_logger()

# Maximum alerts kept in memory for the dashboard
_MAX_HISTORY = 500


# ---------------------------------------------------------------------------
# Severity
# ---------------------------------------------------------------------------

class AlertSeverity(str, Enum):
    INFO     = "info"
    WARNING  = "warning"
    CRITICAL = "critical"
    DISABLED = "disabled"


# ---------------------------------------------------------------------------
# Alert categories
# ---------------------------------------------------------------------------

class AlertCategory(str, Enum):
    FEATURE_DRIFT     = "feature_drift"
    PREDICTION_DRIFT  = "prediction_drift"
    PERFORMANCE       = "performance"
    STRATEGY_DECAY    = "strategy_decay"
    MODEL_STATE       = "model_state"
    RETRAINING        = "retraining"
    SYSTEM            = "system"


# ---------------------------------------------------------------------------
# Alert dataclass
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Alert:
    """
    Immutable alert record.

    Attributes
    ----------
    alert_id   : UUID string, auto-generated
    timestamp  : UTC ISO-8601 string
    severity   : INFO | WARNING | CRITICAL | DISABLED
    category   : what type of event triggered this alert
    model_name : which model is affected (or "system" for global events)
    title      : short human-readable title (< 80 chars)
    message    : full detail message
    metadata   : arbitrary key-value context (PSI values, drift stats, etc.)
    """

    alert_id:   str
    timestamp:  str
    severity:   AlertSeverity
    category:   AlertCategory
    model_name: str
    title:      str
    message:    str
    metadata:   dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "alertId":   self.alert_id,
            "timestamp": self.timestamp,
            "severity":  self.severity.value,
            "category":  self.category.value,
            "modelName": self.model_name,
            "title":     self.title,
            "message":   self.message,
            "metadata":  self.metadata,
        }


def _make_alert(
    severity: AlertSeverity,
    category: AlertCategory,
    model_name: str,
    title: str,
    message: str,
    metadata: dict[str, Any] | None = None,
) -> Alert:
    return Alert(
        alert_id=str(uuid.uuid4()),
        timestamp=datetime.now(timezone.utc).isoformat(),
        severity=severity,
        category=category,
        model_name=model_name,
        title=title,
        message=message,
        metadata=metadata or {},
    )


# ---------------------------------------------------------------------------
# AlertSystem
# ---------------------------------------------------------------------------

class AlertSystem:
    """
    Central alert dispatcher for the monitoring pipeline.

    Usage
    -----
    ::

        alerts = AlertSystem()

        # Emit a warning
        alerts.warn(
            category=AlertCategory.FEATURE_DRIFT,
            model_name="regime",
            title="Feature PSI > 0.10",
            message="Feature 'india_vix' PSI=0.18 — minor drift detected.",
            metadata={"feature": "india_vix", "psi": 0.18},
        )

        # Retrieve recent alerts for the dashboard
        recent = alerts.get_recent(limit=50)

    Thread safety
    -------------
    All public methods are protected by a ``threading.Lock``.
    """

    def __init__(self, max_history: int = _MAX_HISTORY) -> None:
        self._history: deque[Alert] = deque(maxlen=max_history)
        self._lock = threading.Lock()
        self._suppressed_models: set[str] = set()   # models in DISABLED state

    # ------------------------------------------------------------------
    # Emit helpers
    # ------------------------------------------------------------------

    def info(
        self,
        category: AlertCategory,
        model_name: str,
        title: str,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> Alert:
        return self._emit(
            AlertSeverity.INFO, category, model_name, title, message, metadata
        )

    def warn(
        self,
        category: AlertCategory,
        model_name: str,
        title: str,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> Alert:
        return self._emit(
            AlertSeverity.WARNING, category, model_name, title, message, metadata
        )

    def critical(
        self,
        category: AlertCategory,
        model_name: str,
        title: str,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> Alert:
        return self._emit(
            AlertSeverity.CRITICAL, category, model_name, title, message, metadata
        )

    def disabled_alert(
        self,
        model_name: str,
        reason: str,
        metadata: dict[str, Any] | None = None,
    ) -> Alert:
        return self._emit(
            AlertSeverity.DISABLED,
            AlertCategory.MODEL_STATE,
            model_name,
            f"Model '{model_name}' DISABLED",
            reason,
            metadata,
        )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _emit(
        self,
        severity: AlertSeverity,
        category: AlertCategory,
        model_name: str,
        title: str,
        message: str,
        metadata: dict[str, Any] | None,
    ) -> Alert:
        alert = _make_alert(severity, category, model_name, title, message, metadata)

        with self._lock:
            self._history.append(alert)

        # Structured log — appears in all log pipelines
        log_fn = (
            logger.error   if severity == AlertSeverity.CRITICAL  else
            logger.warning if severity == AlertSeverity.WARNING    else
            logger.info
        )
        log_fn(
            "monitoring_alert",
            alert_id=alert.alert_id,
            severity=severity.value,
            category=category.value,
            model=model_name,
            title=title,
            message=message,
            **(metadata or {}),
        )

        self.dispatch_external(alert)
        return alert

    # ------------------------------------------------------------------
    # Override for external dispatch (Slack, PagerDuty, etc.)
    # ------------------------------------------------------------------

    def dispatch_external(self, alert: Alert) -> None:
        """
        Override this method to forward alerts to external sinks.

        The default implementation is a no-op.  Example override::

            class SlackAlertSystem(AlertSystem):
                def dispatch_external(self, alert: Alert) -> None:
                    if alert.severity in (AlertSeverity.CRITICAL,
                                          AlertSeverity.DISABLED):
                        slack_client.post_message(
                            channel="#ml-alerts",
                            text=f"[{alert.severity}] {alert.title}\\n{alert.message}",
                        )
        """

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def get_recent(
        self,
        limit: int = 100,
        severity: AlertSeverity | None = None,
        model_name: str | None = None,
        category: AlertCategory | None = None,
    ) -> list[Alert]:
        """
        Return the most recent alerts, optionally filtered.

        Parameters
        ----------
        limit      : maximum number of alerts to return
        severity   : filter to a specific severity level
        model_name : filter to a specific model
        category   : filter to a specific alert category

        Returns
        -------
        List of Alert objects (newest first)
        """
        with self._lock:
            items = list(self._history)

        # newest first
        items = list(reversed(items))

        if severity is not None:
            items = [a for a in items if a.severity == severity]
        if model_name is not None:
            items = [a for a in items if a.model_name == model_name]
        if category is not None:
            items = [a for a in items if a.category == category]

        return items[:limit]

    def get_summary(self) -> dict[str, Any]:
        """Count of alerts by severity for the dashboard."""
        with self._lock:
            items = list(self._history)

        summary: dict[str, int] = {s.value: 0 for s in AlertSeverity}
        for a in items:
            summary[a.severity.value] += 1

        return {
            "total":   len(items),
            "counts":  summary,
            "recent":  [a.to_dict() for a in list(reversed(items))[:5]],
        }

    def clear(self) -> None:
        """Clear alert history (useful in tests)."""
        with self._lock:
            self._history.clear()


# ---------------------------------------------------------------------------
# Convenience rule-based alert generators
# ---------------------------------------------------------------------------

def emit_drift_alert(
    alert_system: AlertSystem,
    model_name: str,
    feature_name: str,
    psi: float,
    ks_p: float,
    js: float,
    severity_str: str,
) -> Alert:
    """Emit a pre-formatted drift alert."""
    sev = AlertSeverity.CRITICAL if severity_str == "major" else AlertSeverity.WARNING
    return alert_system._emit(
        sev,
        AlertCategory.FEATURE_DRIFT,
        model_name,
        f"Feature drift detected: {feature_name}",
        (
            f"Feature '{feature_name}' shows {severity_str} drift. "
            f"PSI={psi:.4f}, KS_p={ks_p:.4f}, JS={js:.4f}."
        ),
        {"feature": feature_name, "psi": psi, "ks_p": ks_p, "js": js},
    )


def emit_performance_alert(
    alert_system: AlertSystem,
    model_name: str,
    metric_name: str,
    current_value: float,
    threshold: float,
    direction: Literal["above", "below"] = "below",  # noqa: F821
) -> Alert:
    """Emit a pre-formatted performance degradation alert."""
    from typing import Literal  # noqa: PLC0415 — intentional local import

    sev = AlertSeverity.CRITICAL
    return alert_system._emit(
        sev,
        AlertCategory.PERFORMANCE,
        model_name,
        f"Performance degradation: {model_name} — {metric_name}",
        (
            f"Model '{model_name}' metric '{metric_name}' is {current_value:.4f}, "
            f"threshold is {threshold:.4f} ({direction})."
        ),
        {"metric": metric_name, "value": current_value, "threshold": threshold},
    )


def emit_retraining_recommendation(
    alert_system: AlertSystem,
    model_name: str,
    reasons: list[str],
    metadata: dict[str, Any] | None = None,
) -> Alert:
    """Emit a retraining recommendation alert (INFO severity)."""
    return alert_system._emit(
        AlertSeverity.WARNING,
        AlertCategory.RETRAINING,
        model_name,
        f"Retraining recommended: {model_name}",
        "Model performance or distribution shift has exceeded thresholds. "
        "Manual retraining is recommended. Reasons: " + "; ".join(reasons),
        metadata or {},
    )
