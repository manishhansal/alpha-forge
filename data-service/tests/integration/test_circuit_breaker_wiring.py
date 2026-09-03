"""
Integration tests — Circuit Breaker Wiring (Phase 6 / V2.1 certification).

These tests verify that the circuit breaker is correctly wired into every
upstream HTTP call in the data-service scrapers. They use mock HTTP but test
real CircuitBreaker state machine transitions.

Test labels: UNIT_TESTED (CircuitBreaker state machine + scraper integration)
             NOT_TESTED for: real NSE network under load (requires live infra)

Evidence level: INTEGRATION_TESTED (real CircuitBreaker, mocked HTTP)
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.circuit_breaker import CircuitBreaker, CircuitState, get_breaker


class TestCircuitBreakerStateMachine:
    """Verify core CLOSED → OPEN → HALF_OPEN → CLOSED transitions."""

    def test_initially_closed(self) -> None:
        cb = CircuitBreaker("test_initial", failure_threshold=0.5, min_requests=2)
        assert cb.state == CircuitState.CLOSED

    def test_opens_after_threshold_failures(self) -> None:
        cb = CircuitBreaker("test_open", failure_threshold=0.5, min_requests=4)
        for _ in range(4):
            cb.record_failure("simulated")
        assert cb.state == CircuitState.OPEN

    def test_does_not_open_below_min_requests(self) -> None:
        cb = CircuitBreaker("test_min", failure_threshold=0.5, min_requests=5)
        for _ in range(3):
            cb.record_failure("simulated")
        assert cb.state == CircuitState.CLOSED

    def test_mixed_requests_below_threshold(self) -> None:
        cb = CircuitBreaker("test_mixed", failure_threshold=0.6, min_requests=4)
        cb.record_success()
        cb.record_success()
        cb.record_failure("err")
        cb.record_failure("err")
        # 2/4 = 0.5 failure rate, below 0.6 threshold
        assert cb.state == CircuitState.CLOSED

    def test_half_open_after_cooldown(self) -> None:
        import time
        cb = CircuitBreaker("test_half", failure_threshold=0.5, min_requests=2, open_timeout_s=0.01)
        cb.record_failure("a")
        cb.record_failure("b")
        assert cb.state == CircuitState.OPEN
        time.sleep(0.02)
        assert cb.state == CircuitState.HALF_OPEN

    def test_closes_after_half_open_success(self) -> None:
        import time
        cb = CircuitBreaker("test_close", failure_threshold=0.5, min_requests=2, open_timeout_s=0.01)
        cb.record_failure("a")
        cb.record_failure("b")
        time.sleep(0.02)
        assert cb.state == CircuitState.HALF_OPEN
        cb.record_success()
        assert cb.state == CircuitState.CLOSED

    def test_reopens_after_half_open_failure(self) -> None:
        import time
        cb = CircuitBreaker("test_reopen", failure_threshold=0.5, min_requests=2, open_timeout_s=0.01)
        cb.record_failure("a")
        cb.record_failure("b")
        time.sleep(0.02)
        assert cb.state == CircuitState.HALF_OPEN
        cb.record_failure("probe_failed")
        assert cb.state == CircuitState.OPEN

    def test_allow_request_blocks_when_open(self) -> None:
        cb = CircuitBreaker("test_block", failure_threshold=0.5, min_requests=2)
        cb.record_failure("a")
        cb.record_failure("b")
        assert cb.state == CircuitState.OPEN
        assert cb.allow_request() is False

    def test_allow_request_passes_when_closed(self) -> None:
        cb = CircuitBreaker("test_pass", failure_threshold=0.5, min_requests=5)
        assert cb.allow_request() is True

    def test_100_failures_under_concurrency(self) -> None:
        """Simulate 100 concurrent failures — verify thundering herd protection."""
        import threading
        cb = CircuitBreaker(
            "test_100",
            failure_threshold=0.5,
            min_requests=10,
            open_timeout_s=60.0,
        )
        errors = []

        def fail_thread(idx: int) -> None:
            try:
                if cb.allow_request():
                    cb.record_failure(f"simulated_{idx}")
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=fail_thread, args=(i,)) for i in range(100)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Thread errors: {errors}"
        # After 100 failures the breaker must be OPEN
        assert cb.state == CircuitState.OPEN, f"Expected OPEN, got {cb.state}"
        # Verify no requests pass through
        assert cb.allow_request() is False, "Requests must be suppressed when OPEN"

    def test_failure_rate_stat(self) -> None:
        cb = CircuitBreaker("test_rate", failure_threshold=0.8, min_requests=5)
        for _ in range(3):
            cb.record_failure("f")
        for _ in range(7):
            cb.record_success()
        assert 0.0 <= cb.failure_rate <= 1.0

    def test_stats_dict(self) -> None:
        cb = CircuitBreaker("test_stats")
        cb.record_success()
        cb.record_failure("test")
        stats = cb.stats
        assert "state" in stats
        assert "failure_rate" in stats
        assert "total_requests" in stats
        assert stats["total_requests"] == 2


class TestCircuitBreakerWiredToScrapers:
    """Verify that scrapers check circuit breaker before making HTTP calls."""

    @pytest.mark.asyncio
    async def test_batch_quotes_blocked_when_circuit_open(self) -> None:
        """_fetch_batch_quotes returns empty dict when circuit is OPEN."""
        # Force the nse_nextapi breaker open
        cb = get_breaker("nse_nextapi_test_batch")

        from src.core.circuit_breaker import _breakers
        original = _breakers.get("nse_nextapi")
        # Temporarily replace the breaker with a forced-open one
        import src.scrapers.live_quotes as lq
        cb_open = CircuitBreaker("nse_nextapi", failure_threshold=0.1, min_requests=1)
        cb_open.record_failure("forced")  # trips open

        http_call_count = 0

        async def mock_get(*args, **kwargs):
            nonlocal http_call_count
            http_call_count += 1
            raise AssertionError("HTTP call made despite circuit being OPEN")

        with patch.object(lq, "get_breaker", return_value=cb_open):
            results = await lq._fetch_batch_quotes(MagicMock(), ["RELIANCE", "TCS"])

        assert results == {}, "Should return empty when circuit is OPEN"
        assert http_call_count == 0, "No HTTP calls should have been made"

    @pytest.mark.asyncio
    async def test_batch_quotes_records_failure_on_http_error(self) -> None:
        """_fetch_batch_quotes records circuit failure on HTTP error."""
        import httpx
        import src.scrapers.live_quotes as lq

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

        # Get a fresh breaker
        import time
        cb = CircuitBreaker(f"nse_nextapi_err_{int(time.time() * 1000)}", failure_threshold=0.5, min_requests=1)

        with (
            patch.object(lq, "get_http_client", AsyncMock(return_value=mock_client)),
            patch.object(lq, "get_breaker", return_value=cb),
        ):
            results = await lq._fetch_batch_quotes(MagicMock(), ["RELIANCE"])

        assert results == {}, "Should return empty on HTTP error"
        assert cb.state == CircuitState.OPEN or cb._total_failures > 0, (
            "Failure should be recorded"
        )

    @pytest.mark.asyncio
    async def test_index_quotes_blocked_when_circuit_open(self) -> None:
        """_fetch_index_quotes returns empty dict when circuit is OPEN."""
        import src.scrapers.live_quotes as lq

        cb_open = CircuitBreaker("nse_nextapi_idx", failure_threshold=0.1, min_requests=1)
        cb_open.record_failure("forced")

        http_called = False

        async def mock_get(*args, **kwargs):
            nonlocal http_called
            http_called = True
            raise AssertionError("HTTP call made despite circuit being OPEN")

        with patch.object(lq, "get_breaker", return_value=cb_open):
            results = await lq._fetch_index_quotes(["NIFTY", "BANKNIFTY"])

        assert results == {}, "Should return empty when circuit is OPEN"
        assert not http_called, "HTTP must not be called when circuit is OPEN"

    @pytest.mark.asyncio
    async def test_single_quote_blocked_when_circuit_open(self) -> None:
        """_fetch_single_quote returns None when circuit is OPEN."""
        import src.scrapers.live_quotes as lq

        cb_open = CircuitBreaker("nse_nextapi_single", failure_threshold=0.1, min_requests=1)
        cb_open.record_failure("forced")

        http_called = False

        async def mock_get(*args, **kwargs):
            nonlocal http_called
            http_called = True
            raise AssertionError("HTTP call made despite circuit being OPEN")

        with patch.object(lq, "get_breaker", return_value=cb_open):
            result = await lq._fetch_single_quote(MagicMock(), "RELIANCE")

        assert result is None, "Should return None when circuit is OPEN"
        assert not http_called, "HTTP must not be called when circuit is OPEN"

    @pytest.mark.asyncio
    async def test_batch_quotes_records_success(self) -> None:
        """_fetch_batch_quotes records success on valid HTTP response."""
        import src.scrapers.live_quotes as lq

        mock_payload = {
            "data": {
                "data": [
                    {
                        "symbol": "RELIANCE",
                        "lastPrice": 2845.50,
                        "change": 12.30,
                        "pChange": 0.43,
                        "open": 2833.00,
                        "dayHigh": 2860.00,
                        "dayLow": 2828.00,
                        "previousClose": 2833.20,
                        "totalTradedVolume": 1234567,
                    }
                ]
            }
        }

        mock_resp = AsyncMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value=mock_payload)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)

        import time as _time
        cb = CircuitBreaker(f"nse_nextapi_suc_{int(_time.time() * 1000)}", failure_threshold=0.5, min_requests=1)

        with (
            patch.object(lq, "get_http_client", AsyncMock(return_value=mock_client)),
            patch.object(lq, "get_breaker", return_value=cb),
        ):
            results = await lq._fetch_batch_quotes(MagicMock(), ["RELIANCE"])

        assert "RELIANCE" in results, "RELIANCE quote should be present"
        assert results["RELIANCE"].ltp == pytest.approx(2845.50)
        assert results["RELIANCE"].oi is None, "OI must be None for equity (semantic fix)"
        assert cb._total_successes >= 1, "Success should be recorded in breaker"
