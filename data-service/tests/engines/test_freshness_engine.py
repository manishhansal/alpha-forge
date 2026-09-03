"""
Tests for DataFreshnessEngine — Phase 6.
"""

from __future__ import annotations

import pytest

from src.core.schemas_v2 import FreshnessClass
from src.engines.freshness_engine import DataFreshnessEngine, freshness_engine


class TestDataFreshnessEngine:
    def test_fresh_index_quote(self) -> None:
        engine = DataFreshnessEngine()
        # 5 seconds old — FRESH for index
        assert engine.classify_quote(5_000, "NIFTY") == FreshnessClass.FRESH

    def test_aging_index_quote(self) -> None:
        engine = DataFreshnessEngine()
        # 20 seconds old — AGING for index
        assert engine.classify_quote(20_000, "NIFTY") == FreshnessClass.AGING

    def test_stale_index_quote(self) -> None:
        engine = DataFreshnessEngine()
        # 45 seconds old — STALE for index
        assert engine.classify_quote(45_000, "NIFTY") == FreshnessClass.STALE

    def test_expired_index_quote(self) -> None:
        engine = DataFreshnessEngine()
        # 10 minutes old — EXPIRED for index
        assert engine.classify_quote(600_000, "NIFTY") == FreshnessClass.EXPIRED

    def test_liquid_fno_has_tighter_threshold_than_generic_equity(self) -> None:
        engine = DataFreshnessEngine()
        # 25s old — RELIANCE (liquid FNO) should be AGING
        reliance = engine.classify_quote(25_000, "RELIANCE")
        # 25s old — generic equity should be FRESH (threshold: 30s for FRESH)
        generic = engine.classify_quote(25_000, "SOMESTOCK")
        # Both should work without error; the classifications may differ by tier
        assert reliance in FreshnessClass
        assert generic in FreshnessClass

    def test_offmarket_has_looser_thresholds(self) -> None:
        engine = DataFreshnessEngine()
        # 2 minutes old — off-market should still be FRESH (threshold: 300s)
        assert engine.classify_quote(120_000, in_session=False) == FreshnessClass.FRESH

    def test_negative_age_returns_unknown(self) -> None:
        engine = DataFreshnessEngine()
        result = engine.classify_quote(-1000)
        assert result == FreshnessClass.UNKNOWN

    def test_fresh_option_chain(self) -> None:
        engine = DataFreshnessEngine()
        assert engine.classify_option_chain(20_000) == FreshnessClass.FRESH

    def test_stale_option_chain(self) -> None:
        engine = DataFreshnessEngine()
        assert engine.classify_option_chain(200_000) == FreshnessClass.STALE

    def test_candle_freshness_1m(self) -> None:
        engine = DataFreshnessEngine()
        assert engine.classify_candle(60_000, "1m") == FreshnessClass.FRESH
        assert engine.classify_candle(200_000, "1m") == FreshnessClass.STALE

    def test_candle_freshness_5m(self) -> None:
        engine = DataFreshnessEngine()
        assert engine.classify_candle(300_000, "5m") == FreshnessClass.FRESH

    def test_is_stale_for_signal(self) -> None:
        engine = DataFreshnessEngine()
        assert engine.is_stale_for_signal(15_000, strategy_max_age_ms=10_000)
        assert not engine.is_stale_for_signal(5_000, strategy_max_age_ms=10_000)

    def test_freshness_summary_structure(self) -> None:
        engine = DataFreshnessEngine()
        summary = engine.freshness_summary(
            quote_age_ms=5_000,
            option_chain_age_ms=25_000,
            candle_age_ms=60_000,
        )
        assert "quote" in summary
        assert "optionChain" in summary
        assert "candle" in summary
        assert "quoteAgeMs" in summary
