"""
Integration tests — Gate Router (POST /data/gate, GET /data/gate/:symbol).

Verifies the DataQualityGate HTTP API that the Next.js signal engine
must call before generating any signal.

Evidence level: INTEGRATION_TESTED (real FastAPI TestClient, real gate logic)
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

# Patch lifespan before importing app
with patch("src.server.lifespan"):
    from src.server import app


class TestGateEndpoints:
    """Test the POST /data/gate and GET /data/gate/:symbol endpoints."""

    @pytest.fixture
    def client(self) -> TestClient:
        return TestClient(app)

    def test_post_gate_fresh_data_allowed(self, client: TestClient) -> None:
        """Fresh data → signalEngineAllowed=True."""
        resp = client.post("/data/gate", json={
            "symbol": "NIFTY",
            "quoteAgeMs": 2000,
            "completenessPercent": 1.0,
            "timestampValid": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["signalEngineAllowed"] is True
        assert data["confidenceScore"] > 70
        assert data["quality"] == "VALID"

    def test_post_gate_stale_data_blocked(self, client: TestClient) -> None:
        """Stale quote → signalEngineAllowed=False."""
        resp = client.post("/data/gate", json={
            "symbol": "NIFTY",
            "quoteAgeMs": 120_000,  # 2 minutes
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["signalEngineAllowed"] is False
        assert data["blockReasons"] is not None
        assert len(data["blockReasons"]) > 0

    def test_post_gate_invalid_timestamp_blocked(self, client: TestClient) -> None:
        """Invalid timestamp → signal blocked."""
        resp = client.post("/data/gate", json={
            "symbol": "RELIANCE",
            "quoteAgeMs": 2000,
            "timestampValid": False,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["signalEngineAllowed"] is False

    def test_post_gate_returns_circuit_breaker_states(self, client: TestClient) -> None:
        """Gate response must include circuit breaker states."""
        resp = client.post("/data/gate", json={
            "symbol": "NIFTY",
            "quoteAgeMs": 2000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "circuitBreakers" in data
        assert isinstance(data["circuitBreakers"], dict)

    def test_post_gate_returns_all_gate_conditions(self, client: TestClient) -> None:
        """Gate response must include all five gate conditions."""
        resp = client.post("/data/gate", json={
            "symbol": "NIFTY",
            "quoteAgeMs": 2000,
        })
        assert resp.status_code == 200
        data = resp.json()
        gates = data["gates"]
        assert "dataFresh" in gates
        assert "dataComplete" in gates
        assert "dataTimestampValid" in gates
        assert "dataProviderHealthy" in gates
        assert "dataSemanticallyValid" in gates

    def test_post_gate_oi_strategy_without_oi(self, client: TestClient) -> None:
        """OI strategy must be blocked when OI is unavailable."""
        resp = client.post("/data/gate", json={
            "symbol": "BANKNIFTY",
            "quoteAgeMs": 2000,
            "strategyId": "oi_scalper",
            "maxQuoteAgeMs": 5000,
            "minConfidenceScore": 70,
            "requiresOI": True,
            "oiAvailable": False,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["signalEngineAllowed"] is False

    def test_get_gate_symbol(self, client: TestClient) -> None:
        """GET /data/gate/:symbol returns gate for a specific symbol."""
        resp = client.get("/data/gate/NIFTY?quote_age_ms=3000")
        assert resp.status_code == 200
        data = resp.json()
        assert data["symbol"] == "NIFTY"
        assert "signalEngineAllowed" in data
        assert "confidenceScore" in data
        assert "recentObservations" in data

    def test_post_gate_evaluated_at_present(self, client: TestClient) -> None:
        """Gate response must include evaluatedAt timestamp."""
        resp = client.post("/data/gate", json={
            "symbol": "TCS",
            "quoteAgeMs": 2000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "evaluatedAt" in data
        assert data["evaluatedAt"].endswith("Z")


class TestLineageEndpoints:
    """Test the lineage query endpoints."""

    @pytest.fixture
    def client(self) -> TestClient:
        return TestClient(app)

    def test_get_lineage_summary(self, client: TestClient) -> None:
        """Lineage summary must return store statistics."""
        resp = client.get("/data/lineage/summary")
        assert resp.status_code == 200
        data = resp.json()
        assert "storeSize" in data
        assert "totalRecorded" in data
        assert "maxSize" in data
        assert "utilizationPercent" in data

    def test_get_lineage_unknown_id_returns_404(self, client: TestClient) -> None:
        """Unknown observation ID must return 404."""
        resp = client.get("/data/lineage/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404
        data = resp.json()
        assert "observation_not_found" in data.get("error", "")

    def test_get_instrument_lineage_returns_list(self, client: TestClient) -> None:
        """Instrument lineage endpoint must return a list."""
        resp = client.get("/data/lineage/instrument/NIFTY")
        assert resp.status_code == 200
        data = resp.json()
        assert "records" in data
        assert isinstance(data["records"], list)
        assert "instrumentId" in data
        assert data["instrumentId"] == "NIFTY"

    def test_get_strategy_health(self, client: TestClient) -> None:
        """Strategy data health endpoint must evaluate requirements."""
        resp = client.get("/data/health/strategy/oi_scalper?quote_age_ms=2000&oi_available=true")
        assert resp.status_code == 200
        data = resp.json()
        assert data["strategyId"] == "oi_scalper"
        assert "signalAllowed" in data
        assert "requirements" in data
        assert data["requirements"]["requiresOI"] is True
