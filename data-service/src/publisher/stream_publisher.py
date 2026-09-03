"""
Redis Streams publisher — Phase 22-24.

Provides durable, recoverable tick delivery using Redis Streams (XADD/XREAD)
in addition to the existing pub/sub channel (af:ticks:{symbol}).

Architecture
------------
Each tick is published to BOTH:
  1. Redis Pub/Sub channel ``af:ticks:{symbol}``    (real-time, lossy)
  2. Redis Stream ``af:stream:ticks``               (durable, bounded)

Consumers can reconnect, detect their last sequence, and replay
missing events from the stream before resuming the pub/sub feed.

Stream retention
----------------
The stream is capped at ``MAX_STREAM_LEN`` entries (MAXLEN ~10000).
This gives ~14 minutes of recovery window at 5s polling × 20 symbols.

Backpressure
------------
Publishes are tracked against a lag counter. If the stream grows beyond
``BACKPRESSURE_WARN_LEN`` a warning is emitted. High-priority ticks
(indices, active positions) are never dropped.

Delivery semantics
------------------
Transport: AT_LEAST_ONCE (pub/sub may lose; stream is durable)
Consumer contract: IDEMPOTENT consumers required (tickId for dedup)

Phase 22 requirements:
  - consumer reconnect → detect last sequence → replay → resume
  - bounded retention (no infinite history)
  - publish to both channels atomically (best-effort)
"""

from __future__ import annotations

import json
import time
from typing import Any, Optional

import structlog

from src.core.schemas_v2 import DeliverySemantics, LiveTickV2

logger = structlog.get_logger(__name__)

# Stream config
_STREAM_KEY = "af:stream:ticks"
_MAX_STREAM_LEN = 10_000          # MAXLEN for XADD ~= prefix
_BACKPRESSURE_WARN_LEN = 8_000
_BACKPRESSURE_DROP_PRIORITY = "LOW"

# Per-symbol stream for fine-grained recovery
_SYMBOL_STREAM_KEY = "af:stream:ticks:{symbol}"
_SYMBOL_STREAM_MAX_LEN = 500  # per symbol


class StreamPublisher:
    """Publishes ticks to both Redis Pub/Sub and Redis Streams.

    Phase 22: Provides recovery path for consumers that reconnect.
    Phase 23: AT_LEAST_ONCE delivery with idempotent consumer support.
    Phase 24: Backpressure detection.
    """

    DELIVERY_SEMANTICS = DeliverySemantics.AT_LEAST_ONCE

    def __init__(self) -> None:
        self._redis: Any = None
        self._pub_count: int = 0
        self._stream_count: int = 0
        self._drop_count: int = 0
        self._backpressure_events: int = 0

    def set_redis(self, redis_client: Any) -> None:
        """Inject the Redis client."""
        self._redis = redis_client

    async def publish_tick(
        self,
        tick: LiveTickV2,
        priority: str = "NORMAL",  # HIGH, NORMAL, LOW
    ) -> bool:
        """Publish a tick to both pub/sub and stream.

        Returns True when the pub/sub publish succeeded.
        The stream publish is best-effort (failure does not block pub/sub).
        """
        if self._redis is None:
            return False

        channel = f"af:ticks:{tick.symbol.upper()}"
        payload = tick.model_dump_json()

        # 1. Pub/Sub publish (real-time, lossy)
        pub_ok = False
        try:
            await self._redis.publish(channel, payload)
            pub_ok = True
            self._pub_count += 1
        except Exception as exc:
            logger.warning("stream_pubsub_error", channel=channel, error=str(exc))

        # 2. Stream append (durable, bounded) — best effort
        await self._stream_append(tick, payload, priority)

        return pub_ok

    async def _stream_append(
        self,
        tick: LiveTickV2,
        payload: str,
        priority: str,
    ) -> None:
        """Append tick to Redis Stream with backpressure check."""
        if self._redis is None:
            return

        try:
            # Check stream length for backpressure
            stream_len = await self._redis.xlen(_STREAM_KEY)
            if stream_len >= _BACKPRESSURE_WARN_LEN:
                self._backpressure_events += 1
                logger.warning(
                    "stream_backpressure",
                    stream_len=stream_len,
                    max_len=_MAX_STREAM_LEN,
                    priority=priority,
                )
                # Drop low-priority ticks under backpressure
                if priority == "LOW" and stream_len >= _MAX_STREAM_LEN:
                    self._drop_count += 1
                    logger.warning(
                        "stream_tick_dropped",
                        symbol=tick.symbol,
                        priority=priority,
                    )
                    return

            # XADD with MAXLEN trim (~ prefix for efficiency)
            stream_entry = {
                "tickId": tick.tickId,
                "instrumentId": tick.instrumentId,
                "symbol": tick.symbol,
                "ltp": str(tick.ltp),
                "eventTimeMs": str(tick.eventTimeMs),
                "receivedAtMs": str(tick.receivedAtMs),
                "payload": payload,
            }
            await self._redis.xadd(
                _STREAM_KEY,
                stream_entry,
                maxlen=_MAX_STREAM_LEN,
                approximate=True,
            )
            self._stream_count += 1

            # Also append to per-symbol stream for fine-grained replay
            symbol_key = _SYMBOL_STREAM_KEY.format(symbol=tick.symbol.upper())
            await self._redis.xadd(
                symbol_key,
                stream_entry,
                maxlen=_SYMBOL_STREAM_MAX_LEN,
                approximate=True,
            )

        except Exception as exc:
            logger.warning("stream_append_error", error=str(exc))

    async def get_ticks_since(
        self,
        last_stream_id: str = "0",
        max_count: int = 100,
        symbol: Optional[str] = None,
    ) -> list[dict]:
        """Replay ticks since a given stream ID for consumer recovery.

        Phase 22: consumer reconnect → detect last sequence → replay missing.

        Args:
            last_stream_id: Redis stream ID ('0' = from beginning, '$' = new only)
            max_count: Maximum entries to return
            symbol: If specified, reads from per-symbol stream
        """
        if self._redis is None:
            return []

        try:
            key = (
                _SYMBOL_STREAM_KEY.format(symbol=symbol.upper())
                if symbol
                else _STREAM_KEY
            )
            entries = await self._redis.xrange(key, min=last_stream_id, count=max_count)
            return [
                {"stream_id": entry_id, **{k: v for k, v in fields.items()}}
                for entry_id, fields in entries
            ]
        except Exception as exc:
            logger.warning("stream_replay_error", error=str(exc))
            return []

    async def get_consumer_lag(self) -> dict:
        """Return backpressure / lag metrics for the main stream."""
        if self._redis is None:
            return {"stream_len": 0, "max_len": _MAX_STREAM_LEN, "lag_pct": 0.0}

        try:
            stream_len = await self._redis.xlen(_STREAM_KEY)
            lag_pct = (stream_len / _MAX_STREAM_LEN) * 100
            status = "OK"
            if stream_len >= _BACKPRESSURE_WARN_LEN:
                status = "WARN"
            if stream_len >= _MAX_STREAM_LEN:
                status = "CRITICAL"
            return {
                "stream_len": stream_len,
                "max_len": _MAX_STREAM_LEN,
                "warn_len": _BACKPRESSURE_WARN_LEN,
                "lag_pct": round(lag_pct, 2),
                "status": status,
            }
        except Exception as exc:
            logger.warning("stream_lag_check_error", error=str(exc))
            return {"stream_len": -1, "error": str(exc)}

    @property
    def stats(self) -> dict:
        return {
            "pub_count": self._pub_count,
            "stream_count": self._stream_count,
            "drop_count": self._drop_count,
            "backpressure_events": self._backpressure_events,
            "delivery_semantics": self.DELIVERY_SEMANTICS.value,
        }


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

stream_publisher = StreamPublisher()
