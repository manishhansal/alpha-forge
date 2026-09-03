"""
DataQualityGate HTTP API — Phase 53 / V2.1 certification.

Exposes the DataQualityGate as a REST endpoint so the Next.js signal engine
can check gate status before generating any signal.

The signal engine MUST call this endpoint (or the equivalent SDK function)
before generating a tradeable signal. signalEngineAllowed=false MUST block
signal generation with no exceptions.

Endpoints
---------
POST /data/gate          — evaluate gate for a given quote/instrument
GET  /data/gate/:symbol  — current gate state for a symbol (using cached quote age)
GET  /data/lineage/:observationId — retrieve a lineage record
GET  /data/lineage/instrument/:instrumentId — recent lineage for an instrument
GET  /data/health/strategy/:strategyId — strategy-specific data health check
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Optional

import structlog
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.core.data_quality import build_quality_gate, check_strategy_data_requirements
from src.core.lineage import lineage_store
from src.core.circuit_breaker import all_breakers
from src.core.schemas_v2 import StrategyDataRequirements

logger = structlog.get_logger(__name__)

gate_router = APIRouter(prefix="/data", tags=["gate", "lineage"])


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class GateRequest(BaseModel):
    """Inputs needed to evaluate a DataQualityGate."""
    symbol: str
    quoteAgeMs: int
    completenessPercent: float = 1.0      # 0.0–1.0
    timestampValid: bool = True
    crossSourceAgreement: float = 1.0     # 0.0–1.0
    sequenceIntegrity: bool = True
    strategyId: Optional[str] = None
    # Optional strategy-specific overrides
    maxQuoteAgeMs: Optional[int] = None
    minConfidenceScore: Optional[int] = None
    requiresOI: bool = False
    requiresOptionChain: bool = False
    requiresConfirmedCandle: bool = False
    oiAvailable: bool = True
    optionChainAvailable: bool = True
    candleConfirmed: bool = True


# ---------------------------------------------------------------------------
# POST /data/gate
# ---------------------------------------------------------------------------


@gate_router.post("/gate", response_class=JSONResponse)
async def evaluate_gate(req: GateRequest) -> JSONResponse:
    """Evaluate the DataQualityGate for a given instrument + quote age.

    The signal engine MUST check signalEngineAllowed before proceeding.
    If signalEngineAllowed is false, no signal may be generated.

    This endpoint is the authoritative gate for all AlphaForge strategies.
    It evaluates:
      - quote freshness (with per-tier thresholds)
      - completeness
      - provider health (live circuit breaker state)
      - timestamp validity
      - cross-source agreement
      - sequence integrity
      - strategy-specific requirements
    """
    # Determine provider health from circuit breaker state
    breakers = all_breakers()
    provider_healthy = all(
        not b.is_open() for b in breakers.values()
    ) if breakers else True

    # Build strategy requirements if strategyId provided
    strategy_req: Optional[StrategyDataRequirements] = None
    if req.strategyId and (req.maxQuoteAgeMs or req.minConfidenceScore):
        strategy_req = StrategyDataRequirements(
            strategyId=req.strategyId,
            strategyName=req.strategyId,
            requiredDataTypes=["PRICE"],
            maxQuoteAgeMs=req.maxQuoteAgeMs or 10_000,
            minConfidenceScore=req.minConfidenceScore or 60,
            requiresOI=req.requiresOI,
            requiresOptionChain=req.requiresOptionChain,
            requiresConfirmedCandle=req.requiresConfirmedCandle,
        )

    gate = build_quality_gate(
        quote_age_ms=req.quoteAgeMs,
        symbol=req.symbol,
        completeness_pct=req.completenessPercent,
        provider_healthy=provider_healthy,
        timestamp_valid=req.timestampValid,
        cross_source_agreement=req.crossSourceAgreement,
        sequence_integrity=req.sequenceIntegrity,
        strategy_requirements=strategy_req,
    )

    # Strategy-specific data requirements check
    strategy_reasons: list[str] = []
    if strategy_req:
        _, strategy_reasons = check_strategy_data_requirements(
            strategy_req,
            quote_age_ms=req.quoteAgeMs,
            option_chain_available=req.optionChainAvailable,
            oi_available=req.oiAvailable,
            candle_confirmed=req.candleConfirmed,
            confidence_score=gate.confidenceScore,
        )

    all_block_reasons = []
    if gate.blockReason:
        all_block_reasons.append(gate.blockReason)
    all_block_reasons.extend(strategy_reasons)

    logger.info(
        "data_gate_evaluated",
        symbol=req.symbol,
        allowed=gate.signalEngineAllowed,
        confidence=gate.confidenceScore,
        quote_age_ms=req.quoteAgeMs,
        block_reasons=all_block_reasons,
    )

    return JSONResponse(
        status_code=200,
        content={
            "signalEngineAllowed": gate.signalEngineAllowed and len(strategy_reasons) == 0,
            "confidenceScore": gate.confidenceScore,
            "quality": gate.quality.value,
            "quoteAgeMs": gate.quoteAgeMs,
            "gates": {
                "dataFresh": gate.dataFresh,
                "dataComplete": gate.dataComplete,
                "dataTimestampValid": gate.dataTimestampValid,
                "dataProviderHealthy": gate.dataProviderHealthy,
                "dataSemanticallyValid": gate.dataSemanticallyValid,
            },
            "blockReasons": all_block_reasons if all_block_reasons else None,
            "circuitBreakers": {
                name: b.state.value for name, b in breakers.items()
            },
            "evaluatedAt": _utc_now_iso(),
        },
    )


# ---------------------------------------------------------------------------
# GET /data/gate/:symbol
# ---------------------------------------------------------------------------


@gate_router.get("/gate/{symbol}", response_class=JSONResponse)
async def get_symbol_gate(
    symbol: str,
    quote_age_ms: int = Query(default=5000, description="Age of the most recent quote in ms"),
    strategy_id: Optional[str] = Query(default=None),
) -> JSONResponse:
    """Quick GET-based gate evaluation for a symbol.

    Useful for monitoring dashboards. Uses provided quote_age_ms (the caller
    is responsible for tracking the actual quote freshness).
    """
    breakers = all_breakers()
    provider_healthy = all(not b.is_open() for b in breakers.values()) if breakers else True

    gate = build_quality_gate(
        quote_age_ms=quote_age_ms,
        symbol=symbol,
        provider_healthy=provider_healthy,
    )

    # Get recent lineage for this symbol
    recent_lineage = lineage_store.get_by_instrument(symbol.upper(), limit=3)

    return JSONResponse(
        status_code=200,
        content={
            "symbol": symbol.upper(),
            "signalEngineAllowed": gate.signalEngineAllowed,
            "confidenceScore": gate.confidenceScore,
            "quality": gate.quality.value,
            "quoteAgeMs": quote_age_ms,
            "blockReason": gate.blockReason,
            "recentObservations": [
                {
                    "observationId": r.observation_id,
                    "dataType": r.data_type,
                    "source": r.source.value,
                    "receivedAtMs": r.received_at_ms,
                    "isFallback": r.is_fallback,
                }
                for r in recent_lineage
            ],
            "evaluatedAt": _utc_now_iso(),
        },
    )


@gate_router.get("/lineage/summary", response_class=JSONResponse)
async def get_lineage_summary() -> JSONResponse:
    """Return lineage store statistics."""
    return JSONResponse(
        status_code=200,
        content={
            "storeSize": lineage_store.current_size,
            "totalRecorded": lineage_store.total_recorded,
            "maxSize": lineage_store._max_size,
            "utilizationPercent": round(
                lineage_store.current_size / lineage_store._max_size * 100, 2
            ),
            "retrievedAt": _utc_now_iso(),
        },
    )


# ---------------------------------------------------------------------------
# GET /data/lineage/:observationId
# ---------------------------------------------------------------------------


@gate_router.get("/lineage/{observation_id}", response_class=JSONResponse)
async def get_lineage(observation_id: str) -> JSONResponse:
    """Retrieve a single lineage record by its observationId.

    This is the foundation of trade forensics — every observation ID that
    appears in a signal or paper trade can be looked up here to reconstruct
    the exact market data that drove the decision.
    """
    record = lineage_store.get(observation_id)
    if record is None:
        return JSONResponse(
            status_code=404,
            content={
                "error": "observation_not_found",
                "observationId": observation_id,
                "message": (
                    "Observation ID not found in lineage store. "
                    "The in-memory store holds the most recent 50,000 records. "
                    "Older records require persistent storage."
                ),
            },
        )
    return JSONResponse(status_code=200, content=record.as_dict())


# ---------------------------------------------------------------------------
# GET /data/lineage/instrument/:instrumentId
# ---------------------------------------------------------------------------


@gate_router.get("/lineage/instrument/{instrument_id}", response_class=JSONResponse)
async def get_instrument_lineage(
    instrument_id: str,
    limit: int = Query(default=10, ge=1, le=100),
) -> JSONResponse:
    """Return recent lineage records for an instrument.

    Used by the forensics endpoint to show what data drove recent observations
    for a given instrument.
    """
    records = lineage_store.get_by_instrument(instrument_id, limit=limit)
    return JSONResponse(
        status_code=200,
        content={
            "instrumentId": instrument_id,
            "records": [r.as_dict() for r in records],
            "count": len(records),
            "storeSize": lineage_store.current_size,
            "totalRecorded": lineage_store.total_recorded,
            "retrievedAt": _utc_now_iso(),
        },
    )


# ---------------------------------------------------------------------------
# GET /data/health/strategy/:strategyId — strategy data health
# ---------------------------------------------------------------------------


@gate_router.get("/health/strategy/{strategy_id}", response_class=JSONResponse)
async def get_strategy_data_health(
    strategy_id: str,
    quote_age_ms: int = Query(default=5000),
    requires_oi: bool = Query(default=False),
    requires_option_chain: bool = Query(default=False),
    requires_confirmed_candle: bool = Query(default=False),
    oi_available: bool = Query(default=True),
    option_chain_available: bool = Query(default=True),
    candle_confirmed: bool = Query(default=True),
) -> JSONResponse:
    """Evaluate data health for a specific strategy's requirements.

    Returns whether the strategy can safely generate a signal given the
    current data conditions. This is the strategy-specific gate check.
    """
    # Default strategy requirements per strategyId
    _STRATEGY_DEFAULTS: dict[str, dict[str, Any]] = {
        "oi_scalper": {"requiresOI": True, "maxQuoteAgeMs": 5_000, "minConfidenceScore": 75},
        "momentum": {"requiresOI": False, "maxQuoteAgeMs": 15_000, "minConfidenceScore": 60},
        "breakout": {"requiresConfirmedCandle": True, "maxQuoteAgeMs": 10_000, "minConfidenceScore": 70},
        "option_straddle": {"requiresOptionChain": True, "requiresOI": True, "maxQuoteAgeMs": 30_000, "minConfidenceScore": 70},
    }

    defaults = _STRATEGY_DEFAULTS.get(strategy_id, {})

    req = StrategyDataRequirements(
        strategyId=strategy_id,
        strategyName=strategy_id,
        requiredDataTypes=["PRICE"],
        maxQuoteAgeMs=defaults.get("maxQuoteAgeMs", 10_000),
        minConfidenceScore=defaults.get("minConfidenceScore", 60),
        requiresOI=requires_oi or defaults.get("requiresOI", False),
        requiresOptionChain=requires_option_chain or defaults.get("requiresOptionChain", False),
        requiresConfirmedCandle=requires_confirmed_candle or defaults.get("requiresConfirmedCandle", False),
    )

    breakers = all_breakers()
    provider_healthy = all(not b.is_open() for b in breakers.values()) if breakers else True

    gate = build_quality_gate(
        quote_age_ms=quote_age_ms,
        provider_healthy=provider_healthy,
    )

    ok, reasons = check_strategy_data_requirements(
        req,
        quote_age_ms=quote_age_ms,
        option_chain_available=option_chain_available,
        oi_available=oi_available,
        candle_confirmed=candle_confirmed,
        confidence_score=gate.confidenceScore,
    )

    return JSONResponse(
        status_code=200,
        content={
            "strategyId": strategy_id,
            "signalAllowed": ok and gate.signalEngineAllowed,
            "dataGateAllowed": gate.signalEngineAllowed,
            "strategyRequirementsMet": ok,
            "confidenceScore": gate.confidenceScore,
            "quality": gate.quality.value,
            "blockReasons": reasons if reasons else None,
            "requirements": {
                "maxQuoteAgeMs": req.maxQuoteAgeMs,
                "minConfidenceScore": req.minConfidenceScore,
                "requiresOI": req.requiresOI,
                "requiresOptionChain": req.requiresOptionChain,
                "requiresConfirmedCandle": req.requiresConfirmedCandle,
            },
            "evaluatedAt": _utc_now_iso(),
        },
    )
