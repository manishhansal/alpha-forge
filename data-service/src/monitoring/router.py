"""
Monitoring router for data-service.

This module provides:
  - RequestRecord: per-request log entry
  - EndpointStats: P50/P99/success_rate summary for an endpoint
  - RollingWindowStats: sliding 3600-second window over RequestRecords,
    plus cache hit tracking, uptime, and request counting
  - rolling_stats: module-level singleton used by all scrapers and routes
  - _service_initialized: module flag; monitoring routes return 503 until
    the FastAPI lifespan sets this to True
  - monitoring_router: FastAPI APIRouter with 4 monitoring endpoints

Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

if TYPE_CHECKING:
    from src.anti_ban.proxy_manager import ProxyManager
    from src.anti_ban.session_warmer import SessionWarmer


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class RequestRecord:
    """Single request log entry stored in the rolling window."""

    endpoint: str
    duration_ms: int
    success: bool
    recorded_at: float  # time.monotonic() — NOT wall-clock, avoids DST jumps


@dataclass
class EndpointStats:
    """Aggregated statistics for a single endpoint over the rolling window."""

    p50_ms: int
    p99_ms: int
    success_rate: float  # 0.0–1.0 rounded to 4 decimal places


# ---------------------------------------------------------------------------
# RollingWindowStats
# ---------------------------------------------------------------------------


class RollingWindowStats:
    """Sliding-window request statistics tracker.

    Maintains all :class:`RequestRecord` entries from the last
    ``WINDOW_SECONDS`` seconds (default 3600).  All methods are
    thread-safe via a single ``threading.Lock``.

    Counter semantics
    -----------------
    ``_request_count``: total requests recorded since service start (never
    decremented by eviction — it is a monotonic counter).

    ``_cache_hits`` / ``_cache_total``: tracked via :meth:`record_cache_result`
    so that :attr:`cache_hit_rate` can be reported on the monitoring endpoint.
    Both are also monotonic; the reported *rate* is lifetime, not windowed.

    P50 / P99 computation
    ----------------------
    Durations are sorted ascending; indices are ``int(0.50 * n)`` and
    ``int(0.99 * n)`` (0-indexed), matching the design spec.
    """

    WINDOW_SECONDS: int = 3600

    # Known endpoint names — used by get_all_stats() to enumerate results
    # even when no requests have been recorded for a particular endpoint yet.
    KNOWN_ENDPOINTS: tuple[str, ...] = (
        "/scraping/historical",
        "/scraping/quotes",
        "/scraping/option-chain",
        "/scraping/instruments",
        "/publisher/status",
        "/publisher/symbols",
        "/monitoring/health",
        "/monitoring/scraping-stats",
        "/monitoring/proxy-status",
        "/monitoring/session-status",
    )

    def __init__(self) -> None:
        self._records: list[RequestRecord] = []
        self._lock = threading.Lock()
        self._start_time: float = time.monotonic()
        self._request_count: int = 0
        self._cache_hits: int = 0
        self._cache_total: int = 0

    # ------------------------------------------------------------------
    # Public API — recording
    # ------------------------------------------------------------------

    def record(self, endpoint: str, duration_ms: int, success: bool) -> None:
        """Append a new :class:`RequestRecord` and evict stale records.

        ``duration_ms`` must be a non-negative integer (callers are
        responsible for clamping/rounding).
        """
        now = time.monotonic()
        record = RequestRecord(
            endpoint=endpoint,
            duration_ms=max(0, int(duration_ms)),
            success=success,
            recorded_at=now,
        )
        with self._lock:
            self._records.append(record)
            self._request_count += 1
            self._evict(now)

    def record_cache_result(self, hit: bool) -> None:
        """Track a cache lookup outcome for :attr:`cache_hit_rate`.

        Call once per cache lookup (both hits and misses).
        """
        with self._lock:
            self._cache_total += 1
            if hit:
                self._cache_hits += 1

    # ------------------------------------------------------------------
    # Public API — querying
    # ------------------------------------------------------------------

    def get_stats(self, endpoint: str) -> Optional[EndpointStats]:
        """Return :class:`EndpointStats` for *endpoint* within the window.

        Returns ``None`` when no records exist for *endpoint* in the
        current window.

        P50 index: ``int(0.50 * n)``
        P99 index: ``int(0.99 * n)``
        Both are 0-indexed and intentionally match the design spec.
        """
        now = time.monotonic()
        with self._lock:
            self._evict(now)
            records = [r for r in self._records if r.endpoint == endpoint]

        if not records:
            return None

        n = len(records)
        durations = sorted(r.duration_ms for r in records)
        success_count = sum(1 for r in records if r.success)

        return EndpointStats(
            p50_ms=durations[int(0.50 * n)],
            p99_ms=durations[int(0.99 * n)],
            success_rate=round(success_count / n, 4),
        )

    def get_all_stats(self) -> dict[str, Optional[EndpointStats]]:
        """Return :class:`EndpointStats` (or ``None``) for every known endpoint.

        The returned dict always contains all entries in
        :attr:`KNOWN_ENDPOINTS`.  Endpoints with no records in the current
        window map to ``None``.
        """
        now = time.monotonic()
        with self._lock:
            self._evict(now)
            # Snapshot under lock so get_stats() doesn't re-acquire
            snapshot = list(self._records)

        result: dict[str, Optional[EndpointStats]] = {}
        for endpoint in self.KNOWN_ENDPOINTS:
            ep_records = [r for r in snapshot if r.endpoint == endpoint]
            if not ep_records:
                result[endpoint] = None
                continue
            n = len(ep_records)
            durations = sorted(r.duration_ms for r in ep_records)
            success_count = sum(1 for r in ep_records if r.success)
            result[endpoint] = EndpointStats(
                p50_ms=durations[int(0.50 * n)],
                p99_ms=durations[int(0.99 * n)],
                success_rate=round(success_count / n, 4),
            )
        return result

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def uptime_seconds(self) -> int:
        """Non-negative integer seconds since this instance was created."""
        return max(0, int(time.monotonic() - self._start_time))

    @property
    def request_count(self) -> int:
        """Monotonic count of all requests recorded since service start."""
        with self._lock:
            return self._request_count

    @property
    def cache_hit_rate(self) -> float:
        """Lifetime cache hit rate as a float in [0.0, 1.0] rounded to 4 dp.

        Returns ``0.0`` when no cache lookups have been recorded yet.
        """
        with self._lock:
            total = self._cache_total
            hits = self._cache_hits
        if total == 0:
            return 0.0
        return round(hits / total, 4)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _evict(self, now: float) -> None:
        """Remove records older than ``WINDOW_SECONDS`` from ``_records``.

        MUST be called with ``self._lock`` already held.
        """
        cutoff = now - self.WINDOW_SECONDS
        # Records are appended in chronological order so we can binary-search
        # for the cutoff point.  For correctness a linear scan from the front
        # is used; the list is small in practice (≤ 3600 × max_rps entries).
        keep_from = 0
        for i, record in enumerate(self._records):
            if record.recorded_at >= cutoff:
                keep_from = i
                break
        else:
            # All records are stale — clear entirely
            if self._records and self._records[-1].recorded_at < cutoff:
                self._records = []
                return

        self._records = self._records[keep_from:]


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

#: Shared instance imported by scrapers and route handlers.
rolling_stats = RollingWindowStats()

# ---------------------------------------------------------------------------
# Service initialisation gate
# ---------------------------------------------------------------------------

#: Set to ``True`` by the FastAPI lifespan once all components have started.
#: Monitoring route handlers check this flag and return 503 with
#: ``{"available": false, "reason": "service not yet ready"}`` until it
#: flips to True.
_service_initialized: bool = False


def mark_service_initialized() -> None:
    """Called once from the FastAPI lifespan after successful startup."""
    global _service_initialized
    _service_initialized = True


def is_service_initialized() -> bool:
    """Return True when the service has finished its startup sequence."""
    return _service_initialized

# ---------------------------------------------------------------------------
# Dependency-injection slots for anti-ban components
# ---------------------------------------------------------------------------
# These are set once during FastAPI lifespan startup via the setter functions
# below. Monitoring route handlers access the live ProxyManager and
# SessionWarmer through these module-level references so that no circular
# imports are introduced.

_proxy_manager: Optional["ProxyManager"] = None
_session_warmer: Optional["SessionWarmer"] = None


def set_proxy_manager(pm: "ProxyManager") -> None:
    """Inject the live ProxyManager instance from the lifespan startup code."""
    global _proxy_manager
    _proxy_manager = pm


def set_session_warmer(sw: "SessionWarmer") -> None:
    """Inject the live SessionWarmer instance from the lifespan startup code."""
    global _session_warmer
    _session_warmer = sw


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

monitoring_router = APIRouter(prefix="/monitoring", tags=["monitoring"])

# Shared 503 body returned while the service is still initialising.
_NOT_READY_BODY: dict[str, Any] = {
    "available": False,
    "reason": "service not yet ready",
}


# ---------------------------------------------------------------------------
# GET /monitoring/health  (Requirement 10.1)
# ---------------------------------------------------------------------------


@monitoring_router.get("/health", response_class=JSONResponse)
async def monitoring_health() -> JSONResponse:
    """Return overall service health counters.

    Returns ``{"available": false, "reason": "service not yet ready"}`` with
    HTTP 503 when the service has not finished initialising.

    Normal response (HTTP 200)::

        {
            "request_count": 1234,
            "ban_count": 2,
            "cache_hit_rate": 0.9876,
            "uptime_seconds": 3600
        }
    """
    if not is_service_initialized():
        return JSONResponse(content=_NOT_READY_BODY, status_code=503)

    from src.anti_ban.ban_detector import ban_detector  # local import avoids circulars

    body: dict[str, Any] = {
        "request_count": rolling_stats.request_count,
        "ban_count": ban_detector.ban_count,
        "cache_hit_rate": rolling_stats.cache_hit_rate,
        "uptime_seconds": rolling_stats.uptime_seconds,
    }
    return JSONResponse(content=body, status_code=200)


# ---------------------------------------------------------------------------
# GET /monitoring/scraping-stats  (Requirement 10.2)
# ---------------------------------------------------------------------------


@monitoring_router.get("/scraping-stats", response_class=JSONResponse)
async def monitoring_scraping_stats() -> JSONResponse:
    """Return per-endpoint P50/P99 latency and success_rate over the last 3600 s.

    Endpoints with no requests in the window map to ``null``.

    Example response::

        {
            "endpoints": {
                "/scraping/historical": {"p50_ms": 150, "p99_ms": 800, "success_rate": 0.98},
                "/scraping/quotes": null,
                ...
            }
        }
    """
    if not is_service_initialized():
        return JSONResponse(content=_NOT_READY_BODY, status_code=503)

    all_stats = rolling_stats.get_all_stats()

    endpoints: dict[str, Any] = {}
    for endpoint, stats in all_stats.items():
        if stats is None:
            endpoints[endpoint] = None
        else:
            endpoints[endpoint] = {
                "p50_ms": stats.p50_ms,
                "p99_ms": stats.p99_ms,
                "success_rate": stats.success_rate,
            }

    return JSONResponse(content={"endpoints": endpoints}, status_code=200)


# ---------------------------------------------------------------------------
# GET /monitoring/proxy-status  (Requirement 10.3)
# ---------------------------------------------------------------------------


@monitoring_router.get("/proxy-status", response_class=JSONResponse)
async def monitoring_proxy_status() -> JSONResponse:
    """Return proxy pool state with credentials masked.

    Example response::

        {
            "pool_size": 3,
            "rotation_count": 12,
            "active_proxy": "http://***@proxy.host:8080"
        }

    ``active_proxy`` is ``null`` when no proxy is configured.
    """
    if not is_service_initialized():
        return JSONResponse(content=_NOT_READY_BODY, status_code=503)

    if _proxy_manager is not None:
        pool_size = _proxy_manager.pool_size
        rotation_count = _proxy_manager.rotation_count
        active_proxy = _proxy_manager.active_proxy_masked()
    else:
        # ProxyManager not yet injected — return safe defaults.
        pool_size = 0
        rotation_count = 0
        active_proxy = None

    body: dict[str, Any] = {
        "pool_size": pool_size,
        "rotation_count": rotation_count,
        "active_proxy": active_proxy,
    }
    return JSONResponse(content=body, status_code=200)


# ---------------------------------------------------------------------------
# GET /monitoring/session-status  (Requirement 10.4)
# ---------------------------------------------------------------------------


@monitoring_router.get("/session-status", response_class=JSONResponse)
async def monitoring_session_status() -> JSONResponse:
    """Return session warmer state.

    Example response::

        {
            "last_warm_at": "2025-01-01T09:00:00Z",
            "session_age_seconds": 1800,
            "next_warm_at": "2025-01-01T09:30:00Z"
        }

    All fields are ``null`` when no warm has occurred or the warmer has not
    been injected yet.
    """
    if not is_service_initialized():
        return JSONResponse(content=_NOT_READY_BODY, status_code=503)

    if _session_warmer is not None:
        last_warm = _session_warmer.last_warm_at
        next_warm = _session_warmer.next_warm_at
        age = _session_warmer.session_age_seconds
    else:
        # SessionWarmer not yet injected — return null placeholders.
        last_warm = None
        next_warm = None
        age = None

    def _iso(dt: Any) -> Optional[str]:
        """Convert a datetime to UTC ISO-8601 string with Z suffix, or None."""
        if dt is None:
            return None
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    body: dict[str, Any] = {
        "last_warm_at": _iso(last_warm),
        "session_age_seconds": age,
        "next_warm_at": _iso(next_warm),
    }
    return JSONResponse(content=body, status_code=200)
