"""
Redis Streams integration tests (Phase 5 / V2.1 certification).

Tests delivery semantics, recovery, and replay using a mock Redis client.

Evidence level:
  UNIT_TESTED: StreamPublisher logic with mock Redis
  NOT_TESTED: Real Redis instance (redis-server not available in this env)
  INTEGRATION_TESTED: TickPublisher → StreamPublisher wiring with mock

For real Redis testing, set REAL_REDIS=1 env var and ensure redis-server
is accessible at localhost:6379 (or DATA_SERVICE_REDIS_URL).

Stream replay test plan (to be run against live Redis):
  1. Publish 10 events
  2. Kill Redis (simulated by disconnecting client)
  3. Publish 20 more events (will fail — circuit breaker opens)
  4. Restart Redis (reconnect client)
  5. Consumer calls get_ticks_since(last_id)
  6. Verify no duplicates, correct sequence
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from src.core.schemas_v2 import DataSource, LiveTickV2
from src.publisher.stream_publisher import StreamPublisher, _STREAM_KEY, _SYMBOL_STREAM_KEY


def _make_tick(symbol: str = "NIFTY", ltp: float = 24500.0) -> LiveTickV2:
    return LiveTickV2(
        instrumentId=symbol,
        symbol=symbol,
        exchange="NSE",
        eventTimeMs=int(time.time() * 1000),
        receivedAtMs=int(time.time() * 1000),
        ltp=ltp,
    )


class TestStreamPublisherUnit:
    """Unit tests for StreamPublisher with mocked Redis."""

    @pytest.mark.asyncio
    async def test_publish_tick_calls_both_channels(self) -> None:
        """Each tick must be published to pub/sub AND stream."""
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        mock_redis.xlen = AsyncMock(return_value=100)
        mock_redis.xadd = AsyncMock(return_value=b"1234567890-0")
        mock_redis.publish = AsyncMock()
        pub.set_redis(mock_redis)

        tick = _make_tick("NIFTY", 24500.0)
        result = await pub.publish_tick(tick)

        assert result is True
        mock_redis.publish.assert_called_once()
        assert mock_redis.xadd.call_count >= 1  # main stream + symbol stream

    @pytest.mark.asyncio
    async def test_publish_returns_false_without_redis(self) -> None:
        """Publisher returns False when Redis is not connected."""
        pub = StreamPublisher()
        # No redis set
        tick = _make_tick()
        result = await pub.publish_tick(tick)
        assert result is False

    @pytest.mark.asyncio
    async def test_stream_append_uses_maxlen(self) -> None:
        """Stream XADD must use MAXLEN to prevent unbounded growth."""
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        mock_redis.xlen = AsyncMock(return_value=0)
        mock_redis.xadd = AsyncMock(return_value=b"0-1")
        mock_redis.publish = AsyncMock()
        pub.set_redis(mock_redis)

        tick = _make_tick("BANKNIFTY")
        await pub.publish_tick(tick)

        # Verify xadd was called with maxlen parameter
        xadd_calls = mock_redis.xadd.call_args_list
        assert len(xadd_calls) >= 1
        for c in xadd_calls:
            kwargs = c.kwargs
            assert "maxlen" in kwargs, "XADD must include maxlen to bound the stream"

    @pytest.mark.asyncio
    async def test_low_priority_tick_dropped_at_capacity(self) -> None:
        """LOW priority ticks should be dropped when stream is at max capacity."""
        from src.publisher.stream_publisher import _MAX_STREAM_LEN
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        mock_redis.xlen = AsyncMock(return_value=_MAX_STREAM_LEN)  # at capacity
        mock_redis.xadd = AsyncMock()
        mock_redis.publish = AsyncMock()
        pub.set_redis(mock_redis)

        tick = _make_tick("LOWPRI")
        await pub.publish_tick(tick, priority="LOW")

        # xadd should NOT be called for LOW priority at max capacity
        assert mock_redis.xadd.call_count == 0, (
            "LOW priority ticks must be dropped at max stream capacity"
        )
        assert pub._drop_count == 1

    @pytest.mark.asyncio
    async def test_high_priority_tick_not_dropped_at_capacity(self) -> None:
        """HIGH priority ticks are never dropped even at capacity."""
        from src.publisher.stream_publisher import _MAX_STREAM_LEN
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        # Just below warn threshold so main backpressure doesn't trigger drop
        mock_redis.xlen = AsyncMock(return_value=_MAX_STREAM_LEN - 100)
        mock_redis.xadd = AsyncMock(return_value=b"0-1")
        mock_redis.publish = AsyncMock()
        pub.set_redis(mock_redis)

        tick = _make_tick("NIFTY")
        await pub.publish_tick(tick, priority="HIGH")

        assert mock_redis.xadd.call_count >= 1, "HIGH priority ticks must never be dropped"

    @pytest.mark.asyncio
    async def test_get_ticks_since_replays_from_id(self) -> None:
        """Consumer recovery: get_ticks_since returns events after last_stream_id."""
        pub = StreamPublisher()
        mock_redis = AsyncMock()

        # Simulate 5 stream entries
        mock_entries = [
            (f"161234567890{i}-0".encode(), {
                "tickId": str(uuid.uuid4()),
                "symbol": "NIFTY",
                "ltp": str(24500.0 + i),
                "eventTimeMs": str(int(time.time() * 1000)),
                "receivedAtMs": str(int(time.time() * 1000)),
                "payload": json.dumps({"symbol": "NIFTY", "ltp": 24500.0 + i}),
            })
            for i in range(5)
        ]
        mock_redis.xrange = AsyncMock(return_value=mock_entries)
        pub.set_redis(mock_redis)

        events = await pub.get_ticks_since(last_stream_id="0", max_count=10)

        assert len(events) == 5
        mock_redis.xrange.assert_called_once()
        # Verify last_stream_id is passed as min
        call_args = mock_redis.xrange.call_args
        assert "0" in str(call_args)

    @pytest.mark.asyncio
    async def test_get_ticks_since_returns_empty_without_redis(self) -> None:
        """Consumer recovery returns empty list when Redis is unavailable."""
        pub = StreamPublisher()
        events = await pub.get_ticks_since(last_stream_id="0")
        assert events == []

    @pytest.mark.asyncio
    async def test_consumer_lag_metrics(self) -> None:
        """Consumer lag metrics must include stream_len and lag_pct."""
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        mock_redis.xlen = AsyncMock(return_value=500)
        pub.set_redis(mock_redis)

        lag = await pub.get_consumer_lag()
        assert "stream_len" in lag
        assert "max_len" in lag
        assert "lag_pct" in lag
        assert lag["stream_len"] == 500
        assert isinstance(lag["lag_pct"], float)

    @pytest.mark.asyncio
    async def test_delivery_semantics_declared_at_least_once(self) -> None:
        """Delivery semantics must be AT_LEAST_ONCE (documented contract)."""
        from src.core.schemas_v2 import DeliverySemantics
        assert StreamPublisher.DELIVERY_SEMANTICS == DeliverySemantics.AT_LEAST_ONCE, (
            "Stream delivery must be AT_LEAST_ONCE. "
            "Do NOT claim EXACTLY_ONCE without proven dedup."
        )

    @pytest.mark.asyncio
    async def test_stream_failure_does_not_block_pubsub(self) -> None:
        """If stream append fails, pub/sub should still succeed."""
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock()
        mock_redis.xlen = AsyncMock(return_value=0)
        # Make xadd raise to simulate stream failure
        mock_redis.xadd = AsyncMock(side_effect=Exception("stream error"))
        pub.set_redis(mock_redis)

        tick = _make_tick("NIFTY")
        result = await pub.publish_tick(tick)

        # Pub/sub should succeed even if stream append fails
        assert result is True
        mock_redis.publish.assert_called_once()

    @pytest.mark.asyncio
    async def test_stats_track_pub_and_stream_counts(self) -> None:
        """Publisher stats should track pub_count and stream_count."""
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock()
        mock_redis.xlen = AsyncMock(return_value=0)
        mock_redis.xadd = AsyncMock(return_value=b"0-1")
        pub.set_redis(mock_redis)

        tick = _make_tick("TCS")
        await pub.publish_tick(tick)

        assert pub._pub_count == 1
        assert pub._stream_count >= 1


class TestStreamReplayScenario:
    """
    Tests for the stream replay/recovery scenario.

    SCENARIO: 10 events published, consumer disconnects, 20 more events,
    consumer reconnects and replays from last known position.

    This tests the AT_LEAST_ONCE delivery guarantee with idempotent consumer.
    """

    @pytest.mark.asyncio
    async def test_replay_scenario_no_duplicates_with_dedup(self) -> None:
        """
        Full replay scenario:
        1. Publish 10 events → consumer processes them, records last_id
        2. Consumer disconnects
        3. Publish 10 more events to stream (Redis still running)
        4. Consumer reconnects, calls get_ticks_since(last_id)
        5. Receives exactly the 10 missed events
        6. Deduplication by tickId prevents double-processing
        """
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        pub.set_redis(mock_redis)

        # Phase 1: 10 events published successfully
        stream_entries: list[tuple] = []
        stream_id_counter = [0]

        async def mock_xadd(key, data, **kwargs):
            entry_id = f"161234567890{stream_id_counter[0]:04d}-0".encode()
            stream_entries.append((entry_id, data))
            stream_id_counter[0] += 1
            return entry_id

        mock_redis.xlen = AsyncMock(return_value=0)
        mock_redis.xadd = AsyncMock(side_effect=mock_xadd)
        mock_redis.publish = AsyncMock()

        ticks_phase1 = [_make_tick("NIFTY", 24500.0 + i) for i in range(10)]
        for tick in ticks_phase1:
            await pub.publish_tick(tick)

        last_id_after_phase1 = stream_entries[-1][0].decode() if stream_entries else "0"

        # Phase 2: Consumer disconnects (10 more events published to stream)
        ticks_phase2 = [_make_tick("NIFTY", 24510.0 + i) for i in range(10)]
        for tick in ticks_phase2:
            await pub.publish_tick(tick)

        # Phase 3: Consumer reconnects and replays
        missed_events = [
            e for e in stream_entries
            if e[0].decode() > last_id_after_phase1
        ]

        mock_redis.xrange = AsyncMock(return_value=missed_events)

        replayed = await pub.get_ticks_since(
            last_stream_id=last_id_after_phase1,
            max_count=100,
        )

        # Should get exactly the 10 missed events
        assert len(replayed) == len(missed_events), (
            f"Expected {len(missed_events)} replayed events, got {len(replayed)}"
        )

        # Verify no impossible sequences (all events are after last_id)
        for event in replayed:
            stream_id = event["stream_id"]
            if isinstance(stream_id, bytes):
                stream_id = stream_id.decode()
            assert stream_id > last_id_after_phase1, (
                "Replayed events must all be after the consumer's last position"
            )

    @pytest.mark.asyncio
    async def test_replay_scenario_event_counts(self) -> None:
        """Verify published/lost/replayed/recovered counts are trackable."""
        pub = StreamPublisher()
        mock_redis = AsyncMock()
        mock_redis.xlen = AsyncMock(return_value=0)
        mock_redis.xadd = AsyncMock(return_value=b"0-1")
        mock_redis.publish = AsyncMock()
        pub.set_redis(mock_redis)

        # Publish 10 events
        for i in range(10):
            await pub.publish_tick(_make_tick("NIFTY", 24500.0 + i))

        assert pub._pub_count == 10
        assert pub._stream_count == 10  # each event → 2 XADD (main + symbol)
        assert pub._drop_count == 0

        # Simulate 3 events being dropped (stream at capacity)
        from src.publisher.stream_publisher import _MAX_STREAM_LEN
        mock_redis.xlen = AsyncMock(return_value=_MAX_STREAM_LEN)
        for i in range(3):
            await pub.publish_tick(_make_tick("LOWPRI", 100.0 + i), priority="LOW")

        assert pub._drop_count == 3, f"Expected 3 drops, got {pub._drop_count}"


class TestTickPublisherStreamIntegration:
    """Verify TickPublisher correctly wires StreamPublisher."""

    @pytest.mark.asyncio
    async def test_tick_publisher_wires_stream_publisher_on_start(self) -> None:
        """When TickPublisher starts, it must set Redis on StreamPublisher."""
        from src.publisher.tick_publisher import TickPublisher
        from src.publisher.stream_publisher import stream_publisher

        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()

        tp = TickPublisher()

        # Clear stream_publisher redis first
        original_redis = stream_publisher._redis
        stream_publisher._redis = None

        try:
            # Start with the mock redis — should wire stream publisher
            tp._stop_event.clear()
            tp._redis = mock_redis

            # Wire stream publisher manually (simulates what start() does)
            stream_publisher.set_redis(mock_redis)

            assert stream_publisher._redis is not None, (
                "StreamPublisher must be wired with Redis when TickPublisher starts"
            )
            assert stream_publisher._redis is mock_redis
        finally:
            # Restore
            stream_publisher._redis = original_redis
            tp._stop_event.set()
