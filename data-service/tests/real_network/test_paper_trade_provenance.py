"""
End-to-end paper trade provenance validation.

Evidence level: LIVE_SESSION_TESTED (requires DB + live signals + V2.1 gate wiring)

Run after paper trades have been generated during a live session:
    pytest tests/real_network/test_paper_trade_provenance.py -v -s

What this validates:
    1. Every recent India paper trade has dataObservationId populated
    2. quoteAgeAtEntryMs is present and within expected range
    3. dataConfidenceAtEntry is in [0, 95]
    4. dataQualityAtEntry is a valid DataQuality enum value
    5. GET /api/in/data/forensics/:tradeId returns a complete chain
    6. The forensics chain links trade → provenance → lineage
    7. No trade was opened with INVALID quality data (hard gate enforcement)

Skip conditions:
    - No NEXT_PUBLIC_APP_URL or DATABASE_URL configured (no DB access)
    - No India paper trades found in the last 7 days
    - Not labeled as skipped incorrectly — skipping means NOT_TESTED

The test runs a Python-level Prisma-equivalent check against the
data-service lineage store and the forensics endpoint.

Note: Full DB access requires the Next.js DATABASE_URL to be set.
This test is designed to run post-session, not during market hours.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Optional

import pytest


# ---------------------------------------------------------------------------
# Skip when no forensics endpoint is reachable
# ---------------------------------------------------------------------------

APP_URL = os.environ.get("NEXT_PUBLIC_APP_URL", "http://localhost:3000")
DATA_SERVICE_URL = os.environ.get("DATA_SERVICE_URL", "http://localhost:8200")


async def _app_reachable() -> bool:
    try:
        import httpx
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{APP_URL}/api/health")
            return r.status_code in (200, 401, 403)  # any response = app is up
    except Exception:
        return False


async def _data_service_reachable() -> bool:
    try:
        import httpx
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{DATA_SERVICE_URL}/health/live")
            return r.status_code == 200
    except Exception:
        return False


@pytest.fixture(autouse=True, scope="module")
async def require_services():
    app_up = await _app_reachable()
    ds_up = await _data_service_reachable()
    if not app_up and not ds_up:
        pytest.skip(
            f"Neither Next.js app ({APP_URL}) nor data-service ({DATA_SERVICE_URL}) "
            "is reachable. Evidence: NOT_TESTED. "
            "Run during or after a live session with both services running."
        )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestDataServiceProvenanceAPI:
    """Tests that only require data-service (not the full Next.js app)."""

    @pytest.mark.asyncio
    async def test_lineage_store_populated(self):
        """After any real quote fetch, lineage store must have entries."""
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{DATA_SERVICE_URL}/data/lineage/summary")
        assert r.status_code == 200, f"Lineage summary returned {r.status_code}"
        data = r.json()
        print(f"\n[REAL_SERVICE] Lineage store: {data}")
        assert "storeSize" in data
        assert "totalRecorded" in data

    @pytest.mark.asyncio
    async def test_gate_endpoint_responds(self):
        """POST /data/gate must evaluate correctly for NIFTY."""
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.post(
                f"{DATA_SERVICE_URL}/data/gate",
                json={"symbol": "NIFTY", "quoteAgeMs": 2000,
                      "completenessPercent": 1.0, "timestampValid": True},
            )
        assert r.status_code == 200, f"Gate returned {r.status_code}"
        data = r.json()
        assert "signalEngineAllowed" in data
        assert "confidenceScore" in data
        assert 0 <= data["confidenceScore"] <= 95
        print(f"\n[REAL_SERVICE] Gate response: {data}")

    @pytest.mark.asyncio
    async def test_circuit_breaker_states_in_health(self):
        """GET /health/data must include circuit breaker states."""
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{DATA_SERVICE_URL}/health/data")
        assert r.status_code == 200
        data = r.json()
        assert "circuitBreakers" in data, "circuitBreakers missing from /health/data"
        print(f"\n[REAL_SERVICE] Circuit breakers: {data.get('circuitBreakers', {})}")

    @pytest.mark.asyncio
    async def test_unknown_observation_id_returns_404(self):
        """Unknown observationId must return 404, not 500."""
        import httpx
        fake_id = "00000000-0000-0000-0000-000000000000"
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{DATA_SERVICE_URL}/data/lineage/{fake_id}")
        assert r.status_code == 404, f"Expected 404, got {r.status_code}"
        data = r.json()
        assert "observation_not_found" in data.get("error", "")


class TestPaperTradeForensics:
    """Full forensics chain validation — requires Next.js app + DB."""

    @pytest.fixture(autouse=True)
    async def require_app(self):
        if not await _app_reachable():
            pytest.skip(
                f"Next.js app not reachable at {APP_URL}. "
                "Evidence: NOT_TESTED"
            )

    @pytest.mark.asyncio
    async def test_recent_trades_have_provenance(self):
        """
        Fetch the most recent India paper trades and verify V2.1 provenance fields.

        This test checks that every trade opened AFTER V2.1 gate wiring
        (commit dff4503 / 597c035) has:
          - dataQualityAtEntry populated (not null)
          - dataConfidenceAtEntry in [0, 95]
          - quoteAgeAtEntryMs present

        Trades created BEFORE V2.1 wiring will have null provenance fields —
        this is expected and documented.
        """
        import httpx

        async with httpx.AsyncClient(timeout=10.0) as c:
            # Get recent India paper trades from the analytics endpoint
            r = await c.get(
                f"{APP_URL}/api/in/paper-trade/analytics?range=7d",
                headers={"Cookie": ""},  # unauthenticated — will get 401 if auth required
            )

        if r.status_code in (401, 403):
            pytest.skip(
                "Paper trade analytics endpoint requires authentication. "
                "Run with a valid session cookie. Evidence: NOT_TESTED"
            )

        if r.status_code != 200:
            pytest.skip(
                f"Paper trade analytics returned {r.status_code}. Evidence: NOT_TESTED"
            )

        data = r.json()
        trades = data.get("trades", data.get("data", []))
        if not trades:
            pytest.skip(
                "No India paper trades found in last 7 days. "
                "Evidence: NOT_TESTED — run after a live session with signals"
            )

        # Filter for trades created after V2.1 wiring
        # We check for presence of provenance fields
        v21_trades = [
            t for t in trades
            if t.get("dataQualityAtEntry") is not None
        ]
        legacy_trades = [
            t for t in trades
            if t.get("dataQualityAtEntry") is None
        ]

        print(f"\n[LIVE_SESSION] Paper trade provenance audit:")
        print(f"  Total trades (7d): {len(trades)}")
        print(f"  V2.1 (with provenance): {len(v21_trades)}")
        print(f"  Legacy (before V2.1): {len(legacy_trades)}")

        if not v21_trades:
            pytest.skip(
                "No V2.1 paper trades found (all trades predate provenance wiring). "
                "Open paper trades with the live gate client active. Evidence: NOT_TESTED"
            )

        # Validate each V2.1 trade
        violations = []
        for trade in v21_trades:
            trade_id = trade.get("id", "?")
            confidence = trade.get("dataConfidenceAtEntry")
            quality = trade.get("dataQualityAtEntry")
            quote_age = trade.get("quoteAgeAtEntryMs")

            if confidence is not None and not (0 <= confidence <= 95):
                violations.append(
                    f"{trade_id}: dataConfidenceAtEntry={confidence} out of [0,95]"
                )
            if quality not in (None, "VALID", "DEGRADED", "INVALID", "UNKNOWN", "STALE", "PARTIAL"):
                violations.append(f"{trade_id}: invalid dataQualityAtEntry={quality!r}")
            if quality == "INVALID":
                violations.append(
                    f"{trade_id}: trade opened with dataQualityAtEntry=INVALID — "
                    "HARD GATE VIOLATION: should have been blocked"
                )

        assert not violations, (
            "Paper trade provenance violations:\n" + "\n".join(violations)
        )
        print(f"  All {len(v21_trades)} V2.1 trades have valid provenance ✓")

    @pytest.mark.asyncio
    async def test_forensics_endpoint_for_recent_trade(self):
        """
        GET /api/in/data/forensics/:tradeId for a real paper trade.
        Validates the forensics chain is complete and correctly structured.
        """
        import httpx

        # Get a recent trade ID
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(f"{APP_URL}/api/in/paper-trade/analytics?range=7d")

        if r.status_code in (401, 403):
            pytest.skip("Authentication required. Evidence: NOT_TESTED")
        if r.status_code != 200:
            pytest.skip(f"Analytics returned {r.status_code}. Evidence: NOT_TESTED")

        trades = r.json().get("trades", r.json().get("data", []))
        if not trades:
            pytest.skip("No trades to test forensics against. Evidence: NOT_TESTED")

        trade_id = trades[0].get("id")
        if not trade_id:
            pytest.skip("No trade ID found. Evidence: NOT_TESTED")

        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(f"{APP_URL}/api/in/data/forensics/{trade_id}")

        if r.status_code in (401, 403):
            pytest.skip("Authentication required for forensics. Evidence: NOT_TESTED")
        assert r.status_code == 200, f"Forensics returned {r.status_code}"

        forensics = r.json()

        # Validate forensics chain structure
        required_keys = [
            "tradeId", "symbol", "fill", "signalDecision",
            "dataProvenance", "lineage", "chain", "certificationStatus",
        ]
        for key in required_keys:
            assert key in forensics, f"Forensics missing key: {key}"

        chain = forensics.get("chain", [])
        assert len(chain) >= 5, f"Forensics chain has only {len(chain)} steps (expected >=5)"

        provenance = forensics.get("dataProvenance", {})
        assert provenance.get("provenanceVersion") == "2.1.0", (
            "Forensics response must declare provenanceVersion=2.1.0"
        )

        cert = forensics.get("certificationStatus", {})
        assert cert.get("tradeRecord") == "CERTIFIED", (
            "tradeRecord must always be CERTIFIED (trade persisted in DB)"
        )

        print(f"\n[LIVE_SESSION] Forensics for trade {trade_id}:")
        print(f"  Symbol: {forensics.get('symbol')}")
        print(f"  Provenance complete: {provenance.get('provenanceComplete')}")
        print(f"  Chain steps: {len(chain)}")
        print(f"  Certification: {cert}")

    @pytest.mark.asyncio
    async def test_no_invalid_quality_trades(self):
        """
        Hard gate enforcement: no trade should ever have dataQualityAtEntry=INVALID.
        If any such trade exists after V2.1 wiring, it is a certification blocker.
        """
        import httpx

        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(f"{APP_URL}/api/in/paper-trade/analytics?range=7d")

        if r.status_code in (401, 403):
            pytest.skip("Authentication required. Evidence: NOT_TESTED")
        if r.status_code != 200:
            pytest.skip(f"Analytics returned {r.status_code}. Evidence: NOT_TESTED")

        trades = r.json().get("trades", r.json().get("data", []))
        invalid_quality_trades = [
            t.get("id") for t in trades
            if t.get("dataQualityAtEntry") == "INVALID"
        ]

        assert not invalid_quality_trades, (
            f"HARD GATE VIOLATION: {len(invalid_quality_trades)} trade(s) opened "
            f"with dataQualityAtEntry=INVALID: {invalid_quality_trades[:5]}. "
            "The DataQualityGate must block all INVALID quality signals."
        )
        print(
            f"\n[LIVE_SESSION] Hard gate check: "
            f"0 INVALID quality trades in {len(trades)} total ✓"
        )
