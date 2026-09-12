"""
providers/openchart/adapter.py — Data Foundation V8 §11.

OpenChart 0.2.0 provider adapter for AlphaForge.

NSE WAF bypass: both layers handled via src.core.nse_session:
  Layer 1 (TLS fingerprinting): curl_cffi Chrome 110 impersonation — BYPASSED
  Layer 2 (nsit behavioural token): loaded from .nsit_cookie / NSE_NSIT_COOKIE env

The adapter now delegates all HTTP to the central nse_session singleton,
which handles cookie seeding, nsit injection, and periodic refresh.

Provides:
  - Historical OHLCV for NSE equities (EQ), indices (IDX), and F&O (FO)
  - Supported timeframes: 1m 5m 10m 15m 30m 1h 1d 1w 1M (NO 3m)
  - Session reuse across calls
  - Retries with exponential backoff
  - Raw response capture (landing zone)
  - Provenance records

ABSOLUTE RULES:
  - 3m raises ValueError — permanently removed from scope.
  - Never return fabricated data on network error.
  - Never use openchart as a live signal source.
  - OI/IV/bid/ask always stay None.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

import structlog

from src.core.nse_session import get_nse_session_sync, NSE_CHROME_HEADERS
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


def _oc_symbol(symbol: str, segment: str) -> str:
    s = symbol.upper()
    if segment == "EQ" and not s.endswith("-EQ"):
        return f"{s}-EQ"
    return s


# ---------------------------------------------------------------------------
# Acquisition result
# ---------------------------------------------------------------------------

@dataclass
class OpenChartAcquisitionResult:
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
    OpenChart 0.2.0 adapter with NSE WAF bypass via curl_cffi.

    Uses Chrome TLS fingerprinting to bypass Akamai's bot detection on
    charting.nseindia.com. Seeds session cookies from the NSE homepage
    before making any API calls.
    """

    PROVIDER_ID = "openchart"
    MAX_RETRIES = 3
    BACKOFF_BASE_SECS = 2.0
    REQUEST_SLEEP_SECS = 1.5   # between requests — avoid rate-ban

    SUPPORTED_INTERVALS: frozenset[str] = frozenset({
        "1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"
    })

    def __init__(self, nsit_cookie: Optional[str] = None) -> None:
        """
        Parameters
        ----------
        nsit_cookie : str, optional
            Overrides the .nsit_cookie file / NSE_NSIT_COOKIE env var.
            The central nse_session.py will also try to load nsit automatically.
        """
        self._openchart_available = False
        self._last_request: float = 0.0
        self._nse: Any = None
        self._nsit_cookie: Optional[str] = nsit_cookie  # explicit override
        self._import_libs()

    def _import_libs(self) -> None:
        try:
            from openchart import NSEData  # noqa: F401
            self._openchart_available = True
        except ImportError:
            logger.warning("openchart_not_installed",
                           message="Install with: pip install openchart==0.2.0")

    def _ensure_session(self) -> None:
        """Create and warm up the NSEData + curl_cffi session via central nse_session."""
        if self._nse is not None:
            return
        from openchart import NSEData
        self._nse = NSEData()

        # Delegate to central nse_session — handles cookie seeding, nsit, refresh
        cffi_session = get_nse_session_sync()
        if cffi_session is not None:
            # Explicit nsit override takes precedence over the file/env loaded by nse_session
            if self._nsit_cookie:
                cffi_session.cookies.set("nsit", self._nsit_cookie, domain=".nseindia.com")
            self._nse.session = cffi_session
            self._nse._cookies_set = True
            logger.info("openchart_cffi_session_injected",
                        message="Central Chrome TLS session (curl_cffi) injected into OpenChart")
        else:
            self._nse._ensure_cookies()

    def _rate_limit(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < self.REQUEST_SLEEP_SECS:
            time.sleep(self.REQUEST_SLEEP_SECS - elapsed)
        self._last_request = time.monotonic()

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def get_historical(
        self,
        symbol: str,
        segment: str,
        interval_str: str,
        from_date: date,
        to_date: date,
        exchange: str = "NSE",
    ) -> OpenChartAcquisitionResult:
        if interval_str == "3m":
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment, interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="UNSUPPORTED",
                error="3m interval permanently removed from AlphaForge (V8).",
            )
        if interval_str not in self.SUPPORTED_INTERVALS:
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment, interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="UNSUPPORTED",
                error=f"Interval '{interval_str}' not supported by OpenChart.",
            )
        if not self._openchart_available:
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment, interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="FAILED",
                error="openchart package not installed.",
            )

        result = await asyncio.get_event_loop().run_in_executor(
            None,
            self._fetch_with_retry,
            symbol, segment, interval_str, from_date, to_date, exchange,
        )
        return result

    def _fetch_with_retry(
        self,
        symbol: str,
        segment: str,
        interval_str: str,
        from_date: date,
        to_date: date,
        exchange: str,
    ) -> OpenChartAcquisitionResult:
        self._ensure_session()
        last_error: Optional[str] = None

        for attempt in range(self.MAX_RETRIES + 1):
            if attempt > 0:
                delay = self.BACKOFF_BASE_SECS * (2 ** (attempt - 1))
                logger.info("openchart_retry", symbol=symbol, interval=interval_str,
                            attempt=attempt, delay_secs=round(delay, 2))
                time.sleep(delay)

            result = self._fetch_once(symbol, segment, interval_str, from_date, to_date, exchange)
            if result.status not in ("FAILED",):
                return result
            last_error = result.error

        return OpenChartAcquisitionResult(
            symbol=symbol, segment=segment, interval_str=interval_str,
            from_date=str(from_date), to_date=str(to_date),
            status="FAILED",
            error=f"All {self.MAX_RETRIES + 1} attempts failed. Last: {last_error}",
        )

    def _fetch_once(
        self,
        symbol: str,
        segment: str,
        interval_str: str,
        from_date: date,
        to_date: date,
        exchange: str,
    ) -> OpenChartAcquisitionResult:
        self._rate_limit()
        oc_segment = _SEGMENT_MAP.get(segment.upper(), segment.upper())
        oc_symbol  = _oc_symbol(symbol, oc_segment)

        t_start = int(time.time() * 1000)
        try:
            from datetime import datetime as _dt
            start_dt = _dt.combine(from_date, _dt.min.time())
            end_dt   = _dt.combine(to_date,   _dt.max.time())
            df = self._nse.historical(oc_symbol, oc_segment, start_dt, end_dt, interval_str)
        except Exception as exc:
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment, interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="FAILED", error=str(exc),
            )
        t_end = int(time.time() * 1000)

        if df is None or len(df) == 0:
            # Empty response with status=true means the charting API served no data.
            # This happens when the nsit session cookie is missing (Akamai behavioural
            # token — not obtainable via curl_cffi alone, requires Playwright).
            status_msg = "SESSION_REQUIRED" if not self._nsit_cookie else "EMPTY"
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment, interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status=status_msg,
                rows_fetched=0,
                error=(
                    "NSE charting API returned no data. The 'nsit' session cookie is "
                    "required but not present. Obtain it via Playwright "
                    "(scripts/seed_nse_session.py) and pass it to "
                    "OpenChartAdapter(nsit_cookie='...'). "
                    "Alternative: use jugaad-data for EOD or Angel One/Upstox for intraday."
                ) if status_msg == "SESSION_REQUIRED" else None,
            )

        # Validate schema
        required_cols = {"Open", "High", "Low", "Close", "Volume"}
        if not required_cols.issubset(set(df.columns)):
            return OpenChartAcquisitionResult(
                symbol=symbol, segment=segment, interval_str=interval_str,
                from_date=str(from_date), to_date=str(to_date),
                status="FAILED",
                error=f"OpenChart response missing columns. Got: {list(df.columns)}",
            )

        raw_records = df.reset_index().to_dict("records")
        raw_record = build_raw_record(
            provider=self.PROVIDER_ID,
            endpoint=f"openchart.NSEData.historical:{oc_symbol}:{oc_segment}:{interval_str}",
            instrument_id=symbol,
            exchange=exchange,
            interval_str=interval_str,
            request_params={
                "symbol": oc_symbol, "segment": oc_segment, "interval": interval_str,
                "from": str(from_date), "to": str(to_date),
            },
            raw_response=raw_records[:50],
            record_count=len(raw_records),
            request_start_ms=t_start,
            request_end_ms=t_end,
        )

        candles, dropped = self._normalize_df(df, symbol, exchange, interval_str)
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
        prov.dataTrustStatus = TRUST_VERIFIED_SINGLE_SOURCE if valid else TRUST_UNVERIFIED

        status = "SUCCESS" if valid else "EMPTY"
        if all_dropped and valid:
            status = "PARTIAL"

        logger.info("openchart_acquired",
                    symbol=symbol, segment=segment, interval=interval_str,
                    from_date=str(from_date), to_date=str(to_date),
                    rows_fetched=len(raw_records), rows_valid=len(valid),
                    rows_invalid=len(all_dropped), status=status)

        return OpenChartAcquisitionResult(
            symbol=symbol, segment=segment, interval_str=interval_str,
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
        df: Any,
        symbol: str,
        exchange: str,
        interval_str: str,
    ) -> tuple[list[CanonicalCandle], list[dict]]:
        candles: list[CanonicalCandle] = []
        dropped: list[dict] = []

        from zoneinfo import ZoneInfo
        _IST = ZoneInfo("Asia/Kolkata")

        for idx, row in df.iterrows():
            try:
                if hasattr(idx, "to_pydatetime"):
                    ts = idx.to_pydatetime()
                elif isinstance(idx, datetime):
                    ts = idx
                else:
                    ts = datetime.fromisoformat(str(idx))

                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=_IST)

                ts_utc = ts.astimezone(timezone.utc)
                epoch_sec = int(ts_utc.timestamp())
                ts_ist = ts.astimezone(_IST)
                session_date_str = ts_ist.strftime("%Y-%m-%d")

                o = float(row["Open"])
                h = float(row["High"])
                l_ = float(row["Low"])
                c = float(row["Close"])
                v = float(row.get("Volume", 0) or 0)

                if any(x is None or x <= 0 for x in [o, h, l_, c]):
                    dropped.append({"time": epoch_sec, "symbol": symbol, "error": "invalid_ohlc"})
                    continue

                candles.append(CanonicalCandle(
                    instrumentId=symbol,
                    exchange=exchange,
                    intervalStr=interval_str,
                    sessionDate=session_date_str,
                    provider=self.PROVIDER_ID,
                    time=epoch_sec,
                    open=o, high=h, low=l_, close=c,
                    volume=v,
                    volumeUnavailable=("Volume" not in df.columns),
                    oi=None, iv=None, bid=None, ask=None,
                ))
            except Exception as exc:
                dropped.append({"time": str(idx), "symbol": symbol, "error": str(exc)})

        return candles, dropped
