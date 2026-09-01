"""
Monitoring Router — AlphaForge ML Monitoring Dashboard API.

Exposes model health data to the AlphaForge UI via a FastAPI APIRouter.

Endpoints
---------
GET  /monitoring/health
     Overall system health: state counts, active / disabled models.

GET  /monitoring/models
     Full registry dump: all model records with provenance + runtime state.

GET  /monitoring/models/{model_name}
     Single model detail: state, metrics, history, retraining recommendations.

GET  /monitoring/alerts
     Recent alert history with optional ?severity=&model=&limit= filtering.

GET  /monitoring/alerts/summary
     Aggregated alert counts by severity.

GET  /monitoring/drift
     Last feature drift report for every model.

GET  /monitoring/drift/{model_name}
     Last feature drift report for a specific model.

GET  /monitoring/performance
     Last performance snapshot for every model.

GET  /monitoring/performance/{model_name}
     Last performance snapshot + strategy decay metrics for a specific model.

GET  /monitoring/strategy-decay
     All strategy decay metrics across all models.

GET  /monitoring/retraining
     All unacknowledged retraining recommendations.

POST /monitoring/retraining/{model_name}/acknowledge
     Acknowledge all pending recommendations for a model.

POST /monitoring/models/{model_name}/recover
     Manually recover a model back to HEALTHY state.

POST /monitoring/models/{model_name}/disable
     Manually disable a model (operator override).

POST /monitoring/outcomes
     Record one or more resolved trade outcomes (for performance tracking).

POST /monitoring/drift/check/{model_name}
     Force an immediate drift check for a model (using buffered data).

GET  /monitoring/weights
     Current ensemble weight multipliers for all registered models.
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

logger = structlog.get_logger()

router = APIRouter(prefix="/monitoring", tags=["monitoring"])

# ---------------------------------------------------------------------------
# Lazy singletons — populated by init_monitoring() called from lifespan
# ---------------------------------------------------------------------------

_registry = None       # ModelRegistry
_alerts   = None       # AlertSystem
_feature  = None       # FeatureMonitor
_perf     = None       # PerformanceMonitor


def init_monitoring(
    registry,
    alert_system,
    feature_monitor,
    performance_monitor,
) -> None:
    """
    Wire up the global monitoring singletons.

    Call this once from the FastAPI lifespan, after models are loaded.
    """
    global _registry, _alerts, _feature, _perf
    _registry = registry
    _alerts   = alert_system
    _feature  = feature_monitor
    _perf     = performance_monitor
    logger.info("monitoring_router_initialised")


def _req_registry():
    if _registry is None:
        raise HTTPException(status_code=503, detail="Monitoring registry not initialised.")
    return _registry

def _req_alerts():
    if _alerts is None:
        raise HTTPException(status_code=503, detail="Alert system not initialised.")
    return _alerts

def _req_feature():
    if _feature is None:
        raise HTTPException(status_code=503, detail="Feature monitor not initialised.")
    return _feature

def _req_perf():
    if _perf is None:
        raise HTTPException(status_code=503, detail="Performance monitor not initialised.")
    return _perf


# ---------------------------------------------------------------------------
# System health
# ---------------------------------------------------------------------------

@router.get("/health")
async def monitoring_health() -> dict[str, Any]:
    """
    Overall monitoring system health.

    Returns state counts, list of active / disabled models, and alert summary.
    """
    registry = _req_registry()
    alerts   = _req_alerts()

    health = registry.health_summary()
    alert_summary = alerts.get_summary()

    return {
        "status":         _overall_status(health["stateCounts"]),
        "registry":       health,
        "alertSummary":   alert_summary,
        "monitoringReady": True,
    }


@router.get("/weights")
async def monitoring_weights() -> dict[str, Any]:
    """
    Current ensemble weight multipliers for all registered models.

    Returns {modelName: weightMultiplier} — the Meta Decision Engine should
    use these to scale base weights.  DISABLED models have weight 0.0.
    """
    registry = _req_registry()
    return {
        "weights":       registry.get_all_weights(),
        "activeModels":  registry.get_active_models(),
        "disabledModels":registry.get_disabled_models(),
    }


# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

@router.get("/models")
async def monitoring_models() -> dict[str, Any]:
    """Full model registry dump."""
    registry = _req_registry()
    return registry.health_summary()


@router.get("/models/{model_name}")
async def monitoring_model_detail(model_name: str) -> dict[str, Any]:
    """Single model detail with provenance, state history, and recommendations."""
    registry = _req_registry()
    record = registry.get(model_name)
    if record is None:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model_name}' is not registered.",
        )

    # Attach last performance snapshot and drift report
    perf_snap = _perf.get_snapshot(model_name) if _perf else None
    drift_rep = _feature.get_last_report(model_name) if _feature else None

    data = record.to_dict()
    data["performanceSnapshot"] = perf_snap.to_dict() if perf_snap else None
    data["featureDriftReport"]  = drift_rep.to_dict()  if drift_rep  else None
    return data


# ---------------------------------------------------------------------------
# Model state management (operator actions)
# ---------------------------------------------------------------------------

class RecoverRequest(BaseModel):
    notes: str = Field(default="", description="Operator notes for the recovery action.")


@router.post("/models/{model_name}/recover")
async def monitoring_recover_model(
    model_name: str,
    body: RecoverRequest = RecoverRequest(),
) -> dict[str, Any]:
    """
    Manually recover a model back to HEALTHY state.

    Should only be called after verifying the model is performing correctly
    (e.g. after a retraining run or manual review).
    """
    registry = _req_registry()
    if not registry.is_registered(model_name):
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model_name}' is not registered.",
        )
    new_state = registry.recover(model_name, notes=body.notes)
    logger.info("monitoring_model_recovered", model=model_name, notes=body.notes)
    return {"model": model_name, "newState": new_state.value, "notes": body.notes}


class DisableRequest(BaseModel):
    reasons: list[str] = Field(
        default=["Manual operator disable"],
        description="List of reasons for disabling the model.",
    )


@router.post("/models/{model_name}/disable")
async def monitoring_disable_model(
    model_name: str,
    body: DisableRequest = DisableRequest(),
) -> dict[str, Any]:
    """
    Manually disable a model (operator override).

    The model's weight drops to 0.0 and it is excluded from the ensemble
    until explicitly recovered.
    """
    registry = _req_registry()
    if not registry.is_registered(model_name):
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model_name}' is not registered.",
        )
    new_state = registry.set_disabled(model_name, reasons=body.reasons)
    logger.warning("monitoring_model_disabled", model=model_name, reasons=body.reasons)
    return {"model": model_name, "newState": new_state.value}


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

@router.get("/alerts")
async def monitoring_alerts(
    severity: str | None = Query(default=None, description="Filter by severity"),
    model:    str | None = Query(default=None, description="Filter by model name"),
    limit:    int        = Query(default=100,  ge=1, le=500),
) -> dict[str, Any]:
    """Recent alert history with optional filtering."""
    from .alerts import AlertSeverity

    alerts = _req_alerts()
    sev = None
    if severity:
        try:
            sev = AlertSeverity(severity.lower())
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid severity '{severity}'. "
                       f"Must be one of: {[s.value for s in AlertSeverity]}",
            )

    items = alerts.get_recent(limit=limit, severity=sev, model_name=model)
    return {
        "total": len(items),
        "alerts": [a.to_dict() for a in items],
    }


@router.get("/alerts/summary")
async def monitoring_alerts_summary() -> dict[str, Any]:
    """Aggregated alert counts by severity."""
    return _req_alerts().get_summary()


# ---------------------------------------------------------------------------
# Feature drift
# ---------------------------------------------------------------------------

@router.get("/drift")
async def monitoring_drift_all() -> dict[str, Any]:
    """Last feature drift report for every model."""
    feature = _req_feature()
    reports = feature.get_all_reports()
    return {
        "models": {
            name: report.to_dict() for name, report in reports.items()
        }
    }


@router.get("/drift/{model_name}")
async def monitoring_drift_model(model_name: str) -> dict[str, Any]:
    """Last feature drift report for a specific model."""
    feature = _req_feature()
    report = feature.get_last_report(model_name)
    if report is None:
        return {
            "modelName": model_name,
            "available": False,
            "message": "No drift report available yet for this model.",
        }
    return {**report.to_dict(), "available": True}


@router.post("/drift/check/{model_name}")
async def monitoring_force_drift_check(model_name: str) -> dict[str, Any]:
    """Force an immediate drift check for a model using buffered data."""
    feature = _req_feature()
    report = feature.force_check(model_name)
    if report is None:
        return {
            "modelName": model_name,
            "triggered": False,
            "message": "Insufficient buffered data for a drift check.",
        }
    return {**report.to_dict(), "triggered": True}


# ---------------------------------------------------------------------------
# Performance monitoring
# ---------------------------------------------------------------------------

@router.get("/performance")
async def monitoring_performance_all() -> dict[str, Any]:
    """Last performance snapshot for every model."""
    perf = _req_perf()
    snapshots = perf.get_all_snapshots()
    return {
        "models": {
            name: snap.to_dict() for name, snap in snapshots.items()
        }
    }


@router.get("/performance/{model_name}")
async def monitoring_performance_model(model_name: str) -> dict[str, Any]:
    """Last performance snapshot + all strategy decay metrics for a model."""
    perf = _req_perf()
    snap = perf.get_snapshot(model_name)

    all_decay = perf.get_all_strategy_decay()
    model_decay = [d.to_dict() for d in all_decay if d.model_name == model_name]

    return {
        "modelName":      model_name,
        "snapshot":       snap.to_dict() if snap else None,
        "strategyDecay":  model_decay,
        "available":      snap is not None,
    }


# ---------------------------------------------------------------------------
# Strategy decay
# ---------------------------------------------------------------------------

@router.get("/strategy-decay")
async def monitoring_strategy_decay() -> dict[str, Any]:
    """All strategy decay metrics across all models."""
    perf = _req_perf()
    all_decay = perf.get_all_strategy_decay()
    decaying = [d for d in all_decay if d.is_decaying]
    return {
        "total":    len(all_decay),
        "decaying": len(decaying),
        "metrics":  [d.to_dict() for d in all_decay],
    }


# ---------------------------------------------------------------------------
# Retraining recommendations
# ---------------------------------------------------------------------------

@router.get("/retraining")
async def monitoring_retraining(
    unacknowledged_only: bool = Query(default=True),
) -> dict[str, Any]:
    """All pending retraining recommendations."""
    registry = _req_registry()
    recommendations = registry.get_retraining_recommendations(
        unacknowledged_only=unacknowledged_only
    )
    return {
        "total": len(recommendations),
        "recommendations": [r.to_dict() for r in recommendations],
    }


@router.post("/retraining/{model_name}/acknowledge")
async def monitoring_acknowledge_retraining(
    model_name: str,
    acknowledged_by: str = Query(default="operator"),
) -> dict[str, Any]:
    """Acknowledge all pending retraining recommendations for a model."""
    registry = _req_registry()
    if not registry.is_registered(model_name):
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model_name}' is not registered.",
        )
    count = registry.acknowledge_recommendation(model_name, acknowledged_by=acknowledged_by)
    return {
        "model":            model_name,
        "acknowledged":     count,
        "acknowledgedBy":   acknowledged_by,
    }


# ---------------------------------------------------------------------------
# Trade outcome ingestion
# ---------------------------------------------------------------------------

class TradeOutcomeRequest(BaseModel):
    """Request body for recording one resolved trade outcome."""

    model_name:     str
    strategy:       str
    symbol:         str
    predicted_prob: float = Field(ge=0.0, le=1.0)
    actual_outcome: float = Field(ge=0.0, le=1.0, description="1.0=profit, 0.0=loss")
    pnl_pct:        float = Field(description="P&L as fraction e.g. 0.012 = +1.2%")
    confidence:     float = Field(default=0.5, ge=0.0, le=1.0)
    action:         str   = Field(default="BUY")


class TradeOutcomeBatchRequest(BaseModel):
    outcomes: list[TradeOutcomeRequest]


@router.post("/outcomes")
async def monitoring_record_outcomes(
    body: TradeOutcomeBatchRequest,
) -> dict[str, Any]:
    """
    Record one or more resolved trade outcomes for performance tracking.

    ``predicted_prob`` should be the calibrated probability the model
    assigned at decision time.  ``actual_outcome`` is 1.0 if the trade
    was profitable, 0.0 otherwise.  ``pnl_pct`` is the realised P&L as
    a fraction of capital (e.g. 0.012 for +1.2%).
    """
    from .performance_monitor import TradeOutcome

    perf = _req_perf()
    results: list[dict] = []

    for req in body.outcomes:
        outcome = TradeOutcome(
            model_name=req.model_name,
            strategy=req.strategy,
            symbol=req.symbol,
            predicted_prob=req.predicted_prob,
            actual_outcome=req.actual_outcome,
            pnl_pct=req.pnl_pct,
            confidence=req.confidence,
            action=req.action,
        )
        snap = perf.record_outcome(outcome)
        results.append({
            "model":    req.model_name,
            "strategy": req.strategy,
            "snapshotUpdated": snap is not None,
        })

    logger.info("monitoring_outcomes_recorded", count=len(body.outcomes))
    return {"recorded": len(body.outcomes), "results": results}


# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

def _overall_status(state_counts: dict[str, int]) -> str:
    """Derive an overall system status string from model state counts."""
    if state_counts.get("disabled", 0) > 0:
        return "degraded"
    if state_counts.get("degraded", 0) > 0:
        return "degraded"
    if state_counts.get("warning", 0) > 0:
        return "warning"
    return "healthy"
