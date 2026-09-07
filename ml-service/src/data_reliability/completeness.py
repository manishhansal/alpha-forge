"""
Phase 3Q — Bar completeness + FORMING_BAR vs CLOSED_BAR (spec §8).

This distinction did not exist anywhere in the codebase and is safety-critical: an
incomplete current candle must NEVER be treated as a completed historical candle
(§8, §44). This module reports, for a chronological bar series and an interval,
the expected/observed/missing/duplicate/out-of-order structure and classifies the
LAST bar as FORMING or CLOSED relative to `now`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc

# Canonical bar interval seconds (spec §8). Daily is a marker (session-based, not
# a fixed second-grid) and is handled specially.
INTERVAL_SECONDS: dict[str, int] = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
    "1d": 86400,
}


class BarState(str, Enum):
    CLOSED_BAR  = "CLOSED_BAR"    # bar interval has fully elapsed
    FORMING_BAR = "FORMING_BAR"   # current interval still in progress
    UNKNOWN     = "UNKNOWN"


class CompletenessStatus(str, Enum):
    COMPLETE     = "COMPLETE"
    INCOMPLETE   = "INCOMPLETE"     # missing / out-of-order / duplicate bars
    UNAVAILABLE  = "UNAVAILABLE"    # no bars / unusable interval


@dataclass
class CompletenessReport:
    instrument:      str
    timeframe:       str
    status:          str            # CompletenessStatus value
    expected_bars:   Optional[int] = None
    observed_bars:   int = 0
    missing_bars:    int = 0
    duplicate_bars:  int = 0
    out_of_order:    int = 0
    last_bar_state:  str = BarState.UNKNOWN.value
    gaps:            list[int] = field(default_factory=list)   # missing bar indices
    detail:          str = ""

    @property
    def is_complete(self) -> bool:
        return self.status == CompletenessStatus.COMPLETE.value

    def to_dict(self) -> dict:
        return {"instrument": self.instrument, "timeframe": self.timeframe,
                "status": self.status, "expected_bars": self.expected_bars,
                "observed_bars": self.observed_bars, "missing_bars": self.missing_bars,
                "duplicate_bars": self.duplicate_bars, "out_of_order": self.out_of_order,
                "last_bar_state": self.last_bar_state, "gaps": self.gaps,
                "detail": self.detail}


def _epoch(ts) -> Optional[float]:
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


def classify_last_bar_state(last_bar_start_epoch: float, timeframe: str,
                            now: Optional[datetime] = None) -> BarState:
    """
    Classify the final bar as CLOSED or FORMING (spec §8). A bar is CLOSED only
    once its full interval has elapsed relative to `now`; otherwise it is FORMING
    and must not be used where a closed bar is required.
    """
    step = INTERVAL_SECONDS.get(timeframe)
    if step is None:
        return BarState.UNKNOWN
    ref = (now or datetime.now(UTC)).timestamp()
    return BarState.CLOSED_BAR if ref >= last_bar_start_epoch + step else BarState.FORMING_BAR


def assess_completeness(bars: list[dict], timeframe: str, instrument: str = "",
                        now: Optional[datetime] = None,
                        expected_start: Optional[datetime] = None,
                        expected_end: Optional[datetime] = None) -> CompletenessReport:
    """
    Assess a chronological OHLCV bar series for completeness on `timeframe`.
    Detects missing / duplicate / out-of-order bars against the expected grid,
    and classifies the last bar FORMING vs CLOSED. Fail-closed: an unknown
    interval or empty series → UNAVAILABLE.
    """
    step = INTERVAL_SECONDS.get(timeframe)
    if step is None:
        return CompletenessReport(instrument, timeframe,
                                  CompletenessStatus.UNAVAILABLE.value,
                                  detail=f"unknown interval {timeframe!r}")
    epochs = [_epoch(b.get("timestamp")) for b in bars]
    epochs = [e for e in epochs if e is not None]
    if not epochs:
        return CompletenessReport(instrument, timeframe,
                                  CompletenessStatus.UNAVAILABLE.value,
                                  observed_bars=0, detail="no usable timestamps")

    # duplicates + out-of-order
    seen: set = set()
    duplicate = 0
    out_of_order = 0
    prev = None
    for e in epochs:
        if e in seen:
            duplicate += 1
        seen.add(e)
        if prev is not None and e < prev:
            out_of_order += 1
        prev = e

    uniq = sorted(seen)
    # expected grid: from expected_start (or first bar) to expected_end (or last bar)
    grid_start = _epoch(expected_start) if expected_start else uniq[0]
    grid_end = _epoch(expected_end) if expected_end else uniq[-1]
    expected = int((grid_end - grid_start) / step) + 1 if grid_end >= grid_start else 0

    present = set(uniq)
    gaps = []
    t = grid_start
    idx = 0
    while t <= grid_end and timeframe != "1d":   # daily grid is session-based, skip strict gap-fill
        if t not in present:
            gaps.append(idx)
        t += step
        idx += 1
    missing = len(gaps)

    last_state = classify_last_bar_state(uniq[-1], timeframe, now)

    if timeframe == "1d":
        status = CompletenessStatus.COMPLETE.value if (duplicate == 0 and out_of_order == 0) \
                 else CompletenessStatus.INCOMPLETE.value
    else:
        status = (CompletenessStatus.COMPLETE.value
                  if (missing == 0 and duplicate == 0 and out_of_order == 0)
                  else CompletenessStatus.INCOMPLETE.value)

    return CompletenessReport(
        instrument=instrument, timeframe=timeframe, status=status,
        expected_bars=(expected if timeframe != "1d" else None),
        observed_bars=len(uniq), missing_bars=missing, duplicate_bars=duplicate,
        out_of_order=out_of_order, last_bar_state=last_state.value, gaps=gaps,
        detail="")
