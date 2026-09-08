"""
Broker API router — exposes the authorized Upstox broker client as a fallback
data source alongside the NSE/BSE scrapers.

These endpoints are the data-service's *own* Upstox integration. They are used
both directly (for testing / verification) and internally by the historical
fallback chain. Every response is classified with typed provider errors so a
403/503/429 from Upstox surfaces as a clear, non-crashing HTTP response rather
than an unhandled 500.

Endpoints:
  GET /brokers/upstox/status                 — is Upstox configured?
  GET /brokers/upstox/quotes?symbols=A,B     — live quotes via Upstox
  GET /brokers/upstox/historical?symbol=...  — historical candles via Upstox
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from src.brokers import upstox_client
from src.core.circuit_breaker import get_breaker
from src.core.provider_http import (
    ProviderAuthenticationError,
    ProviderAuthorizationError,
    ProviderError,
    ProviderRateLimitError,
    ProviderUnavailableError,
)

logger = structlog.get_logger(__name__)

brokers_router = APIRouter(prefix="/brokers", tags=["brokers"])


def _error_status_for(exc: ProviderError) -> int:
    """Map a typed provider error to the HTTP status we surface to callers.

    We surface the upstream status when it's a clean provider signal so
    downstream consumers (and the TypeScript failover layer) can classify
    identically. Non-classified provider errors become 502 (bad gateway).
    """
    if isinstance(exc, ProviderAuthenticationError):
        return 401
    if isinstance(exc, ProviderAuthorizationError):
        return 403
    if isinstance(exc, ProviderRateLimitError):
        return 429
    if isinstance(exc, ProviderUnavailableError):
        return 503
    return 502


@brokers_router.get("/upstox/status", response_class=JSONResponse)
async def upstox_status() -> JSONResponse:
    """Report whether Upstox is configured and its circuit-breaker state."""
    configured = upstox_client._is_configured()
    quotes_breaker = get_breaker("upstox_quotes")
    hist_breaker = get_breaker("upstox_historical")
    return JSONResponse(
        status_code=200,
        content={
            "provider": "upstox",
            "configured": configured,
            "circuitBreakers": {
                "quotes": quotes_breaker.state.value,
                "historical": hist_breaker.state.value,
            },
        },
    )


@brokers_router.get("/upstox/quotes", response_class=JSONResponse)
async def upstox_quotes(
    symbols: str = Query(..., description="Comma-separated symbols, e.g. NIFTY,RELIANCE"),
    exchange: str = Query(default="NSE"),
) -> JSONResponse:
    """Fetch live quotes via the authorized Upstox API."""
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not sym_list:
        return JSONResponse(status_code=400, content={"error": "no symbols provided"})

    try:
        quotes = await upstox_client.get_quotes(sym_list, exchange=exchange)
    except ProviderError as exc:
        # A provider-level failure is isolated — return a clean, classified
        # error, never a crash. The overall service stays healthy.
        return JSONResponse(
            status_code=_error_status_for(exc),
            content={
                "error": str(exc),
                "provider": "upstox",
                "retryable": exc.retryable,
                "retryAfterMs": exc.retry_after_ms,
            },
        )

    return JSONResponse(
        status_code=200,
        content={
            "quotes": {sym: q.model_dump() for sym, q in quotes.items()},
            "count": len(quotes),
            "provider": "upstox",
        },
    )


@brokers_router.get("/upstox/historical", response_class=JSONResponse)
async def upstox_historical(
    symbol: str = Query(...),
    interval: str = Query(default="1d"),
    from_date: str = Query(..., alias="from"),
    to_date: str = Query(..., alias="to"),
    exchange: str = Query(default="NSE"),
) -> JSONResponse:
    """Fetch historical candles via the authorized Upstox API."""
    try:
        f = date.fromisoformat(from_date)
        t = date.fromisoformat(to_date)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "from/to must be YYYY-MM-DD"})

    try:
        candles = await upstox_client.get_historical_candles(
            symbol, interval, f, t, exchange=exchange
        )
    except ProviderError as exc:
        return JSONResponse(
            status_code=_error_status_for(exc),
            content={
                "error": str(exc),
                "provider": "upstox",
                "retryable": exc.retryable,
                "retryAfterMs": exc.retry_after_ms,
            },
        )

    return JSONResponse(
        status_code=200,
        content={
            "candles": [c.model_dump() for c in candles],
            "count": len(candles),
            "provider": "upstox",
        },
    )
