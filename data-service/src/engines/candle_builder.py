"""
Candle Builder V2 — Phases 25-28.

Builds validated OHLCV candles from tick streams.
Anchored to NSE session start (09:15 IST).

Features:
- Explicit OPEN/PARTIAL/CLOSED candle states
- OHLC invariant validation on every update
- Multi-timeframe derivation with source tracking
- 09:15 IST anchor for all intraday bars
- Rejects impossible candles (high < max(open, close), etc.)

Supported intervals: 1m, 3m, 5m, 15m, 30m, 1h, 1d

Usage:
    from src.engines.candle_builder import CandleBuilderV2
    builder = CandleBuilderV2("NSE:NIFTY", "5m")
    candle = builder.update(ltp=24850.0, volume=100000, event_time_ms=...)
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import structlog

from src.core.schemas_v2 import CandleState, CandleV2, DataQuality, DataSource
from src.engines.timestamp_engine import ts_engine

logger = structlog.get_logger(__name__)

_IST = ZoneInfo("Asia/Kolkata")

# ---------------------------------------------------------------------------
# Interval definitions
# ---------------------------------------------------------------------------

_INTERVAL_SECONDS: dict[str, int] = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "1d": 86400,
}

# NSE session anchor: 09:15:00 IST
_NSE_SESSION_OPEN_HOUR = 9
_NSE_SESSION_OPEN_MINUTE = 15


def _candle_open_time_utc_s(event_time_ms: int, interval_seconds: int) -> int:
    """Compute the candle open time (UTC epoch seconds) for a given event time.

    For intraday intervals, aligns to the NSE session anchor (09:15 IST).
    For daily (1d), aligns to 00:00 UTC of the trading day.
    """
    if interval_seconds == 86400:
        # Daily: align to 00:00 UTC of the day
        dt = datetime.fromtimestamp(event_time_ms / 1000, tz=ZoneInfo("UTC"))
        return int(dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())

    # Intraday: convert to IST and align to 09:15 anchor
    dt_ist = datetime.fromtimestamp(event_time_ms / 1000, tz=_IST)
    anchor_ist = dt_ist.replace(
        hour=_NSE_SESSION_OPEN_HOUR,
        minute=_NSE_SESSION_OPEN_MINUTE,
        second=0,
        microsecond=0,
    )

    elapsed_s = int((dt_ist - anchor_ist).total_seconds())
    if elapsed_s < 0:
        # Before session open — use pre-session anchor (set to 0 slot)
        elapsed_s = 0

    slot = (elapsed_s // interval_seconds) * interval_seconds
    candle_open_ist = anchor_ist + timedelta(seconds=slot)
    # Convert IST datetime to UTC epoch seconds
    return int(candle_open_ist.timestamp())


def _candle_close_time_utc_s(open_time_s: int, interval_seconds: int) -> int:
    """Return the close time (UTC epoch seconds) for a candle."""
    return open_time_s + interval_seconds


class LiveCandle:
    """A mutable in-progress candle bar.

    Updated tick-by-tick. Sealed when the next candle starts.
    """

    def __init__(
        self,
        instrument_id: str,
        symbol: str,
        exchange: str,
        interval: str,
        open_time_s: int,
        source: DataSource = DataSource.NSE_NEXTAPI,
    ) -> None:
        self.instrument_id = instrument_id
        self.symbol = symbol
        self.exchange = exchange
        self.interval = interval
        self.open_time_s = open_time_s
        self.source = source

        interval_s = _INTERVAL_SECONDS[interval]
        self.close_time_s = open_time_s + interval_s

        self._open: Optional[float] = None
        self._high: Optional[float] = None
        self._low: Optional[float] = None
        self._close: Optional[float] = None
        self._volume: int = 0
        self._tick_count: int = 0
        self._state: CandleState = CandleState.OPEN

    def update(self, price: float, volume: int = 0) -> None:
        """Apply a new tick to this candle."""
        if price <= 0:
            logger.debug("candle_skip_non_positive_price", price=price)
            return

        if self._open is None:
            self._open = price
            self._high = price
            self._low = price
        else:
            self._high = max(self._high, price)  # type: ignore[arg-type]
            self._low = min(self._low, price)  # type: ignore[arg-type]

        self._close = price
        self._volume += max(0, volume)
        self._tick_count += 1
        self._state = CandleState.PARTIAL

    def seal(self) -> Optional[CandleV2]:
        """Seal this candle as CLOSED and return a CandleV2.

        Returns None when the candle has no data (no ticks received).
        """
        if self._open is None or self._close is None:
            return None

        self._state = CandleState.CLOSED

        try:
            return CandleV2(
                instrumentId=self.instrument_id,
                symbol=self.symbol,
                exchange=self.exchange,
                interval=self.interval,
                time=self.open_time_s,
                closeTimeMs=self.close_time_s * 1000,
                open=self._open,
                high=self._high,  # type: ignore[arg-type]
                low=self._low,  # type: ignore[arg-type]
                close=self._close,
                volume=self._volume,
                state=CandleState.CLOSED,
                isComplete=True,
                source=self.source,
                quality=DataQuality.VALID,
            )
        except ValueError as exc:
            logger.error(
                "candle_seal_validation_error",
                instrument_id=self.instrument_id,
                interval=self.interval,
                error=str(exc),
            )
            return None

    def as_partial(self) -> Optional[CandleV2]:
        """Return the current in-progress state as a PARTIAL CandleV2."""
        if self._open is None or self._close is None:
            return None
        try:
            return CandleV2(
                instrumentId=self.instrument_id,
                symbol=self.symbol,
                exchange=self.exchange,
                interval=self.interval,
                time=self.open_time_s,
                closeTimeMs=self.close_time_s * 1000,
                open=self._open,
                high=self._high,  # type: ignore[arg-type]
                low=self._low,  # type: ignore[arg-type]
                close=self._close,
                volume=self._volume,
                state=CandleState.PARTIAL,
                isComplete=False,
                source=self.source,
                quality=DataQuality.VALID,
            )
        except ValueError:
            return None

    @property
    def state(self) -> CandleState:
        return self._state

    @property
    def tick_count(self) -> int:
        return self._tick_count

    @property
    def is_empty(self) -> bool:
        return self._open is None


class CandleBuilderV2:
    """Real-time candle aggregator for a single instrument and interval.

    NOT thread-safe — use one instance per async task/coroutine.

    The builder:
    1. Determines the correct candle slot for each incoming tick
    2. Seals the previous candle when the slot advances
    3. Validates OHLC invariants on each seal
    4. Tracks OPEN→PARTIAL→CLOSED state transitions

    Signal engine must check CandleV2.isComplete before using as a
    confirmed closed candle.
    """

    def __init__(
        self,
        instrument_id: str,
        interval: str,
        symbol: str = "",
        exchange: str = "NSE",
        source: DataSource = DataSource.NSE_NEXTAPI,
    ) -> None:
        if interval not in _INTERVAL_SECONDS:
            raise ValueError(
                f"Unsupported interval '{interval}'. "
                f"Valid: {sorted(_INTERVAL_SECONDS.keys())}"
            )
        self.instrument_id = instrument_id
        self.interval = interval
        self.symbol = symbol or instrument_id
        self.exchange = exchange
        self.source = source
        self._interval_s = _INTERVAL_SECONDS[interval]
        self._current_candle: Optional[LiveCandle] = None
        self._closed_candles: list[CandleV2] = []
        self._total_closed = 0

    def update(
        self,
        ltp: float,
        event_time_ms: int,
        volume: int = 0,
    ) -> tuple[Optional[CandleV2], Optional[CandleV2]]:
        """Apply a tick to the candle builder.

        Returns (closed_candle, current_partial):
        - closed_candle: A newly sealed CandleV2 if the slot advanced, else None
        - current_partial: The current PARTIAL candle state
        """
        if ltp <= 0:
            return None, self._current_candle.as_partial() if self._current_candle else None

        open_time_s = _candle_open_time_utc_s(event_time_ms, self._interval_s)
        closed_candle: Optional[CandleV2] = None

        # Check if we need to advance the slot
        if (
            self._current_candle is not None
            and open_time_s != self._current_candle.open_time_s
        ):
            # Seal previous candle
            closed = self._current_candle.seal()
            if closed is not None:
                self._closed_candles.append(closed)
                self._total_closed += 1
                closed_candle = closed
                logger.debug(
                    "candle_sealed",
                    instrument_id=self.instrument_id,
                    interval=self.interval,
                    open_time_s=self._current_candle.open_time_s,
                    close=closed.close,
                    volume=closed.volume,
                )
            self._current_candle = None

        # Start new candle if needed
        if self._current_candle is None:
            self._current_candle = LiveCandle(
                instrument_id=self.instrument_id,
                symbol=self.symbol,
                exchange=self.exchange,
                interval=self.interval,
                open_time_s=open_time_s,
                source=self.source,
            )

        # Update current candle
        self._current_candle.update(ltp, volume)

        return closed_candle, self._current_candle.as_partial()

    def force_seal(self) -> Optional[CandleV2]:
        """Force-seal the current candle (e.g. at market close 15:30 IST)."""
        if self._current_candle is not None and not self._current_candle.is_empty:
            closed = self._current_candle.seal()
            if closed is not None:
                self._closed_candles.append(closed)
                self._total_closed += 1
            self._current_candle = None
            return closed
        return None

    @property
    def current_partial(self) -> Optional[CandleV2]:
        """Return the current partial candle (or None)."""
        if self._current_candle:
            return self._current_candle.as_partial()
        return None

    @property
    def total_closed(self) -> int:
        return self._total_closed

    @property
    def recent_closed(self) -> list[CandleV2]:
        """Return the last 10 closed candles."""
        return self._closed_candles[-10:]


# ---------------------------------------------------------------------------
# Multi-timeframe derivation utility
# ---------------------------------------------------------------------------


def derive_higher_timeframe(
    source_candles: list[CandleV2],
    target_interval: str,
) -> list[CandleV2]:
    """Aggregate lower-timeframe candles into a higher timeframe.

    Example: 1m candles → 5m candles (5 × 1m = 1 × 5m).

    Phase 28 requirement: derived candles carry sourceInterval tag.
    """
    if not source_candles:
        return []

    target_s = _INTERVAL_SECONDS.get(target_interval)
    if target_s is None:
        raise ValueError(f"Unknown target interval: {target_interval}")

    # Group source candles by their target-interval slot
    groups: dict[int, list[CandleV2]] = {}
    for candle in source_candles:
        slot_s = (candle.time // target_s) * target_s
        groups.setdefault(slot_s, []).append(candle)

    result: list[CandleV2] = []
    for slot_s in sorted(groups.keys()):
        group = groups[slot_s]
        if not group:
            continue

        open_p = group[0].open
        close_p = group[-1].close
        high_p = max(c.high for c in group)
        low_p = min(c.low for c in group)
        volume_sum = sum(c.volume for c in group)
        source_interval = group[0].interval

        try:
            derived = CandleV2(
                instrumentId=group[0].instrumentId,
                symbol=group[0].symbol,
                exchange=group[0].exchange,
                interval=target_interval,
                time=slot_s,
                open=open_p,
                high=high_p,
                low=low_p,
                close=close_p,
                volume=volume_sum,
                state=CandleState.CLOSED,
                isComplete=True,
                source=group[0].source,
                sourceInterval=source_interval,
                quality=DataQuality.VALID,
            )
            result.append(derived)
        except ValueError as exc:
            logger.warning(
                "derived_candle_invalid",
                slot_s=slot_s,
                target_interval=target_interval,
                error=str(exc),
            )

    return result
