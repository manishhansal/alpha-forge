"""
Token bucket rate limiter for per-domain request throttling.

Each domain gets a singleton `TokenBucketRateLimiter` whose `acquire()` method
blocks (yields control) until a token is available.  Overflow requests are
queued in a FIFO `asyncio.Queue`; once the queue reaches 1000 entries the next
caller receives a `QueueFullError` immediately.

A background drain task runs inside each `TokenBucketRateLimiter` and resolves
queued futures as new tokens become available, preserving arrival order.

Usage:
    limiters = create_domain_limiters(nse_rate=3, bse_rate=2)
    await limiters["nseindia.com"].acquire()
"""

from __future__ import annotations

import asyncio
from typing import Dict

import structlog

logger = structlog.get_logger(__name__)

# Maximum FIFO queue depth before QueueFullError is raised.
_MAX_QUEUE_DEPTH = 1000


class QueueFullError(Exception):
    """Raised when the FIFO overflow queue has reached its maximum depth (1000)."""


# ---------------------------------------------------------------------------
# TokenBucketRateLimiter
# ---------------------------------------------------------------------------


class TokenBucketRateLimiter:
    """
    Asyncio token-bucket rate limiter with a FIFO overflow queue.

    Parameters
    ----------
    domain:
        Human-readable domain label (e.g. ``"nseindia.com"``).
    rate:
        Token refill rate in tokens per second.
    capacity:
        Maximum number of tokens the bucket can hold.  Tokens start at
        ``capacity`` when the limiter is created.
    """

    def __init__(self, domain: str, rate: float, capacity: float) -> None:
        self._domain = domain
        self._rate = rate
        self._capacity = capacity
        self._tokens: float = capacity

        # FIFO queue of Future objects — each represents one waiting caller.
        # maxsize=0 means unlimited here; we enforce the cap manually so we can
        # raise QueueFullError before enqueueing rather than blocking.
        self._queue: asyncio.Queue[asyncio.Future[None]] = asyncio.Queue(maxsize=0)

        self._last_refill: float | None = None
        self._drain_task: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    @property
    def domain(self) -> str:
        return self._domain

    @property
    def queue_depth(self) -> int:
        return self._queue.qsize()

    async def acquire(self) -> None:
        """
        Acquire one token, blocking until one is available.

        If the bucket is empty or there are already callers ahead in the queue,
        this coroutine enqueues a Future and suspends until the drain task
        resolves it.

        Raises
        ------
        QueueFullError
            When the FIFO queue already holds 1000 pending requests.
        """
        self._ensure_drain_task()

        # Fast path: a token is available and no one is ahead of us.
        # NOTE: we do NOT call _refill() here to avoid double-accounting
        # elapsed time (the drain loop is the sole token issuer).
        if self._tokens >= 1 and self._queue.empty():
            self._tokens -= 1
            return

        # Slow path: queue this caller.
        if self._queue.qsize() >= _MAX_QUEUE_DEPTH:
            raise QueueFullError(
                f"{self._domain}: rate-limit queue is full ({_MAX_QUEUE_DEPTH} pending requests)"
            )

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[None] = loop.create_future()
        await self._queue.put(fut)

        logger.debug(
            "rate_limiter_queued",
            domain=self._domain,
            queue_depth=self._queue.qsize(),
        )

        await fut  # Suspend until the drain task resolves this future.

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _refill(self) -> None:
        """Refill the bucket based on elapsed wall-clock time.

        Called exclusively from ``_drain_loop`` to avoid double-accounting.
        """
        try:
            now = asyncio.get_running_loop().time()
        except RuntimeError:
            return  # no running event loop — called during construction
        if self._last_refill is None:
            self._last_refill = now
            return
        elapsed = now - self._last_refill
        self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
        self._last_refill = now

    def _ensure_drain_task(self) -> None:
        """
        Lazily start the background drain task.

        Deferred until first ``acquire()`` so the class can be constructed at
        module import time (before an event loop is running).
        """
        if self._drain_task is None or self._drain_task.done():
            self._drain_task = asyncio.ensure_future(self._drain_loop())

    async def _drain_loop(self) -> None:
        """
        Background coroutine that continuously drains the FIFO queue.

        Sleeps until a token is available, then pops and resolves the oldest
        pending future, then sleeps again.  Token inter-arrival time is
        ``1 / rate`` seconds.
        """
        token_interval = 1.0 / self._rate
        while True:
            try:
                if self._queue.empty():
                    # Nothing waiting — poll every token interval.
                    await asyncio.sleep(token_interval)
                    continue

                # Wait until the next token is available.
                self._refill()
                if self._tokens < 1:
                    wait = (1 - self._tokens) / self._rate
                    await asyncio.sleep(wait)
                    self._refill()

                # Consume one token and resolve the oldest waiter.
                self._tokens -= 1
                fut = await self._queue.get()
                if not fut.done():
                    fut.set_result(None)

                logger.debug(
                    "rate_limiter_drained",
                    domain=self._domain,
                    queue_depth=self._queue.qsize(),
                )
            except asyncio.CancelledError:
                # Graceful shutdown — resolve all remaining waiters with an error.
                while not self._queue.empty():
                    try:
                        fut = self._queue.get_nowait()
                        if not fut.done():
                            fut.cancel()
                    except asyncio.QueueEmpty:
                        break
                raise
            except Exception:
                logger.exception("rate_limiter_drain_error", domain=self._domain)
                await asyncio.sleep(token_interval)


# ---------------------------------------------------------------------------
# NoopRateLimiter — for domains with no throttling requirement
# ---------------------------------------------------------------------------


class NoopRateLimiter:
    """
    No-op rate limiter for domains where throttling is not required
    (e.g. ``nsearchives.nseindia.com`` which is served by CloudFront CDN).
    """

    def __init__(self, domain: str) -> None:
        self._domain = domain

    @property
    def domain(self) -> str:
        return self._domain

    @property
    def queue_depth(self) -> int:
        return 0

    async def acquire(self) -> None:
        """Returns immediately — no throttling applied."""
        return


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_domain_limiters(
    nse_rate: float,
    bse_rate: float,
) -> Dict[str, TokenBucketRateLimiter | NoopRateLimiter]:
    """
    Create per-domain rate limiter singletons.

    Parameters
    ----------
    nse_rate:
        Token refill rate for ``nseindia.com`` (requests per second).
    bse_rate:
        Token refill rate for ``bseindia.com`` (requests per second).

    Returns
    -------
    dict
        Keys are domain strings; values are limiter instances.
        ``nsearchives.nseindia.com`` always gets a ``NoopRateLimiter``.
    """
    return {
        "nseindia.com": TokenBucketRateLimiter(
            "nseindia.com",
            rate=nse_rate,
            capacity=nse_rate,
        ),
        "bseindia.com": TokenBucketRateLimiter(
            "bseindia.com",
            rate=bse_rate,
            capacity=bse_rate,
        ),
        "nsearchives.nseindia.com": NoopRateLimiter("nsearchives.nseindia.com"),
    }
