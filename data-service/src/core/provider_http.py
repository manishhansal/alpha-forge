"""
Provider HTTP resilience layer.

A single, shared helper for making authorized broker/provider HTTP calls with
production-grade resilience:

  - Typed provider errors (403 / 503 / 429 / timeout / network / malformed) so
    callers and circuit breakers can react correctly instead of treating every
    failure as a generic error.
  - Retry-After honouring for 429 / 503.
  - Exponential backoff + jitter on transient failures (503 / timeout / network).
  - NO retry on non-retryable failures (401 / 403 / 404 / 400) — retrying an
    authorization/authentication failure just burns attempts and can flag the
    source further. We NEVER attempt to bypass a 403.
  - A pooled, reused ``httpx.AsyncClient`` per base URL (keep-alive) instead of
    a new TCP+TLS connection per request.

This module deliberately does not know about any specific provider — it is used
by ``brokers/upstox_client.py`` (and could be used by any future authorized
provider client). Provider ordering / failover lives in the TypeScript
ProviderRegistry; this layer only makes an *individual* provider call resilient.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import httpx
import structlog

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Typed provider errors
# ---------------------------------------------------------------------------


class ProviderError(Exception):
    """Base class for all classified provider failures.

    Attributes
    ----------
    provider:   short provider id (e.g. "upstox").
    http_status: the upstream HTTP status, when the failure came from a response.
    retryable:  whether this failure class is safe to retry.
    retry_after_ms: provider-supplied cooldown (429 / 503), when present.
    """

    retryable: bool = False

    def __init__(
        self,
        message: str,
        provider: str,
        http_status: Optional[int] = None,
        retry_after_ms: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.http_status = http_status
        self.retry_after_ms = retry_after_ms


class ProviderAuthenticationError(ProviderError):
    """401 — invalid/expired credentials. Not retryable; needs token recovery."""

    retryable = False


class ProviderAuthorizationError(ProviderError):
    """403 — forbidden / WAF / gateway block. Not retryable. NEVER bypass."""

    retryable = False


class ProviderRateLimitError(ProviderError):
    """429 — too many requests. Retryable only after the Retry-After cooldown."""

    retryable = True


class ProviderUnavailableError(ProviderError):
    """503 / 5xx — provider temporarily degraded. Retryable with backoff."""

    retryable = True


class ProviderTimeoutError(ProviderError):
    """Request exceeded the deadline. Retryable with backoff."""

    retryable = True


class ProviderNetworkError(ProviderError):
    """ECONNRESET / DNS / connection refused. Retryable with backoff."""

    retryable = True


class ProviderMalformedResponseError(ProviderError):
    """Body present but failed to parse / validate. Not retryable (same body)."""

    retryable = False


class ProviderCapabilityError(ProviderError):
    """The provider does not support the requested capability."""

    retryable = False


class InstrumentNotFoundError(ProviderError):
    """404 — the symbol/token is unknown to this provider."""

    retryable = False


# ---------------------------------------------------------------------------
# Retry-After parsing
# ---------------------------------------------------------------------------


def parse_retry_after_ms(header_value: Optional[str], now: Optional[float] = None) -> Optional[int]:
    """Parse an HTTP ``Retry-After`` header into milliseconds.

    Supports both delta-seconds ("120") and the HTTP-date form. Returns None
    when the header is absent or unparseable.
    """
    if not header_value:
        return None
    value = header_value.strip()
    if value.isdigit():
        return int(value) * 1000
    try:
        dt = parsedate_to_datetime(value)
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now_s = now if now is not None else datetime.now(timezone.utc).timestamp()
        delta_ms = int((dt.timestamp() - now_s) * 1000)
        return max(0, delta_ms)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Status classification
# ---------------------------------------------------------------------------


def classify_status(
    status: int,
    provider: str,
    message: str,
    retry_after_ms: Optional[int] = None,
) -> ProviderError:
    """Map an HTTP status code to the appropriate typed ProviderError."""
    if status == 401:
        return ProviderAuthenticationError(message, provider, status)
    if status == 403:
        return ProviderAuthorizationError(message, provider, status)
    if status == 404:
        return InstrumentNotFoundError(message, provider, status)
    if status == 408:
        return ProviderTimeoutError(message, provider, status)
    if status == 429:
        return ProviderRateLimitError(message, provider, status, retry_after_ms)
    if status == 503:
        return ProviderUnavailableError(message, provider, status, retry_after_ms)
    if status >= 500:
        return ProviderUnavailableError(message, provider, status, retry_after_ms)
    return ProviderMalformedResponseError(message, provider, status)


# ---------------------------------------------------------------------------
# Backoff schedule
# ---------------------------------------------------------------------------

# 1s, 2s, 4s, 8s, 16s, 30s, 60s (spec §7). Indexed by attempt.
_BACKOFF_LADDER_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000]
_MAX_RETRY_AFTER_SLEEP_MS = 60_000
_JITTER_FRACTION = 0.2


def _with_jitter(ms: int) -> int:
    return int(ms + ms * _JITTER_FRACTION * random.random())


def backoff_ms(attempt: int, retry_after_ms: Optional[int] = None) -> int:
    """Compute the sleep (ms) before the next attempt.

    A provider-supplied Retry-After (capped) always wins; otherwise use the
    exponential ladder with jitter.
    """
    if retry_after_ms is not None and retry_after_ms > 0:
        return min(_MAX_RETRY_AFTER_SLEEP_MS, retry_after_ms)
    idx = min(max(0, attempt), len(_BACKOFF_LADDER_MS) - 1)
    return _with_jitter(_BACKOFF_LADDER_MS[idx])


# ---------------------------------------------------------------------------
# Pooled client registry
# ---------------------------------------------------------------------------

_clients: dict[str, httpx.AsyncClient] = {}
_clients_lock = asyncio.Lock()


async def get_pooled_client(
    base_url: str,
    timeout_s: float = 10.0,
    default_headers: Optional[dict[str, str]] = None,
) -> httpx.AsyncClient:
    """Return a keep-alive pooled AsyncClient for ``base_url`` (created once)."""
    existing = _clients.get(base_url)
    if existing is not None and not existing.is_closed:
        return existing
    async with _clients_lock:
        existing = _clients.get(base_url)
        if existing is not None and not existing.is_closed:
            return existing
        client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(connect=5.0, read=timeout_s, write=5.0, pool=5.0),
            limits=httpx.Limits(
                max_keepalive_connections=10,
                max_connections=20,
                keepalive_expiry=30.0,
            ),
            headers=default_headers or {},
        )
        _clients[base_url] = client
        logger.info("provider_http_client_created", base_url=base_url)
        return client


async def close_all_clients() -> None:
    """Close every pooled client (used on shutdown / in tests)."""
    async with _clients_lock:
        for base_url, client in list(_clients.items()):
            if not client.is_closed:
                await client.aclose()
            _clients.pop(base_url, None)


# ---------------------------------------------------------------------------
# Resilient GET
# ---------------------------------------------------------------------------


@dataclass
class ResilientGetResult:
    status: int
    json: Any
    attempts: int


async def resilient_get(
    *,
    provider: str,
    base_url: str,
    path: str,
    headers: Optional[dict[str, str]] = None,
    params: Optional[dict[str, Any]] = None,
    timeout_s: float = 10.0,
    max_attempts: int = 3,
    sleep=asyncio.sleep,
) -> ResilientGetResult:
    """Perform a GET with typed-error classification, Retry-After and backoff.

    Raises the appropriate ``ProviderError`` subclass on failure. On a
    non-retryable failure (401/403/404/malformed) it raises immediately without
    burning further attempts — critically, a 403 is NEVER retried.

    ``sleep`` is injectable so tests can run deterministically without real time.
    """
    client = await get_pooled_client(base_url, timeout_s=timeout_s)

    last_error: Optional[ProviderError] = None
    for attempt in range(max_attempts):
        if attempt > 0 and last_error is not None:
            await sleep(backoff_ms(attempt - 1, last_error.retry_after_ms) / 1000.0)

        try:
            resp = await client.get(path, headers=headers or {}, params=params or {})
        except httpx.TimeoutException as exc:
            last_error = ProviderTimeoutError(f"{provider} {path}: timeout ({exc})", provider)
            logger.warning("provider_http_timeout", provider=provider, path=path, attempt=attempt)
            continue
        except httpx.HTTPError as exc:
            last_error = ProviderNetworkError(f"{provider} {path}: network error ({exc})", provider)
            logger.warning("provider_http_network_error", provider=provider, path=path, attempt=attempt)
            continue

        if resp.is_success:
            try:
                payload = resp.json()
            except ValueError as exc:
                raise ProviderMalformedResponseError(
                    f"{provider} {path}: malformed JSON ({exc})", provider, resp.status_code
                ) from exc
            return ResilientGetResult(status=resp.status_code, json=payload, attempts=attempt + 1)

        # Non-2xx — classify.
        retry_after_ms = parse_retry_after_ms(resp.headers.get("retry-after"))
        err = classify_status(
            resp.status_code,
            provider,
            f"{provider} {path}: HTTP {resp.status_code}",
            retry_after_ms,
        )

        if not err.retryable:
            # 401 / 403 / 404 / 4xx — do not retry. NEVER hammer a 403.
            logger.warning(
                "provider_http_non_retryable",
                provider=provider,
                path=path,
                status=resp.status_code,
                error=type(err).__name__,
            )
            raise err

        last_error = err
        logger.warning(
            "provider_http_retryable",
            provider=provider,
            path=path,
            status=resp.status_code,
            attempt=attempt,
            retry_after_ms=retry_after_ms,
        )

    # Exhausted retries on a retryable failure.
    assert last_error is not None
    logger.error(
        "provider_http_exhausted",
        provider=provider,
        path=path,
        attempts=max_attempts,
        error=type(last_error).__name__,
    )
    raise last_error
