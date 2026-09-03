"""
BhavcopyScraper — ``GET /scraping/historical`` routing, validation, and caching.

This module is the outermost layer of the historical OHLCV pipeline:

  request → validate → redis cache (intraday) / disk cache (daily)
          → fetch → cache write → respond

Fetch implementations:
  - _fetch_nse_daily / _fetch_bse_daily: NSE and BSE Bhavcopy archives (FetcherSession).
  - _fetch_nse_intraday / _fetch_bse_intraday: NSE and BSE charting APIs (httpx).

Cache architecture
------------------
Intraday intervals (5m, 15m, 30m, 1h):
  Redis key : ``scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}``
  TTL       : 3600 s

Daily interval (1d):
  Disk path : ``{data_dir}/bhavcopy/{exchange}/{symbol}/{date}.csv.gz``
  Staleness : serve if mtime < 24 h ago (otherwise re-fetch and overwrite)
"""

from __future__ import annotations

import gzip
import json
import os
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from src.config import settings
from src.schemas import OHLCVCandle
from src.anti_ban.rate_limiter import create_domain_limiters

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Per-domain rate limiters — instantiated lazily on first use
# ---------------------------------------------------------------------------
# These are module-level singletons. They are created lazily (not at import
# time) so the module loads cleanly before the event loop is running.
# All HTTP calls to nseindia.com and bseindia.com must call .acquire() first.
_limiters: dict | None = None


def _get_limiters() -> dict:
    global _limiters
    if _limiters is None:
        _limiters = create_domain_limiters(
            nse_rate=settings.nse_rate_limit,
            bse_rate=settings.bse_rate_limit,
        )
    return _limiters

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_VALID_EXCHANGES: frozenset[str] = frozenset({"NSE", "BSE"})
_VALID_INTERVALS: frozenset[str] = frozenset({"1d", "5m", "15m", "30m", "1h"})
_INTRADAY_INTERVALS: frozenset[str] = frozenset({"5m", "15m", "30m", "1h"})

_MAX_DAILY_DAYS: int = 1825    # 5 years
_MAX_INTRADAY_DAYS: int = 365  # 1 year

_INTRADAY_REDIS_TTL: int = 3600  # seconds
_DISK_CACHE_MAX_AGE: int = 86_400  # 24 hours in seconds


# ---------------------------------------------------------------------------
# Fetch implementations (Tasks 4.2 and 4.3)
# ---------------------------------------------------------------------------


async def _write_disk_cache(
    exchange: str,
    symbol: str,
    from_date: date,
    candles: list[OHLCVCandle],
) -> None:
    """
    Write a candles list to the daily Bhavcopy disk cache as gzip-compressed JSON.

    Path: ``{data_dir}/bhavcopy/{exchange}/{symbol}/{from_date}.csv.gz``

    Errors are logged and swallowed — a cache write failure never blocks the
    HTTP response.
    """
    path = _daily_disk_cache_path(exchange, symbol, from_date)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        payload = json.dumps([c.model_dump() for c in candles])
        with gzip.open(path, "wt", encoding="utf-8") as fh:
            fh.write(payload)
        logger.debug("disk_cache_write_ok", path=path, count=len(candles))
    except Exception as exc:
        logger.warning("disk_cache_write_error", path=path, error=str(exc))


async def _fetch_nse_daily(
    symbol: str,
    from_date: date,
    to_date: date,
) -> list[OHLCVCandle]:
    """
    Fetch NSE daily Bhavcopy from nsearchives CDN (no anti-bot protection).

    Downloads the bulk equity data CSV for each trading day in the requested
    range from ``nsearchives.nseindia.com``.  The CDN is served by CloudFront
    and requires no TLS spoofing or session cookies.

    URL pattern per day::

        https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{DDMMYYYY}.csv

    CSV columns (pipe-delimited, all columns are present but we only need):
        SYMBOL, SERIES, OPEN, HIGH, LOW, CLOSE, TOTTRDQTY, ...

    After a successful fetch the parsed candles are written to the disk
    cache (``{data_dir}/bhavcopy/NSE/{symbol}/{from_date}.csv.gz``).

    Raises any exception on HTTP error; the caller converts to HTTP 503.
    """
    import csv
    import io

    candles: list[OHLCVCandle] = []
    symbol_upper = symbol.upper()

    current = from_date
    async with httpx.AsyncClient(
        timeout=30.0,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Referer": "https://www.nseindia.com/",
        },
        follow_redirects=True,
    ) as client:
        while current <= to_date:
            # Skip weekends — NSE does not publish Bhavcopy on Sat/Sun
            if current.weekday() >= 5:
                current += timedelta(days=1)
                continue

            ddmmyyyy = current.strftime("%d%m%Y")
            url = (
                f"https://nsearchives.nseindia.com/products/content/"
                f"sec_bhavdata_full_{ddmmyyyy}.csv"
            )

            try:
                # Rate-limit: NSE archives is CDN (no anti-bot), use noop limiter
                await _get_limiters()["nsearchives.nseindia.com"].acquire()
                resp = await client.get(url)
                if resp.status_code == 404:
                    # Market holiday — silently skip
                    logger.debug("nse_daily_404_skip", date=current.isoformat())
                    current += timedelta(days=1)
                    continue
                resp.raise_for_status()

                # The bulk file is pipe-delimited, encoding may vary
                try:
                    csv_text = resp.content.decode("utf-8")
                except UnicodeDecodeError:
                    csv_text = resp.content.decode("latin-1")

                time_utc = int(
                    datetime(
                        current.year, current.month, current.day,
                        tzinfo=timezone.utc,
                    ).timestamp()
                )

                reader = csv.DictReader(io.StringIO(csv_text), skipinitialspace=True)
                for row in reader:
                    # Column names have leading/trailing spaces in some versions
                    row_sym = row.get("SYMBOL", row.get(" SYMBOL", "")).strip().upper()
                    if row_sym != symbol_upper:
                        continue
                    series = row.get("SERIES", row.get(" SERIES", "")).strip()
                    if series not in ("EQ", "BE", "BZ", "SM", "ST"):
                        continue

                    try:
                        open_ = float(row.get("OPEN", row.get(" OPEN", 0)))
                        high  = float(row.get("HIGH", row.get(" HIGH", 0)))
                        low   = float(row.get("LOW",  row.get(" LOW",  0)))
                        close = float(row.get("CLOSE", row.get(" CLOSE", 0)))
                        volume = int(float(row.get("TOTTRDQTY", row.get(" TOTTRDQTY", 0)) or 0))

                        if high < max(open_, close) or low > min(open_, close):
                            continue
                        if open_ <= 0 or high <= 0 or low <= 0 or close <= 0:
                            continue

                        candles.append(OHLCVCandle(
                            time=time_utc,
                            open=open_, high=high, low=low, close=close,
                            volume=volume,
                        ))
                        break  # only one row per symbol per day
                    except (KeyError, ValueError, OverflowError) as exc:
                        logger.debug("nse_daily_row_skip", symbol=symbol, error=str(exc))
                        continue

            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "nse_daily_http_error",
                    date=current.isoformat(),
                    status=exc.response.status_code,
                )
            except Exception as exc:
                logger.warning(
                    "nse_daily_fetch_error",
                    date=current.isoformat(),
                    error=str(exc),
                )

            current += timedelta(days=1)

    if candles:
        await _write_disk_cache("NSE", symbol, from_date, candles)

    return candles


async def _fetch_bse_daily(
    symbol: str,
    from_date: date,
    to_date: date,
) -> list[OHLCVCandle]:
    """
    Fetch BSE daily Bhavcopy by downloading one ZIP archive per calendar day.

    URL pattern per day::

        https://www.bseindia.com/download/BhavCopy/Equity/EQ{DDMMYYYY}_CSV.ZIP

    ZIP contains ``EQ{DDMMYYYY}_CSV.CSV`` with columns::

        Code, Name, Open, High, Low, Close, No of Shares, ...

    Only rows where ``Name`` matches *symbol* (case-insensitive) are kept.
    Weekends (Saturday, Sunday) are skipped.

    ``httpx.AsyncClient`` is used for archive downloads (no TLS spoofing needed
    for BSE's CloudFront-served static files).

    After a successful fetch the parsed candles are written to the disk cache
    (``{data_dir}/bhavcopy/BSE/{symbol}/{from_date}.csv.gz``).

    Raises on HTTP error or parse failure; the caller converts to HTTP 503.
    """
    import csv
    import io
    import zipfile

    candles: list[OHLCVCandle] = []
    symbol_upper = symbol.upper()

    current = from_date
    async with httpx.AsyncClient(
        timeout=30.0,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Referer": "https://www.bseindia.com/",
        },
        follow_redirects=True,
    ) as client:
        while current <= to_date:
            # Skip weekends — BSE does not publish Bhavcopy on Sat/Sun
            if current.weekday() >= 5:
                current += timedelta(days=1)
                continue

            ddmmyyyy = current.strftime("%d%m%Y")
            url = (
                f"https://www.bseindia.com/download/BhavCopy/Equity/"
                f"EQ{ddmmyyyy}_CSV.ZIP"
            )

            try:
                resp = await client.get(url)
                if resp.status_code == 404:
                    # BSE does not publish on holidays — silently skip
                    logger.debug("bse_daily_404_skip", date=current.isoformat(), url=url)
                    current += timedelta(days=1)
                    continue
                resp.raise_for_status()

                zip_bytes = resp.content
                csv_filename = f"EQ{ddmmyyyy}_CSV.CSV"

                with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                    # The filename casing can vary; do a case-insensitive match
                    names = {n.upper(): n for n in zf.namelist()}
                    actual_name = names.get(csv_filename.upper())
                    if actual_name is None:
                        logger.warning(
                            "bse_daily_csv_not_found_in_zip",
                            expected=csv_filename,
                            available=list(zf.namelist()),
                            date=current.isoformat(),
                        )
                        current += timedelta(days=1)
                        continue

                    csv_bytes = zf.read(actual_name)

                # Try UTF-8 first, fall back to latin-1 (BSE uses both)
                try:
                    csv_text = csv_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    csv_text = csv_bytes.decode("latin-1")

                reader = csv.DictReader(io.StringIO(csv_text))
                for row in reader:
                    name_col = row.get("Name", "").strip().upper()
                    if name_col != symbol_upper:
                        continue

                    try:
                        open_ = float(row["Open"])
                        high = float(row["High"])
                        low = float(row["Low"])
                        close = float(row["Close"])
                        volume = int(float(row.get("No of Shares", "0") or "0"))

                        time_utc = int(
                            datetime(
                                current.year,
                                current.month,
                                current.day,
                                tzinfo=timezone.utc,
                            ).timestamp()
                        )

                        # Validate OHLC invariants
                        if high < max(open_, close):
                            logger.debug(
                                "bse_daily_skip_invalid_high",
                                symbol=symbol,
                                date=current.isoformat(),
                            )
                            continue
                        if low > min(open_, close):
                            logger.debug(
                                "bse_daily_skip_invalid_low",
                                symbol=symbol,
                                date=current.isoformat(),
                            )
                            continue
                        if open_ <= 0 or high <= 0 or low <= 0 or close <= 0:
                            continue
                        if volume < 0:
                            continue

                        candles.append(
                            OHLCVCandle(
                                time=time_utc,
                                open=open_,
                                high=high,
                                low=low,
                                close=close,
                                volume=volume,
                            )
                        )
                    except (KeyError, ValueError, OverflowError) as exc:
                        logger.debug(
                            "bse_daily_row_skip",
                            symbol=symbol,
                            date=current.isoformat(),
                            error=str(exc),
                        )
                        continue

            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "bse_daily_http_error",
                    date=current.isoformat(),
                    status=exc.response.status_code,
                    url=url,
                )
                # Non-fatal: skip this day and continue the range
            except Exception as exc:
                logger.warning(
                    "bse_daily_fetch_error",
                    date=current.isoformat(),
                    error=str(exc),
                )
                # Non-fatal for individual days; continue range

            current += timedelta(days=1)

    # --- disk cache write (fire-and-forget) ----------------------------------
    if candles:
        await _write_disk_cache("BSE", symbol, from_date, candles)

    return candles



# ---------------------------------------------------------------------------
# Interval → period/resolution mapping (shared by NSE and BSE)
# ---------------------------------------------------------------------------

_INTERVAL_TO_PERIOD: dict[str, str] = {
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
}

# IST offset in seconds (UTC+5:30 = 5*3600 + 30*60)
_IST_OFFSET_SECONDS: int = 19_800

# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------


def _ist_ms_to_utc_s(ts_ms_ist: int | float) -> int:
    """Convert an IST millisecond timestamp to a UTC epoch-second integer.

    Formula: utc_epoch_s = int(ts_ms_ist / 1000) - 19800
    """
    return int(ts_ms_ist / 1000) - _IST_OFFSET_SECONDS


def _validate_candle_row(
    open_: float,
    high: float,
    low: float,
    close: float,
    volume: int,
) -> bool:
    """Return True when the row satisfies the OHLCVCandle price invariants.

    Invariants (from Requirement 2.7):
      - all prices > 0
      - high >= max(open, close)
      - low  <= min(open, close)
      - volume >= 0
    """
    if open_ <= 0 or high <= 0 or low <= 0 or close <= 0:
        return False
    if volume < 0:
        return False
    if high < max(open_, close):
        return False
    if low > min(open_, close):
        return False
    return True


def _parse_raw_row(
    row: Any,
    source: str,
) -> OHLCVCandle | None:
    """Parse a raw ``[ts_ms_ist, open, high, low, close, volume]`` array.

    Returns a validated ``OHLCVCandle`` or ``None`` when the row is malformed
    or fails the price-invariant check.  Failures are logged at WARNING level.
    """
    try:
        ts_ms_ist, open_, high, low, close, volume = (
            row[0],
            float(row[1]),
            float(row[2]),
            float(row[3]),
            float(row[4]),
            int(row[5]),
        )
    except (IndexError, TypeError, ValueError) as exc:
        logger.warning("intraday_row_parse_error", source=source, row=row, error=str(exc))
        return None

    if not _validate_candle_row(open_, high, low, close, volume):
        logger.warning(
            "intraday_candle_invalid",
            source=source,
            ts_ms_ist=ts_ms_ist,
            open=open_,
            high=high,
            low=low,
            close=close,
            volume=volume,
        )
        return None

    return OHLCVCandle(
        time=_ist_ms_to_utc_s(ts_ms_ist),
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
    )


# ---------------------------------------------------------------------------
# NSE intraday fetch (charting.nseindia.com)
# ---------------------------------------------------------------------------

_NSE_CHARTING_URL = "https://charting.nseindia.com/charts/getData"

_NSE_CHARTING_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Referer": "https://www.nseindia.com/",
}


async def _fetch_nse_intraday(
    symbol: str,
    interval: str,
    from_date: date,
    to_date: date,
) -> list[OHLCVCandle]:
    """Fetch NSE intraday OHLCV from the NSE charting API.

    URL pattern::

        GET https://charting.nseindia.com/charts/getData
            ?appid=chartiq&callback=&symbol={SYMBOL}&period={5|15|30|60}
            &type=EQ&startDate={DD-MM-YYYY}&endDate={DD-MM-YYYY}

    Response JSON::

        {"grapthData": [[timestamp_ms_ist, open, high, low, close, volume], ...]}

    Note: the key is ``grapthData`` — this is a typo in the NSE API; it is
    preserved here intentionally.

    All timestamps are converted from IST milliseconds to UTC epoch seconds.
    Candles that fail the price-invariant check are logged and skipped.
    """
    period = _INTERVAL_TO_PERIOD.get(interval)
    if period is None:
        logger.error("nse_intraday_unknown_interval", interval=interval)
        return []

    params = {
        "appid": "chartiq",
        "callback": "",
        "symbol": symbol,
        "period": period,
        "type": "EQ",
        "startDate": from_date.strftime("%d-%m-%Y"),
        "endDate": to_date.strftime("%d-%m-%Y"),
    }

    log = logger.bind(
        source="nse_intraday",
        symbol=symbol,
        interval=interval,
        from_date=from_date.isoformat(),
        to_date=to_date.isoformat(),
    )

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            # Rate-limit NSE charting API
            await _get_limiters()["nseindia.com"].acquire()
            response = await client.get(
                _NSE_CHARTING_URL,
                params=params,
                headers=_NSE_CHARTING_HEADERS,
            )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"NSE charting API timed out: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"NSE charting API returned HTTP {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            raise RuntimeError(f"NSE charting API request failed: {exc}") from exc

    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f"NSE charting API returned non-JSON body: {exc}") from exc

    # The NSE API uses the misspelled key "grapthData"
    raw_rows = payload.get("grapthData")
    if not isinstance(raw_rows, list):
        log.warning("nse_intraday_unexpected_shape", keys=list(payload.keys()))
        return []

    candles: list[OHLCVCandle] = []
    for row in raw_rows:
        candle = _parse_raw_row(row, source="nse_intraday")
        if candle is not None:
            candles.append(candle)

    candles.sort(key=lambda c: c.time)
    log.info("nse_intraday_fetched", count=len(candles), skipped=len(raw_rows) - len(candles))
    return candles


# ---------------------------------------------------------------------------
# BSE intraday fetch (api.bseindia.com/StockReachGraph)
# ---------------------------------------------------------------------------

_BSE_CHARTING_URL = "https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w"

_BSE_CHARTING_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Referer": "https://www.bseindia.com/",
}


async def _fetch_bse_intraday(
    symbol: str,
    bse_code: str,
    interval: str,
    from_date: date,
    to_date: date,
) -> list[OHLCVCandle]:
    """Fetch BSE intraday OHLCV from the BSE StockReachGraph API.

    URL pattern::

        GET https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w
            ?scripcode={bse_code}&Resolution={5|15|30|60}&Category=EQ
            &FromDate={DD%2FMM%2FYYYY}&ToDate={DD%2FMM%2FYYYY}

    Response JSON::

        {"Data": [[timestamp_ms_ist, open, high, low, close, volume], ...]}

    All timestamps are converted from IST milliseconds to UTC epoch seconds.
    Candles that fail the price-invariant check are logged and skipped.

    ``bse_code`` is the BSE scrip code for the symbol.  Until the instrument
    master (Task 7) is fully wired, the caller passes the symbol string as a
    placeholder, which matches the existing behaviour of the outer route handler.
    """
    resolution = _INTERVAL_TO_PERIOD.get(interval)
    if resolution is None:
        logger.error("bse_intraday_unknown_interval", interval=interval)
        return []

    # BSE expects DD/MM/YYYY (URL-encoded as DD%2FMM%2FYYYY, handled by httpx)
    params = {
        "scripcode": bse_code,
        "Resolution": resolution,
        "Category": "EQ",
        "FromDate": from_date.strftime("%d/%m/%Y"),
        "ToDate": to_date.strftime("%d/%m/%Y"),
    }

    log = logger.bind(
        source="bse_intraday",
        symbol=symbol,
        bse_code=bse_code,
        interval=interval,
        from_date=from_date.isoformat(),
        to_date=to_date.isoformat(),
    )

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            # Rate-limit BSE charting API
            await _get_limiters()["bseindia.com"].acquire()
            response = await client.get(
                _BSE_CHARTING_URL,
                params=params,
                headers=_BSE_CHARTING_HEADERS,
            )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"BSE charting API timed out: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"BSE charting API returned HTTP {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            raise RuntimeError(f"BSE charting API request failed: {exc}") from exc

    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f"BSE charting API returned non-JSON body: {exc}") from exc

    raw_rows = payload.get("Data")
    if not isinstance(raw_rows, list):
        log.warning("bse_intraday_unexpected_shape", keys=list(payload.keys()))
        return []

    candles: list[OHLCVCandle] = []
    for row in raw_rows:
        candle = _parse_raw_row(row, source="bse_intraday")
        if candle is not None:
            candles.append(candle)

    candles.sort(key=lambda c: c.time)
    log.info("bse_intraday_fetched", count=len(candles), skipped=len(raw_rows) - len(candles))
    return candles


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def _parse_iso_date(value: str, param_name: str) -> date | JSONResponse:
    """Parse an ISO 8601 date or datetime string into a ``date``.

    Accepts both ``YYYY-MM-DD`` and full datetime strings like
    ``2025-09-03T13:20:52.952Z`` — the time component is stripped.
    Returns a ``JSONResponse`` (HTTP 400) when the value cannot be parsed.
    """
    try:
        # Strip the time portion if present (everything from 'T' onwards)
        date_part = value.split("T")[0]
        return date.fromisoformat(date_part)
    except (ValueError, AttributeError):
        return JSONResponse(
            status_code=400,
            content={"error": f"'{param_name}' must be a valid ISO 8601 date (YYYY-MM-DD or YYYY-MM-DDThh:mm:ssZ), got '{value}'"},
        )


def _validate_params(
    symbol: str | None,
    exchange: str | None,
    interval: str | None,
    from_str: str | None,
    to_str: str | None,
) -> tuple[date, date] | JSONResponse:
    """
    Validate all request parameters in order.

    Returns ``(from_date, to_date)`` on success, or a ``JSONResponse`` (HTTP 400)
    describing the first validation failure encountered.
    """
    # --- Required field presence ---
    missing = [
        name
        for name, val in [
            ("symbol", symbol),
            ("exchange", exchange),
            ("interval", interval),
            ("from", from_str),
            ("to", to_str),
        ]
        if not val
    ]
    if missing:
        return JSONResponse(
            status_code=400,
            content={"error": f"Missing required parameter(s): {', '.join(missing)}"},
        )

    # --- exchange ---
    if exchange not in _VALID_EXCHANGES:
        return JSONResponse(
            status_code=400,
            content={"error": f"'exchange' must be one of {sorted(_VALID_EXCHANGES)}, got '{exchange}'"},
        )

    # --- interval ---
    if interval not in _VALID_INTERVALS:
        return JSONResponse(
            status_code=400,
            content={"error": f"'interval' must be one of {sorted(_VALID_INTERVALS)}, got '{interval}'"},
        )

    # --- date parsing ---
    from_result = _parse_iso_date(from_str, "from")  # type: ignore[arg-type]
    if isinstance(from_result, JSONResponse):
        return from_result

    to_result = _parse_iso_date(to_str, "to")  # type: ignore[arg-type]
    if isinstance(to_result, JSONResponse):
        return to_result

    from_date: date = from_result  # type: ignore[assignment]
    to_date: date = to_result  # type: ignore[assignment]

    # --- from <= to ---
    if from_date > to_date:
        return JSONResponse(
            status_code=400,
            content={"error": f"'from' ({from_date}) must not be later than 'to' ({to_date})"},
        )

    # --- max date range ---
    span_days = (to_date - from_date).days

    if interval == "1d" and span_days > _MAX_DAILY_DAYS:
        return JSONResponse(
            status_code=400,
            content={"error": f"Maximum range is {_MAX_DAILY_DAYS} days for interval 1d"},
        )

    if interval in _INTRADAY_INTERVALS and span_days > _MAX_INTRADAY_DAYS:
        return JSONResponse(
            status_code=400,
            content={"error": f"Maximum range is {_MAX_INTRADAY_DAYS} days for interval {interval}"},
        )

    return from_date, to_date


# ---------------------------------------------------------------------------
# Redis cache helpers
# ---------------------------------------------------------------------------


def _intraday_redis_key(
    exchange: str,
    symbol: str,
    interval: str,
    from_date: date,
    to_date: date,
) -> str:
    """Build the Redis cache key for an intraday historical request."""
    return (
        f"scraping:hist:{exchange}:{symbol}:{interval}"
        f":{from_date.isoformat()}:{to_date.isoformat()}"
    )


async def _redis_get(redis: Any, key: str) -> list[dict] | None:
    """
    Attempt to retrieve a cached candles list from Redis.

    Returns the deserialized list on a cache hit, or ``None`` on a miss or
    when ``redis`` is ``None``.
    """
    if redis is None:
        return None
    try:
        raw = await redis.get(key)
        if raw is None:
            return None
        return json.loads(raw)
    except Exception as exc:
        logger.warning("redis_get_error", key=key, error=str(exc))
        return None


async def _redis_set(
    redis: Any,
    key: str,
    candles: list[OHLCVCandle],
    ttl: int,
) -> None:
    """
    Write a candles list to Redis as JSON.  Errors are logged and swallowed
    so that a Redis write failure never blocks the HTTP response.
    """
    if redis is None:
        return
    try:
        payload = json.dumps([c.model_dump() for c in candles])
        await redis.set(key, payload, ex=ttl)
    except Exception as exc:
        logger.warning("redis_set_error", key=key, error=str(exc))


# ---------------------------------------------------------------------------
# Disk cache helpers (daily Bhavcopy)
# ---------------------------------------------------------------------------


def _daily_disk_cache_path(
    exchange: str,
    symbol: str,
    from_date: date,
) -> str:
    """
    Return the canonical disk-cache path for a daily Bhavcopy file.

    One compressed CSV per (exchange, symbol, date) triple is written by the
    fetch implementation in Task 4.2.
    """
    return os.path.join(
        settings.data_dir,
        "bhavcopy",
        exchange,
        symbol,
        f"{from_date.isoformat()}.csv.gz",
    )


def _disk_cache_is_fresh(path: str) -> bool:
    """Return True when *path* exists and its mtime is less than 24 h ago."""
    try:
        mtime = os.path.getmtime(path)
        age_seconds = time.time() - mtime
        return age_seconds < _DISK_CACHE_MAX_AGE
    except OSError:
        return False


def _read_disk_cache(path: str) -> list[dict] | None:
    """
    Read a gzip-compressed JSON array from disk.

    Returns the parsed list on success, or ``None`` on any read/parse error.
    The Task 4.2 fetch implementation writes this format; here we only read it.
    """
    try:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        logger.warning("disk_cache_read_error", path=path, error=str(exc))
        return None


# ---------------------------------------------------------------------------
# Response builder
# ---------------------------------------------------------------------------


def _build_response(
    symbol: str,
    exchange: str,
    interval: str,
    candles: list[OHLCVCandle] | list[dict],
    source: str,
) -> dict[str, Any]:
    """
    Construct the canonical ``GET /scraping/historical`` response body.

    Accepts either ``OHLCVCandle`` model instances or plain dicts (from cache).
    Candles are sorted ascending by ``time`` before the response is built.
    """
    if candles and isinstance(candles[0], OHLCVCandle):
        candle_dicts: list[dict] = [c.model_dump() for c in candles]  # type: ignore[union-attr]
    else:
        candle_dicts = list(candles)  # type: ignore[arg-type]

    # Sort ascending by time (required by Requirement 2.1 / Property 2)
    candle_dicts.sort(key=lambda c: c["time"])

    return {
        "symbol": symbol,
        "exchange": exchange,
        "interval": interval,
        "count": len(candle_dicts),
        "source": source,
        "candles": candle_dicts,
    }


# ---------------------------------------------------------------------------
# BSE scrip code lookup
# ---------------------------------------------------------------------------


async def _resolve_bse_scrip_code(symbol: str) -> str | None:
    """Attempt to look up a BSE numeric scrip code from the instrument master.

    Returns the numeric token string (e.g. ``"500325"``) or ``None`` when the
    symbol is not found in the cached instrument master.  The caller should
    surface a clear error rather than silently passing the trading symbol as
    the scrip code.
    """
    try:
        from src.scrapers.instrument_master import _load_instruments  # noqa: PLC0415
        instruments, _ = await _load_instruments("BSE")
        sym_upper = symbol.upper()
        for inst in instruments:
            if inst.tradingSymbol.upper() == sym_upper and inst.exchange in {"BSE", "BFO"}:
                return inst.token
    except Exception as exc:
        logger.warning("bse_scrip_code_lookup_failed", symbol=symbol, error=str(exc))
    return None


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

historical_router = APIRouter()


@historical_router.get("/scraping/historical")
async def get_historical_candles(
    symbol: str | None = Query(default=None),
    exchange: str | None = Query(default=None),
    interval: str | None = Query(default=None),
    # 'from' is a Python keyword — the query param is aliased via Query(alias=...)
    from_date_str: str | None = Query(default=None, alias="from"),
    to_date_str: str | None = Query(default=None, alias="to"),
) -> JSONResponse:
    """
    Return historical OHLCV candles for a given symbol.

    **Query parameters**

    | Param      | Description                                          |
    |------------|------------------------------------------------------|
    | ``symbol`` | NSE/BSE ticker (e.g. ``RELIANCE``, ``NIFTY``)        |
    | ``exchange`` | ``NSE`` or ``BSE``                                 |
    | ``interval`` | ``1d``, ``5m``, ``15m``, ``30m``, or ``1h``        |
    | ``from``   | Start date, ISO 8601 (``YYYY-MM-DD``)                |
    | ``to``     | End date, ISO 8601 (``YYYY-MM-DD``)                  |

    **Caching**

    * **Daily (1d)**: served from disk at
      ``{data_dir}/bhavcopy/{exchange}/{symbol}/{from}.csv.gz``
      when its mtime is < 24 h.
    * **Intraday**: Redis key
      ``scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}``
      with TTL 3600 s.

    **Response shape**

    ```json
    {
      "symbol": "RELIANCE",
      "exchange": "NSE",
      "interval": "1d",
      "count": 252,
      "source": "bhavcopy" | "cache" | "redis",
      "candles": [{"time": 1609459200, "open": 1950.0, ...}, ...]
    }
    ```

    **Error responses**

    * HTTP 400 — validation failure (missing/invalid param, date range exceeded)
    * HTTP 503 — upstream timeout or upstream error
    """
    # ------------------------------------------------------------------
    # 1. Validate all input parameters
    # ------------------------------------------------------------------
    validation_result = _validate_params(
        symbol=symbol,
        exchange=exchange,
        interval=interval,
        from_str=from_date_str,
        to_str=to_date_str,
    )

    if isinstance(validation_result, JSONResponse):
        return validation_result

    from_date, to_date = validation_result

    # At this point all strings are guaranteed non-None by _validate_params
    assert symbol is not None
    assert exchange is not None
    assert interval is not None

    log = logger.bind(
        symbol=symbol,
        exchange=exchange,
        interval=interval,
        from_date=from_date.isoformat(),
        to_date=to_date.isoformat(),
    )

    # ------------------------------------------------------------------
    # 2. Retrieve Redis client from the server module (set during lifespan)
    # ------------------------------------------------------------------
    try:
        from src.server import _redis_client as redis  # noqa: PLC0415
    except ImportError:
        redis = None

    # ------------------------------------------------------------------
    # 3a. Intraday — check Redis cache first
    # ------------------------------------------------------------------
    if interval in _INTRADAY_INTERVALS:
        redis_key = _intraday_redis_key(exchange, symbol, interval, from_date, to_date)
        cached = await _redis_get(redis, redis_key)
        if cached is not None:
            log.debug("intraday_cache_hit", key=redis_key)
            return JSONResponse(
                content=_build_response(symbol, exchange, interval, cached, source="redis"),
                status_code=200,
            )

    # ------------------------------------------------------------------
    # 3b. Daily — check disk cache
    # ------------------------------------------------------------------
    if interval == "1d":
        cache_path = _daily_disk_cache_path(exchange, symbol, from_date)
        if _disk_cache_is_fresh(cache_path):
            disk_data = _read_disk_cache(cache_path)
            if disk_data is not None:
                log.debug("daily_disk_cache_hit", path=cache_path)
                return JSONResponse(
                    content=_build_response(symbol, exchange, interval, disk_data, source="cache"),
                    status_code=200,
                )

    # ------------------------------------------------------------------
    # 4. Fetch from upstream
    # ------------------------------------------------------------------
    try:
        candles: list[OHLCVCandle] = []

        if interval == "1d":
            if exchange == "NSE":
                candles = await _fetch_nse_daily(symbol, from_date, to_date)
            else:
                candles = await _fetch_bse_daily(symbol, from_date, to_date)
        elif exchange == "NSE":
            candles = await _fetch_nse_intraday(symbol, interval, from_date, to_date)
        else:
            # BSE intraday requires a numeric scrip code.
            # Attempt to look it up from the instrument master; if not found,
            # return an empty result with a warning rather than silently
            # passing the symbol string (which would return no data from BSE).
            bse_code = await _resolve_bse_scrip_code(symbol)
            if bse_code is None:
                logger.warning(
                    "bse_intraday_no_scrip_code",
                    symbol=symbol,
                    note=(
                        "BSE intraday requires a numeric scrip code. "
                        "Populate the instrument master or provide a scrip code directly."
                    ),
                )
                return JSONResponse(
                    status_code=503,
                    content={
                        "available": False,
                        "reason": (
                            f"BSE intraday for '{symbol}' requires a numeric scrip code. "
                            "Refresh the instrument master via POST /scraping/instruments/refresh."
                        ),
                        "provider": "scrapling",
                    },
                )
            candles = await _fetch_bse_intraday(symbol, bse_code, interval, from_date, to_date)

    except Exception as exc:
        log.error("fetch_error", error=str(exc))
        return JSONResponse(
            status_code=503,
            content={
                "available": False,
                "reason": f"Upstream fetch failed: {exc}",
                "provider": "scrapling",
            },
        )

    # ------------------------------------------------------------------
    # 5. Write to cache (fire-and-forget; errors already swallowed inside helpers)
    # ------------------------------------------------------------------
    if interval in _INTRADAY_INTERVALS and candles:
        redis_key = _intraday_redis_key(exchange, symbol, interval, from_date, to_date)
        await _redis_set(redis, redis_key, candles, ttl=_INTRADAY_REDIS_TTL)

    # Daily disk-cache writes are handled inside _fetch_nse_daily /
    # _fetch_bse_daily in Task 4.2 (they own the disk path).

    # ------------------------------------------------------------------
    # 6. Return
    # ------------------------------------------------------------------
    log.info(
        "historical_response",
        count=len(candles),
        source="bhavcopy",
    )
    return JSONResponse(
        content=_build_response(symbol, exchange, interval, candles, source="bhavcopy"),
        status_code=200,
    )
