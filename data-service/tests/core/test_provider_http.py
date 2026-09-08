"""
Reliability matrix for the shared provider HTTP layer (spec §33).

Deterministic tests using httpx.MockTransport + an injectable sleep, so no real
network I/O and no real time elapses. Proves:
  - 403 → ProviderAuthorizationError, raised on the FIRST attempt (no retry storm)
  - 401 → ProviderAuthenticationError, no retry
  - 404 → InstrumentNotFoundError, no retry
  - 429 → ProviderRateLimitError, Retry-After honoured, then exhausts
  - 503 → ProviderUnavailableError, retried with backoff, then exhausts
  - timeout / network → retried then classified
  - success after a transient failure
"""

from __future__ import annotations

import httpx
import pytest

from src.core import provider_http
from src.core.provider_http import (
    InstrumentNotFoundError,
    ProviderAuthenticationError,
    ProviderAuthorizationError,
    ProviderMalformedResponseError,
    ProviderNetworkError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    parse_retry_after_ms,
    resilient_get,
)

_BASE = "https://mock.provider.test"


class _Recorder:
    """Counts sleeps so we can assert backoff happened without real waiting."""

    def __init__(self) -> None:
        self.sleeps: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.sleeps.append(seconds)


def _install_mock(handler) -> None:
    """Inject a MockTransport-backed client into the pooled registry for _BASE."""
    transport = httpx.MockTransport(handler)
    provider_http._clients[_BASE] = httpx.AsyncClient(base_url=_BASE, transport=transport)


@pytest.fixture(autouse=True)
async def _cleanup():
    yield
    await provider_http.close_all_clients()


# ── Retry-After parsing ─────────────────────────────────────────────────────────


def test_parse_retry_after_seconds():
    assert parse_retry_after_ms("120") == 120_000
    assert parse_retry_after_ms(None) is None
    assert parse_retry_after_ms("") is None


# ── 403: no retry storm ──────────────────────────────────────────────────────────


async def test_403_raises_immediately_no_retry():
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(403, json={"error": "forbidden"})

    _install_mock(handler)
    sleeper = _Recorder()
    with pytest.raises(ProviderAuthorizationError) as ei:
        await resilient_get(provider="t", base_url=_BASE, path="/x", sleep=sleeper)
    assert ei.value.http_status == 403
    assert ei.value.retryable is False
    # Exactly ONE attempt — never retry a 403.
    assert calls["n"] == 1
    assert sleeper.sleeps == []


async def test_401_raises_immediately():
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    _install_mock(handler)
    with pytest.raises(ProviderAuthenticationError):
        await resilient_get(provider="t", base_url=_BASE, path="/x", sleep=_Recorder())


async def test_404_instrument_not_found():
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    _install_mock(handler)
    with pytest.raises(InstrumentNotFoundError):
        await resilient_get(provider="t", base_url=_BASE, path="/x", sleep=_Recorder())


# ── 429: honour Retry-After, retryable, then exhaust ─────────────────────────────


async def test_429_honours_retry_after_then_exhausts():
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, headers={"Retry-After": "2"}, json={"error": "rate"})

    _install_mock(handler)
    sleeper = _Recorder()
    with pytest.raises(ProviderRateLimitError) as ei:
        await resilient_get(provider="t", base_url=_BASE, path="/x", max_attempts=3, sleep=sleeper)
    assert ei.value.retry_after_ms == 2000
    # 3 attempts total → 2 backoff sleeps, each honouring Retry-After (2s).
    assert calls["n"] == 3
    assert sleeper.sleeps == [2.0, 2.0]


# ── 503: backoff + retry, no request storm ───────────────────────────────────────


async def test_503_retries_with_backoff_then_exhausts():
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503)

    _install_mock(handler)
    sleeper = _Recorder()
    with pytest.raises(ProviderUnavailableError):
        await resilient_get(provider="t", base_url=_BASE, path="/x", max_attempts=3, sleep=sleeper)
    # Bounded attempts — NOT an unbounded storm.
    assert calls["n"] == 3
    # Two backoff sleeps on the exponential ladder (~1s, ~2s + jitter).
    assert len(sleeper.sleeps) == 2
    assert 1.0 <= sleeper.sleeps[0] <= 1.25
    assert 2.0 <= sleeper.sleeps[1] <= 2.5


# ── success after a transient 503 ────────────────────────────────────────────────


async def test_success_after_transient_503():
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"ok": True})

    _install_mock(handler)
    result = await resilient_get(provider="t", base_url=_BASE, path="/x", sleep=_Recorder())
    assert result.json == {"ok": True}
    assert result.attempts == 2


# ── malformed body ───────────────────────────────────────────────────────────────


async def test_malformed_json_raises():
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json")

    _install_mock(handler)
    with pytest.raises(ProviderMalformedResponseError):
        await resilient_get(provider="t", base_url=_BASE, path="/x", sleep=_Recorder())


# ── timeout & network are retryable ──────────────────────────────────────────────


async def test_timeout_is_retried_then_classified():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ReadTimeout("timed out", request=req)

    _install_mock(handler)
    with pytest.raises(ProviderTimeoutError):
        await resilient_get(provider="t", base_url=_BASE, path="/x", max_attempts=2, sleep=_Recorder())
    assert calls["n"] == 2


async def test_network_error_is_retried_then_classified():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("connection refused", request=req)

    _install_mock(handler)
    with pytest.raises(ProviderNetworkError):
        await resilient_get(provider="t", base_url=_BASE, path="/x", max_attempts=2, sleep=_Recorder())
    assert calls["n"] == 2
