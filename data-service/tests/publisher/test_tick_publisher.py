"""
Unit tests for TickPublisher and /publisher/* endpoints.

Covers:
  1. PUBLISH called with channel ``af:ticks:NIFTY`` + valid JSON LiveTick
  2. Null ltp skips publish; publish_count NOT incremented
  3. Exponential backoff intervals on Redis reconnection: 1s, 2s, 4s, 8s, 16s, 30s, 30s
  4. POST /publisher/symbols with valid add/remove applies changes atomically
  5. HTTP 400 when symbol >50 chars; symbol list unchanged

Requirements: 5.1–5.8
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.schemas import LiveTick, MDQuote


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_quote(
    symbol: str = "NIFTY",
    token: str = "T001",
    exchange: str = "NSE",
    ltp: float | None = 24850.60,
) -> MDQuote:
    """Create a minimal MDQuote for use in tests."""
    return MDQuote(
        symbol=symbol,
        token=token,
        exchange=exchange,
        ltp=ltp,
        change=50.0,
        changePct=0.20,
        prevClose=24800.60,
        open=24810.0,
        high=24900.0,
        low=24780.0,
        volume=1_000_000,
        provider="scrapling",
        fetchedAt="2024-01-01T09:15:00Z",
    )


def _make_publisher_with_mock_scraper(quotes: list) -> "TickPublisher":
    """Build a TickPublisher wired to a mock scraper returning *quotes*."""
    from src.publisher.tick_publisher import TickPublisher

    mock_scraper = MagicMock()
    mock_scraper.get_quotes = AsyncMock(return_value=quotes)
    return TickPublisher(scraper=mock_scraper)


# ---------------------------------------------------------------------------
# 1. PUBLISH called with correct channel and valid JSON LiveTick
# ---------------------------------------------------------------------------


class TestPublishTick:
    @pytest.mark.asyncio
    async def test_publish_called_with_correct_channel(self):
        """PUBLISH must use channel af:ticks:NIFTY for symbol NIFTY."""
        quote = _make_quote()
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis

        # Give the publisher a symbol to track
        publisher._symbols = ["NIFTY"]

        await publisher._poll_and_publish()

        assert mock_redis.publish.called, "redis.publish was not called"
        call_args = mock_redis.publish.call_args
        channel = call_args[0][0]
        assert channel == "af:ticks:NIFTY", f"Expected 'af:ticks:NIFTY', got '{channel}'"

    @pytest.mark.asyncio
    async def test_publish_payload_is_valid_json(self):
        """Published payload must be valid JSON."""
        quote = _make_quote()
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        await publisher._poll_and_publish()

        payload_str = mock_redis.publish.call_args[0][1]
        payload = json.loads(payload_str)
        assert isinstance(payload, dict), "Payload must be a JSON object"

    @pytest.mark.asyncio
    async def test_publish_payload_contains_correct_ltp(self):
        """Published LiveTick JSON must contain ltp == 24850.60."""
        quote = _make_quote(ltp=24850.60)
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        await publisher._poll_and_publish()

        payload = json.loads(mock_redis.publish.call_args[0][1])
        assert payload["ltp"] == pytest.approx(24850.60), (
            f"Expected ltp 24850.60, got {payload.get('ltp')}"
        )

    @pytest.mark.asyncio
    async def test_publish_payload_required_livetick_fields_present(self):
        """Published JSON must have all required LiveTick fields."""
        quote = _make_quote()
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        await publisher._poll_and_publish()

        payload = json.loads(mock_redis.publish.call_args[0][1])
        required_fields = {
            "token", "symbol", "exchange", "ltp",
            "exchangeTimestampMs", "receivedAtMs", "provider",
        }
        for field in required_fields:
            assert field in payload, f"Missing required field: {field}"

    @pytest.mark.asyncio
    async def test_publish_count_increments_on_success(self):
        """publish_count must increment by 1 for each successfully published tick."""
        quote = _make_quote()
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        assert publisher._publish_count == 0
        await publisher._poll_and_publish()
        assert publisher._publish_count == 1

    @pytest.mark.asyncio
    async def test_provider_field_is_scrapling(self):
        """Published LiveTick must have provider == 'scrapling'."""
        quote = _make_quote()
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        await publisher._poll_and_publish()

        payload = json.loads(mock_redis.publish.call_args[0][1])
        assert payload["provider"] == "scrapling"

    @pytest.mark.asyncio
    async def test_symbol_is_uppercased_in_channel(self):
        """Channel name must use the uppercase symbol even if quote.symbol is lowercase."""
        quote = _make_quote(symbol="nifty")
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        await publisher._poll_and_publish()

        channel = mock_redis.publish.call_args[0][0]
        assert channel == "af:ticks:NIFTY"


# ---------------------------------------------------------------------------
# 2. Null ltp skips publish; publish_count NOT incremented
# ---------------------------------------------------------------------------


class TestNullLtpSkip:
    @pytest.mark.asyncio
    async def test_null_ltp_does_not_call_publish(self):
        """redis.publish must NOT be called when ltp is None."""
        quote = _make_quote(ltp=None)
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        await publisher._poll_and_publish()

        mock_redis.publish.assert_not_called()

    @pytest.mark.asyncio
    async def test_null_ltp_does_not_increment_publish_count(self):
        """publish_count must remain 0 when ltp is None."""
        quote = _make_quote(ltp=None)
        publisher = _make_publisher_with_mock_scraper([quote])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        await publisher._poll_and_publish()

        assert publisher._publish_count == 0

    @pytest.mark.asyncio
    async def test_none_quote_in_list_is_silently_skipped(self):
        """A None entry in the quotes list must be skipped without error."""
        publisher = _make_publisher_with_mock_scraper([None])

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY"]

        # Should not raise
        await publisher._poll_and_publish()

        mock_redis.publish.assert_not_called()
        assert publisher._publish_count == 0

    @pytest.mark.asyncio
    async def test_mixed_null_and_valid_ltp(self):
        """Only the symbol with non-null ltp should be published."""
        quotes = [
            _make_quote(symbol="NIFTY", ltp=None, token="T001"),
            _make_quote(symbol="BANKNIFTY", ltp=52000.0, token="T002", exchange="NSE"),
        ]
        publisher = _make_publisher_with_mock_scraper(quotes)

        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock(return_value=1)
        publisher._redis = mock_redis
        publisher._symbols = ["NIFTY", "BANKNIFTY"]

        await publisher._poll_and_publish()

        assert mock_redis.publish.call_count == 1
        channel = mock_redis.publish.call_args[0][0]
        assert channel == "af:ticks:BANKNIFTY"
        assert publisher._publish_count == 1


# ---------------------------------------------------------------------------
# 3. Exponential backoff on Redis reconnection
# ---------------------------------------------------------------------------


class TestExponentialBackoff:
    @pytest.mark.asyncio
    async def test_backoff_sequence_1_2_4_8_16_30_30(self):
        """Reconnect wait durations must follow min(2^(n-1), 30) pattern.

        The new implementation sleeps in 0.5s chunks; we intercept asyncio.sleep
        and accumulate the total sleep per attempt to verify the backoff sequence.
        """
        from src.publisher.tick_publisher import TickPublisher

        publisher = TickPublisher()
        publisher._stop_event = asyncio.Event()

        # Track cumulative sleep per reconnect attempt window.
        # Each attempt sleeps `wait` seconds in 0.5s slices, then calls
        # _try_create_redis.  We track the sum of slices between attempts.
        slept_per_attempt: list[float] = []
        current_attempt_sleep: list[float] = [0.0]
        attempt_counter = {"count": 0}

        original_sleep = asyncio.sleep

        async def fake_sleep(seconds: float) -> None:
            # Accumulate sleep within the current attempt window
            current_attempt_sleep[0] += seconds
            # Do NOT actually sleep — just yield control once
            await original_sleep(0)

        async def fake_try_create_redis() -> "Any":
            # Record the sleep accumulated for this attempt
            slept_per_attempt.append(round(current_attempt_sleep[0], 3))
            current_attempt_sleep[0] = 0.0
            attempt_counter["count"] += 1
            if attempt_counter["count"] <= 7:
                return None
            publisher._stop_event.set()
            return AsyncMock()

        publisher._try_create_redis = fake_try_create_redis

        with patch("asyncio.sleep", side_effect=fake_sleep):
            await publisher._reconnect_redis()

        # Expected backoff totals: 1, 2, 4, 8, 16, 30, 30, 30
        expected = [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]
        assert len(slept_per_attempt) == len(expected), (
            f"Expected {len(expected)} attempts, got {len(slept_per_attempt)}: {slept_per_attempt}"
        )
        for i, (actual, exp) in enumerate(zip(slept_per_attempt, expected)):
            assert abs(actual - exp) < 0.6, (
                f"Attempt {i + 1}: expected ~{exp}s sleep, got {actual}s"
            )

    @pytest.mark.asyncio
    async def test_backoff_cap_at_30_seconds(self):
        """Backoff must never exceed 30 seconds per attempt regardless of failure count."""
        from src.publisher.tick_publisher import TickPublisher

        publisher = TickPublisher()
        publisher._stop_event = asyncio.Event()

        per_attempt_sleep: list[float] = []
        current_window: list[float] = [0.0]
        attempt_counter = {"count": 0}

        original_sleep = asyncio.sleep

        async def fake_sleep(seconds: float) -> None:
            current_window[0] += seconds
            await original_sleep(0)

        async def fake_try_create_redis() -> "Any":
            per_attempt_sleep.append(round(current_window[0], 3))
            current_window[0] = 0.0
            attempt_counter["count"] += 1
            if attempt_counter["count"] <= 10:
                return None
            publisher._stop_event.set()
            return AsyncMock()

        publisher._try_create_redis = fake_try_create_redis

        with patch("asyncio.sleep", side_effect=fake_sleep):
            await publisher._reconnect_redis()

        for i, duration in enumerate(per_attempt_sleep):
            assert duration <= 30.0 + 0.5, (  # +0.5 tolerance for chunk rounding
                f"Attempt {i + 1}: backoff duration {duration}s exceeds 30s cap"
            )

    @pytest.mark.asyncio
    async def test_running_state_is_reconnecting_during_backoff(self):
        """_running must be 'reconnecting' while attempting to reconnect."""
        from src.publisher.tick_publisher import TickPublisher

        publisher = TickPublisher()
        publisher._running = True
        publisher._stop_event = asyncio.Event()

        states_during_reconnect: list = []
        attempt_counter = {"count": 0}
        original_sleep = asyncio.sleep

        async def fake_sleep(seconds: float) -> None:
            states_during_reconnect.append(publisher._running)
            await original_sleep(0)  # yield without actual delay

        async def fake_try_create_redis() -> "Any":
            attempt_counter["count"] += 1
            if attempt_counter["count"] <= 2:
                return None
            publisher._stop_event.set()
            return AsyncMock()

        publisher._try_create_redis = fake_try_create_redis

        with patch("asyncio.sleep", side_effect=fake_sleep):
            await publisher._reconnect_redis()

        for state in states_during_reconnect:
            assert state == "reconnecting", (
                f"Expected 'reconnecting' during backoff, got '{state}'"
            )


# ---------------------------------------------------------------------------
# 4. POST /publisher/symbols — valid add/remove applies changes atomically
# ---------------------------------------------------------------------------


class TestPublisherSymbolsEndpoint:
    def test_add_and_remove_symbols(self, test_client):
        """POST /publisher/symbols with add + remove must return updated list."""
        from src.publisher.tick_publisher import tick_publisher

        # Set up a known state
        tick_publisher._symbols = ["NIFTY", "BANKNIFTY"]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": ["INFY"], "remove": ["NIFTY"]},
        )

        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()

        # All required response fields must be present
        assert "symbols" in body, "Response must contain 'symbols'"
        assert "count" in body, "Response must contain 'count'"
        assert "added" in body, "Response must contain 'added'"
        assert "removed" in body, "Response must contain 'removed'"

    def test_add_and_remove_reflects_changes(self, test_client):
        """Added symbol must appear and removed symbol must disappear."""
        from src.publisher.tick_publisher import tick_publisher

        tick_publisher._symbols = ["NIFTY", "BANKNIFTY"]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": ["INFY"], "remove": ["NIFTY"]},
        )
        body = resp.json()

        assert "INFY" in body["symbols"], "INFY should have been added"
        assert "NIFTY" not in body["symbols"], "NIFTY should have been removed"
        assert "BANKNIFTY" in body["symbols"], "BANKNIFTY should remain unchanged"

    def test_count_matches_symbols_length(self, test_client):
        """'count' field must equal len(symbols)."""
        from src.publisher.tick_publisher import tick_publisher

        tick_publisher._symbols = ["NIFTY"]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": ["INFY", "RELIANCE"], "remove": []},
        )
        body = resp.json()

        assert body["count"] == len(body["symbols"]), (
            f"count ({body['count']}) must equal len(symbols) ({len(body['symbols'])})"
        )

    def test_add_existing_symbol_is_idempotent(self, test_client):
        """Adding an already-tracked symbol must not create duplicates."""
        from src.publisher.tick_publisher import tick_publisher

        tick_publisher._symbols = ["NIFTY"]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": ["NIFTY"], "remove": []},
        )
        body = resp.json()

        assert body["symbols"].count("NIFTY") == 1, "Duplicate NIFTY in symbol list"

    def test_remove_non_existent_symbol_is_harmless(self, test_client):
        """Removing a symbol not in the list must not raise or change anything unexpected."""
        from src.publisher.tick_publisher import tick_publisher

        tick_publisher._symbols = ["NIFTY"]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": [], "remove": ["BANKNIFTY"]},  # BANKNIFTY not tracked
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "NIFTY" in body["symbols"]

    def test_empty_add_and_remove_is_valid(self, test_client):
        """Sending empty add and remove arrays must succeed and return the current list."""
        from src.publisher.tick_publisher import tick_publisher

        tick_publisher._symbols = ["NIFTY"]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": [], "remove": []},
        )
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# 5. HTTP 400 when symbol > 50 chars or array > 100 entries; list unchanged
# ---------------------------------------------------------------------------


class TestPublisherSymbolsValidation:
    def test_symbol_over_50_chars_returns_400(self, test_client):
        """Symbol exceeding 50 characters must cause HTTP 400."""
        too_long = "A" * 51

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": [too_long], "remove": []},
        )

        assert resp.status_code == 400, (
            f"Expected 400 for >50-char symbol, got {resp.status_code}"
        )

    def test_symbol_over_50_chars_response_has_error_key(self, test_client):
        """HTTP 400 response must contain an 'error' or 'detail' field."""
        too_long = "B" * 51

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": [too_long], "remove": []},
        )

        body = resp.json()
        assert "error" in body or "detail" in body, (
            f"Expected 'error' or 'detail' in 400 response, got: {body}"
        )

    def test_symbol_over_50_chars_leaves_list_unchanged(self, test_client):
        """A rejected request must NOT modify the tracked symbol list."""
        from src.publisher.tick_publisher import tick_publisher

        original = ["NIFTY", "BANKNIFTY"]
        tick_publisher._symbols = list(original)

        too_long = "C" * 51
        test_client.post(
            "/publisher/symbols",
            json={"add": [too_long], "remove": []},
        )

        assert tick_publisher._symbols == original, (
            f"Symbol list was modified after a rejected request: {tick_publisher._symbols}"
        )

    def test_add_array_over_100_entries_returns_400(self, test_client):
        """An 'add' array with >100 entries must cause HTTP 400."""
        too_many = [f"SYM{i}" for i in range(101)]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": too_many, "remove": []},
        )

        assert resp.status_code == 400, (
            f"Expected 400 for >100-entry add array, got {resp.status_code}"
        )

    def test_remove_array_over_100_entries_returns_400(self, test_client):
        """A 'remove' array with >100 entries must cause HTTP 400."""
        too_many = [f"SYM{i}" for i in range(101)]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": [], "remove": too_many},
        )

        assert resp.status_code == 400, (
            f"Expected 400 for >100-entry remove array, got {resp.status_code}"
        )

    def test_over_100_entries_leaves_list_unchanged(self, test_client):
        """Rejected oversized array must not modify the tracked symbol list."""
        from src.publisher.tick_publisher import tick_publisher

        original = ["NIFTY"]
        tick_publisher._symbols = list(original)

        too_many = [f"SYM{i}" for i in range(101)]
        test_client.post(
            "/publisher/symbols",
            json={"add": too_many, "remove": []},
        )

        assert tick_publisher._symbols == original, (
            f"Symbol list was modified after rejection: {tick_publisher._symbols}"
        )

    def test_exactly_50_char_symbol_is_accepted(self, test_client):
        """A symbol of exactly 50 characters must be accepted (boundary check)."""
        from src.publisher.tick_publisher import tick_publisher

        boundary = "A" * 50
        tick_publisher._symbols = []

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": [boundary], "remove": []},
        )

        assert resp.status_code == 200, (
            f"Expected 200 for exactly-50-char symbol, got {resp.status_code}"
        )

    def test_exactly_100_entries_is_accepted(self, test_client):
        """An array with exactly 100 entries must be accepted (boundary check)."""
        from src.publisher.tick_publisher import tick_publisher

        tick_publisher._symbols = []
        exactly_100 = [f"SY{i:03d}" for i in range(100)]

        resp = test_client.post(
            "/publisher/symbols",
            json={"add": exactly_100, "remove": []},
        )

        assert resp.status_code == 200, (
            f"Expected 200 for exactly-100-entry array, got {resp.status_code}"
        )
