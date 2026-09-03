"""
data-service configuration.

All runtime parameters are read from environment variables at import time.
A module-level `settings` singleton is created so the rest of the service
can do `from src.config import settings`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields

import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Default symbol list — top-20 NSE F&O names
# ---------------------------------------------------------------------------
_DEFAULT_SYMBOLS: list[str] = [
    "NIFTY",
    "BANKNIFTY",
    "FINNIFTY",
    "MIDCPNIFTY",
    "RELIANCE",
    "HDFCBANK",
    "ICICIBANK",
    "TCS",
    "INFY",
    "HINDUNILVR",
    "ITC",
    "SBIN",
    "BAJFINANCE",
    "WIPRO",
    "AXISBANK",
    "MARUTI",
    "ASIANPAINT",
    "NTPC",
    "POWERGRID",
    "ULTRACEMCO",
]


def _bool_env(name: str, default: bool) -> bool:
    """Read an env var as a boolean ('true'/'1'/'yes' → True, everything else → False)."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("true", "1", "yes")


def _int_env(name: str, default: int, min_val: int | None = None, max_val: int | None = None) -> int:
    """Read an env var as an int, optionally clamped to [min_val, max_val]."""
    raw = os.getenv(name)
    try:
        value = int(raw) if raw is not None else default
    except ValueError:
        logger.warning("config_parse_error", env_var=name, raw_value=raw, fallback=default)
        value = default
    if min_val is not None:
        value = max(min_val, value)
    if max_val is not None:
        value = min(max_val, value)
    return value


def _str_list_env(name: str, default: list[str], sep: str = ",") -> list[str]:
    """Read an env var as a list of strings split by *sep*, stripping whitespace."""
    raw = os.getenv(name)
    if not raw or not raw.strip():
        return default
    return [s.strip() for s in raw.split(sep) if s.strip()]


@dataclass(frozen=True)
class Settings:
    # -------------------------------------------------------------------
    # Network
    # -------------------------------------------------------------------
    port: int = field(default_factory=lambda: _int_env("DATA_SERVICE_PORT", 8200))
    redis_url: str = field(default_factory=lambda: os.getenv("REDIS_URL", "redis://redis:6379/0"))

    # -------------------------------------------------------------------
    # Scrapling / browser
    # -------------------------------------------------------------------
    scrapling_headless: bool = field(default_factory=lambda: _bool_env("SCRAPLING_HEADLESS", True))
    scrapling_proxy_url: str | None = field(default_factory=lambda: os.getenv("SCRAPLING_PROXY_URL") or None)
    scrapling_proxy_list: list[str] = field(
        default_factory=lambda: _str_list_env("SCRAPLING_PROXY_LIST", [], sep="\n")
    )

    # -------------------------------------------------------------------
    # Anti-ban / rate limiting
    # -------------------------------------------------------------------
    nse_rate_limit: int = field(
        default_factory=lambda: _int_env("NSE_RATE_LIMIT", 3, min_val=1, max_val=20)
    )
    bse_rate_limit: int = field(
        default_factory=lambda: _int_env("BSE_RATE_LIMIT", 2, min_val=1, max_val=20)
    )
    ban_backoff_seconds: int = field(
        default_factory=lambda: _int_env("BAN_BACKOFF_SECONDS", 60, min_val=1, max_val=3600)
    )

    # -------------------------------------------------------------------
    # Storage
    # -------------------------------------------------------------------
    data_dir: str = field(default_factory=lambda: os.getenv("DATA_DIR", "/app/data"))

    # -------------------------------------------------------------------
    # Default tracked symbols
    # -------------------------------------------------------------------
    symbols: list[str] = field(
        default_factory=lambda: _str_list_env("DATA_SERVICE_SYMBOLS", _DEFAULT_SYMBOLS, sep=",")
    )

    def __post_init__(self) -> None:
        """Log every resolved parameter value using structlog."""
        log = logger.bind(event="config_resolved")
        for f in fields(self):
            value = getattr(self, f.name)
            # Mask proxy credentials in log output; display everything else as-is.
            display = "***" if ("proxy" in f.name and value) else value
            log = log.bind(**{f.name: display})
        log.info("data-service configuration loaded")


# ---------------------------------------------------------------------------
# Module-level singleton — import with:
#   from src.config import settings
# ---------------------------------------------------------------------------
settings = Settings()
