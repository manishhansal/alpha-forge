"""
Historical cache-key, data-fingerprint and gap-repair helpers.

This module implements the cache-first / no-redundant-download / validated
gap-repair requirements (spec §15-17) as small, testable, provider-agnostic
functions. The historical route uses them to:

  1. Build a *provider-independent* deterministic cache key so identical
     requests (regardless of which provider ultimately served them) reuse the
     same cache entry.  (spec §16)
  2. Fingerprint acquired data so we can detect "already have this exact,
     validated data" and skip the provider entirely.  (spec §16)
  3. Detect gaps in an OHLCV series and coordinate a *validated* repair — every
     repaired candle must pass validation before it would be persisted.
     (spec §17)

It deliberately does not perform any network I/O itself; the caller supplies a
``repair_fetcher`` callable so the same logic works against Angel One / Upstox /
Yahoo (in that fallback order) and is trivially testable with fakes.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional, Sequence

import structlog

from src.schemas import OHLCVCandle

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Deterministic, provider-independent cache key + data fingerprint
# ---------------------------------------------------------------------------


def canonical_cache_key(exchange: str, symbol: str, interval: str, start: str, end: str) -> str:
    """Build a deterministic, provider-INDEPENDENT cache key.

    The key intentionally omits the provider: the same (instrument, timeframe,
    range) request must map to the same entry no matter whether Angel One,
    Upstox or Yahoo served it, so we never re-download data we already hold.
    """
    parts = [exchange.upper(), symbol.upper(), interval, start, end]
    return "hist:" + ":".join(parts)


def data_fingerprint(candles: Sequence[OHLCVCandle]) -> str:
    """Compute a deterministic SHA-256 fingerprint of an OHLCV series.

    Two byte-identical series produce the same fingerprint; used to detect that
    validated data already exists so the provider is never called again.
    """
    hasher = hashlib.sha256()
    for c in candles:
        oi = c.oi if c.oi is not None else 0
        hasher.update(
            f"{c.time}|{c.open:.4f}|{c.high:.4f}|{c.low:.4f}|{c.close:.4f}|{c.volume}|{oi};".encode()
        )
    return hasher.hexdigest()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def is_valid_candle(c: OHLCVCandle) -> bool:
    """OHLC price-invariant validation for a single candle."""
    if c.open <= 0 or c.high <= 0 or c.low <= 0 or c.close <= 0:
        return False
    if c.volume < 0:
        return False
    if c.high < max(c.open, c.close):
        return False
    if c.low > min(c.open, c.close):
        return False
    return True


def validate_series(candles: Sequence[OHLCVCandle]) -> tuple[list[OHLCVCandle], list[int]]:
    """Split a series into (valid_candles, invalid_indices)."""
    valid: list[OHLCVCandle] = []
    invalid: list[int] = []
    for i, c in enumerate(candles):
        if is_valid_candle(c):
            valid.append(c)
        else:
            invalid.append(i)
    return valid, invalid


# ---------------------------------------------------------------------------
# Gap detection
# ---------------------------------------------------------------------------

# Interval → seconds. Only the intervals the data-service serves.
_INTERVAL_SECONDS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "1d": 86_400,
}


@dataclass
class Gap:
    """A detected gap between two consecutive candles (UTC epoch seconds)."""

    after_time: int
    before_time: int
    missing_count: int


def detect_gaps(candles: Sequence[OHLCVCandle], interval: str) -> list[Gap]:
    """Detect gaps in a time-ordered OHLCV series.

    A gap is any place where consecutive candle timestamps differ by more than
    one interval step. For daily data (weekends/holidays) the caller should use
    a session-aware calendar; here we conservatively flag only clearly larger
    jumps (> 1.5 × interval) to avoid false positives from expected boundaries.
    """
    step = _INTERVAL_SECONDS.get(interval)
    if step is None or len(candles) < 2:
        return []

    ordered = sorted(candles, key=lambda c: c.time)
    gaps: list[Gap] = []
    for prev, cur in zip(ordered, ordered[1:]):
        delta = cur.time - prev.time
        if delta > step * 1.5:
            missing = max(1, int(delta / step) - 1)
            gaps.append(Gap(after_time=prev.time, before_time=cur.time, missing_count=missing))
    return gaps


# ---------------------------------------------------------------------------
# Validated gap repair
# ---------------------------------------------------------------------------

# A repair fetcher takes (from_epoch_s, to_epoch_s) and returns candles for the
# gap window. Providers are tried in order until one returns validatable data.
RepairFetcher = Callable[[int, int], Awaitable[Sequence[OHLCVCandle]]]


@dataclass
class RepairAttempt:
    """Audit record for a single gap-repair attempt (spec §17)."""

    provider: str
    gap_after: int
    gap_before: int
    result: str  # "repaired" | "no_data" | "invalid" | "error"
    error: Optional[str] = None
    filled_count: int = 0
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class RepairOutcome:
    candles: list[OHLCVCandle]
    attempts: list[RepairAttempt]
    repaired_count: int


async def repair_gaps(
    candles: Sequence[OHLCVCandle],
    interval: str,
    fetchers: Sequence[tuple[str, RepairFetcher]],
) -> RepairOutcome:
    """Detect and repair gaps, validating every repaired candle before use.

    ``fetchers`` is an ordered list of (provider_name, fetcher). For each gap we
    try the providers in order (e.g. Angel One → Upstox → Yahoo). Only candles
    that fall inside the gap window AND pass validation are merged in. Every
    attempt is recorded for lineage/audit. The returned series is de-duplicated
    on timestamp and time-ordered.

    This function performs NO persistence — it returns a validated, repaired
    series so the caller can persist it. That keeps "validate before persist"
    (spec §17) enforceable and the logic unit-testable.
    """
    attempts: list[RepairAttempt] = []
    gaps = detect_gaps(candles, interval)
    if not gaps:
        return RepairOutcome(candles=list(candles), attempts=attempts, repaired_count=0)

    by_time: dict[int, OHLCVCandle] = {c.time: c for c in candles}
    repaired_count = 0

    for gap in gaps:
        window_start = gap.after_time + 1
        window_end = gap.before_time - 1
        filled_this_gap = False

        for provider_name, fetcher in fetchers:
            if filled_this_gap:
                break
            try:
                fetched = await fetcher(window_start, window_end)
            except Exception as exc:  # provider failure is isolated per §4
                attempts.append(
                    RepairAttempt(
                        provider=provider_name,
                        gap_after=gap.after_time,
                        gap_before=gap.before_time,
                        result="error",
                        error=str(exc),
                    )
                )
                continue

            # Keep only in-window, validatable candles.
            candidates = [
                c
                for c in fetched
                if window_start <= c.time <= window_end and is_valid_candle(c)
            ]
            if not candidates:
                attempts.append(
                    RepairAttempt(
                        provider=provider_name,
                        gap_after=gap.after_time,
                        gap_before=gap.before_time,
                        result="no_data" if not fetched else "invalid",
                    )
                )
                continue

            added = 0
            for c in candidates:
                if c.time not in by_time:
                    by_time[c.time] = c
                    added += 1
            repaired_count += added
            filled_this_gap = True
            attempts.append(
                RepairAttempt(
                    provider=provider_name,
                    gap_after=gap.after_time,
                    gap_before=gap.before_time,
                    result="repaired",
                    filled_count=added,
                )
            )
            logger.info(
                "historical_gap_repaired",
                provider=provider_name,
                gap_after=gap.after_time,
                gap_before=gap.before_time,
                filled=added,
            )

    merged = sorted(by_time.values(), key=lambda c: c.time)
    return RepairOutcome(candles=merged, attempts=attempts, repaired_count=repaired_count)
