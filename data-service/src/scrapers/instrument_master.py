"""
InstrumentMaster scraper — routing, disk caching, and REST endpoints.

Endpoints:
    GET  /scraping/instruments         — list instruments (optional ?type=FO, ?exchange=NSE|BSE)
    GET  /scraping/instruments/{symbol} — single instrument lookup by tradingSymbol
    POST /scraping/instruments/refresh  — force re-download, bypass disk cache

Fetch implementations:
  - _fetch_nse_instruments: downloads fo_mktlots.csv from NSE Archives (CloudFront CDN).
  - _fetch_bse_instruments: downloads daily BSE equity scrip master ZIP.

Disk cache:
    /app/data/instruments/{exchange}.json   (mtime < 24 h → serve from cache)
"""

from __future__ import annotations

import csv
import io
import json
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from src.config import settings
from src.schemas import Instrument

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Disk cache TTL — 24 hours in seconds.
_CACHE_TTL_SECONDS: int = 24 * 60 * 60

# F&O instrument types.
_FO_TYPES: frozenset[str] = frozenset({"FUT", "CE", "PE"})

# Exchanges that belong to each logical exchange group.
_NSE_EXCHANGES: frozenset[str] = frozenset({"NSE", "NFO"})
_BSE_EXCHANGES: frozenset[str] = frozenset({"BSE", "BFO"})

# Hardcoded fallback lot sizes (requirement 8.5).
NSE_LOT_SIZES: dict[str, int] = {
    "NIFTY": 50,
    "BANKNIFTY": 15,
    "FINNIFTY": 40,
    "MIDCPNIFTY": 75,
    "SENSEX": 10,
    "BANKEX": 15,
}

# ---------------------------------------------------------------------------
# Fetch implementations
# ---------------------------------------------------------------------------


_NSE_LOT_CSV_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv"
_BSE_EQUITY_ZIP_URL = "https://www.bseindia.com/download/BseIndiaAPI/Equity/EQUITY_{ddmmyyyy}.zip"


def _make_nse_fallback_instruments() -> list[Instrument]:
    """Build Instrument objects from the hardcoded NSE_LOT_SIZES dict."""
    return [
        Instrument(
            token=symbol,
            tradingSymbol=symbol,
            name=symbol,
            exchange="NFO",
            lotSize=lot_size,
            instrumentType="FUT",
            expiry="",
            strike=0.0,
            optionType="",
        )
        for symbol, lot_size in NSE_LOT_SIZES.items()
    ]


async def _fetch_nse_instruments() -> list[Instrument]:
    """Download and parse the NSE F&O lot size CSV from NSE Archives (CloudFront CDN).

    The CSV is served without anti-bot protection, so a plain ``httpx`` client
    is used instead of Scrapling.

    CSV format (flexible — header rows are skipped):
    - Column 0: symbol name
    - Column 1 or 2: current lot size (tries column 1 first, then column 2)

    Falls back to :data:`NSE_LOT_SIZES` when the download or parse fails.
    """
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(_NSE_LOT_CSV_URL)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning(
            "nse_lot_csv_download_failed",
            url=_NSE_LOT_CSV_URL,
            error=str(exc),
        )
        logger.info("nse_lot_csv_using_fallback")
        return _make_nse_fallback_instruments()

    instruments: list[Instrument] = []

    try:
        # The CSV may use various encodings; try UTF-8 first, then latin-1.
        try:
            text = response.content.decode("utf-8")
        except UnicodeDecodeError:
            text = response.content.decode("latin-1")

        reader = csv.reader(io.StringIO(text))
        for row in reader:
            if not row:
                continue
            first_col = row[0].strip()
            # Skip header rows and empty first-column rows.
            if not first_col or first_col.upper() in {"SYMBOL", "SYMBOL NAME", ""}:
                continue
            # Skip rows that look like section headers (all non-numeric first col
            # that don't resemble a trading symbol — e.g. "DERIVATIVES", "NOTES:").
            # Trading symbols are alphanumeric (letters + digits + hyphens).
            if not any(c.isalpha() for c in first_col):
                continue

            symbol = first_col.upper()

            # Lot size may be in column 1 or column 2 depending on CSV version.
            lot_size: int | None = None
            for col_idx in (1, 2):
                if len(row) > col_idx:
                    raw_lot = row[col_idx].strip().replace(",", "")
                    if raw_lot.isdigit():
                        lot_size = int(raw_lot)
                        break

            if lot_size is None:
                # Row has no parseable lot size — skip it.
                logger.debug("nse_lot_csv_skip_row_no_lot", symbol=symbol, row=row)
                continue

            instruments.append(
                Instrument(
                    token=symbol,
                    tradingSymbol=symbol,
                    name=symbol,
                    exchange="NFO",
                    lotSize=lot_size,
                    instrumentType="FUT",
                    expiry="",
                    strike=0.0,
                    optionType="",
                )
            )

    except Exception as exc:
        logger.warning(
            "nse_lot_csv_parse_failed",
            error=str(exc),
        )
        logger.info("nse_lot_csv_using_fallback")
        return _make_nse_fallback_instruments()

    if not instruments:
        logger.warning("nse_lot_csv_empty_result", url=_NSE_LOT_CSV_URL)
        logger.info("nse_lot_csv_using_fallback")
        return _make_nse_fallback_instruments()

    logger.info("nse_lot_csv_parsed", count=len(instruments))
    return instruments


async def _fetch_bse_instruments() -> list[Instrument]:
    """Download and parse the BSE equity scrip master ZIP for today's date.

    URL pattern: ``EQUITY_{DDMMYYYY}.zip``

    The ZIP contains a CSV named ``Equity*.csv`` or ``EQUITY*.csv``.  The
    expected columns are (positions may vary):
    - ``Security Code`` — BSE scrip code (token)
    - ``Security Name`` / ``Issuer Name`` — instrument name
    - ``Series`` — trading series (e.g. ``EQ``, ``BE``, …)
    - ``ISIN No.`` — optional ISIN

    Raises:
        RuntimeError: On non-200 HTTP status, corrupt ZIP, or CSV parse failure.
            The caller (``_load_instruments``) converts this to HTTP 503.
    """
    today = datetime.now(tz=timezone.utc)
    ddmmyyyy = today.strftime("%d%m%Y")
    url = _BSE_EQUITY_ZIP_URL.format(ddmmyyyy=ddmmyyyy)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        raise RuntimeError(
            f"BSE scrip master download failed: {exc}"
        ) from exc

    if response.status_code != 200:
        raise RuntimeError(
            f"BSE scrip master unavailable: HTTP {response.status_code} from {url}"
        )

    # Parse the ZIP archive.
    try:
        zf = zipfile.ZipFile(io.BytesIO(response.content))
    except zipfile.BadZipFile as exc:
        raise RuntimeError(
            f"BSE scrip master ZIP is corrupt: {exc}"
        ) from exc

    # Find the CSV file inside the ZIP.
    csv_name: str | None = None
    for name in zf.namelist():
        upper = name.upper()
        if upper.startswith("EQUITY") and upper.endswith(".CSV"):
            csv_name = name
            break
        if upper.endswith(".CSV"):
            # Fallback: take any CSV file.
            csv_name = name

    if csv_name is None:
        raise RuntimeError(
            f"BSE scrip master ZIP contains no CSV file. Files: {zf.namelist()}"
        )

    try:
        raw_bytes = zf.read(csv_name)
    except Exception as exc:
        raise RuntimeError(
            f"Failed to read '{csv_name}' from BSE scrip master ZIP: {exc}"
        ) from exc

    try:
        try:
            csv_text = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            csv_text = raw_bytes.decode("latin-1")
    except Exception as exc:
        raise RuntimeError(
            f"Failed to decode BSE scrip master CSV: {exc}"
        ) from exc

    instruments: list[Instrument] = []

    try:
        reader = csv.DictReader(io.StringIO(csv_text))
        if reader.fieldnames is None:
            raise RuntimeError("BSE scrip master CSV has no header row")

        # Normalise header names to uppercase for flexible column matching.
        field_map: dict[str, str] = {
            (f.strip().upper() if f else ""): (f or "")
            for f in reader.fieldnames
        }

        def _col(*candidates: str) -> str | None:
            """Return the first matching original column name (case-insensitive)."""
            for c in candidates:
                if c.upper() in field_map:
                    return field_map[c.upper()]
            return None

        code_col = _col("Security Code", "SECURITY CODE", "CODE", "ScripCode", "SCRIPCODE")
        name_col = _col("Security Name", "SECURITY NAME", "Issuer Name", "ISSUER NAME", "NAME", "SCRIPNAME")
        isin_col = _col("ISIN No.", "ISIN NO.", "ISIN", "ISIN NUMBER")

        if code_col is None:
            raise RuntimeError(
                f"BSE scrip master CSV missing 'Security Code' column. "
                f"Available columns: {list(reader.fieldnames)}"
            )
        if name_col is None:
            raise RuntimeError(
                f"BSE scrip master CSV missing 'Security Name' column. "
                f"Available columns: {list(reader.fieldnames)}"
            )

        for row in reader:
            token = row.get(code_col, "").strip()
            raw_name = row.get(name_col, "").strip()
            isin = row.get(isin_col, "").strip() if isin_col else None

            if not token or not raw_name:
                continue

            trading_symbol = raw_name[:50]
            full_name = raw_name[:100]

            instruments.append(
                Instrument(
                    token=token,
                    tradingSymbol=trading_symbol,
                    name=full_name,
                    exchange="BSE",
                    lotSize=1,
                    instrumentType="EQ",
                    expiry="",
                    strike=0.0,
                    optionType="",
                    isin=isin if isin else None,
                )
            )

    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(
            f"Failed to parse BSE scrip master CSV '{csv_name}': {exc}"
        ) from exc

    logger.info("bse_scrip_master_parsed", count=len(instruments), date=ddmmyyyy)
    return instruments


# ---------------------------------------------------------------------------
# Disk cache helpers
# ---------------------------------------------------------------------------


def _cache_path(exchange_group: str) -> Path:
    """Resolve the on-disk cache path for an exchange group.

    Args:
        exchange_group: One of ``"NSE"`` or ``"BSE"`` (logical group label).

    Returns:
        An absolute ``Path`` to the JSON cache file.
    """
    data_dir = Path(settings.data_dir) / "instruments"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / f"{exchange_group}.json"


def _is_cache_fresh(path: Path) -> bool:
    """Return ``True`` when the file exists and its mtime is < 24 hours ago."""
    try:
        mtime = path.stat().st_mtime
        return (time.time() - mtime) < _CACHE_TTL_SECONDS
    except FileNotFoundError:
        return False


def _read_cache(path: Path) -> list[dict] | None:
    """Read JSON from disk cache.  Returns ``None`` when the file is absent or corrupt."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        logger.warning("cache_read_error", path=str(path), error=str(exc))
        return None


def _write_cache(path: Path, instruments: list[Instrument]) -> None:
    """Serialise *instruments* to disk at *path* (atomic write via temp file)."""
    data_dir = path.parent
    data_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    try:
        tmp_path.write_text(
            json.dumps([inst.model_dump() for inst in instruments], ensure_ascii=False),
            encoding="utf-8",
        )
        tmp_path.replace(path)
        logger.info("cache_written", path=str(path), count=len(instruments))
    except Exception as exc:
        logger.error("cache_write_error", path=str(path), error=str(exc))
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def _invalidate_cache(path: Path) -> None:
    """Delete the cache file so the next request triggers a fresh fetch."""
    try:
        path.unlink(missing_ok=True)
        logger.info("cache_invalidated", path=str(path))
    except Exception as exc:
        logger.warning("cache_invalidate_error", path=str(path), error=str(exc))


# ---------------------------------------------------------------------------
# Core fetch-or-cache logic
# ---------------------------------------------------------------------------


async def _load_instruments(
    exchange_group: str,
    *,
    force_refresh: bool = False,
) -> tuple[list[Instrument], bool]:
    """Return instruments for *exchange_group*, using disk cache when fresh.

    Args:
        exchange_group: ``"NSE"`` or ``"BSE"``.
        force_refresh: When ``True``, bypass and overwrite the disk cache.

    Returns:
        A ``(instruments, from_cache)`` tuple.  ``from_cache`` is ``True``
        when the data came from disk without an upstream fetch.

    Raises:
        RuntimeError: When no cache is available and the upstream fetch fails
            (caller converts this to HTTP 503).
    """
    path = _cache_path(exchange_group)

    if not force_refresh and _is_cache_fresh(path):
        cached = _read_cache(path)
        if cached is not None:
            instruments = [Instrument(**item) for item in cached]
            logger.info(
                "instrument_master_cache_hit",
                exchange=exchange_group,
                count=len(instruments),
            )
            return instruments, True

    # Fetch from upstream.
    try:
        if exchange_group == "NSE":
            instruments = await _fetch_nse_instruments()
        else:
            instruments = await _fetch_bse_instruments()
    except Exception as exc:
        logger.error(
            "instrument_master_fetch_failed",
            exchange=exchange_group,
            error=str(exc),
        )
        # Fall back to stale cache if available.
        if path.exists():
            stale = _read_cache(path)
            if stale is not None:
                logger.warning(
                    "instrument_master_serving_stale_cache",
                    exchange=exchange_group,
                )
                return [Instrument(**item) for item in stale], True
        raise RuntimeError(str(exc)) from exc

    if instruments:
        _write_cache(path, instruments)
    else:
        # Empty result from upstream — don't overwrite a valid existing cache.
        logger.info(
            "instrument_master_fetch_returned_empty",
            exchange=exchange_group,
        )

    return instruments, False


# ---------------------------------------------------------------------------
# Filtering helpers
# ---------------------------------------------------------------------------


def _apply_type_filter(
    instruments: list[Instrument],
    type_filter: str | None,
) -> list[Instrument]:
    """Filter to F&O instruments when *type_filter* is ``'FO'``."""
    if type_filter is None:
        return instruments
    if type_filter.upper() == "FO":
        return [i for i in instruments if i.instrumentType in _FO_TYPES]
    # Unknown type filter — return all (callers may validate first).
    return instruments


def _apply_exchange_filter(
    instruments: list[Instrument],
    exchange: str | None,
) -> list[Instrument]:
    """Filter instruments to a logical exchange group (NSE|BSE)."""
    if exchange is None:
        return instruments
    group = exchange.upper()
    if group == "NSE":
        return [i for i in instruments if i.exchange in _NSE_EXCHANGES]
    if group == "BSE":
        return [i for i in instruments if i.exchange in _BSE_EXCHANGES]
    return instruments


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

instrument_router = APIRouter()


@instrument_router.get("/scraping/instruments")
async def get_instruments(
    exchange: Optional[str] = Query(
        default=None,
        description="Logical exchange group: NSE or BSE. Returns both when omitted.",
    ),
    type: Optional[str] = Query(  # noqa: A002
        default=None,
        description="Instrument type filter. Use 'FO' to return only FUT/CE/PE.",
    ),
) -> JSONResponse:
    """Return a list of tradeable instruments, optionally filtered by exchange and type.

    **Query params:**

    - ``exchange`` — ``NSE`` or ``BSE``; both groups are returned when omitted.
    - ``type``     — ``FO`` returns only F&O instruments (``FUT``, ``CE``, ``PE``).

    **Response shape:**

    .. code-block:: json

        {
            "instruments": [...],
            "count": N,
            "cached": true,
            "exchange": "NSE"
        }
    """
    # Validate optional exchange param.
    if exchange is not None and exchange.upper() not in {"NSE", "BSE"}:
        return JSONResponse(
            content={"error": f"exchange must be 'NSE' or 'BSE', got '{exchange}'"},
            status_code=400,
        )

    # Determine which exchange group(s) to load.
    groups_to_load: list[str] = (
        [exchange.upper()] if exchange else ["NSE", "BSE"]
    )

    all_instruments: list[Instrument] = []
    any_cached = False
    any_fetched = False

    for group in groups_to_load:
        try:
            instruments, from_cache = await _load_instruments(group)
        except RuntimeError as exc:
            return JSONResponse(
                content={
                    "available": False,
                    "reason": str(exc),
                    "provider": "scrapling",
                },
                status_code=503,
            )
        all_instruments.extend(instruments)
        if from_cache:
            any_cached = True
        else:
            any_fetched = True

    # Determine the "cached" flag for the response.
    # When loading both groups: "cached" is True only if both were cached.
    cached_flag = any_cached and not any_fetched

    # Apply filters.
    filtered = _apply_type_filter(all_instruments, type)
    # Exchange filter is redundant when only one group was loaded, but
    # applied consistently for the case where both groups are loaded and
    # the caller wants a stricter per-exchange view (e.g. exclude NFO).
    filtered = _apply_exchange_filter(filtered, exchange)

    return JSONResponse(
        content={
            "instruments": [inst.model_dump() for inst in filtered],
            "count": len(filtered),
            "cached": cached_flag,
            "exchange": exchange.upper() if exchange else "ALL",
        },
        status_code=200,
    )


@instrument_router.get("/scraping/instruments/{symbol}")
async def get_instrument_by_symbol(symbol: str) -> JSONResponse:
    """Look up a single instrument by its ``tradingSymbol``.

    The lookup is case-insensitive.

    Returns HTTP 404 when no instrument matches the symbol.
    """
    symbol_upper = symbol.upper()

    # Search both groups; return the first match.
    for group in ["NSE", "BSE"]:
        try:
            instruments, _ = await _load_instruments(group)
        except RuntimeError as exc:
            return JSONResponse(
                content={
                    "available": False,
                    "reason": str(exc),
                    "provider": "scrapling",
                },
                status_code=503,
            )
        for inst in instruments:
            if inst.tradingSymbol.upper() == symbol_upper:
                return JSONResponse(
                    content={"instrument": inst.model_dump()},
                    status_code=200,
                )

    return JSONResponse(
        content={"error": f"Instrument not found: '{symbol}'"},
        status_code=404,
    )


@instrument_router.post("/scraping/instruments/refresh")
async def refresh_instruments(
    exchange: Optional[str] = Query(
        default=None,
        description="Refresh only NSE or BSE; refreshes both when omitted.",
    ),
) -> JSONResponse:
    """Force a re-download of instrument master data, bypassing the disk cache.

    Deletes existing cache files, re-fetches from NSE/BSE, and writes a new
    cache before returning the updated instrument list.
    """
    if exchange is not None and exchange.upper() not in {"NSE", "BSE"}:
        return JSONResponse(
            content={"error": f"exchange must be 'NSE' or 'BSE', got '{exchange}'"},
            status_code=400,
        )

    groups_to_refresh: list[str] = (
        [exchange.upper()] if exchange else ["NSE", "BSE"]
    )

    all_instruments: list[Instrument] = []

    for group in groups_to_refresh:
        # Invalidate existing cache first so _load_instruments always fetches.
        _invalidate_cache(_cache_path(group))
        try:
            instruments, _ = await _load_instruments(group, force_refresh=True)
        except RuntimeError as exc:
            return JSONResponse(
                content={
                    "available": False,
                    "reason": str(exc),
                    "provider": "scrapling",
                },
                status_code=503,
            )
        all_instruments.extend(instruments)

    return JSONResponse(
        content={
            "instruments": [inst.model_dump() for inst in all_instruments],
            "count": len(all_instruments),
            "cached": False,
            "exchange": exchange.upper() if exchange else "ALL",
            "refreshed": True,
        },
        status_code=200,
    )
