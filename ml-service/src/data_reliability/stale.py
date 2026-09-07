"""
Phase 3Q — Stale-data detection (spec §5).

A datum is NOT "live" merely because an API call succeeded. The existing
`paper.data_quality` provides freshness-by-age (delayed/missing/future via
FreshnessPolicy + validate_ohlcv_bars). This module ADDS the two detectors that
were missing: FROZEN feed (repeated identical bars) and value REGRESSION
(a series that jumps backwards in time / a timestamp that regresses), and rolls
the whole picture into a single StaleReason verdict.

Fail-closed: when the market is open and the latest expected bar is missing beyond
the grace period, or a feed is frozen/regressing, the verdict is DATA_STALE and a
high-confidence decision MUST NOT be produced from it (§5).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


class StaleReason(str, Enum):
    FRESH             = "FRESH"
    FROZEN_FEED       = "FROZEN_FEED"        # N identical consecutive bars
    REPEATED_BAR      = "REPEATED_BAR"       # exact duplicate of prior bar
    DELAYED           = "DELAYED"            # age beyond freshness policy
    MISSING_BAR       = "MISSING_BAR"        # expected bar absent past grace
    FUTURE_TIMESTAMP  = "FUTURE_TIMESTAMP"   # market_ts ahead of now
    TIMESTAMP_REGRESSION = "TIMESTAMP_REGRESSION"  # ts went backwards
    UNAVAILABLE       = "UNAVAILABLE"


@dataclass
class StaleAssessment:
    reason:       str            # StaleReason value
    is_stale:     bool
    detail:       str = ""
    n_repeated:   int = 0

    def to_dict(self) -> dict:
        return {"reason": self.reason, "is_stale": self.is_stale,
                "detail": self.detail, "n_repeated": self.n_repeated}


def _bar_signature(bar: dict) -> tuple:
    return (bar.get("open"), bar.get("high"), bar.get("low"),
            bar.get("close"), bar.get("volume"))


def detect_frozen_feed(bars: list[dict], min_repeats: int = 3) -> StaleAssessment:
    """
    Frozen feed: `min_repeats`+ consecutive bars with identical OHLCV (spec §5).
    Distinct from the existing zero-volume heuristic — this catches a stuck feed
    even at non-zero volume. Returns FRESH if no run reaches the threshold.
    """
    if not bars:
        return StaleAssessment(StaleReason.UNAVAILABLE.value, True, "no bars")
    run = 1
    max_run = 1
    for i in range(1, len(bars)):
        if _bar_signature(bars[i]) == _bar_signature(bars[i - 1]):
            run += 1
            max_run = max(max_run, run)
        else:
            run = 1
    if max_run >= min_repeats:
        return StaleAssessment(StaleReason.FROZEN_FEED.value, True,
                               f"{max_run} identical consecutive bars", n_repeated=max_run)
    return StaleAssessment(StaleReason.FRESH.value, False, "", n_repeated=max_run)


def detect_timestamp_regression(bars: list[dict]) -> StaleAssessment:
    """
    Timestamp regression: a bar whose timestamp is earlier than a prior bar
    (spec §5). Uses epoch seconds; missing timestamps are ignored here (the OHLCV
    validator flags those separately). Fail-closed on the first regression.
    """
    prev = None
    for i, bar in enumerate(bars):
        ts = _to_epoch(bar.get("timestamp"))
        if ts is None:
            continue
        if prev is not None and ts < prev:
            return StaleAssessment(StaleReason.TIMESTAMP_REGRESSION.value, True,
                                   f"bar {i} ts {ts} < prev {prev}")
        prev = ts
    return StaleAssessment(StaleReason.FRESH.value, False)


def assess_staleness(
    timeframe: str,
    market_timestamp: Optional[datetime],
    bars: Optional[list[dict]] = None,
    now: Optional[datetime] = None,
    market_open: bool = True,
    freshness_policy=None,
) -> StaleAssessment:
    """
    Single staleness verdict combining age (delayed/future/missing), frozen-feed
    and timestamp-regression. Precedence (fail-closed): future > regression >
    frozen > delayed/missing > fresh. When the market is CLOSED, age-based
    staleness is not raised (a quiet feed is expected), but frozen/regression
    structural problems still are.
    """
    ref = now or datetime.now(UTC)

    if market_timestamp is None:
        return StaleAssessment(StaleReason.UNAVAILABLE.value, True, "no market timestamp")

    # future timestamp is always wrong
    if market_timestamp > ref:
        return StaleAssessment(StaleReason.FUTURE_TIMESTAMP.value, True,
                               f"market_ts {market_timestamp.isoformat()} > now {ref.isoformat()}")

    if bars:
        reg = detect_timestamp_regression(bars)
        if reg.is_stale:
            return reg
        frozen = detect_frozen_feed(bars)
        if frozen.is_stale:
            return frozen

    if market_open:
        from src.paper.data_quality import classify_freshness, Freshness
        fresh, age = classify_freshness(timeframe, market_timestamp, ref, freshness_policy)
        if fresh == Freshness.STALE:
            return StaleAssessment(StaleReason.DELAYED.value, True,
                                   f"age {age:.0f}s exceeds {timeframe} stale threshold")
        if fresh == Freshness.UNAVAILABLE:
            return StaleAssessment(StaleReason.UNAVAILABLE.value, True, "freshness unavailable")

    return StaleAssessment(StaleReason.FRESH.value, False)


def _to_epoch(ts) -> Optional[float]:
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return float(ts)
    if isinstance(ts, datetime):
        return ts.timestamp()
    try:
        return datetime.fromisoformat(str(ts)).timestamp()
    except ValueError:
        return None
