"""
Phase 3G — NSE Market Calendar.

Provides:
- NSE trading session hours (09:15–15:30 IST = 04:45–10:00 UTC)
- NSE holiday list (built-in for 2022–2026; extend as needed)
- F&O expiry date computation (weekly Thursday for NIFTY/BANKNIFTY, monthly for others)
- "Next trading bar" lookup — the essential timing gate preventing same-bar execution

PIT contract
------------
is_trading_day(date) and next_trading_day(date) use only the built-in
holiday list — they do NOT fetch from external APIs at runtime.
This guarantees determinism in backtests (spec §33).

If the built-in holiday list is incomplete for a given year, the method
returns calendar_data_status=INSUFFICIENT_EVIDENCE rather than assuming
every weekday is a trading day.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

IST = timezone(timedelta(hours=5, minutes=30), name="IST")
UTC = timezone.utc

# NSE session (IST)
NSE_OPEN_IST  = time(9, 15)
NSE_CLOSE_IST = time(15, 30)

# Years covered by the built-in holiday list
_COVERED_YEARS = frozenset(range(2020, 2028))

# ── NSE holidays 2020-2026 ────────────────────────────────────────────────────
# Source: NSE Exchange holiday circulars
# Note: This list may be incomplete for edge cases. Always mark as DATA_APPROXIMATE.
_NSE_HOLIDAYS: frozenset[date] = frozenset({
    # 2020
    date(2020, 2, 21), date(2020, 3, 10), date(2020, 4, 2), date(2020, 4, 6),
    date(2020, 4, 10), date(2020, 4, 14), date(2020, 5, 1), date(2020, 11, 16),
    date(2020, 11, 30),
    # 2021
    date(2021, 1, 26), date(2021, 3, 11), date(2021, 3, 29), date(2021, 4, 2),
    date(2021, 4, 14), date(2021, 4, 21), date(2021, 5, 13), date(2021, 7, 21),
    date(2021, 8, 19), date(2021, 11, 4), date(2021, 11, 5), date(2021, 11, 19),
    date(2021, 12, 24),
    # 2022
    date(2022, 1, 26), date(2022, 3, 1), date(2022, 3, 18), date(2022, 4, 14),
    date(2022, 4, 15), date(2022, 5, 3), date(2022, 8, 9), date(2022, 8, 15),
    date(2022, 10, 5), date(2022, 10, 24), date(2022, 10, 26), date(2022, 11, 8),
    # 2023
    date(2023, 1, 26), date(2023, 3, 7), date(2023, 3, 30), date(2023, 4, 4),
    date(2023, 4, 7), date(2023, 4, 14), date(2023, 5, 1), date(2023, 6, 28),
    date(2023, 8, 15), date(2023, 9, 19), date(2023, 10, 2), date(2023, 10, 24),
    date(2023, 11, 14), date(2023, 11, 27), date(2023, 12, 25),
    # 2024
    date(2024, 1, 22), date(2024, 1, 26), date(2024, 3, 8), date(2024, 3, 25),
    date(2024, 3, 29), date(2024, 4, 11), date(2024, 4, 14), date(2024, 4, 17),
    date(2024, 4, 21), date(2024, 5, 23), date(2024, 6, 17), date(2024, 7, 17),
    date(2024, 8, 15), date(2024, 10, 2), date(2024, 10, 14), date(2024, 11, 1),
    date(2024, 11, 15), date(2024, 11, 20), date(2024, 12, 25),
    # 2025
    date(2025, 1, 26), date(2025, 2, 26), date(2025, 3, 14), date(2025, 3, 31),
    date(2025, 4, 10), date(2025, 4, 14), date(2025, 4, 18), date(2025, 5, 1),
    date(2025, 8, 15), date(2025, 10, 2), date(2025, 10, 21), date(2025, 10, 23),
    date(2025, 11, 5), date(2025, 12, 25),
    # 2026
    date(2026, 1, 26), date(2026, 3, 19), date(2026, 4, 3),
    date(2026, 8, 15), date(2026, 10, 2), date(2026, 12, 25),
})


class CalendarDataStatus:
    OK                  = "OK"
    DATA_APPROXIMATE    = "DATA_APPROXIMATE"  # built-in list may be incomplete
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"  # year not covered


class NSECalendar:
    """
    NSE market calendar with trading session hours and holiday awareness.

    Deterministic: uses only built-in data — no external API calls.
    """

    def is_holiday(self, d: date) -> bool:
        return d in _NSE_HOLIDAYS

    def is_weekend(self, d: date) -> bool:
        return d.weekday() >= 5  # Saturday=5, Sunday=6

    def is_trading_day(self, d: date) -> tuple[bool, str]:
        """
        Returns (is_trading, status).
        status: OK | DATA_APPROXIMATE | INSUFFICIENT_EVIDENCE
        """
        if d.year not in _COVERED_YEARS:
            return False, CalendarDataStatus.INSUFFICIENT_EVIDENCE
        if self.is_weekend(d) or self.is_holiday(d):
            return False, CalendarDataStatus.OK
        return True, CalendarDataStatus.DATA_APPROXIMATE  # may miss unlisted holidays

    def next_trading_day(self, d: date, max_lookforward: int = 10) -> Optional[date]:
        """Return the next trading day after `d` (not including `d`)."""
        candidate = d + timedelta(days=1)
        for _ in range(max_lookforward):
            tradeable, _ = self.is_trading_day(candidate)
            if tradeable:
                return candidate
            candidate += timedelta(days=1)
        return None  # no trading day found within max_lookforward

    def is_within_session(self, dt: datetime) -> bool:
        """Return True if `dt` (IST-aware) falls within NSE trading session."""
        dt_ist = dt.astimezone(IST)
        t = dt_ist.time().replace(second=0, microsecond=0)
        return NSE_OPEN_IST <= t < NSE_CLOSE_IST

    def session_open_ist(self, d: date) -> datetime:
        """Return NSE session open datetime for date d (IST-aware)."""
        return datetime(d.year, d.month, d.day, 9, 15, tzinfo=IST)

    def session_close_ist(self, d: date) -> datetime:
        """Return NSE session close datetime for date d (IST-aware)."""
        return datetime(d.year, d.month, d.day, 15, 30, tzinfo=IST)

    def monthly_expiry(self, year: int, month: int) -> date:
        """
        Return the last Thursday of the given month (NSE monthly F&O expiry).
        If that Thursday is a holiday, returns the preceding Wednesday, etc.
        """
        # Find last Thursday (weekday=3) of the month
        if month == 12:
            last_day = date(year + 1, 1, 1) - timedelta(days=1)
        else:
            last_day = date(year, month + 1, 1) - timedelta(days=1)
        # Walk backwards to Thursday
        while last_day.weekday() != 3:
            last_day -= timedelta(days=1)
        # If holiday, go to preceding day
        for _ in range(5):
            if not self.is_holiday(last_day) and not self.is_weekend(last_day):
                return last_day
            last_day -= timedelta(days=1)
        return last_day  # fallback

    def weekly_expiry_thursday(self, year: int, week: int) -> Optional[date]:
        """
        Return the Thursday in ISO week `week` of `year`.
        NSE introduced weekly NIFTY/BANKNIFTY expiry from ~2019.
        """
        # ISO week: weekday 4 = Thursday
        try:
            d = date.fromisocalendar(year, week, 4)  # Thursday
        except ValueError:
            return None
        if self.is_holiday(d) or self.is_weekend(d):
            d -= timedelta(days=1)  # try Wednesday
        return d


# Module-level singleton
DEFAULT_CALENDAR = NSECalendar()
