"""
OptionChainScraper — ``GET /scraping/option-chain`` routing, caching, and session management.

This module owns the singleton ``AsyncDynamicSession`` used for live NSE/BSE
option chain scraping via ``capture_xhr``.

Session strategy
----------------
A single ``AsyncDynamicSession`` instance (``_chain_session``) is shared across
all requests.  It is lazily created on the first call to ``get_chain_session()``.
An asyncio lock prevents duplicate creation under concurrent startup.

Fallback strategy
-----------------
If ``DynamicSession`` raises ``BrowserError`` or times out (15 s), the scraper
falls back to ``FetcherSession(impersonate='chrome')`` for a direct HTTP attempt.
If the fallback also fails, HTTP 503 is returned.

Cache architecture
------------------
Redis key : ``scraping:chain:{underlying}:{expiry}:{exchange}``
TTL       : 20 seconds

Cache writes are **fire-and-forget** (errors are logged but do not affect the
response).

Analytics
---------
``_compute_analytics(rows, spot)`` computes all option chain analytics:
PCR by OI and volume, max pain, ATM IV, and OI wall strikes.  Pure functions
are exported so they can be tested and property-checked independently.

Requirements: 4.1, 4.2, 4.3, 4.4, 4.10, 4.11, 4.12, 4.13
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from src.config import settings
from src.schemas import (
    Greeks,
    OptionChain,
    OptionChainAnalytics,
    OptionChainRow,
    OptionContract,
)
from src.core.circuit_breaker import get_breaker
from src.core.lineage import lineage_store
from src.core.schemas_v2 import DataSource

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

option_chain_router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_CHAIN_CACHE_TTL: int = 20        # seconds
_DYNAMIC_TIMEOUT: float = 15.0    # seconds — DynamicSession fetch deadline
_FALLBACK_TIMEOUT: float = 15.0   # seconds — FetcherSession fallback deadline

_VALID_EXCHANGES: frozenset[str] = frozenset({"NSE", "BSE"})

_NSE_OPTION_CHAIN_URL = "https://www.nseindia.com/option-chain"
_BSE_OPTION_CHAIN_URL = (
    "https://www.bseindia.com/markets/Derivatives/DerivativeHome.aspx?flag=03"
)

# ---------------------------------------------------------------------------
# Singleton session management
# ---------------------------------------------------------------------------

_chain_session: Any = None
# Raw (un-entered) instance kept so __aexit__ can be called on the exact
# object that was entered.  _chain_session holds the *entered* session.
_chain_session_raw: Any = None
_chain_session_lock: asyncio.Lock = asyncio.Lock()
# Semaphore: only one fetch() at a time on the shared Playwright session.
_chain_session_sem: asyncio.Semaphore = asyncio.Semaphore(1)

# Injected by server.py lifespan — used to pick up the current proxy when
# creating or resetting the session after a ban/proxy-rotation event.
_chain_proxy_manager: Any = None  # type: ignore[type-arg]


def set_chain_proxy_manager(pm: Any) -> None:
    """Inject the live ProxyManager so session resets use the rotated proxy."""
    global _chain_proxy_manager
    _chain_proxy_manager = pm


def _current_chain_proxy() -> str | None:
    """Return the active proxy URL from the proxy manager, or the settings default."""
    if _chain_proxy_manager is not None:
        return _chain_proxy_manager.get_proxy()
    return settings.scrapling_proxy_url or None


async def get_chain_session() -> Any:
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
    global _chain_session, _chain_session_raw

    if _chain_session is not None:
        return _chain_session

    async with _chain_session_lock:
        # Double-checked locking pattern
        if _chain_session is not None:
            return _chain_session

        try:
            from scrapling.fetchers import AsyncDynamicSession  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError("scrapling not available") from exc

        proxy = _current_chain_proxy()
        session_kwargs: dict[str, Any] = {
            "headless": settings.scrapling_headless,
            # Do NOT use network_idle=True at session level — NSE's SPA
            # background-polls indefinitely, so every fetch() would hang.
            "network_idle": False,
            # Force Chromium to IPv4 (Docker DNS returns IPv6 NAT64 first).
            "extra_flags": ["--disable-ipv6"],
            # capture_xhr is session-level only (not per-fetch).  Covers both
            # NSE and BSE option-chain XHR patterns.
            "capture_xhr": "api/option-chain|GetOptionChain",
        }
        if proxy:
            session_kwargs["proxy"] = proxy

        raw = AsyncDynamicSession(**session_kwargs)
        entered = await raw.__aenter__()
        _chain_session_raw = raw

        # NSE requires the browser to have visited the homepage before any
        # data API XHRs fire.  The homepage sets session cookies (nsit /
        # nseappid) that the SPA checks before making API calls.
        try:
            await entered.fetch("https://www.nseindia.com", network_idle=False, wait=2000)
            logger.info("chain_session_homepage_warmed")
        except Exception as exc:
            logger.warning("chain_session_homepage_warm_failed", error=str(exc))

        _chain_session = entered
        logger.info(
            "chain_session_created",
            headless=settings.scrapling_headless,
            proxy_set=bool(proxy),
        )

    return _chain_session


async def reset_chain_session() -> None:
    """Close and discard the singleton session.

    Called by the ban-response cycle.  The next call to ``get_chain_session``
    will create a fresh session using the *current* proxy from the proxy manager
    (which may have been rotated since the last ban).
    """
    global _chain_session, _chain_session_raw

    async with _chain_session_lock:
        if _chain_session_raw is not None:
            try:
                await _chain_session_raw.__aexit__(None, None, None)
            except Exception as exc:  # pragma: no cover
                logger.warning("chain_session_close_error", error=str(exc))
            _chain_session = None
            _chain_session_raw = None
            logger.info("chain_session_reset")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now_iso() -> str:
    """Return current UTC time as an ISO 8601 string with 'Z' suffix."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _today_str() -> str:
    """Return today's date as YYYY-MM-DD."""
    return date.today().isoformat()


_cached_redis: Any = None


async def _get_redis() -> Any:
    """Return the aioredis client stored on the server module, or None.

    Cached to avoid a dynamic import on every cache read/write.
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


async def _cache_get(redis: Any, key: str) -> OptionChain | None:
    """Try to read an ``OptionChain`` from Redis. Returns None on miss or error."""
    if redis is None:
        return None
    try:
        raw = await redis.get(key)
        if raw is None:
            return None
        data = json.loads(raw)
        return OptionChain.model_validate(data)
    except Exception as exc:
        logger.warning("chain_cache_read_error", key=key, error=str(exc))
        return None


async def _cache_set(redis: Any, key: str, chain: OptionChain) -> None:
    """Write an ``OptionChain`` to Redis with a 20-second TTL (fire-and-forget)."""
    if redis is None:
        return
    try:
        await redis.set(key, chain.model_dump_json(), ex=_CHAIN_CACHE_TTL)
    except Exception as exc:
        logger.warning("chain_cache_write_error", key=key, error=str(exc))


def _parse_expiry_date(expiry_str: str) -> date | None:
    """Parse NSE expiry date strings like '24-Jul-2025' or '2025-07-24'."""
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%B-%Y"):
        try:
            return datetime.strptime(expiry_str, fmt).date()
        except ValueError:
            continue
    return None


def _select_nearest_expiry(expiry_dates: list[str]) -> str:
    """Return the first expiry date >= today, or the last one if all are past."""
    today = date.today()
    for expiry_str in expiry_dates:
        parsed = _parse_expiry_date(expiry_str)
        if parsed is not None and parsed >= today:
            return expiry_str
    # All expiries are in the past — return the last one
    return expiry_dates[-1] if expiry_dates else ""


def _normalize_expiry_to_iso(expiry_str: str) -> str:
    """Convert NSE expiry string (e.g. '24-Jul-2025') to ISO 8601 date."""
    parsed = _parse_expiry_date(expiry_str)
    if parsed is not None:
        return parsed.isoformat()
    return expiry_str  # already ISO or unrecognised — return as-is


def _build_option_contract(
    raw: dict[str, Any],
    underlying: str,
    strike: float,
    expiry_iso: str,
    option_type: str,
    fetched_at: str,
) -> OptionContract:
    """Build an ``OptionContract`` from a raw NSE CE/PE dict."""
    greeks = Greeks(
        iv=raw.get("impliedVolatility") or None,
        delta=raw.get("delta") or None,
        gamma=raw.get("gamma") or None,
        theta=raw.get("theta") or None,
        vega=raw.get("vega") or None,
    )
    return OptionContract(
        token=str(raw.get("identifier", f"{underlying}{expiry_iso}{strike}{option_type}")),
        tradingSymbol=raw.get("identifier", f"{underlying}{expiry_iso}{strike}{option_type}"),
        underlying=underlying,
        expiry=expiry_iso,
        strike=strike,
        optionType=option_type,
        ltp=raw.get("lastPrice") or None,
        bid=raw.get("bidprice") or None,
        ask=raw.get("askPrice") or None,
        oi=int(raw.get("openInterest", 0)),
        oiChange=int(raw.get("changeinOpenInterest", 0)),
        volume=int(raw.get("totalTradedVolume", 0)),
        greeks=greeks,
        fetchedAt=fetched_at,
    )


def _build_rows_from_nse_data(
    data: list[dict[str, Any]],
    selected_expiry: str,
    underlying: str,
    fetched_at: str,
) -> list[OptionChainRow]:
    """Convert NSE ``records.data`` list to ``OptionChainRow`` objects.

    Filters to the selected expiry. Each dict may have a 'CE' key, a 'PE' key,
    or both.
    """
    # Normalise the selected expiry to ISO for comparison
    selected_expiry_iso = _normalize_expiry_to_iso(selected_expiry)

    strike_map: dict[float, dict[str, Any]] = {}

    for item in data:
        raw_expiry = item.get("expiryDate", "")
        item_expiry_iso = _normalize_expiry_to_iso(raw_expiry)

        # Filter to the selected expiry
        if item_expiry_iso != selected_expiry_iso:
            continue

        strike = float(item.get("strikePrice", 0))

        if strike not in strike_map:
            strike_map[strike] = {"CE": None, "PE": None}

        if "CE" in item:
            strike_map[strike]["CE"] = item["CE"]
        if "PE" in item:
            strike_map[strike]["PE"] = item["PE"]

    rows: list[OptionChainRow] = []
    for strike in sorted(strike_map.keys()):
        raw_ce = strike_map[strike]["CE"]
        raw_pe = strike_map[strike]["PE"]

        ce = (
            _build_option_contract(
                raw_ce, underlying, strike, selected_expiry_iso, "CE", fetched_at
            )
            if raw_ce
            else None
        )
        pe = (
            _build_option_contract(
                raw_pe, underlying, strike, selected_expiry_iso, "PE", fetched_at
            )
            if raw_pe
            else None
        )

        rows.append(OptionChainRow(strike=strike, ce=ce, pe=pe))

    return rows


# ---------------------------------------------------------------------------
# Analytics pure functions (Requirements: 4.5, 4.6, 4.7, 4.8, 4.9)
# ---------------------------------------------------------------------------


def compute_pcr_oi(rows: list[OptionChainRow]) -> float | None:
    """Compute Put-Call Ratio by open interest.

    Returns ``round(total_pe_oi / total_ce_oi, 2)`` when ``total_ce_oi > 0``,
    otherwise ``None``.

    **Validates: Requirements 4.5**
    """
    total_ce = sum(r.ce.oi for r in rows if r.ce)
    total_pe = sum(r.pe.oi for r in rows if r.pe)
    return round(total_pe / total_ce, 2) if total_ce > 0 else None


def compute_pcr_volume(rows: list[OptionChainRow]) -> float | None:
    """Compute Put-Call Ratio by traded volume.

    Returns ``round(total_pe_vol / total_ce_vol, 2)`` when ``total_ce_vol > 0``,
    otherwise ``None``.

    **Validates: Requirements 4.8**
    """
    total_ce_vol = sum(r.ce.volume for r in rows if r.ce)
    total_pe_vol = sum(r.pe.volume for r in rows if r.pe)
    return round(total_pe_vol / total_ce_vol, 2) if total_ce_vol > 0 else None


def compute_max_pain(rows: list[OptionChainRow]) -> float | None:
    """Compute the max pain strike price using an efficient O(N log N) algorithm.

    Phase 39 fix: replaces the previous O(N²) implementation.

    The max pain strike is the price at which the maximum number of options
    expire worthless (minimum total option value / "pain" to holders).

    For each candidate strike S:
        pain(S) = Σ_k [ max(0, S-k) × CE_OI_k + max(0, k-S) × PE_OI_k ]

    Efficient approach using prefix sums:
    - CE pain at S: sum of (S - k) * CE_OI_k for all k < S
      = S * cumulative_CE_OI_below_S - cumulative_CE_value_below_S
    - PE pain at S: sum of (k - S) * PE_OI_k for all k > S
      = cumulative_PE_value_above_S - S * cumulative_PE_OI_above_S

    This reduces from O(N²) to O(N log N) (sort) + O(N) (prefix sums).

    Returns the strike S* that minimises total pain.
    Returns None when rows is empty.
    """
    if not rows:
        return None

    # Sort strikes ascending
    sorted_rows = sorted(rows, key=lambda r: r.strike)
    n = len(sorted_rows)
    strikes = [r.strike for r in sorted_rows]

    # Extract OI arrays (0 when contract absent)
    ce_oi = [r.ce.oi if r.ce else 0 for r in sorted_rows]
    pe_oi = [r.pe.oi if r.pe else 0 for r in sorted_rows]

    # Build prefix sums for CE (left-to-right)
    # cumCeOi[i]  = sum of ce_oi[0..i-1]
    # cumCeVal[i] = sum of ce_oi[j] * strikes[j] for j in 0..i-1
    cum_ce_oi = [0.0] * (n + 1)
    cum_ce_val = [0.0] * (n + 1)
    for i in range(n):
        cum_ce_oi[i + 1] = cum_ce_oi[i] + ce_oi[i]
        cum_ce_val[i + 1] = cum_ce_val[i] + ce_oi[i] * strikes[i]

    # Build suffix sums for PE (right-to-left)
    # sfxPeOi[i]  = sum of pe_oi[i..n-1]
    # sfxPeVal[i] = sum of pe_oi[j] * strikes[j] for j in i..n-1
    sfx_pe_oi = [0.0] * (n + 1)
    sfx_pe_val = [0.0] * (n + 1)
    for i in range(n - 1, -1, -1):
        sfx_pe_oi[i] = sfx_pe_oi[i + 1] + pe_oi[i]
        sfx_pe_val[i] = sfx_pe_val[i + 1] + pe_oi[i] * strikes[i]

    # Compute pain for each strike using prefix/suffix sums
    # pain(S[i]) = CE_pain(S[i]) + PE_pain(S[i])
    # CE_pain(S[i]) = S[i] * cum_ce_oi[i] - cum_ce_val[i]  (all strikes < S[i])
    # PE_pain(S[i]) = sfx_pe_val[i+1] - S[i] * sfx_pe_oi[i+1]  (all strikes > S[i])
    min_pain = float("inf")
    min_pain_strike = strikes[0]

    for i in range(n):
        s = strikes[i]
        ce_pain = s * cum_ce_oi[i] - cum_ce_val[i]
        pe_pain = sfx_pe_val[i + 1] - s * sfx_pe_oi[i + 1]
        total_pain = ce_pain + pe_pain
        if total_pain < min_pain:
            min_pain = total_pain
            min_pain_strike = s

    return min_pain_strike


def compute_atm_iv(rows: list[OptionChainRow], spot: float | None) -> float | None:
    """Compute ATM implied volatility.

    Sorts rows by ``|strike - spot|`` ascending and collects CE and PE IVs
    from up to the 5 nearest strikes where the contract's ``OI > 0`` and
    ``iv`` is not None.

    Returns the simple arithmetic mean rounded to 2 decimal places when at
    least 2 qualifying IV values are found; ``None`` otherwise.

    Returns ``None`` when ``spot`` is ``None``.

    **Validates: Requirements 4.7**
    """
    if spot is None:
        return None

    sorted_rows = sorted(rows, key=lambda r: abs(r.strike - spot))
    ivs: list[float] = []

    for row in sorted_rows[:5]:
        if row.ce and row.ce.greeks.iv is not None and row.ce.oi > 0:
            ivs.append(row.ce.greeks.iv)
        if row.pe and row.pe.greeks.iv is not None and row.pe.oi > 0:
            ivs.append(row.pe.greeks.iv)

    return round(sum(ivs) / len(ivs), 2) if len(ivs) >= 2 else None


def compute_oi_walls(
    rows: list[OptionChainRow],
) -> tuple[float | None, float | None]:
    """Compute the OI wall strike prices.

    ``maxCeOiStrike`` — strike with the highest CE open interest across all
    rows with a non-null CE contract.  Tie-break: lowest strike.

    ``maxPeOiStrike`` — strike with the highest PE open interest across all
    rows with a non-null PE contract.  Tie-break: lowest strike.

    Returns ``(None, None)`` when no CE or PE contracts are present.

    **Validates: Requirements 4.9**
    """
    ce_rows = [(r.strike, r.ce.oi) for r in rows if r.ce]
    pe_rows = [(r.strike, r.pe.oi) for r in rows if r.pe]

    max_ce_strike: float | None = None
    if ce_rows:
        # Sort by OI descending, then by strike ascending for tie-break
        ce_rows.sort(key=lambda x: (-x[1], x[0]))
        max_ce_strike = ce_rows[0][0]

    max_pe_strike: float | None = None
    if pe_rows:
        pe_rows.sort(key=lambda x: (-x[1], x[0]))
        max_pe_strike = pe_rows[0][0]

    return max_ce_strike, max_pe_strike


def _compute_analytics(
    rows: list[OptionChainRow], spot: float | None
) -> OptionChainAnalytics:
    """Compute the full ``OptionChainAnalytics`` from a list of rows.

    Aggregates totals and calls each analytics pure function.
    """
    total_ce_oi = 0
    total_pe_oi = 0
    total_ce_oi_change = 0
    total_pe_oi_change = 0

    for row in rows:
        if row.ce:
            total_ce_oi += row.ce.oi
            total_ce_oi_change += row.ce.oiChange
        if row.pe:
            total_pe_oi += row.pe.oi
            total_pe_oi_change += row.pe.oiChange

    max_ce_oi_strike, max_pe_oi_strike = compute_oi_walls(rows)

    return OptionChainAnalytics(
        pcrOi=compute_pcr_oi(rows),
        pcrVolume=compute_pcr_volume(rows),
        maxCeOiStrike=max_ce_oi_strike,
        maxPeOiStrike=max_pe_oi_strike,
        totalCeOi=total_ce_oi,
        totalPeOi=total_pe_oi,
        totalCeOiChange=total_ce_oi_change,
        totalPeOiChange=total_pe_oi_change,
        atmIv=compute_atm_iv(rows, spot),
        maxPain=compute_max_pain(rows),
    )


# ---------------------------------------------------------------------------
# NSE fetch path
# ---------------------------------------------------------------------------


async def _fetch_nse_option_chain(
    session: Any,
    underlying: str,
    expiry: str | None,
) -> OptionChain:
    """Fetch the NSE option chain using DynamicSession + capture_xhr.

    Parameters
    ----------
    session:
        The shared ``AsyncDynamicSession`` instance.
    underlying:
        The underlying index/equity symbol (e.g. ``NIFTY``, ``BANKNIFTY``).
    expiry:
        Optional ISO 8601 expiry date string.  When None, the nearest
        available expiry (>= today) is used.

    Returns
    -------
    OptionChain
        Fully populated option chain with all analytics computed.

    Raises
    ------
    RuntimeError
        When no XHR payload is captured or the response structure is invalid.
    """
    fetched_at = _utc_now_iso()

    # Build the NSE URL — indices use a different endpoint than equities but
    # both are captured by the 'api/option-chain' substring match.
    url = _NSE_OPTION_CHAIN_URL

    import time as _time
    breaker = get_breaker("nse_option_chain")
    if not breaker.allow_request():
        raise RuntimeError("NSE option chain circuit breaker OPEN — request suppressed")
    received_at_ms = int(_time.time() * 1000)

    logger.info("nse_chain_fetch_start", underlying=underlying, url=url)

    # Serialize: only one fetch() at a time on the shared Playwright session
    async with _chain_session_sem:
        page = await session.fetch(
            url,
            # NSE SPA background-polls forever; use wait= instead of
            # network_idle=True so the fetch completes after DOM load + dwell.
            network_idle=False,
            wait=4000,
        )

        # Save structural fingerprints on first scrape so adaptive tracking can
        # relocate elements if NSE redesigns the page.
        try:
            page.css("[data-expiry]", auto_save=True)
        except Exception:  # pragma: no cover
            pass  # Element may not exist on all pages — non-fatal

        # Find the captured XHR response whose URL contains 'option-chain'
        chain_data: dict[str, Any] | None = None
        if hasattr(page, "captured_xhr") and page.captured_xhr:
            for xhr_response in page.captured_xhr:
                if "option-chain" in getattr(xhr_response, "url", ""):
                    try:
                        chain_data = xhr_response.json()
                        break
                    except Exception as exc:
                        logger.warning("nse_xhr_json_parse_error", error=str(exc))

    if chain_data is None:
        breaker.record_failure("xhr_not_captured")
        raise RuntimeError(
            "NSE option chain XHR not captured — no matching xhr response found"
        )

    # Parse the canonical NSE payload structure
    records = chain_data.get("records", {})
    data_list: list[dict[str, Any]] = records.get("data") or []
    expiry_dates: list[str] = records.get("expiryDates") or []
    underlying_value: float | None = records.get("underlyingValue")

    if not expiry_dates:
        raise RuntimeError("NSE option chain response contains no expiryDates")

    # Normalise expiries to ISO 8601
    expiries_iso = [_normalize_expiry_to_iso(e) for e in expiry_dates]

    # Determine which expiry to use
    if expiry:
        # Caller specified an expiry — validate it is in the list
        if expiry not in expiries_iso:
            # Caller may have passed in NSE format — try to match
            expiry_iso_requested = _normalize_expiry_to_iso(expiry)
            if expiry_iso_requested not in expiries_iso:
                # Fall back to nearest
                logger.warning(
                    "nse_requested_expiry_not_found",
                    requested=expiry,
                    available=expiries_iso,
                )
                selected_raw_expiry = _select_nearest_expiry(expiry_dates)
            else:
                # Find the raw NSE expiry that maps to this ISO date
                idx = expiries_iso.index(expiry_iso_requested)
                selected_raw_expiry = expiry_dates[idx]
        else:
            idx = expiries_iso.index(expiry)
            selected_raw_expiry = expiry_dates[idx]
    else:
        selected_raw_expiry = _select_nearest_expiry(expiry_dates)

    selected_expiry_iso = _normalize_expiry_to_iso(selected_raw_expiry)

    # Build rows for the selected expiry
    rows = _build_rows_from_nse_data(
        data=data_list,
        selected_expiry=selected_raw_expiry,
        underlying=underlying,
        fetched_at=fetched_at,
    )

    analytics = _compute_analytics(rows, underlying_value)

    logger.info(
        "nse_chain_fetch_complete",
        underlying=underlying,
        expiry=selected_expiry_iso,
        row_count=len(rows),
        spot=underlying_value,
    )

    breaker.record_success()
    available_at_ms = int(_time.time() * 1000)
    lineage_store.record(
        instrument_id=underlying,
        symbol=underlying,
        data_type="OPTION_CHAIN",
        source=DataSource.NSE_XHR,
        event_time_ms=None,
        received_at_ms=received_at_ms,
        available_at_ms=available_at_ms,
        normalization_version="2.0.0",
        validation_applied=True,
        is_fallback=False,
        extra={"expiry": selected_expiry_iso, "strike_count": len(rows)},
    )

    return OptionChain(
        underlying=underlying,
        spot=underlying_value,
        expiry=selected_expiry_iso,
        expiries=expiries_iso,
        rows=rows,
        analytics=analytics,
        provider="scrapling",
        fetchedAt=fetched_at,
    )


# ---------------------------------------------------------------------------
# BSE fetch path
# ---------------------------------------------------------------------------


async def _fetch_bse_option_chain(
    session: Any,
    underlying: str,
    expiry: str | None,
) -> OptionChain:
    """Fetch the BSE SENSEX option chain using DynamicSession + capture_xhr.

    Parameters
    ----------
    session:
        The shared ``AsyncDynamicSession`` instance.
    underlying:
        The underlying symbol (e.g. ``SENSEX``, ``BANKEX``).
    expiry:
        Optional ISO 8601 expiry date string.

    Returns
    -------
    OptionChain
        Fully populated option chain with all analytics computed.

    Raises
    ------
    RuntimeError
        When no XHR payload is captured or the response structure is invalid.
    """
    fetched_at = _utc_now_iso()
    url = _BSE_OPTION_CHAIN_URL

    import time as _time
    breaker = get_breaker("bse_option_chain")
    if not breaker.allow_request():
        raise RuntimeError("BSE option chain circuit breaker OPEN — request suppressed")
    received_at_ms = int(_time.time() * 1000)

    logger.info("bse_chain_fetch_start", underlying=underlying, url=url)

    # Serialize: only one fetch() at a time on the shared Playwright session
    async with _chain_session_sem:
        page = await session.fetch(
            url,
            network_idle=False,
            wait=4000,
        )

        # Find the captured XHR response
        chain_data: dict[str, Any] | None = None
        if hasattr(page, "captured_xhr") and page.captured_xhr:
            for xhr_response in page.captured_xhr:
                if "GetOptionChain" in getattr(xhr_response, "url", ""):
                    try:
                        chain_data = xhr_response.json()
                        break
                    except Exception as exc:
                        logger.warning("bse_xhr_json_parse_error", error=str(exc))

    if chain_data is None:
        breaker.record_failure("xhr_not_captured")
        raise RuntimeError(
            "BSE option chain XHR not captured — no matching xhr response found"
        )

    # BSE response structure varies; attempt to extract a data list
    # BSE typically returns {"Table": [...], "Table1": [...]} or similar
    data_list: list[dict[str, Any]] = []
    expiry_dates: list[str] = []
    spot: float | None = None

    # Try common BSE response keys
    for data_key in ("Table", "data", "OptionChainData"):
        if data_key in chain_data and isinstance(chain_data[data_key], list):
            data_list = chain_data[data_key]
            break

    # Extract unique expiry dates from the data
    for item in data_list:
        exp = item.get("ExpiryDate") or item.get("expiryDate") or item.get("EXPIRY_DT", "")
        if exp and exp not in expiry_dates:
            expiry_dates.append(exp)

    # Extract spot price
    for key in ("UnderlyingValue", "underlyingValue", "LastPrice", "lastPrice"):
        if key in chain_data:
            try:
                spot = float(chain_data[key])
                break
            except (TypeError, ValueError):
                pass

    if not expiry_dates:
        raise RuntimeError("BSE option chain response contains no expiry dates")

    expiries_iso = [_normalize_expiry_to_iso(e) for e in expiry_dates]

    selected_raw_expiry = expiry_dates[0] if not expiry else (
        expiry_dates[expiries_iso.index(expiry)]
        if expiry in expiries_iso
        else expiry_dates[0]
    )
    selected_expiry_iso = _normalize_expiry_to_iso(selected_raw_expiry)

    # Build rows from BSE data — BSE format differs from NSE
    rows = _build_rows_from_bse_data(
        data=data_list,
        selected_expiry=selected_raw_expiry,
        underlying=underlying,
        fetched_at=fetched_at,
    )

    analytics = _compute_analytics(rows, spot)

    logger.info(
        "bse_chain_fetch_complete",
        underlying=underlying,
        expiry=selected_expiry_iso,
        row_count=len(rows),
        spot=spot,
    )

    breaker.record_success()
    available_at_ms = int(_time.time() * 1000)
    lineage_store.record(
        instrument_id=underlying,
        symbol=underlying,
        data_type="OPTION_CHAIN",
        source=DataSource.BSE_XHR,
        event_time_ms=None,
        received_at_ms=received_at_ms,
        available_at_ms=available_at_ms,
        normalization_version="2.0.0",
        validation_applied=True,
        is_fallback=False,
        extra={"expiry": selected_expiry_iso, "strike_count": len(rows)},
    )

    return OptionChain(
        underlying=underlying,
        spot=spot,
        expiry=selected_expiry_iso,
        expiries=expiries_iso,
        rows=rows,
        analytics=analytics,
        provider="scrapling",
        fetchedAt=fetched_at,
    )


def _build_rows_from_bse_data(
    data: list[dict[str, Any]],
    selected_expiry: str,
    underlying: str,
    fetched_at: str,
) -> list[OptionChainRow]:
    """Convert BSE option chain data list to ``OptionChainRow`` objects."""
    selected_expiry_iso = _normalize_expiry_to_iso(selected_expiry)
    strike_map: dict[float, dict[str, Any]] = {}

    for item in data:
        raw_expiry = (
            item.get("ExpiryDate") or item.get("expiryDate") or item.get("EXPIRY_DT", "")
        )
        if _normalize_expiry_to_iso(raw_expiry) != selected_expiry_iso:
            continue

        strike = float(item.get("StrikePrice") or item.get("strikePrice") or 0)
        option_type = (
            item.get("OptionType") or item.get("optionType") or item.get("CP_FLAG", "")
        ).upper()

        if strike not in strike_map:
            strike_map[strike] = {"CE": None, "PE": None}

        if option_type in ("CE", "C", "CALL"):
            strike_map[strike]["CE"] = item
        elif option_type in ("PE", "P", "PUT"):
            strike_map[strike]["PE"] = item

    rows: list[OptionChainRow] = []
    for strike in sorted(strike_map.keys()):
        raw_ce = strike_map[strike]["CE"]
        raw_pe = strike_map[strike]["PE"]

        def _bse_to_contract(
            raw: dict[str, Any], otype: str
        ) -> OptionContract:
            # BSE field names differ slightly from NSE
            ltp = raw.get("LastPrice") or raw.get("lastPrice") or raw.get("LTP") or None
            oi = int(raw.get("OpenInterest") or raw.get("openInterest") or raw.get("OI") or 0)
            oi_change = int(
                raw.get("ChangeInOI") or raw.get("changeinOpenInterest") or 0
            )
            volume = int(
                raw.get("TotalTradedVolume") or raw.get("totalTradedVolume") or raw.get("Volume") or 0
            )
            iv = raw.get("ImpliedVolatility") or raw.get("impliedVolatility") or None
            identifier = raw.get("token") or raw.get("Token") or (
                f"{underlying}{selected_expiry_iso}{strike}{otype}"
            )
            return OptionContract(
                token=str(identifier),
                tradingSymbol=str(identifier),
                underlying=underlying,
                expiry=selected_expiry_iso,
                strike=strike,
                optionType=otype,
                ltp=float(ltp) if ltp is not None else None,
                bid=None,
                ask=None,
                oi=oi,
                oiChange=oi_change,
                volume=volume,
                greeks=Greeks(iv=float(iv) if iv is not None else None),
                fetchedAt=fetched_at,
            )

        ce = _bse_to_contract(raw_ce, "CE") if raw_ce else None
        pe = _bse_to_contract(raw_pe, "PE") if raw_pe else None
        rows.append(OptionChainRow(strike=strike, ce=ce, pe=pe))

    return rows


# ---------------------------------------------------------------------------
# FetcherSession fallback
# ---------------------------------------------------------------------------


async def _fetch_nse_option_chain_fallback(
    underlying: str, expiry: str | None
) -> OptionChain:
    """Fallback: fetch NSE option chain via FetcherSession (HTTP, no browser).

    Used when DynamicSession raises BrowserError or times out.
    """
    import asyncio

    loop = asyncio.get_running_loop()

    def _sync_fetch() -> dict[str, Any]:
        try:
            from scrapling.fetchers import FetcherSession  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError("scrapling not available") from exc

        with FetcherSession(impersonate="chrome", stealthy_headers=True) as sess:
            # NSE provides the option chain data via a direct API endpoint
            url = (
                f"https://www.nseindia.com/api/option-chain-indices?symbol={underlying}"
                if underlying in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50")
                else f"https://www.nseindia.com/api/option-chain-equities?symbol={underlying}"
            )
            resp = sess.get(url)
            return resp.json()

    fetched_at = _utc_now_iso()
    chain_data = await asyncio.wait_for(
        loop.run_in_executor(None, _sync_fetch),
        timeout=_FALLBACK_TIMEOUT,
    )

    records = chain_data.get("records", {})
    data_list: list[dict[str, Any]] = records.get("data") or []
    expiry_dates: list[str] = records.get("expiryDates") or []
    underlying_value: float | None = records.get("underlyingValue")

    if not expiry_dates:
        raise RuntimeError("NSE fallback: response contains no expiryDates")

    expiries_iso = [_normalize_expiry_to_iso(e) for e in expiry_dates]

    if expiry and expiry in expiries_iso:
        idx = expiries_iso.index(expiry)
        selected_raw_expiry = expiry_dates[idx]
    else:
        selected_raw_expiry = _select_nearest_expiry(expiry_dates)

    selected_expiry_iso = _normalize_expiry_to_iso(selected_raw_expiry)

    rows = _build_rows_from_nse_data(
        data=data_list,
        selected_expiry=selected_raw_expiry,
        underlying=underlying,
        fetched_at=fetched_at,
    )
    analytics = _compute_analytics(rows, underlying_value)

    return OptionChain(
        underlying=underlying,
        spot=underlying_value,
        expiry=selected_expiry_iso,
        expiries=expiries_iso,
        rows=rows,
        analytics=analytics,
        provider="scrapling",
        fetchedAt=fetched_at,
    )


# ---------------------------------------------------------------------------
# Route: GET /scraping/option-chain
# ---------------------------------------------------------------------------


@option_chain_router.get("/scraping/option-chain", response_class=JSONResponse)
async def get_option_chain(
    underlying: str = Query(
        ...,
        description="Underlying index or equity symbol (e.g. NIFTY, BANKNIFTY, SENSEX).",
    ),
    expiry: str | None = Query(
        default=None,
        description="Expiry date in ISO 8601 format (YYYY-MM-DD). Defaults to nearest expiry.",
    ),
    exchange: str = Query(
        default="NSE",
        description="Exchange: NSE or BSE.",
    ),
) -> JSONResponse:
    """Return the full option chain for a given underlying and expiry.

    When ``expiry`` is omitted, the nearest available expiry date >= today is
    used.  Results are cached in Redis for 20 seconds.

    Error responses
    ---------------
    - HTTP 400 : validation failure (missing underlying, invalid exchange)
    - HTTP 503 : DynamicSession timeout, XHR not captured, or fallback also failed
    """
    # ------------------------------------------------------------------
    # 1. Validate inputs
    # ------------------------------------------------------------------
    underlying = underlying.strip().upper()
    exchange = exchange.strip().upper()

    if not underlying:
        return JSONResponse(
            status_code=400,
            content={"error": "underlying is required"},
        )

    if exchange not in _VALID_EXCHANGES:
        return JSONResponse(
            status_code=400,
            content={
                "error": f"exchange must be one of {sorted(_VALID_EXCHANGES)}, got '{exchange}'"
            },
        )

    # ------------------------------------------------------------------
    # 2. Redis cache check
    # ------------------------------------------------------------------
    redis = await _get_redis()
    cache_key = f"scraping:chain:{underlying}:{expiry or 'nearest'}:{exchange}"
    cached = await _cache_get(redis, cache_key)
    if cached is not None:
        logger.info(
            "chain_cache_hit",
            underlying=underlying,
            expiry=expiry,
            exchange=exchange,
        )
        return JSONResponse(status_code=200, content=cached.model_dump())

    # ------------------------------------------------------------------
    # 3. Fetch live data
    # ------------------------------------------------------------------
    try:
        session = await get_chain_session()
    except RuntimeError as exc:
        return JSONResponse(
            status_code=503,
            content={
                "available": False,
                "reason": str(exc),
                "provider": "scrapling",
            },
        )

    chain: OptionChain | None = None

    if exchange == "NSE":
        # --- Primary: DynamicSession ---
        try:
            chain = await asyncio.wait_for(
                _fetch_nse_option_chain(session, underlying, expiry),
                timeout=_DYNAMIC_TIMEOUT,
            )
        except (asyncio.TimeoutError, Exception) as primary_exc:
            is_timeout = isinstance(primary_exc, asyncio.TimeoutError)
            logger.warning(
                "nse_chain_primary_failed",
                underlying=underlying,
                error=str(primary_exc),
                is_timeout=is_timeout,
            )
            # --- Fallback: FetcherSession ---
            try:
                chain = await _fetch_nse_option_chain_fallback(underlying, expiry)
                logger.info(
                    "nse_chain_fallback_succeeded",
                    underlying=underlying,
                )
            except Exception as fallback_exc:
                logger.error(
                    "nse_chain_fallback_failed",
                    underlying=underlying,
                    error=str(fallback_exc),
                )
                return JSONResponse(
                    status_code=503,
                    content={
                        "available": False,
                        "reason": (
                            f"NSE option chain fetch failed: {primary_exc}; "
                            f"fallback also failed: {fallback_exc}"
                        ),
                        "provider": "scrapling",
                    },
                )

    else:  # BSE
        try:
            chain = await asyncio.wait_for(
                _fetch_bse_option_chain(session, underlying, expiry),
                timeout=_DYNAMIC_TIMEOUT,
            )
        except (asyncio.TimeoutError, Exception) as exc:
            logger.error(
                "bse_chain_fetch_failed",
                underlying=underlying,
                error=str(exc),
            )
            return JSONResponse(
                status_code=503,
                content={
                    "available": False,
                    "reason": f"BSE option chain fetch failed: {exc}",
                    "provider": "scrapling",
                },
            )

    # ------------------------------------------------------------------
    # 4. Write to Redis cache (fire-and-forget)
    # ------------------------------------------------------------------
    if chain is not None:
        # Use the resolved expiry from the chain for a more specific cache key
        resolved_cache_key = (
            f"scraping:chain:{underlying}:{chain.expiry}:{exchange}"
        )
        await _cache_set(redis, resolved_cache_key, chain)
        # Also cache under the 'nearest' key so the next call with no expiry hits cache
        if expiry is None:
            await _cache_set(redis, cache_key, chain)

    # ------------------------------------------------------------------
    # 5. Return response
    # ------------------------------------------------------------------
    return JSONResponse(
        status_code=200,
        content=chain.model_dump() if chain else {},
    )


# ---------------------------------------------------------------------------
# Route: POST /scraping/option-chain/warm
# ---------------------------------------------------------------------------


@option_chain_router.post("/scraping/option-chain/warm", response_class=JSONResponse)
async def warm_option_chain_session() -> JSONResponse:
    """Pre-warm the DynamicSession by loading the NSE option chain page.

    This endpoint is called at startup (or on-demand) to ensure the Chromium
    session is ready before the first real option chain request.  It confirms
    that at least one XHR payload was captured before returning success.

    Returns
    -------
    200 ``{"warmed": true, "session_ready": true}``
        When a successful XHR capture was confirmed.
    503 ``{"available": false, "reason": "..."}``
        When the session could not be warmed or XHR capture failed.
    """
    try:
        session = await get_chain_session()
    except RuntimeError as exc:
        return JSONResponse(
            status_code=503,
            content={
                "available": False,
                "reason": str(exc),
                "provider": "scrapling",
            },
        )

    try:
        page = await asyncio.wait_for(
            session.fetch(
                _NSE_OPTION_CHAIN_URL,
                capture_xhr="api/option-chain",
                network_idle=True,
            ),
            timeout=_DYNAMIC_TIMEOUT,
        )

        # Verify that at least one XHR was captured
        session_ready = bool(
            hasattr(page, "captured_xhr")
            and page.captured_xhr
            and any(
                "option-chain" in getattr(r, "url", "")
                for r in page.captured_xhr
            )
        )

        if session_ready:
            logger.info("chain_session_warmed", nse_xhr_captured=True)
            return JSONResponse(
                status_code=200,
                content={"warmed": True, "session_ready": True},
            )
        else:
            logger.warning("chain_session_warm_no_xhr")
            return JSONResponse(
                status_code=503,
                content={
                    "available": False,
                    "reason": "Session loaded but no option-chain XHR was captured",
                    "provider": "scrapling",
                },
            )

    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=503,
            content={
                "available": False,
                "reason": f"Warm request timed out after {_DYNAMIC_TIMEOUT}s",
                "provider": "scrapling",
            },
        )
    except Exception as exc:
        logger.error("chain_session_warm_failed", error=str(exc))
        return JSONResponse(
            status_code=503,
            content={
                "available": False,
                "reason": f"Session warm failed: {exc}",
                "provider": "scrapling",
            },
        )
