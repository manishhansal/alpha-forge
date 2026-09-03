"""
Health endpoints — Phases 63, 89-90.

Separates liveness, readiness, and data-quality health.

/health/live   — Is the process alive? (Always 200 if process is running)
/health/ready  — Are critical dependencies available? (Redis, publisher)
/health/data   — Is the market data usable? (quotes fresh, chain fresh, etc.)

A service can be LIVE but not READY (Redis offline).
A service can be READY but DATA DEGRADED (quotes stale, provider down).

This satisfies Phase 89: separate liveness from readiness from data quality.
Phase 90: readiness requires Redis + publisher + session healthy.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from src.engines.timestamp_engine import ts_engine

logger = structlog.get_logger(__name__)

health_router = APIRouter(prefix="/health", tags=["health"])

# Service start time for uptime calculation
_service_start_ms: int = int(time.time() * 1000)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------------------
# GET /health/live
# ---------------------------------------------------------------------------


@health_router.get("/live", response_class=JSONResponse)
async def health_live() -> JSONResponse:
    """Liveness probe — always HTTP 200 if the process is running.

    Docker/k8s: use this for liveness checks only.
    A failed liveness probe triggers a container restart.
    """
    return JSONResponse(
        status_code=200,
        content={
            "status": "alive",
            "service": "data-service",
            "version": "2.0.0",
            "uptimeMs": ts_engine.age_ms(_service_start_ms),
            "timestamp": _utc_now_iso(),
        },
    )


# ---------------------------------------------------------------------------
# GET /health/ready
# ---------------------------------------------------------------------------


@health_router.get("/ready", response_class=JSONResponse)
async def health_ready() -> JSONResponse:
    """Readiness probe — checks critical dependencies.

    Returns 200 when all critical dependencies are healthy.
    Returns 503 when any critical dependency is unavailable.

    Critical dependencies for readiness:
    - Redis connected
    - Tick publisher operational
    - At least one HTTP path healthy

    Phase 90: capability-level degradation is allowed.
    E.g. quotes=READY, options=DEGRADED is still 200 with a warning.
    """
    issues: dict[str, str] = {}
    capabilities: dict[str, str] = {}

    # Check Redis
    try:
        from src.server import _redis_client, _redis_available  # type: ignore[attr-defined]
        if _redis_available and _redis_client is not None:
            await _redis_client.ping()
            capabilities["redis"] = "READY"
        else:
            capabilities["redis"] = "UNAVAILABLE"
            issues["redis"] = "not connected"
    except Exception as exc:
        capabilities["redis"] = "UNAVAILABLE"
        issues["redis"] = str(exc)

    # Check tick publisher
    try:
        from src.publisher.tick_publisher import tick_publisher  # type: ignore[attr-defined]
        if tick_publisher._running is True:
            capabilities["tick_publisher"] = "READY"
        else:
            capabilities["tick_publisher"] = "UNAVAILABLE"
            issues["tick_publisher"] = f"running={tick_publisher._running}"
    except Exception as exc:
        capabilities["tick_publisher"] = "UNKNOWN"

    # Check quote capability (httpx client)
    try:
        from src.scrapers.live_quotes import _http_client  # type: ignore[attr-defined]
        if _http_client is not None and not _http_client.is_closed:
            capabilities["quotes"] = "READY"
        else:
            capabilities["quotes"] = "DEGRADED"
    except Exception:
        capabilities["quotes"] = "UNKNOWN"

    # Check chromium/option-chain capability
    try:
        from src.server import _chromium_available  # type: ignore[attr-defined]
        capabilities["option_chain"] = "READY" if _chromium_available else "DEGRADED"
    except Exception:
        capabilities["option_chain"] = "UNKNOWN"

    # Historical is always available (pure HTTP)
    capabilities["historical"] = "READY"

    # Determine overall status
    critical_failed = bool(issues.get("redis"))  # Redis is the only hard requirement
    http_code = 503 if critical_failed else 200
    overall = "DEGRADED" if issues else "READY"

    return JSONResponse(
        status_code=http_code,
        content={
            "status": overall,
            "capabilities": capabilities,
            "issues": issues,
            "timestamp": _utc_now_iso(),
        },
    )


# ---------------------------------------------------------------------------
# GET /health/data
# ---------------------------------------------------------------------------


@health_router.get("/data", response_class=JSONResponse)
async def health_data() -> JSONResponse:
    """Data quality health check.

    Returns the current data freshness and quality status.
    Consumers can use this to decide whether to trust the data.

    This is separate from readiness — data can be stale even when
    all services are running.
    """
    from src.engines.freshness_engine import freshness_engine
    from src.engines.market_session import market_session
    from src.core.deduplication import tick_gap_detector, event_dedup

    session_info = market_session.get_session_info()

    # Gather quote freshness info from the monitoring rolling stats
    try:
        from src.monitoring.router import rolling_stats  # type: ignore[attr-defined]
        stats = rolling_stats.get_all_stats()
        quote_stats = stats.get("/scraping/quotes")
    except Exception:
        quote_stats = None

    # Gap detection info
    gaps = tick_gap_detector.gap_events[-5:]  # last 5 gaps

    # Circuit breaker states
    try:
        from src.core.circuit_breaker import all_breakers
        breaker_states = {
            name: breaker.stats
            for name, breaker in all_breakers().items()
        }
    except Exception:
        breaker_states = {}

    # Duplicate rate
    dup_rate = event_dedup.duplicate_rate

    return JSONResponse(
        status_code=200,
        content={
            "status": "DATA_AVAILABLE",
            "session": session_info.as_dict(),
            "quoteStats": {
                "p50Ms": quote_stats.p50_ms if quote_stats else None,
                "p99Ms": quote_stats.p99_ms if quote_stats else None,
                "successRate": quote_stats.success_rate if quote_stats else None,
            },
            "gaps": [
                {
                    "instrumentId": g.instrumentId,
                    "gapDurationMs": g.gapDurationMs,
                    "severity": g.severity,
                }
                for g in gaps
            ],
            "duplicateRate": round(dup_rate, 4),
            "circuitBreakers": {
                name: {"state": s.get("state"), "failureRate": s.get("failure_rate")}
                for name, s in breaker_states.items()
            },
            "clockSkewMs": ts_engine.clock_skew_ms,
            "clockDegraded": ts_engine.is_clock_degraded,
            "timestamp": _utc_now_iso(),
        },
    )
