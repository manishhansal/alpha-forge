"""
Phase 3F — Canonical Type Contracts for the Meta Decision Layer.

The central problem Phase 3F fixes
------------------------------------
The existing code uses a single overloaded "score" or "confidence" field
to mean different things in different contexts:
  - 0-100 rank score from StockRanker
  - raw regression output
  - uncalibrated sigmoid
  - calibrated probability
  - expected return
  - expected value

This creates semantic bugs where a raw score is treated as a calibrated
probability, or a score magnitude is treated as a directional confidence.

This module defines explicit canonical types so that every value in the
meta pipeline carries its own semantics and cannot be accidentally misused.

Design rules
------------
1. NEVER construct a CalibratedProbability from a raw score without a
   fitted calibrator.  Use status=UNCALIBRATED when calibration is absent.
2. NEVER call clip(raw_score, 0, 1) and return it as a probability.
   Use value=None, status=UNAVAILABLE instead.
3. NEVER derive ExpectedValue without documenting the payoff assumptions.
4. Decision output must carry REASONS — not just a bare action.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional


UTC = timezone.utc

# ── Score type taxonomy ───────────────────────────────────────────────────────

class ScoreType(str, Enum):
    """
    Declares what a numeric value represents.
    Must be attached to every cross-boundary value.
    """
    ALPHA_SCORE          = "ALPHA_SCORE"          # relative attractiveness rank signal
    RAW_PROBABILITY      = "RAW_PROBABILITY"       # un-calibrated model output
    CALIBRATED_PROBABILITY = "CALIBRATED_PROBABILITY"  # post-calibration P(success)
    EXPECTED_RETURN      = "EXPECTED_RETURN"       # estimated conditional return (not probability)
    EXPECTED_VALUE       = "EXPECTED_VALUE"        # E[payoff] after costs
    CONFIDENCE_SCORE     = "CONFIDENCE_SCORE"      # model certainty in its direction
    ENSEMBLE_SCORE       = "ENSEMBLE_SCORE"        # signed weighted aggregate ∈ [-1,1]
    UNKNOWN              = "UNKNOWN"               # must never appear in production


# ── Probability status ────────────────────────────────────────────────────────

class ProbabilityStatus(str, Enum):
    """
    Lifecycle state of a probability value.

    A raw score clipped to [0,1] must NEVER be labelled CALIBRATED.
    If calibration is absent, use UNCALIBRATED.
    """
    CALIBRATED              = "CALIBRATED"           # trusted calibrated probability
    UNCALIBRATED            = "UNCALIBRATED"         # raw score, not yet calibrated
    INSUFFICIENT_DATA       = "INSUFFICIENT_DATA"    # too few samples to calibrate
    STALE                   = "STALE"                # calibrator older than max_age
    UNAVAILABLE             = "UNAVAILABLE"          # no model or data
    CALIBRATOR_MISMATCH     = "CALIBRATOR_MISMATCH"  # model/calibrator version mismatch
    INSUFFICIENT_EVIDENCE   = "INSUFFICIENT_EVIDENCE"  # not enough OOS evidence


# ── Decision states ───────────────────────────────────────────────────────────

class Decision(str, Enum):
    """
    Canonical decision states for the meta layer.

    TAKE     — proceed with the candidate trade
    SKIP     — evidence does not support the trade
    ABSTAIN  — cannot make a confident decision; withhold action
    INSUFFICIENT_EVIDENCE — framework lacks the data to evaluate
    UNAVAILABLE — meta engine not operational

    Direction (LONG/SHORT) comes from the primary side field, not this enum.
    Do not use BUY/SELL here — those belong in the execution layer.
    """
    TAKE                  = "TAKE"
    SKIP                  = "SKIP"
    ABSTAIN               = "ABSTAIN"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    UNAVAILABLE           = "UNAVAILABLE"


class DecisionReason(str, Enum):
    """Machine-readable reasons attached to every Decision."""
    # TAKE reasons
    CALIBRATED_PROBABILITY_ABOVE_THRESHOLD = "CALIBRATED_PROBABILITY_ABOVE_THRESHOLD"
    POSITIVE_NET_EV                       = "POSITIVE_NET_EV"
    STRONG_META_SIGNAL                    = "STRONG_META_SIGNAL"
    PRIMARY_RANK_HIGH                     = "PRIMARY_RANK_HIGH"

    # SKIP reasons
    NEGATIVE_EV                           = "NEGATIVE_EV"
    LOW_META_PROBABILITY                  = "LOW_META_PROBABILITY"
    BELOW_EV_THRESHOLD                    = "BELOW_EV_THRESHOLD"
    EXPECTED_LOSS_EXCEEDS_WIN             = "EXPECTED_LOSS_EXCEEDS_WIN"

    # ABSTAIN reasons
    CALIBRATION_INSUFFICIENT_DATA         = "CALIBRATION_INSUFFICIENT_DATA"
    CALIBRATION_STALE                     = "CALIBRATION_STALE"
    CALIBRATION_MISMATCH                  = "CALIBRATION_MISMATCH"
    CALIBRATION_UNAVAILABLE               = "CALIBRATION_UNAVAILABLE"
    HIGH_MODEL_DISAGREEMENT               = "HIGH_MODEL_DISAGREEMENT"
    HIGH_UNCERTAINTY                      = "HIGH_UNCERTAINTY"
    LOW_CROSS_SECTION_SIZE                = "LOW_CROSS_SECTION_SIZE"
    FEATURE_MISSINGNESS                   = "FEATURE_MISSINGNESS"
    DISTRIBUTION_SHIFT                    = "DISTRIBUTION_SHIFT"
    STALE_MODEL                           = "STALE_MODEL"
    STALE_DATA                            = "STALE_DATA"

    # INSUFFICIENT_EVIDENCE reasons
    NO_TRAINED_META_MODEL                 = "NO_TRAINED_META_MODEL"
    NO_OOS_EVIDENCE                       = "NO_OOS_EVIDENCE"
    INSUFFICIENT_CALIBRATION_SAMPLES      = "INSUFFICIENT_CALIBRATION_SAMPLES"


class EVStatus(str, Enum):
    """Status of an ExpectedValue computation."""
    VALID                    = "VALID"
    COST_DATA_UNAVAILABLE    = "COST_DATA_UNAVAILABLE"
    OUTCOME_DATA_INSUFFICIENT = "OUTCOME_DATA_INSUFFICIENT"
    PROBABILITY_UNCALIBRATED = "PROBABILITY_UNCALIBRATED"
    INSUFFICIENT_EVIDENCE    = "INSUFFICIENT_EVIDENCE"
    UNAVAILABLE              = "UNAVAILABLE"


class MetaLabelPolicyType(str, Enum):
    """Which meta-label definition was used to construct the target."""
    POLICY_A_POSITIVE_NET    = "POLICY_A_POSITIVE_NET"   # net_return > 0
    POLICY_B_TRIPLE_BARRIER  = "POLICY_B_TRIPLE_BARRIER"  # first_touch == TAKE_PROFIT
    POLICY_C_RISK_ADJUSTED   = "POLICY_C_RISK_ADJUSTED"   # net_return > min_required AND mae > -limit


class PredictionProvenance(str, Enum):
    """
    How a raw_probability was produced.
    TRAINED_MODEL must never be applied to baselines or heuristics.
    """
    TRAINED_MODEL         = "TRAINED_MODEL"
    BASELINE_THRESHOLD    = "BASELINE_THRESHOLD"
    BASELINE_LINEAR       = "BASELINE_LINEAR"
    HEURISTIC             = "HEURISTIC"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    UNAVAILABLE           = "UNAVAILABLE"


# ── Canonical value containers ────────────────────────────────────────────────

@dataclass
class AlphaScore:
    """
    A ranking signal from the primary ranker.
    NOT a probability.  Higher = more attractive.
    """
    value:          float
    rank:           Optional[int]   = None   # 1 = highest
    percentile:     Optional[float] = None   # 0–100
    cross_section_size: int         = 0
    model_id:       str             = ""
    score_type:     ScoreType       = ScoreType.ALPHA_SCORE

    def is_valid(self) -> bool:
        return math.isfinite(self.value)


@dataclass
class RawProbabilityScore:
    """
    Un-calibrated model output.

    This is NOT a trusted probability.  It must pass through a
    CalibratorArtifact before being called CalibratedProbability.
    Clipping to [0,1] does NOT make this a probability.
    """
    value:          float
    model_id:       str
    model_version:  str
    prediction_time: datetime
    score_type:     ScoreType  = ScoreType.RAW_PROBABILITY
    provenance:     PredictionProvenance = PredictionProvenance.TRAINED_MODEL
    is_oos:         bool       = True   # must be True for meta-model training

    def is_valid(self) -> bool:
        return self.value is not None and math.isfinite(self.value)

    def assert_oos(self) -> None:
        """
        Raise RuntimeError if this is an in-sample prediction.
        Must be called before using this record for meta-model training.
        """
        if not self.is_oos:
            raise RuntimeError(
                f"Stacking leakage: RawProbabilityScore from model "
                f"'{self.model_id}' is NOT an OOS prediction (is_oos=False). "
                "Training the meta model on in-sample predictions will cause "
                "stacking leakage and over-confident calibration."
            )


@dataclass
class CalibratedProbability:
    """
    P(success | information available at decision time).

    This value is trusted only when status == CALIBRATED.
    A raw score clipped to [0,1] MUST NOT be stored here with
    status == CALIBRATED.
    """
    value:              Optional[float]      # None when status != CALIBRATED
    status:             ProbabilityStatus
    model_id:           str
    model_version:      str
    calibrator_id:      str
    calibration_method: str      # "platt" | "isotonic" | "none"
    calibration_version: str
    fit_end_time:       Optional[datetime]
    effective_from:     Optional[datetime]
    sample_count:       int = 0
    prediction_time:    Optional[datetime] = None
    score_type:         ScoreType = ScoreType.CALIBRATED_PROBABILITY

    def is_usable(self) -> bool:
        """Return True only when the probability can be trusted for decision-making."""
        return (
            self.status == ProbabilityStatus.CALIBRATED
            and self.value is not None
            and 0.0 <= self.value <= 1.0
        )

    @classmethod
    def unavailable(
        cls,
        model_id: str,
        reason: ProbabilityStatus = ProbabilityStatus.UNAVAILABLE,
        notes: str = "",
    ) -> "CalibratedProbability":
        """
        Factory for unavailable/uncalibrated probability.
        Never set value = clip(raw, 0, 1) and call it CALIBRATED.
        """
        return cls(
            value=None,
            status=reason,
            model_id=model_id,
            model_version="",
            calibrator_id="",
            calibration_method="none",
            calibration_version="",
            fit_end_time=None,
            effective_from=None,
            sample_count=0,
        )


@dataclass
class ExpectedReturn:
    """
    Estimated conditional return E[return | signal].
    NOT a probability.  May be positive or negative.
    """
    value:          Optional[float]   # expected return %; None = unavailable
    horizon_bars:   int
    side:           str               # "LONG" | "SHORT"
    conditioned_on: str               # what signal was used
    status:         str = "VALID"
    score_type:     ScoreType = ScoreType.EXPECTED_RETURN


@dataclass
class ExpectedValue:
    """
    Expected economic value = E[payoff × probability] - cost.

    This is a decision statistic, NOT a portfolio backtest.
    EV > 0 is necessary but not sufficient for a tradable strategy.
    """
    value:             Optional[float]   # net EV; None = unavailable
    probability:       Optional[float]   # P(success)
    expected_win:      Optional[float]   # E[return | win] as %
    expected_loss:     Optional[float]   # E[return | loss] as % (negative)
    expected_cost:     Optional[float]   # round-trip cost as %
    confidence:        Optional[float]   # uncertainty in the EV estimate
    status:            EVStatus
    score_type:        ScoreType = ScoreType.EXPECTED_VALUE
    payoff_assumptions: str = ""         # document assumptions explicitly

    def is_valid(self) -> bool:
        return self.status == EVStatus.VALID and self.value is not None

    def is_positive(self) -> bool:
        return self.is_valid() and self.value > 0.0


# ── Meta decision output ──────────────────────────────────────────────────────

@dataclass
class MetaDecisionOutput:
    """
    Complete output of the Phase 3F meta decision layer for one candidate.

    Every field is explicit — none are inferred from another.
    The decision MUST carry reasons.
    """
    instrument_id:      str
    prediction_time:    datetime

    # Primary ranking context
    primary_alpha_score: Optional[AlphaScore]
    primary_side:       str              # "LONG" | "SHORT" | "NONE"

    # Meta-model output
    raw_probability:    Optional[RawProbabilityScore]
    calibrated_probability: CalibratedProbability

    # Economic evaluation
    expected_return:    Optional[ExpectedReturn]
    expected_value:     Optional[ExpectedValue]

    # Decision
    decision:           Decision
    decision_reasons:   list[DecisionReason]
    uncertainty:        Optional[float]        # 0–1; higher = less confident

    # Provenance
    primary_model_id:    str
    meta_model_id:       str
    meta_model_version:  str
    calibrator_id:       str
    calibration_version: str
    feature_set_id:      str
    label_version:       str
    dataset_id:          str

    def is_take(self) -> bool:
        return self.decision == Decision.TAKE

    def to_dict(self) -> dict:
        return {
            "instrument_id":       self.instrument_id,
            "prediction_time":     self.prediction_time.isoformat(),
            "primary_side":        self.primary_side,
            "alpha_score":         self.primary_alpha_score.value if self.primary_alpha_score else None,
            "alpha_rank":          self.primary_alpha_score.rank if self.primary_alpha_score else None,
            "raw_probability":     self.raw_probability.value if self.raw_probability else None,
            "calibrated_probability": self.calibrated_probability.value,
            "probability_status":  self.calibrated_probability.status.value,
            "expected_value":      self.expected_value.value if self.expected_value else None,
            "ev_status":           self.expected_value.status.value if self.expected_value else None,
            "decision":            self.decision.value,
            "decision_reasons":    [r.value for r in self.decision_reasons],
            "uncertainty":         self.uncertainty,
            "meta_model_id":       self.meta_model_id,
            "calibrator_id":       self.calibrator_id,
        }


# ── Signal state machine ──────────────────────────────────────────────────────

class SignalState(str, Enum):
    """
    Ordered states a candidate passes through in the meta pipeline.
    Never jump directly from CANDIDATE to TAKE.
    """
    NO_CANDIDATE          = "NO_CANDIDATE"
    CANDIDATE             = "CANDIDATE"
    META_EVALUATED        = "META_EVALUATED"
    CALIBRATED            = "CALIBRATED"
    EV_EVALUATED          = "EV_EVALUATED"
    TAKE                  = "TAKE"
    SKIP                  = "SKIP"
    ABSTAIN               = "ABSTAIN"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


# ── Calibration quality ───────────────────────────────────────────────────────

@dataclass
class CalibrationQualityV2:
    """
    Enhanced calibration quality record with OOS provenance.
    Replaces the existing CalibrationQuality that lacks eval_is_oos.
    """
    model_id:             str
    calibrator_id:        str
    calibration_method:   str         # "platt" | "isotonic"
    calibration_version:  str
    fit_end_time:         Optional[datetime]
    effective_from:       Optional[datetime]
    fit_sample_count:     int
    eval_sample_count:    int
    eval_is_oos:          bool        # True = eval on disjoint OOS fold
    ece:                  float       # Expected Calibration Error [0,1]; lower=better
    mce:                  float       # Maximum Calibration Error [0,1]; lower=better
    brier_score:          float       # [0,1]; lower=better
    log_loss:             Optional[float]
    calibration_slope:    Optional[float]     # ideal = 1.0
    calibration_intercept: Optional[float]   # ideal = 0.0
    is_fitted:            bool = False
    dataset_id:           str = ""
    git_commit:           str = ""

    def is_stale(self, current_time: datetime, max_age_days: int = 30) -> bool:
        if self.effective_from is None:
            return True
        eff = self.effective_from
        if eff.tzinfo is None:
            eff = eff.replace(tzinfo=UTC)
        ct = current_time.astimezone(UTC)
        return (ct - eff).days > max_age_days

    @property
    def quality_score(self) -> float:
        """Composite quality ∈ [0,1]; 0.5 for unfitted calibrators."""
        if not self.is_fitted or self.eval_sample_count == 0:
            return 0.5
        return float(max(0.0, min(1.0, 1.0 - self.ece - 0.5 * self.brier_score)))
