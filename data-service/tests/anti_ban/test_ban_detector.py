"""
Unit tests for BanDetector and its three detection patterns.

Requirements: 9.4, 9.5, 9.6
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from src.anti_ban.ban_detector import BanDetector


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fresh() -> BanDetector:
    """Return a new BanDetector with ban_count reset to zero."""
    return BanDetector()


# ---------------------------------------------------------------------------
# AkamaiChallengePattern
# ---------------------------------------------------------------------------


def test_akamai_pattern_triggers_when_window_atsb_in_body() -> None:
    """is_banned returns True when 'window._atsb' appears anywhere in the body."""
    detector = _fresh()
    assert detector.is_banned("prefix window._atsb suffix") is True


def test_akamai_pattern_triggers_on_exact_token() -> None:
    """is_banned returns True for the minimal Akamai challenge string."""
    detector = _fresh()
    assert detector.is_banned("window._atsb") is True


def test_akamai_pattern_does_not_trigger_on_substring_mismatch() -> None:
    """is_banned returns False when '_atsb' appears without 'window.' prefix."""
    detector = _fresh()
    assert detector.is_banned("_atsb detected") is False


# ---------------------------------------------------------------------------
# RateLimitPattern
# ---------------------------------------------------------------------------


def test_rate_limit_pattern_triggers_when_too_many_requests() -> None:
    """is_banned returns True when body contains 'Too Many Requests'."""
    detector = _fresh()
    assert detector.is_banned("Too Many Requests") is True


def test_rate_limit_pattern_triggers_embedded_in_longer_body() -> None:
    """is_banned returns True when 'Too Many Requests' appears mid-string."""
    detector = _fresh()
    assert detector.is_banned("HTTP 429: Too Many Requests — please slow down") is True


# ---------------------------------------------------------------------------
# ShadowBanPattern
# ---------------------------------------------------------------------------


def test_shadow_ban_triggers_during_market_hours() -> None:
    """is_banned returns True for empty records.data dict during market hours."""
    detector = _fresh()
    body = {"records": {"data": []}}
    with patch(
        "src.anti_ban.ban_detector._is_market_hours_ist", return_value=True
    ):
        assert detector.is_banned(body) is True


def test_shadow_ban_does_not_trigger_outside_market_hours() -> None:
    """is_banned returns False for empty records.data dict outside market hours."""
    detector = _fresh()
    body = {"records": {"data": []}}
    with patch(
        "src.anti_ban.ban_detector._is_market_hours_ist", return_value=False
    ):
        assert detector.is_banned(body) is False


def test_shadow_ban_does_not_trigger_when_data_is_non_empty() -> None:
    """is_banned returns False when records.data has entries, even during market hours."""
    detector = _fresh()
    body = {"records": {"data": [{"symbol": "NIFTY"}]}}
    with patch(
        "src.anti_ban.ban_detector._is_market_hours_ist", return_value=True
    ):
        assert detector.is_banned(body) is False


def test_shadow_ban_does_not_trigger_on_non_dict_body() -> None:
    """is_banned returns False when body is a string (shadow-ban requires dict)."""
    detector = _fresh()
    with patch(
        "src.anti_ban.ban_detector._is_market_hours_ist", return_value=True
    ):
        assert detector.is_banned("[]") is False


# ---------------------------------------------------------------------------
# Non-matching body
# ---------------------------------------------------------------------------


def test_non_matching_body_returns_false() -> None:
    """is_banned returns False for an ordinary successful response string."""
    detector = _fresh()
    assert detector.is_banned("normal response") is False


def test_non_matching_dict_body_returns_false() -> None:
    """is_banned returns False for a normal dict response with non-empty data."""
    detector = _fresh()
    body = {"status": "OK", "data": [1, 2, 3]}
    with patch(
        "src.anti_ban.ban_detector._is_market_hours_ist", return_value=True
    ):
        assert detector.is_banned(body) is False


# ---------------------------------------------------------------------------
# ban_count tracking
# ---------------------------------------------------------------------------


def test_ban_count_increments_on_detection() -> None:
    """ban_count advances from 0 → 1 → 2 across consecutive detected bans."""
    detector = _fresh()
    assert detector.ban_count == 0

    # First detection (Akamai challenge)
    detector.is_banned("window._atsb")
    assert detector.ban_count == 1

    # Second detection (rate limit)
    detector.is_banned("Too Many Requests")
    assert detector.ban_count == 2


def test_ban_count_does_not_increment_on_non_match() -> None:
    """ban_count stays 0 when no ban pattern matches."""
    detector = _fresh()
    detector.is_banned("hello world")
    detector.is_banned({"records": {"data": [1, 2]}})
    assert detector.ban_count == 0


def test_explicit_increment_ban_count_increments_counter() -> None:
    """increment_ban_count() directly increments the counter without a detection call."""
    detector = _fresh()
    detector.increment_ban_count()
    detector.increment_ban_count()
    assert detector.ban_count == 2


def test_ban_count_is_independent_across_instances() -> None:
    """Each BanDetector instance maintains its own counter."""
    a = _fresh()
    b = _fresh()
    a.is_banned("window._atsb")
    assert a.ban_count == 1
    assert b.ban_count == 0
