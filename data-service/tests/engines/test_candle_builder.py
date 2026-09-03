"""
Tests for CandleBuilderV2 — Phases 25-28.

Tests OHLC invariants, OPEN/PARTIAL/CLOSED states,
09:15 IST anchor, and multi-timeframe derivation.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from src.core.schemas_v2 import CandleState, CandleV2
from src.engines.candle_builder import (
    CandleBuilderV2,
    LiveCandle,
    _candle_open_time_utc_s,
    derive_higher_timeframe,
)

_IST = ZoneInfo("Asia/Kolkata")


def _ist_ms(h: int, m: int, s: int = 0, year: int = 2026, month: int = 9, day: int = 3) -> int:
    """Build IST datetime as UTC milliseconds."""
    dt = datetime(year, month, day, h, m, s, tzinfo=_IST)
    return int(dt.timestamp() * 1000)


class TestCandleOpenTime:
    def test_anchor_at_0915_ist(self) -> None:
        # Tick at exactly 09:15:00 IST → candle open = 09:15:00 IST
        tick_ms = _ist_ms(9, 15, 0)
        open_s = _candle_open_time_utc_s(tick_ms, 300)  # 5m
        dt = datetime.fromtimestamp(open_s, tz=_IST)
        assert dt.hour == 9
        assert dt.minute == 15
        assert dt.second == 0

    def test_tick_at_0920_falls_in_0920_5m_candle(self) -> None:
        """09:20 is the start of the second 5m candle (09:20-09:25)."""
        tick_ms = _ist_ms(9, 20, 0)
        open_s = _candle_open_time_utc_s(tick_ms, 300)
        dt = datetime.fromtimestamp(open_s, tz=_IST)
        assert dt.hour == 9
        assert dt.minute == 20  # 09:20 is the 2nd 5m candle, not 09:15

    def test_tick_at_0919_falls_in_0915_5m_candle(self) -> None:
        """09:19 is within the first 5m candle (09:15-09:20)."""
        tick_ms = _ist_ms(9, 19, 0)
        open_s = _candle_open_time_utc_s(tick_ms, 300)
        dt = datetime.fromtimestamp(open_s, tz=_IST)
        assert dt.hour == 9
        assert dt.minute == 15  # 09:19 falls in 09:15 candle

    def test_tick_at_0921_falls_in_0920_5m_candle(self) -> None:
        tick_ms = _ist_ms(9, 21, 0)
        open_s = _candle_open_time_utc_s(tick_ms, 300)
        dt = datetime.fromtimestamp(open_s, tz=_IST)
        assert dt.hour == 9
        assert dt.minute == 20

    def test_1m_candles_align_to_0915(self) -> None:
        tick_ms = _ist_ms(9, 16, 30)
        open_s = _candle_open_time_utc_s(tick_ms, 60)
        dt = datetime.fromtimestamp(open_s, tz=_IST)
        assert dt.hour == 9
        assert dt.minute == 16

    def test_15m_candles_align_to_0915(self) -> None:
        tick_ms = _ist_ms(9, 25, 0)  # 10 minutes into session
        open_s = _candle_open_time_utc_s(tick_ms, 900)  # 15m
        dt = datetime.fromtimestamp(open_s, tz=_IST)
        assert dt.hour == 9
        assert dt.minute == 15


class TestLiveCandle:
    def _make_candle(self) -> LiveCandle:
        return LiveCandle(
            instrument_id="NSE:NIFTY",
            symbol="NIFTY",
            exchange="NSE",
            interval="5m",
            open_time_s=_candle_open_time_utc_s(_ist_ms(9, 15, 0), 300),
        )

    def test_initial_state_is_open(self) -> None:
        c = self._make_candle()
        assert c.state == CandleState.OPEN
        assert c.is_empty

    def test_first_tick_sets_ohlc(self) -> None:
        c = self._make_candle()
        c.update(24850.0)
        assert c.state == CandleState.PARTIAL
        assert not c.is_empty

    def test_high_tracks_maximum(self) -> None:
        c = self._make_candle()
        c.update(24850.0)
        c.update(24900.0)
        c.update(24820.0)
        partial = c.as_partial()
        assert partial is not None
        assert partial.high == 24900.0
        assert partial.low == 24820.0

    def test_ohlc_invariant_maintained_on_seal(self) -> None:
        c = self._make_candle()
        c.update(24850.0)
        c.update(24900.0)
        c.update(24820.0)
        c.update(24880.0)
        sealed = c.seal()
        assert sealed is not None
        assert sealed.high >= max(sealed.open, sealed.close)
        assert sealed.low <= min(sealed.open, sealed.close)
        assert sealed.state == CandleState.CLOSED
        assert sealed.isComplete

    def test_seal_returns_none_for_empty_candle(self) -> None:
        c = self._make_candle()
        assert c.seal() is None

    def test_volume_accumulates(self) -> None:
        c = self._make_candle()
        c.update(24850.0, volume=100)
        c.update(24860.0, volume=200)
        c.update(24870.0, volume=150)
        partial = c.as_partial()
        assert partial is not None
        assert partial.volume == 450

    def test_non_positive_price_skipped(self) -> None:
        c = self._make_candle()
        c.update(0.0)  # Should be skipped
        c.update(-100.0)  # Should be skipped
        assert c.is_empty

    def test_partial_state_is_not_complete(self) -> None:
        c = self._make_candle()
        c.update(24850.0)
        partial = c.as_partial()
        assert partial is not None
        assert not partial.isComplete
        assert partial.state == CandleState.PARTIAL


class TestCandleBuilderV2:
    def test_builder_creates_candle_on_slot_advance(self) -> None:
        builder = CandleBuilderV2("NSE:NIFTY", "5m", symbol="NIFTY")
        # Tick in slot 1
        t1 = _ist_ms(9, 16, 0)
        closed, partial = builder.update(24850.0, t1, volume=1000)
        assert closed is None  # First tick, no closed candle yet

        # Tick in slot 2 (forces slot 1 to close)
        t2 = _ist_ms(9, 21, 0)  # New 5m slot
        closed, partial = builder.update(24900.0, t2, volume=2000)
        assert closed is not None
        assert closed.state == CandleState.CLOSED
        assert closed.isComplete
        assert closed.open == 24850.0

    def test_partial_candle_returned_on_update(self) -> None:
        builder = CandleBuilderV2("NSE:NIFTY", "1m", symbol="NIFTY")
        t = _ist_ms(9, 15, 30)
        closed, partial = builder.update(24850.0, t)
        assert closed is None
        assert partial is not None
        assert partial.state == CandleState.PARTIAL

    def test_force_seal(self) -> None:
        builder = CandleBuilderV2("NSE:NIFTY", "5m", symbol="NIFTY")
        t = _ist_ms(9, 15, 30)
        builder.update(24850.0, t, volume=500)
        sealed = builder.force_seal()
        assert sealed is not None
        assert sealed.state == CandleState.CLOSED

    def test_invalid_interval_raises(self) -> None:
        with pytest.raises(ValueError, match="Unsupported interval"):
            CandleBuilderV2("NSE:NIFTY", "2m")

    def test_total_closed_increments(self) -> None:
        builder = CandleBuilderV2("NSE:NIFTY", "1m", symbol="NIFTY")
        t1 = _ist_ms(9, 15, 0)
        builder.update(24850.0, t1)
        t2 = _ist_ms(9, 16, 0)
        builder.update(24860.0, t2)
        assert builder.total_closed == 1

    def test_candle_v2_ohlc_validation_on_seal(self) -> None:
        """CandleV2 model must reject impossible candles."""
        # Directly test the CandleV2 validator
        with pytest.raises(ValueError):
            CandleV2(
                instrumentId="NSE:NIFTY",
                symbol="NIFTY",
                exchange="NSE",
                interval="5m",
                time=1_000_000,
                open=24850.0,
                high=24800.0,  # high < open — INVALID
                low=24700.0,
                close=24830.0,
                volume=1000,
            )


class TestDeriveHigherTimeframe:
    def _make_candle(self, open_time_s: int, close_p: float = 24850.0) -> CandleV2:
        return CandleV2(
            instrumentId="NSE:NIFTY",
            symbol="NIFTY",
            exchange="NSE",
            interval="1m",
            time=open_time_s,
            open=24800.0,
            high=24900.0,
            low=24750.0,
            close=close_p,
            volume=10000,
        )

    def test_derive_5m_from_1m(self) -> None:
        """5 x 1m candles should produce 1 x 5m candle."""
        # Create 5 consecutive 1m candles starting at 09:15 IST
        # Open time for 09:15 IST: use anchor
        base_s = _candle_open_time_utc_s(_ist_ms(9, 15, 0), 60)
        candles = [self._make_candle(base_s + i * 60, close_p=24850.0 + i * 5) for i in range(5)]
        derived = derive_higher_timeframe(candles, "5m")
        assert len(derived) >= 1
        d = derived[0]
        assert d.interval == "5m"
        assert d.sourceInterval == "1m"
        assert d.volume == 50000  # 5 * 10000
        # Open of first candle, close of last
        assert d.open == candles[0].open
        assert d.close == candles[-1].close

    def test_derived_candle_has_correct_high_low(self) -> None:
        base_s = _candle_open_time_utc_s(_ist_ms(9, 15, 0), 60)
        candles = [
            CandleV2(instrumentId="NSE:NIFTY", symbol="NIFTY", exchange="NSE",
                     interval="1m", time=base_s + i * 60,
                     open=24800.0, high=24800.0 + (i + 1) * 50, low=24700.0,
                     close=24800.0, volume=1000)
            for i in range(3)
        ]
        derived = derive_higher_timeframe(candles, "15m")
        assert len(derived) >= 1
        d = derived[0]
        # High should be the maximum of all highs
        expected_high = max(c.high for c in candles)
        assert d.high == expected_high
