"""
Timestamp Engine — Phase 5.

Provides authoritative UTC/IST timestamp handling for the data-service.

Responsibilities:
- UTC-internal storage; IST only for NSE session interpretation
- Clock skew detection (system vs expected)
- Future/past timestamp validation
- IST millisecond ↔ UTC second conversion
- All timestamp operations are centralized here

Usage:
    from src.engines.timestamp_engine import ts_engine
    ts_engine.utc_now_ms()
    ts_engine.validate_event_time(event_ms)
    ts_engine.ist_ms_to_utc_s(ts_ms_ist)
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import structlog

logger = structlog.get_logger(__name__)

# IST = UTC+5:30
_IST = ZoneInfo("Asia/Kolkata")
_IST_OFFSET_SECONDS: int = 5 * 3600 + 30 * 60  # 19800

# Clock skew thresholds
_CLOCK_SKEW_WARN_MS: int = 5_000       # 5s — warn
_CLOCK_SKEW_CRITICAL_MS: int = 30_000  # 30s — degrade data quality

# Timestamp validity bounds
_FUTURE_TOLERANCE_MS: int = 60_000    # 60s ahead of now → invalid
_PAST_MAX_MS: int = 7 * 24 * 3600 * 1000  # 7 days back → suspicious

# NSE session in UTC ms ranges
_NSE_PREOPEN_START_UTC_H = 3   # 03:45 UTC = 09:15 IST
_NSE_PREOPEN_START_UTC_M = 45
_NSE_SESSION_OPEN_UTC_H = 3    # 03:45 UTC = 09:15 IST
_NSE_SESSION_OPEN_UTC_M = 45
_NSE_SESSION_CLOSE_UTC_H = 10  # 10:00 UTC = 15:30 IST
_NSE_SESSION_CLOSE_UTC_M = 0


class TimestampEngine:
    """Centralized timestamp management.

    Thread-safe (reads only, no mutable state beyond last_skew_ms).
    """

    def __init__(self, skew_warn_ms: int = _CLOCK_SKEW_WARN_MS,
                 skew_critical_ms: int = _CLOCK_SKEW_CRITICAL_MS) -> None:
        self._skew_warn_ms = skew_warn_ms
        self._skew_critical_ms = skew_critical_ms
        self._last_skew_ms: int = 0
        self._skew_degraded: bool = False

    # ------------------------------------------------------------------
    # Core time accessors
    # ------------------------------------------------------------------

    def utc_now_ms(self) -> int:
        """Current UTC time in milliseconds."""
        return int(time.time() * 1000)

    def utc_now_s(self) -> int:
        """Current UTC time in seconds."""
        return int(time.time())

    def utc_now_iso(self) -> str:
        """Current UTC time as ISO 8601 with Z suffix."""
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    def utc_now_datetime(self) -> datetime:
        """Current UTC datetime (timezone-aware)."""
        return datetime.now(timezone.utc)

    def ist_now(self) -> datetime:
        """Current IST datetime (timezone-aware)."""
        return datetime.now(_IST)

    # ------------------------------------------------------------------
    # Conversions
    # ------------------------------------------------------------------

    def ist_ms_to_utc_s(self, ts_ms_ist: int | float) -> int:
        """Convert IST millisecond timestamp to UTC epoch-second integer.

        Formula: utc_epoch_s = int(ts_ms_ist / 1000) - 19800
        """
        return int(ts_ms_ist / 1000) - _IST_OFFSET_SECONDS

    def ist_ms_to_utc_ms(self, ts_ms_ist: int | float) -> int:
        """Convert IST millisecond timestamp to UTC milliseconds."""
        return int(ts_ms_ist) - (_IST_OFFSET_SECONDS * 1000)

    def utc_ms_to_datetime(self, utc_ms: int) -> datetime:
        """Convert UTC milliseconds to timezone-aware UTC datetime."""
        return datetime.fromtimestamp(utc_ms / 1000.0, tz=timezone.utc)

    def utc_ms_to_ist(self, utc_ms: int) -> datetime:
        """Convert UTC milliseconds to IST datetime."""
        return datetime.fromtimestamp(utc_ms / 1000.0, tz=_IST)

    def iso_to_utc_ms(self, iso_str: str) -> int | None:
        """Parse an ISO 8601 UTC string to milliseconds. Returns None on failure."""
        try:
            clean = iso_str.replace("Z", "+00:00")
            dt = datetime.fromisoformat(clean)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except (ValueError, AttributeError):
            return None

    def utc_ms_to_iso(self, utc_ms: int) -> str:
        """Convert UTC milliseconds to ISO 8601 string with Z suffix."""
        dt = self.utc_ms_to_datetime(utc_ms)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def validate_event_time(self, event_ms: int) -> tuple[bool, str]:
        """Validate an event timestamp against current time.

        Returns (is_valid, reason).
        """
        now_ms = self.utc_now_ms()
        diff = event_ms - now_ms

        if diff > _FUTURE_TOLERANCE_MS:
            return False, f"future_timestamp: event is {diff}ms ahead of now"
        if now_ms - event_ms > _PAST_MAX_MS:
            return False, f"very_old_timestamp: event is {(now_ms - event_ms) // 3600000}h old"
        return True, "ok"

    def is_future_timestamp(self, event_ms: int, tolerance_ms: int = _FUTURE_TOLERANCE_MS) -> bool:
        """Return True when event_ms is more than tolerance_ms ahead of now."""
        return event_ms > self.utc_now_ms() + tolerance_ms

    def is_stale_timestamp(self, event_ms: int, max_age_ms: int) -> bool:
        """Return True when event_ms is older than max_age_ms."""
        return (self.utc_now_ms() - event_ms) > max_age_ms

    # ------------------------------------------------------------------
    # Clock skew detection
    # ------------------------------------------------------------------

    def measure_skew(self, reference_utc_ms: int) -> int:
        """Compute skew between our clock and a reference UTC timestamp.

        Positive = our clock is ahead of reference.
        Negative = our clock is behind reference.
        """
        skew_ms = self.utc_now_ms() - reference_utc_ms
        self._last_skew_ms = skew_ms

        if abs(skew_ms) > self._skew_critical_ms:
            self._skew_degraded = True
            logger.warning(
                "clock_skew_critical",
                skew_ms=skew_ms,
                threshold_ms=self._skew_critical_ms,
            )
        elif abs(skew_ms) > self._skew_warn_ms:
            logger.warning("clock_skew_warn", skew_ms=skew_ms)

        return skew_ms

    @property
    def clock_skew_ms(self) -> int:
        """Last measured clock skew in milliseconds."""
        return self._last_skew_ms

    @property
    def is_clock_degraded(self) -> bool:
        """True when clock skew exceeds critical threshold.
        Callers should set DATA_QUALITY=DEGRADED when this is True."""
        return self._skew_degraded

    def reset_skew_state(self) -> None:
        """Reset the degraded flag (e.g. after NTP correction)."""
        self._skew_degraded = False
        self._last_skew_ms = 0

    # ------------------------------------------------------------------
    # NSE session helpers
    # ------------------------------------------------------------------

    def nse_trading_minutes_utc(self, dt: datetime) -> tuple[int, int]:
        """Return (start_minute, end_minute) of NSE regular session in UTC minutes.

        NSE session: 09:15–15:30 IST = 03:45–10:00 UTC.
        """
        return (
            _NSE_SESSION_OPEN_UTC_H * 60 + _NSE_SESSION_OPEN_UTC_M,
            _NSE_SESSION_CLOSE_UTC_H * 60 + _NSE_SESSION_CLOSE_UTC_M,
        )

    def is_within_nse_session(self, dt: datetime | None = None) -> bool:
        """Return True when dt (UTC) falls within NSE regular session 03:45–10:00 UTC."""
        if dt is None:
            dt = self.utc_now_datetime()
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        # Convert to UTC for comparison
        dt_utc = dt.astimezone(timezone.utc)
        current_minutes = dt_utc.hour * 60 + dt_utc.minute
        open_m = _NSE_SESSION_OPEN_UTC_H * 60 + _NSE_SESSION_OPEN_UTC_M
        close_m = _NSE_SESSION_CLOSE_UTC_H * 60 + _NSE_SESSION_CLOSE_UTC_M
        # Also check it's not a weekend (basic check — full check in MarketSessionEngine)
        if dt_utc.weekday() >= 5:  # Sat=5, Sun=6
            return False
        return open_m <= current_minutes < close_m

    def age_ms(self, timestamp_ms: int) -> int:
        """Return the age of a timestamp in milliseconds from now."""
        return max(0, self.utc_now_ms() - timestamp_ms)

    def candle_open_time_for_interval(self, interval_seconds: int) -> int:
        """Return the open-time (UTC ms) for the current candle at the given interval.

        NSE intraday candles are anchored to 09:15 IST.
        """
        now_ist = self.ist_now()
        # Anchor: 09:15:00 IST
        anchor_ist = now_ist.replace(
            hour=9, minute=15, second=0, microsecond=0
        )
        if now_ist < anchor_ist:
            # Before market open — no current intraday candle
            return 0
        elapsed_s = int((now_ist - anchor_ist).total_seconds())
        completed_intervals = elapsed_s // interval_seconds
        candle_open_ist = anchor_ist.replace(
            second=0, microsecond=0
        ).timestamp() + completed_intervals * interval_seconds
        # Convert IST epoch to UTC ms
        return int((candle_open_ist + _IST_OFFSET_SECONDS) * 1000
                   - _IST_OFFSET_SECONDS * 1000
                   )

    def format_age_human(self, age_ms: int) -> str:
        """Format an age in ms as a human-readable string."""
        if age_ms < 1000:
            return f"{age_ms}ms"
        if age_ms < 60_000:
            return f"{age_ms/1000:.1f}s"
        if age_ms < 3_600_000:
            return f"{age_ms/60000:.1f}m"
        return f"{age_ms/3600000:.1f}h"


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

ts_engine = TimestampEngine()
