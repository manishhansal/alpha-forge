"""
Integration tests — Signal Gate Wiring (Phase 2 / V2.1 certification).

Verifies the hard signal gate requirement:
  - stale quote → signal blocked
  - valid quote → signal allowed
  - provider unhealthy → signal blocked
  - strategy-specific requirements enforced

Evidence level: UNIT_TESTED (real DataQualityGate, no mocks on gate logic)
The gate is tested in isolation; TypeScript signal engine wiring requires
a running Next.js process and is documented as NOT_CERTIFIED in the matrix.
"""

from __future__ import annotations

import pytest

from src.core.data_quality import build_quality_gate, check_strategy_data_requirements
from src.core.schemas_v2 import (
    DataQuality,
    FreshnessClass,
    StrategyDataRequirements,
)


class TestHardSignalGate:
    """Verify the hard gate: stale/invalid data must always block signals."""

    def test_stale_quote_blocks_signal(self) -> None:
        """CRITICAL: stale quote → signalEngineAllowed=False. No exceptions."""
        gate = build_quality_gate(
            quote_age_ms=120_000,  # 2 minutes — clearly stale
            symbol="NIFTY",
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
        )
        assert gate.signalEngineAllowed is False, (
            "HARD GATE VIOLATION: stale quote must block signal engine"
        )
        assert gate.blockReason is not None, "Block reason must be provided"
        assert "stale" in gate.blockReason.lower() or "data_stale" in gate.blockReason.lower()

    def test_valid_quote_allows_signal(self) -> None:
        """Fresh, complete, valid data must allow signal generation."""
        gate = build_quality_gate(
            quote_age_ms=2_000,  # 2 seconds — fresh
            symbol="NIFTY",
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
        )
        assert gate.signalEngineAllowed is True, (
            "Fresh, valid data must allow signal generation"
        )
        assert gate.confidenceScore > 70

    def test_invalid_timestamp_blocks_signal(self) -> None:
        """Invalid timestamp → signal always blocked."""
        gate = build_quality_gate(
            quote_age_ms=2_000,
            symbol="RELIANCE",
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=False,  # invalid timestamp
        )
        assert gate.signalEngineAllowed is False
        assert "timestamp" in (gate.blockReason or "").lower()

    def test_provider_unhealthy_blocks_signal(self) -> None:
        """Provider circuit open → signal always blocked."""
        gate = build_quality_gate(
            quote_age_ms=2_000,
            symbol="BANKNIFTY",
            completeness_pct=1.0,
            provider_healthy=False,
            timestamp_valid=True,
        )
        assert gate.signalEngineAllowed is False
        assert "provider" in (gate.blockReason or "").lower()

    def test_low_completeness_blocks_signal(self) -> None:
        """Incomplete data (< 80%) → signal blocked."""
        gate = build_quality_gate(
            quote_age_ms=2_000,
            symbol="TCS",
            completeness_pct=0.6,  # 60% completeness — below 80% threshold
            provider_healthy=True,
            timestamp_valid=True,
        )
        assert gate.signalEngineAllowed is False
        assert "incomplete" in (gate.blockReason or "").lower()

    def test_all_gates_must_pass_for_allowed(self) -> None:
        """All five gate conditions must be True for signalEngineAllowed."""
        # Test each condition independently
        conditions = [
            {"completeness_pct": 0.5},
            {"provider_healthy": False},
            {"timestamp_valid": False},
            {"quote_age_ms": 60_000},
        ]
        for condition in conditions:
            params = {
                "quote_age_ms": 2_000,
                "completeness_pct": 1.0,
                "provider_healthy": True,
                "timestamp_valid": True,
            }
            params.update(condition)
            gate = build_quality_gate(**params)
            assert gate.signalEngineAllowed is False, (
                f"Gate should be closed with: {condition}"
            )

    def test_gate_quality_classifications(self) -> None:
        """Verify quality field matches conditions."""
        valid_gate = build_quality_gate(
            quote_age_ms=2_000,
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
        )
        assert valid_gate.quality == DataQuality.VALID

        stale_gate = build_quality_gate(
            quote_age_ms=120_000,
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
        )
        assert stale_gate.quality in (DataQuality.DEGRADED, DataQuality.INVALID)

    def test_confidence_score_bounded(self) -> None:
        """Confidence score never reaches 100 — cap is 95."""
        gate = build_quality_gate(
            quote_age_ms=1_000,
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
            cross_source_agreement=1.0,
            sequence_integrity=True,
        )
        assert gate.confidenceScore <= 95, "Score must never reach 100"
        assert gate.confidenceScore >= 0

    def test_expired_data_has_near_zero_confidence(self) -> None:
        """Expired data should have very low confidence score."""
        gate = build_quality_gate(
            quote_age_ms=600_000,  # 10 minutes — expired
            completeness_pct=0.0,
            provider_healthy=False,
            timestamp_valid=False,
        )
        assert gate.confidenceScore < 20, (
            f"Expired/invalid data confidence {gate.confidenceScore} should be < 20"
        )
        assert gate.signalEngineAllowed is False


class TestStrategySpecificGate:
    """Verify strategy-specific data requirements."""

    def test_oi_strategy_requires_oi(self) -> None:
        """OI strategy must be blocked when OI is unavailable."""
        req = StrategyDataRequirements(
            strategyId="oi_scalper",
            strategyName="OI Scalper",
            requiredDataTypes=["PRICE", "OI"],
            minConfidenceScore=70,
            maxQuoteAgeMs=5_000,
            requiresOI=True,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=2_000,
            confidence_score=80,
            oi_available=False,  # OI not available
        )
        assert ok is False, "OI strategy must be blocked without OI"
        assert any("oi" in r.lower() for r in reasons)

    def test_oi_strategy_passes_with_oi(self) -> None:
        """OI strategy should pass when OI is available and data is fresh."""
        req = StrategyDataRequirements(
            strategyId="oi_scalper",
            strategyName="OI Scalper",
            requiredDataTypes=["PRICE", "OI"],
            minConfidenceScore=70,
            maxQuoteAgeMs=5_000,
            requiresOI=True,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=2_000,
            confidence_score=80,
            oi_available=True,
        )
        assert ok is True, f"OI strategy should pass with OI: {reasons}"
        assert len(reasons) == 0

    def test_breakout_strategy_requires_confirmed_candle(self) -> None:
        """Breakout strategy must not fire on a partial candle."""
        req = StrategyDataRequirements(
            strategyId="breakout",
            strategyName="Breakout",
            requiredDataTypes=["PRICE", "CANDLE"],
            minConfidenceScore=70,
            maxQuoteAgeMs=10_000,
            requiresConfirmedCandle=True,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=5_000,
            confidence_score=80,
            candle_confirmed=False,  # partial candle — must block
        )
        assert ok is False
        assert any("candle" in r.lower() for r in reasons)

    def test_option_straddle_requires_option_chain(self) -> None:
        """Option straddle strategy must be blocked without option chain."""
        req = StrategyDataRequirements(
            strategyId="option_straddle",
            strategyName="Option Straddle",
            requiredDataTypes=["PRICE", "OPTION_CHAIN"],
            minConfidenceScore=70,
            maxQuoteAgeMs=30_000,
            requiresOptionChain=True,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=5_000,
            confidence_score=80,
            option_chain_available=False,
        )
        assert ok is False
        assert any("option_chain" in r.lower() for r in reasons)

    def test_stale_quote_blocks_any_strategy(self) -> None:
        """Quote older than strategy maxQuoteAgeMs must always block."""
        req = StrategyDataRequirements(
            strategyId="momentum",
            strategyName="Momentum",
            requiredDataTypes=["PRICE"],
            minConfidenceScore=60,
            maxQuoteAgeMs=5_000,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=30_000,  # 30s — beyond 5s limit
            confidence_score=80,
        )
        assert ok is False
        assert any("stale" in r.lower() or "quote_too_stale" in r.lower() for r in reasons)

    def test_low_confidence_blocks_strategy(self) -> None:
        """Confidence below strategy minimum must block."""
        req = StrategyDataRequirements(
            strategyId="test_strategy",
            strategyName="Test",
            requiredDataTypes=["PRICE"],
            minConfidenceScore=75,
            maxQuoteAgeMs=10_000,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=2_000,
            confidence_score=50,  # below 75 threshold
        )
        assert ok is False
        assert any("confidence" in r.lower() for r in reasons)


class TestGateMonotonicity:
    """Verify that higher confidence corresponds to lower data failure probability."""

    def test_freshness_monotone(self) -> None:
        """Fresher data → higher confidence."""
        ages = [1_000, 5_000, 15_000, 30_000, 120_000]
        scores = []
        for age in ages:
            gate = build_quality_gate(
                quote_age_ms=age,
                completeness_pct=1.0,
                provider_healthy=True,
                timestamp_valid=True,
            )
            scores.append(gate.confidenceScore)
        # Scores should be non-increasing as age increases
        for i in range(len(scores) - 1):
            assert scores[i] >= scores[i + 1], (
                f"Confidence should decrease with age: age[{ages[i]}]={scores[i]} "
                f"< age[{ages[i+1]}]={scores[i+1]}"
            )

    def test_completeness_monotone(self) -> None:
        """Higher completeness → higher confidence."""
        for low, high in [(0.0, 0.5), (0.5, 0.8), (0.8, 1.0)]:
            low_gate = build_quality_gate(quote_age_ms=3_000, completeness_pct=low)
            high_gate = build_quality_gate(quote_age_ms=3_000, completeness_pct=high)
            assert low_gate.confidenceScore <= high_gate.confidenceScore, (
                f"Higher completeness ({high}) should have higher confidence than {low}"
            )

    def test_score_buckets_calibration(self) -> None:
        """Verify score buckets: lower buckets correspond to worse data."""
        # Perfect data
        perfect = build_quality_gate(
            quote_age_ms=1_000, completeness_pct=1.0,
            provider_healthy=True, timestamp_valid=True,
        )
        # Degraded data
        degraded = build_quality_gate(
            quote_age_ms=30_000, completeness_pct=0.7,
            provider_healthy=True, timestamp_valid=True,
        )
        # Failed data
        failed = build_quality_gate(
            quote_age_ms=300_000, completeness_pct=0.0,
            provider_healthy=False, timestamp_valid=False,
        )

        assert perfect.confidenceScore > degraded.confidenceScore > failed.confidenceScore, (
            "Perfect > Degraded > Failed in confidence score"
        )
        assert perfect.signalEngineAllowed is True
        assert failed.signalEngineAllowed is False
