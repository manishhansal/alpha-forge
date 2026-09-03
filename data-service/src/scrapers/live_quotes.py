"""
LiveQuoteScraper — ``GET /scraping/quotes`` routing, caching, and session management.

This module owns the singleton ``AsyncDynamicSession`` used for live NSE quote
scraping via ``capture_xhr``.

Session strategy
----------------
A single ``AsyncDynamicSession`` instance (``_quote_session``) is shared across
all requests.  It is lazily created on the first call to ``get_quote_session()``.
An asyncio lock prevents duplicate creation under concurrent startup.

Cache architecture
------------------
Redis key : ``scraping:quote:{exchange}:{symbol}``
TTL       : 5 seconds

Cache writes are **fire-and-forget** (errors are logged but do not affect the
response).  Cache reads are synchronous within the request; if the cached entry
is younger than the TTL, the value is returned directly without hitting the
scraper.

Fetch routing
-------------
The NIFTY 200 batch path intercepts a single XHR response that contains all 200
constituents, which is far more efficient than 200 individual XHR calls.  For
symbols not in NIFTY 200, a per-symbol XHR intercept is used.  Mixed requests
combine both strategies and merge results in the original input order.

Requirements: 3.1, 3.5, 3.7, 3.8, 3.9
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from src.config import settings
from src.schemas import MDQuote

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

quotes_router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_QUOTE_CACHE_TTL: int = 5  # seconds

# ---------------------------------------------------------------------------
# NSE NextApi base URLs (post-2026 redesign)
# NSE migrated from the old equity-stockIndices / api/quote/equity XHR paths
# to a Next.js-powered API.  These endpoints return JSON without requiring
# a browser session — standard httpx requests with a Referer header suffice.
# ---------------------------------------------------------------------------

_NSE_NEXTAPI_BASE = "https://www.nseindia.com/api/NextApi"

# Constituent-level data for a named index (e.g. NIFTY 200).
# Returns {data: {data: [{symbol, lastPrice, change, pChange, open, dayHigh,
#          dayLow, previousClose, totalTradedVolume, totalTradedValue, ...}]}}
_NSE_INDICES_DATA_URL = (
    f"{_NSE_NEXTAPI_BASE}/apiClient/marketWatchApi"
    "?functionName=getIndicesData&symbol={{index}}"
)

# All-indices summary (used for index-symbol quotes like NIFTY / BANKNIFTY).
# Returns {data: [{indexName, last, open, high, low, previousClose, percChange}]}
_NSE_INDEX_LIST_URL = f"{_NSE_NEXTAPI_BASE}/apiClient?functionName=getIndexData&&type=All"

# Common headers that NSE's CDN requires to return JSON instead of an error page.
_NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"
    ),
    "Referer": "https://www.nseindia.com/",
    "Accept": "application/json, text/plain, */*",
}

# Index symbols that are served by the all-indices endpoint rather than
# the NIFTY 200 constituent endpoint.
_NSE_INDEX_SYMBOLS: frozenset[str] = frozenset({
    "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
    "NIFTY50", "NIFTYBANK", "NIFTYFIN", "NIFTYMIDCP",
})

# ---------------------------------------------------------------------------
# NIFTY 200 constituent set
# ---------------------------------------------------------------------------
# Complete list of NIFTY 200 index constituents as of September 2025.
# Symbols not in this set use the slower per-symbol XHR path; symbols in
# this set are fetched efficiently via the single equity-stockIndices XHR
# that returns all 200 constituents in one payload.
# Source: NSE India NIFTY 200 index methodology document.

NIFTY_200_SYMBOLS: frozenset[str] = frozenset(
    {
        # ── Large-cap (NIFTY 50) ────────────────────────────────────────────
        "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS",
        "HINDUNILVR", "ITC", "SBIN", "BAJFINANCE", "WIPRO",
        "AXISBANK", "MARUTI", "ASIANPAINT", "NTPC", "POWERGRID",
        "ULTRACEMCO", "ONGC", "KOTAKBANK", "LT", "HCLTECH",
        "TITAN", "SUNPHARMA", "BAJAJFINSV", "M&M", "ADANIENT",
        "ADANIPORTS", "COALINDIA", "TATAMOTORS", "JSWSTEEL", "TATASTEEL",
        "TECHM", "NESTLEIND", "BRITANNIA", "DIVISLAB", "HEROMOTOCO",
        "CIPLA", "GRASIM", "APOLLOHOSP", "INDUSINDBK", "DRREDDY",
        "SBILIFE", "HDFCLIFE", "BAJAJ-AUTO", "HINDALCO", "TATACONSUM",
        "BPCL", "LTIM", "EICHERMOT", "SHRIRAMFIN", "VEDL",
        # ── Mid-cap (NIFTY MIDCAP 150) ──────────────────────────────────────
        "PIDILITIND", "SIEMENS", "HAVELLS", "MUTHOOTFIN", "GODREJCP",
        "MARICO", "BERGEPAINT", "COLPAL", "LUPIN", "BIOCON",
        "TORNTPHARM", "AMBUJACEM", "ACC", "DABUR", "VOLTAS",
        "POLYCAB", "PAGEIND", "GLAXO", "PFIZER", "ABCAPITAL",
        "ALKEM", "AUROPHARMA", "BALKRISIND", "BANDHANBNK", "BANKINDIA",
        "BATAINDIA", "BHEL", "BOSCHLTD", "CANBK", "CHOLAFIN",
        "CUMMINSIND", "DEEPAKNTR", "DIXON", "ESCORTS", "EXIDEIND",
        "FEDERALBNK", "GLENMARK", "GMRAIRPORT", "GODREJPROP", "GRANULES",
        "HAL", "HINDPETRO", "IDFCFIRSTB", "INDUSTOWER", "IRCTC",
        "JINDALSTEL", "JUBLFOOD", "KALYANKJIL", "KANSAINER", "KPITTECH",
        "LICHSGFIN", "LICI", "LTTS", "MCDOWELL-N", "METROPOLIS",
        "MFSL", "MPHASIS", "MRPL", "MRF", "NATIONALUM",
        "NAUKRI", "NBCC", "NHPC", "NLC", "NMDC",
        "OBEROIRLTY", "OFSS", "OIL", "PATANJALI", "PERSISTENT",
        "PETRONET", "PIIND", "PNB", "POONAWALLA", "PRESTIGE",
        "PVR", "RAJESHEXPO", "RAMCOCEM", "RECLTD", "SAIL",
        "SANOFI", "SCI", "SHYAMMETL", "SJVN", "SKFINDIA",
        "SONACOMS", "SRTRANSFIN", "STARHEALTH", "SUNDARMFIN", "SUNDRMFAST",
        "SUNTV", "SUPREMEIND", "SUZLON", "THERMAX", "TRENT",
        "TTKPRESTIG", "TVSHLTD", "UBL", "UNIONBANK", "UNIPARTS",
        "UNITDSPR", "UTIAMC", "VBL", "VINATIORGA", "WHIRLPOOL",
        "WINTERGREEN", "ZOMATO", "ZYDUSLIFE", "AAVAS", "ABB",
        "ABFRL", "AEGISLOG", "AFFLE", "ANGELONE", "ANURAS",
        "APOLLOTYRE", "ATUL", "AWHCL", "BAJAJELEC", "BAYERCROP",
        "BLUESTAR", "BSOFT", "CAMPUS", "CANFINHOME", "CARERATING",
        "CASTROLIND", "CDSL", "CESC", "CGPOWER", "CLEAN",
        "COFORGE", "CONCOR", "COROMANDEL", "CREDITACC", "CYIENT",
        "DATAPATTNS", "DCMSHRIRAM", "DELTACORP", "DMART", "DRHorn",
        "ELGIEQUIP", "EMCURE", "EQUITASBNK", "FINEORG", "FINPIPE",
        "GAIL", "GNFC", "GPIL", "GRINDWELL", "GSFC",
        "GUJGASLTD", "HAPPSTMNDS", "HATSUN", "HOMEFIRST", "HUL",
        "IBREALEST", "IDBI", "IDFC", "IFBIND", "IGPL",
        "INDHOTEL", "INDIAMART", "IOB", "IOC", "IPCALAB",
        "JBCHEPHARM", "JKLAKSHMI", "JKPAPER", "JMFINANCIL", "JSWENERGY",
        "JTEKTINDIA", "KAJARIACER", "KALPATPOWR", "KIRLOSENG", "KNRCON",
        "KSCL", "LAURUSLABS", "LEMONTREE", "LUXIND", "MANAPPURAM",
        "MASFIN", "MAXHEALTH", "MCX", "MEDANTA", "MINDAIND",
    }
)

# ---------------------------------------------------------------------------
# Singleton session management
# ---------------------------------------------------------------------------

_quote_session: Any = None
# Raw (un-entered) instance kept so __aexit__ can be called on the exact
# object that was entered.  _quote_session holds the *entered* session
# (i.e. the return value of __aenter__), which is what fetch() is called on.
_quote_session_raw: Any = None
_quote_session_lock: asyncio.Lock = asyncio.Lock()
# Semaphore: only one fetch() is allowed at a time on the shared session.
# Playwright's AsyncDynamicSession navigates a single browser page; concurrent
# fetch() calls would mix XHR captures and corrupt results.
_quote_session_sem: asyncio.Semaphore = asyncio.Semaphore(1)

# Injected by server.py lifespan — used to pick up the current proxy when
# creating or resetting the session after a ban/proxy-rotation event.
_proxy_manager: Any = None  # type: ignore[type-arg]


def set_quote_proxy_manager(pm: Any) -> None:
    """Inject the live ProxyManager so session resets use the rotated proxy."""
    global _proxy_manager
    _proxy_manager = pm


def _current_proxy() -> str | None:
    """Return the active proxy URL from the proxy manager, or the settings default."""
    if _proxy_manager is not None:
        return _proxy_manager.get_proxy()
    return settings.scrapling_proxy_url or None


async def get_quote_session() -> Any:
    """Return the shared ``AsyncDynamicSession``, creating it lazily on first call.

    ``AsyncDynamicSession`` must be used as an async context manager to
    initialise the underlying Playwright browser.  This function calls
    ``__aenter__`` once and stores both the raw instance (for ``__aexit__``
    during reset) and the entered session (for ``fetch()`` calls).

    Uses an asyncio lock so concurrent coroutines don't race to create multiple
    Chromium instances.

    Raises
    ------
    RuntimeError
        When the ``scrapling`` package is not installed.
    """
    global _quote_session, _quote_session_raw

    if _quote_session is not None:
        return _quote_session

    async with _quote_session_lock:
        # Double-checked locking: another coroutine may have created it while
        # we were waiting for the lock.
        if _quote_session is not None:
            return _quote_session

        try:
            from scrapling.fetchers import AsyncDynamicSession  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError("scrapling not available") from exc

        proxy = _current_proxy()
        session_kwargs: dict[str, Any] = {
            "headless": settings.scrapling_headless,
            # Do NOT pass network_idle=True at session level — the NSE SPA
            # keeps background-polling indefinitely, so network_idle never
            # fires and every fetch() call hangs until timeout.
            # Each fetch() call controls its own wait via the wait= param.
            "network_idle": False,
            # Force Chromium to use IPv4 only.  Docker's default network
            # returns IPv6 NAT64 addresses first; Chromium fails to connect
            # through them because the container has no real IPv6 egress.
            "extra_flags": ["--disable-ipv6"],
            # capture_xhr is a session-level config (not a per-fetch param).
            # Scrapling wires a response handler at the Playwright page level
            # that matches any XHR/fetch response URL via re.search.
            # This pattern covers both fetch paths:
            #   - batch path : equity-stockIndices (NIFTY 200 endpoint)
            #   - single path: api/quote/equity    (per-symbol endpoint)
            "capture_xhr": "equity-stockIndices|api/quote/equity",
        }
        if proxy:
            session_kwargs["proxy"] = proxy

        raw = AsyncDynamicSession(**session_kwargs)
        entered = await raw.__aenter__()
        _quote_session_raw = raw

        # NSE requires the browser to have visited the homepage before any
        # data API XHRs fire.  The homepage sets session cookies (nsit /
        # nseappid) that the SPA checks before making API calls.  Without
        # this visit the page loads (HTTP 200) but captured_xhr is empty.
        try:
            await entered.fetch("https://www.nseindia.com", network_idle=False, wait=2000)
            logger.info("quote_session_homepage_warmed")
        except Exception as exc:
            # Non-fatal: log and proceed — some polls may still fail until the
            # next successful fetch establishes cookies.
            logger.warning("quote_session_homepage_warm_failed", error=str(exc))

        _quote_session = entered
        logger.info(
            "quote_session_created",
            headless=settings.scrapling_headless,
            proxy_set=bool(proxy),
        )

    return _quote_session


async def reset_quote_session() -> None:
    """Close and discard the singleton session.

    Called by the ban-response cycle.  The next call to ``get_quote_session``
    will create a fresh session using the *current* proxy from the proxy manager
    (which may have been rotated since the last ban).
    """
    global _quote_session, _quote_session_raw

    async with _quote_session_lock:
        if _quote_session_raw is not None:
            try:
                await _quote_session_raw.__aexit__(None, None, None)
            except Exception as exc:  # pragma: no cover
                logger.warning("quote_session_close_error", error=str(exc))
            _quote_session = None
            _quote_session_raw = None
            logger.info("quote_session_reset")


# ---------------------------------------------------------------------------
# Fetch implementations — NSE NextApi (httpx, no browser required)
# ---------------------------------------------------------------------------


async def _fetch_batch_quotes(session: Any, symbols: list[str]) -> dict[str, MDQuote]:
    """Fetch NIFTY 200 constituents via NSE NextApi.

    Calls ``marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20200``
    which returns live price data for all 200 constituents in one request.

    The ``session`` parameter is accepted for API compatibility but is no
    longer used — the endpoint is reachable via plain httpx without a browser.
    """
    results: dict[str, MDQuote] = {}

    def _float(val: Any) -> float | None:
        try:
            return float(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    def _int(val: Any) -> int | None:
        try:
            return int(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    url = _NSE_INDICES_DATA_URL.replace("{{index}}", "NIFTY%20200")
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url, headers=_NSE_HEADERS)
            resp.raise_for_status()
            payload = resp.json()

        items: list[dict] = payload.get("data", {}).get("data", [])
        if not items:
            logger.warning("batch_xhr_not_captured", symbols=symbols)
            return results

        requested_upper = {s.upper() for s in symbols}
        fetched_at = _utc_now_iso()

        for item in items:
            sym = str(item.get("symbol", "")).upper()
            if sym not in requested_upper:
                continue
            try:
                quote = MDQuote(
                    symbol=sym,
                    token=sym,
                    exchange="NSE",
                    ltp=_float(item.get("lastPrice")),
                    change=_float(item.get("change")),
                    changePct=_float(item.get("pChange")),
                    open=_float(item.get("open")),
                    high=_float(item.get("dayHigh")),
                    low=_float(item.get("dayLow")),
                    prevClose=_float(item.get("previousClose")),
                    volume=_int(item.get("totalTradedVolume")),
                    oi=_int(item.get("totalTradedValue")),
                    upperCircuit=None,
                    lowerCircuit=None,
                    provider="scrapling",
                    fetchedAt=fetched_at,
                )
                results[sym] = quote
            except Exception as exc:
                logger.warning("batch_quote_parse_error", symbol=sym, error=str(exc))

    except Exception as exc:
        logger.error("batch_fetch_error", symbols=symbols, error=str(exc))

    return results


async def _fetch_index_quotes(symbols: list[str]) -> dict[str, MDQuote]:
    """Fetch index-level quotes (NIFTY, BANKNIFTY, etc.) via the all-indices endpoint.

    Uses ``getIndexData&&type=All`` which returns a flat list of all tradeable
    indices with ``last``, ``open``, ``high``, ``low``, ``previousClose``,
    ``percChange``.
    """
    results: dict[str, MDQuote] = {}

    def _float(val: Any) -> float | None:
        try:
            return float(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    # NSE index names differ from symbols used in the app
    # e.g. "NIFTY" → "NIFTY 50", "BANKNIFTY" → "NIFTY BANK"
    _INDEX_NAME_MAP: dict[str, str] = {
        "NIFTY": "NIFTY 50",
        "BANKNIFTY": "NIFTY BANK",
        "FINNIFTY": "NIFTY FIN SERVICE",
        "MIDCPNIFTY": "NIFTY MID SELECT",
    }
    # Reverse map: NSE index name → app symbol
    _REVERSE_MAP = {v: k for k, v in _INDEX_NAME_MAP.items()}

    wanted_names = {_INDEX_NAME_MAP.get(s.upper(), s.upper()) for s in symbols}

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(_NSE_INDEX_LIST_URL, headers=_NSE_HEADERS)
            resp.raise_for_status()
            payload = resp.json()

        items: list[dict] = payload.get("data", [])
        fetched_at = _utc_now_iso()

        for item in items:
            name = str(item.get("indexName", ""))
            if name not in wanted_names:
                continue
            sym = _REVERSE_MAP.get(name, name.replace(" ", "").upper())
            try:
                quote = MDQuote(
                    symbol=sym,
                    token=sym,
                    exchange="NSE",
                    ltp=_float(item.get("last")),
                    change=_float(
                        (item.get("last") or 0) - (item.get("previousClose") or 0)
                    ),
                    changePct=_float(item.get("percChange")),
                    open=_float(item.get("open")),
                    high=_float(item.get("high")),
                    low=_float(item.get("low")),
                    prevClose=_float(item.get("previousClose")),
                    volume=None,
                    oi=None,
                    upperCircuit=None,
                    lowerCircuit=None,
                    provider="scrapling",
                    fetchedAt=fetched_at,
                )
                results[sym] = quote
            except Exception as exc:
                logger.warning("index_quote_parse_error", symbol=sym, error=str(exc))

    except Exception as exc:
        logger.error("index_fetch_error", symbols=symbols, error=str(exc))

    return results


async def _fetch_single_quote(session: Any, symbol: str) -> MDQuote | None:
    """Fetch a single equity symbol via NSE NextApi NIFTY 500 endpoint.

    Falls back to the NIFTY 500 constituent list which covers the vast majority
    of traded equities.  Index symbols (NIFTY, BANKNIFTY, etc.) are routed to
    ``_fetch_index_quotes`` instead.

    The ``session`` parameter is accepted for API compatibility but is not used.
    """
    # Reject symbols that are clearly not NSE tickers (Yahoo Finance format,
    # BSE '^' prefix, etc.) — log at debug level, not warning.
    if not symbol or symbol.startswith("^") or "." in symbol:
        logger.debug("single_quote_unsupported_symbol", symbol=symbol)
        return None

    # Route index symbols to the dedicated index endpoint
    if symbol.upper() in _NSE_INDEX_SYMBOLS:
        idx_results = await _fetch_index_quotes([symbol])
        return idx_results.get(symbol.upper())

    def _float(val: Any) -> float | None:
        try:
            return float(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    def _int(val: Any) -> int | None:
        try:
            return int(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    url = _NSE_INDICES_DATA_URL.replace("{{index}}", "NIFTY%20500")
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url, headers=_NSE_HEADERS)
            resp.raise_for_status()
            payload = resp.json()

        items: list[dict] = payload.get("data", {}).get("data", [])
        fetched_at = _utc_now_iso()

        sym_upper = symbol.upper()
        for item in items:
            if str(item.get("symbol", "")).upper() != sym_upper:
                continue
            return MDQuote(
                symbol=sym_upper,
                token=sym_upper,
                exchange="NSE",
                ltp=_float(item.get("lastPrice")),
                change=_float(item.get("change")),
                changePct=_float(item.get("pChange")),
                open=_float(item.get("open")),
                high=_float(item.get("dayHigh")),
                low=_float(item.get("dayLow")),
                prevClose=_float(item.get("previousClose")),
                volume=_int(item.get("totalTradedVolume")),
                oi=_int(item.get("totalTradedValue")),
                upperCircuit=None,
                lowerCircuit=None,
                provider="scrapling",
                fetchedAt=fetched_at,
            )

        logger.debug("single_quote_not_in_nifty500", symbol=symbol)
        return None

    except Exception as exc:
        logger.error("single_fetch_error", symbol=symbol, error=str(exc))
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now_iso() -> str:
    """Return current UTC time as an ISO 8601 string with 'Z' suffix."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


async def _get_redis() -> Any:
    """Return the aioredis client stored on the server module, or None.

    The result is cached in a module-level variable so subsequent calls
    within the same process do not repeat the dynamic import on every request.
    """
    global _cached_redis
    if _cached_redis is not None:
        return _cached_redis
    try:
        from src.server import _redis_client  # type: ignore[attr-defined]
        _cached_redis = _redis_client
        return _cached_redis
    except (ImportError, AttributeError):
        return None


_cached_redis: Any = None


async def _cache_get(redis: Any, key: str) -> MDQuote | None:
    """Try to read an ``MDQuote`` from Redis. Returns None on miss or error."""
    if redis is None:
        return None
    try:
        raw = await redis.get(key)
        if raw is None:
            return None
        data = json.loads(raw)
        return MDQuote.model_validate(data)
    except Exception as exc:
        logger.warning("quote_cache_read_error", key=key, error=str(exc))
        return None


async def _cache_set(redis: Any, key: str, quote: MDQuote) -> None:
    """Write an ``MDQuote`` to Redis with a 5-second TTL (fire-and-forget)."""
    if redis is None:
        return
    try:
        await redis.set(key, quote.model_dump_json(), ex=_QUOTE_CACHE_TTL)
    except Exception as exc:
        logger.warning("quote_cache_write_error", key=key, error=str(exc))


# ---------------------------------------------------------------------------
# Route: GET /scraping/quotes
# ---------------------------------------------------------------------------


@quotes_router.get("/scraping/quotes", response_class=JSONResponse)
async def get_quotes(
    symbols: str = Query(
        ...,
        description="Comma-separated list of NSE/BSE trading symbols (1–200 entries).",
    ),
    exchange: str = Query(
        default="NSE",
        description="Exchange code: NSE or BSE.",
    ),
) -> JSONResponse:
    """Return live market quotes for the requested symbols.

    Results are positionally aligned to the input ``symbols`` list.  Each
    entry is either a serialised ``MDQuote`` object or ``null`` when no quote
    could be obtained for that symbol.

    Routing
    -------
    - Index symbols (NIFTY, BANKNIFTY, etc.) → ``_fetch_index_quotes`` (NextApi all-indices)
    - NIFTY 200 constituents → ``_fetch_batch_quotes`` (NextApi NIFTY 200 endpoint)
    - Other symbols → ``_fetch_single_quote`` (NextApi NIFTY 500 endpoint)
    - All three use plain httpx — no browser/Playwright required

    Cache
    -----
    Each symbol is checked in Redis (key ``scraping:quote:{exchange}:{symbol}``,
    TTL 5 s) before any scraping is attempted.  After a successful fetch, results
    are written back to Redis.

    Error responses
    ---------------
    - HTTP 400 : validation failure (missing, empty, or >200 symbols)
    """
    # ------------------------------------------------------------------
    # 1. Parse and validate the symbols query parameter
    # ------------------------------------------------------------------
    parsed_symbols: list[str] = [s.strip().upper() for s in symbols.split(",") if s.strip()]

    if len(parsed_symbols) < 1:
        return JSONResponse(
            status_code=400,
            content={"error": "symbols must contain at least 1 symbol"},
        )
    if len(parsed_symbols) > 200:
        return JSONResponse(
            status_code=400,
            content={
                "error": (
                    f"symbols must contain at most 200 symbols, "
                    f"got {len(parsed_symbols)}"
                )
            },
        )

    exchange = exchange.strip().upper()
    if exchange not in {"NSE", "BSE"}:
        return JSONResponse(
            status_code=400,
            content={"error": f"exchange must be NSE or BSE, got '{exchange}'"},
        )

    # ------------------------------------------------------------------
    # 2. Redis cache check — populate from cache where possible
    # ------------------------------------------------------------------
    redis = await _get_redis()

    results_map: dict[str, MDQuote | None] = {sym: None for sym in parsed_symbols}
    cache_hits: set[str] = set()

    for sym in parsed_symbols:
        cache_key = f"scraping:quote:{exchange}:{sym}"
        cached = await _cache_get(redis, cache_key)
        if cached is not None:
            results_map[sym] = cached
            cache_hits.add(sym)

    symbols_to_fetch = [s for s in parsed_symbols if s not in cache_hits]

    # ------------------------------------------------------------------
    # 3. Fetch live data for cache-miss symbols
    # ------------------------------------------------------------------
    if symbols_to_fetch:
        # Route symbols to the appropriate endpoint:
        #  - Index symbols  → all-indices endpoint (_fetch_index_quotes)
        #  - NIFTY 200 members → batch constituent endpoint
        #  - Others          → NIFTY 500 constituent endpoint (single path)
        index_symbols = [s for s in symbols_to_fetch if s in _NSE_INDEX_SYMBOLS]
        constituents = [s for s in symbols_to_fetch if s not in _NSE_INDEX_SYMBOLS and s in NIFTY_200_SYMBOLS]
        non_constituents = [s for s in symbols_to_fetch if s not in _NSE_INDEX_SYMBOLS and s not in NIFTY_200_SYMBOLS]

        # Lazy session still needed for option-chain and future browser paths.
        session = await get_quote_session()

        # Index fetch (NIFTY, BANKNIFTY, etc.)
        if index_symbols:
            idx_results = await _fetch_index_quotes(index_symbols)
            results_map.update(idx_results)

        # Batch fetch for NIFTY 200 members
        if constituents:
            batch_results = await _fetch_batch_quotes(session, constituents)
            results_map.update(batch_results)

        # Per-symbol fetch for non-constituents
        for sym in non_constituents:
            quote = await _fetch_single_quote(session, sym)
            results_map[sym] = quote

        # ------------------------------------------------------------------
        # 4. Write newly-fetched quotes back to Redis cache
        # ------------------------------------------------------------------
        for sym in symbols_to_fetch:
            quote = results_map.get(sym)
            if quote is not None:
                cache_key = f"scraping:quote:{exchange}:{sym}"
                await _cache_set(redis, cache_key, quote)

    # ------------------------------------------------------------------
    # 5. Build positionally-aligned response
    # ------------------------------------------------------------------
    quotes_list: list[dict[str, Any] | None] = []
    for sym in parsed_symbols:
        q = results_map.get(sym)
        quotes_list.append(q.model_dump() if q is not None else None)

    return JSONResponse(
        status_code=200,
        content={
            "quotes": quotes_list,
            "count": len(quotes_list),
            "source": "nextapi",
        },
    )
