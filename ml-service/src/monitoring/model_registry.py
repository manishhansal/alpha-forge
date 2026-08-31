"""
Model Registry — AlphaForge ML Monitoring.

Every deployed model must be registered here with full provenance metadata.
The registry tracks model health states and enforces automatic safety actions:

  State transitions
  -----------------
  HEALTHY   → WARNING   : minor drift or performance degradation detected
  WARNING   → DEGRADED  : repeated / major drift or performance below threshold
  DEGRADED  → DISABLED  : persistent degradation beyond the grace period
  * → HEALTHY           : manual recovery after retraining / recalibration

  Auto safety actions
  -------------------
  DEGRADED  : model weight is reduced to ``degraded_weight_factor`` × base weight
  DISABLED  : model is removed from the Meta Decision Engine ensemble (weight = 0)

  Retraining
  ----------
  The registry never triggers automatic retraining in production.
  Instead it creates a ``RetrainingRecommendation`` record and emits a
  WARNING alert so a human operator can review and schedule retraining.

Design
------
- Thread-safe via per-model ``threading.Lock``.
- Pure in-memory; persists to / restores from JSON for restart survival.
- Integrates with ``AlertSystem`` to emit state-change alerts.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

import structlog

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Model state enum
# ---------------------------------------------------------------------------

class ModelState(str, Enum):
    HEALTHY   = "healthy"
    WARNING   = "warning"
    DEGRADED  = "degraded"
    DISABLED  = "disabled"


# Numeric severity so we can compare states
_STATE_SEVERITY: dict[ModelState, int] = {
    ModelState.HEALTHY:  0,
    ModelState.WARNING:  1,
    ModelState.DEGRADED: 2,
    ModelState.DISABLED: 3,
}

# Weight multipliers applied automatically on state change
_WEIGHT_MULTIPLIERS: dict[ModelState, float] = {
    ModelState.HEALTHY:  1.00,
    ModelState.WARNING:  0.75,
    ModelState.DEGRADED: 0.30,
    ModelState.DISABLED: 0.00,
}


# ---------------------------------------------------------------------------
# Retraining recommendation
# ---------------------------------------------------------------------------

@dataclass
class RetrainingRecommendation:
    """
    A structured recommendation that a model should be retrained.

    Created automatically when a model enters DEGRADED state.
    Never triggers automatic retraining — operator action is required.
    """

    model_name:       str
    created_at:       str   # ISO-8601 UTC
    reasons:          list[str]
    current_state:    ModelState
    drift_metrics:    dict[str, float] = field(default_factory=dict)
    performance_metrics: dict[str, float] = field(default_factory=dict)
    acknowledged:     bool = False
    acknowledged_by:  str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "modelName":          self.model_name,
            "createdAt":          self.created_at,
            "reasons":            self.reasons,
            "currentState":       self.current_state.value,
            "driftMetrics":       self.drift_metrics,
            "performanceMetrics": self.performance_metrics,
            "acknowledged":       self.acknowledged,
            "acknowledgedBy":     self.acknowledged_by,
        }


# ---------------------------------------------------------------------------
# Model record (registry entry)
# ---------------------------------------------------------------------------

@dataclass
class ModelRecord:
    """
    Full provenance and runtime health record for one deployed model.

    Required fields (set at registration time)
    -------------------------------------------
    model_name       : unique identifier — must match ``MODEL_NAMES`` in ensemble
    model_version    : semantic version string, e.g. "regime-xgb-v1"
    dataset_version  : training dataset identifier / hash
    feature_version  : feature engineering version tag
    training_period  : human-readable training window, e.g. "2022-01-01/2024-06-30"
    deployment_date  : ISO-8601 UTC deployment timestamp

    Validation metrics (filled at registration)
    --------------------------------------------
    validation_metrics : dict of metric_name → value from the final eval run

    Runtime state (updated by monitoring)
    --------------------------------------
    state            : current ModelState
    weight_multiplier: effective weight multiplier ∈ [0, 1]
    consecutive_warnings : number of consecutive warning evaluations
    retraining_recommendations : list of RetrainingRecommendation
    state_history    : list of (timestamp, old_state, new_state) transitions
    """

    # -- Provenance (immutable after registration) -------------------------
    model_name:         str
    model_version:      str
    dataset_version:    str
    feature_version:    str
    training_period:    str
    deployment_date:    str

    # -- Validation metrics -----------------------------------------------
    validation_metrics: dict[str, float] = field(default_factory=dict)

    # -- Runtime state (mutable) ------------------------------------------
    state:               ModelState = ModelState.HEALTHY
    weight_multiplier:   float      = 1.0
    consecutive_warnings: int       = 0

    # -- History ----------------------------------------------------------
    retraining_recommendations: list[RetrainingRecommendation] = field(
        default_factory=list
    )
    state_history: list[dict[str, str]] = field(default_factory=list)

    # -- Internal ---------------------------------------------------------
    last_evaluated_at: str = ""
    notes:             str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "modelName":          self.model_name,
            "modelVersion":       self.model_version,
            "datasetVersion":     self.dataset_version,
            "featureVersion":     self.feature_version,
            "trainingPeriod":     self.training_period,
            "deploymentDate":     self.deployment_date,
            "validationMetrics":  self.validation_metrics,
            "state":              self.state.value,
            "weightMultiplier":   round(self.weight_multiplier, 4),
            "consecutiveWarnings":self.consecutive_warnings,
            "lastEvaluatedAt":    self.last_evaluated_at,
            "notes":              self.notes,
            "retrainingRecommendations": [
                r.to_dict() for r in self.retraining_recommendations
            ],
            "stateHistory": self.state_history[-20:],  # last 20 transitions
        }


# ---------------------------------------------------------------------------
# ModelRegistry
# ---------------------------------------------------------------------------

class ModelRegistry:
    """
    Central registry for all deployed AlphaForge ML models.

    Parameters
    ----------
    alert_system : AlertSystem | None
        If provided, state-change events are forwarded as alerts.
    warn_after_n : int
        Number of consecutive WARNING evaluations before escalating to DEGRADED.
    persist_path : Path | None
        If set, the registry is saved to / loaded from this JSON file on
        every state change (for restart survival).

    Example
    -------
    ::

        from monitoring.model_registry import ModelRegistry, ModelRecord
        from monitoring.alerts import AlertSystem

        alerts  = AlertSystem()
        registry = ModelRegistry(alert_system=alerts)

        registry.register(ModelRecord(
            model_name="regime",
            model_version="regime-xgb-v2",
            dataset_version="ds-2024-q4",
            feature_version="feat-v3",
            training_period="2022-01-01/2024-09-30",
            deployment_date="2024-10-01T00:00:00Z",
            validation_metrics={"accuracy": 0.74, "f1": 0.71},
        ))

        # Mark a warning
        registry.set_warning("regime", reasons=["PSI > 0.10 on india_vix"])

        # Get effective weight for ensemble
        weight = registry.get_weight("regime")   # 0.75
    """

    def __init__(
        self,
        alert_system: Any | None = None,
        warn_after_n: int = 3,
        persist_path: Path | None = None,
    ) -> None:
        self._records: dict[str, ModelRecord] = {}
        self._locks:   dict[str, threading.Lock] = {}
        self._global_lock = threading.Lock()
        self._alert_system = alert_system
        self._warn_after_n = warn_after_n
        self._persist_path = persist_path

        if persist_path and persist_path.exists():
            self._load(persist_path)

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(self, record: ModelRecord) -> None:
        """
        Register a model with the registry.  Safe to call multiple times;
        re-registration updates the provenance fields without resetting
        the runtime state.
        """
        with self._global_lock:
            if record.model_name in self._records:
                existing = self._records[record.model_name]
                # Update provenance, keep runtime state
                existing.model_version   = record.model_version
                existing.dataset_version = record.dataset_version
                existing.feature_version = record.feature_version
                existing.training_period = record.training_period
                existing.deployment_date = record.deployment_date
                existing.validation_metrics = record.validation_metrics
                logger.info(
                    "model_registry_updated",
                    model=record.model_name,
                    version=record.model_version,
                )
            else:
                self._records[record.model_name] = record
                self._locks[record.model_name] = threading.Lock()
                logger.info(
                    "model_registry_registered",
                    model=record.model_name,
                    version=record.model_version,
                    state=record.state.value,
                )

        self._maybe_persist()

    def is_registered(self, model_name: str) -> bool:
        with self._global_lock:
            return model_name in self._records

    def get(self, model_name: str) -> ModelRecord | None:
        with self._global_lock:
            return self._records.get(model_name)

    def all_records(self) -> list[ModelRecord]:
        with self._global_lock:
            return list(self._records.values())

    def registered_names(self) -> list[str]:
        with self._global_lock:
            return list(self._records.keys())

    # ------------------------------------------------------------------
    # State transitions
    # ------------------------------------------------------------------

    def set_warning(
        self,
        model_name: str,
        reasons: list[str],
        drift_metrics: dict[str, float] | None = None,
        performance_metrics: dict[str, float] | None = None,
    ) -> ModelState:
        """
        Escalate model to WARNING (or DEGRADED if consecutive warnings exceeded).

        Returns the new state.
        """
        record = self._require(model_name)
        with self._locks[model_name]:
            if record.state == ModelState.DISABLED:
                return record.state   # disabled models are not auto-recovered

            record.consecutive_warnings += 1
            record.last_evaluated_at = _now()

            if (
                record.consecutive_warnings >= self._warn_after_n
                and record.state != ModelState.DEGRADED
            ):
                return self._transition(
                    record,
                    ModelState.DEGRADED,
                    reasons,
                    drift_metrics,
                    performance_metrics,
                )

            if record.state == ModelState.HEALTHY:
                return self._transition(
                    record,
                    ModelState.WARNING,
                    reasons,
                    drift_metrics,
                    performance_metrics,
                )

            # Already WARNING — update metrics, emit alert again
            self._emit_alert(record, reasons, drift_metrics, performance_metrics)
            self._maybe_persist()
            return record.state

    def set_degraded(
        self,
        model_name: str,
        reasons: list[str],
        drift_metrics: dict[str, float] | None = None,
        performance_metrics: dict[str, float] | None = None,
    ) -> ModelState:
        """Force a model to DEGRADED state and create a retraining recommendation."""
        record = self._require(model_name)
        with self._locks[model_name]:
            if record.state == ModelState.DISABLED:
                return record.state
            return self._transition(
                record, ModelState.DEGRADED, reasons, drift_metrics, performance_metrics
            )

    def set_disabled(
        self,
        model_name: str,
        reasons: list[str],
    ) -> ModelState:
        """
        Disable a model — weight drops to 0.0 and it is excluded from the ensemble.

        This is the most severe state.  Recovery requires explicit ``recover()``.
        """
        record = self._require(model_name)
        with self._locks[model_name]:
            return self._transition(record, ModelState.DISABLED, reasons)

    def recover(
        self,
        model_name: str,
        notes: str = "",
    ) -> ModelState:
        """
        Manually recover a model back to HEALTHY.

        Should only be called after a human operator has reviewed the situation
        and confirmed that the model is healthy again (e.g. after retraining).
        """
        record = self._require(model_name)
        with self._locks[model_name]:
            old_state = record.state
            record.state                = ModelState.HEALTHY
            record.weight_multiplier    = _WEIGHT_MULTIPLIERS[ModelState.HEALTHY]
            record.consecutive_warnings = 0
            record.last_evaluated_at    = _now()
            record.notes                = notes

            record.state_history.append({
                "timestamp": _now(),
                "from":      old_state.value,
                "to":        ModelState.HEALTHY.value,
                "reason":    f"Manual recovery. {notes}".strip(),
            })

            logger.info(
                "model_recovered",
                model=model_name,
                previous_state=old_state.value,
            )

            if self._alert_system:
                from .alerts import AlertCategory, AlertSeverity
                self._alert_system.info(
                    category=AlertCategory.MODEL_STATE,
                    model_name=model_name,
                    title=f"Model '{model_name}' recovered to HEALTHY",
                    message=f"Previous state: {old_state.value}. {notes}",
                    metadata={"previous_state": old_state.value},
                )

        self._maybe_persist()
        return ModelState.HEALTHY

    def mark_healthy(self, model_name: str) -> ModelState:
        """
        Reset consecutive-warning counter without changing state.
        Call when an evaluation passes cleanly.
        """
        record = self._require(model_name)
        with self._locks[model_name]:
            if record.state == ModelState.HEALTHY:
                record.consecutive_warnings = 0
                record.last_evaluated_at = _now()
        return record.state

    # ------------------------------------------------------------------
    # Weight access (used by Meta Decision Engine integration)
    # ------------------------------------------------------------------

    def get_weight(self, model_name: str) -> float:
        """
        Return the current weight multiplier for *model_name*.

        - HEALTHY   → 1.00
        - WARNING   → 0.75
        - DEGRADED  → 0.30
        - DISABLED  → 0.00
        - Unknown   → 1.00 (not registered — no adjustment)
        """
        with self._global_lock:
            rec = self._records.get(model_name)
        return rec.weight_multiplier if rec else 1.0

    def get_active_models(self) -> list[str]:
        """Return model names that are NOT disabled (weight > 0)."""
        with self._global_lock:
            return [
                name for name, rec in self._records.items()
                if rec.state != ModelState.DISABLED
            ]

    def get_disabled_models(self) -> list[str]:
        """Return model names that are DISABLED."""
        with self._global_lock:
            return [
                name for name, rec in self._records.items()
                if rec.state == ModelState.DISABLED
            ]

    def get_all_weights(self) -> dict[str, float]:
        """Return {model_name: weight_multiplier} for all registered models."""
        with self._global_lock:
            return {
                name: rec.weight_multiplier
                for name, rec in self._records.items()
            }

    # ------------------------------------------------------------------
    # Dashboard summary
    # ------------------------------------------------------------------

    def health_summary(self) -> dict[str, Any]:
        """Full registry state for the dashboard API."""
        with self._global_lock:
            records = list(self._records.values())

        state_counts: dict[str, int] = {s.value: 0 for s in ModelState}
        for rec in records:
            state_counts[rec.state.value] += 1

        return {
            "totalModels":  len(records),
            "stateCounts":  state_counts,
            "models":       [r.to_dict() for r in records],
            "activeModels": [r.model_name for r in records
                             if r.state != ModelState.DISABLED],
            "disabledModels": [r.model_name for r in records
                               if r.state == ModelState.DISABLED],
        }

    def get_retraining_recommendations(
        self,
        unacknowledged_only: bool = True,
    ) -> list[RetrainingRecommendation]:
        """Return all pending retraining recommendations."""
        with self._global_lock:
            records = list(self._records.values())

        recommendations: list[RetrainingRecommendation] = []
        for rec in records:
            for r in rec.retraining_recommendations:
                if unacknowledged_only and r.acknowledged:
                    continue
                recommendations.append(r)

        # Newest first
        recommendations.sort(key=lambda r: r.created_at, reverse=True)
        return recommendations

    def acknowledge_recommendation(
        self,
        model_name: str,
        acknowledged_by: str = "operator",
    ) -> int:
        """
        Acknowledge all pending retraining recommendations for a model.
        Returns the count of recommendations acknowledged.
        """
        record = self._require(model_name)
        count = 0
        with self._locks[model_name]:
            for r in record.retraining_recommendations:
                if not r.acknowledged:
                    # RetrainingRecommendation is a regular dataclass (mutable)
                    r.acknowledged    = True
                    r.acknowledged_by = acknowledged_by
                    count += 1
        self._maybe_persist()
        return count

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _require(self, model_name: str) -> ModelRecord:
        with self._global_lock:
            rec = self._records.get(model_name)
        if rec is None:
            raise KeyError(f"Model '{model_name}' is not registered in ModelRegistry.")
        return rec

    def _transition(
        self,
        record: ModelRecord,
        new_state: ModelState,
        reasons: list[str],
        drift_metrics: dict[str, float] | None = None,
        performance_metrics: dict[str, float] | None = None,
    ) -> ModelState:
        """
        Apply a state transition (caller must hold the model's lock).
        Updates weight multiplier, appends history, creates recommendation if needed.
        """
        old_state = record.state
        record.state             = new_state
        record.weight_multiplier = _WEIGHT_MULTIPLIERS[new_state]
        record.last_evaluated_at = _now()

        record.state_history.append({
            "timestamp": _now(),
            "from":      old_state.value,
            "to":        new_state.value,
            "reason":    "; ".join(reasons),
        })

        logger.warning(
            "model_state_transition",
            model=record.model_name,
            old_state=old_state.value,
            new_state=new_state.value,
            weight_multiplier=record.weight_multiplier,
            reasons=reasons,
        )

        # Auto-generate retraining recommendation for DEGRADED / DISABLED
        if new_state in (ModelState.DEGRADED, ModelState.DISABLED):
            rec = RetrainingRecommendation(
                model_name=record.model_name,
                created_at=_now(),
                reasons=reasons,
                current_state=new_state,
                drift_metrics=drift_metrics or {},
                performance_metrics=performance_metrics or {},
            )
            record.retraining_recommendations.append(rec)

            logger.warning(
                "retraining_recommendation_created",
                model=record.model_name,
                state=new_state.value,
                reasons=reasons,
            )

        self._emit_alert(record, reasons, drift_metrics, performance_metrics)
        self._maybe_persist()
        return new_state

    def _emit_alert(
        self,
        record: ModelRecord,
        reasons: list[str],
        drift_metrics: dict[str, float] | None,
        performance_metrics: dict[str, float] | None,
    ) -> None:
        if self._alert_system is None:
            return

        from .alerts import AlertCategory, AlertSeverity

        sev_map = {
            ModelState.HEALTHY:  AlertSeverity.INFO,
            ModelState.WARNING:  AlertSeverity.WARNING,
            ModelState.DEGRADED: AlertSeverity.CRITICAL,
            ModelState.DISABLED: AlertSeverity.DISABLED,
        }
        severity = sev_map[record.state]

        meta: dict[str, Any] = {
            "state":            record.state.value,
            "weight_multiplier":record.weight_multiplier,
            "model_version":    record.model_version,
        }
        if drift_metrics:
            meta["drift"] = drift_metrics
        if performance_metrics:
            meta["performance"] = performance_metrics

        self._alert_system._emit(
            severity,
            AlertCategory.MODEL_STATE,
            record.model_name,
            f"Model '{record.model_name}' → {record.state.value.upper()}",
            "; ".join(reasons),
            meta,
        )

    # ------------------------------------------------------------------
    # Persistence (JSON)
    # ------------------------------------------------------------------

    def _maybe_persist(self) -> None:
        if self._persist_path is None:
            return
        try:
            self._save(self._persist_path)
        except Exception as exc:
            logger.warning("model_registry_persist_failed", error=str(exc))

    def _save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._global_lock:
            data = {
                name: asdict(rec)
                for name, rec in self._records.items()
            }
        with open(path, "w") as fh:
            json.dump(data, fh, indent=2)
        logger.debug("model_registry_saved", path=str(path))

    def _load(self, path: Path) -> None:
        try:
            with open(path) as fh:
                data = json.load(fh)
            for name, rec_dict in data.items():
                # Reconstruct enums
                rec_dict["state"] = ModelState(rec_dict["state"])
                recs = []
                for r in rec_dict.pop("retraining_recommendations", []):
                    r["current_state"] = ModelState(r["current_state"])
                    recs.append(RetrainingRecommendation(**r))
                record = ModelRecord(**rec_dict)
                record.retraining_recommendations = recs
                self._records[name] = record
                self._locks[name]   = threading.Lock()
            logger.info("model_registry_loaded", path=str(path), n=len(data))
        except Exception as exc:
            logger.warning("model_registry_load_failed", path=str(path), error=str(exc))


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_default_registry(
    alert_system: Any | None = None,
    persist_path: Path | None = None,
) -> ModelRegistry:
    """
    Create a ModelRegistry pre-populated with default records for all
    seven AlphaForge models.  Useful for bootstrapping a fresh deployment.
    """
    from ..meta.ensemble import MODEL_NAMES  # avoid circular import

    registry = ModelRegistry(
        alert_system=alert_system,
        persist_path=persist_path,
    )

    version_map = {
        "regime":          "regime-xgb-v1",
        "ranker":          "ranker-lgbm-v1",
        "strategy":        "strategy-catboost-v1",
        "risk":            "risk-xgb-v1",
        "price_forecaster":"price-forecaster-v1",
        "iv_classifier":   "iv-classifier-v1",
        "quant_engine":    "quant-engine-v1",
    }

    for name in MODEL_NAMES:
        registry.register(ModelRecord(
            model_name=name,
            model_version=version_map.get(name, f"{name}-v1"),
            dataset_version="ds-baseline-v1",
            feature_version="feat-v1",
            training_period="2022-01-01/2024-06-30",
            deployment_date=_now(),
            validation_metrics={},
        ))

    return registry
