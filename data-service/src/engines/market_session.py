"""
Market Session Engine — Phase 7.

Canonical NSE session management.
Handles pre-open, regular session, post-market, weekends, NSE holidays,
expiry days, and special sessions.

Key rule: Never infer market status using weekday alone.

Usage:
    from src.engines.market_session import market_session
    phase = market_session.session_phase()
    is_trading = market_session.is_trading_day()
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from enum import Enum
from typing import Optional
from zoneinfo import ZoneInfo

import structlog

logger = structlog.get_logger(__name__)

_IST = ZoneInfo("Asia/Kolkata")

# ---------------------------------------------------------------------------
# Session phases
# ---------------------------------------------------------------------------


class SessionPhase(str, Enum):
    PRE_OPEN = "PRE_OPEN"           # 09:00–09:08 IST
    PRE_OPEN_CALL_AUCTION = "PRE_OPEN_CALL_AUCTION"  # 09:08–09:15 IST
    REGULAR = "REGULAR"             # 09:15–15:30 IST
    POST_MARKET = "POST_MARKET"     # 15:30–16:00 IST
    CLOSED = "CLOSED"               # outside all sessions
    MUHURAT = "MUHURAT"             # special Diwali session
    UNKNOWN = "UNKNOWN"


# ---------------------------------------------------------------------------
# NSE session times (IST)
# ---------------------------------------------------------------------------

_SESSION_TIMES: dict[str, time] = {
    "preopen_start": time(9, 0),
    "preopen_call_auction": time(9, 8),
    "regular_open": time(9, 15),
    "regular_close": time(15, 30),
    "postmarket_close": time(16, 0),
}

# ---------------------------------------------------------------------------
# NSE Holidays (CY 2026 — update as required)
# We include a static list here; for production the service should fetch
# from NSE's official holiday API. The list below covers all known 2026 holidays.
# ---------------------------------------------------------------------------

_NSE_HOLIDAYS_2026: frozenset[date] = frozenset({
    date(2026, 1, 26),   # Republic Day
    date(2026, 2, 26),   # Maha Shivratri
    date(2026, 3, 13),   # Holi
    date(2026, 3, 30),   # Id-Ul-Fitr (Ramzan)
    date(2026, 4, 3),    # Good Friday
    date(2026, 4, 14),   # Dr. Ambedkar Jayanti
    date(2026, 5, 1),    # Maharashtra Day
    date(2026, 8, 15),   # Independence Day
    date(2026, 9, 3),    # Ganesh Chaturthi
    date(2026, 10, 2),   # Gandhi Jayanti
    date(2026, 10, 13),  # Dussehra
    date(2026, 10, 22),  # Diwali Laxmi Puja (tentative)
    date(2026, 10, 23),  # Diwali Balipratipada (tentative)
    date(2026, 11, 4),   # Gurunanak Jayanti
    date(2026, 12, 25),  # Christmas
})

_NSE_HOLIDAYS_2025: frozenset[date] = frozenset({
    date(2025, 1, 26),
    date(2025, 2, 26),
    date(2025, 3, 14),
    date(2025, 3, 31),
    date(2025, 4, 14),
    date(2025, 4, 18),
    date(2025, 5, 1),
    date(2025, 8, 15),
    date(2025, 9, 2),
    date(2025, 10, 2),
    date(2025, 10, 2),
    date(2025, 10, 22),  # Diwali
    date(2025, 11, 5),
    date(2025, 12, 25),
})

_ALL_NSE_HOLIDAYS: frozenset[date] = _NSE_HOLIDAYS_2025 | _NSE_HOLIDAYS_2026


class SessionInfo:
    """Snapshot of current market session state."""

    def __init__(
        self,
        isTradingDay: bool,
        phase: SessionPhase,
        sessionOpen: Optional[datetime],
        sessionClose: Optional[datetime],
        timeUntilCloseMs: Optional[int],
        isExpiryDay: bool,
        isHoliday: bool,
        holidayName: Optional[str],
    ) -> None:
        self.isTradingDay = isTradingDay
        self.phase = phase
        self.sessionOpen = sessionOpen
        self.sessionClose = sessionClose
        self.timeUntilCloseMs = timeUntilCloseMs
        self.isExpiryDay = isExpiryDay
        self.isHoliday = isHoliday
        self.holidayName = holidayName

    def as_dict(self) -> dict:
        return {
            "isTradingDay": self.isTradingDay,
            "phase": self.phase.value,
            "sessionOpen": self.sessionOpen.isoformat() if self.sessionOpen else None,
            "sessionClose": self.sessionClose.isoformat() if self.sessionClose else None,
            "timeUntilCloseMs": self.timeUntilCloseMs,
            "isExpiryDay": self.isExpiryDay,
            "isHoliday": self.isHoliday,
            "holidayName": self.holidayName,
        }


class MarketSessionEngine:
    """Canonical NSE market session manager."""

    def __init__(
        self,
        extra_holidays: Optional[frozenset[date]] = None,
    ) -> None:
        self._holidays: frozenset[date] = (
            _ALL_NSE_HOLIDAYS | (extra_holidays or frozenset())
        )

    def _ist_now(self) -> datetime:
        return datetime.now(_IST)

    def is_holiday(self, d: Optional[date] = None) -> bool:
        """Return True when d is an NSE holiday."""
        if d is None:
            d = self._ist_now().date()
        return d in self._holidays

    def is_weekend(self, d: Optional[date] = None) -> bool:
        """Return True when d is Saturday (5) or Sunday (6)."""
        if d is None:
            d = self._ist_now().date()
        return d.weekday() >= 5

    def is_trading_day(self, d: Optional[date] = None) -> bool:
        """Return True when d is a trading day (not weekend, not holiday).

        NEVER use weekday alone — always check the holiday calendar.
        """
        if d is None:
            d = self._ist_now().date()
        return not self.is_weekend(d) and not self.is_holiday(d)

    def session_phase(self, dt: Optional[datetime] = None) -> SessionPhase:
        """Return the current NSE session phase."""
        if dt is None:
            dt = self._ist_now()
        elif dt.tzinfo is None:
            dt = dt.replace(tzinfo=_IST)

        d = dt.date()
        if not self.is_trading_day(d):
            return SessionPhase.CLOSED

        t = dt.time()
        if t < _SESSION_TIMES["preopen_start"]:
            return SessionPhase.CLOSED
        if t < _SESSION_TIMES["preopen_call_auction"]:
            return SessionPhase.PRE_OPEN
        if t < _SESSION_TIMES["regular_open"]:
            return SessionPhase.PRE_OPEN_CALL_AUCTION
        if t < _SESSION_TIMES["regular_close"]:
            return SessionPhase.REGULAR
        if t < _SESSION_TIMES["postmarket_close"]:
            return SessionPhase.POST_MARKET
        return SessionPhase.CLOSED

    def is_regular_session(self, dt: Optional[datetime] = None) -> bool:
        """Return True during 09:15–15:30 IST on trading days."""
        return self.session_phase(dt) == SessionPhase.REGULAR

    def session_open_datetime(self, d: Optional[date] = None) -> Optional[datetime]:
        """Return the session open datetime for date d (or today)."""
        if d is None:
            d = self._ist_now().date()
        if not self.is_trading_day(d):
            return None
        return datetime.combine(d, _SESSION_TIMES["regular_open"], tzinfo=_IST)

    def session_close_datetime(self, d: Optional[date] = None) -> Optional[datetime]:
        """Return the session close datetime for date d (or today)."""
        if d is None:
            d = self._ist_now().date()
        if not self.is_trading_day(d):
            return None
        return datetime.combine(d, _SESSION_TIMES["regular_close"], tzinfo=_IST)

    def time_until_close_ms(self, dt: Optional[datetime] = None) -> Optional[int]:
        """Return milliseconds until regular session close, or None if closed."""
        if dt is None:
            dt = self._ist_now()
        close = self.session_close_datetime(dt.date())
        if close is None or dt >= close:
            return None
        return int((close - dt).total_seconds() * 1000)

    def get_session_info(self, dt: Optional[datetime] = None) -> SessionInfo:
        """Return a full SessionInfo snapshot."""
        if dt is None:
            dt = self._ist_now()
        d = dt.date()
        is_trading = self.is_trading_day(d)
        phase = self.session_phase(dt)
        is_holiday = self.is_holiday(d)

        return SessionInfo(
            isTradingDay=is_trading,
            phase=phase,
            sessionOpen=self.session_open_datetime(d),
            sessionClose=self.session_close_datetime(d),
            timeUntilCloseMs=self.time_until_close_ms(dt) if is_trading else None,
            isExpiryDay=self.is_expiry_day(d),
            isHoliday=is_holiday,
            holidayName=None,  # could be enriched with a holiday name map
        )

    def next_trading_day(self, d: Optional[date] = None) -> date:
        """Return the next trading day after d."""
        if d is None:
            d = self._ist_now().date()
        next_d = d + timedelta(days=1)
        while not self.is_trading_day(next_d):
            next_d += timedelta(days=1)
        return next_d

    def previous_trading_day(self, d: Optional[date] = None) -> date:
        """Return the most recent trading day before d."""
        if d is None:
            d = self._ist_now().date()
        prev_d = d - timedelta(days=1)
        while not self.is_trading_day(prev_d):
            prev_d -= timedelta(days=1)
        return prev_d

    def is_expiry_day(self, d: Optional[date] = None) -> bool:
        """Return True when d is a weekly or monthly F&O expiry day.

        NSE weekly expiry: Thursday (weekday=3).
        If Thursday is a holiday, expiry moves to Wednesday.
        """
        if d is None:
            d = self._ist_now().date()
        # Thursday check
        if d.weekday() == 3:
            return self.is_trading_day(d)
        # If Thursday next week is expiry but today is Wednesday and
        # Thursday is a holiday → Wednesday becomes expiry
        next_thursday = d + timedelta(days=(3 - d.weekday()) % 7 or 7)
        if d.weekday() == 2 and not self.is_trading_day(next_thursday):
            return self.is_trading_day(d)
        return False

    def days_until_expiry(self, d: Optional[date] = None) -> int:
        """Return days until the next weekly expiry from date d."""
        if d is None:
            d = self._ist_now().date()
        # Find next Thursday (or Wednesday if Thu is holiday)
        candidate = d
        for _ in range(14):
            candidate += timedelta(days=1)
            if self.is_expiry_day(candidate):
                return (candidate - d).days
        return -1

    def add_nse_holiday(self, holiday: date) -> None:
        """Dynamically add a holiday (e.g. from NSE holiday API response)."""
        self._holidays = self._holidays | {holiday}


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

market_session = MarketSessionEngine()
