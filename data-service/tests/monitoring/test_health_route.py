"""
Unit tests for monitoring endpoints.

Covers:
  - GET /monitoring/health   — request_count, ban_count, cache_hit_rate, uptime_seconds
  - GET /monitoring/scraping-stats — per-endpoint stats; null for endpoints with no requests
  - GET /monitoring/proxy-status  — pool_size, rotation_count, active_proxy
  - GET /monitoring/session-status — null fields when no warm has occurred
  - Service-initializing gate     — 503 on all /monitoring/* when not yet ready

Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import src.monitoring.router as _mon
from src.anti_ban.ban_detector import BanDetector


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NOT_READY_BODY = {"available": False, "reason": "service not yet ready"}

_ALL_MONITORING_PATHS = [
    "/monitoring/health",
    "/monitoring/scraping-stats",
    "/monitoring/proxy-status",
    "/monitoring/session-status",
]


def _mark_ready() -> None:
    """Flip the module-level initialized flag to True."""
    _mon.mark_service_initialized()


def _fresh_ban_detector() -> BanDetector:
    """Return a brand-new BanDetector with ban_count == 0."""
    return BanDetector()


# ---------------------------------------------------------------------------
# Service-initializing gate (Requirement 10.6)
# ---------------------------------------------------------------------------


class TestServiceInitializingGate:
    """All /monitoring/* routes must return 503 while the service is initialising."""

    def test_health_returns_503_when_not_initialized(self, test_client) -> None:
        # test_client fixture resets _service_initialized to False
        resp = test_client.get("/monitoring/health")
        assert resp.status_code == 503
        assert resp.json() == _NOT_READY_BODY

    def test_scraping_stats_returns_503_when_not_initialized(self, test_client) -> None:
        resp = test_client.get("/monitoring/scraping-stats")
        assert resp.status_code == 503
        assert resp.json() == _NOT_READY_BODY

    def test_proxy_status_returns_503_when_not_initialized(self, test_client) -> None:
        resp = test_client.get("/monitoring/proxy-status")
        assert resp.status_code == 503
        assert resp.json() == _NOT_READY_BODY

    def test_session_status_returns_503_when_not_initialized(self, test_client) -> None:
        resp = test_client.get("/monitoring/session-status")
        assert resp.status_code == 503
        assert resp.json() == _NOT_READY_BODY

    @pytest.mark.parametrize("path", _ALL_MONITORING_PATHS)
    def test_all_monitoring_paths_503_when_not_initialized(
        self, test_client, path: str
    ) -> None:
        resp = test_client.get(path)
        assert resp.status_code == 503
        assert resp.json()["available"] is False
        assert "reason" in resp.json()


# ---------------------------------------------------------------------------
# GET /monitoring/health (Requirement 10.1)
# ---------------------------------------------------------------------------


class TestMonitoringHealth:
    """Verify the /monitoring/health response shape and field contracts."""

    def test_health_returns_200_when_initialized(self, test_client) -> None:
        _mark_ready()
        resp = test_client.get("/monitoring/health")
        assert resp.status_code == 200

    def test_health_response_contains_all_required_fields(self, test_client) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/health").json()

        for field in ("request_count", "ban_count", "cache_hit_rate", "uptime_seconds"):
            assert field in body, f"Missing field: {field}"

    def test_request_count_is_non_negative_integer(self, test_client) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/health").json()
        assert isinstance(body["request_count"], int)
        assert body["request_count"] >= 0

    def test_ban_count_is_non_negative_integer(self, test_client) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/health").json()
        assert isinstance(body["ban_count"], int)
        assert body["ban_count"] >= 0

    def test_cache_hit_rate_is_float_in_valid_range(self, test_client) -> None:
        """cache_hit_rate must be a float in [0.0, 1.0] rounded to 4 dp."""
        _mark_ready()
        body = test_client.get("/monitoring/health").json()
        rate = body["cache_hit_rate"]
        assert isinstance(rate, (int, float))
        assert 0.0 <= rate <= 1.0
        # Must be rounded to at most 4 decimal places
        assert rate == round(rate, 4)

    def test_uptime_seconds_is_non_negative_integer(self, test_client) -> None:
        """uptime_seconds must be a non-negative integer."""
        _mark_ready()
        body = test_client.get("/monitoring/health").json()
        assert isinstance(body["uptime_seconds"], int)
        assert body["uptime_seconds"] >= 0

    def test_cache_hit_rate_zero_when_no_lookups(self, test_client) -> None:
        """cache_hit_rate should be 0.0 when no cache lookups have been recorded."""
        _mark_ready()
        # Replace the rolling_stats singleton temporarily so we start clean
        fresh_stats = _mon.RollingWindowStats()
        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/health").json()
            assert body["cache_hit_rate"] == 0.0


# ---------------------------------------------------------------------------
# ban_count increments after BanDetector events (Requirement 10.5)
# ---------------------------------------------------------------------------


class TestBanCountIncrement:
    """ban_count in /monitoring/health must reflect ban events from BanDetector."""

    def test_ban_count_increments_after_two_detections(self, test_client) -> None:
        """After two is_banned() calls that match, ban_count must be >= 2."""
        _mark_ready()

        # Use a fresh detector so other tests don't bleed state.
        # The route handler does `from src.anti_ban.ban_detector import ban_detector`
        # inside the function body, so we patch the singleton in its home module.
        detector = _fresh_ban_detector()
        detector.is_banned("window._atsb")
        detector.is_banned("window._atsb")
        assert detector.ban_count == 2

        with patch("src.anti_ban.ban_detector.ban_detector", detector):
            body = test_client.get("/monitoring/health").json()
            assert body["ban_count"] == 2

    def test_ban_count_is_zero_when_no_bans_detected(self, test_client) -> None:
        """ban_count must be 0 when no ban events have occurred on a fresh detector."""
        _mark_ready()

        detector = _fresh_ban_detector()
        with patch("src.anti_ban.ban_detector.ban_detector", detector):
            body = test_client.get("/monitoring/health").json()
            assert body["ban_count"] == 0

    def test_ban_count_increments_correctly_for_each_event(
        self, test_client
    ) -> None:
        """Each individual ban detection advances ban_count by exactly 1."""
        _mark_ready()

        detector = _fresh_ban_detector()
        with patch("src.anti_ban.ban_detector.ban_detector", detector):
            # First ban
            detector.is_banned("window._atsb")
            body = test_client.get("/monitoring/health").json()
            assert body["ban_count"] == 1

            # Second ban
            detector.is_banned("Too Many Requests")
            body = test_client.get("/monitoring/health").json()
            assert body["ban_count"] == 2


# ---------------------------------------------------------------------------
# GET /monitoring/scraping-stats (Requirement 10.2)
# ---------------------------------------------------------------------------


class TestMonitoringScrapingStats:
    """Verify scraping-stats structure and null behaviour."""

    def test_scraping_stats_returns_200_when_initialized(self, test_client) -> None:
        _mark_ready()
        resp = test_client.get("/monitoring/scraping-stats")
        assert resp.status_code == 200

    def test_scraping_stats_contains_endpoints_key(self, test_client) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/scraping-stats").json()
        assert "endpoints" in body

    def test_scraping_stats_endpoints_is_dict(self, test_client) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/scraping-stats").json()
        assert isinstance(body["endpoints"], dict)

    def test_scraping_stats_all_known_endpoints_present(self, test_client) -> None:
        """All KNOWN_ENDPOINTS must appear as keys in the response."""
        _mark_ready()
        body = test_client.get("/monitoring/scraping-stats").json()
        endpoints = body["endpoints"]
        for ep in _mon.RollingWindowStats.KNOWN_ENDPOINTS:
            assert ep in endpoints, f"Missing endpoint key: {ep}"

    def test_scraping_stats_returns_null_for_endpoints_with_no_requests(
        self, test_client
    ) -> None:
        """Endpoints with no requests in the 3600s window must map to null."""
        _mark_ready()
        fresh_stats = _mon.RollingWindowStats()
        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/scraping-stats").json()
            endpoints = body["endpoints"]
            for ep in _mon.RollingWindowStats.KNOWN_ENDPOINTS:
                assert endpoints[ep] is None, f"Expected null for {ep}, got {endpoints[ep]}"

    def test_scraping_stats_non_null_entry_has_correct_shape(
        self, test_client
    ) -> None:
        """When an endpoint has recorded requests its entry must have p50_ms, p99_ms, success_rate."""
        _mark_ready()
        fresh_stats = _mon.RollingWindowStats()
        fresh_stats.record("/monitoring/health", duration_ms=120, success=True)
        fresh_stats.record("/monitoring/health", duration_ms=200, success=True)

        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/scraping-stats").json()
            entry = body["endpoints"]["/monitoring/health"]
            assert entry is not None
            assert "p50_ms" in entry
            assert "p99_ms" in entry
            assert "success_rate" in entry

    def test_scraping_stats_success_rate_in_valid_range(self, test_client) -> None:
        """success_rate in any non-null entry must be in [0.0, 1.0] rounded to 4 dp."""
        _mark_ready()
        fresh_stats = _mon.RollingWindowStats()
        fresh_stats.record("/monitoring/health", duration_ms=100, success=True)
        fresh_stats.record("/monitoring/health", duration_ms=150, success=False)

        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/scraping-stats").json()
            rate = body["endpoints"]["/monitoring/health"]["success_rate"]
            assert 0.0 <= rate <= 1.0
            assert rate == round(rate, 4)

    def test_scraping_stats_p50_and_p99_are_non_negative_ints(
        self, test_client
    ) -> None:
        """p50_ms and p99_ms must be non-negative integers."""
        _mark_ready()
        fresh_stats = _mon.RollingWindowStats()
        for i in range(10):
            fresh_stats.record("/monitoring/health", duration_ms=i * 10, success=True)

        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/scraping-stats").json()
            entry = body["endpoints"]["/monitoring/health"]
            assert isinstance(entry["p50_ms"], int)
            assert isinstance(entry["p99_ms"], int)
            assert entry["p50_ms"] >= 0
            assert entry["p99_ms"] >= 0


# ---------------------------------------------------------------------------
# GET /monitoring/proxy-status (Requirement 10.3)
# ---------------------------------------------------------------------------


class TestMonitoringProxyStatus:
    """Verify proxy-status response structure."""

    def test_proxy_status_returns_200_when_initialized(self, test_client) -> None:
        _mark_ready()
        resp = test_client.get("/monitoring/proxy-status")
        assert resp.status_code == 200

    def test_proxy_status_contains_all_required_fields(self, test_client) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/proxy-status").json()
        for field in ("pool_size", "rotation_count", "active_proxy"):
            assert field in body, f"Missing field: {field}"

    def test_proxy_status_defaults_when_no_proxy_manager(self, test_client) -> None:
        """When no ProxyManager is injected, pool_size and rotation_count must be 0."""
        _mark_ready()
        # test_client fixture sets _proxy_manager to None
        body = test_client.get("/monitoring/proxy-status").json()
        assert body["pool_size"] == 0
        assert body["rotation_count"] == 0

    def test_proxy_status_active_proxy_null_when_no_proxy_configured(
        self, test_client
    ) -> None:
        """active_proxy must be null when no proxy is configured."""
        _mark_ready()
        body = test_client.get("/monitoring/proxy-status").json()
        assert body["active_proxy"] is None

    def test_proxy_status_reflects_injected_proxy_manager(self, test_client) -> None:
        """pool_size and rotation_count must come from the injected ProxyManager."""
        _mark_ready()

        mock_pm = MagicMock()
        mock_pm.pool_size = 3
        mock_pm.rotation_count = 7
        mock_pm.active_proxy_masked.return_value = "http://***@proxy.host:8080"

        _mon.set_proxy_manager(mock_pm)
        try:
            body = test_client.get("/monitoring/proxy-status").json()
            assert body["pool_size"] == 3
            assert body["rotation_count"] == 7
            assert body["active_proxy"] == "http://***@proxy.host:8080"
        finally:
            _mon.set_proxy_manager(None)

    def test_proxy_status_pool_size_is_non_negative_int(self, test_client) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/proxy-status").json()
        assert isinstance(body["pool_size"], int)
        assert body["pool_size"] >= 0

    def test_proxy_status_rotation_count_is_non_negative_int(
        self, test_client
    ) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/proxy-status").json()
        assert isinstance(body["rotation_count"], int)
        assert body["rotation_count"] >= 0


# ---------------------------------------------------------------------------
# GET /monitoring/session-status (Requirement 10.4 / 10.7)
# ---------------------------------------------------------------------------


class TestMonitoringSessionStatus:
    """Verify session-status response structure and null-warm behaviour."""

    def test_session_status_returns_200_when_initialized(self, test_client) -> None:
        _mark_ready()
        resp = test_client.get("/monitoring/session-status")
        assert resp.status_code == 200

    def test_session_status_contains_all_required_fields(self, test_client) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/session-status").json()
        for field in ("last_warm_at", "session_age_seconds", "next_warm_at"):
            assert field in body, f"Missing field: {field}"

    def test_session_status_all_fields_null_when_no_warmer_injected(
        self, test_client
    ) -> None:
        """When no SessionWarmer is injected all three fields must be null."""
        _mark_ready()
        # test_client fixture sets _session_warmer to None
        body = test_client.get("/monitoring/session-status").json()
        assert body["last_warm_at"] is None
        assert body["session_age_seconds"] is None
        assert body["next_warm_at"] is None

    def test_session_status_all_fields_null_when_no_warm_has_occurred(
        self, test_client
    ) -> None:
        """Injected warmer with no previous warm must return null for all fields."""
        _mark_ready()

        mock_sw = MagicMock()
        mock_sw.last_warm_at = None
        mock_sw.next_warm_at = None
        mock_sw.session_age_seconds = None

        _mon.set_session_warmer(mock_sw)
        try:
            body = test_client.get("/monitoring/session-status").json()
            assert body["last_warm_at"] is None
            assert body["session_age_seconds"] is None
            assert body["next_warm_at"] is None
        finally:
            _mon.set_session_warmer(None)

    def test_session_status_iso_timestamps_when_warm_has_occurred(
        self, test_client
    ) -> None:
        """last_warm_at and next_warm_at must be non-empty ISO-8601 UTC strings."""
        from datetime import datetime, timezone

        _mark_ready()

        last_warm = datetime(2025, 1, 1, 9, 0, 0, 0, tzinfo=timezone.utc)
        next_warm = datetime(2025, 1, 1, 9, 30, 0, 0, tzinfo=timezone.utc)

        mock_sw = MagicMock()
        mock_sw.last_warm_at = last_warm
        mock_sw.next_warm_at = next_warm
        mock_sw.session_age_seconds = 1800

        _mon.set_session_warmer(mock_sw)
        try:
            body = test_client.get("/monitoring/session-status").json()
            assert isinstance(body["last_warm_at"], str)
            assert len(body["last_warm_at"]) > 0
            assert "Z" in body["last_warm_at"] or "+" in body["last_warm_at"]
            assert isinstance(body["next_warm_at"], str)
            assert body["session_age_seconds"] == 1800
        finally:
            _mon.set_session_warmer(None)

    def test_session_status_session_age_is_non_negative_int_when_set(
        self, test_client
    ) -> None:
        """session_age_seconds must be a non-negative integer when a warm has occurred."""
        from datetime import datetime, timezone

        _mark_ready()

        mock_sw = MagicMock()
        mock_sw.last_warm_at = datetime(2025, 6, 1, 5, 0, 0, tzinfo=timezone.utc)
        mock_sw.next_warm_at = datetime(2025, 6, 1, 5, 30, 0, tzinfo=timezone.utc)
        mock_sw.session_age_seconds = 300

        _mon.set_session_warmer(mock_sw)
        try:
            body = test_client.get("/monitoring/session-status").json()
            assert isinstance(body["session_age_seconds"], int)
            assert body["session_age_seconds"] >= 0
        finally:
            _mon.set_session_warmer(None)


# ---------------------------------------------------------------------------
# Uptime and counter reset on service restart (Requirement 10.7)
# ---------------------------------------------------------------------------


class TestUptimeAndReset:
    """Verify uptime_seconds and zero-counter behaviour on fresh stats."""

    def test_uptime_seconds_is_non_negative_after_fresh_start(
        self, test_client
    ) -> None:
        _mark_ready()
        body = test_client.get("/monitoring/health").json()
        assert body["uptime_seconds"] >= 0

    def test_request_count_zero_on_fresh_rolling_stats(self, test_client) -> None:
        """Fresh RollingWindowStats must report request_count == 0."""
        _mark_ready()
        fresh_stats = _mon.RollingWindowStats()
        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/health").json()
            assert body["request_count"] == 0

    def test_cache_hit_rate_zero_on_fresh_rolling_stats(self, test_client) -> None:
        """Fresh RollingWindowStats must report cache_hit_rate == 0.0."""
        _mark_ready()
        fresh_stats = _mon.RollingWindowStats()
        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/health").json()
            assert body["cache_hit_rate"] == 0.0

    def test_request_count_increments_after_record_call(self, test_client) -> None:
        """request_count must reflect recorded requests."""
        _mark_ready()
        fresh_stats = _mon.RollingWindowStats()
        fresh_stats.record("/monitoring/health", duration_ms=50, success=True)
        fresh_stats.record("/monitoring/health", duration_ms=80, success=True)

        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/health").json()
            assert body["request_count"] == 2

    def test_cache_hit_rate_computed_correctly(self, test_client) -> None:
        """cache_hit_rate must equal hits/total rounded to 4 dp."""
        _mark_ready()
        fresh_stats = _mon.RollingWindowStats()
        # 3 hits, 1 miss → rate = 3/4 = 0.75
        fresh_stats.record_cache_result(hit=True)
        fresh_stats.record_cache_result(hit=True)
        fresh_stats.record_cache_result(hit=True)
        fresh_stats.record_cache_result(hit=False)

        with patch.object(_mon, "rolling_stats", fresh_stats):
            body = test_client.get("/monitoring/health").json()
            assert body["cache_hit_rate"] == 0.75
