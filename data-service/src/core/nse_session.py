"""
core/nse_session.py — Centralised NSE WAF bypass session.

NSE's Akamai WAF has TWO layers of bot protection:

  Layer 1: TLS fingerprinting (JA3/JA4)
    Standard Python requests/httpx use OpenSSL; Akamai detects this and
    blocks the connection (HTTP 000 or 403). curl_cffi impersonates Chrome's
    BoringSSL TLS fingerprint, making the connection indistinguishable from a
    real browser. This unblocks: www.nseindia.com, charting.nseindia.com.

  Layer 2: Behavioural session token (nsit cookie)
    The nsit cookie is issued by Akamai's JS challenge after it confirms
    the client is a real browser (mouse movements, JS execution, timing).
    Without nsit, charting.nseindia.com returns {"status":true,"data":[]}.
    With nsit: full historical data served.

This module owns ONE singleton curl_cffi session used across ALL data-service
NSE HTTP calls:
  - src/scrapers/live_quotes.py  (NextAPI: www.nseindia.com/api/NextApi)
  - src/scrapers/historical.py   (Charting: www.nseindia.com/api/chart-databyindex
                                  and charting.nseindia.com)
  - src/providers/openchart/     (charting.nseindia.com/v1/charts)

NOT replaced (no WAF / different CDN):
  - nsearchives.nseindia.com     (CloudFront, no Akamai — httpx works fine)
  - bseindia.com                 (BSE CDN, no Akamai)
  - Angel One / Upstox           (broker APIs, authenticated)

nsit cookie loading:
  1. Reads from file: data-service/.nsit_cookie (set by seed_nse_session.py)
  2. Falls back to env var: NSE_NSIT_COOKIE
  3. If absent: Layer 1 bypass only (charting data may be empty)

Session lifecycle:
  - Singleton; created lazily on first call to get_nse_session()
  - Thread/async safe via asyncio.Lock
  - Cookie refresh: re-seeds homepage cookies every 25 minutes
  - nsit token: injected once; falls back gracefully if absent

Usage:
  from src.core.nse_session import get_nse_session, nse_get, nse_post

  # Preferred: use high-level helpers
  resp = await nse_get("https://www.nseindia.com/api/NextApi/...")
  resp = await nse_post("https://charting.nseindia.com/v1/charts/...", json={...})

  # Or get the session for custom use
  session = await get_nse_session()
  r = session.get(url, timeout=12)
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any, Optional

import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Chrome headers (shared with OpenChart adapter)
# ---------------------------------------------------------------------------

NSE_CHROME_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/119.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}

# ---------------------------------------------------------------------------
# nsit cookie loader
# ---------------------------------------------------------------------------

def _load_nsit_cookie() -> Optional[str]:
    """
    Load the NSE nsit session cookie from .nsit_cookie file or env var.
    Returns None if not found (Layer 1 bypass only).
    """
    # 1. Check file (set by seed_nse_session.py)
    candidates = [
        Path(__file__).parent.parent.parent / ".nsit_cookie",     # data-service/.nsit_cookie
        Path(__file__).parent.parent.parent.parent / ".nsit_cookie",  # repo root/.nsit_cookie
    ]
    for p in candidates:
        if p.exists():
            val = p.read_text().strip()
            if val:
                logger.info("nse_nsit_loaded_from_file", path=str(p))
                return val

    # 2. Check env var
    env_val = os.environ.get("NSE_NSIT_COOKIE", "").strip()
    if env_val:
        logger.info("nse_nsit_loaded_from_env")
        return env_val

    return None


# ---------------------------------------------------------------------------
# Session singleton
# ---------------------------------------------------------------------------

_session: Any = None          # curl_cffi Session
_session_lock = asyncio.Lock()
_last_cookie_refresh: float = 0.0
_COOKIE_REFRESH_INTERVAL_SECS = 25 * 60   # re-seed every 25 minutes


def _build_session(nsit_cookie: Optional[str] = None) -> Any:
    """Build a new curl_cffi session with Chrome TLS + NSE cookies."""
    from curl_cffi import requests as cffi_requests

    session = cffi_requests.Session(impersonate="chrome110")
    session.headers.update(NSE_CHROME_HEADERS)

    # Seed Layer 1 cookies: _abck, ak_bmsc, bm_sv, bm_sz
    _prime_cookies(session)

    # Inject nsit if available (Layer 2)
    if nsit_cookie:
        session.cookies.set("nsit", nsit_cookie, domain=".nseindia.com")
        logger.info("nse_session_nsit_injected")
    else:
        logger.info(
            "nse_session_no_nsit",
            message=(
                "Layer 1 TLS bypass active. nsit cookie absent — "
                "charting API will return empty data. "
                "Run: python3 scripts/seed_nse_session.py"
            ),
        )

    return session


def _prime_cookies(session: Any) -> None:
    """
    Synchronously seed WAF cookies from NSE homepage + charting subdomain.
    Called during session creation and periodic refresh.
    """
    global _last_cookie_refresh

    for url, referer in [
        ("https://www.nseindia.com", "https://www.nseindia.com/"),
        ("https://charting.nseindia.com", "https://charting.nseindia.com/"),
    ]:
        try:
            session.headers.update({"Referer": referer})
            session.get(url, timeout=12)
            time.sleep(1.5)
        except Exception as exc:
            logger.warning("nse_cookie_prime_failed", url=url, error=str(exc))

    # Restore neutral referer
    session.headers.update({"Referer": "https://www.nseindia.com/"})
    _last_cookie_refresh = time.monotonic()
    logger.info("nse_session_cookies_primed")


async def get_nse_session() -> Any:
    """
    Return the singleton curl_cffi NSE session (creates it on first call).
    Thread/async safe. Refreshes cookies every 25 minutes automatically.
    Returns None if curl_cffi is not installed (callers must handle gracefully).
    """
    global _session, _last_cookie_refresh

    try:
        import curl_cffi  # noqa: F401
    except ImportError:
        logger.warning(
            "curl_cffi_not_installed",
            message=(
                "curl_cffi not installed — NSE requests will use httpx (OpenSSL). "
                "Install with: pip install curl_cffi"
            ),
        )
        return None

    # Fast path — session exists and cookies are fresh
    if (
        _session is not None
        and time.monotonic() - _last_cookie_refresh < _COOKIE_REFRESH_INTERVAL_SECS
    ):
        return _session

    async with _session_lock:
        # Re-check under lock (double-checked locking)
        if (
            _session is not None
            and time.monotonic() - _last_cookie_refresh < _COOKIE_REFRESH_INTERVAL_SECS
        ):
            return _session

        nsit = _load_nsit_cookie()

        if _session is None:
            # First creation: run in thread pool (synchronous HTTP calls)
            _session = await asyncio.get_event_loop().run_in_executor(
                None, _build_session, nsit
            )
            logger.info("nse_session_created")
        else:
            # Periodic cookie refresh
            await asyncio.get_event_loop().run_in_executor(
                None, _prime_cookies, _session
            )
            if nsit:
                _session.cookies.set("nsit", nsit, domain=".nseindia.com")
            logger.info("nse_session_cookies_refreshed")

    return _session


def get_nse_session_sync() -> Any:
    """
    Synchronous version of get_nse_session for use in thread-pool contexts.
    Returns None if curl_cffi is not installed.
    """
    global _session, _last_cookie_refresh

    try:
        import curl_cffi  # noqa: F401
    except ImportError:
        return None

    if (
        _session is not None
        and time.monotonic() - _last_cookie_refresh < _COOKIE_REFRESH_INTERVAL_SECS
    ):
        return _session

    nsit = _load_nsit_cookie()
    _session = _build_session(nsit)
    return _session


# ---------------------------------------------------------------------------
# High-level async helpers (run blocking curl_cffi calls in thread pool)
# ---------------------------------------------------------------------------

async def nse_get(url: str, *, params: Optional[dict] = None,
                  headers: Optional[dict] = None, timeout: int = 12) -> Any:
    """
    GET request to NSE with Chrome TLS bypass.
    Falls back to httpx if curl_cffi is unavailable.
    """
    session = await get_nse_session()
    if session is None:
        # Fallback: use httpx with standard headers
        import httpx
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True,
            headers={**NSE_CHROME_HEADERS, **(headers or {})}
        ) as client:
            return await client.get(url, params=params)

    def _do_get():
        kw: dict[str, Any] = {"timeout": timeout}
        if params:
            kw["params"] = params
        if headers:
            session.headers.update(headers)
        return session.get(url, **kw)

    return await asyncio.get_event_loop().run_in_executor(None, _do_get)


async def nse_post(url: str, *, json: Optional[dict] = None,
                   data: Optional[dict] = None, headers: Optional[dict] = None,
                   timeout: int = 12) -> Any:
    """
    POST request to NSE with Chrome TLS bypass.
    Falls back to httpx if curl_cffi is unavailable.
    """
    session = await get_nse_session()
    if session is None:
        import httpx
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True,
            headers={**NSE_CHROME_HEADERS, **(headers or {})}
        ) as client:
            return await client.post(url, json=json, data=data)

    def _do_post():
        kw: dict[str, Any] = {"timeout": timeout}
        if json is not None:
            kw["json"] = json
        if data is not None:
            kw["data"] = data
        if headers:
            session.headers.update(headers)
        return session.post(url, **kw)

    return await asyncio.get_event_loop().run_in_executor(None, _do_post)


async def reset_nse_session() -> None:
    """Reset the session (e.g. after auth error or manual cookie refresh)."""
    global _session, _last_cookie_refresh
    async with _session_lock:
        _session = None
        _last_cookie_refresh = 0.0
    logger.info("nse_session_reset")
