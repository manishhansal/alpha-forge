"""
Capability-aware /health/providers endpoint (spec §37-38).

Confirms that a single provider CAPABILITY outage (e.g. NSE historical) surfaces
that capability as DEGRADED while other capabilities stay healthy, and that the
overall status is DEGRADED — never DOWN — because at least one path still works.
"""

from __future__ import annotations

import json

import pytest

from src.monitoring.health_router import health_providers
from src.core.circuit_breaker import get_breaker, _breakers


@pytest.fixture(autouse=True)
def _reset_breakers():
    _breakers.clear()
    yield
    _breakers.clear()


async def test_historical_outage_degrades_only_historical():
    # Trip the NSE historical (charting) circuit — a burst of 503s.
    b = get_breaker("nse_charting")
    for _ in range(10):
        b.record_failure("503")

    resp = await health_providers()
    body = json.loads(resp.body)

    assert resp.status_code == 200
    assert body["status"] == "DEGRADED"

    scrapling = body["providers"]["scrapling"]
    assert scrapling["historical"]["status"] == "DEGRADED"
    # Live capability was never touched → not degraded by the historical outage.
    assert scrapling["live"]["status"] in ("HEALTHY", "UNKNOWN")


async def test_all_healthy_is_healthy():
    resp = await health_providers()
    body = json.loads(resp.body)
    assert resp.status_code == 200
    # With no breaker failures, nothing is degraded.
    assert body["status"] == "HEALTHY"


async def test_upstox_live_outage_isolated():
    b = get_breaker("upstox_quotes")
    for _ in range(10):
        b.record_failure("429")

    resp = await health_providers()
    body = json.loads(resp.body)
    assert body["providers"]["upstox"]["live"]["status"] == "DEGRADED"
    # scrapling untouched.
    assert body["providers"]["scrapling"]["live"]["status"] in ("HEALTHY", "UNKNOWN")
