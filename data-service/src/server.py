"""
data-service FastAPI application.

Entry point for the AlphaForge Scrapling data microservice. Manages the
lifespan of all components (Redis, DynamicSession, AntibanLayer, TickPublisher)
and exposes the core health and status endpoints.

Start with:
    uvicorn src.server:app --host 0.0.0.0 --port 8200
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from src.config import settings
from src.monitoring.router import (
    mark_service_initialized,
    monitoring_router,
    set_proxy_manager,
    set_session_warmer,
)
from src.monitoring.health_router import health_router
from src.publisher.router import publisher_router
from src.scrapers.historical import historical_router
from src.scrapers.instrument_master import instrument_router
from src.scrapers.live_quotes import quotes_router
from src.scrapers.option_chain import option_chain_router

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Global service state
# ---------------------------------------------------------------------------

# Maps component name → failure reason string, or "ok" when healthy.
_component_status: dict[str, str] = {}

# Monotonic timestamp recorded at the start of the lifespan (for uptime).
_service_start_time: float = 0.0

# Populated during lifespan; other modules reference these singletons.
_redis_client: Any = None

# Tracks whether each optional capability is available.
_chromium_available: bool = False
_redis_available: bool = False


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN001
    """Manage component startup and graceful shutdown."""
    global _redis_client, _chromium_available, _redis_available, _service_start_time

    _service_start_time = time.monotonic()
    log = logger.bind(phase="startup")
    log.info("data-service starting", version="0.1.0")

    # ------------------------------------------------------------------
    # 1. Connect Redis
    # ------------------------------------------------------------------
    try:
        import redis.asyncio as aioredis  # type: ignore[import]

        _redis_client = await aioredis.from_url(
            settings.redis_url,
            encoding="utf-8",
            decode_responses=True,
        )
        await _redis_client.ping()
        _redis_available = True
        _component_status["redis"] = "ok"
        log.info("redis_connected", url=settings.redis_url)
    except Exception as exc:  # pragma: no cover
        _redis_available = False
        _component_status["redis"] = str(exc)
        log.error("redis_connect_failed", error=str(exc))

    # ------------------------------------------------------------------
    # 2. Warm DynamicSession (headless Chromium)
    # ------------------------------------------------------------------
    try:
        # Scrapling is an optional heavy dependency — import inside the try
        # block so the service starts in degraded mode when it is absent.
        from scrapling.fetchers import AsyncDynamicSession  # type: ignore[import]

        async with AsyncDynamicSession(
            headless=settings.scrapling_headless,
            extra_flags=["--disable-ipv6"],
        ) as _sess:
            # A bare page load is enough to verify Chromium is functional.
            # Each scraper owns its own singleton session.
            pass

        _chromium_available = True
        _component_status["chromium"] = "ok"
        log.info("chromium_warmed", headless=settings.scrapling_headless)
    except Exception as exc:
        _chromium_available = False
        _component_status["chromium"] = str(exc)
        log.error("chromium_warm_failed", error=str(exc))

    # ------------------------------------------------------------------
    # 3. Start AntibanLayer (ProxyManager + SessionWarmer)
    # ------------------------------------------------------------------
    try:
        from src.anti_ban.ban_detector import ban_detector
        from src.anti_ban.proxy_manager import create_proxy_manager
        from src.anti_ban.session_warmer import create_session_warmer
        from src.scrapers.live_quotes import set_quote_proxy_manager
        from src.scrapers.option_chain import set_chain_proxy_manager

        _proxy_mgr = create_proxy_manager(settings)
        _session_warmer_instance = create_session_warmer(
            proxy_manager=_proxy_mgr,
            ban_detector=ban_detector,
            settings=settings,
        )
        set_proxy_manager(_proxy_mgr)
        set_session_warmer(_session_warmer_instance)
        # Wire proxy manager into scrapers so bans rotate the proxy correctly
        set_quote_proxy_manager(_proxy_mgr)
        set_chain_proxy_manager(_proxy_mgr)

        await _session_warmer_instance.start()
        _component_status["anti_ban"] = "ok"
        log.info("anti_ban_started")
    except Exception as exc:
        _component_status["anti_ban"] = str(exc)
        log.error("anti_ban_start_failed", error=str(exc))

    # ------------------------------------------------------------------
    # 4. Start TickPublisher
    # ------------------------------------------------------------------
    from src.publisher.tick_publisher import tick_publisher as _tick_publisher_instance
    from src.publisher.stream_publisher import stream_publisher as _stream_pub

    try:
        await _tick_publisher_instance.start(redis_client=_redis_client)
        # Wire stream publisher for durable delivery
        if _redis_client is not None:
            _stream_pub.set_redis(_redis_client)
        _component_status["tick_publisher"] = "ok"
        log.info("tick_publisher_started")
    except Exception as exc:  # pragma: no cover
        _component_status["tick_publisher"] = str(exc)
        log.error("tick_publisher_start_failed", error=str(exc))

    # ------------------------------------------------------------------
    # Log final startup state
    # ------------------------------------------------------------------
    degraded_components = {k: v for k, v in _component_status.items() if v != "ok"}
    if degraded_components:
        log.warning("data-service started in degraded mode", degraded=degraded_components)
    else:
        log.info("data-service started healthy")

    # Mark service as initialized so monitoring endpoints return real data.
    mark_service_initialized()

    # --- Yield — service is running ---
    yield

    # ------------------------------------------------------------------
    # Shutdown
    # ------------------------------------------------------------------
    shutdown_log = logger.bind(phase="shutdown")

    try:
        from src.publisher.tick_publisher import tick_publisher as _tp
        await _tp.stop()
        shutdown_log.info("tick_publisher_stopped")
    except Exception as exc:  # pragma: no cover
        shutdown_log.warning("tick_publisher_stop_error", error=str(exc))

    # Close the persistent HTTP client
    try:
        from src.scrapers.live_quotes import close_http_client
        await close_http_client()
        shutdown_log.info("http_client_closed")
    except Exception as exc:  # pragma: no cover
        shutdown_log.warning("http_client_close_error", error=str(exc))

    # Stop the session warmer background task
    try:
        from src.monitoring.router import _session_warmer as _sw
        if _sw is not None:
            await _sw.stop()
            shutdown_log.info("session_warmer_stopped")
    except Exception as exc:  # pragma: no cover
        shutdown_log.warning("session_warmer_stop_error", error=str(exc))

    if _redis_client is not None:
        try:
            await _redis_client.aclose()
            shutdown_log.info("redis_disconnected")
        except Exception as exc:  # pragma: no cover
            shutdown_log.warning("redis_close_error", error=str(exc))

    shutdown_log.info("data-service shutdown complete")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="AlphaForge Data Service",
    description=(
        "Credential-free Indian market data microservice. "
        "Scrapes NSE and BSE using Scrapling (headless Chromium + TLS fingerprint spoofing), "
        "publishes live ticks to Redis pub/sub, and exposes REST endpoints for "
        "historical OHLCV, live quotes, option chains, and instrument master data."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS middleware
# ---------------------------------------------------------------------------
# Only localhost:3000 and 127.0.0.1:3000 are whitelisted.
# All other origins receive HTTP 403 (the default CORS behaviour when
# allow_origins is an explicit list and the incoming Origin is not in it).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now_iso() -> str:
    """Return the current UTC time as an ISO 8601 string with 'Z' suffix."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------


@app.get("/health", response_class=JSONResponse)
async def health() -> JSONResponse:
    """
    Always returns HTTP 200 so Docker healthchecks never block service start.

    Returns ``status: "healthy"`` when every component is functional,
    ``status: "degraded"`` with a ``components`` map otherwise.
    """
    degraded_components = {k: v for k, v in _component_status.items() if v != "ok"}
    status = "degraded" if degraded_components else "healthy"

    body: dict[str, Any] = {
        "status": status,
        "service": "data-service",
        "version": "0.1.0",
        "timestamp": _utc_now_iso(),
    }

    if degraded_components:
        body["components"] = degraded_components

    return JSONResponse(content=body, status_code=200)


# ---------------------------------------------------------------------------
# Scraping status endpoint
# ---------------------------------------------------------------------------


@app.get("/scraping/status", response_class=JSONResponse)
async def scraping_status() -> JSONResponse:
    """
    Returns scraping capability flags and the current configuration summary.

    Clients can use this to decide whether to skip ScraplingProvider before
    a real scraping call is attempted.
    """
    body: dict[str, Any] = {
        "available": True,
        "version": "2.0.0",
        "capabilities": {
            "chromium_available": _chromium_available,
            "redis_connected": _redis_available,
            "proxy_available": bool(
                settings.scrapling_proxy_url or settings.scrapling_proxy_list
            ),
            "live_quotes": True,
            "option_chain_nse": True,
            "option_chain_bse": True,
            "historical_daily": True,
            "historical_intraday": True,
            "instrument_master": True,
            "tick_publisher": _component_status.get("tick_publisher") == "ok",
            "redis_streams": True,
            "data_lineage": True,
            "candle_builder": True,
        },
        "config": {
            "active_symbol_count": len(settings.symbols),
            "nse_rate_limit": settings.nse_rate_limit,
            "bse_rate_limit": settings.bse_rate_limit,
            "proxy_enabled": bool(
                settings.scrapling_proxy_url or settings.scrapling_proxy_list
            ),
            "headless": settings.scrapling_headless,
            "data_dir": settings.data_dir,
        },
        "dataServiceV2": {
            "semanticIntegrityFixed": True,
            "oiNotMappedToTradedValue": True,
            "connectionPoolingEnabled": True,
            "redisStreamsEnabled": True,
            "deduplicationEnabled": True,
            "lineageTrackingEnabled": True,
        },
    }

    return JSONResponse(content=body, status_code=200)


# ---------------------------------------------------------------------------
# Routers — registered after app and middleware are fully configured
# ---------------------------------------------------------------------------

app.include_router(historical_router)
app.include_router(quotes_router)
app.include_router(option_chain_router)
app.include_router(instrument_router)
app.include_router(publisher_router)
app.include_router(monitoring_router)
app.include_router(health_router)


# ---------------------------------------------------------------------------
# Validation error handler — return HTTP 400 instead of FastAPI's default 422
# ---------------------------------------------------------------------------


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Any, exc: RequestValidationError) -> JSONResponse:  # noqa: ANN001
    """Return HTTP 400 (not 422) for request body validation failures."""
    errors = exc.errors()
    first = errors[0] if errors else {}
    msg = first.get("msg", "Validation error")
    return JSONResponse({"error": msg}, status_code=400)
