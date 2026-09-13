"""
providers/common/acquisition_planner.py — Data Foundation V8 §12/§13.

Historical acquisition planner.

Given a (symbol, interval, desired date range), determines the optimal
acquisition strategy: provider selection, chunk sizing, request count,
expected candles, retry policy, and checkpoint strategy.

Provider-specific limits come from the capability registry — never hardcoded.
Different providers have different chunk sizes and rate limits, so the planner
produces a provider-specific acquisition plan rather than a one-size-fits-all
approach.

ABSOLUTE RULES:
  - Never plan an acquisition for 3m (returns infeasible plan, feasible=False).
  - Chunk sizes come from registry maximumRangeDays — never exceed them.
  - Rate limits come from registry requestsPerSecond.
  - Expected candle count is computed from the NSE trading calendar where
    available, or from a conservative approximation.
  - The planner does NOT make network calls — it only plans.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from src.providers.common.normalizer import SUPPORTED_TIMEFRAMES, BARS_PER_SESSION
from src.providers.common.registry import (
    DatasetType, InstrumentClass, max_range_days, requests_per_second,
    providers_for_dataset, capabilities_for,
)


# ---------------------------------------------------------------------------
# Helper: NSE trading day approximation
# ---------------------------------------------------------------------------

# NSE has ~250 trading days per year. We approximate without a full calendar
# dependency in the planner module.
_TRADING_DAYS_PER_YEAR = 252
_TRADING_DAYS_PER_WEEK = 5


def _approx_trading_days(from_date: date, to_date: date) -> int:
    """
    Approximate the number of NSE trading days in [from_date, to_date].
    Uses 5/7 density (Mon–Fri) without holiday adjustment.
    Conservative: slightly overestimates to ensure we don't underplan.
    """
    calendar_days = max(0, (to_date - from_date).days + 1)
    return max(1, math.ceil(calendar_days * 5 / 7))


def _expected_bars(interval_str: str, from_date: date, to_date: date) -> int:
    """
    Approximate the expected number of candles for an interval and date range.
    """
    trading_days = _approx_trading_days(from_date, to_date)
    if interval_str in ("1w",):
        return max(1, trading_days // 5)
    if interval_str in ("1M",):
        return max(1, trading_days // 21)
    bars_per_day = BARS_PER_SESSION.get(interval_str, 1)
    return trading_days * bars_per_day


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AcquisitionChunk:
    """A single request chunk within an acquisition plan."""
    from_date: date
    to_date:   date
    chunk_idx: int
    total_chunks: int

    @property
    def from_str(self) -> str:
        return self.from_date.strftime("%Y-%m-%d")

    @property
    def to_str(self) -> str:
        return self.to_date.strftime("%Y-%m-%d")


@dataclass
class AcquisitionPlan:
    """
    Complete acquisition plan for one (symbol, interval, date range, provider).
    The planner produces this; the backfill runner executes it.
    """
    provider:         str
    instrumentId:     str
    exchange:         str
    intervalStr:      str
    from_date:        date
    to_date:          date
    dataset_type:     DatasetType
    instrument_class: InstrumentClass

    # Computed fields
    chunks:           list[AcquisitionChunk] = field(default_factory=list)
    chunk_size_days:  int                    = 1
    total_requests:   int                    = 0
    expected_candles: int                    = 0
    requests_per_sec: float                  = 1.0
    estimated_minutes: float                 = 0.0
    checkpoint_interval: int                 = 10  # checkpoint every N chunks

    # Feasibility
    feasible:         bool                   = True
    blocked_reason:   Optional[str]          = None


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------

def plan_acquisition(
    provider: str,
    instrument_id: str,
    exchange: str,
    interval_str: str,
    from_date: date,
    to_date: date,
    instrument_class: InstrumentClass = InstrumentClass.EQUITY,
) -> AcquisitionPlan:
    """
    Plan a historical acquisition for a single (instrument, interval) pair.

    Parameters
    ----------
    provider : str
        Provider ID (e.g. "angel_one", "jugaad", "openchart").
    instrument_id : str
        NSE symbol.
    exchange : str
        "NSE" | "NFO" | etc.
    interval_str : str
        Canonical interval. Returns infeasible plan with blocked_reason for "3m".
    from_date : date
        Desired start of historical range (inclusive).
    to_date : date
        Desired end of historical range (inclusive).
    instrument_class : InstrumentClass
        Used for capability lookup.

    Returns
    -------
    AcquisitionPlan
        If not feasible, plan.feasible=False and plan.blocked_reason explains why.
        For "3m": plan.feasible=False, plan.blocked_reason contains "3m was permanently removed".
    """
    # Reject 3m permanently
    if interval_str == "3m":
        return AcquisitionPlan(
            provider=provider, instrumentId=instrument_id, exchange=exchange,
            intervalStr=interval_str, from_date=from_date, to_date=to_date,
            dataset_type=DatasetType.EOD_OHLCV, instrument_class=instrument_class,
            feasible=False,
            blocked_reason=(
                "Interval '3m' was permanently removed from AlphaForge (V8). "
                "No acquisition is planned for 3m data."
            ),
        )

    if interval_str not in SUPPORTED_TIMEFRAMES:
        return AcquisitionPlan(
            provider=provider, instrumentId=instrument_id, exchange=exchange,
            intervalStr=interval_str, from_date=from_date, to_date=to_date,
            dataset_type=DatasetType.EOD_OHLCV, instrument_class=instrument_class,
            feasible=False,
            blocked_reason=f"Unsupported interval '{interval_str}'.",
        )

    if to_date < from_date:
        return AcquisitionPlan(
            provider=provider, instrumentId=instrument_id, exchange=exchange,
            intervalStr=interval_str, from_date=from_date, to_date=to_date,
            dataset_type=DatasetType.EOD_OHLCV, instrument_class=instrument_class,
            feasible=False,
            blocked_reason=f"to_date ({to_date}) is before from_date ({from_date}).",
        )

    # Determine dataset type from interval
    dataset_type = (
        DatasetType.EOD_OHLCV
        if interval_str in ("1d", "1w", "1M")
        else DatasetType.INTRADAY_OHLCV
    )
    if instrument_class in (InstrumentClass.FUTURES, InstrumentClass.OPTIONS):
        dataset_type = DatasetType.FNO_EOD

    # Check provider capability
    caps = capabilities_for(
        provider=provider,
        dataset=dataset_type,
        timeframe=interval_str,
        instrument_class=instrument_class,
    )
    if not caps:
        # Try with ALL class
        caps = capabilities_for(
            provider=provider,
            dataset=dataset_type,
            timeframe=interval_str,
            instrument_class=InstrumentClass.ALL,
        )

    if not caps:
        return AcquisitionPlan(
            provider=provider, instrumentId=instrument_id, exchange=exchange,
            intervalStr=interval_str, from_date=from_date, to_date=to_date,
            dataset_type=dataset_type, instrument_class=instrument_class,
            feasible=False,
            blocked_reason=(
                f"Provider '{provider}' has no registered capability for "
                f"dataset={dataset_type.value} interval={interval_str} "
                f"instrumentClass={instrument_class.value}."
            ),
        )

    cap = caps[0]  # use the first matching capability
    if not cap.historical:
        return AcquisitionPlan(
            provider=provider, instrumentId=instrument_id, exchange=exchange,
            intervalStr=interval_str, from_date=from_date, to_date=to_date,
            dataset_type=dataset_type, instrument_class=instrument_class,
            feasible=False,
            blocked_reason=(
                f"Provider '{provider}' does not support historical data for "
                f"interval={interval_str}."
            ),
        )

    # Chunk size from registry (provider-specific maximum)
    chunk_days = cap.maximumRangeDays or 30
    rps = cap.requestsPerSecond

    # Build chunks
    chunks: list[AcquisitionChunk] = []
    cursor = from_date
    while cursor <= to_date:
        chunk_end = min(cursor + timedelta(days=chunk_days - 1), to_date)
        chunks.append(AcquisitionChunk(
            from_date=cursor,
            to_date=chunk_end,
            chunk_idx=len(chunks),
            total_chunks=0,  # filled in below
        ))
        cursor = chunk_end + timedelta(days=1)

    # Fill in total_chunks
    total = len(chunks)
    chunks = [
        AcquisitionChunk(c.from_date, c.to_date, c.chunk_idx, total)
        for c in chunks
    ]

    # Estimated duration
    # requests / rps = seconds, + 0.5s safety margin per chunk
    estimated_secs = (total / rps) + (total * 0.5)
    estimated_minutes = estimated_secs / 60

    # Expected candles
    expected = _expected_bars(interval_str, from_date, to_date)

    # Checkpoint interval: every 10 chunks or every 100 for large plans
    checkpoint_interval = 10 if total <= 100 else max(10, total // 10)

    return AcquisitionPlan(
        provider=provider,
        instrumentId=instrument_id,
        exchange=exchange,
        intervalStr=interval_str,
        from_date=from_date,
        to_date=to_date,
        dataset_type=dataset_type,
        instrument_class=instrument_class,
        chunks=chunks,
        chunk_size_days=chunk_days,
        total_requests=total,
        expected_candles=expected,
        requests_per_sec=rps,
        estimated_minutes=round(estimated_minutes, 1),
        checkpoint_interval=checkpoint_interval,
        feasible=True,
    )


def plan_fno_universe_acquisition(
    provider: str,
    fno_symbols: list[str],
    exchange: str,
    interval_str: str,
    from_date: date,
    to_date: date,
    instrument_class: InstrumentClass = InstrumentClass.EQUITY,
) -> list[AcquisitionPlan]:
    """
    Plan acquisition for all symbols in the F&O universe.

    Returns a list of (one plan per symbol). Infeasible plans are included
    with feasible=False so the caller can report them explicitly rather than
    silently skipping them.
    """
    plans: list[AcquisitionPlan] = []
    for symbol in fno_symbols:
        plan = plan_acquisition(
            provider=provider,
            instrument_id=symbol,
            exchange=exchange,
            interval_str=interval_str,
            from_date=from_date,
            to_date=to_date,
            instrument_class=instrument_class,
        )
        plans.append(plan)
    return plans
