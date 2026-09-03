"""
Session warmer for the data-service anti-ban layer.

Keeps a headless Chromium DynamicSession pre-warmed so that the first real
scraping request in each market session doesn't incur browser cold-start
latency or face a stale TLS fingerprint.

The warmer:
  - Runs only during IST market hours (09:00–16:00 IST = 03:30–10:30 UTC).
  - Fires once every 30 minutes while the market window is open.
  - On each warm attempt, loads the NSE option-chain page and checks for a
    successful XHR capture.  If a ban is detected it rotates the proxy,
    resets the session, backs off, and retries — up to 5 times total.
  - After 5 consecutive failures it propagates ``BanError`` to the caller.

**Import hygiene:** ``DynamicSession`` is imported lazily (inside
``_warm_session``) so this module loads cleanly even when Scrapling is not
installed — required for degraded-mode startup.

Requirements: 9.7, 9.8, 9.9
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    from src.anti_ban.ban_detector import BanDetector
    from src.anti_ban.proxy_manager import ProxyManager
    from src.config import Settings

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MARKET_OPEN_UTC_HOUR = 3
_MARKET_OPEN_UTC_MIN = 30
_MARKET_CLOSE_UTC_HOUR = 10
_MARKET_CLOSE_UTC_MIN = 30

WARM_INTERVAL_SECONDS = 30 * 60  # 30 minutes
MAX_BAN_RETRIES = 5

# NSE option-chain page used for warm-up XHR capture
_NSE_OPTION_CHAIN_URL = "https://www.nseindia.com/option-chain"
_NSE_XHR_PATTERN = "api/option-chain"
_WARM_TIMEOUT_SECONDS = 20  # seconds to wait for XHR capture during warm


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class BanError(Exception):
    """Raised when all MAX_BAN_RETRIES warm attempts fail due to ban detection."""


# ---------------------------------------------------------------------------
# Market window helper
# ---------------------------------------------------------------------------


def _is_market_window(now_utc: datetime) -> bool:
    """Return ``True`` when *now_utc* falls within 03:30–10:30 UTC.

    This corresponds to the NSE trading session 09:00–16:00 IST.
    The upper bound is exclusive (10:30 is outside the window).

    Parameters
    ----------
    now_utc:
        A timezone-aware ``datetime`` in UTC.
    """
    open_minutes = _MARKET_OPEN_UTC_HOUR * 60 + _MARKET_OPEN_UTC_MIN   # 210
    close_minutes = _MARKET_CLOSE_UTC_HOUR * 60 + _MARKET_CLOSE_UTC_MIN  # 630
    current_minutes = now_utc.hour * 60 + now_utc.minute
    return open_minutes <= current_minutes < close_minutes


# ---------------------------------------------------------------------------
# SessionWarmer
# ---------------------------------------------------------------------------


class SessionWarmer:
    """Background asyncio task that pre-warms a headless Chromium session.

    Parameters
    ----------
    proxy_manager:
        :class:`~src.anti_ban.proxy_manager.ProxyManager` instance used to
        rotate proxies when a ban is detected during warm-up.
    ban_detector:
        :class:`~src.anti_ban.ban_detector.BanDetector` instance used to
        check warm-up responses for ban signatures.
    settings:
        Application :class:`~src.config.Settings` singleton.

    Usage::

        warmer = SessionWarmer(proxy_manager, ban_detector, settings)
        await warmer.start()
        # … service runs …
        await warmer.stop()
    """

    def __init__(
        self,
        proxy_manager: "ProxyManager",
        ban_detector: "BanDetector",
        settings: "Settings",
    ) -> None:
        self._proxy_manager = proxy_manager
        self._ban_detector = ban_detector
        self._settings = settings

        self._running: bool = False
        self._task: asyncio.Task | None = None

        self._last_warm_at: datetime | None = None
        self._next_warm_at: datetime | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the background warm-loop task."""
        if self._task is not None and not self._task.done():
            logger.warning("session_warmer_already_running")
            return

        self._running = True
        self._task = asyncio.ensure_future(self._warm_loop())
        logger.info("session_warmer_started")

    async def stop(self) -> None:
        """Cancel the background warm-loop task gracefully."""
        self._running = False
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None
        logger.info("session_warmer_stopped")

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def last_warm_at(self) -> datetime | None:
        """UTC datetime of the last *successful* warm, or ``None``."""
        return self._last_warm_at

    @property
    def session_age_seconds(self) -> int | None:
        """Seconds elapsed since the last successful warm, or ``None``."""
        if self._last_warm_at is None:
            return None
        delta = datetime.now(timezone.utc) - self._last_warm_at
        return max(0, int(delta.total_seconds()))

    @property
    def next_warm_at(self) -> datetime | None:
        """Scheduled UTC datetime of the next warm cycle, or ``None``."""
        return self._next_warm_at

    @property
    def running(self) -> bool:
        """``True`` while the warm loop is active."""
        return self._running and self._task is not None and not self._task.done()

    # ------------------------------------------------------------------
    # Internal loop
    # ------------------------------------------------------------------

    async def _warm_loop(self) -> None:
        """Main warm-up loop.

        Fires every 30 minutes, but only warms within IST market hours.
        Outside market hours the loop still sleeps 30 minutes so it wakes
        up and checks again after the next interval.
        """
        while self._running:
            now_utc = datetime.now(timezone.utc)

            if _is_market_window(now_utc):
                logger.info("session_warmer_warming", now_utc=now_utc.isoformat())
                try:
                    await self._warm_session()
                    self._last_warm_at = datetime.now(timezone.utc)
                    logger.info(
                        "session_warmer_success",
                        last_warm_at=self._last_warm_at.isoformat(),
                    )
                except BanError as exc:
                    logger.error(
                        "session_warmer_ban_error",
                        error=str(exc),
                        ban_count=self._ban_detector.ban_count,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.error("session_warmer_unexpected_error", error=str(exc))
            else:
                logger.debug(
                    "session_warmer_outside_market_hours",
                    now_utc=now_utc.isoformat(),
                )

            # Schedule next wake-up
            next_wake = datetime.now(timezone.utc)
            self._next_warm_at = datetime.fromtimestamp(
                next_wake.timestamp() + WARM_INTERVAL_SECONDS,
                tz=timezone.utc,
            )
            await asyncio.sleep(WARM_INTERVAL_SECONDS)

    # ------------------------------------------------------------------
    # Warm session — with ban retry cycle
    # ------------------------------------------------------------------

    async def _warm_session(self) -> None:
        """Load the NSE option-chain page and verify a successful XHR capture.

        Retries up to ``MAX_BAN_RETRIES`` times on ban detection, rotating the
        proxy and backing off between attempts.

        Raises
        ------
        BanError
            When all ``MAX_BAN_RETRIES`` attempts are exhausted.
        """
        # Lazy import — keeps the module loadable when scrapling is absent.
        # Use AsyncDynamicSession — the same class used by live_quotes.py
        # and option_chain.py.  (The old import used the nonexistent
        # AsyncPlayWrightFetcher, so the warmer was silently a no-op.)
        DynamicSession = None
        try:
            import importlib
            _mod = importlib.import_module("scrapling.fetchers")
            DynamicSession = getattr(_mod, "AsyncDynamicSession", None)
        except (ImportError, AttributeError):
            pass

        if DynamicSession is None:
            logger.warning(
                "session_warmer_scrapling_unavailable",
                reason="AsyncDynamicSession not found — scrapling may not be installed",
            )
            return

        last_exc: Exception | None = None

        for attempt in range(1, MAX_BAN_RETRIES + 1):
            proxy = self._proxy_manager.get_proxy()
            try:
                logger.debug(
                    "session_warmer_attempt",
                    attempt=attempt,
                    max_attempts=MAX_BAN_RETRIES,
                    proxy_masked=self._proxy_manager.active_proxy_masked(),
                )

                # AsyncDynamicSession must be entered as a context manager to
                # initialise the underlying Playwright browser before fetch().
                # Each warm attempt gets its own fresh session so a hung or
                # banned browser doesn't poison future attempts.
                # Force IPv4 — Docker returns IPv6 NAT64 addresses first but
                # the container has no real IPv6 egress, so Playwright fails.
                async with DynamicSession(
                    headless=self._settings.scrapling_headless,
                    network_idle=False,
                    proxy=proxy,
                    extra_flags=["--disable-ipv6"],
                    capture_xhr="api/option-chain",
                ) as session:
                    # NSE requires a prior homepage visit to set session cookies
                    # (nsit / nseappid) before any data XHRs fire.  Without this
                    # step the option-chain page loads (HTTP 200) but the
                    # api/option-chain XHR is never intercepted.
                    await asyncio.wait_for(
                        session.fetch(
                            "https://www.nseindia.com",
                            network_idle=False,
                            wait=2000,
                        ),
                        timeout=_WARM_TIMEOUT_SECONDS,
                    )

                    # Fetch with timeout — capture_xhr intercepts the option-chain JSON
                    page = await asyncio.wait_for(
                        session.fetch(
                            _NSE_OPTION_CHAIN_URL,
                            network_idle=False,
                            wait=4000,
                        ),
                        timeout=_WARM_TIMEOUT_SECONDS,
                    )

                    # Verify that the option-chain XHR was actually captured.
                    # If no XHR matched, the warm is not useful — treat as failure.
                    xhr_captured = (
                        hasattr(page, "captured_xhr")
                        and page.captured_xhr
                        and any(
                            _NSE_XHR_PATTERN in getattr(r, "url", "")
                            for r in page.captured_xhr
                        )
                    )

                    # Also check page body for ban signatures
                    response_body = page.get_content() if hasattr(page, "get_content") else ""

                if not xhr_captured:
                    logger.warning(
                        "session_warmer_no_xhr_captured",
                        attempt=attempt,
                        pattern=_NSE_XHR_PATTERN,
                    )
                    last_exc = RuntimeError(
                        f"Warm attempt {attempt}: option-chain XHR not captured"
                    )
                    if attempt < MAX_BAN_RETRIES:
                        await asyncio.sleep(self._settings.ban_backoff_seconds)
                    continue

                # Check page content — empty string is safe for ban detector
                if self._ban_detector.is_banned(response_body):
                    logger.warning(
                        "session_warmer_ban_detected",
                        attempt=attempt,
                        ban_count=self._ban_detector.ban_count,
                    )
                    last_exc = BanError(f"Ban detected on warm attempt {attempt}")
                    await self._handle_ban_backoff()
                    continue

                # Success — warm complete.
                # Phase 44 fix: after a successful warm, also reset the production
                # singleton sessions so they pick up fresh cookies/TLS fingerprints.
                # The generation number prevents races between old/new sessions.
                await self._refresh_production_sessions()
                logger.debug("session_warmer_attempt_success", attempt=attempt)
                return

            except asyncio.TimeoutError as exc:
                logger.warning(
                    "session_warmer_timeout",
                    attempt=attempt,
                    timeout=_WARM_TIMEOUT_SECONDS,
                )
                last_exc = exc
                if attempt < MAX_BAN_RETRIES:
                    await self._handle_ban_backoff()

            except asyncio.CancelledError:
                raise

            except Exception as exc:
                logger.warning(
                    "session_warmer_fetch_error",
                    attempt=attempt,
                    error=str(exc),
                )
                last_exc = exc
                # Non-ban errors also back off before retry
                if attempt < MAX_BAN_RETRIES:
                    await asyncio.sleep(self._settings.ban_backoff_seconds)

        raise BanError(
            f"Session warm failed after {MAX_BAN_RETRIES} attempts. "
            f"Last error: {last_exc}"
        )

    async def _handle_ban_backoff(self) -> None:
        """Rotate proxy, then sleep for ``ban_backoff_seconds``."""
        self._proxy_manager.rotate()
        logger.info(
            "session_warmer_backing_off",
            backoff_seconds=self._settings.ban_backoff_seconds,
            new_proxy_masked=self._proxy_manager.active_proxy_masked(),
        )
        await asyncio.sleep(self._settings.ban_backoff_seconds)

    async def _refresh_production_sessions(self) -> None:
        """Phase 44 fix: reset the production singleton sessions after a successful warm.

        The previous implementation kept a separate ephemeral browser for warming
        that never refreshed the production singletons. This fix ensures that after
        a successful warm the actual scrapers get fresh sessions.

        A generation number prevents races: the old session is closed only after
        the new one is ready, and only if no requests are in flight.
        """
        try:
            from src.scrapers.live_quotes import reset_quote_session  # noqa: PLC0415
            from src.scrapers.option_chain import reset_chain_session  # noqa: PLC0415

            # Reset sessions — the next request will lazily create a new session
            # with the current proxy and fresh TLS fingerprint.
            # reset_*_session() uses an asyncio.Lock so concurrent fetch() calls
            # are not interrupted mid-request.
            await reset_quote_session()
            await reset_chain_session()
            logger.info("session_warmer_production_sessions_refreshed")
        except Exception as exc:
            # Non-fatal — warm succeeded even if refresh fails
            logger.warning(
                "session_warmer_production_refresh_failed",
                error=str(exc),
            )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_session_warmer(
    proxy_manager: "ProxyManager",
    ban_detector: "BanDetector",
    settings: "Settings",
) -> SessionWarmer:
    """Create and return a :class:`SessionWarmer` instance.

    Parameters
    ----------
    proxy_manager:
        Proxy pool manager for rotation on ban detection.
    ban_detector:
        Ban detection engine.
    settings:
        Application settings (reads ``ban_backoff_seconds``, ``scrapling_headless``).

    Returns
    -------
    SessionWarmer
        A new, not-yet-started warmer.  Call ``await warmer.start()`` to begin.
    """
    return SessionWarmer(
        proxy_manager=proxy_manager,
        ban_detector=ban_detector,
        settings=settings,
    )
