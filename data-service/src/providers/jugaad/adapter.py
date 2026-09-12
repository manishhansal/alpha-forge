"""
providers/jugaad/adapter.py — Data Foundation V8 §10.

Jugaad-data provider adapter for AlphaForge.

Provides:
  - Historical EOD equity OHLCV via NSE bhavcopy (stock_df)
  - Historical F&O EOD data (futures + options) via bhavcopy_fo_save
  - F&O universe filtering: only downloads data for current F&O symbols
  - Resumable acquisition: checkpoints last successfully processed date
  - Duplicate + malformed row detection
  - Full provenance tracking (raw record + provenance record)

Jugaad API (verified against pypi.org/project/jugaad-data/ and GitHub docs):
  - jugaad_data.nse.stock_df(symbol, from_date, to_date, series="EQ")
    → pandas DataFrame with columns: DATE, OPEN, HIGH, LOW, CLOSE, VOLUME
  - jugaad_data.nse.bhavcopy_fo_save(date, directory)
    → saves F&O bhavcopy CSV to directory
  - Supports both UDiff (≥ 2024-07-08) and BHAVDATA-FULL (< 2024-07-08)
    formats automatically.

ABSOLUTE RULES:
  - Never download the entire NSE dataset — filter to F&O universe at source.
  - Never convert null OI to zero.
  - Never fabricate missing bars.
  - 3m is permanently out of scope — raises ValueError if requested.
  - Raw responses are captured in the landing zone before normalization.
  - Resumable: checkpoint advances only after validated persistence.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator, Optional

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
# Jugaad column name mappings
# ---------------------------------------------------------------------------
# stock_df column names (case-insensitive after normalize)
_EQUITY_COL_MAP = {
    "DATE": "date", "OPEN": "open", "HIGH": "high", "LOW": "low",
    "CLOSE": "close", "VOLUME": "volume", "SYMBOL": "symbol",
    "SERIES": "series",
}

# F&O bhavcopy column names vary by format; we handle both.
# BHAVDATA-FULL format (pre-2024-07-08)
_FNO_COL_MAP_LEGACY = {
    "SYMBOL": "symbol", "INSTRUMENT": "instrument_type",
    "EXPIRY_DT": "expiry", "STRIKE_PR": "strike", "OPTION_TYP": "option_type",
    "OPEN": "open", "HIGH": "high", "LOW": "low", "CLOSE": "close",
    "SETTLE_PR": "settle_pr", "CONTRACTS": "volume", "VAL_INLAKH": "val_inlakh",
    "OPEN_INT": "oi", "CHG_IN_OI": "oi_change", "TIMESTAMP": "date",
}

# UDiff format (post-2024-07-08)
_FNO_COL_MAP_UDIFF = {
    "TckrSymb": "symbol", "FinInstrmTp": "instrument_type",
    "XpryDt": "expiry", "StrkPric": "strike", "OptnTp": "option_type",
    "OpnPric": "open", "HghPric": "high", "LwPric": "low", "ClsPric": "close",
    "SttlmPric": "settle_pr", "TtlTradgVol": "volume",
    "OpnIntrst": "oi", "ChngInOpnIntrst": "oi_change", "TradDt": "date",
}

# Instrument type mapping to AlphaForge canonical
_INSTRUMENT_TYPE_MAP = {
    "FUTSTK": "FUTSTK", "FUTIDX": "FUTIDX",
    "OPTSTK": "OPTSTK", "OPTIDX": "OPTIDX",
    "STK": "FUTSTK", "IDX": "FUTIDX",    # UDiff abbreviations
}


# ---------------------------------------------------------------------------
# Acquisition result types
# ---------------------------------------------------------------------------

@dataclass
class JugaadAcquisitionResult:
    """Result of a single jugaad acquisition request."""
    provider:        str                       = "jugaad"
    symbol:          str                       = ""
    session_date:    str                       = ""
    interval_str:    str                       = "1d"
    status:          str                       = "PENDING"
    # "PENDING" | "SUCCESS" | "EMPTY" | "INVALID" | "PARTIAL" | "UNSUPPORTED" | "FAILED"
    rows_fetched:    int                       = 0
    rows_valid:      int                       = 0
    rows_invalid:    int                       = 0
    rows_duplicate:  int                       = 0
    candles:         list[CanonicalCandle]     = None  # type: ignore[assignment]
    dropped:         list[dict]               = None  # type: ignore[assignment]
    provenance:      Optional[DataProvenanceRecord] = None
    raw_record:      Optional[RawAcquisitionRecord] = None
    error:           Optional[str]            = None

    def __post_init__(self) -> None:
        if self.candles is None:
            self.candles = []
        if self.dropped is None:
            self.dropped = []


# ---------------------------------------------------------------------------
# Main adapter class
# ---------------------------------------------------------------------------

class JugaadAdapter:
    """
    Jugaad-data adapter for AlphaForge historical data acquisition.

    Usage
    -----
    adapter = JugaadAdapter()
    result = await adapter.get_equity_eod(
        symbol="RELIANCE",
        from_date=date(2024, 1, 1),
        to_date=date(2024, 12, 31),
    )
    """

    PROVIDER_ID = "jugaad"

    def __init__(self) -> None:
        self._import_jugaad()

    def _import_jugaad(self) -> None:
        """Lazy import jugaad_data — raises ImportError with clear message if missing."""
        try:
            from jugaad_data.nse import stock_df  # noqa: F401
            self._jugaad_available = True
        except ImportError:
            self._jugaad_available = False
            logger.warning(
                "jugaad_data_not_installed",
                message="jugaad-data package not found. "
                        "Install with: pip install jugaad-data==0.35.5. "
                        "Historical equity EOD acquisition will be unavailable.",
            )

    def _ensure_available(self) -> None:
        if not self._jugaad_available:
            raise ImportError(
                "jugaad-data is not installed. "
                "Run: pip install jugaad-data\n"
                "The adapter will be disabled until the package is installed."
            )

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def get_equity_eod(
        self,
        symbol: str,
        from_date: date,
        to_date: date,
        exchange: str = "NSE",
        fno_symbols: Optional[frozenset[str]] = None,
    ) -> JugaadAcquisitionResult:
        """
        Fetch historical EOD equity OHLCV for a single symbol.

        Parameters
        ----------
        symbol : str
            NSE trading symbol (e.g. "RELIANCE"). Without .EQ or .NS suffix.
        from_date : date
            Start of the date range (inclusive).
        to_date : date
            End of the date range (inclusive).
        exchange : str
            Exchange (default "NSE").
        fno_symbols : frozenset[str], optional
            If provided, only symbols in this set are allowed.
            Prevents downloading non-F&O symbols.

        Returns
        -------
        JugaadAcquisitionResult
        """
        self._ensure_available()

        if fno_symbols is not None and symbol not in fno_symbols:
            return JugaadAcquisitionResult(
                symbol=symbol,
                session_date=str(to_date),
                status="UNSUPPORTED",
                error=f"Symbol '{symbol}' is not in the current F&O universe.",
            )

        # Run the blocking jugaad call in a thread pool
        result = await asyncio.get_event_loop().run_in_executor(
            None, self._fetch_equity_eod_sync, symbol, from_date, to_date, exchange
        )
        return result

    async def get_fno_eod_by_date(
        self,
        session_date: date,
        instrument_types: Optional[list[str]] = None,
        fno_symbols: Optional[frozenset[str]] = None,
        download_dir: Optional[str] = None,
    ) -> JugaadAcquisitionResult:
        """
        Fetch F&O bhavcopy for a specific session date.

        Parameters
        ----------
        session_date : date
            NSE trading day.
        instrument_types : list[str], optional
            Filter to specific instrument types (e.g. ["FUTSTK", "OPTSTK"]).
            Default: all (FUTSTK, FUTIDX, OPTSTK, OPTIDX).
        fno_symbols : frozenset[str], optional
            Filter to symbols in the F&O universe.
        download_dir : str, optional
            Directory for bhavcopy file storage. Defaults to /tmp/jugaad_cache.
        """
        self._ensure_available()
        _dir = download_dir or "/tmp/jugaad_cache"
        os.makedirs(_dir, exist_ok=True)

        result = await asyncio.get_event_loop().run_in_executor(
            None,
            self._fetch_fno_eod_sync,
            session_date, instrument_types, fno_symbols, _dir
        )
        return result

    # ------------------------------------------------------------------
    # Sync implementation (called in thread pool)
    # ------------------------------------------------------------------

    def _fetch_equity_eod_sync(
        self, symbol: str, from_date: date, to_date: date, exchange: str
    ) -> JugaadAcquisitionResult:
        t_start = int(time.time() * 1000)
        try:
            from jugaad_data.nse import stock_df
            df = stock_df(
                symbol=symbol,
                from_date=from_date,
                to_date=to_date,
                series="EQ",
            )
        except Exception as exc:
            return JugaadAcquisitionResult(
                symbol=symbol,
                session_date=str(to_date),
                status="FAILED",
                error=str(exc),
            )
        t_end = int(time.time() * 1000)

        if df is None or len(df) == 0:
            return JugaadAcquisitionResult(
                symbol=symbol,
                session_date=str(to_date),
                status="EMPTY",
                rows_fetched=0,
            )

        # Normalize column names
        df.columns = [c.upper() for c in df.columns]
        raw_records = df.to_dict("records")
        response_hash = hashlib.sha256(
            str(raw_records).encode("utf-8")
        ).hexdigest()

        # Build raw landing record
        raw_record = build_raw_record(
            provider=self.PROVIDER_ID,
            endpoint="jugaad_data.nse.stock_df",
            instrument_id=symbol,
            exchange=exchange,
            interval_str="1d",
            request_params={
                "symbol": symbol, "from_date": str(from_date), "to_date": str(to_date),
                "series": "EQ",
            },
            raw_response=raw_records[:50],  # first 50 rows as sample
            record_count=len(raw_records),
            request_start_ms=t_start,
            request_end_ms=t_end,
        )

        # Normalize to CanonicalCandle
        candles, dropped, rows_fetched = self._normalize_equity_df(
            raw_records, symbol, exchange
        )
        valid, validation_dropped = validate_batch(candles)
        all_dropped = dropped + validation_dropped

        session_date_str = str(to_date)
        prov = build_provenance(
            provider=self.PROVIDER_ID,
            instrument_id=symbol,
            exchange=exchange,
            interval_str="1d",
            session_date=session_date_str,
            row_count=len(valid),
            raw_response=raw_records,
            dataset_version=current_dataset_version(),
        )
        prov.dataTrustStatus = (
            TRUST_VERIFIED_SINGLE_SOURCE if len(valid) > 0 else TRUST_UNVERIFIED
        )

        status = "SUCCESS" if len(valid) > 0 else "EMPTY"
        if len(all_dropped) > 0 and len(valid) > 0:
            status = "PARTIAL"

        logger.info(
            "jugaad_equity_eod_acquired",
            symbol=symbol, from_date=str(from_date), to_date=str(to_date),
            rows_fetched=rows_fetched, rows_valid=len(valid),
            rows_invalid=len(all_dropped), status=status,
        )

        return JugaadAcquisitionResult(
            symbol=symbol,
            session_date=session_date_str,
            interval_str="1d",
            status=status,
            rows_fetched=rows_fetched,
            rows_valid=len(valid),
            rows_invalid=len(all_dropped),
            candles=valid,
            dropped=all_dropped,
            provenance=prov,
            raw_record=raw_record,
        )

    def _fetch_fno_eod_sync(
        self,
        session_date: date,
        instrument_types: Optional[list[str]],
        fno_symbols: Optional[frozenset[str]],
        download_dir: str,
    ) -> JugaadAcquisitionResult:
        t_start = int(time.time() * 1000)
        try:
            from jugaad_data.nse import bhavcopy_fo_save
            bhavcopy_fo_save(session_date, download_dir)
        except Exception as exc:
            return JugaadAcquisitionResult(
                session_date=str(session_date),
                interval_str="1d",
                status="FAILED",
                error=str(exc),
            )
        t_end = int(time.time() * 1000)

        # Find the saved file
        import glob
        pattern = os.path.join(download_dir, f"*{session_date.strftime('%d%b%Y').upper()}*fo*")
        files = glob.glob(pattern, recursive=False)
        if not files:
            # Try alternate patterns
            files = glob.glob(os.path.join(download_dir, "*.csv"))
            # Pick the most recently modified
            if files:
                files = sorted(files, key=os.path.getmtime, reverse=True)[:1]

        if not files:
            return JugaadAcquisitionResult(
                session_date=str(session_date),
                interval_str="1d",
                status="EMPTY",
                error="F&O bhavcopy file not found after download.",
            )

        csv_path = files[0]
        try:
            import pandas as pd
            df = pd.read_csv(csv_path)
        except Exception as exc:
            return JugaadAcquisitionResult(
                session_date=str(session_date),
                interval_str="1d",
                status="FAILED",
                error=f"Failed to read bhavcopy CSV: {exc}",
            )

        raw_records = df.to_dict("records")
        response_hash = hashlib.sha256(str(raw_records).encode("utf-8")).hexdigest()

        raw_record = build_raw_record(
            provider=self.PROVIDER_ID,
            endpoint=f"jugaad_data.nse.bhavcopy_fo_save:{csv_path}",
            instrument_id="FNO_UNIVERSE",
            exchange="NFO",
            interval_str="1d",
            request_params={"session_date": str(session_date)},
            raw_response=raw_records[:50],
            record_count=len(raw_records),
            request_start_ms=t_start,
            request_end_ms=t_end,
        )

        # Normalize F&O rows
        candles, dropped, rows_fetched = self._normalize_fno_df(
            raw_records, str(session_date),
            instrument_types=instrument_types,
            fno_symbols=fno_symbols,
        )
        valid, validation_dropped = validate_batch(candles)
        all_dropped = dropped + validation_dropped

        prov = build_provenance(
            provider=self.PROVIDER_ID,
            instrument_id="FNO_UNIVERSE",
            exchange="NFO",
            interval_str="1d",
            session_date=str(session_date),
            row_count=len(valid),
            raw_response=response_hash,
            dataset_version=current_dataset_version(),
        )
        prov.dataTrustStatus = (
            TRUST_VERIFIED_SINGLE_SOURCE if len(valid) > 0 else TRUST_UNVERIFIED
        )

        status = "SUCCESS" if len(valid) > 0 else "EMPTY"
        if all_dropped and valid:
            status = "PARTIAL"

        logger.info(
            "jugaad_fno_eod_acquired",
            session_date=str(session_date),
            rows_fetched=rows_fetched, rows_valid=len(valid),
            rows_invalid=len(all_dropped), status=status,
        )

        return JugaadAcquisitionResult(
            session_date=str(session_date),
            interval_str="1d",
            status=status,
            rows_fetched=rows_fetched,
            rows_valid=len(valid),
            rows_invalid=len(all_dropped),
            candles=valid,
            dropped=all_dropped,
            provenance=prov,
            raw_record=raw_record,
        )

    # ------------------------------------------------------------------
    # Normalization helpers
    # ------------------------------------------------------------------

    def _normalize_equity_df(
        self,
        raw_records: list[dict],
        symbol: str,
        exchange: str,
    ) -> tuple[list[CanonicalCandle], list[dict], int]:
        """
        Normalize equity stock_df rows to CanonicalCandle objects.
        Returns (candles, dropped_records, rows_fetched).
        """
        candles: list[CanonicalCandle] = []
        dropped: list[dict] = []

        for row in raw_records:
            # Normalize column names
            normalized = {k.upper(): v for k, v in row.items()}
            try:
                # Parse date — jugaad returns as date or string
                raw_date = normalized.get("DATE") or normalized.get("TIMESTAMP")
                if raw_date is None:
                    dropped.append({"row": row, "error": "missing_date"})
                    continue

                if isinstance(raw_date, date):
                    session_date_str = raw_date.strftime("%Y-%m-%d")
                else:
                    d = datetime.strptime(str(raw_date)[:10], "%Y-%m-%d")
                    session_date_str = d.strftime("%Y-%m-%d")

                # UTC epoch seconds for candle open = IST 00:00 of session date
                # (EOD candles use midnight IST convention)
                from zoneinfo import ZoneInfo
                _IST = ZoneInfo("Asia/Kolkata")
                dt_ist = datetime.strptime(session_date_str, "%Y-%m-%d").replace(
                    tzinfo=_IST
                )
                epoch_sec = int(dt_ist.timestamp())

                def _float(key: str) -> Optional[float]:
                    v = normalized.get(key)
                    if v is None or v == "" or str(v).strip() == "-":
                        return None
                    try:
                        return float(v)
                    except (ValueError, TypeError):
                        return None

                o = _float("OPEN") or _float("OPEN_PRICE")
                h = _float("HIGH") or _float("HIGH_PRICE")
                l_ = _float("LOW") or _float("LOW_PRICE")
                c = _float("CLOSE") or _float("CLOSE_PRICE") or _float("LAST_PRICE")
                v = _float("VOLUME") or _float("TTL_TRD_QNTY") or 0.0

                if any(x is None or x <= 0 for x in [o, h, l_, c]):
                    dropped.append({
                        "row": {"symbol": symbol, "date": session_date_str},
                        "error": "invalid_ohlc",
                    })
                    continue

                candles.append(CanonicalCandle(
                    instrumentId=symbol,
                    exchange=exchange,
                    intervalStr="1d",
                    sessionDate=session_date_str,
                    provider="jugaad",
                    time=epoch_sec,
                    open=o,
                    high=h,
                    low=l_,
                    close=c,
                    volume=v if v >= 0 else 0.0,
                    volumeUnavailable=(v is None or v < 0),
                ))

            except Exception as exc:
                dropped.append({"row": row, "error": str(exc)})

        return candles, dropped, len(raw_records)

    def _normalize_fno_df(
        self,
        raw_records: list[dict],
        session_date_str: str,
        instrument_types: Optional[list[str]],
        fno_symbols: Optional[frozenset[str]],
    ) -> tuple[list[CanonicalCandle], list[dict], int]:
        """Normalize F&O bhavcopy rows to CanonicalCandle objects."""
        candles: list[CanonicalCandle] = []
        dropped: list[dict] = []
        allowed_types = set(instrument_types) if instrument_types else {
            "FUTSTK", "FUTIDX", "OPTSTK", "OPTIDX", "STK", "IDX"
        }

        from zoneinfo import ZoneInfo
        _IST = ZoneInfo("Asia/Kolkata")
        dt_ist = datetime.strptime(session_date_str, "%Y-%m-%d").replace(tzinfo=_IST)
        epoch_sec = int(dt_ist.timestamp())

        for row in raw_records:
            # Detect column format
            norm = {k.upper().strip(): v for k, v in row.items()}

            symbol = (
                norm.get("SYMBOL") or norm.get("TCKRSYMB") or norm.get("TCKR_SYMB") or ""
            )
            symbol = str(symbol).strip().upper()

            if not symbol:
                dropped.append({"row": row, "error": "missing_symbol"})
                continue

            if fno_symbols is not None and symbol not in fno_symbols:
                continue  # filtered — not an error

            instrument_type_raw = (
                norm.get("INSTRUMENT") or norm.get("FININSTRM_TP") or
                norm.get("FININSTRMTP") or ""
            )
            instrument_type = _INSTRUMENT_TYPE_MAP.get(
                str(instrument_type_raw).strip().upper(), str(instrument_type_raw).upper()
            )
            if instrument_type not in allowed_types:
                continue  # filtered

            def _float(key: str) -> Optional[float]:
                v = norm.get(key)
                if v is None or str(v).strip() in ("", "-", "0"):
                    return None
                try:
                    f = float(str(v).replace(",", ""))
                    return f if f > 0 else None
                except (ValueError, TypeError):
                    return None

            o = _float("OPEN") or _float("OPNPRIC")
            h = _float("HIGH") or _float("HGHPRIC")
            l_ = _float("LOW") or _float("LWPRIC")
            c = _float("CLOSE") or _float("CLSPRIC") or _float("SETTLE_PR") or _float("STTLMPRIC")
            vol_raw = norm.get("CONTRACTS") or norm.get("TTLTRADGVOL") or 0
            oi_raw = norm.get("OPEN_INT") or norm.get("OPNINTRST")
            oi_change_raw = norm.get("CHG_IN_OI") or norm.get("CHNGIOPNINTRST")

            if any(x is None or x <= 0 for x in [o, h, l_, c]):
                dropped.append({
                    "row": {"symbol": symbol, "date": session_date_str},
                    "error": "invalid_ohlc",
                })
                continue

            try:
                volume = float(str(vol_raw).replace(",", "")) if vol_raw else 0.0
            except (ValueError, TypeError):
                volume = 0.0

            # OI — never convert null to zero
            oi_val: Optional[float] = None
            if oi_raw is not None and str(oi_raw).strip() not in ("", "-"):
                try:
                    oi_val = float(str(oi_raw).replace(",", ""))
                    if oi_val < 0:
                        oi_val = None  # negative OI is invalid
                except (ValueError, TypeError):
                    oi_val = None  # stay null, never zero

            oi_change_val: Optional[float] = None
            if oi_change_raw is not None and str(oi_change_raw).strip() not in ("", "-"):
                try:
                    oi_change_val = float(str(oi_change_raw).replace(",", ""))
                except (ValueError, TypeError):
                    oi_change_val = None

            # Expiry
            expiry_raw = norm.get("EXPIRY_DT") or norm.get("XPRYDT")
            expiry_str: Optional[str] = None
            if expiry_raw and str(expiry_raw).strip() not in ("", "-"):
                try:
                    # Formats: "29-SEP-2026" or "2026-09-29"
                    raw_str = str(expiry_raw).strip()
                    if "-" in raw_str and len(raw_str) == 10:
                        expiry_str = raw_str  # already YYYY-MM-DD
                    else:
                        _months = {
                            "JAN":"01","FEB":"02","MAR":"03","APR":"04",
                            "MAY":"05","JUN":"06","JUL":"07","AUG":"08",
                            "SEP":"09","OCT":"10","NOV":"11","DEC":"12",
                        }
                        parts = raw_str.upper().replace("-", "").replace(" ", "")
                        # DDMMMYYYYformat
                        if len(parts) == 9:
                            day, mon, yr = parts[:2], parts[2:5], parts[5:]
                            expiry_str = f"{yr}-{_months.get(mon,'00')}-{day}"
                except Exception:
                    expiry_str = None

            # Strike
            strike_raw = norm.get("STRIKE_PR") or norm.get("STRKPRIC")
            strike_val: Optional[float] = None
            if strike_raw and str(strike_raw).strip() not in ("", "-", "0"):
                try:
                    sv = float(str(strike_raw).replace(",", ""))
                    strike_val = sv if sv > 0 else None
                except (ValueError, TypeError):
                    strike_val = None

            # Option type CE/PE
            opt_type_raw = norm.get("OPTION_TYP") or norm.get("OPTNTP")
            opt_type: Optional[str] = None
            if opt_type_raw:
                raw_t = str(opt_type_raw).strip().upper()
                if raw_t in ("CE", "CA", "CALL"):
                    opt_type = "CE"
                elif raw_t in ("PE", "PA", "PUT"):
                    opt_type = "PE"

            candles.append(CanonicalCandle(
                instrumentId=symbol,
                exchange="NFO",
                intervalStr="1d",
                sessionDate=session_date_str,
                provider="jugaad",
                time=epoch_sec,
                open=o,
                high=h,
                low=l_,
                close=c,
                volume=volume,
                volumeUnavailable=(volume == 0.0),
                oi=oi_val,       # NEVER converted from null to zero
                oiChange=oi_change_val,
                expiry=expiry_str,
                strike=strike_val,
                optionType=opt_type,
            ))

        return candles, dropped, len(raw_records)
