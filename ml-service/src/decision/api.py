"""
Phase 3M — Minimal FastAPI router for the decision / shadow / monitoring surface
(spec §26).

Design constraints
------------------
* This module is a *thin adapter*. It does NOT redesign or replace `server.py`;
  it only exposes an `APIRouter` that an operator can mount if desired
  (`app.include_router(decision_router)`).
* Import hygiene: FastAPI/pydantic and every heavy dependency are imported
  LAZILY inside `get_router()` / handlers so that merely importing
  `src.decision` (and running the test-suite) never requires FastAPI, talib,
  torch, or sklearn to be installed.
* Every endpoint is deployment-mode aware and distinguishes
  research / shadow / paper. LIVE is DISABLED — any request that names a live /
  production mode is rejected with HTTP 403 via `assert_not_live`; there is no
  code path that reaches a broker.
* The mutating surface is intentionally narrow: `/decision/evaluate` runs the
  in-process orchestrator against caller-supplied, pre-computed predictor
  outputs (fail-closed) and `/shadow/execute` runs the reused Phase 3G
  simulator. Neither can place a real order. Everything else is read-only over
  the append-only JSONL stores.

The router persists nothing new: it reads/writes only through the existing
append-only stores (`EventLog`, `ShadowLedger`, `ReconciliationEngine`) rooted
at a configurable artifacts directory.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

# Default artifacts root for the append-only JSONL stores. Overridable via env
# so the router never hard-codes a machine-specific path.
_DEFAULT_ROOT = os.environ.get(
    "ALPHAFORGE_DECISION_ROOT",
    str(Path(__file__).resolve().parents[2] / "artifacts" / "decision"),
)

# Modes this surface will service. LIVE / PRODUCTION are deliberately absent.
_SERVICEABLE_MODES = ("research", "shadow", "paper")


def _root() -> Path:
    p = Path(_DEFAULT_ROOT)
    p.mkdir(parents=True, exist_ok=True)
    return p


# ── request models ────────────────────────────────────────────────────────
# Defined lazily at module import time ONLY if pydantic is available, and kept at
# MODULE level (not inside get_router) so FastAPI can resolve the string
# annotations produced by `from __future__ import annotations`. Importing this
# module without pydantic installed is still tolerated (the builders are None
# and get_router() raises a clear error).
try:  # pragma: no cover - exercised whenever pydantic is present
    from pydantic import BaseModel as _BaseModel, Field as _Field

    class DimensionIn(_BaseModel):
        dimension: str
        state: str
        reasons: list = _Field(default_factory=list)
        metrics: dict = _Field(default_factory=dict)

    class SystemHealthIn(_BaseModel):
        dimensions: list = _Field(default_factory=list)

    class EvaluateIn(_BaseModel):
        deployment_mode: str = _Field(..., description="research | shadow | paper")
        decision_id: Optional[str] = None
        trace_id: Optional[str] = None
        inputs: dict = _Field(default_factory=dict)

    class ShadowExecuteIn(_BaseModel):
        deployment_mode: str = _Field(..., description="research | shadow | paper")
        decision: dict = _Field(...)
        market_bars: list = _Field(default_factory=list)
        lot_size: int = 1
        instrument_type: str = "EQUITY"
        stop_price: Optional[float] = None
        target_price: Optional[float] = None

    _PYDANTIC_OK = True
except Exception:  # pydantic not installed — import stays clean
    DimensionIn = SystemHealthIn = EvaluateIn = ShadowExecuteIn = None  # type: ignore
    _PYDANTIC_OK = False


def _guard_mode(mode: str) -> str:
    """
    Normalize + fail-closed on any live/production token. Returns the lowercased
    serviceable mode string or raises HTTP 403. Kept as a plain helper so it can
    be unit-tested without FastAPI.
    """
    from fastapi import HTTPException
    from .provenance import assert_not_live, LiveExecutionForbidden

    m = (mode or "").strip().lower()
    try:
        assert_not_live(m)                       # raises on live/production tokens
    except LiveExecutionForbidden as exc:
        raise HTTPException(status_code=403, detail=f"LIVE execution is forbidden: {exc}")
    if m not in _SERVICEABLE_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"unsupported mode {mode!r}; allowed: {list(_SERVICEABLE_MODES)}",
        )
    return m


def get_router(root: Optional[str] = None):
    """
    Build and return the decision APIRouter. Imported lazily so `import
    src.decision` stays FastAPI-free.

    Endpoints (spec §26):
      GET  /decision/health/ml
      GET  /decision/health/data
      GET  /decision/health/models
      POST /decision/health/system         (roll up caller-supplied dimensions)
      POST /decision/decision/evaluate     (run orchestrator; fail-closed)
      GET  /decision/decision/{decision_id}
      POST /decision/shadow/execute        (reuse Phase 3G simulator; never broker)
      GET  /decision/shadow/orders
      GET  /decision/shadow/positions
      GET  /decision/shadow/performance
      GET  /decision/reconciliation/{decision_id}
      GET  /decision/monitoring/events
      GET  /decision/monitoring/report
      GET  /decision/modes
    """
    from fastapi import APIRouter, HTTPException, Query

    if not _PYDANTIC_OK:
        raise RuntimeError("pydantic is required to build the decision router")

    store_root = Path(root) if root else _root()
    router = APIRouter(prefix="/decision", tags=["decision"])

    # ── lazy store handles ────────────────────────────────────────────────
    def _event_log():
        from .events import EventLog
        return EventLog(store_root)

    def _ledger():
        from src.shadow import ShadowLedger
        return ShadowLedger(store_root)

    def _reconciliation():
        from src.shadow import ReconciliationEngine
        return ReconciliationEngine(store_root)

    # ── modes / capability discovery ──────────────────────────────────────
    @router.get("/modes")
    def modes():
        return {
            "serviceable_modes": list(_SERVICEABLE_MODES),
            "live_enabled": False,
            "auto_retrain_enabled": False,
            "auto_recalibrate_enabled": False,
            "auto_promote_enabled": False,
            "broker_execution_enabled": False,
        }

    # ── health (read-only projections of a caller-supplied snapshot) ───────
    # `body.dimensions` is a list of plain dicts: {dimension, state, reasons?, metrics?}
    def _dim(dimension: str, request_dims: list):
        from .monitoring import DimensionHealth, HealthState
        picked = [d for d in request_dims
                  if str(d.get("dimension", "")).upper() == dimension.upper()]
        if not picked:
            return DimensionHealth(
                dimension=dimension, state=HealthState.INSUFFICIENT_EVIDENCE,
                reasons=["no snapshot supplied"], metrics={},
            ).to_dict()
        d = picked[0]
        try:
            state = HealthState(d.get("state"))
        except ValueError:
            state = HealthState.INSUFFICIENT_EVIDENCE
        return DimensionHealth(dimension=d.get("dimension"), state=state,
                               reasons=list(d.get("reasons") or []),
                               metrics=dict(d.get("metrics") or {})).to_dict()

    @router.post("/health/system")
    def health_system(body: SystemHealthIn):
        from .monitoring import DimensionHealth, HealthState, HealthOrchestrator
        dims = []
        for d in body.dimensions:
            try:
                state = HealthState(d.get("state"))
            except ValueError:
                state = HealthState.INSUFFICIENT_EVIDENCE
            dims.append(DimensionHealth(dimension=d.get("dimension"), state=state,
                                        reasons=list(d.get("reasons") or []),
                                        metrics=dict(d.get("metrics") or {})))
        return HealthOrchestrator().assess(dims).to_dict()

    @router.post("/health/ml")
    def health_ml(body: SystemHealthIn):
        return {
            "model": _dim("MODEL", body.dimensions),
            "calibration": _dim("CALIBRATION", body.dimensions),
            "alpha": _dim("ALPHA", body.dimensions),
            "rl": _dim("RL", body.dimensions),
        }

    @router.post("/health/data")
    def health_data(body: SystemHealthIn):
        return {
            "data": _dim("DATA", body.dimensions),
            "feature": _dim("FEATURE", body.dimensions),
        }

    @router.post("/health/models")
    def health_models(body: SystemHealthIn):
        return {"model": _dim("MODEL", body.dimensions)}

    # ── decision evaluate (fail-closed orchestrator) ──────────────────────
    @router.post("/decision/evaluate")
    def decision_evaluate(body: EvaluateIn):
        mode = _guard_mode(body.deployment_mode)
        from .pipeline import DecisionPipeline, PipelineInputs
        from .provenance import LiveExecutionForbidden
        from .schema import new_decision_id
        from dataclasses import fields as _fields

        payload = dict(body.inputs)
        payload["deployment_mode"] = mode  # trust the guarded mode over the body

        allowed = {f.name for f in _fields(PipelineInputs)}
        unknown = set(payload) - allowed
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"unknown PipelineInputs fields: {sorted(unknown)}",
            )
        try:
            inputs = PipelineInputs(**{k: v for k, v in payload.items() if k in allowed})
        except TypeError as exc:
            raise HTTPException(status_code=422, detail=f"invalid inputs: {exc}")

        pipeline = DecisionPipeline(event_log=_event_log())
        decision_id = body.decision_id or new_decision_id()
        try:
            out = pipeline.evaluate(inputs, decision_id=decision_id, trace_id=body.trace_id)
        except LiveExecutionForbidden as exc:
            raise HTTPException(status_code=403, detail=f"LIVE execution is forbidden: {exc}")
        return out.to_dict()

    @router.get("/decision/{decision_id}")
    def decision_get(decision_id: str):
        events = _event_log().for_decision(decision_id)
        if not events:
            raise HTTPException(status_code=404, detail=f"no decision {decision_id!r}")
        return {"decision_id": decision_id, "events": events}

    # ── shadow execution (reuses Phase 3G simulator; NEVER a broker) ───────
    @router.post("/shadow/execute")
    def shadow_execute(body: ShadowExecuteIn):
        mode = _guard_mode(body.deployment_mode)
        from src.shadow import ShadowExecutionEngine
        from .schema import CanonicalDecision
        from .provenance import LiveExecutionForbidden

        try:
            decision = CanonicalDecision.from_dict(body.decision)
        except Exception as exc:  # malformed decision → fail-closed 422
            raise HTTPException(status_code=422, detail=f"invalid decision: {exc}")

        engine = ShadowExecutionEngine(_ledger())
        try:
            result = engine.execute(
                decision=decision,
                market_bars=body.market_bars,
                mode=mode,
                lot_size=body.lot_size,
                instrument_type=body.instrument_type,
                stop_price=body.stop_price,
                target_price=body.target_price,
            )
        except LiveExecutionForbidden as exc:
            raise HTTPException(status_code=403, detail=f"LIVE execution is forbidden: {exc}")

        def _ser(v):
            return v.to_dict() if hasattr(v, "to_dict") else v
        return {
            "executed": result.get("executed"),
            "reason": result.get("reason"),
            "order": _ser(result.get("order")),
            "fill": _ser(result.get("fill")),
        }

    @router.get("/shadow/orders")
    def shadow_orders(decision_id: Optional[str] = Query(default=None)):
        ledger = _ledger()
        orders = ledger.orders()
        if decision_id:
            orders = [o for o in orders if o.get("decision_id") == decision_id]
        return {"count": len(orders), "orders": orders}

    @router.get("/shadow/positions")
    def shadow_positions():
        """Net hypothetical position per instrument from the append-only fills."""
        fills = _ledger().fills()
        positions: dict[str, float] = {}
        for f in fills:
            side = (f.get("side") or "").upper()
            qty = f.get("quantity_filled") or 0
            sign = 1.0 if side in ("BUY", "LONG") else -1.0 if side in ("SELL", "SHORT") else 0.0
            positions[f.get("instrument", "")] = positions.get(f.get("instrument", ""), 0.0) + sign * qty
        return {"positions": positions}

    @router.get("/shadow/performance")
    def shadow_performance():
        """Aggregate hypothetical P&L from the append-only fills (never fabricated)."""
        fills = _ledger().fills()
        pnls = [f.get("realized_pnl") for f in fills if f.get("realized_pnl") is not None]
        costs = [f.get("total_cost") for f in fills if f.get("total_cost") is not None]
        n = len(pnls)
        wins = len([p for p in pnls if p > 0])
        return {
            "fills": len(fills),
            "reconciled_fills": len([f for f in fills if f.get("pnl_reconciled")]),
            "net_pnl": sum(pnls) if pnls else None,
            "total_cost": sum(costs) if costs else None,
            "win_rate": (wins / n) if n else None,
        }

    # ── reconciliation ────────────────────────────────────────────────────
    @router.get("/reconciliation/{decision_id}")
    def reconciliation_get(decision_id: str):
        recs = _reconciliation().for_decision(decision_id)
        if not recs:
            raise HTTPException(status_code=404, detail=f"no reconciliation for {decision_id!r}")
        return {"decision_id": decision_id, "records": recs}

    # ── monitoring ────────────────────────────────────────────────────────
    @router.get("/monitoring/events")
    def monitoring_events(limit: int = Query(default=200, ge=1, le=5000)):
        events = _event_log().all()
        return {"count": len(events), "events": events[-limit:]}

    @router.get("/monitoring/report")
    def monitoring_report():
        ledger = _ledger()
        return {
            "live_enabled": False,
            "events": len(_event_log().all()),
            "shadow_orders": len(ledger.orders()),
            "shadow_fills": len(ledger.fills()),
            "reconciliations": len(_reconciliation().all()),
        }

    return router


# Convenience module-level accessor. Kept lazy: only builds when explicitly
# called so importing this module does not require FastAPI.
def decision_router(root: Optional[str] = None):
    return get_router(root=root)
