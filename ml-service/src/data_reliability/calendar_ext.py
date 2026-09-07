"""
Phase 3Q — Market-calendar extension (spec §6).

The existing `execution.market_calendar.NSECalendar` already answers is_open /
is_holiday / next_trading_day / expiry. It does NOT expose `prev_trading_session`
or a "is this timestamp a valid market bar?" check, and does not special-case
Muhurat trading. This module ADDS exactly those, reusing NSECalendar underneath —
it never reimplements holiday data.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

# NSE Muhurat (Diwali) special one-hour evening sessions — known dates (IST).
# Kept as an explicit, auditable set; never inferred.
_MUHURAT_SESSIONS: frozenset[date] = frozenset({
    date(2023, 11, 12), date(2024, 11, 1), date(2025, 10, 21),
})


def _calendar(cal=None):
    if cal is not None:
        return cal
    from src.execution.market_calendar import DEFAULT_CALENDAR
    return DEFAULT_CALENDAR


def is_muhurat_session(d: date) -> bool:
    """Explicit Muhurat-day check (spec §6). Never inferred from weekday."""
    return d in _MUHURAT_SESSIONS


def prev_trading_session(d: date, cal=None, max_lookback: int = 10) -> Optional[date]:
    """
    Previous valid trading day strictly before `d` (spec §6). Returns None if the
    calendar has no coverage in the lookback window (fail-closed, never guesses).
    """
    cal = _calendar(cal)
    candidate = d - timedelta(days=1)
    for _ in range(max_lookback):
        tradeable, status = cal.is_trading_day(candidate)
        if status == "INSUFFICIENT_EVIDENCE":
            return None
        if tradeable:
            return candidate
        candidate -= timedelta(days=1)
    return None


@dataclass
class BarValidity:
    """Result of checking whether a timestamp is a valid NSE market bar (spec §6)."""
    valid:        bool
    reason:       str
    session:      str = ""       # SessionType value from paper.data_quality
    calendar_status: str = ""


def is_valid_market_bar(dt: datetime, cal=None) -> BarValidity:
    """
    Is `dt` a valid regular-session NSE bar timestamp? Fail-closed:
      • naive datetime         → invalid (NAIVE_TIMESTAMP)
      • uncovered calendar year → invalid (CALENDAR_INSUFFICIENT_EVIDENCE)
      • weekend / holiday       → invalid (NON_TRADING_DAY)
      • outside 09:15–15:30 IST → invalid (OUTSIDE_SESSION)
    Reuses the existing `classify_session` so calendar logic is not duplicated.
    """
    if dt.tzinfo is None:
        return BarValidity(False, "NAIVE_TIMESTAMP")
    from src.paper.data_quality import classify_session, SessionType
    sc = classify_session(dt, cal)
    if sc.session == SessionType.UNKNOWN.value:
        return BarValidity(False, "CALENDAR_INSUFFICIENT_EVIDENCE",
                           sc.session, sc.calendar_status)
    if sc.session in (SessionType.WEEKEND.value, SessionType.HOLIDAY.value):
        return BarValidity(False, "NON_TRADING_DAY", sc.session, sc.calendar_status)
    if sc.session != SessionType.REGULAR.value:
        return BarValidity(False, "OUTSIDE_REGULAR_SESSION", sc.session, sc.calendar_status)
    return BarValidity(True, "OK", sc.session, sc.calendar_status)
