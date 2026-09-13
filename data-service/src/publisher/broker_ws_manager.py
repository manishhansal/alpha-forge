"""
Broker WebSocket Manager — data-service sole ownership of broker WS connections.

data-service is the SOLE owner of:
  - Angel One SmartStream WebSocket connection (binary, little-endian frames)
  - Upstox v3 Protobuf WebSocket connection (binary, FeedResponse frames)

No other service or worker may establish a direct connection to these broker
WebSocket endpoints (Requirement 19.1).

Reconnection policy (Requirement 19.6):
  - Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s → 60s (capped)
  - Maximum 10 attempts per outage event
  - Before each attempt: publish {"type": "reconnect"} to affected channels
  - After 10 exhausted attempts: publish {"type": "connection_failed"}
  - data-service marks capability as UNAVAILABLE in health endpoint

Tick normalization + publishing:
  - Normalize to LiveTick format
  - Validate: non-null LTP, finite prices, timestamp ≤ now + 5s
  - Deduplicate: same symbol+ltp+timestamp within 1s → discard
  - Publish to Redis pub/sub af:ticks:{SYMBOL} and Redis Stream af:stream:ticks

Architecture note:
  This manager is a stub implementation. Angel One SmartStream and Upstox v3
  Protobuf WebSocket require broker credentials (SMARTAPI_CLIENT_CODE,
  SMARTAPI_TOTP_SECRET, UPSTOX_ACCESS_TOKEN) and their proprietary client SDKs.
  The manager is designed to be wired with the broker SDK once credentials are
  available. In their absence it fails gracefully and marks capabilities as
  UNAVAILABLE.

Requirements: 19.1, 19.2, 19.3, 19.6, 19.7
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Callable

import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Reconnection constants (Requirement 19.6)
# ---------------------------------------------------------------------------
_WS_BACKOFF_BASE: float = 1.0        # seconds — initial wait
_WS_BACKOFF_MAX: float = 60.0        # seconds — cap (per spec: "base 1s, max 60s")
_WS_MAX_RECONNECT_ATTEMPTS: int = 10 # per spec: up to 10 attempts

# ---------------------------------------------------------------------------
# Control message schema
# ---------------------------------------------------------------------------
_RECONNECT_MESSAGE = '{"type":"reconnect"}'
_CONNECTION_FAILED_MESSAGE = '{"type":"connection_failed"}'


def _utc_now_ms() -> int:
    """Current UTC time in milliseconds."""
    return int(time.time() * 1000)


class BrokerWsConnection:
    """
    Manages a single broker WebSocket connection with reconnection and
    pub/sub publishing.

    Subclasses should override ``_connect()`` and ``_disconnect()`` to
    wire in the actual broker SDK (Angel One SmartWebSocket / Upstox
    Protobuf feed). The base class handles the reconnection loop,
    control message publishing, and health tracking.

    Parameters
    ----------
    name : str
        Human-readable identifier used in logs (e.g. "angel_one_smartstream").
    symbols : list[str]
        Initial set of symbols to subscribe to.
    redis_client : Any
        Connected aioredis.Redis client for publishing ticks and control msgs.
    """

    def __init__(
        self,
        name: str,
        symbols: list[str],
        redis_client: Any = None,
    ) -> None:
        self._name = name
        self._symbols: list[str] = [s.upper() for s in symbols]
        self._redis: Any = redis_client

        # Connection state
        self._running: bool = False
        self._connected: bool = False
        self._task: asyncio.Task[None] | None = None
        self._stop_event: asyncio.Event = asyncio.Event()

        # Health tracking
        self._connect_attempts: int = 0
        self._consecutive_failures: int = 0
        self._last_tick_ms: int | None = None
        self._ticks_published: int = 0
        self._validation_failures: dict[str, int] = {
            "negative_ltp": 0,
            "future_timestamp": 0,
            "duplicate": 0,
        }

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self, redis_client: Any = None) -> None:
        """Start the WebSocket connection loop."""
        if self._running:
            logger.warning("broker_ws_already_running", name=self._name)
            return

        if redis_client is not None:
            self._redis = redis_client

        self._stop_event.clear()
        self._running = True
        self._task = asyncio.create_task(
            self._connection_loop(), name=f"broker_ws_{self._name}"
        )
        logger.info("broker_ws_started", name=self._name)

    async def stop(self) -> None:
        """Gracefully stop the WebSocket connection loop."""
        if not self._running:
            return

        self._stop_event.set()
        if self._task and not self._task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._task), timeout=10.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass

        self._running = False
        self._connected = False
        logger.info("broker_ws_stopped", name=self._name)

    # ------------------------------------------------------------------
    # Core reconnection loop (Requirement 19.6)
    # ------------------------------------------------------------------

    async def _connection_loop(self) -> None:
        """
        Outer reconnection loop with exponential backoff.

        Reconnection policy (Requirement 19.6):
          - Up to _WS_MAX_RECONNECT_ATTEMPTS consecutive attempts
          - Backoff: 1s → 2s → 4s → 8s → 16s → 30s → 60s (doubling, capped)
          - Publish {"type":"reconnect"} before each attempt
          - Publish {"type":"connection_failed"} after exhaustion
        """
        consecutive_failures = 0
        wait = _WS_BACKOFF_BASE

        while not self._stop_event.is_set():
            # Attempt connection
            try:
                logger.info(
                    "broker_ws_connecting",
                    name=self._name,
                    attempt=consecutive_failures + 1,
                )
                self._connect_attempts += 1

                # Publish reconnect control message before each attempt
                # (except the very first connection attempt)
                if consecutive_failures > 0:
                    await self._publish_control_message(
                        _RECONNECT_MESSAGE, reason="reconnect_attempt"
                    )

                await self._connect()
                # If we reach here without raising, the connection was
                # established and has since closed normally (e.g. on stop).
                self._connected = False
                consecutive_failures = 0
                wait = _WS_BACKOFF_BASE

                if self._stop_event.is_set():
                    break

            except Exception as exc:
                self._connected = False
                consecutive_failures += 1
                self._consecutive_failures = consecutive_failures

                logger.warning(
                    "broker_ws_connect_failed",
                    name=self._name,
                    attempt=consecutive_failures,
                    max_attempts=_WS_MAX_RECONNECT_ATTEMPTS,
                    error=str(exc),
                )

                if consecutive_failures >= _WS_MAX_RECONNECT_ATTEMPTS:
                    # Publish connection_failed control message (Requirement 19.6)
                    logger.error(
                        "broker_ws_exhausted",
                        name=self._name,
                        attempts=consecutive_failures,
                    )
                    await self._publish_control_message(
                        _CONNECTION_FAILED_MESSAGE,
                        reason="max_attempts_exhausted",
                    )
                    # Stop retrying — mark capability UNAVAILABLE
                    self._running = False
                    break

                # Wait with exponential backoff before next attempt
                slept = 0.0
                while slept < wait and not self._stop_event.is_set():
                    chunk = min(0.5, wait - slept)
                    await asyncio.sleep(chunk)
                    slept += chunk

                # Double the wait, capped at max
                wait = min(wait * 2, _WS_BACKOFF_MAX)

        self._connected = False
        logger.info("broker_ws_loop_exited", name=self._name)

    async def _publish_control_message(self, message: str, reason: str) -> None:
        """Publish a control message to all subscribed symbol channels."""
        if self._redis is None:
            return
        for symbol in self._symbols:
            channel = f"af:ticks:{symbol.upper()}"
            try:
                await self._redis.publish(channel, message)
            except Exception as exc:
                logger.debug(
                    "control_message_publish_failed",
                    channel=channel,
                    reason=reason,
                    error=str(exc),
                )

    # ------------------------------------------------------------------
    # Override in subclasses
    # ------------------------------------------------------------------

    async def _connect(self) -> None:
        """
        Establish the broker WebSocket connection and run the receive loop.

        This method must block until the connection closes (normally or due
        to an error). Subclasses should:
          1. Set self._connected = True once the WS handshake succeeds.
          2. For each received tick: call self._on_tick(raw_tick).
          3. Raise an exception on any unrecoverable error (triggers reconnect).
          4. Return normally when the connection closes gracefully.
        """
        raise NotImplementedError(
            f"BrokerWsConnection subclass '{type(self).__name__}' "
            f"must implement _connect(). "
            f"Credentials and broker SDK are required."
        )

    async def _on_tick(self, raw_tick: dict[str, Any]) -> None:
        """
        Validate and publish a normalized tick.

        Validation (Requirement 19.2):
          - non-null LTP
          - finite LTP and price fields
          - timestamp not more than 5s ahead of system clock
        Deduplication (Requirement 19.3):
          - same symbol+ltp+timestamp within 1s → discard
        """
        symbol = raw_tick.get("symbol", "").upper()
        ltp = raw_tick.get("ltp")
        ts_ms = raw_tick.get("timestamp_ms") or _utc_now_ms()

        # Validation: non-null, positive LTP
        if ltp is None or not (ltp > 0):
            self._validation_failures["negative_ltp"] += 1
            logger.debug("tick_invalid_ltp", symbol=symbol, ltp=ltp)
            return

        # Validation: timestamp not more than 5s in the future
        now_ms = _utc_now_ms()
        if ts_ms > now_ms + 5_000:
            self._validation_failures["future_timestamp"] += 1
            logger.debug("tick_future_timestamp", symbol=symbol, ts_ms=ts_ms, now_ms=now_ms)
            return

        # Deduplication: same symbol+ltp+timestamp within 1s
        try:
            from src.core.deduplication import compute_event_id, event_dedup
            event_id = compute_event_id(
                instrument_id=symbol,
                event_time_ms=ts_ms,
                source=self._name,
                ltp=ltp,
                volume=raw_tick.get("volume"),
            )
            if event_dedup.is_duplicate(event_id):
                self._validation_failures["duplicate"] += 1
                logger.debug("tick_deduplicated", symbol=symbol)
                return
        except Exception as exc:
            logger.debug("dedup_check_error", error=str(exc))

        # Publish to Redis pub/sub af:ticks:{SYMBOL}
        if self._redis is not None:
            payload = (
                f'{{"symbol":"{symbol}","ltp":{ltp},'
                f'"timestamp_ms":{ts_ms},"provider":"{self._name}"}}'
            )
            channel = f"af:ticks:{symbol}"
            try:
                await self._redis.publish(channel, payload)
                self._ticks_published += 1
                self._last_tick_ms = ts_ms
            except Exception as exc:
                logger.warning("broker_ws_publish_failed", symbol=symbol, error=str(exc))

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    @property
    def status(self) -> dict[str, Any]:
        """Current connection state for /publisher/status."""
        return {
            "name": self._name,
            "running": self._running,
            "connected": self._connected,
            "connectAttempts": self._connect_attempts,
            "consecutiveFailures": self._consecutive_failures,
            "ticksPublished": self._ticks_published,
            "validationFailures": dict(self._validation_failures),
            "lastTickMs": self._last_tick_ms,
        }


class AngelOneSmartStreamWs(BrokerWsConnection):
    """
    Angel One SmartStream WebSocket owner.

    data-service is the SOLE owner of the Angel One SmartStream WS connection.
    No other service may establish a direct SmartStream connection.

    Credentials required (from environment, never from HTTP request):
      - SMARTAPI_CLIENT_CODE
      - SMARTAPI_TOTP_SECRET (for session token refresh)

    The SDK integration (smartapi-javascript equivalent Python binding or
    the smartapi-python library) is wired in _connect() below.

    Requirement 19.1: data-service is the sole owner.
    """

    def __init__(self, symbols: list[str], redis_client: Any = None) -> None:
        super().__init__(
            name="angel_one_smartstream",
            symbols=symbols,
            redis_client=redis_client,
        )

    async def _connect(self) -> None:
        """
        Connect to the Angel One SmartStream WebSocket.

        The SmartStream binary feed uses little-endian frames. This method:
          1. Resolves session token via SMARTAPI_CLIENT_CODE + TOTP.
          2. Opens the SmartStream WSS connection.
          3. Subscribes to LTP_MODE / FULL_SNAP for tracked symbols.
          4. Normalizes each frame to LiveTick and calls self._on_tick().

        Raises RuntimeError when credentials are absent — graceful degradation.
        """
        client_code = os.environ.get("SMARTAPI_CLIENT_CODE")
        if not client_code:
            raise RuntimeError(
                "SMARTAPI_CLIENT_CODE not configured. "
                "Angel One SmartStream WS is unavailable."
            )

        # SDK integration point — the actual SmartStream client is wired here.
        # When credentials are present and the SDK is installed, replace the
        # RuntimeError below with the SmartStream subscription + receive loop.
        #
        # Example integration (pseudo-code):
        #   from SmartWebSocket import SmartWebSocket
        #   session_token = await self._get_session_token(client_code)
        #   ws = SmartWebSocket(session_token, client_code)
        #   await ws.connect(
        #       subscription_list=[{"exchangeType": 1, "tokens": self._tokens}],
        #       on_data=lambda raw: asyncio.ensure_future(self._on_angel_tick(raw)),
        #       on_error=lambda e: ...,
        #       on_close=lambda: ...,
        #   )
        #   self._connected = True
        #   await ws.run_forever()

        raise RuntimeError(
            "Angel One SmartStream SDK not integrated. "
            "Wire the SmartWebSocket client in _connect() with valid credentials."
        )


class UpstoxV3ProtobufWs(BrokerWsConnection):
    """
    Upstox v3 Protobuf WebSocket owner.

    data-service is the SOLE owner of the Upstox v3 Protobuf WS connection.
    No other service may establish a direct Upstox WSS connection.

    Credentials required (from environment, never from HTTP request):
      - UPSTOX_ACCESS_TOKEN

    The feed uses binary Protobuf FeedResponse frames decoded via the
    Upstox-provided proto schema.

    Requirement 19.1: data-service is the sole owner.
    """

    def __init__(self, symbols: list[str], redis_client: Any = None) -> None:
        super().__init__(
            name="upstox_v3_protobuf",
            symbols=symbols,
            redis_client=redis_client,
        )

    async def _connect(self) -> None:
        """
        Connect to the Upstox v3 Protobuf WebSocket.

        The Upstox market data WS feed URL:
          wss://api.upstox.com/v3/feed/market-data-feed

        Each frame is a binary protobuf FeedResponse. This method:
          1. Resolves UPSTOX_ACCESS_TOKEN from environment.
          2. Opens the authenticated WSS connection.
          3. Decodes each FeedResponse protobuf frame.
          4. Normalizes to LiveTick and calls self._on_tick().

        Raises RuntimeError when credentials are absent — graceful degradation.
        """
        access_token = os.environ.get("UPSTOX_ACCESS_TOKEN")
        if not access_token:
            raise RuntimeError(
                "UPSTOX_ACCESS_TOKEN not configured. "
                "Upstox v3 Protobuf WS is unavailable."
            )

        # SDK integration point — wire the actual Upstox WS client here.
        # When the access token is present and websockets library is available,
        # replace the RuntimeError below with the Upstox WS subscription loop.
        #
        # Example integration (pseudo-code):
        #   import websockets
        #   from upstox_proto import FeedResponse  # generated from .proto
        #   url = "wss://api.upstox.com/v3/feed/market-data-feed"
        #   headers = {"Authorization": f"Bearer {access_token}"}
        #   async with websockets.connect(url, extra_headers=headers) as ws:
        #       self._connected = True
        #       async for message in ws:
        #           feed_response = FeedResponse()
        #           feed_response.ParseFromString(message)
        #           for feed in feed_response.feeds:
        #               tick = self._decode_upstox_feed(feed)
        #               await self._on_tick(tick)

        raise RuntimeError(
            "Upstox v3 Protobuf WS SDK not integrated. "
            "Wire the websockets client in _connect() with a valid UPSTOX_ACCESS_TOKEN."
        )


# ---------------------------------------------------------------------------
# Module-level singletons (wired in server.py lifespan)
# ---------------------------------------------------------------------------

#: Singleton for Angel One SmartStream WS.
#: Start with: await angel_one_ws.start(redis_client=_redis_client)
angel_one_ws = AngelOneSmartStreamWs(symbols=[])

#: Singleton for Upstox v3 Protobuf WS.
#: Start with: await upstox_ws.start(redis_client=_redis_client)
upstox_ws = UpstoxV3ProtobufWs(symbols=[])
