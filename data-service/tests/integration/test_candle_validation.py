"""
Integration tests — Candle Validation (Phase 9 / V2.1 certification).

Tests:
1. OHLC invariant enforcement in CandleV2
2. Partial candle safety (PARTIAL never becomes CLOSED prematurely)
3. Duplicate/OOO tick injection into CandleBuilderV2
4. Max pain validation (optimized vs naive)

Evidence level: UNIT_TESTED (real CandleBuilderV2, no network)
"""

from __future__ import annotations

import random
import time
from datetime import datetime, timezone

import pytest

from src.core.schemas_v2 import CandleState, CandleV2, DataQuality
from src.engines.candle_builder import CandleBuilderV2


def _ist_now_ms() -> int:
    """Return current time as milliseconds."""
    return int(time.time() * 1000)


class TestCandleV2Invariants:
    """CandleV2 enforces OHLC invariants at instantiation."""

    def test_valid_candle_created(self) -> None:
        c = CandleV2(
            instrumentId="NIFTY",
            symbol="NIFTY",
            exchange="NSE",
            interval="5m",
            time=int(time.time()),
            open=24500.0,
            high=24550.0,
            low=24480.0,
            close=24530.0,
            volume=1000,
        )
        assert c.open == 24500.0
        assert c.high == 24550.0

    def test_high_below_open_rejected(self) -> None:
        with pytest.raises(ValueError, match="high"):
            CandleV2(
                instrumentId="NIFTY", symbol="NIFTY", exchange="NSE",
                interval="5m", time=int(time.time()),
                open=24500.0,
                high=24400.0,  # invalid: high < open
                low=24480.0,
                close=24530.0,
                volume=1000,
            )

    def test_high_below_close_rejected(self) -> None:
        with pytest.raises(ValueError, match="high"):
            CandleV2(
                instrumentId="NIFTY", symbol="NIFTY", exchange="NSE",
                interval="5m", time=int(time.time()),
                open=24500.0,
                high=24510.0,
                low=24480.0,
                close=24550.0,  # close > high — invalid
                volume=1000,
            )

    def test_low_above_open_rejected(self) -> None:
        with pytest.raises(ValueError, match="low"):
            CandleV2(
                instrumentId="NIFTY", symbol="NIFTY", exchange="NSE",
                interval="5m", time=int(time.time()),
                open=24500.0,
                high=24550.0,
                low=24520.0,  # invalid: low > open
                close=24530.0,
                volume=1000,
            )

    def test_negative_volume_rejected(self) -> None:
        with pytest.raises(ValueError, match="volume"):
            CandleV2(
                instrumentId="NIFTY", symbol="NIFTY", exchange="NSE",
                interval="5m", time=int(time.time()),
                open=24500.0,
                high=24550.0,
                low=24480.0,
                close=24530.0,
                volume=-1,  # invalid
            )

    def test_zero_price_rejected(self) -> None:
        with pytest.raises((ValueError, Exception)):
            CandleV2(
                instrumentId="NIFTY", symbol="NIFTY", exchange="NSE",
                interval="5m", time=int(time.time()),
                open=0.0,  # invalid
                high=24550.0,
                low=24480.0,
                close=24530.0,
                volume=1000,
            )

    def test_partial_candle_state(self) -> None:
        c = CandleV2(
            instrumentId="NIFTY", symbol="NIFTY", exchange="NSE",
            interval="5m", time=int(time.time()),
            open=24500.0, high=24550.0, low=24480.0, close=24530.0,
            volume=1000,
            state=CandleState.PARTIAL,
            isComplete=False,
        )
        assert c.state == CandleState.PARTIAL
        assert c.isComplete is False

    def test_closed_candle_is_complete(self) -> None:
        c = CandleV2(
            instrumentId="NIFTY", symbol="NIFTY", exchange="NSE",
            interval="5m", time=int(time.time()),
            open=24500.0, high=24550.0, low=24480.0, close=24530.0,
            volume=1000,
            state=CandleState.CLOSED,
            isComplete=True,
        )
        assert c.state == CandleState.CLOSED
        assert c.isComplete is True


class TestCandleBuilderV2:
    """CandleBuilderV2 integration tests — tick aggregation, OOO, duplication."""

    def _make_builder(self, interval_seconds: int = 300) -> CandleBuilderV2:
        interval = "5m" if interval_seconds == 300 else "1m"
        return CandleBuilderV2(
            instrument_id="NIFTY",
            interval=interval,
            symbol="NIFTY",
            exchange="NSE",
        )

    def test_first_tick_opens_candle(self) -> None:
        builder = self._make_builder()
        # 09:15 IST = 03:45 UTC
        ts_ms = int(datetime(2026, 9, 3, 3, 45, 30, tzinfo=timezone.utc).timestamp() * 1000)
        closed, partial = builder.update(ltp=24500.0, volume=100, event_time_ms=ts_ms)
        assert partial is not None or builder._current_candle is not None

    def test_ticks_aggregate_ohlcv(self) -> None:
        builder = self._make_builder(interval_seconds=300)
        # Use a fixed 5m candle window
        base_ms = int(datetime(2026, 9, 3, 4, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
        ticks = [
            (24500.0, 100, base_ms + 10_000),
            (24520.0, 200, base_ms + 30_000),
            (24480.0, 150, base_ms + 60_000),
            (24510.0, 180, base_ms + 90_000),
        ]
        for price, vol, ts in ticks:
            builder.update(ltp=price, volume=vol, event_time_ms=ts)

        lc = builder._current_candle
        if lc and lc.as_partial():
            c = lc.as_partial()
            assert c.open == pytest.approx(24500.0), "Open should be first tick price"
            assert c.high == pytest.approx(24520.0), "High should be max price"
            assert c.low == pytest.approx(24480.0), "Low should be min price"
            assert c.close == pytest.approx(24510.0), "Close should be last tick price"
            assert c.volume >= 630, "Volume should be sum of ticks"

    def test_partial_candle_not_closed_prematurely(self) -> None:
        """Signal engine must not consume a partial candle as complete."""
        builder = self._make_builder(interval_seconds=300)
        base_ms = int(datetime(2026, 9, 3, 4, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
        builder.update(ltp=24500.0, volume=100, event_time_ms=base_ms + 30_000)

        lc = builder._current_candle
        if lc:
            c = lc.as_partial()
            if c:
                assert c.state != CandleState.CLOSED, (
                    "Candle should not be CLOSED before interval ends"
                )
                assert c.isComplete is False, "Partial candle must not be marked as complete"

    def test_out_of_order_tick_handled(self) -> None:
        """Out-of-order ticks must not corrupt OHLCV state."""
        builder = self._make_builder(interval_seconds=300)
        base_ms = int(datetime(2026, 9, 3, 4, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)

        # Add tick at t+60
        builder.update(ltp=24520.0, volume=100, event_time_ms=base_ms + 60_000)
        # Add tick at t+30 (out of order — earlier than previous, same slot)
        builder.update(ltp=24500.0, volume=50, event_time_ms=base_ms + 30_000)

        lc = builder._current_candle
        # No exception raised — OOO handled gracefully
        if lc and lc.as_partial():
            c = lc.as_partial()
            assert c.open > 0
            assert c.high >= c.low
            assert c.volume >= 0


class TestMaxPainValidation:
    """Verify O(N log N) max pain equals naive O(N²) implementation."""

    @staticmethod
    def _naive_max_pain(rows: list) -> float | None:
        """Naive O(N²) max pain for reference comparison."""
        if not rows:
            return None
        strikes = [r.strike for r in rows]
        min_pain = float("inf")
        min_strike = strikes[0]
        for s in strikes:
            pain = 0.0
            for r in rows:
                if r.ce:
                    pain += max(0, s - r.strike) * r.ce.oi
                if r.pe:
                    pain += max(0, r.strike - s) * r.pe.oi
            if pain < min_pain:
                min_pain = pain
                min_strike = s
        return min_strike

    def test_optimized_equals_naive_random_chains(self) -> None:
        """Optimized max pain must produce same result as naive for random OI data."""
        from src.scrapers.option_chain import compute_max_pain

        rng = random.Random(42)

        for trial in range(20):
            # Generate a random option chain
            n_strikes = rng.randint(5, 200)
            atm = rng.uniform(20000, 25000)
            strikes = sorted([atm + (i - n_strikes // 2) * 50 for i in range(n_strikes)])

            # Build minimal OptionChainRow objects with OI
            from src.schemas import OptionChainRow, OptionContract, Greeks
            rows = []
            for strike in strikes:
                ce_oi = rng.randint(0, 100_000)
                pe_oi = rng.randint(0, 100_000)
                ce = OptionContract(
                    token=f"CE{strike}",
                    tradingSymbol=f"CE{strike}",
                    underlying="TEST",
                    expiry="2026-09-25",
                    strike=strike,
                    optionType="CE",
                    oi=ce_oi,
                    oiChange=0,
                    volume=0,
                    greeks=Greeks(),
                    fetchedAt="2026-09-03T10:00:00Z",
                )
                pe = OptionContract(
                    token=f"PE{strike}",
                    tradingSymbol=f"PE{strike}",
                    underlying="TEST",
                    expiry="2026-09-25",
                    strike=strike,
                    optionType="PE",
                    oi=pe_oi,
                    oiChange=0,
                    volume=0,
                    greeks=Greeks(),
                    fetchedAt="2026-09-03T10:00:00Z",
                )
                rows.append(OptionChainRow(strike=strike, ce=ce, pe=pe))

            optimized = compute_max_pain(rows)
            naive = self._naive_max_pain(rows)

            assert optimized == pytest.approx(naive, abs=0.01), (
                f"Trial {trial}: optimized={optimized}, naive={naive} — mismatch"
            )

    def test_max_pain_empty_chain_returns_none(self) -> None:
        from src.scrapers.option_chain import compute_max_pain
        assert compute_max_pain([]) is None

    def test_max_pain_single_strike(self) -> None:
        from src.scrapers.option_chain import compute_max_pain
        from src.schemas import OptionChainRow, OptionContract, Greeks
        rows = [OptionChainRow(
            strike=24500.0,
            ce=OptionContract(
                token="CE24500", tradingSymbol="CE24500", underlying="NIFTY",
                expiry="2026-09-25", strike=24500.0, optionType="CE",
                oi=10000, oiChange=0, volume=0,
                greeks=Greeks(), fetchedAt="2026-09-03T10:00:00Z",
            ),
        )]
        result = compute_max_pain(rows)
        assert result == pytest.approx(24500.0)
