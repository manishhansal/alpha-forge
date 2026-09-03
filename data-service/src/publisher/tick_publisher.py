"""
TickPublisher — asyncio background task that polls LiveQuoteScraper every 5 s
and publishes live ticks to Redis pub/sub.

Channel format : ``af:ticks:{SYMBOL}``  (symbol always uppercase)
Payload format : JSON-encoded :class:`~src.schemas.LiveTick`

Null-LTP skip rule
------------------
If a quote's ``ltp`` is ``None`` or absent, the symbol is skipped for that
polling cycle — no message is published and ``publish_count`` is NOT
incremented.

Reconnection
------------
On Redis connection loss the publisher switches to ``running = "reconnecting"``
and retries with exponential backoff: 1 s → 2 s → 4 s → 8 s → 16 s → capped
at 30 s.  The backoff counter resets to 1 s as soon as the connection is
restored.

Dynamic symbol management
--------------------------
``add_symbols`` / ``remove_symbols`` apply changes atomically to the in-memory
symbol set; no service restart is required.

Requirements: 5.1, 5.2, 5.3, 5.6, 5.7
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any

import structlog

from src.config import settings
from src.schemas import LiveTick, MDQuote

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_POLL_INTERVAL: float = 5.0          # seconds between quote polls
_SHUTDOWN_TIMEOUT: float = 10.0      # max seconds for graceful stop
_BACKOFF_BASE: float = 1.0           # initial Redis reconnect wait (seconds)
_BACKOFF_CAP: float = 30.0           # maximum Redis reconnect wait (seconds)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utc_now_ms() -> int:
    """Current UTC time in milliseconds."""
    return int(time.time() * 1000)


def _quote_to_tick(quote: MDQuote) -> LiveTick | None:
    """Convert an :class:`MDQuote` to a :class:`LiveTick`.

    Returns ``None`` when any required field (``ltp``, ``token``, ``exchange``)
    is missing — those ticks must be skipped per the null-LTP skip rule.
    """
    if quote.ltp is None:
        return None

    # token and exchange are optional on MDQuote; treat absence as skip
    if not quote.token or not quote.exchange:
        return None

    now_ms = _utc_now_ms()

    # exchangeTimestampMs: prefer lastTradeTime when available, else use now
    exchange_ts_ms: int
    if quote.lastTradeTime:
        try:
            # lastTradeTime is UTC ISO-8601; parse and convert to ms
            dt = datetime.fromisoformat(quote.lastTradeTime.replace("Z", "+00:00"))
            exchange_ts_ms = int(dt.timestamp() * 1000)
        except (ValueError, AttributeError):
            exchange_ts_ms = now_ms
    else:
        exchange_ts_ms = now_ms

    return LiveTick(
        token=quote.token,
        symbol=quote.symbol.upper(),
        exchange=quote.exchange,
        ltp=quote.ltp,
        change=quote.change,
        changePct=quote.changePct,
        volume=quote.volume,
        oi=quote.oi,
        exchangeTimestampMs=exchange_ts_ms,
        receivedAtMs=now_ms,
        provider="scrapling",
    )


# ---------------------------------------------------------------------------
# TickPublisher
# ---------------------------------------------------------------------------


class TickPublisher:
    """Asyncio background task: polls LiveQuoteScraper and publishes to Redis.

    Usage (inside FastAPI lifespan)::

        publisher = TickPublisher()
        await publisher.start(redis_client=_redis_client)
        # ... service runs ...
        await publisher.stop()
    """

    def __init__(self, scraper: Any = None) -> None:
        # State flags
        self._running: bool | str = False   # True | False | "reconnecting"
        self._task: asyncio.Task[None] | None = None
        self._stop_event: asyncio.Event = asyncio.Event()

        # Redis — injected at start() or resolved lazily from server module
        self._redis: Any = None

        # Symbol management — thread-safe via asyncio lock (single-threaded event loop)
        self._symbols: list[str] = [s.upper() for s in settings.symbols]
        self._symbols_lock = asyncio.Lock()

        # Counters
        self._publish_count: int = 0
        self._last_publish_ms: int | None = None

        # Optional scraper override (mostly for testing)
        self._scraper = scraper

        logger.info(
            "tick_publisher_initialized",
            symbol_count=len(self._symbols),
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self, redis_client: Any = None) -> None:
        """Start the background polling task.

        Parameters
        ----------
        redis_client:
            An already-connected ``aioredis.Redis`` instance.  When omitted,
            ``TickPublisher`` tries to import ``_redis_client`` from
            ``src.server`` (the module-level singleton created during lifespan).
        """
        if self._running is True:
            logger.warning("tick_publisher_already_running")
            return

        self._stop_event.clear()
        self._redis = redis_client

        # Fall back to the server's Redis singleton when none was injected
        if self._redis is None:
            self._redis = await self._resolve_server_redis()

        # Wire stream publisher with the same Redis client for durable delivery
        if self._redis is not None:
            try:
                from src.publisher.stream_publisher import stream_publisher as _sp
                _sp.set_redis(self._redis)
                logger.info("stream_publisher_wired")
            except Exception as exc:
                logger.warning("stream_publisher_wire_failed", error=str(exc))

        self._running = True
        self._task = asyncio.create_task(self._tick_loop(), name="tick_publisher_loop")
        logger.info("tick_publisher_started")

    async def stop(self) -> None:
        """Request a graceful shutdown; wait up to 10 s for the loop to exit."""
        if not self._running and self._task is None:
            return

        logger.info("tick_publisher_stopping")
        self._stop_event.set()

        if self._task is not None and not self._task.done():
            try:
                await asyncio.wait_for(
                    asyncio.shield(self._task),
                    timeout=_SHUTDOWN_TIMEOUT,
                )
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass

        self._running = False
        self._task = None
        logger.info("tick_publisher_stopped")

    # ------------------------------------------------------------------
    # Core loop
    # ------------------------------------------------------------------

    async def _tick_loop(self) -> None:
        """Poll quotes every 5 s and publish ticks to Redis."""
        while not self._stop_event.is_set():
            poll_start = asyncio.get_running_loop().time()

            try:
                await self._poll_and_publish()
            except Exception as exc:  # pragma: no cover
                logger.error("tick_loop_unexpected_error", error=str(exc), exc_info=True)

            # Sleep for the remainder of the 5 s window in 100 ms slices so
            # we can respond to stop_event promptly without leaking Tasks.
            elapsed = asyncio.get_running_loop().time() - poll_start
            sleep_for = max(0.0, _POLL_INTERVAL - elapsed)
            slept = 0.0
            while slept < sleep_for and not self._stop_event.is_set():
                chunk = min(0.1, sleep_for - slept)
                await asyncio.sleep(chunk)
                slept += chunk

        self._running = False
        logger.info("tick_loop_exited")

    async def _poll_and_publish(self) -> None:
        """Fetch quotes for all tracked symbols and publish non-null ticks."""
        async with self._symbols_lock:
            current_symbols = list(self._symbols)

        if not current_symbols:
            return

        quotes = await self._fetch_quotes(current_symbols)

        if not quotes:
            return

        for quote in quotes:
            if quote is None:
                continue

            tick = _quote_to_tick(quote)
            if tick is None:
                # null ltp or missing required fields — skip without counting
                logger.debug(
                    "tick_skipped_null_ltp",
                    symbol=quote.symbol if hasattr(quote, "symbol") else "unknown",
                )
                continue

            published = await self._publish_tick(tick)
            if published:
                self._publish_count += 1
                self._last_publish_ms = tick.receivedAtMs

    async def _fetch_quotes(self, symbols: list[str]) -> list[MDQuote | None]:
        """Fetch quotes by delegating to the live_quotes module.

        Falls back to an empty list when no scraper is available or an error
        occurs — the publisher loop should never crash due to a scrape failure.
        """
        if self._scraper is not None:
            # Use injected scraper (primarily for tests)
            try:
                return await self._scraper.get_quotes(symbols)
            except Exception as exc:
                logger.warning("scraper_fetch_error", error=str(exc))
                return []

        # Default path: call the live_quotes module functions directly
        try:
            from src.scrapers.live_quotes import (  # type: ignore[import]
                NIFTY_200_SYMBOLS,
                _NSE_INDEX_SYMBOLS,
                _fetch_batch_quotes,
                _fetch_index_quotes,
                _fetch_single_quote,
                get_quote_session,
            )

            session = await get_quote_session()

            index_syms = [s for s in symbols if s in _NSE_INDEX_SYMBOLS]
            constituents = [s for s in symbols if s not in _NSE_INDEX_SYMBOLS and s in NIFTY_200_SYMBOLS]
            non_constituents = [s for s in symbols if s not in _NSE_INDEX_SYMBOLS and s not in NIFTY_200_SYMBOLS]

            results: dict[str, MDQuote | None] = {s: None for s in symbols}

            if index_syms:
                idx = await asyncio.wait_for(_fetch_index_quotes(index_syms), timeout=12.0)
                results.update(idx)

            if constituents:
                batch = await asyncio.wait_for(
                    _fetch_batch_quotes(session, constituents),
                    timeout=12.0,
                )
                results.update(batch)

            for sym in non_constituents:
                quote = await asyncio.wait_for(
                    _fetch_single_quote(session, sym),
                    timeout=12.0,
                )
                results[sym] = quote

            return [results.get(s) for s in symbols]

        except asyncio.TimeoutError:
            logger.warning("tick_fetch_timeout")
            return []
        except Exception as exc:
            logger.warning("tick_fetch_error", error=str(exc))
            return []

    async def _publish_tick(self, tick: LiveTick) -> bool:
        """Publish a single tick to ``af:ticks:{SYMBOL}`` and Redis Streams.

        Handles Redis connection loss with exponential backoff reconnection.
        Returns ``True`` when the pub/sub message was published successfully.

        Phase 22-24: Also publishes to Redis Stream for durable AT_LEAST_ONCE delivery.
        """
        channel = f"af:ticks:{tick.symbol.upper()}"
        payload = tick.model_dump_json()

        # Try with the current connection first
        if self._redis is not None:
            try:
                await self._redis.publish(channel, payload)
                # Also publish to Redis Stream for durable delivery
                await self._publish_to_stream(tick)
                return True
            except Exception as exc:
                logger.warning(
                    "redis_publish_error",
                    channel=channel,
                    error=str(exc),
                )
                self._redis = None

        # Connection lost — reconnect with exponential backoff
        reconnected = await self._reconnect_redis()
        if not reconnected:
            return False

        try:
            await self._redis.publish(channel, payload)
            await self._publish_to_stream(tick)
            return True
        except Exception as exc:
            logger.error("redis_publish_after_reconnect_failed", error=str(exc))
            return False

    async def _publish_to_stream(self, tick: LiveTick) -> None:
        """Publish tick to Redis Stream for durable at-least-once delivery.

        Phase 22: Stream provides recovery path; pub/sub is real-time/lossy.
        This is fire-and-forget — stream failure does NOT block pub/sub.
        """
        try:
            from src.publisher.stream_publisher import stream_publisher
            if stream_publisher._redis is not None:
                # Build a minimal LiveTickV2 for the stream publisher
                from src.core.schemas_v2 import LiveTickV2
                import time as _time
                now_ms = int(_time.time() * 1000)
                tick_v2 = LiveTickV2(
                    instrumentId=tick.symbol.upper(),
                    symbol=tick.symbol.upper(),
                    exchange=tick.exchange or "NSE",
                    eventTimeMs=tick.exchangeTimestampMs or now_ms,
                    receivedAtMs=tick.receivedAtMs or now_ms,
                    ltp=tick.ltp,
                    change=tick.change,
                    changePct=tick.changePct,
                    volume=tick.volume,
                    oi=tick.oi,
                )
                await stream_publisher.publish_tick(tick_v2)
        except Exception as exc:
            # Non-fatal: stream publish failure should never block pub/sub
            logger.debug("stream_publish_error", symbol=tick.symbol, error=str(exc))

    # ------------------------------------------------------------------
    # Redis reconnection with exponential backoff
    # ------------------------------------------------------------------

    async def _reconnect_redis(self) -> bool:
        """Attempt to reconnect to Redis with exponential backoff.

        Wait sequence: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s (capped), 30 s, …
        Sets ``self._running = "reconnecting"`` during the outage.
        Resets ``self._running = True`` when the connection is restored.

        Returns ``True`` on success, ``False`` if the stop event fires
        before a connection can be established.
        """
        previous_state = self._running
        self._running = "reconnecting"
        wait = _BACKOFF_BASE

        attempt = 0
        while not self._stop_event.is_set():
            attempt += 1
            logger.info(
                "redis_reconnect_attempt",
                attempt=attempt,
                wait_seconds=wait,
            )

            # Sleep in short slices so we respond to stop_event without leaking Tasks
            slept = 0.0
            while slept < wait and not self._stop_event.is_set():
                chunk = min(0.5, wait - slept)
                await asyncio.sleep(chunk)
                slept += chunk

            if self._stop_event.is_set():
                logger.info("redis_reconnect_aborted_by_stop")
                return False

            new_redis = await self._try_create_redis()
            if new_redis is not None:
                self._redis = new_redis
                self._running = True
                logger.info("redis_reconnected", attempt=attempt)
                return True

            # Advance backoff (double, cap at 30 s)
            wait = min(wait * 2, _BACKOFF_CAP)

        return False

    async def _try_create_redis(self) -> Any:
        """Attempt to create a new Redis connection. Returns ``None`` on failure."""
        try:
            import aioredis  # type: ignore[import]

            client = await aioredis.from_url(
                settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
            await client.ping()
            return client
        except Exception as exc:
            logger.warning("redis_reconnect_failed", error=str(exc))
            return None

    # ------------------------------------------------------------------
    # Symbol management
    # ------------------------------------------------------------------

    async def add_symbols(self, symbols: list[str]) -> None:
        """Add symbols to the tracked set atomically.

        Symbols are uppercased and deduplicated. No-op for already-tracked
        symbols.
        """
        normalised = [s.strip().upper() for s in symbols if s.strip()]
        async with self._symbols_lock:
            existing = set(self._symbols)
            added = [s for s in normalised if s not in existing]
            self._symbols.extend(added)
            if added:
                logger.info("symbols_added", symbols=added, total=len(self._symbols))

    async def remove_symbols(self, symbols: list[str]) -> None:
        """Remove symbols from the tracked set atomically."""
        normalised = {s.strip().upper() for s in symbols if s.strip()}
        async with self._symbols_lock:
            before = len(self._symbols)
            self._symbols = [s for s in self._symbols if s not in normalised]
            removed = before - len(self._symbols)
            if removed:
                logger.info(
                    "symbols_removed",
                    count=removed,
                    total=len(self._symbols),
                )

    def add_symbols_sync(self, symbols: list[str]) -> None:
        """Synchronous variant for use outside an async context.

        Note: not safe to call concurrently with the async symbol management
        methods.  Prefer :meth:`add_symbols` inside the event loop.
        """
        normalised = [s.strip().upper() for s in symbols if s.strip()]
        existing = set(self._symbols)
        added = [s for s in normalised if s not in existing]
        self._symbols.extend(added)
        if added:
            logger.info("symbols_added_sync", symbols=added, total=len(self._symbols))

    def remove_symbols_sync(self, symbols: list[str]) -> None:
        """Synchronous variant for use outside an async context."""
        normalised = {s.strip().upper() for s in symbols if s.strip()}
        before = len(self._symbols)
        self._symbols = [s for s in self._symbols if s not in normalised]
        removed = before - len(self._symbols)
        if removed:
            logger.info(
                "symbols_removed_sync",
                count=removed,
                total=len(self._symbols),
            )

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    @property
    def status(self) -> dict[str, Any]:
        """Snapshot of publisher state for the ``/publisher/status`` endpoint."""
        return {
            "running": self._running,
            "symbols": self._symbols[:500],   # cap at 500 entries per spec
            "publish_count": self._publish_count,
            "last_publish_ms": self._last_publish_ms,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _resolve_server_redis(self) -> Any:
        """Import the Redis singleton from the server module, if available."""
        try:
            from src.server import _redis_client  # type: ignore[attr-defined]

            return _redis_client
        except (ImportError, AttributeError):
            return None


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

#: Default publisher instance — wire up via ``tick_publisher.start()`` inside
#: the FastAPI lifespan.  Other modules can import this directly:
#:
#:     from src.publisher.tick_publisher import tick_publisher
tick_publisher = TickPublisher()
