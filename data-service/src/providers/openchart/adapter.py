"""
providers/openchart/adapter.py — Data Foundation V8 §11.

OpenChart 0.2.0 provider adapter for AlphaForge.

Provides:
  - Historical OHLCV for NSE equities (EQ), indices (IDX), and F&O (FO)
  - Supported timeframes: 1m 5m 10m 15m 30m 1h 1d 1w 1M (NO 3m)
  - Rate limiting: 1 req/s max (NSE charting platform — be conservative)
  - Retries with exponential backoff
  - Response validation
  - Raw response capture (landing zone)
  - Provenance records

OpenChart API (verified against openchart 0.2.0):
  from openchart import NSEData
  nse = NSEData()

  # Search
  nse.search(query, segment)  # segment: 'IDX' | 'EQ' | 'FO'

  # Historical
  nse.historical(symbol, segment, start, end, interval)
  # interval: '1m'|'5m'|'10m'|'15m'|'30m'|'1h'|'1d'|'1w'|'1M'
  # Returns: DataFrame with columns [Open, High, Low, Close, Volume]
  #          Index: Timestamp (pandas DatetimeTZDtype)

IMPORTANT:
  - OpenChart does NOT provide OI, IV, bid, ask.
  - Never store 0 for missing OI/IV — those fields stay None.
  - This provider is primarily for reconciliation and historical gaps.
  - Live data is NOT provided — realtime=False for all capabilities.

ABSOLUTE RULES:
  - 3m raises ValueError — permanently removed from scope.
  - Never return fabricated data on network error.
  - Never use openchart as a live signal source.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

import structlog

from src.providers.common.normalizer import (
    CanonicalCandle,
    validate_batch,
    validate_interval,
    SUPPORTED_TIMEFRAMES,
)
from src.providers.common.provenance import (
    build_provenance,
    build_raw_record,
    DataProvenanceRecord,
    RawAcquisitionRecord,
    TRUST_VERIFIED_SINGLE_SOURCE,
    TRUST_UNVERIFIED,
    current_dataset_version,
)

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Segment mapping
# ---------------------------------------------------------------------------

# AlphaForge instrument type → openchart segment
_SEGMENT_MAP = {
    "EQ":    "EQ",
    "INDEX": "IDX",
    "IDX":   "IDX",
    "FO":    "FO",
    "FUTIDX": "FO",
    "FUTSTK": "FO",
    "OPTIDX": "FO",
    "OPTSTK": "FO",
}

# openchart uses "<symbol>-EQ" naming for equities
def _oc_symbol(symbol: str, segment: str) -> str:
    """Build the openchart symbol string."""
    if segment == "EQ":
        s = symbol.upper()
        if not s.endswith("-EQ"):
            return f"{s}-EQ"
        return s
    return symbol.upper()


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

class _SimpleRateLimiter:
    """Token-bucket rate limiter for openchart (max 1 req/s)."""

    def __init__(self, requests_per_second: float = 1.0) -> None:
        self._min_interval = 1.0 / requests_per_second
        self._last_call: float = 0.0

    async def acquire(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_call
        if elapsed < self._min_interval:
            await asyncio.sleep(self._min_interval - elapsed)
        self._last_call = time.monotonic()


_rate_limiter = _SimpleRateLimiter(requests_per_second=1.0)


# ---------------------------------------------------------------------------
# Acquisition result
# ---------------------------------------------------------------------------

@dataclass
class OpenChartAcquisitionResult:
    """Result of a single OpenChart acquisition request."""
    provider:       str                        = "openchart"
    symbol:         str                        = ""
    segment:        str                        = "EQ"
    interval_str:   str                        = "1d"
    from_date:      str                        = ""
    to_date:        str                        = ""
    status:         str                        = "PENDING"
    rows_fetched:   int                        = 0
    rows_valid:     int                        = 0
    rows_invalid:   int                        = 0
    candles:        list[CanonicalCandle]      = None  # type: ignore[assignment]
    dropped:        list[dict]                = None  # type: ignore[assignment]
    provenance:     Optional[DataProvenanceRecord] = None
    raw_record:     Optional[RawAcquisitionRecord] = None
    error:          Optional[str]             = None

    def __post_init__(self) -> None:
        if self.candles is None:
            self.candles = []
        if self.dropped is None:
            self.dropped = []


# ---------------------------------------------------------------------------
# Main adapter
# ---------------------------------------------------------------------------

class OpenChartAdapter:
    """
    OpenChart 0.2.0 adapter for AlphaForge historical data acquisition.

    Usage
    -----
    adapter = OpenChartAdapter()
    result = await adapter.get_historical(
        symbol="RELIANCE",
        segment="EQ",
        interval_str="1d",
        from_date=date(2024, 1, 1),
        to_date=date(2024, 12, 31),
    )
    """

    PROVIDER_ID = "openchart"
    MAX_RETRIES = 3
    BACKOFF_BASE_SECS = 2.0

    # OpenChart supported timeframes (verified from README — no 3m)
    SUPPORTED_INTERVALS: frozenset[str] = frozenset({
        "1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"
    })

    def __init__(self) -> None:
        self._import_openchart()

    def _import_openchart(self) -> None:
        """Lazy import openchart — raises ImportError with clear message if missing."""
        try:
            from openchart import NSEData  # noqa: F401
            self._openchart_available = True
        except ImportError:
            self._openchart_available = False
            logger.warning(
                "openchart_not_installed",
                message="openchart package not found. "
                        "Install with: pip install openchart==0.2.0. "
                        "Historical OHLCV reconciliation will be unavailable.",
            )

    def _ensure_available(self) -> None:
        if not self._openchart_available:
            raise ImportError(
                "openchart is not installed. "
                "Run: pip install openchart==0.2.0\n"
                "The adapter will be disabled until the package is installed."
            )

    async def get_historical(
        self,
        symbol: str,
        segment: str,
        interval_str: str,
        from_date: date,
        to_date: date,
        exchange: str = "NSE",
    ) -> OpenChartAcquisitionResult:
        """
        Fetch historical OHLCV from OpenChart for a single instrument.

        Parameters
        ----------
        symbol : str
            NSE symbol (e.g. "RELIANCE" for EQ, "NIFTY 50" for IDX,
            "NIFTY26JANFUT" for FO).
        segment : str
            "EQ" | "IDX" | "FO"
        interval_str : str
            Canonical interval (e.g. "1d", "5m"). Raises on "3m".
        from_date : date
        to_date : date
        exchange : str
            Default "NSE".
        """
        self._ensure_available()

        # Validate interval — reject 3m explicitly
        if interval_str == "3m":
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment,
                interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="UNSUPPORTED",
                error="3m interval was permanently removed from AlphaForge (V8). "
                      "OpenChart does not provide 3m data.",
            )
        if interval_str not in self.SUPPORTED_INTERVALS:
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment,
                interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="UNSUPPORTED",
                error=f"Interval '{interval_str}' not supported by OpenChart. "
                      f"Supported: {sorted(self.SUPPORTED_INTERVALS)}",
            )

        result = await asyncio.get_event_loop().run_in_executor(
            None,
            self._fetch_sync_with_retry,
            symbol, segment, interval_str, from_date, to_date, exchange,
        )
        return result

    def _fetch_sync_with_retry(
        self,
        symbol: str,
        segment: str,
        interval_str: str,
        from_date: date,
        to_date: date,
        exchange: str,
    ) -> OpenChartAcquisitionResult:
        """Fetch with exponential backoff retry."""
        last_error: Optional[str] = None

        for attempt in range(self.MAX_RETRIES + 1):
            if attempt > 0:
                delay = self.BACKOFF_BASE_SECS * (2 ** (attempt - 1))
                jitter = 0.1 * delay * (hash(symbol + str(attempt)) % 10) / 10
                logger.info(
                    "openchart_retry",
                    symbol=symbol, interval=interval_str, attempt=attempt,
                    delay_secs=round(delay + jitter, 2),
                )
                time.sleep(delay + jitter)

            result = self._fetch_sync_once(
                symbol, segment, interval_str, from_date, to_date, exchange
            )

            if result.status not in ("FAILED",):
                return result

            last_error = result.error
            logger.warning(
                "openchart_fetch_failed",
                symbol=symbol, interval=interval_str, attempt=attempt,
                error=last_error,
            )

        return OpenChartAcquisitionResult(
            symbol=symbol, segment=segment,
            interval_str=interval_str,
            from_date=str(from_date), to_date=str(to_date),
            status="FAILED",
            error=f"All {self.MAX_RETRIES + 1} attempts failed. Last: {last_error}",
        )

    def _fetch_sync_once(
        self,
        symbol: str,
        segment: str,
        interval_str: str,
        from_date: date,
        to_date: date,
        exchange: str,
    ) -> OpenChartAcquisitionResult:
        """Single fetch attempt — no retry logic."""
        from openchart import NSEData
        t_start = int(time.time() * 1000)
        oc_symbol = _oc_symbol(symbol, segment)
        oc_segment = _SEGMENT_MAP.get(segment.upper(), segment.upper())

        # Rate limit (synchronous wait since we're in thread pool)
        _elapsed = time.monotonic() - getattr(self, "_last_oc_call", 0)
        _min_interval = 1.0  # 1 req/s
        if _elapsed < _min_interval:
            time.sleep(_min_interval - _elapsed)
        self._last_oc_call = time.monotonic()  # type: ignore[attr-defined]

        try:
            nse = NSEData()
            from datetime import datetime as _dt
            start_dt = _dt.combine(from_date, _dt.min.time())
            end_dt = _dt.combine(to_date, _dt.max.time())

            df = nse.historical(oc_symbol, oc_segment, start_dt, end_dt, interval_str)

        except Exception as exc:
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment,
                interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="FAILED",
                error=str(exc),
            )

        t_end = int(time.time() * 1000)

        if df is None or len(df) == 0:
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment,
                interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="EMPTY",
                rows_fetched=0,
            )

        # Validate response schema
        required_cols = {"Open", "High", "Low", "Close", "Volume"}
        if not required_cols.issubset(set(df.columns)):
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment,
                interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="FAILED",
                error=f"OpenChart response missing columns. Got: {list(df.columns)}",
            )

        # Convert to raw records for landing zone
        raw_records = df.reset_index().to_dict("records")

        raw_record = build_raw_record(
            provider=self.PROVIDER_ID,
            endpoint=f"openchart.NSEData.historical:{oc_symbol}:{oc_segment}:{interval_str}",
            instrument_id=symbol,
            exchange=exchange,
            interval_str=interval_str,
            request_params={
                "symbol": oc_symbol, "segment": oc_segment,
                "interval": interval_str,
                "from": str(from_date), "to": str(to_date),
            },
            raw_response=raw_records[:50],
            record_count=len(raw_records),
            request_start_ms=t_start,
            request_end_ms=t_end,
        )

        # Normalize
        candles, dropped = self._normalize_df(
            df, symbol, exchange, interval_str
        )
        valid, validation_dropped = validate_batch(candles)
        all_dropped = dropped + validation_dropped

        prov = build_provenance(
            provider=self.PROVIDER_ID,
            instrument_id=symbol,
            exchange=exchange,
            interval_str=interval_str,
            session_date=str(to_date),
            row_count=len(valid),
            raw_response=raw_records,
            dataset_version=current_dataset_version(),
        )
        prov.dataTrustStatus = (
            TRUST_VERIFIED_SINGLE_SOURCE if len(valid) > 0 else TRUST_UNVERIFIED
        )

        status = "SUCCESS" if len(valid) > 0 else "EMPTY"
        if all_dropped and valid:
            status = "PARTIAL"

        logger.info(
            "openchart_acquired",
            symbol=symbol, segment=segment, interval=interval_str,
            from_date=str(from_date), to_date=str(to_date),
            rows_fetched=len(raw_records), rows_valid=len(valid),
            rows_invalid=len(all_dropped), status=status,
        )

        return OpenChartAcquisitionResult(
            symbol=symbol, segment=segment,
            interval_str=interval_str,
            from_date=str(from_date), to_date=str(to_date),
            status=status,
            rows_fetched=len(raw_records),
            rows_valid=len(valid),
            rows_invalid=len(all_dropped),
            candles=valid,
            dropped=all_dropped,
            provenance=prov,
            raw_record=raw_record,
        )

    def _normalize_df(
        self,
        df: Any,   # pandas DataFrame
        symbol: str,
        exchange: str,
        interval_str: str,
    ) -> tuple[list[CanonicalCandle], list[dict]]:
        """
        Normalize an openchart DataFrame to CanonicalCandle objects.
        OpenChart returns OHLCV with a Timestamp index (timezone-aware).
        """
        candles: list[CanonicalCandle] = []
        dropped: list[dict] = []

        from zoneinfo import ZoneInfo
        _IST = ZoneInfo("Asia/Kolkata")

        for idx, row in df.iterrows():
            try:
                # idx is a Timestamp — extract IST session date and UTC epoch
                if hasattr(idx, "to_pydatetime"):
                    ts = idx.to_pydatetime()
                elif isinstance(idx, datetime):
                    ts = idx
                else:
                    ts = datetime.fromisoformat(str(idx))

                # Ensure UTC
                if ts.tzinfo is None:
                    # Assume IST (openchart returns IST times)
                    ts = ts.replace(tzinfo=_IST)

                ts_utc = ts.astimezone(timezone.utc)
                epoch_sec = int(ts_utc.timestamp())

                # Session date in IST
                ts_ist = ts.astimezone(_IST)
                session_date_str = ts_ist.strftime("%Y-%m-%d")

                o = float(row["Open"])
                h = float(row["High"])
                l_ = float(row["Low"])
                c = float(row["Close"])
                v = float(row.get("Volume", 0) or 0)

                # Sanity check
                if any(x is None or x <= 0 for x in [o, h, l_, c]):
                    dropped.append({
                        "time": epoch_sec, "symbol": symbol,
                        "error": "invalid_ohlc",
                    })
                    continue

                candles.append(CanonicalCandle(
                    instrumentId=symbol,
                    exchange=exchange,
                    intervalStr=interval_str,
                    sessionDate=session_date_str,
                    provider=self.PROVIDER_ID,
                    time=epoch_sec,
                    open=o,
                    high=h,
                    low=l_,
                    close=c,
                    volume=v,
                    volumeUnavailable=(v == 0.0 and "Volume" not in df.columns),
                    # OpenChart does NOT provide OI, IV, bid, ask.
                    # All stay None — never fabricated to 0.
                    oi=None,
                    iv=None,
                    bid=None,
                    ask=None,
                ))

            except Exception as exc:
                dropped.append({"time": str(idx), "symbol": symbol, "error": str(exc)})

        return candles, dropped
