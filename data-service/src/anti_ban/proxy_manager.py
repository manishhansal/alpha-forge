"""
Anti-ban proxy manager.

Manages a pool of proxy URLs with cyclic rotation. Does NOT import scrapling's
ProxyRotator — pool management is done with a plain index counter. The proxy URL
is passed to DynamicSession / FetcherSession by the caller; this module only
tracks which proxy is active and how many rotations have occurred.

Usage:
    from src.anti_ban.proxy_manager import create_proxy_manager
    from src.config import settings

    proxy_mgr = create_proxy_manager(settings)

    # Get current proxy (or None when no proxy configured)
    proxy_url = proxy_mgr.get_proxy()

    # After a ban is detected, rotate to the next proxy
    proxy_mgr.rotate()

    # For monitoring endpoints — never log raw credentials
    print(proxy_mgr.active_proxy_masked())  # "http://***@proxy.example.com:8080"
"""

from __future__ import annotations

import re
import threading
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    from src.config import Settings

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Credential-masking regex
# ---------------------------------------------------------------------------
# Matches: scheme://user:password@host:port  OR  scheme://user@host:port
_CREDENTIALS_RE = re.compile(
    r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+\-.]*)"  # e.g. "http", "socks5"
    r"://"
    r"(?P<creds>[^@]+)"                       # user or user:pass — everything before @
    r"@"
    r"(?P<hostport>.+)",                      # host:port (rest of URL)
)


def _mask_proxy_url(url: str) -> str:
    """Return *url* with user/password replaced by ``***``.

    Examples
    --------
    >>> _mask_proxy_url("http://user:secret@proxy.host:8080")
    'http://***@proxy.host:8080'
    >>> _mask_proxy_url("socks5://token@proxy.host:1080")
    'socks5://***@proxy.host:1080'
    >>> _mask_proxy_url("http://proxy.host:8080")  # no credentials
    'http://proxy.host:8080'
    """
    m = _CREDENTIALS_RE.fullmatch(url.strip())
    if m:
        return f"{m.group('scheme')}://***@{m.group('hostport')}"
    return url  # no credentials present — return as-is


# ---------------------------------------------------------------------------
# ProxyManager
# ---------------------------------------------------------------------------

class ProxyManager:
    """Cyclic proxy pool manager.

    Thread-safe via a ``threading.Lock`` (the service uses asyncio but
    blocking calls may happen on executor threads so a lock is safer
    than a raw counter).
    """

    def __init__(
        self,
        proxy_url: str | None,
        proxy_list: list[str],
    ) -> None:
        # Build pool: proxy_list takes precedence over the single proxy_url
        if proxy_list:
            self._pool: list[str] = [p.strip() for p in proxy_list if p.strip()]
        elif proxy_url and proxy_url.strip():
            self._pool = [proxy_url.strip()]
        else:
            self._pool = []

        self._index: int = 0
        self._rotation_count: int = 0
        self._lock = threading.Lock()

        logger.info(
            "proxy_manager_initialized",
            pool_size=len(self._pool),
            has_proxy=bool(self._pool),
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def _masked_unlocked(self) -> str | None:
        """Return the masked proxy URL — caller MUST already hold ``self._lock``."""
        if not self._pool:
            return None
        return _mask_proxy_url(self._pool[self._index])

    def rotate(self) -> None:
        """Advance to the next proxy in the pool (cyclic).

        No-op when the pool is empty.
        """
        with self._lock:
            if not self._pool:
                return
            self._index = (self._index + 1) % len(self._pool)
            self._rotation_count += 1
            logger.debug(
                "proxy_rotated",
                rotation_count=self._rotation_count,
                new_index=self._index,
                active_masked=self._masked_unlocked(),
            )

    def get_proxy(self) -> str | None:
        """Return the active proxy URL (raw, with credentials), or ``None``."""
        with self._lock:
            if not self._pool:
                return None
            return self._pool[self._index]

    def active_proxy_masked(self) -> str | None:
        """Return the active proxy URL with credentials replaced by ``***``.

        Format: ``scheme://***@host:port``.
        Returns ``None`` when no proxy is configured.
        """
        with self._lock:
            if not self._pool:
                return None
            return _mask_proxy_url(self._pool[self._index])

    @property
    def pool_size(self) -> int:
        """Number of proxies in the pool (0 when no proxy configured)."""
        return len(self._pool)

    @property
    def rotation_count(self) -> int:
        """Total number of times :meth:`rotate` has been called."""
        with self._lock:
            return self._rotation_count


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_proxy_manager(settings: "Settings") -> ProxyManager:
    """Create a :class:`ProxyManager` from application settings.

    Reads ``settings.scrapling_proxy_list`` (takes precedence) and
    ``settings.scrapling_proxy_url`` (single-proxy fallback).
    """
    return ProxyManager(
        proxy_url=settings.scrapling_proxy_url,
        proxy_list=list(settings.scrapling_proxy_list),
    )
