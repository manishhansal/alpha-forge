"""
Tests for MarketSessionEngine — Phase 7.
"""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from src.engines.market_session import (
    MarketSessionEngine,
    SessionPhase,
    market_session,
)

_IST = ZoneInfo("Asia/Kolkata")

# 2026-09-10 is a Thursday and NOT a holiday in the 2026 calendar
_TRADING_THURSDAY = date(2026, 9, 10)
_TRADING_THURSDAY_DT = lambda h, m: datetime(_TRADING_THURSDAY.year, _TRADING_THURSDAY.month, _TRADING_THURSDAY.day, h, m, 0, tzinfo=_IST)


class TestMarketSessionEngine:
    def test_weekday_not_alone_for_trading_day(self) -> None:
        """Never infer trading status from weekday alone."""
        # 2026-01-26 is Republic Day (NSE holiday) — it's a Monday
        engine = MarketSessionEngine()
        assert not engine.is_trading_day(date(2026, 1, 26))

    def test_weekend_is_not_trading_day(self) -> None:
        engine = MarketSessionEngine()
        assert not engine.is_trading_day(date(2026, 9, 5))   # Saturday
        assert not engine.is_trading_day(date(2026, 9, 6))   # Sunday

    def test_regular_weekday_non_holiday_is_trading_day(self) -> None:
        engine = MarketSessionEngine()
        assert engine.is_trading_day(_TRADING_THURSDAY)

    def test_pre_open_phase(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(9, 5)   # 09:05 IST
        assert engine.session_phase(dt) == SessionPhase.PRE_OPEN

    def test_pre_open_call_auction_phase(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(9, 10)  # 09:10 IST
        assert engine.session_phase(dt) == SessionPhase.PRE_OPEN_CALL_AUCTION

    def test_regular_session_phase(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(10, 30)  # 10:30 IST
        assert engine.session_phase(dt) == SessionPhase.REGULAR

    def test_post_market_phase(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(15, 40)  # 15:40 IST
        assert engine.session_phase(dt) == SessionPhase.POST_MARKET

    def test_closed_before_market(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(8, 50)  # before 09:00
        assert engine.session_phase(dt) == SessionPhase.CLOSED

    def test_closed_after_post_market(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(16, 10)  # after 16:00
        assert engine.session_phase(dt) == SessionPhase.CLOSED

    def test_closed_on_holiday(self) -> None:
        engine = MarketSessionEngine()
        dt = datetime(2026, 1, 26, 10, 30, 0, tzinfo=_IST)
        assert engine.session_phase(dt) == SessionPhase.CLOSED

    def test_is_regular_session(self) -> None:
        engine = MarketSessionEngine()
        assert engine.is_regular_session(_TRADING_THURSDAY_DT(11, 0))
        assert not engine.is_regular_session(_TRADING_THURSDAY_DT(8, 0))

    def test_session_open_datetime(self) -> None:
        engine = MarketSessionEngine()
        open_dt = engine.session_open_datetime(_TRADING_THURSDAY)
        assert open_dt is not None
        assert open_dt.hour == 9
        assert open_dt.minute == 15

    def test_session_open_none_on_holiday(self) -> None:
        engine = MarketSessionEngine()
        assert engine.session_open_datetime(date(2026, 1, 26)) is None

    def test_time_until_close_ms(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(15, 25)  # 5 minutes before close
        ttc = engine.time_until_close_ms(dt)
        assert ttc is not None
        assert 290_000 <= ttc <= 310_000

    def test_time_until_close_none_after_close(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(16, 0)
        assert engine.time_until_close_ms(dt) is None

    def test_next_trading_day_skips_weekend(self) -> None:
        engine = MarketSessionEngine()
        friday = date(2026, 9, 11)
        next_day = engine.next_trading_day(friday)
        assert next_day == date(2026, 9, 14)  # Monday

    def test_previous_trading_day_skips_weekend(self) -> None:
        engine = MarketSessionEngine()
        monday = date(2026, 9, 14)
        prev = engine.previous_trading_day(monday)
        assert prev == date(2026, 9, 11)  # Friday

    def test_expiry_day_thursday(self) -> None:
        engine = MarketSessionEngine()
        assert engine.is_expiry_day(_TRADING_THURSDAY)

    def test_non_expiry_day(self) -> None:
        engine = MarketSessionEngine()
        assert not engine.is_expiry_day(date(2026, 9, 8))  # Tuesday

    def test_get_session_info_structure(self) -> None:
        engine = MarketSessionEngine()
        dt = _TRADING_THURSDAY_DT(10, 0)
        info = engine.get_session_info(dt)
        assert info.isTradingDay
        assert info.phase == SessionPhase.REGULAR
        assert info.sessionOpen is not None
        assert info.sessionClose is not None
        assert isinstance(info.as_dict(), dict)

    def test_add_custom_holiday(self) -> None:
        engine = MarketSessionEngine()
        custom_holiday = date(2026, 7, 15)
        engine.add_nse_holiday(custom_holiday)
        assert not engine.is_trading_day(custom_holiday)
