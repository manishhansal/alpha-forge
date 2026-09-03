"""
Security hardening — Phases 91-92.

Phase 91: SSRF prevention, input validation, resource protection.
Phase 92: Resource limits (max symbols, max date range, max response size).

Key protections:
- SSRF: only whitelisted URLs are ever fetched
- Symbol injection: validated against safe pattern before use in URLs
- Date range limits enforced
- Concurrent request semaphores
"""

from __future__ import annotations

import asyncio
import re
from datetime import date
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Resource limits
# ---------------------------------------------------------------------------

MAX_SYMBOLS_PER_REQUEST = 200
MAX_DATE_RANGE_DAILY_DAYS = 1825       # 5 years
MAX_DATE_RANGE_INTRADAY_DAYS = 365     # 1 year
MAX_OPTION_CHAIN_STRIKES = 1000        # upper bound for parsing
MAX_RESPONSE_BODY_MB = 10
MAX_CONCURRENT_BROWSER_REQUESTS = 1   # serialized — one Playwright session

# Semaphores for resource control
_browser_semaphore = asyncio.Semaphore(MAX_CONCURRENT_BROWSER_REQUESTS)

# ---------------------------------------------------------------------------
# SSRF protection — allowed external domains
# ---------------------------------------------------------------------------

_ALLOWED_DOMAINS: frozenset[str] = frozenset({
    "www.nseindia.com",
    "nsearchives.nseindia.com",
    "charting.nseindia.com",
    "www.bseindia.com",
    "api.bseindia.com",
    "www1.nseindia.com",
    "idbrt.nseindia.com",
})

# Valid symbol pattern: letters, digits, &, -, . only; max 30 chars
_SAFE_SYMBOL_RE = re.compile(r"^[A-Z0-9&\-\.]{1,30}$")

# Valid date string pattern
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T[\d:\.Z+\-]*)?$")


def is_allowed_url(url: str) -> bool:
    """Return True when the URL targets an allowed domain.

    Prevents SSRF attacks from user-controlled URL parameters.
    """
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        return parsed.netloc in _ALLOWED_DOMAINS
    except Exception:
        return False


def validate_symbol(symbol: str) -> tuple[bool, str]:
    """Validate a symbol for safe use in API URLs.

    Returns (is_valid, cleaned_symbol or error_message).
    """
    if not symbol:
        return False, "empty symbol"
    cleaned = symbol.strip().upper()
    if not _SAFE_SYMBOL_RE.match(cleaned):
        logger.warning("symbol_validation_failed", symbol=symbol)
        return False, f"invalid symbol format: '{symbol}'"
    return True, cleaned


def validate_date_string(value: str, param_name: str) -> tuple[bool, str]:
    """Validate a date string for safe parsing."""
    if not value:
        return False, f"{param_name} is required"
    if not _ISO_DATE_RE.match(value.strip()):
        return False, f"{param_name} must be ISO 8601 date (got: '{value}')"
    return True, value.strip()


def validate_date_range(
    from_date: date,
    to_date: date,
    interval: str,
) -> tuple[bool, str]:
    """Validate a date range is within allowed limits."""
    if from_date > to_date:
        return False, f"from ({from_date}) must not be after to ({to_date})"

    span_days = (to_date - from_date).days
    if interval == "1d" and span_days > MAX_DATE_RANGE_DAILY_DAYS:
        return False, f"max range for 1d is {MAX_DATE_RANGE_DAILY_DAYS} days"
    if interval != "1d" and span_days > MAX_DATE_RANGE_INTRADAY_DAYS:
        return False, f"max range for {interval} is {MAX_DATE_RANGE_INTRADAY_DAYS} days"

    return True, "ok"


def validate_symbols_list(symbols: list[str]) -> tuple[list[str], list[str]]:
    """Validate and clean a list of symbols.

    Returns (valid_symbols, rejected_symbols).
    """
    valid = []
    rejected = []
    for sym in symbols:
        ok, cleaned_or_error = validate_symbol(sym)
        if ok:
            valid.append(cleaned_or_error)
        else:
            rejected.append(sym)
    return valid, rejected
