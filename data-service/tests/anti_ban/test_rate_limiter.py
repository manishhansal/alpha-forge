"""
Unit tests for TokenBucketRateLimiter, NoopRateLimiter, and create_domain_limiters.

Requirements: 9.1, 9.2, 9.3
"""

from __future__ import annotations

import asyncio
import time

import pytest

from src.anti_ban.rate_limiter import (
    NoopRateLimiter,
    QueueFullError,
    TokenBucketRateLimiter,
    create_domain_limiters,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _limiter(rate: float, capacity: float | None = None) -> TokenBucketRateLimiter:
    """Create a TokenBucketRateLimiter with sensible defaults for testing."""
    if capacity is None:
        capacity = rate
    return TokenBucketRateLimiter("test.example.com", rate=rate, capacity=capacity)


# ---------------------------------------------------------------------------
# FIFO ordering
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_requests_beyond_rate_queued_in_fifo_order() -> None:
    """
    Requests that cannot be served immediately are served in the order they arrived.

    Strategy: create a limiter with capacity=1, drain the initial token, then
    concurrently enqueue 3 requests.  Because new tokens arrive at a fixed cadence
    the first waiter (lowest index) must always be unblocked before later ones.
    """
    limiter = _limiter(rate=10.0, capacity=1.0)

    # Drain the single initial token so all subsequent acquires must queue.
    await limiter.acquire()

    completion_order: list[int] = []

    async def acquire_and_record(index: int) -> None:
        await limiter.acquire()
        completion_order.append(index)

    # Enqueue 3 concurrent waiters in order 0, 1, 2.
    tasks = [asyncio.create_task(acquire_and_record(i)) for i in range(3)]

    # Give the event loop a tick so all tasks enter the queue before the drain
    # loop starts servicing them.
    await asyncio.sleep(0)

    await asyncio.gather(*tasks)

    # FIFO guarantee: completion order must be non-decreasing (0 → 1 → 2).
    assert completion_order == sorted(completion_order), (
        f"Expected FIFO completion order, got {completion_order}"
    )


# ---------------------------------------------------------------------------
# QueueFullError at depth 1000
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_queue_full_error_at_depth_1000() -> None:
    """
    The 1001st enqueue attempt raises QueueFullError once 1000 requests are queued.

    We use capacity=0 and a very slow refill rate so no token ever becomes
    available during the test, guaranteeing every acquire() goes to the queue.
    """
    limiter = TokenBucketRateLimiter(
        "test.example.com",
        rate=0.001,   # extremely slow: one token per 1000 seconds
        capacity=0.0, # no initial tokens
    )

    # Fill the queue to the 1000-entry limit.
    pending: list[asyncio.Task] = []
    for _ in range(1000):
        task = asyncio.ensure_future(limiter.acquire())
        pending.append(task)
        # Give the event loop a tick so each coroutine reaches the queue.
        await asyncio.sleep(0)

    assert limiter.queue_depth == 1000

    # The 1001st attempt must raise QueueFullError synchronously (before awaiting).
    with pytest.raises(QueueFullError):
        await limiter.acquire()

    # Clean up background tasks to avoid warnings.
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


# ---------------------------------------------------------------------------
# NoopRateLimiter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_noop_limiter_acquires_immediately() -> None:
    """NoopRateLimiter.acquire() completes without blocking."""
    noop = NoopRateLimiter("archives.example.com")

    start = time.monotonic()
    for _ in range(100):
        await noop.acquire()
    elapsed = time.monotonic() - start

    # 100 no-op acquires should complete in well under 0.1 seconds.
    assert elapsed < 0.1, f"NoopRateLimiter took {elapsed:.3f}s for 100 acquires"


def test_noop_limiter_domain_property() -> None:
    """NoopRateLimiter.domain returns the constructor argument."""
    noop = NoopRateLimiter("archives.example.com")
    assert noop.domain == "archives.example.com"


def test_noop_limiter_queue_depth_is_always_zero() -> None:
    """NoopRateLimiter.queue_depth is always 0."""
    noop = NoopRateLimiter("archives.example.com")
    assert noop.queue_depth == 0


# ---------------------------------------------------------------------------
# create_domain_limiters factory
# ---------------------------------------------------------------------------


def test_create_domain_limiters_returns_correct_types() -> None:
    """
    Factory returns TokenBucketRateLimiter for NSE and BSE domains,
    and NoopRateLimiter for nsearchives.
    """
    limiters = create_domain_limiters(nse_rate=3.0, bse_rate=2.0)

    assert isinstance(limiters["nseindia.com"], TokenBucketRateLimiter)
    assert isinstance(limiters["bseindia.com"], TokenBucketRateLimiter)
    assert isinstance(limiters["nsearchives.nseindia.com"], NoopRateLimiter)


def test_create_domain_limiters_nse_rate_applied() -> None:
    """NSE limiter is created with the specified rate."""
    limiters = create_domain_limiters(nse_rate=5.0, bse_rate=2.0)
    nse: TokenBucketRateLimiter = limiters["nseindia.com"]  # type: ignore[assignment]
    assert nse._rate == 5.0


def test_create_domain_limiters_bse_rate_applied() -> None:
    """BSE limiter is created with the specified rate."""
    limiters = create_domain_limiters(nse_rate=3.0, bse_rate=7.0)
    bse: TokenBucketRateLimiter = limiters["bseindia.com"]  # type: ignore[assignment]
    assert bse._rate == 7.0


def test_create_domain_limiters_contains_exactly_three_domains() -> None:
    """Factory produces exactly three domain keys."""
    limiters = create_domain_limiters(nse_rate=3.0, bse_rate=2.0)
    assert set(limiters.keys()) == {
        "nseindia.com",
        "bseindia.com",
        "nsearchives.nseindia.com",
    }
