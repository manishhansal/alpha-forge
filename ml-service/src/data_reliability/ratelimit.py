"""
Phase 3Q — Rate-limit safety (spec §29).

A deterministic token-bucket throttle so provider request limits are respected,
requests are queued/denied rather than storming, and retries stay bounded. Time
is injected (no wall-clock dependency) so behaviour is fully testable. This never
issues real requests — it only decides admit / deny.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class RateDecision(str, Enum):
    ALLOW = "ALLOW"
    DENY  = "DENY"      # over budget — caller must back off, NOT storm


@dataclass
class TokenBucket:
    """
    Classic token bucket (spec §29). `capacity` tokens refill at `refill_per_sec`.
    `try_acquire(now)` admits a request iff a token is available. Deterministic:
    the caller supplies `now` (monotonic seconds).
    """
    capacity:       float
    refill_per_sec: float
    _tokens:        float = 0.0
    _last:          float | None = None

    def __post_init__(self) -> None:
        if self.capacity <= 0 or self.refill_per_sec <= 0:
            raise ValueError("capacity and refill_per_sec must be positive")
        self._tokens = self.capacity

    def _refill(self, now: float) -> None:
        if self._last is None:
            self._last = now
            return
        elapsed = max(0.0, now - self._last)
        self._tokens = min(self.capacity, self._tokens + elapsed * self.refill_per_sec)
        self._last = now

    def try_acquire(self, now: float, cost: float = 1.0) -> RateDecision:
        self._refill(now)
        if self._tokens >= cost:
            self._tokens -= cost
            return RateDecision.ALLOW
        return RateDecision.DENY

    @property
    def available(self) -> float:
        return self._tokens


class RateLimiter:
    """
    Central per-provider throttle (spec §29). One bucket per provider; a shared
    limiter prevents any single provider from being stormed and gives callers a
    typed ALLOW/DENY they must honour (deny -> bounded retry/backoff, never spin).
    """

    def __init__(self) -> None:
        self._buckets: dict[str, TokenBucket] = {}

    def configure(self, provider: str, capacity: float, refill_per_sec: float) -> None:
        self._buckets[provider] = TokenBucket(capacity=capacity,
                                              refill_per_sec=refill_per_sec)

    def acquire(self, provider: str, now: float, cost: float = 1.0) -> RateDecision:
        bucket = self._buckets.get(provider)
        if bucket is None:
            # Unconfigured provider: fail-closed by denying (never assume infinite).
            return RateDecision.DENY
        return bucket.try_acquire(now, cost)
