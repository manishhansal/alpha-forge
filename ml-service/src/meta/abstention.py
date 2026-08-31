"""
Abstention Logic for the Meta Decision Engine.

The engine must be able to say WAIT or NO_TRADE.
It must never be forced into BUY or SELL.

Abstention is triggered by any of these conditions (independently or combined):

  1. MODEL_DISAGREEMENT   — models point in different directions
  2. LOW_DATA_QUALITY     — insufficient or stale input features
  3. HIGH_UNCERTAINTY     — individual model confidences are low
  4. UNCLEAR_REGIME       — regime classifier is uncertain
  5. RISK_THRESHOLD       — risk model indicates elevated stop-hit probability
  6. CONFIDENCE_SPREAD    — gap between best and worst model is too wide
  7. ENSEMBLE_SCORE_WEAK  — weighted aggregate signal is below entry threshold

The distinction between WAIT and NO_TRADE:

  WAIT       → conditions are temporary; retry on next bar
  NO_TRADE   → structural issue (data, risk, extreme disagreement); skip this
               opportunity entirely

:class:`AbstentionPolicy` evaluates signals and returns an
:class:`AbstentionDecision` that explains *why* the engine abstained.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import NamedTuple

import structlog

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Enums & types
# ---------------------------------------------------------------------------

class AbstentionReason(str, Enum):
    """Why the engine chose to abstain."""

    MODEL_DISAGREEMENT   = "model_disagreement"
    LOW_DATA_QUALITY     = "low_data_quality"
    HIGH_UNCERTAINTY     = "high_uncertainty"
    UNCLEAR_REGIME       = "unclear_regime"
    RISK_THRESHOLD       = "risk_threshold"
    CONFIDENCE_SPREAD    = "confidence_spread"
    ENSEMBLE_SCORE_WEAK  = "ensemble_score_weak"


class AbstentionKind(str, Enum):
    """The flavour of the abstention decision."""

    NONE     = "none"       # no abstention; proceed with decision
    WAIT     = "wait"       # temporary; retry next bar
    NO_TRADE = "no_trade"   # structural; skip this opportunity


@dataclass
class AbstentionDecision:
    """
    Full output of the abstention evaluation.

    Attributes
    ----------
    kind          : NONE | WAIT | NO_TRADE
    reasons       : list of triggered AbstentionReason values
    reason_details: human-readable explanation per reason
    severity      : 0.0–1.0 — how strongly the policy recommends abstention
    should_abstain: shorthand boolean (kind != NONE)
    """

    kind: AbstentionKind = AbstentionKind.NONE
    reasons: list[AbstentionReason] = field(default_factory=list)
    reason_details: dict[str, str] = field(default_factory=dict)
    severity: float = 0.0

    @property
    def should_abstain(self) -> bool:
        return self.kind != AbstentionKind.NONE


# ---------------------------------------------------------------------------
# Input snapshot for the abstention check
# ---------------------------------------------------------------------------

class AbstentionInputs(NamedTuple):
    """
    All signals that feed into the abstention check.

    agreement_ratio       : fraction of models agreeing on direction  [0,1]
    direction_disagreement: fraction of models opposing majority      [0,1]
    data_quality          : composite data quality score              [0,1]
    mean_confidence       : mean calibrated confidence across models  [0,1]
    regime_confidence     : regime classifier confidence              [0,1]
    prob_stop_hit         : risk model P(stop loss hit)               [0,1]
    confidence_spread     : max − min confidence across models        [0,1]
    ensemble_score        : weighted signed meta-score                [-1,1]
    n_available_models    : number of models that returned a signal
    prediction_variance   : variance of signed model scores           [0,∞)
"""
    agreement_ratio: float
    direction_disagreement: float
    data_quality: float
    mean_confidence: float
    regime_confidence: float
    prob_stop_hit: float
    confidence_spread: float
    ensemble_score: float
    n_available_models: int
    prediction_variance: float


# ---------------------------------------------------------------------------
# Thresholds (tunable)
# ---------------------------------------------------------------------------

@dataclass
class AbstentionThresholds:
    """
    Configurable trigger thresholds for abstention.

    All values are sensible defaults calibrated on NSE F&O typical conditions.
    Override them when instantiating :class:`AbstentionPolicy`.
    """

    # Trigger: MODEL_DISAGREEMENT
    max_direction_disagreement: float = 0.40  # >40% models opposing majority → abstain
    max_prediction_variance: float    = 0.18  # variance of signed scores

    # Trigger: LOW_DATA_QUALITY
    min_data_quality: float           = 0.60  # below 60% → abstain
    min_available_models: int         = 3     # need at least 3 models

    # Trigger: HIGH_UNCERTAINTY
    min_mean_confidence: float        = 0.52  # all models must average > 52%

    # Trigger: UNCLEAR_REGIME
    min_regime_confidence: float      = 0.55  # regime classifier certainty

    # Trigger: RISK_THRESHOLD
    max_prob_stop_hit: float          = 0.70  # risk model P(stop) > 70%

    # Trigger: CONFIDENCE_SPREAD
    max_confidence_spread: float      = 0.45  # gap between best/worst model

    # Trigger: ENSEMBLE_SCORE_WEAK
    min_ensemble_score_abs: float     = 0.15  # |score| < 0.15 → no conviction

    # Classification: WAIT vs NO_TRADE
    # Conditions considered "structural" → NO_TRADE
    # Conditions considered "temporary"  → WAIT
    no_trade_reasons: frozenset[AbstentionReason] = field(
        default_factory=lambda: frozenset({
            AbstentionReason.LOW_DATA_QUALITY,
            AbstentionReason.RISK_THRESHOLD,
        })
    )

    # If severity ≥ this, upgrade WAIT → NO_TRADE
    severity_no_trade_threshold: float = 0.75


# ---------------------------------------------------------------------------
# AbstentionPolicy
# ---------------------------------------------------------------------------

class AbstentionPolicy:
    """
    Evaluates whether the meta engine should abstain from trading.

    Parameters
    ----------
    thresholds : AbstentionThresholds (uses defaults if not supplied)
    """

    def __init__(
        self,
        thresholds: AbstentionThresholds | None = None,
    ) -> None:
        self.thresholds = thresholds or AbstentionThresholds()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def evaluate(self, inputs: AbstentionInputs) -> AbstentionDecision:
        """
        Evaluate all abstention conditions and return a decision.

        Parameters
        ----------
        inputs : AbstentionInputs snapshot

        Returns
        -------
        AbstentionDecision with kind, reasons, details, severity
        """
        t = self.thresholds
        triggered: list[AbstentionReason] = []
        details: dict[str, str] = {}
        severities: list[float] = []

        # ── 1. Model disagreement ────────────────────────────────────────
        if inputs.direction_disagreement > t.max_direction_disagreement:
            triggered.append(AbstentionReason.MODEL_DISAGREEMENT)
            details[AbstentionReason.MODEL_DISAGREEMENT] = (
                f"Direction disagreement {inputs.direction_disagreement:.0%} "
                f"exceeds threshold {t.max_direction_disagreement:.0%}"
            )
            severities.append(
                min(1.0, inputs.direction_disagreement / t.max_direction_disagreement - 1.0 + 0.4)
            )

        if inputs.prediction_variance > t.max_prediction_variance:
            # Second disagreement signal — boost severity but don't add a new reason
            if AbstentionReason.MODEL_DISAGREEMENT not in triggered:
                triggered.append(AbstentionReason.MODEL_DISAGREEMENT)
                details[AbstentionReason.MODEL_DISAGREEMENT] = (
                    f"Prediction variance {inputs.prediction_variance:.4f} "
                    f"exceeds threshold {t.max_prediction_variance:.4f}"
                )
            severities.append(
                min(1.0, inputs.prediction_variance / (t.max_prediction_variance + 1e-9) * 0.4)
            )

        # ── 2. Low data quality ──────────────────────────────────────────
        if inputs.data_quality < t.min_data_quality:
            triggered.append(AbstentionReason.LOW_DATA_QUALITY)
            details[AbstentionReason.LOW_DATA_QUALITY] = (
                f"Data quality {inputs.data_quality:.2f} "
                f"below minimum {t.min_data_quality:.2f}"
            )
            severities.append(
                min(1.0, (t.min_data_quality - inputs.data_quality) / t.min_data_quality + 0.5)
            )

        if inputs.n_available_models < t.min_available_models:
            reason = AbstentionReason.LOW_DATA_QUALITY
            if reason not in triggered:
                triggered.append(reason)
            details.setdefault(
                AbstentionReason.LOW_DATA_QUALITY,
                f"Only {inputs.n_available_models} models available "
                f"(minimum {t.min_available_models})",
            )
            severities.append(0.8)

        # ── 3. High uncertainty ──────────────────────────────────────────
        if inputs.mean_confidence < t.min_mean_confidence:
            triggered.append(AbstentionReason.HIGH_UNCERTAINTY)
            details[AbstentionReason.HIGH_UNCERTAINTY] = (
                f"Mean confidence {inputs.mean_confidence:.2f} "
                f"below minimum {t.min_mean_confidence:.2f}"
            )
            severities.append(
                min(1.0, (t.min_mean_confidence - inputs.mean_confidence) / t.min_mean_confidence + 0.3)
            )

        # ── 4. Unclear regime ────────────────────────────────────────────
        if inputs.regime_confidence < t.min_regime_confidence:
            triggered.append(AbstentionReason.UNCLEAR_REGIME)
            details[AbstentionReason.UNCLEAR_REGIME] = (
                f"Regime confidence {inputs.regime_confidence:.2f} "
                f"below minimum {t.min_regime_confidence:.2f}"
            )
            severities.append(
                min(1.0, (t.min_regime_confidence - inputs.regime_confidence)
                    / t.min_regime_confidence + 0.25)
            )

        # ── 5. Risk threshold ────────────────────────────────────────────
        if inputs.prob_stop_hit > t.max_prob_stop_hit:
            triggered.append(AbstentionReason.RISK_THRESHOLD)
            details[AbstentionReason.RISK_THRESHOLD] = (
                f"P(stop hit) = {inputs.prob_stop_hit:.0%} "
                f"exceeds threshold {t.max_prob_stop_hit:.0%}"
            )
            severities.append(
                min(1.0, (inputs.prob_stop_hit - t.max_prob_stop_hit)
                    / (1.0 - t.max_prob_stop_hit) + 0.5)
            )

        # ── 6. Confidence spread ─────────────────────────────────────────
        if inputs.confidence_spread > t.max_confidence_spread:
            triggered.append(AbstentionReason.CONFIDENCE_SPREAD)
            details[AbstentionReason.CONFIDENCE_SPREAD] = (
                f"Confidence spread {inputs.confidence_spread:.2f} "
                f"exceeds threshold {t.max_confidence_spread:.2f}"
            )
            severities.append(
                min(1.0, inputs.confidence_spread / t.max_confidence_spread * 0.5)
            )

        # ── 7. Ensemble score too weak ───────────────────────────────────
        if abs(inputs.ensemble_score) < t.min_ensemble_score_abs:
            triggered.append(AbstentionReason.ENSEMBLE_SCORE_WEAK)
            details[AbstentionReason.ENSEMBLE_SCORE_WEAK] = (
                f"|Ensemble score| = {abs(inputs.ensemble_score):.3f} "
                f"below threshold {t.min_ensemble_score_abs:.3f} (no conviction)"
            )
            severities.append(
                min(1.0, 1.0 - abs(inputs.ensemble_score) / t.min_ensemble_score_abs)
            )

        # ── Aggregate severity ───────────────────────────────────────────
        severity = float(max(severities)) if severities else 0.0
        # Multiple triggers compound the severity
        if len(triggered) > 1:
            severity = min(1.0, severity + 0.05 * (len(triggered) - 1))

        # ── Determine kind ───────────────────────────────────────────────
        if not triggered:
            kind = AbstentionKind.NONE
        else:
            has_no_trade_reason = bool(
                set(triggered) & set(t.no_trade_reasons)
            )
            if has_no_trade_reason or severity >= t.severity_no_trade_threshold:
                kind = AbstentionKind.NO_TRADE
            else:
                kind = AbstentionKind.WAIT

        decision = AbstentionDecision(
            kind=kind,
            reasons=triggered,
            reason_details=details,
            severity=severity,
        )

        if decision.should_abstain:
            logger.info(
                "abstention_triggered",
                kind=kind.value,
                reasons=[r.value for r in triggered],
                severity=round(severity, 3),
            )
        else:
            logger.debug("abstention_cleared", severity=round(severity, 3))

        return decision

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    @staticmethod
    def from_ensemble_and_risk(
        *,
        agreement_ratio: float,
        direction_disagreement: float,
        confidence_spread: float,
        prediction_variance: float,
        mean_confidence: float,
        ensemble_score: float,
        regime_confidence: float,
        prob_stop_hit: float,
        data_quality: float = 1.0,
        n_available_models: int = 7,
        thresholds: AbstentionThresholds | None = None,
    ) -> AbstentionDecision:
        """
        One-shot helper — construct inputs and evaluate in a single call.

        All parameters map directly to :class:`AbstentionInputs`.
        """
        policy = AbstentionPolicy(thresholds=thresholds)
        inputs = AbstentionInputs(
            agreement_ratio=agreement_ratio,
            direction_disagreement=direction_disagreement,
            data_quality=data_quality,
            mean_confidence=mean_confidence,
            regime_confidence=regime_confidence,
            prob_stop_hit=prob_stop_hit,
            confidence_spread=confidence_spread,
            ensemble_score=ensemble_score,
            n_available_models=n_available_models,
            prediction_variance=prediction_variance,
        )
        return policy.evaluate(inputs)
