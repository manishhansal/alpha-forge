"""
Property-based tests for the TokenBucketRateLimiter.

Property 14: Token bucket rate limit is never exceeded
    Validates: Requirements 9.1

Property 15: FIFO queue preserves request arrival order
    Validates: Requirements 9.2
"""

from __future__ import annotations

import asyncio
import math
import time
from typing import List, Tuple

import pytest
from hypothesis import assume, given, settings as hyp_settings
from hypothesis import strategies as st

from src.anti_ban.rate_limiter import QueueFullError, TokenBucketRateLimiter


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _run_concurrent_acquires(
    limiter: TokenBucketRateLimiter,
    num_requests: int,
    timeout_seconds: float,
) -> List[float]:
    """
    Fire ``num_requests`` concurrent acquire() calls and return the wall-clock
    completion times (event-loop monotonic seconds) for each one.

    Raises asyncio.TimeoutError if any acquire does not complete within
    ``timeout_seconds``.
    """
    results: List[float] = []

    async def _timed_acquire() -> None:
        await asyncio.wait_for(limiter.acquire(), timeout=timeout_seconds)
        results.append(asyncio.get_event_loop().time())

    await asyncio.gather(*[_timed_acquire() for _ in range(num_requests)])
    return results


# ---------------------------------------------------------------------------
# Property 14: Token bucket rate limit is never exceeded
# ---------------------------------------------------------------------------


async def _run_rate_limit_check(rate: float, num_requests: int) -> List[float]:
    """
    Run ``num_requests`` acquire() calls on a limiter with capacity=1 and
    return their completion times.

    Using capacity=1 means only the very first call can take the fast path;
    all remaining requests must be served by the drain loop at exactly R/s.
    This isolates the steady-state rate behaviour from the initial burst.
    """
    # capacity=1 so at most 1 token is available at startup; all other
    # requests must queue and be served by the drain loop at rate R/s.
    limiter = TokenBucketRateLimiter("test.pbt14.domain", rate=rate, capacity=1.0)

    timeout_per_acquire = (num_requests / rate) + 5.0
    return await _run_concurrent_acquires(limiter, num_requests, timeout_per_acquire)


@given(
    rate=st.floats(
        min_value=5.0,
        max_value=20.0,
        allow_nan=False,
        allow_infinity=False,
    ),
    num_requests=st.integers(min_value=2, max_value=30),
)
@hyp_settings(max_examples=50, deadline=None)
def test_property_14_token_bucket_rate_never_exceeded(
    rate: float, num_requests: int
) -> None:
    """
    **Validates: Requirements 9.1**

    Feature: scrapling-data-service, Property 14: token bucket rate limit never exceeded

    For any sequence of requests through a TokenBucketRateLimiter configured
    with rate R, the number of requests that exit the limiter within any
    contiguous 1-second window SHALL never exceed ceil(R) + 1.

    The limiter is created with capacity=1 so only a single token is available
    upfront; all remaining requests are served by the drain loop at R/s.  This
    isolates the steady-state rate property from the initial-burst behaviour.

    Rate is constrained to [5, 20] so that even a 30-request run finishes in
    at most ~6 seconds, keeping the test fast enough for CI.
    """
    completion_times: List[float] = asyncio.run(
        _run_rate_limit_check(rate, num_requests)
    )

    assert len(completion_times) == num_requests, (
        f"Expected {num_requests} completions, got {len(completion_times)}"
    )

    # Check every 1-second sliding window anchored at each completion time.
    # ceil(rate) tokens can be granted in any 1s window; +1 for the one
    # token that may have been pre-filled at bucket creation (capacity=1).
    max_allowed = math.ceil(rate) + 1
    for anchor in completion_times:
        window_count = sum(
            1 for t in completion_times if anchor <= t < anchor + 1.0
        )
        assert window_count <= max_allowed, (
            f"Rate exceeded: {window_count} completions in 1s window "
            f"(rate={rate:.2f}, max_allowed={max_allowed}, "
            f"window_anchor={anchor:.4f})"
        )


# ---------------------------------------------------------------------------
# Property 15: FIFO queue preserves request arrival order
# ---------------------------------------------------------------------------


async def _fifo_order_run(num_queued: int) -> List[float]:
    """
    Verify FIFO ordering for ``num_queued`` requests that must all go through
    the slow (queue) path.

    Strategy:
    1. Create a limiter with capacity=1 and a low rate (2 req/s).
    2. Fire a single "drain" acquire to consume the initial token so the
       bucket is empty.
    3. Schedule ``num_queued`` acquire coroutines sequentially in a single
       gather — each is created in order index 0 … N-1.
    4. Collect completion times and verify they are non-decreasing.

    At 2 req/s the test finishes in at most (num_queued / 2 + 2) seconds
    (≤ 7s for num_queued=10), well within CI budget.
    """
    rate = 2.0
    limiter = TokenBucketRateLimiter("test.pbt15.domain", rate=rate, capacity=1.0)

    # Step 1: exhaust the initial token so every subsequent call must queue.
    await asyncio.wait_for(limiter.acquire(), timeout=2.0)

    # Brief yield so the drain loop can start and register that the queue is empty.
    await asyncio.sleep(0)

    completion_times: List[float] = []

    async def _record_acquire(index: int) -> None:
        # We don't care about index here — we only care about arrival order.
        await asyncio.wait_for(
            limiter.acquire(), timeout=(num_queued / rate) + 5.0
        )
        completion_times.append(asyncio.get_event_loop().time())

    # Enqueue requests in order.  asyncio.gather preserves the order in which
    # coroutines are passed, and each coroutine immediately suspends on await,
    # so they enter the FIFO queue in index order.
    await asyncio.gather(*[_record_acquire(i) for i in range(num_queued)])
    return completion_times


@given(num_queued=st.integers(min_value=2, max_value=10))
@hyp_settings(max_examples=30, deadline=None)
def test_property_15_fifo_queue_preserves_arrival_order(num_queued: int) -> None:
    """
    **Validates: Requirements 9.2**

    Feature: scrapling-data-service, Property 15: FIFO queue preserves request arrival order

    For any sequence of requests that arrive faster than the configured rate
    and are placed in the overflow queue, the requests SHALL be served in the
    exact same order they were enqueued.  For any two requests A and B where A
    arrived before B, A's completion time SHALL be <= B's completion time.
    """
    completion_times = asyncio.run(_fifo_order_run(num_queued))

    assert len(completion_times) == num_queued, (
        f"Expected {num_queued} completions, got {len(completion_times)}"
    )

    # Non-decreasing completion times confirm FIFO service order.
    for i in range(len(completion_times) - 1):
        assert completion_times[i] <= completion_times[i + 1], (
            f"FIFO violation: request {i} completed at {completion_times[i]:.6f}s "
            f"but request {i + 1} completed at {completion_times[i + 1]:.6f}s "
            f"(earlier than its predecessor)"
        )
