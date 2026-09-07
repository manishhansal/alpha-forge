"""
Phase 3Q — Bounded retry / backoff (spec §18, §29).

Deterministic, bounded retry with exponential backoff. Retryability is decided by
the Phase 3Q failure taxonomy (`failure.is_retryable`) — auth failures and
malformed payloads are NEVER retried. The backoff SCHEDULE is computed
deterministically (no real sleeping in the policy itself, so it is testable and
never causes a retry storm); the caller performs the actual wait.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional

from .failure import ProviderFailure, is_retryable


@dataclass(frozen=True)
class RetryPolicy:
    """Bounded retry configuration (spec §18). All limits explicit and finite."""
    max_attempts:  int = 3            # total attempts incl. the first
    base_delay_s:  float = 0.5
    max_delay_s:   float = 8.0
    multiplier:    float = 2.0
    version:       str = "3q-retry-policy-v1"

    def delay_for(self, attempt: int) -> float:
        """Deterministic backoff for a 1-indexed attempt, capped at max_delay_s."""
        if attempt <= 1:
            return 0.0
        d = self.base_delay_s * (self.multiplier ** (attempt - 2))
        return min(d, self.max_delay_s)

    def schedule(self) -> list[float]:
        """The full deterministic delay schedule (no storms — bounded + capped)."""
        return [self.delay_for(a) for a in range(1, self.max_attempts + 1)]


class RetryTermination(str, Enum):
    SUCCESS         = "SUCCESS"
    EXHAUSTED       = "EXHAUSTED"        # ran out of attempts
    NON_RETRYABLE   = "NON_RETRYABLE"    # failure type is not retryable (auth/malformed)


@dataclass
class RetryOutcome:
    termination:  str            # RetryTermination value
    attempts:     int
    last_failure: str            # ProviderFailure value
    delays:       list[float]

    @property
    def succeeded(self) -> bool:
        return self.termination == RetryTermination.SUCCESS.value

    def to_dict(self) -> dict:
        return {"termination": self.termination, "attempts": self.attempts,
                "last_failure": self.last_failure, "delays": self.delays}


def retry_with_backoff(
    attempt_fn: Callable[[int], ProviderFailure],
    policy: Optional[RetryPolicy] = None,
    sleep: Optional[Callable[[float], None]] = None,
) -> RetryOutcome:
    """
    Call `attempt_fn(attempt_index)` up to `policy.max_attempts` times. Stops
    immediately on OK (SUCCESS) or a NON_RETRYABLE failure (auth/malformed) — never
    retries those (spec §18). `sleep` (default: no-op) is invoked with the backoff
    delay between attempts so tests stay fast and there is no retry storm.
    """
    pol = policy or RetryPolicy()
    _sleep = sleep or (lambda _s: None)
    delays: list[float] = []
    last = ProviderFailure.UNKNOWN_PROVIDER_ERROR

    for attempt in range(1, pol.max_attempts + 1):
        outcome = ProviderFailure(attempt_fn(attempt))
        last = outcome
        if outcome == ProviderFailure.OK:
            return RetryOutcome(RetryTermination.SUCCESS.value, attempt, outcome.value, delays)
        if not is_retryable(outcome):
            return RetryOutcome(RetryTermination.NON_RETRYABLE.value, attempt, outcome.value, delays)
        if attempt < pol.max_attempts:
            d = pol.delay_for(attempt + 1)
            delays.append(d)
            _sleep(d)

    return RetryOutcome(RetryTermination.EXHAUSTED.value, pol.max_attempts, last.value, delays)
