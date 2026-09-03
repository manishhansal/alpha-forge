"""
Ban detector for the data-service anti-ban layer.

Detects three NSE/BSE ban patterns:
  - ShadowBan: empty records.data during market hours (NSE 200 OK but no data)
  - AkamaiChallenge: Akamai bot-check JavaScript fingerprint in response body
  - RateLimit: upstream "Too Many Requests" plain-text response

Requirements: 9.4, 9.5, 9.6
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from enum import Enum
from typing import Union


# ---------------------------------------------------------------------------
# Market hours helper
# ---------------------------------------------------------------------------

_MARKET_OPEN_UTC_HOUR = 3
_MARKET_OPEN_UTC_MIN = 30
_MARKET_CLOSE_UTC_HOUR = 10
_MARKET_CLOSE_UTC_MIN = 30


def _is_market_hours_ist() -> bool:
    """Return True when the current UTC time falls within IST market hours.

    NSE trading session is 09:00–16:00 IST which equals 03:30–10:30 UTC.
    A shadow-ban (empty records) is only meaningful inside this window;
    outside market hours an empty response is expected.

    A 15-minute grace period is applied at the start of the session
    (03:30–03:45 UTC = 09:00–09:15 IST) because NSE exchange systems
    often return empty records while warming up, which would otherwise
    trigger false-positive ban detections at every market open.
    """
    now = datetime.now(timezone.utc)
    open_minutes = _MARKET_OPEN_UTC_HOUR * 60 + _MARKET_OPEN_UTC_MIN       # 210 (03:30)
    grace_minutes = open_minutes + 15                                        # 225 (03:45)
    close_minutes = _MARKET_CLOSE_UTC_HOUR * 60 + _MARKET_CLOSE_UTC_MIN    # 630 (10:30)
    current_minutes = now.hour * 60 + now.minute
    # Enforce the grace period: only trigger after 03:45 UTC
    return grace_minutes <= current_minutes < close_minutes


# ---------------------------------------------------------------------------
# Ban type enum
# ---------------------------------------------------------------------------

class BanType(Enum):
    """Enumeration of recognisable ban / challenge response types."""
    SHADOW_BAN = "shadow_ban"
    AKAMAI_CHALLENGE = "akamai_challenge"
    RATE_LIMIT = "rate_limit"


# ---------------------------------------------------------------------------
# Detection patterns (Protocol-compatible classes)
# ---------------------------------------------------------------------------

class ShadowBanPattern:
    """NSE returns HTTP 200 with an empty ``records.data`` list during a shadow-ban.

    Only triggered inside IST market hours (03:30–10:30 UTC) because an empty
    payload is perfectly normal outside trading hours.
    """

    ban_type = BanType.SHADOW_BAN

    def matches(self, body: Union[str, dict]) -> bool:  # noqa: UP007
        if not isinstance(body, dict):
            return False
        data = body.get("records", {}).get("data")
        return data == [] and _is_market_hours_ist()


class AkamaiChallengePattern:
    """Akamai anti-bot challenge page embeds a JavaScript identifier ``window._atsb``.

    When NSE is protected by Akamai's bot manager the scraper receives a
    challenge HTML page instead of JSON; this identifier uniquely marks it.
    """

    ban_type = BanType.AKAMAI_CHALLENGE

    def matches(self, body: Union[str, dict]) -> bool:  # noqa: UP007
        return isinstance(body, str) and "window._atsb" in body


class RateLimitPattern:
    """Upstream rate-limit plain-text response."""

    ban_type = BanType.RATE_LIMIT

    def matches(self, body: Union[str, dict]) -> bool:  # noqa: UP007
        return isinstance(body, str) and "Too Many Requests" in body


# ---------------------------------------------------------------------------
# BanDetector
# ---------------------------------------------------------------------------

class BanDetector:
    """Composite ban detector that checks all three patterns in order.

    Thread-safe: ``_ban_count`` is protected by a ``threading.Lock`` so the
    service can safely increment the counter from concurrent request handlers.

    Usage::

        from data_service.anti_ban.ban_detector import ban_detector

        if ban_detector.is_banned(response_body):
            # rotate proxy, reset session, back off …
    """

    def __init__(self) -> None:
        self._patterns = [
            ShadowBanPattern(),
            AkamaiChallengePattern(),
            RateLimitPattern(),
        ]
        self._ban_count: int = 0
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def is_banned(self, body: Union[str, dict]) -> bool:  # noqa: UP007
        """Return ``True`` if *any* pattern matches the response body.

        Also calls :meth:`increment_ban_count` when a ban is detected so that
        callers don't need to track this separately.
        """
        for pattern in self._patterns:
            if pattern.matches(body):
                self._increment_ban_count()
                return True
        return False

    def ban_type(self, body: Union[str, dict]) -> BanType | None:  # noqa: UP007
        """Return the :class:`BanType` for the first matching pattern, or ``None``."""
        for pattern in self._patterns:
            if pattern.matches(body):
                return pattern.ban_type
        return None

    @property
    def ban_count(self) -> int:
        """Cumulative count of detected ban events since service start."""
        with self._lock:
            return self._ban_count

    def increment_ban_count(self) -> None:
        """Explicitly increment the ban counter.

        Exposed as a public method so the ban-response cycle in other
        components (e.g. :class:`SessionWarmer`) can record a ban event even
        when they handle detection themselves.
        """
        self._increment_ban_count()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _increment_ban_count(self) -> None:
        with self._lock:
            self._ban_count += 1


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

ban_detector = BanDetector()
