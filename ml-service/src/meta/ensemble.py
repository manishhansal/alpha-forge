"""
Contextual Ensemble Weighter for the Meta Decision Engine.

Model weights are NOT static — they shift with the market regime.
This encodes the domain knowledge that:

  STRONG_BULL / BULL   → momentum and trend models carry more weight
  SIDEWAYS             → mean-reversion models carry more weight
  VOLATILE             → risk model is most informative
  BEAR / CRASH         → risk and regime models dominate; ranker down-weighted

In addition to regime-gated base weights, the weighter computes:

  - prediction variance   (spread of individual model confidences)
  - direction disagreement (fraction of models pointing against majority)
  - confidence spread      (max – min confidence across models)
  - aggregate disagreement penalty applied to each model's effective weight

The output of :class:`EnsembleWeighter` is a dict of normalised weights,
a disagreement score, and raw signals, ready for the meta policy layer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import NamedTuple

import numpy as np
import structlog

from ..schemas import MarketRegime

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Model identifiers — must match CalibrationStore keys
# ---------------------------------------------------------------------------

MODEL_NAMES = [
    "regime",
    "ranker",
    "strategy",
    "risk",
    "price_forecaster",
    "iv_classifier",
    "quant_engine",
]

# ---------------------------------------------------------------------------
# Regime-specific base weights
#
# Weights are (unnormalised) importance scores; EnsembleWeighter normalises
# them to sum to 1 after applying quality and disagreement adjustments.
#
# Rationale for each regime
# -------------------------
# STRONG_BULL  Momentum/trend signals are most reliable.  Risk model still
#              present but at lower weight since stop-outs are rare.
# BULL         Similar to strong bull but ranker and strategy more balanced.
# SIDEWAYS     Mean-reversion context: strategy selector is the oracle.
#              Regime model receives high weight because the classifier must
#              detect the transition out of range quickly.
# VOLATILE     Risk model is the primary filter.  IV classifier becomes
#              critical.  Pure momentum ranker is penalised.
# BEAR         Regime + risk dominate.  Momentum ranker at half weight.
#              Strategy selector guides short-side plays.
# CRASH        Extreme: risk model is near-sovereign.  Everything else
#              is heavily discounted.  Quant engine rule-based system still
#              matters for circuit-breaker logic.
# ---------------------------------------------------------------------------

REGIME_WEIGHTS: dict[MarketRegime, dict[str, float]] = {
    MarketRegime.STRONG_BULL: {
        "regime":          0.12,
        "ranker":          0.22,
        "strategy":        0.18,
        "risk":            0.14,
        "price_forecaster":0.18,
        "iv_classifier":   0.08,
        "quant_engine":    0.08,
    },
    MarketRegime.BULL: {
        "regime":          0.14,
        "ranker":          0.20,
        "strategy":        0.18,
        "risk":            0.16,
        "price_forecaster":0.16,
        "iv_classifier":   0.08,
        "quant_engine":    0.08,
    },
    MarketRegime.SIDEWAYS: {
        "regime":          0.18,
        "ranker":          0.10,
        "strategy":        0.24,   # mean-reversion oracle
        "risk":            0.18,
        "price_forecaster":0.10,
        "iv_classifier":   0.10,
        "quant_engine":    0.10,
    },
    MarketRegime.VOLATILE: {
        "regime":          0.16,
        "ranker":          0.08,   # penalised in volatile
        "strategy":        0.14,
        "risk":            0.28,   # primary filter
        "price_forecaster":0.10,
        "iv_classifier":   0.16,   # critical
        "quant_engine":    0.08,
    },
    MarketRegime.BEAR: {
        "regime":          0.20,
        "ranker":          0.10,   # momentum penalised
        "strategy":        0.18,
        "risk":            0.24,
        "price_forecaster":0.10,
        "iv_classifier":   0.10,
        "quant_engine":    0.08,
    },
    MarketRegime.CRASH: {
        "regime":          0.22,
        "ranker":          0.06,
        "strategy":        0.10,
        "risk":            0.35,   # near-sovereign
        "price_forecaster":0.08,
        "iv_classifier":   0.10,
        "quant_engine":    0.09,
    },
}

# Fallback weights used when the regime is unknown / None
_DEFAULT_WEIGHTS: dict[str, float] = {
    "regime":          0.15,
    "ranker":          0.15,
    "strategy":        0.15,
    "risk":            0.20,
    "price_forecaster":0.15,
    "iv_classifier":   0.10,
    "quant_engine":    0.10,
}

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class ModelSignal:
    """
    Normalised prediction from a single base model.

    Attributes
    ----------
    model_name   : identifier (must be in MODEL_NAMES)
    direction    : +1 = bullish / enter, -1 = bearish / avoid, 0 = neutral
    confidence   : calibrated probability ∈ [0, 1]
    raw_score    : uncalibrated score (stored for audit)
    is_available : False when the model failed or returned no prediction
    """

    model_name: str
    direction: int          # +1 | 0 | -1
    confidence: float       # ∈ [0, 1]
    raw_score: float = 0.0
    is_available: bool = True
    metadata: dict = field(default_factory=dict)


class DisagreementMetrics(NamedTuple):
    """Disagreement statistics across the model ensemble."""

    prediction_variance: float    # variance of confidences × directions
    direction_disagreement: float # fraction of models opposing majority direction
    confidence_spread: float      # max(confidence) – min(confidence)
    agreement_ratio: float        # fraction of available models in majority direction
    majority_direction: int       # +1 | -1 | 0


@dataclass
class EnsembleResult:
    """Full output of :class:`EnsembleWeighter`."""

    weights: dict[str, float]             # normalised per-model weights
    weighted_score: float                 # scalar meta-score ∈ [-1, 1]
    weighted_confidence: float            # weighted average confidence ∈ [0, 1]
    disagreement: DisagreementMetrics
    regime: MarketRegime | None
    active_models: list[str]             # models that contributed
    penalised_models: list[str]          # models down-weighted due to disagreement
    calibration_quality: dict[str, float] # per-model calibration score


# ---------------------------------------------------------------------------
# EnsembleWeighter
# ---------------------------------------------------------------------------

class EnsembleWeighter:
    """
    Computes regime-aware, disagreement-penalised ensemble weights.

    Parameters
    ----------
    disagreement_penalty : float
        Weight multiplier applied to models that disagree with the majority.
        E.g. 0.5 halves the weight of a dissenting model.
    min_weight : float
        Floor weight — no model's weight drops to zero (preserves diversity).
    calibration_quality_scores : dict[str, float] | None
        Per-model calibration quality ∈ [0, 1].  If None, uniform quality
        is assumed (no calibration-quality adjustment).
    """

    def __init__(
        self,
        disagreement_penalty: float = 0.5,
        min_weight: float = 0.02,
        calibration_quality_scores: dict[str, float] | None = None,
    ) -> None:
        self.disagreement_penalty = disagreement_penalty
        self.min_weight = min_weight
        self._cal_quality: dict[str, float] = calibration_quality_scores or {
            n: 1.0 for n in MODEL_NAMES
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def compute(
        self,
        signals: list[ModelSignal],
        regime: MarketRegime | None,
    ) -> EnsembleResult:
        """
        Compute weights and aggregate score for a list of model signals.

        Parameters
        ----------
        signals : per-model predictions (subset of MODEL_NAMES is fine)
        regime  : current market regime (or None if unknown)

        Returns
        -------
        EnsembleResult with normalised weights, weighted score, disagreement
        """
        available = [s for s in signals if s.is_available]
        if not available:
            return self._empty_result(regime)

        # 1. Regime-gated base weights
        base_w = self._base_weights(regime)

        # 2. Calibration-quality multiplier
        cal_adjusted_w = {
            s.model_name: base_w.get(s.model_name, 0.05)
                          * self._cal_quality.get(s.model_name, 1.0)
            for s in available
        }

        # 3. Disagreement metrics
        disagreement = self._compute_disagreement(available)

        # 4. Penalise models that disagree with the majority
        penalised: list[str] = []
        final_w: dict[str, float] = {}
        for s in available:
            w = cal_adjusted_w[s.model_name]
            if (
                disagreement.majority_direction != 0
                and s.direction != 0
                and s.direction != disagreement.majority_direction
            ):
                w *= self.disagreement_penalty
                penalised.append(s.model_name)
            final_w[s.model_name] = max(w, self.min_weight)

        # 5. Normalise
        total = sum(final_w.values()) or 1.0
        norm_w = {k: v / total for k, v in final_w.items()}

        # 6. Weighted aggregate score ∈ [-1, 1]
        #    Each model contributes: weight × direction × confidence
        weighted_score = sum(
            norm_w[s.model_name] * s.direction * s.confidence
            for s in available
        )

        # 7. Weighted average confidence ∈ [0, 1]
        weighted_conf = sum(
            norm_w[s.model_name] * s.confidence
            for s in available
        )

        logger.debug(
            "ensemble_computed",
            regime=regime.value if regime else "unknown",
            n_models=len(available),
            weighted_score=round(weighted_score, 4),
            agreement=round(disagreement.agreement_ratio, 3),
            penalised=penalised,
        )

        return EnsembleResult(
            weights=norm_w,
            weighted_score=float(np.clip(weighted_score, -1.0, 1.0)),
            weighted_confidence=float(np.clip(weighted_conf, 0.0, 1.0)),
            disagreement=disagreement,
            regime=regime,
            active_models=[s.model_name for s in available],
            penalised_models=penalised,
            calibration_quality={
                s.model_name: self._cal_quality.get(s.model_name, 1.0)
                for s in available
            },
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _base_weights(self, regime: MarketRegime | None) -> dict[str, float]:
        """Return the raw (un-normalised) regime-specific base weights."""
        if regime is None or regime not in REGIME_WEIGHTS:
            return dict(_DEFAULT_WEIGHTS)
        return dict(REGIME_WEIGHTS[regime])

    @staticmethod
    def _compute_disagreement(signals: list[ModelSignal]) -> DisagreementMetrics:
        """Compute DisagreementMetrics from available signals."""
        directions = np.array([s.direction for s in signals], dtype=float)
        confidences = np.array([s.confidence for s in signals], dtype=float)

        # Signed scores: direction × confidence
        signed = directions * confidences

        # Variance of signed scores
        pred_variance = float(np.var(signed)) if len(signed) > 1 else 0.0

        # Majority direction (by count of non-neutral models)
        non_neutral = [s for s in signals if s.direction != 0]
        if non_neutral:
            bull_count = sum(1 for s in non_neutral if s.direction > 0)
            bear_count = len(non_neutral) - bull_count
            majority_dir = 1 if bull_count >= bear_count else -1
            majority_count = max(bull_count, bear_count)
            agreement_ratio = majority_count / len(non_neutral)
            dissent_count = len(non_neutral) - majority_count
            dir_disagreement = dissent_count / len(non_neutral)
        else:
            majority_dir = 0
            agreement_ratio = 1.0
            dir_disagreement = 0.0

        # Confidence spread
        conf_spread = (
            float(confidences.max() - confidences.min())
            if len(confidences) > 1
            else 0.0
        )

        return DisagreementMetrics(
            prediction_variance=pred_variance,
            direction_disagreement=dir_disagreement,
            confidence_spread=conf_spread,
            agreement_ratio=agreement_ratio,
            majority_direction=majority_dir,
        )

    @staticmethod
    def _empty_result(regime: MarketRegime | None) -> EnsembleResult:
        """Return a safe empty result when no signals are available."""
        return EnsembleResult(
            weights={},
            weighted_score=0.0,
            weighted_confidence=0.0,
            disagreement=DisagreementMetrics(
                prediction_variance=1.0,
                direction_disagreement=1.0,
                confidence_spread=0.0,
                agreement_ratio=0.0,
                majority_direction=0,
            ),
            regime=regime,
            active_models=[],
            penalised_models=[],
            calibration_quality={},
        )

    # ------------------------------------------------------------------
    # Inspection helpers
    # ------------------------------------------------------------------

    def describe_weights(self, regime: MarketRegime) -> dict[str, float]:
        """
        Return normalised base weights for a regime (no signals required).
        Useful for introspection and unit tests.
        """
        raw = self._base_weights(regime)
        total = sum(raw.values()) or 1.0
        return {k: round(v / total, 4) for k, v in raw.items()}
