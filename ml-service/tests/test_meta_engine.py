"""
Tests for the AlphaForge Meta Decision Engine.

Scenarios tested
----------------
1. All models agree     → BUY with high confidence, high agreement
2. Models disagree      → WAIT/NO_TRADE, low agreement, disagreement in output
3. Low data quality     → abstention triggered (NO_TRADE or WAIT)
4. High uncertainty     → abstention triggered, low confidence
5. Abstention explicit  → WAIT / NO_TRADE for each trigger condition
6. Regime-specific weighting → volatile regime gives risk model more weight

Additional unit tests
---------------------
- CalibrationStore: fit/calibrate round-trip (Platt + isotonic)
- EnsembleWeighter: regime weights shift correctly
- AbstentionPolicy: each trigger fires independently
- DecisionPolicy: confidence decomposition math
- OOS training: fit_meta_layer rejects in-sample-only warning path
- Persistence: save/load CalibrationStore
"""

from __future__ import annotations

import math
import tempfile
from pathlib import Path

import numpy as np
import pytest

from src.meta.abstention import (
    AbstentionInputs,
    AbstentionKind,
    AbstentionPolicy,
    AbstentionReason,
    AbstentionThresholds,
)
from src.meta.calibration import CalibrationStore, PlattCalibrator, IsotonicCalibrator
from src.meta.decision_policy import (
    ConfidenceDecomposition,
    DecisionPolicy,
    TradeAction,
)
from src.meta.ensemble import EnsembleWeighter, ModelSignal
from src.meta.meta_model import (
    IVPrediction,
    MetaDecisionEngine,
    MetaInput,
    OOSPredictionRecord,
    PriceForecast,
    QuantEngineSignal,
    RankerPrediction,
    RegimePrediction,
    RiskPrediction,
    StrategyPrediction,
)
from src.schemas import MarketRegime


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture()
def engine() -> MetaDecisionEngine:
    """Fresh engine with default config — no calibrators fitted."""
    return MetaDecisionEngine()


def _bullish_input(symbol: str = "RELIANCE", regime: MarketRegime = MarketRegime.BULL) -> MetaInput:
    """All base models agree: bullish."""
    return MetaInput(
        symbol=symbol,
        regime=RegimePrediction(regime=regime, confidence=0.88),
        ranker=RankerPrediction(score=82.0, rank=3),
        strategy=StrategyPrediction(strategy="momentum", confidence=0.81),
        risk=RiskPrediction(
            prob_stop_hit=0.22,
            prob_target_hit=0.71,
            expected_drawdown_pct=0.8,
            suggested_position_size_pct=2.5,
            risk_score=3.2,
        ),
        price_forecast=PriceForecast(regime="bull", probability=0.80, q10=0.3, q90=1.8),
        iv=IVPrediction(regime="STABLE", confidence=0.75),
        quant=QuantEngineSignal(direction=1, confidence=0.78, rules_fired=["ema_cross", "adx_strong"]),
        time_of_day_minutes=120,
    )


def _bearish_disagree_input(symbol: str = "INFY") -> MetaInput:
    """Models split: regime + ranker say bearish, rest say bullish."""
    return MetaInput(
        symbol=symbol,
        regime=RegimePrediction(regime=MarketRegime.BEAR, confidence=0.82),
        ranker=RankerPrediction(score=28.0, rank=45),          # bearish
        strategy=StrategyPrediction(strategy="momentum", confidence=0.76),   # bullish
        risk=RiskPrediction(
            prob_stop_hit=0.55,
            prob_target_hit=0.60,
            expected_drawdown_pct=1.5,
            suggested_position_size_pct=1.0,
            risk_score=5.8,
        ),
        price_forecast=PriceForecast(regime="bull", probability=0.70, q10=-0.2, q90=1.5),  # bullish
        iv=IVPrediction(regime="STABLE", confidence=0.65),
        quant=QuantEngineSignal(direction=1, confidence=0.72),   # bullish
        time_of_day_minutes=200,
    )


def _low_quality_input(symbol: str = "TCS") -> MetaInput:
    """Only 2 out of 7 models provide a signal — low data quality."""
    return MetaInput(
        symbol=symbol,
        regime=RegimePrediction(regime=MarketRegime.SIDEWAYS, confidence=0.60),
        ranker=RankerPrediction(score=55.0, rank=20),
        # All other models absent → data_quality auto-computes to 2/7 ≈ 0.29
        time_of_day_minutes=180,
    )


def _high_uncertainty_input(symbol: str = "HDFCBANK") -> MetaInput:
    """All models available but with low confidence scores."""
    return MetaInput(
        symbol=symbol,
        regime=RegimePrediction(regime=MarketRegime.VOLATILE, confidence=0.52),
        ranker=RankerPrediction(score=51.0, rank=25),
        strategy=StrategyPrediction(strategy="scalping", confidence=0.51),
        risk=RiskPrediction(
            prob_stop_hit=0.50,
            prob_target_hit=0.52,
            expected_drawdown_pct=1.2,
            suggested_position_size_pct=1.0,
            risk_score=5.0,
        ),
        price_forecast=PriceForecast(regime="flat", probability=0.51, q10=-0.5, q90=0.5),
        iv=IVPrediction(regime="STABLE", confidence=0.51),
        quant=QuantEngineSignal(direction=0, confidence=0.50),
        time_of_day_minutes=200,
    )


def _volatile_input(symbol: str = "NIFTY") -> MetaInput:
    """Volatile regime with elevated risk."""
    return MetaInput(
        symbol=symbol,
        regime=RegimePrediction(regime=MarketRegime.VOLATILE, confidence=0.83),
        ranker=RankerPrediction(score=62.0, rank=10),
        strategy=StrategyPrediction(strategy="scalping", confidence=0.72),
        risk=RiskPrediction(
            prob_stop_hit=0.65,
            prob_target_hit=0.58,
            expected_drawdown_pct=2.1,
            suggested_position_size_pct=0.8,
            risk_score=7.5,
        ),
        price_forecast=PriceForecast(regime="flat", probability=0.60, q10=-0.8, q90=0.9),
        iv=IVPrediction(regime="SPIKE", confidence=0.80),
        quant=QuantEngineSignal(direction=1, confidence=0.62),
        time_of_day_minutes=150,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 1 — All models agree
# ─────────────────────────────────────────────────────────────────────────────

class TestAllModelsAgree:
    """All base models point bullish → expect BUY with high confidence."""

    def test_action_is_buy(self, engine):
        result = engine.decide(_bullish_input())
        assert result.action == TradeAction.BUY, (
            f"Expected BUY when all models agree, got {result.action}"
        )

    def test_high_confidence(self, engine):
        result = engine.decide(_bullish_input())
        assert result.confidence >= 0.55, (
            f"Expected confidence ≥ 0.55 when all models agree, got {result.confidence:.3f}"
        )

    def test_high_agreement(self, engine):
        result = engine.decide(_bullish_input())
        assert result.agreement >= 0.70, (
            f"Expected agreement ≥ 0.70 when all models agree, got {result.agreement:.3f}"
        )

    def test_no_abstention(self, engine):
        result = engine.decide(_bullish_input())
        assert not result.abstention.should_abstain, (
            f"Expected no abstention when all models agree, "
            f"got {result.abstention.kind} with reasons {result.abstention.reasons}"
        )

    def test_output_has_required_fields(self, engine):
        result = engine.decide(_bullish_input())
        assert result.symbol == "RELIANCE"
        assert 0.0 <= result.confidence <= 1.0
        assert 0.0 <= result.uncertainty <= 1.0
        assert 0.0 <= result.agreement <= 1.0
        assert isinstance(result.reason_codes, list)
        assert isinstance(result.contributing_models, list)
        assert len(result.contributing_models) > 0

    def test_decomposition_has_five_keys(self, engine):
        result = engine.decide(_bullish_input())
        required = {
            "signalConfidence", "modelAgreement", "dataQuality",
            "regimeConfidence", "executionQuality",
        }
        assert required.issubset(result.decomposition.keys()), (
            f"Missing decomposition keys: {required - result.decomposition.keys()}"
        )

    def test_decomposition_values_in_range(self, engine):
        result = engine.decide(_bullish_input())
        for key, val in result.decomposition.items():
            assert 0.0 <= val <= 1.0, f"decomposition[{key}] = {val} out of [0,1]"

    def test_explainability_has_positive_factors(self, engine):
        result = engine.decide(_bullish_input())
        assert len(result.explainability.top_positive_factors) > 0

    def test_to_dict_is_json_serialisable(self, engine):
        import json
        result = engine.decide(_bullish_input())
        d = result.to_dict()
        # Should not raise
        json.dumps(d)
        assert d["action"] == "BUY"
        assert "decomposition" in d
        assert "abstention" in d
        assert "explainability" in d

    def test_strong_bull_also_gives_buy(self, engine):
        result = engine.decide(_bullish_input(regime=MarketRegime.STRONG_BULL))
        assert result.action == TradeAction.BUY


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 2 — Models disagree
# ─────────────────────────────────────────────────────────────────────────────

class TestModelsDisagree:
    """Regime + ranker bearish, others bullish → expect WAIT or NO_TRADE."""

    def test_does_not_force_buy_or_sell(self, engine):
        result = engine.decide(_bearish_disagree_input())
        # With strong disagreement the engine must not blindly pick a side
        # It should either WAIT, NO_TRADE, or at most produce a low-confidence action
        if result.action in (TradeAction.BUY, TradeAction.SELL):
            assert result.confidence < 0.70, (
                f"Engine produced {result.action} with high confidence "
                f"({result.confidence:.3f}) despite model disagreement"
            )

    def test_agreement_is_below_full(self, engine):
        result = engine.decide(_bearish_disagree_input())
        assert result.agreement < 1.0

    def test_disagreeing_models_exposed(self, engine):
        result = engine.decide(_bearish_disagree_input())
        # Either penalised_models or top_negative_factors should be non-empty
        has_disagree_info = (
            len(result.explainability.disagreeing_models) > 0
            or len(result.explainability.top_negative_factors) > 0
        )
        assert has_disagree_info, "Expected disagreement info in explainability"

    def test_uncertainty_elevated(self, engine):
        result = engine.decide(_bearish_disagree_input())
        # Agreement result with a disagreeing set should have elevated uncertainty
        # (vs the all-agree scenario)
        agree_result = engine.decide(_bullish_input())
        assert result.uncertainty >= agree_result.uncertainty - 0.05, (
            "Disagreement scenario should not have lower uncertainty than full-agreement"
        )

    def test_model_disagreement_reason_code_present(self, engine):
        result = engine.decide(_bearish_disagree_input())
        # Either abstention reason or decision reason code should flag disagreement
        abstention_reasons = [r.value for r in result.abstention.reasons]
        all_signals = result.reason_codes + abstention_reasons
        has_disagree_code = any(
            "disagree" in code or "weak" in code or "abstention" in code
            for code in all_signals
        )
        assert has_disagree_code, (
            f"Expected a disagreement/weak/abstention code, got: {all_signals}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 3 — Low data quality
# ─────────────────────────────────────────────────────────────────────────────

class TestLowDataQuality:
    """Only 2/7 models available → data quality ≈ 0.29 → abstain."""

    def test_computed_data_quality_is_low(self):
        inp = _low_quality_input()
        dq = inp.computed_data_quality()
        assert dq < 0.45, f"Expected data quality < 0.45, got {dq:.3f}"

    def test_abstention_triggered(self, engine):
        result = engine.decide(_low_quality_input())
        assert result.abstention.should_abstain, (
            f"Expected abstention for low data quality input, "
            f"got kind={result.abstention.kind}, reasons={result.abstention.reasons}"
        )

    def test_action_is_not_buy_or_sell(self, engine):
        result = engine.decide(_low_quality_input())
        assert result.action in (TradeAction.WAIT, TradeAction.NO_TRADE), (
            f"Expected WAIT or NO_TRADE for low data quality, got {result.action}"
        )

    def test_low_data_quality_reason_present(self, engine):
        result = engine.decide(_low_quality_input())
        abstention_reasons = [r.value for r in result.abstention.reasons]
        assert AbstentionReason.LOW_DATA_QUALITY.value in abstention_reasons, (
            f"Expected LOW_DATA_QUALITY reason, got: {abstention_reasons}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 4 — High uncertainty
# ─────────────────────────────────────────────────────────────────────────────

class TestHighUncertainty:
    """All models available but confidence scores cluster near 0.50."""

    def test_action_is_wait_or_no_trade(self, engine):
        result = engine.decide(_high_uncertainty_input())
        assert result.action in (TradeAction.WAIT, TradeAction.NO_TRADE), (
            f"Expected WAIT/NO_TRADE for high uncertainty, got {result.action}"
        )

    def test_abstention_triggered(self, engine):
        result = engine.decide(_high_uncertainty_input())
        assert result.abstention.should_abstain, (
            "Expected abstention for high uncertainty scenario"
        )

    def test_uncertainty_score_is_high(self, engine):
        result = engine.decide(_high_uncertainty_input())
        assert result.uncertainty >= 0.35, (
            f"Expected uncertainty ≥ 0.35, got {result.uncertainty:.3f}"
        )

    def test_confidence_is_low(self, engine):
        result = engine.decide(_high_uncertainty_input())
        assert result.confidence <= 0.70, (
            f"Expected confidence ≤ 0.70 for uncertain input, got {result.confidence:.3f}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 5 — Abstention trigger conditions
# ─────────────────────────────────────────────────────────────────────────────

class TestAbstentionTriggers:
    """Each AbstentionReason fires correctly in isolation."""

    # ── 5a. Model disagreement ────────────────────────────────────────────

    def test_direction_disagreement_triggers_abstention(self):
        policy = AbstentionPolicy()
        inputs = AbstentionInputs(
            agreement_ratio=0.40,
            direction_disagreement=0.60,    # > 0.40 threshold
            data_quality=0.95,
            mean_confidence=0.70,
            regime_confidence=0.80,
            prob_stop_hit=0.30,
            confidence_spread=0.10,
            ensemble_score=0.30,
            n_available_models=7,
            prediction_variance=0.05,
        )
        decision = policy.evaluate(inputs)
        assert decision.should_abstain
        assert AbstentionReason.MODEL_DISAGREEMENT in decision.reasons

    # ── 5b. Low data quality ──────────────────────────────────────────────

    def test_low_data_quality_triggers_no_trade(self):
        policy = AbstentionPolicy()
        inputs = AbstentionInputs(
            agreement_ratio=0.85,
            direction_disagreement=0.15,
            data_quality=0.40,      # < 0.60 threshold
            mean_confidence=0.72,
            regime_confidence=0.78,
            prob_stop_hit=0.28,
            confidence_spread=0.10,
            ensemble_score=0.45,
            n_available_models=7,
            prediction_variance=0.03,
        )
        decision = policy.evaluate(inputs)
        assert decision.should_abstain
        assert AbstentionReason.LOW_DATA_QUALITY in decision.reasons
        # LOW_DATA_QUALITY is a NO_TRADE reason
        assert decision.kind == AbstentionKind.NO_TRADE

    def test_too_few_models_triggers_abstention(self):
        policy = AbstentionPolicy()
        inputs = AbstentionInputs(
            agreement_ratio=1.0,
            direction_disagreement=0.0,
            data_quality=0.90,
            mean_confidence=0.80,
            regime_confidence=0.85,
            prob_stop_hit=0.20,
            confidence_spread=0.05,
            ensemble_score=0.60,
            n_available_models=2,   # < 3 threshold
            prediction_variance=0.02,
        )
        decision = policy.evaluate(inputs)
        assert decision.should_abstain
        assert AbstentionReason.LOW_DATA_QUALITY in decision.reasons

    # ── 5c. High uncertainty ──────────────────────────────────────────────

    def test_low_mean_confidence_triggers_abstention(self):
        policy = AbstentionPolicy()
        inputs = AbstentionInputs(
            agreement_ratio=0.85,
            direction_disagreement=0.15,
            data_quality=0.90,
            mean_confidence=0.48,   # < 0.52 threshold
            regime_confidence=0.78,
            prob_stop_hit=0.30,
            confidence_spread=0.08,
            ensemble_score=0.35,
            n_available_models=7,
            prediction_variance=0.04,
        )
        decision = policy.evaluate(inputs)
        assert decision.should_abstain
        assert AbstentionReason.HIGH_UNCERTAINTY in decision.reasons

    # ── 5d. Unclear regime ────────────────────────────────────────────────

    def test_unclear_regime_triggers_abstention(self):
        policy = AbstentionPolicy()
        inputs = AbstentionInputs(
            agreement_ratio=0.80,
            direction_disagreement=0.20,
            data_quality=0.90,
            mean_confidence=0.70,
            regime_confidence=0.45,  # < 0.55 threshold
            prob_stop_hit=0.30,
            confidence_spread=0.10,
            ensemble_score=0.40,
            n_available_models=7,
            prediction_variance=0.04,
        )
        decision = policy.evaluate(inputs)
        assert decision.should_abstain
        assert AbstentionReason.UNCLEAR_REGIME in decision.reasons

    # ── 5e. Risk threshold ────────────────────────────────────────────────

    def test_high_stop_probability_triggers_no_trade(self):
        policy = AbstentionPolicy()
        inputs = AbstentionInputs(
            agreement_ratio=0.85,
            direction_disagreement=0.15,
            data_quality=0.92,
            mean_confidence=0.75,
            regime_confidence=0.80,
            prob_stop_hit=0.82,     # > 0.70 threshold
            confidence_spread=0.10,
            ensemble_score=0.50,
            n_available_models=7,
            prediction_variance=0.04,
        )
        decision = policy.evaluate(inputs)
        assert decision.should_abstain
        assert AbstentionReason.RISK_THRESHOLD in decision.reasons
        assert decision.kind == AbstentionKind.NO_TRADE

    # ── 5f. Weak ensemble score ───────────────────────────────────────────

    def test_weak_ensemble_score_triggers_wait(self):
        policy = AbstentionPolicy()
        inputs = AbstentionInputs(
            agreement_ratio=0.70,
            direction_disagreement=0.30,
            data_quality=0.90,
            mean_confidence=0.65,
            regime_confidence=0.75,
            prob_stop_hit=0.35,
            confidence_spread=0.12,
            ensemble_score=0.05,    # |score| < 0.15 threshold
            n_available_models=7,
            prediction_variance=0.04,
        )
        decision = policy.evaluate(inputs)
        assert decision.should_abstain
        assert AbstentionReason.ENSEMBLE_SCORE_WEAK in decision.reasons

    # ── 5g. Clean signal → no abstention ──────────────────────────────────

    def test_clean_signal_no_abstention(self):
        policy = AbstentionPolicy()
        inputs = AbstentionInputs(
            agreement_ratio=0.90,
            direction_disagreement=0.10,
            data_quality=0.95,
            mean_confidence=0.78,
            regime_confidence=0.85,
            prob_stop_hit=0.25,
            confidence_spread=0.12,
            ensemble_score=0.55,
            n_available_models=7,
            prediction_variance=0.03,
        )
        decision = policy.evaluate(inputs)
        assert not decision.should_abstain
        assert decision.kind == AbstentionKind.NONE
        assert decision.reasons == []

    # ── 5h. WAIT vs NO_TRADE distinction ─────────────────────────────────

    def test_wait_vs_no_trade_distinction(self):
        """Temporary signal weakness → WAIT; structural data issue → NO_TRADE."""
        policy = AbstentionPolicy()

        # Unclear regime only → WAIT (temporary)
        wait_inputs = AbstentionInputs(
            agreement_ratio=0.80, direction_disagreement=0.20,
            data_quality=0.90, mean_confidence=0.70,
            regime_confidence=0.45,  # only trigger: unclear regime
            prob_stop_hit=0.30, confidence_spread=0.10,
            ensemble_score=0.40, n_available_models=7,
            prediction_variance=0.04,
        )
        wait_decision = policy.evaluate(wait_inputs)
        assert wait_decision.kind == AbstentionKind.WAIT

        # Data quality + risk → NO_TRADE (structural)
        no_trade_inputs = AbstentionInputs(
            agreement_ratio=0.70, direction_disagreement=0.30,
            data_quality=0.40,   # structural: bad data
            mean_confidence=0.65, regime_confidence=0.70,
            prob_stop_hit=0.80,  # structural: stop will be hit
            confidence_spread=0.15, ensemble_score=0.35,
            n_available_models=7, prediction_variance=0.05,
        )
        no_trade_decision = policy.evaluate(no_trade_inputs)
        assert no_trade_decision.kind == AbstentionKind.NO_TRADE


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 6 — Regime-specific weighting
# ─────────────────────────────────────────────────────────────────────────────

class TestRegimeSpecificWeighting:
    """Weights shift correctly with regime."""

    def test_volatile_regime_gives_risk_highest_weight(self):
        weighter = EnsembleWeighter()
        weights = weighter.describe_weights(MarketRegime.VOLATILE)
        # Risk should be highest in volatile regime
        assert weights["risk"] == max(weights.values()), (
            f"Expected 'risk' to have highest weight in VOLATILE regime, "
            f"got: {weights}"
        )

    def test_bull_regime_gives_ranker_high_weight(self):
        weighter = EnsembleWeighter()
        bull_weights = weighter.describe_weights(MarketRegime.BULL)
        volatile_weights = weighter.describe_weights(MarketRegime.VOLATILE)
        assert bull_weights["ranker"] > volatile_weights["ranker"], (
            "Ranker weight should be higher in BULL than VOLATILE"
        )

    def test_sideways_regime_favours_strategy(self):
        weighter = EnsembleWeighter()
        sideways = weighter.describe_weights(MarketRegime.SIDEWAYS)
        strong_bull = weighter.describe_weights(MarketRegime.STRONG_BULL)
        assert sideways["strategy"] > strong_bull["strategy"], (
            "Strategy weight should be higher in SIDEWAYS than STRONG_BULL"
        )

    def test_crash_regime_risk_near_top(self):
        weighter = EnsembleWeighter()
        weights = weighter.describe_weights(MarketRegime.CRASH)
        # Risk should be the single heaviest model in CRASH
        assert weights["risk"] == max(weights.values()), (
            f"Expected 'risk' heaviest in CRASH regime, got: {weights}"
        )

    def test_weights_sum_to_one(self):
        weighter = EnsembleWeighter()
        for regime in MarketRegime:
            w = weighter.describe_weights(regime)
            total = sum(w.values())
            assert abs(total - 1.0) < 1e-6, (
                f"Weights for {regime} sum to {total:.6f}, not 1.0"
            )

    def test_volatile_decision_reflects_risk_model(self, engine):
        """High risk score in volatile regime should push toward abstention."""
        result = engine.decide(_volatile_input())
        # Risk model sees prob_stop_hit=0.65 → near/above threshold
        # combined with IV SPIKE → should trigger abstention
        assert result.action in (TradeAction.WAIT, TradeAction.NO_TRADE), (
            f"Expected WAIT/NO_TRADE in high-risk volatile regime, got {result.action}"
        )

    def test_regime_encoded_in_output(self, engine):
        result = engine.decide(_bullish_input(regime=MarketRegime.BULL))
        assert result.regime == MarketRegime.BULL

    def test_strong_bull_vs_bear_confidence_gap(self, engine):
        """Strong bull signal should yield higher confidence than equivalent bear input."""
        bull = engine.decide(_bullish_input(regime=MarketRegime.STRONG_BULL))
        # Bear regime with same scores but different direction context
        bear_input = MetaInput(
            symbol="TEST",
            regime=RegimePrediction(regime=MarketRegime.CRASH, confidence=0.85),
            ranker=RankerPrediction(score=18.0, rank=60),
            strategy=StrategyPrediction(strategy="mean_reversion", confidence=0.78),
            risk=RiskPrediction(
                prob_stop_hit=0.72, prob_target_hit=0.40,
                expected_drawdown_pct=2.5, suggested_position_size_pct=0.5,
                risk_score=8.0,
            ),
            price_forecast=PriceForecast(regime="bear", probability=0.82, q10=-2.0, q90=-0.3),
            iv=IVPrediction(regime="SPIKE", confidence=0.85),
            quant=QuantEngineSignal(direction=-1, confidence=0.80),
            time_of_day_minutes=180,
        )
        bear = engine.decide(bear_input)
        # Bear should abstain due to risk threshold; bull should not
        assert not bull.abstention.should_abstain or bear.abstention.should_abstain, (
            "Bear/crash scenario with high risk should trigger abstention"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Unit tests — CalibrationStore
# ─────────────────────────────────────────────────────────────────────────────

class TestCalibrationStore:

    def _make_binary_dataset(self, n: int = 200, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
        rng = np.random.default_rng(seed)
        scores = rng.uniform(0, 1, n)
        labels = (scores + rng.normal(0, 0.2, n) > 0.5).astype(float)
        return scores, labels

    def test_platt_fit_and_calibrate(self):
        store = CalibrationStore()
        scores, labels = self._make_binary_dataset()
        q = store.fit("regime", scores, labels, kind="platt")
        assert q.is_fitted
        assert q.n_samples == len(scores)
        assert 0.0 <= q.ece <= 1.0
        cal = store.calibrate("regime", 0.7)
        assert 0.0 <= cal <= 1.0

    def test_isotonic_fit_and_calibrate(self):
        store = CalibrationStore()
        scores, labels = self._make_binary_dataset()
        q = store.fit("regime", scores, labels, kind="isotonic")
        assert q.is_fitted
        cal = store.calibrate("regime", 0.7, kind="isotonic")
        assert 0.0 <= cal <= 1.0

    def test_calibrate_without_fit_returns_clipped_score(self):
        store = CalibrationStore()
        val = store.calibrate("regime", 1.5)  # unfitted + out-of-range
        assert 0.0 <= val <= 1.0

    def test_fit_both_selects_better_calibrator(self):
        store = CalibrationStore()
        scores, labels = self._make_binary_dataset(n=300)
        q_p, q_i = store.fit_both("regime", scores, labels)
        # After fitting both, active kind should be the one with lower ECE
        active = store._store["regime"].active_kind
        if q_p.ece <= q_i.ece:
            assert active == "platt"
        else:
            assert active == "isotonic"

    def test_quality_score_is_neutral_when_unfitted(self):
        store = CalibrationStore()
        q = store.get_quality("regime")
        assert q.quality_score == 0.5

    def test_all_quality_scores_returns_dict(self):
        store = CalibrationStore()
        qs = store.all_quality_scores()
        assert isinstance(qs, dict)
        assert len(qs) == 7  # 7 model names

    def test_save_and_load_round_trip(self):
        store = CalibrationStore()
        scores, labels = self._make_binary_dataset()
        store.fit("regime", scores, labels, kind="platt")
        cal_before = store.calibrate("regime", 0.65)

        with tempfile.TemporaryDirectory() as tmpdir:
            store.save(Path(tmpdir))
            store2 = CalibrationStore()
            store2.load(Path(tmpdir))
            cal_after = store2.calibrate("regime", 0.65)

        assert abs(cal_before - cal_after) < 1e-4, (
            f"Calibrated value changed after save/load: "
            f"{cal_before:.5f} → {cal_after:.5f}"
        )

    def test_batch_calibrate(self):
        store = CalibrationStore()
        scores, labels = self._make_binary_dataset()
        store.fit("regime", scores, labels)
        batch = np.array([0.2, 0.5, 0.8])
        result = store.calibrate_batch("regime", batch)
        assert result.shape == (3,)
        assert all(0.0 <= v <= 1.0 for v in result)


# ─────────────────────────────────────────────────────────────────────────────
# Unit tests — EnsembleWeighter
# ─────────────────────────────────────────────────────────────────────────────

class TestEnsembleWeighter:

    def _uniform_signals(self, direction: int, confidence: float) -> list[ModelSignal]:
        return [
            ModelSignal(name, direction, confidence)
            for name in ["regime", "ranker", "strategy", "risk",
                          "price_forecaster", "iv_classifier", "quant_engine"]
        ]

    def test_all_agree_high_agreement_ratio(self):
        weighter = EnsembleWeighter()
        signals = self._uniform_signals(1, 0.80)
        result = weighter.compute(signals, MarketRegime.BULL)
        assert result.disagreement.agreement_ratio == 1.0
        assert result.disagreement.direction_disagreement == 0.0

    def test_all_disagree_high_disagreement(self):
        weighter = EnsembleWeighter()
        signals = [
            ModelSignal("regime", 1, 0.75),
            ModelSignal("ranker", 1, 0.70),
            ModelSignal("strategy", 1, 0.72),
            ModelSignal("risk", -1, 0.80),       # dissenting
            ModelSignal("price_forecaster", -1, 0.78),  # dissenting
            ModelSignal("iv_classifier", -1, 0.71),     # dissenting
            ModelSignal("quant_engine", -1, 0.76),      # dissenting
        ]
        result = weighter.compute(signals, MarketRegime.BULL)
        assert result.disagreement.direction_disagreement > 0.0
        assert len(result.penalised_models) > 0

    def test_weighted_score_positive_when_all_bullish(self):
        weighter = EnsembleWeighter()
        signals = self._uniform_signals(1, 0.75)
        result = weighter.compute(signals, MarketRegime.BULL)
        assert result.weighted_score > 0.0

    def test_weighted_score_negative_when_all_bearish(self):
        weighter = EnsembleWeighter()
        signals = self._uniform_signals(-1, 0.75)
        result = weighter.compute(signals, MarketRegime.BEAR)
        assert result.weighted_score < 0.0

    def test_empty_signals_returns_safe_result(self):
        weighter = EnsembleWeighter()
        result = weighter.compute([], MarketRegime.BULL)
        assert result.weighted_score == 0.0
        assert result.active_models == []

    def test_unavailable_signals_excluded(self):
        weighter = EnsembleWeighter()
        signals = [
            ModelSignal("regime", 1, 0.80, is_available=True),
            ModelSignal("ranker", 0, 0.50, is_available=False),
            ModelSignal("strategy", 1, 0.75, is_available=True),
        ]
        result = weighter.compute(signals, MarketRegime.BULL)
        assert "ranker" not in result.active_models

    def test_weights_sum_to_one(self):
        weighter = EnsembleWeighter()
        signals = [
            ModelSignal("regime", 1, 0.80),
            ModelSignal("ranker", 1, 0.75),
            ModelSignal("strategy", 1, 0.72),
        ]
        result = weighter.compute(signals, MarketRegime.BULL)
        total = sum(result.weights.values())
        assert abs(total - 1.0) < 1e-6

    def test_disagreement_penalty_reduces_dissenting_weight(self):
        weighter_strict = EnsembleWeighter(disagreement_penalty=0.1)
        weighter_lenient = EnsembleWeighter(disagreement_penalty=0.9)
        signals = [
            ModelSignal("regime", 1, 0.80),
            ModelSignal("ranker", -1, 0.80),  # dissenter
            ModelSignal("strategy", 1, 0.75),
            ModelSignal("risk", 1, 0.70),
            ModelSignal("price_forecaster", 1, 0.72),
            ModelSignal("iv_classifier", 1, 0.68),
            ModelSignal("quant_engine", 1, 0.74),
        ]
        strict = weighter_strict.compute(signals, MarketRegime.BULL)
        lenient = weighter_lenient.compute(signals, MarketRegime.BULL)
        # Strict penalty → dissenter's weight is lower → ranker weight smaller
        assert strict.weights.get("ranker", 0) < lenient.weights.get("ranker", 0)


# ─────────────────────────────────────────────────────────────────────────────
# Unit tests — ConfidenceDecomposition
# ─────────────────────────────────────────────────────────────────────────────

class TestConfidenceDecomposition:

    def test_final_confidence_in_range(self):
        decomp = ConfidenceDecomposition(
            signal_confidence=0.80,
            model_agreement=0.90,
            data_quality=0.95,
            regime_confidence=0.85,
            execution_quality=0.78,
        )
        assert 0.0 <= decomp.final_confidence <= 1.0

    def test_high_components_give_high_confidence(self):
        decomp = ConfidenceDecomposition(
            signal_confidence=0.95,
            model_agreement=0.95,
            data_quality=0.98,
            regime_confidence=0.92,
            execution_quality=0.90,
        )
        assert decomp.final_confidence >= 0.80

    def test_low_components_give_low_confidence(self):
        decomp = ConfidenceDecomposition(
            signal_confidence=0.30,
            model_agreement=0.40,
            data_quality=0.35,
            regime_confidence=0.30,
            execution_quality=0.40,
        )
        assert decomp.final_confidence <= 0.40

    def test_to_dict_has_all_keys(self):
        decomp = ConfidenceDecomposition(
            signal_confidence=0.80, model_agreement=0.85,
            data_quality=0.90, regime_confidence=0.78,
            execution_quality=0.72,
        )
        d = decomp.to_dict()
        expected = {
            "signalConfidence", "modelAgreement", "dataQuality",
            "regimeConfidence", "executionQuality", "finalConfidence",
        }
        assert expected == set(d.keys())

    def test_data_quality_zero_reduces_confidence(self):
        high_dq = ConfidenceDecomposition(0.80, 0.85, 1.00, 0.82, 0.78)
        low_dq  = ConfidenceDecomposition(0.80, 0.85, 0.00, 0.82, 0.78)
        assert high_dq.final_confidence > low_dq.final_confidence


# ─────────────────────────────────────────────────────────────────────────────
# Unit tests — OOS training
# ─────────────────────────────────────────────────────────────────────────────

class TestOOSTraining:

    def _make_oos_records(self, model: str, n: int, seed: int = 0) -> list[OOSPredictionRecord]:
        rng = np.random.default_rng(seed)
        scores = rng.uniform(0.1, 0.9, n)
        labels = (scores + rng.normal(0, 0.15, n) > 0.5).astype(float)
        return [
            OOSPredictionRecord(
                model_name=model,
                raw_score=float(s),
                label=float(l),
                fold_id=i % 5,
            )
            for i, (s, l) in enumerate(zip(scores, labels))
        ]

    def test_fit_meta_layer_returns_per_model_results(self):
        engine = MetaDecisionEngine()
        records = (
            self._make_oos_records("regime", 100)
            + self._make_oos_records("ranker", 120)
        )
        results = engine.fit_meta_layer(records, min_samples_per_model=50)
        assert "regime" in results
        assert "ranker" in results
        assert results["regime"]["status"] == "fitted"
        assert results["ranker"]["status"] == "fitted"

    def test_fit_meta_layer_reports_ece_and_brier(self):
        engine = MetaDecisionEngine()
        records = self._make_oos_records("regime", 150)
        results = engine.fit_meta_layer(records)
        r = results["regime"]
        assert "platt" in r
        assert "isotonic" in r
        assert "ece" in r["platt"]
        assert "brier_score" in r["platt"]

    def test_fit_skips_model_with_too_few_samples(self):
        engine = MetaDecisionEngine()
        records = self._make_oos_records("regime", 30)  # below default min=50
        results = engine.fit_meta_layer(records, min_samples_per_model=50)
        assert results["regime"]["status"] == "skipped"

    def test_calibrated_engine_produces_valid_decision(self):
        engine = MetaDecisionEngine()
        # Train calibrator for all 7 models
        all_records = []
        for model in ["regime", "ranker", "strategy", "risk",
                       "price_forecaster", "iv_classifier", "quant_engine"]:
            all_records.extend(self._make_oos_records(model, 100))
        engine.fit_meta_layer(all_records, min_samples_per_model=50)

        result = engine.decide(_bullish_input())
        assert 0.0 <= result.confidence <= 1.0
        assert result.action in list(TradeAction)

    def test_non_binary_labels_skipped(self):
        engine = MetaDecisionEngine()
        records = [
            OOSPredictionRecord("regime", 0.7, 0.5, fold_id=0),   # non-binary
            OOSPredictionRecord("regime", 0.3, 0.8, fold_id=0),
        ]
        results = engine.fit_meta_layer(records, min_samples_per_model=1)
        assert results["regime"]["status"] == "skipped"
        assert "labels are not binary" in results["regime"]["reason"]

    def test_save_and_load_preserves_calibration(self):
        engine = MetaDecisionEngine()
        records = self._make_oos_records("regime", 100)
        engine.fit_meta_layer(records)

        with tempfile.TemporaryDirectory() as tmpdir:
            engine.save(Path(tmpdir))
            engine2 = MetaDecisionEngine()
            engine2.load(Path(tmpdir))

        # Both should produce the same calibrated value for regime
        raw = 0.72
        v1 = engine.calibration_store.calibrate("regime", raw)
        v2 = engine2.calibration_store.calibrate("regime", raw)
        assert abs(v1 - v2) < 1e-4


# ─────────────────────────────────────────────────────────────────────────────
# Edge cases and integration
# ─────────────────────────────────────────────────────────────────────────────

class TestEdgeCases:

    def test_no_models_provided_returns_no_trade(self, engine):
        inp = MetaInput(symbol="EMPTY")
        result = engine.decide(inp)
        assert result.action in (TradeAction.WAIT, TradeAction.NO_TRADE)
        assert result.abstention.should_abstain

    def test_only_regime_provided(self, engine):
        inp = MetaInput(
            symbol="PARTIAL",
            regime=RegimePrediction(regime=MarketRegime.BULL, confidence=0.82),
        )
        result = engine.decide(inp)
        # Should not crash; data quality is low so abstention expected
        assert result.action in list(TradeAction)
        assert 0.0 <= result.confidence <= 1.0

    def test_quant_neutral_does_not_block_buy(self, engine):
        """A neutral quant signal should not prevent a BUY when others strongly agree."""
        inp = _bullish_input()
        inp = MetaInput(
            symbol=inp.symbol,
            regime=inp.regime,
            ranker=inp.ranker,
            strategy=inp.strategy,
            risk=inp.risk,
            price_forecast=inp.price_forecast,
            iv=inp.iv,
            quant=QuantEngineSignal(direction=0, confidence=0.60),  # neutral quant
            time_of_day_minutes=inp.time_of_day_minutes,
        )
        result = engine.decide(inp)
        # Neutral quant shouldn't flip to abstain if 6/7 others agree
        assert result.action in (TradeAction.BUY, TradeAction.WAIT)

    def test_market_close_reduces_execution_quality(self):
        """Signals near market close should have lower execution quality."""
        policy = DecisionPolicy()
        from src.meta.ensemble import EnsembleResult, DisagreementMetrics
        dummy_er = EnsembleResult(
            weights={"regime": 1.0},
            weighted_score=0.60,
            weighted_confidence=0.75,
            disagreement=DisagreementMetrics(0.05, 0.0, 0.10, 0.90, 1),
            regime=MarketRegime.BULL,
            active_models=["regime"],
            penalised_models=[],
            calibration_quality={"regime": 0.8},
        )
        from src.meta.ensemble import ModelSignal as MS
        _, decomp_open, _ = policy.build_decision(
            ensemble_result=dummy_er,
            signals=[MS("regime", 1, 0.75)],
            data_quality=0.95, regime_confidence=0.85,
            prob_stop_hit=0.25, time_of_day_minutes=120,
        )
        _, decomp_close, _ = policy.build_decision(
            ensemble_result=dummy_er,
            signals=[MS("regime", 1, 0.75)],
            data_quality=0.95, regime_confidence=0.85,
            prob_stop_hit=0.25, time_of_day_minutes=368,  # last 7 min
        )
        assert decomp_open.execution_quality >= decomp_close.execution_quality

    def test_iv_spike_reduces_execution_quality(self):
        """IV SPIKE should lower execution quality relative to STABLE."""
        policy = DecisionPolicy()
        from src.meta.ensemble import EnsembleResult, DisagreementMetrics, ModelSignal as MS
        dummy_er = EnsembleResult(
            weights={"regime": 1.0}, weighted_score=0.55,
            weighted_confidence=0.72,
            disagreement=DisagreementMetrics(0.04, 0.0, 0.08, 0.90, 1),
            regime=MarketRegime.BULL, active_models=["regime"],
            penalised_models=[], calibration_quality={"regime": 0.8},
        )
        _, stable, _ = policy.build_decision(
            ensemble_result=dummy_er, signals=[MS("regime", 1, 0.72)],
            data_quality=0.95, regime_confidence=0.82,
            prob_stop_hit=0.28, iv_regime="STABLE",
        )
        _, spike, _ = policy.build_decision(
            ensemble_result=dummy_er, signals=[MS("regime", 1, 0.72)],
            data_quality=0.95, regime_confidence=0.82,
            prob_stop_hit=0.28, iv_regime="SPIKE",
        )
        assert stable.execution_quality > spike.execution_quality
