"""
Tests for TimestampEngine — Phase 5.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import pytest

from src.engines.timestamp_engine import TimestampEngine, ts_engine


class TestTimestampEngine:
    def test_utc_now_ms_is_close_to_system_time(self) -> None:
        system_ms = int(time.time() * 1000)
        engine_ms = ts_engine.utc_now_ms()
        assert abs(engine_ms - system_ms) < 100

    def test_ist_ms_to_utc_s_conversion(self) -> None:
        """Test IST ms → UTC s conversion using the NSE API convention.

        NSE charting API returns timestamps as milliseconds where the epoch
        is relative to IST (not UTC). So the conversion:
            utc_s = int(ts_ms / 1000) - 19800

        For example: NSE returns 1756944300000 for 09:15:00 IST on some date.
        That value = the UTC epoch seconds * 1000 (not IST-adjusted).
        The formula strips IST offset from the raw ms value.
        """
        # Verify the formula is applied correctly
        # An arbitrary IST ms from NSE (e.g. NSE returns epoch ms in UTC already
        # but the comment in the code says it's IST ms)
        # Test the formula directly: utc_s = int(ts_ms / 1000) - 19800
        ts_ms = 1_700_000_000_000  # arbitrary large ms value
        result = ts_engine.ist_ms_to_utc_s(ts_ms)
        expected = int(ts_ms / 1000) - 19800
        assert result == expected, f"Formula error: got {result}, expected {expected}"

    def test_ist_ms_to_utc_s_formula(self) -> None:
        # Formula: utc_s = int(ts_ms / 1000) - 19800
        ts_ms_ist = 1_750_000_000_000  # arbitrary
        expected = int(ts_ms_ist / 1000) - 19800
        assert ts_engine.ist_ms_to_utc_s(ts_ms_ist) == expected

    def test_utc_now_iso_format(self) -> None:
        iso = ts_engine.utc_now_iso()
        assert iso.endswith("Z")
        assert "T" in iso
        # Should parse correctly
        datetime.fromisoformat(iso.replace("Z", "+00:00"))

    def test_validate_event_time_future_rejected(self) -> None:
        future_ms = ts_engine.utc_now_ms() + 120_000  # 2 minutes ahead
        is_valid, reason = ts_engine.validate_event_time(future_ms)
        assert not is_valid
        assert "future" in reason

    def test_validate_event_time_recent_accepted(self) -> None:
        recent_ms = ts_engine.utc_now_ms() - 5_000  # 5 seconds ago
        is_valid, reason = ts_engine.validate_event_time(recent_ms)
        assert is_valid

    def test_validate_event_time_old_rejected(self) -> None:
        # 8 days ago (exceeds 7-day threshold)
        old_ms = ts_engine.utc_now_ms() - (8 * 24 * 3600 * 1000)
        is_valid, reason = ts_engine.validate_event_time(old_ms)
        assert not is_valid
        assert "old" in reason.lower() or "stale" in reason.lower()

    def test_age_ms_is_non_negative(self) -> None:
        past_ms = ts_engine.utc_now_ms() - 1000
        age = ts_engine.age_ms(past_ms)
        assert age >= 1000

    def test_age_ms_clamps_to_zero_for_future(self) -> None:
        future_ms = ts_engine.utc_now_ms() + 5000
        age = ts_engine.age_ms(future_ms)
        assert age == 0

    def test_clock_skew_warn_threshold(self) -> None:
        engine = TimestampEngine(skew_warn_ms=1_000, skew_critical_ms=10_000)
        # A reference that's exactly at our clock (no skew)
        reference = engine.utc_now_ms()
        skew = engine.measure_skew(reference)
        assert abs(skew) < 100  # should be near zero

    def test_clock_skew_critical_sets_degraded_flag(self) -> None:
        engine = TimestampEngine(skew_warn_ms=100, skew_critical_ms=200)
        # Simulate a reference that's 1 second ahead of us (we're behind)
        reference_ahead = engine.utc_now_ms() + 1_000
        engine.measure_skew(reference_ahead)
        assert engine.is_clock_degraded is True

    def test_reset_skew_state_clears_degraded(self) -> None:
        engine = TimestampEngine(skew_warn_ms=100, skew_critical_ms=200)
        reference_ahead = engine.utc_now_ms() + 1_000
        engine.measure_skew(reference_ahead)
        assert engine.is_clock_degraded
        engine.reset_skew_state()
        assert not engine.is_clock_degraded

    def test_is_future_timestamp(self) -> None:
        future = ts_engine.utc_now_ms() + 120_000
        assert ts_engine.is_future_timestamp(future)
        past = ts_engine.utc_now_ms() - 1000
        assert not ts_engine.is_future_timestamp(past)

    def test_is_stale_timestamp(self) -> None:
        old = ts_engine.utc_now_ms() - 20_000  # 20 seconds ago
        assert ts_engine.is_stale_timestamp(old, max_age_ms=10_000)  # 10s threshold
        recent = ts_engine.utc_now_ms() - 5_000  # 5 seconds ago
        assert not ts_engine.is_stale_timestamp(recent, max_age_ms=10_000)

    def test_iso_to_utc_ms_z_suffix(self) -> None:
        ms = ts_engine.iso_to_utc_ms("2025-09-03T09:15:00.000Z")
        assert ms is not None
        dt = ts_engine.utc_ms_to_datetime(ms)
        assert dt.year == 2025
        assert dt.month == 9
        assert dt.day == 3
        assert dt.hour == 9
        assert dt.minute == 15

    def test_iso_to_utc_ms_invalid_returns_none(self) -> None:
        result = ts_engine.iso_to_utc_ms("not-a-date")
        assert result is None

    def test_utc_ms_to_iso_roundtrip(self) -> None:
        original_ms = 1_788_434_580_000
        iso_str = ts_engine.utc_ms_to_iso(original_ms)
        recovered_ms = ts_engine.iso_to_utc_ms(iso_str)
        assert recovered_ms is not None
        # Allow 1ms rounding difference
        assert abs(recovered_ms - original_ms) <= 1

    def test_format_age_human(self) -> None:
        assert "ms" in ts_engine.format_age_human(500)
        assert "s" in ts_engine.format_age_human(5_000)
        assert "m" in ts_engine.format_age_human(90_000)
        assert "h" in ts_engine.format_age_human(3_700_000)
