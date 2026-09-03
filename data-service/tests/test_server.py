"""
Unit tests for data-service core server endpoints.

Covers:
  - GET /health        — always HTTP 200; correct JSON shape
  - GET /scraping/status — HTTP 200; available flag + capability flags
  - CORS allow         — Origin: http://localhost:3000 passes through
  - CORS block         — unknown origins do NOT receive Allow-Origin header
  - Degraded mode      — _component_status non-ok value → status: "degraded"

Requirements: 1.1, 1.2, 1.3, 1.7
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _noop_lifespan(app):  # noqa: ANN001
    """Async context manager that skips all real startup logic."""

    @asynccontextmanager
    async def _inner(app):  # noqa: ANN001
        import src.monitoring.router as _mon

        _mon._service_initialized = False
        _mon._proxy_manager = None
        _mon._session_warmer = None
        yield
        _mon._service_initialized = False

    return _inner(app)


# We use the shared test_client fixture from conftest.py throughout.
# Some tests need to manipulate module state directly, so they accept
# the test_client fixture and use monkeypatch for isolation.


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    def test_health_returns_200(self, test_client):
        """GET /health must always return HTTP 200."""
        resp = test_client.get("/health")
        assert resp.status_code == 200

    def test_health_json_shape_when_healthy(self, test_client):
        """Response must contain status, service, version, and timestamp."""
        resp = test_client.get("/health")
        body = resp.json()

        assert "status" in body
        assert "service" in body
        assert "version" in body
        assert "timestamp" in body

    def test_health_service_name(self, test_client):
        """service field must be 'data-service'."""
        resp = test_client.get("/health")
        assert resp.json()["service"] == "data-service"

    def test_health_version(self, test_client):
        """version field must be '0.1.0'."""
        resp = test_client.get("/health")
        assert resp.json()["version"] == "0.1.0"

    def test_health_timestamp_format(self, test_client):
        """timestamp must be a non-empty string (ISO-8601)."""
        resp = test_client.get("/health")
        ts = resp.json()["timestamp"]
        assert isinstance(ts, str) and len(ts) > 0

    def test_health_status_healthy_when_no_failures(self, test_client):
        """status should be 'healthy' when _component_status is empty."""
        import src.server as server

        with patch.dict(server._component_status, {}, clear=True):
            resp = test_client.get("/health")
            assert resp.json()["status"] == "healthy"

    def test_health_status_degraded_when_component_failed(self, test_client, monkeypatch):
        """status must be 'degraded' when any component has a non-'ok' value."""
        import src.server as server

        monkeypatch.setitem(server._component_status, "redis", "Connection refused")

        resp = test_client.get("/health")
        body = resp.json()

        assert resp.status_code == 200  # still 200 — never a 5xx
        assert body["status"] == "degraded"

    def test_health_degraded_includes_components_key(self, test_client, monkeypatch):
        """Degraded response must include a 'components' dict."""
        import src.server as server

        monkeypatch.setitem(server._component_status, "chromium", "not found")

        body = test_client.get("/health").json()

        assert "components" in body
        assert body["components"]["chromium"] == "not found"

    def test_health_healthy_has_no_components_key(self, test_client):
        """Healthy response must NOT include 'components'."""
        import src.server as server

        with patch.dict(server._component_status, {}, clear=True):
            body = test_client.get("/health").json()
            assert "components" not in body


# ---------------------------------------------------------------------------
# GET /scraping/status
# ---------------------------------------------------------------------------


class TestScrapingStatusEndpoint:
    def test_scraping_status_returns_200(self, test_client):
        """GET /scraping/status must return HTTP 200."""
        resp = test_client.get("/scraping/status")
        assert resp.status_code == 200

    def test_scraping_status_available_true(self, test_client):
        """Response must include available: true."""
        body = test_client.get("/scraping/status").json()
        assert body["available"] is True

    def test_scraping_status_has_capabilities(self, test_client):
        """Response must include a 'capabilities' object."""
        body = test_client.get("/scraping/status").json()
        assert "capabilities" in body
        caps = body["capabilities"]
        assert isinstance(caps, dict)

    def test_scraping_status_capability_flags_are_booleans(self, test_client):
        """All capability flags must be boolean values."""
        caps = test_client.get("/scraping/status").json()["capabilities"]
        bool_flags = [
            "chromium_available",
            "redis_connected",
            "proxy_available",
            "live_quotes",
            "option_chain_nse",
            "option_chain_bse",
            "historical_daily",
            "historical_intraday",
            "instrument_master",
            "tick_publisher",
        ]
        for flag in bool_flags:
            assert flag in caps, f"Missing capability flag: {flag}"
            assert isinstance(caps[flag], bool), f"{flag} should be bool, got {type(caps[flag])}"

    def test_scraping_status_has_config(self, test_client):
        """Response must include a 'config' object with expected keys."""
        body = test_client.get("/scraping/status").json()
        assert "config" in body
        cfg = body["config"]

        for key in ("active_symbol_count", "nse_rate_limit", "bse_rate_limit", "data_dir"):
            assert key in cfg, f"Missing config key: {key}"

    def test_scraping_status_active_symbol_count_is_int(self, test_client):
        """active_symbol_count must be a non-negative integer."""
        cfg = test_client.get("/scraping/status").json()["config"]
        assert isinstance(cfg["active_symbol_count"], int)
        assert cfg["active_symbol_count"] >= 0


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


class TestCors:
    def test_cors_allows_localhost_3000(self, test_client):
        """Requests from http://localhost:3000 must receive Access-Control-Allow-Origin."""
        resp = test_client.get("/health", headers={"Origin": "http://localhost:3000"})
        assert "access-control-allow-origin" in resp.headers
        assert resp.headers["access-control-allow-origin"] == "http://localhost:3000"

    def test_cors_allows_127_0_0_1_3000(self, test_client):
        """Requests from http://127.0.0.1:3000 must receive Access-Control-Allow-Origin."""
        resp = test_client.get("/health", headers={"Origin": "http://127.0.0.1:3000"})
        assert "access-control-allow-origin" in resp.headers
        assert resp.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"

    def test_cors_blocks_unknown_origin(self, test_client):
        """Unknown origins must NOT receive Access-Control-Allow-Origin header."""
        resp = test_client.get("/health", headers={"Origin": "http://evil.example.com"})
        assert "access-control-allow-origin" not in resp.headers

    def test_cors_blocks_localhost_other_port(self, test_client):
        """localhost on a different port (e.g. 4000) must be blocked."""
        resp = test_client.get("/health", headers={"Origin": "http://localhost:4000"})
        assert "access-control-allow-origin" not in resp.headers

    def test_cors_blocks_https_variant(self, test_client):
        """https://localhost:3000 is NOT in the allowlist and must be blocked."""
        resp = test_client.get("/health", headers={"Origin": "https://localhost:3000"})
        assert "access-control-allow-origin" not in resp.headers

    def test_cors_preflight_allowed_origin(self, test_client):
        """OPTIONS preflight from allowed origin must receive 200 with CORS headers."""
        resp = test_client.options(
            "/health",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code == 200
        assert "access-control-allow-origin" in resp.headers


# ---------------------------------------------------------------------------
# Degraded mode (combined)
# ---------------------------------------------------------------------------


class TestDegradedMode:
    def test_multiple_failed_components_all_in_components(self, test_client, monkeypatch):
        """All failed components must appear in the 'components' dict."""
        import src.server as server

        monkeypatch.setitem(server._component_status, "redis", "timeout")
        monkeypatch.setitem(server._component_status, "chromium", "binary not found")

        body = test_client.get("/health").json()

        assert body["status"] == "degraded"
        assert body["components"]["redis"] == "timeout"
        assert body["components"]["chromium"] == "binary not found"

    def test_ok_components_not_in_components_dict(self, test_client, monkeypatch):
        """Components with status 'ok' must not appear in the degraded components dict."""
        import src.server as server

        monkeypatch.setitem(server._component_status, "redis", "ok")
        monkeypatch.setitem(server._component_status, "chromium", "binary not found")

        body = test_client.get("/health").json()

        assert "components" in body
        assert "redis" not in body["components"]
        assert "chromium" in body["components"]

    def test_health_always_200_even_in_degraded_mode(self, test_client, monkeypatch):
        """GET /health must return HTTP 200 even when degraded."""
        import src.server as server

        monkeypatch.setitem(server._component_status, "redis", "down")
        monkeypatch.setitem(server._component_status, "chromium", "down")
        monkeypatch.setitem(server._component_status, "anti_ban", "down")

        resp = test_client.get("/health")
        assert resp.status_code == 200
