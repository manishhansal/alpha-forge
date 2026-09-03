"""
Tests for data quality scoring and signal safety gate — Phases 52-55.
"""

from __future__ import annotations

import pytest

from src.core.data_quality import (
    build_quality_gate,
    check_strategy_data_requirements,
    compute_confidence_score,
)
from src.core.schemas_v2 import DataQuality, FreshnessClass, StrategyDataRequirements


class TestComputeConfidenceScore:
    def test_max_is_95_not_100(self) -> None:
        """Confidence never reaches 100 — inherent uncertainty in market data."""
        score = compute_confidence_score(
            freshness_class=FreshnessClass.FRESH,
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
            cross_source_agreement=1.0,
            sequence_integrity=True,
        )
        assert score <= 95, "Confidence must never reach 100"
        assert score >= 90, "Perfect inputs should yield near-max score"

    def test_stale_data_reduces_score(self) -> None:
        fresh_score = compute_confidence_score(
            FreshnessClass.FRESH, 1.0, True, True
        )
        stale_score = compute_confidence_score(
            FreshnessClass.STALE, 1.0, True, True
        )
        assert stale_score < fresh_score

    def test_expired_data_has_low_score(self) -> None:
        score = compute_confidence_score(
            FreshnessClass.EXPIRED, 0.5, False, False
        )
        assert score < 30

    def test_incomplete_data_reduces_score(self) -> None:
        full_score = compute_confidence_score(
            FreshnessClass.FRESH, 1.0, True, True
        )
        partial_score = compute_confidence_score(
            FreshnessClass.FRESH, 0.5, True, True
        )
        assert partial_score < full_score

    def test_provider_unhealthy_reduces_score(self) -> None:
        healthy_score = compute_confidence_score(
            FreshnessClass.FRESH, 1.0, True, True
        )
        unhealthy_score = compute_confidence_score(
            FreshnessClass.FRESH, 1.0, False, True
        )
        assert unhealthy_score < healthy_score

    def test_sequence_integrity_penalty(self) -> None:
        good_score = compute_confidence_score(
            FreshnessClass.FRESH, 1.0, True, True, sequence_integrity=True
        )
        bad_score = compute_confidence_score(
            FreshnessClass.FRESH, 1.0, True, True, sequence_integrity=False
        )
        assert bad_score < good_score

    def test_score_is_bounded_0_to_95(self) -> None:
        for freshness in FreshnessClass:
            for complete in [0.0, 0.5, 1.0]:
                for provider in [True, False]:
                    score = compute_confidence_score(freshness, complete, provider, True)
                    assert 0 <= score <= 95, f"Score {score} out of bounds"


class TestBuildQualityGate:
    def test_fresh_data_allows_signals(self) -> None:
        gate = build_quality_gate(
            quote_age_ms=3_000,  # 3 seconds
            symbol="NIFTY",
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
        )
        assert gate.signalEngineAllowed

    def test_stale_data_blocks_signals(self) -> None:
        gate = build_quality_gate(
            quote_age_ms=60_000,  # 60 seconds — stale
            symbol="NIFTY",
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
        )
        assert not gate.signalEngineAllowed
        assert gate.blockReason is not None

    def test_provider_unhealthy_blocks_signals(self) -> None:
        gate = build_quality_gate(
            quote_age_ms=3_000,
            provider_healthy=False,
        )
        assert not gate.signalEngineAllowed

    def test_invalid_timestamp_blocks_signals(self) -> None:
        gate = build_quality_gate(
            quote_age_ms=3_000,
            timestamp_valid=False,
        )
        assert not gate.signalEngineAllowed

    def test_low_completeness_blocks_signals(self) -> None:
        gate = build_quality_gate(
            quote_age_ms=3_000,
            completeness_pct=0.5,  # below 0.8 threshold
        )
        assert not gate.signalEngineAllowed

    def test_quality_gate_has_confidence_score(self) -> None:
        gate = build_quality_gate(quote_age_ms=3_000)
        assert 0 <= gate.confidenceScore <= 95

    def test_gate_quality_field(self) -> None:
        fresh_gate = build_quality_gate(
            quote_age_ms=3_000,
            completeness_pct=1.0,
            provider_healthy=True,
            timestamp_valid=True,
        )
        assert fresh_gate.quality == DataQuality.VALID


class TestStrategyDataRequirements:
    def test_momentum_strategy_passes_with_fresh_data(self) -> None:
        req = StrategyDataRequirements(
            strategyId="momentum_v1",
            strategyName="Momentum",
            requiredDataTypes=["PRICE", "VOLUME"],
            minConfidenceScore=60,
            maxQuoteAgeMs=15_000,
            requiresOI=False,
            requiresOptionChain=False,
            requiresConfirmedCandle=False,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=5_000,
            confidence_score=80,
            candle_confirmed=True,
        )
        assert ok
        assert not reasons

    def test_oi_strategy_fails_without_oi(self) -> None:
        req = StrategyDataRequirements(
            strategyId="oi_v1",
            strategyName="OI Strategy",
            requiredDataTypes=["PRICE", "OI"],
            minConfidenceScore=60,
            maxQuoteAgeMs=10_000,
            requiresOI=True,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=5_000,
            confidence_score=75,
            oi_available=False,
        )
        assert not ok
        assert any("oi" in r.lower() for r in reasons)

    def test_breakout_strategy_requires_confirmed_candle(self) -> None:
        req = StrategyDataRequirements(
            strategyId="breakout_v1",
            strategyName="Breakout",
            requiredDataTypes=["PRICE", "VOLUME", "CANDLE"],
            minConfidenceScore=70,
            maxQuoteAgeMs=10_000,
            requiresConfirmedCandle=True,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=5_000,
            confidence_score=80,
            candle_confirmed=False,  # partial candle
        )
        assert not ok
        assert any("candle" in r.lower() for r in reasons)

    def test_low_confidence_blocks_strategy(self) -> None:
        req = StrategyDataRequirements(
            strategyId="test",
            strategyName="Test",
            requiredDataTypes=["PRICE"],
            minConfidenceScore=70,
        )
        ok, reasons = check_strategy_data_requirements(
            req,
            quote_age_ms=5_000,
            confidence_score=50,  # below threshold
        )
        assert not ok
        assert any("confidence" in r.lower() for r in reasons)
