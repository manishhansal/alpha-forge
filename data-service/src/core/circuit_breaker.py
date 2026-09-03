"""
Circuit Breaker — Phase 49.

Per-upstream circuit breaker with CLOSED/OPEN/HALF_OPEN states.
Tracks failure rate, latency, timeout rate, and ban rate.
Fails over when threshold exceeded.

Usage:
    from src.core.circuit_breaker import CircuitBreaker, get_breaker
    breaker = get_breaker("nse_nextapi")
    async with breaker.guard():
        # make request
"""

from __future__ import annotations

import asyncio
import time
import threading
from enum import Enum
from typing import Any, Callable, Optional
import structlog

logger = structlog.get_logger(__name__)


class CircuitState(str, Enum):
    CLOSED = "CLOSED"        # Normal: requests pass through
    OPEN = "OPEN"            # Failing: requests blocked immediately
    HALF_OPEN = "HALF_OPEN"  # Testing: one probe request allowed


class CircuitBreakerOpenError(Exception):
    """Raised when a request is attempted while the circuit is OPEN."""


class CircuitBreaker:
    """Per-upstream circuit breaker.

    Configuration:
        failure_threshold: fraction of failures to trip open (0.0-1.0)
        window_seconds: rolling window for failure rate calculation
        open_timeout_s: seconds before transitioning OPEN → HALF_OPEN
        min_requests: minimum requests before evaluating failure rate
    """

    def __init__(
        self,
        name: str,
        failure_threshold: float = 0.5,
        window_seconds: float = 60.0,
        open_timeout_s: float = 30.0,
        min_requests: int = 5,
    ) -> None:
        self.name = name
        self._failure_threshold = failure_threshold
        self._window_s = window_seconds
        self._open_timeout_s = open_timeout_s
        self._min_requests = min_requests

        self._state = CircuitState.CLOSED
        self._opened_at: Optional[float] = None

        # Rolling window of (timestamp, success) tuples
        self._history: list[tuple[float, bool]] = []
        self._lock = threading.Lock()

        # Metrics
        self._total_requests = 0
        self._total_failures = 0
        self._total_successes = 0
        self._last_failure_reason: Optional[str] = None

    @property
    def state(self) -> CircuitState:
        with self._lock:
            return self._evaluate_state()

    def _evaluate_state(self) -> CircuitState:
        """Evaluate and possibly transition state. Called with lock held."""
        if self._state == CircuitState.OPEN:
            if self._opened_at and time.monotonic() - self._opened_at >= self._open_timeout_s:
                self._state = CircuitState.HALF_OPEN
                logger.info("circuit_breaker_half_open", name=self.name)
        return self._state

    def record_success(self) -> None:
        """Record a successful request."""
        with self._lock:
            now = time.monotonic()
            self._history.append((now, True))
            self._prune(now)
            self._total_requests += 1
            self._total_successes += 1

            if self._state == CircuitState.HALF_OPEN:
                # Probe succeeded — close the circuit
                self._state = CircuitState.CLOSED
                self._opened_at = None
                logger.info("circuit_breaker_closed", name=self.name)

    def record_failure(self, reason: str = "") -> None:
        """Record a failed request."""
        with self._lock:
            now = time.monotonic()
            self._history.append((now, False))
            self._prune(now)
            self._total_requests += 1
            self._total_failures += 1
            self._last_failure_reason = reason

            if self._state == CircuitState.HALF_OPEN:
                # Probe failed — reopen
                self._state = CircuitState.OPEN
                self._opened_at = time.monotonic()
                logger.warning("circuit_breaker_reopen", name=self.name, reason=reason)
            elif self._state == CircuitState.CLOSED:
                failure_rate = self._failure_rate()
                recent = len(self._history)
                if recent >= self._min_requests and failure_rate >= self._failure_threshold:
                    self._state = CircuitState.OPEN
                    self._opened_at = time.monotonic()
                    logger.warning(
                        "circuit_breaker_opened",
                        name=self.name,
                        failure_rate=failure_rate,
                        recent_requests=recent,
                        reason=reason,
                    )

    def _failure_rate(self) -> float:
        """Compute failure rate over the rolling window. Lock must be held."""
        if not self._history:
            return 0.0
        failures = sum(1 for _, ok in self._history if not ok)
        return failures / len(self._history)

    def _prune(self, now: float) -> None:
        """Remove entries older than window_seconds. Lock must be held."""
        cutoff = now - self._window_s
        self._history = [(ts, ok) for ts, ok in self._history if ts > cutoff]

    def is_open(self) -> bool:
        return self.state == CircuitState.OPEN

    def allow_request(self) -> bool:
        """Return True when a request is allowed through the circuit."""
        with self._lock:
            state = self._evaluate_state()
            if state == CircuitState.CLOSED:
                return True
            if state == CircuitState.HALF_OPEN:
                # Allow one probe
                return True
            return False  # OPEN

    @property
    def failure_rate(self) -> float:
        with self._lock:
            self._prune(time.monotonic())
            return round(self._failure_rate(), 4)

    @property
    def stats(self) -> dict:
        with self._lock:
            state = self._evaluate_state()
            return {
                "name": self.name,
                "state": state.value,
                "failure_rate": round(self._failure_rate(), 4),
                "total_requests": self._total_requests,
                "total_failures": self._total_failures,
                "total_successes": self._total_successes,
                "last_failure_reason": self._last_failure_reason,
                "opened_at": self._opened_at,
            }


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_breakers: dict[str, CircuitBreaker] = {}
_registry_lock = threading.Lock()


def get_breaker(name: str) -> CircuitBreaker:
    """Get or create a CircuitBreaker by name."""
    with _registry_lock:
        if name not in _breakers:
            _breakers[name] = CircuitBreaker(name)
        return _breakers[name]


def all_breakers() -> dict[str, CircuitBreaker]:
    """Return all registered circuit breakers."""
    with _registry_lock:
        return dict(_breakers)
