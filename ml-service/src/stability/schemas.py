"""
Phase 3I — Alpha Decay & Stability Schemas.

Canonical types for the stability/decay analysis layer.

Design rules
------------
1. Every observation carries explicit provenance: data_snapshot_id,
   universe_version, feature_version, label_version, model_version.
2. INSUFFICIENT_EVIDENCE is a first-class status for every diagnostic.
3. No arbitrary black-box health score.  SignalHealth decomposes into
   PREDICTIVE / CALIBRATION / FEATURE / REGIME / EXECUTION / CAPACITY.
4. No automatic model replacement.  This module produces evidence only.
5. No np.random.* anywhere in this module.
6. All observations respect PIT: features <= timestamp < labels.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


# ══════════════════════════════════════════════════════════════════════════════
# Enumerations
# ══════════════════════════════════════════════════════════════════════════════

class DecayStatus(str, Enum):
    """Lifecycle status of a signal or metric."""
    STABLE               = "STABLE"
    MILD_DECAY           = "MILD_DECAY"
    SIGNIFICANT_DECAY    = "SIGNIFICANT_DECAY"
    FAILED               = "FAILED"
    DRIFT_DETECTED       = "DRIFT_DETECTED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class DriftType(str, Enum):
    """Distinguishes drift cause (spec §37)."""
    DATA_DRIFT         = "DATA_DRIFT"
    FEATURE_DRIFT      = "FEATURE_DRIFT"
    PREDICTION_DRIFT   = "PREDICTION_DRIFT"
    CALIBRATION_DRIFT  = "CALIBRATION_DRIFT"
    LABEL_DRIFT        = "LABEL_DRIFT"
    PERFORMANCE_DRIFT  = "PERFORMANCE_DRIFT"
    NONE               = "NONE"


class DriftSeverity(str, Enum):
    """Severity of detected drift (spec §48)."""
    NONE      = "NONE"
    LOW       = "LOW"
    MODERATE  = "MODERATE"
    HIGH      = "HIGH"
    CRITICAL  = "CRITICAL"


class ComponentStatus(str, Enum):
    """Per-component health status for SignalHealth."""
    STABLE               = "STABLE"
    WEAKENING            = "WEAKENING"
    DECAYING             = "DECAYING"
    FAILED               = "FAILED"
    DRIFTED              = "DRIFTED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class EvidenceLevel(str, Enum):
    """Statistical evidence strength."""
    STRONG       = "STRONG"       # ≥ 100 observations, statistically significant
    MODERATE     = "MODERATE"     # 30–99 observations
    WEAK         = "WEAK"         # 10–29 observations
    INSUFFICIENT = "INSUFFICIENT" # < 10 observations


class TemporalPeriod(str, Enum):
    """Named temporal periods for stability matrix."""
    EARLY    = "EARLY"
    MIDDLE   = "MIDDLE"
    RECENT   = "RECENT"
    FULL     = "FULL"


class MonotonicityState(str, Enum):
    """Quantile ordering state."""
    MONOTONIC     = "MONOTONIC"     # returns increase monotonically with rank
    WEAKENING     = "WEAKENING"     # near-monotonic but deteriorating
    NON_MONOTONIC = "NON_MONOTONIC"
    REVERSED      = "REVERSED"      # top quantile underperforms bottom
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class HalfLifeStatus(str, Enum):
    """Alpha half-life estimability."""
    ESTIMABLE            = "HALF_LIFE_ESTIMABLE"
    INSUFFICIENT_EVIDENCE = "HALF_LIFE_INSUFFICIENT_EVIDENCE"


class ChangePointStatus(str, Enum):
    """Whether a change point was detected."""
    DETECTED             = "DETECTED"
    NOT_DETECTED         = "NOT_DETECTED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class SignalSurvivalClass(str, Enum):
    """Signal lifecycle classification."""
    ACTIVE               = "ACTIVE"
    WEAKENING            = "WEAKENING"
    DECAYING             = "DECAYING"
    FAILED               = "FAILED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


# ══════════════════════════════════════════════════════════════════════════════
# Core observation
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class AlphaDecayObservation:
    """
    One resolved prediction paired with its realized outcome.

    PIT contract (spec §45):
        features_timestamp <= signal_timestamp < realized_timestamp

    Do NOT mix horizons.  1-day alpha and 20-day alpha must be in
    separate lists with separate decay analysis.

    Fields with None represent genuinely missing data — never substitute 0.
    """
    # Identity
    signal_id:              str
    instrument_id:          str
    signal_timestamp:       datetime          # when signal was generated (PIT gate)
    horizon_bars:           int               # prediction horizon in bars

    # Signal outputs (from Phase 3E / 3F)
    alpha_score:            Optional[float]   # raw ranking signal
    rank_percentile:        Optional[float]   # 0–100; 100 = highest
    expected_return:        Optional[float]   # E[return | signal], %
    calibrated_probability: Optional[float]   # P(success) if CALIBRATED
    expected_value:         Optional[float]   # net EV after costs, %

    # Realized outcomes (only available AFTER signal_timestamp + horizon)
    realized_return:        Optional[float]   # actual return %
    realized_label:         Optional[int]     # 1 = success, 0 = failure, None = missing
    gross_return:           Optional[float]   # before costs
    net_return:             Optional[float]   # after costs
    cost:                   Optional[float]   # transaction cost fraction

    # Context
    regime:                 Optional[str]     # MarketRegime value at signal_timestamp
    sector:                 Optional[str]
    industry:               Optional[str]
    liquidity_bucket:       Optional[str]     # "HIGH_ADV" | "MEDIUM_ADV" | "LOW_ADV"
    adv_inr:                Optional[float]   # average daily value INR

    # Provenance (spec §4)
    model_version:          str = ""
    meta_model_version:     str = ""
    calibrator_version:     str = ""
    feature_version:        str = ""
    label_version:          str = "lv2"
    universe_version:       str = ""
    data_snapshot_id:       str = ""

    @property
    def is_realized(self) -> bool:
        return self.realized_return is not None

    @property
    def is_success(self) -> bool:
        """True if realized label == 1."""
        return self.realized_label == 1


# ══════════════════════════════════════════════════════════════════════════════
# IC decay result
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RollingICWindow:
    """IC statistics computed over one rolling window."""
    window_start:   datetime
    window_end:     datetime
    n_observations: int
    mean_ic:        Optional[float]
    mean_rank_ic:   Optional[float]
    icir:           Optional[float]
    positive_ic_pct: Optional[float]
    evidence:       EvidenceLevel = EvidenceLevel.INSUFFICIENT


@dataclass
class ICDecayResult:
    """
    Full IC decay analysis for one signal / horizon combination.

    Decay is measured via:
    - IC trend slope (scipy.stats.linregress)
    - CUSUM change-point detection
    - Autocorrelation at lag-1 (persistence)
    - Half-life via autocorrelation decay fit
    """
    signal_id:          str
    horizon_bars:       int
    n_timestamps:       int

    # Full-period summary
    mean_ic:            Optional[float]
    mean_rank_ic:       Optional[float]
    icir:               Optional[float]
    positive_ic_pct:    Optional[float]

    # Temporal split (spec §63)
    early_mean_ic:      Optional[float]
    middle_mean_ic:     Optional[float]
    recent_mean_ic:     Optional[float]
    ic_trend_slope:     Optional[float]   # scipy linregress slope; neg = decay
    ic_trend_pvalue:    Optional[float]   # statistical significance of trend

    # Autocorrelation / persistence
    ic_autocorr_lag1:   Optional[float]   # IC[t] vs IC[t-1]

    # Half-life
    half_life_bars:     Optional[float]
    half_life_status:   HalfLifeStatus = HalfLifeStatus.INSUFFICIENT_EVIDENCE

    # Change-point
    change_point_status: ChangePointStatus = ChangePointStatus.INSUFFICIENT_EVIDENCE
    change_point_index: Optional[int] = None   # index into IC series where shift detected

    # Rolling windows
    rolling_windows:    list[RollingICWindow] = field(default_factory=list)

    # Overall status
    decay_status:       DecayStatus = DecayStatus.INSUFFICIENT_EVIDENCE
    evidence:           EvidenceLevel = EvidenceLevel.INSUFFICIENT
    notes:              str = ""


# ══════════════════════════════════════════════════════════════════════════════
# Quantile stability
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class QuantileWindowResult:
    """Quantile return stats for one temporal window."""
    window_label:       str
    n_observations:     int
    q_returns:          dict[int, Optional[float]]   # quantile → mean return
    top_bottom_spread:  Optional[float]
    monotonicity_score: Optional[float]
    monotonicity_state: MonotonicityState


@dataclass
class QuantileDecayResult:
    """Full quantile stability analysis through time."""
    signal_id:          str
    horizon_bars:       int
    n_quantiles:        int

    full_period:        QuantileWindowResult
    early:              Optional[QuantileWindowResult]
    middle:             Optional[QuantileWindowResult]
    recent:             Optional[QuantileWindowResult]

    spread_trend_slope: Optional[float]   # is top-bottom spread shrinking?
    net_spread:         Optional[float]   # gross spread after costs
    cost_adjusted_spread: Optional[float]

    decay_status:       DecayStatus = DecayStatus.INSUFFICIENT_EVIDENCE
    evidence:           EvidenceLevel = EvidenceLevel.INSUFFICIENT


# ══════════════════════════════════════════════════════════════════════════════
# Feature stability
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FeaturePeriodStats:
    """Distribution statistics for a feature over one time period."""
    period_label:   str
    n_observations: int
    mean:           Optional[float]
    median:         Optional[float]
    std:            Optional[float]
    p5:             Optional[float]
    p95:            Optional[float]
    missingness_pct: float
    zero_rate:      float


@dataclass
class FeatureStabilityResult:
    """
    Stability analysis for one feature over time.
    PSI, KS test, Wasserstein distance, missingness drift.
    """
    feature_name:       str
    feature_family:     Optional[str]
    n_periods:          int

    reference_period:   Optional[FeaturePeriodStats]
    comparison_periods: list[FeaturePeriodStats] = field(default_factory=list)

    # Drift statistics
    max_psi:            Optional[float] = None
    max_ks_statistic:   Optional[float] = None
    max_wasserstein:    Optional[float] = None
    missingness_drift:  Optional[float] = None

    drift_severity:     DriftSeverity = DriftSeverity.NONE
    drift_type:         DriftType = DriftType.NONE
    evidence:           EvidenceLevel = EvidenceLevel.INSUFFICIENT
    notes:              str = ""


# ══════════════════════════════════════════════════════════════════════════════
# Prediction drift
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PredictionDriftResult:
    """Distribution drift for alpha score, probability, or EV series."""
    signal_id:          str
    metric_name:        str    # "alpha_score" | "calibrated_probability" | "expected_value"

    # CUSUM change-point
    change_point_status: ChangePointStatus
    change_point_index: Optional[int]
    cusum_max_deviation: Optional[float]

    # Distribution shift (reference = earliest window, comparison = latest window)
    psi:                Optional[float]
    ks_statistic:       Optional[float]
    ks_p_value:         Optional[float]
    js_divergence:      Optional[float]

    # Descriptive
    ref_mean:           Optional[float]
    ref_std:            Optional[float]
    cur_mean:           Optional[float]
    cur_std:            Optional[float]

    drift_severity:     DriftSeverity = DriftSeverity.NONE
    drift_type:         DriftType = DriftType.PREDICTION_DRIFT
    evidence:           EvidenceLevel = EvidenceLevel.INSUFFICIENT


# ══════════════════════════════════════════════════════════════════════════════
# Calibration drift
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class CalibrationPeriodMetrics:
    """Calibration metrics for one temporal fold."""
    period_label:       str
    period_start:       Optional[datetime]
    period_end:         Optional[datetime]
    n_observations:     int

    brier:              Optional[float]
    ece:                Optional[float]
    mce:                Optional[float]
    log_loss:           Optional[float]
    slope:              Optional[float]
    intercept:          Optional[float]
    evidence:           EvidenceLevel = EvidenceLevel.INSUFFICIENT


@dataclass
class CalibrationDriftResult:
    """Calibration decay through time."""
    model_id:           str

    periods:            list[CalibrationPeriodMetrics] = field(default_factory=list)

    # Trend slopes (from linregress on [brier_0, brier_1, ..., brier_n])
    brier_trend_slope:  Optional[float] = None   # positive slope = degrading
    ece_trend_slope:    Optional[float] = None
    slope_trend:        Optional[float] = None   # calibration slope drifting from 1.0

    # Overall assessment
    calibration_status: ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE
    decay_status:       DecayStatus = DecayStatus.INSUFFICIENT_EVIDENCE
    notes:              str = ""


# ══════════════════════════════════════════════════════════════════════════════
# Regime decay
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RegimeICStats:
    """IC statistics conditioned on one market regime."""
    regime:             str
    n_observations:     int
    n_unique_dates:     int
    mean_ic:            Optional[float]
    mean_rank_ic:       Optional[float]
    icir:               Optional[float]
    positive_ic_pct:    Optional[float]
    mean_ev:            Optional[float]
    mean_net_return:    Optional[float]
    evidence:           EvidenceLevel = EvidenceLevel.INSUFFICIENT


@dataclass
class RegimeTransitionResult:
    """Alpha behaviour across a regime transition."""
    from_regime:        str
    to_regime:          str
    n_transitions:      int
    ic_before:          Optional[float]
    ic_after:           Optional[float]
    ic_change:          Optional[float]   # ic_after - ic_before
    status:             str = "INSUFFICIENT_EVIDENCE"   # SURVIVES / WEAKENS / REVERSES / UNAVAILABLE


@dataclass
class RegimeDecayResult:
    """Full regime-conditional stability analysis."""
    signal_id:          str
    horizon_bars:       int
    regime_stats:       list[RegimeICStats] = field(default_factory=list)
    transitions:        list[RegimeTransitionResult] = field(default_factory=list)
    sector_ic:          dict[str, Optional[float]] = field(default_factory=dict)   # sector → IC
    dominant_sector:    Optional[str] = None
    notes:              str = ""


# ══════════════════════════════════════════════════════════════════════════════
# Portfolio decay
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PortfolioWindowMetrics:
    """Portfolio metrics for one rolling time window."""
    window_label:       str
    n_observations:     int
    gross_return:       Optional[float]
    net_return:         Optional[float]
    volatility_ann:     Optional[float]
    sharpe:             Optional[float]
    sortino:            Optional[float]
    max_drawdown:       Optional[float]
    cvar_95:            Optional[float]
    turnover:           Optional[float]
    cost_fraction:      Optional[float]
    hhi:                Optional[float]
    effective_n:        Optional[float]
    evidence:           EvidenceLevel = EvidenceLevel.INSUFFICIENT


@dataclass
class PortfolioDecayResult:
    """Rolling portfolio performance decay."""
    strategy_id:        str

    windows:            list[PortfolioWindowMetrics] = field(default_factory=list)

    # Trend slopes
    sharpe_trend_slope:  Optional[float] = None
    turnover_trend_slope: Optional[float] = None   # positive = turnover increasing (bad)
    cost_edge_ratio:     Optional[float] = None    # cost / gross_edge

    decay_status:       DecayStatus = DecayStatus.INSUFFICIENT_EVIDENCE
    notes:              str = ""


# ══════════════════════════════════════════════════════════════════════════════
# Signal health record (machine-readable monitoring contract, spec §49)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class SignalHealthRecord:
    """
    Machine-readable health record for one signal at one timestamp.
    Spec §49 monitoring contract.
    """
    timestamp:          datetime
    signal_id:          str
    horizon_bars:       int

    # Core metrics
    ic:                 Optional[float]
    rank_ic:            Optional[float]
    icir:               Optional[float]
    ev:                 Optional[float]

    # Drift status per type
    feature_drift:      DriftSeverity = DriftSeverity.NONE
    prediction_drift:   DriftSeverity = DriftSeverity.NONE
    calibration_drift:  DriftSeverity = DriftSeverity.NONE
    label_drift:        DriftSeverity = DriftSeverity.NONE
    performance_drift:  DriftSeverity = DriftSeverity.NONE

    # Context
    regime:             Optional[str] = None
    liquidity_bucket:   Optional[str] = None

    # Overall status
    status:             DecayStatus = DecayStatus.INSUFFICIENT_EVIDENCE
    evidence_level:     EvidenceLevel = EvidenceLevel.INSUFFICIENT


# ══════════════════════════════════════════════════════════════════════════════
# Signal health classification (spec §65)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class SignalHealth:
    """
    Per-dimension health classification for one signal.

    NOT a black-box composite score.
    Every status is traceable to specific diagnostics.
    """
    signal_id:          str
    as_of:              datetime

    predictive_status:  ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE
    calibration_status: ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE
    feature_status:     ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE
    regime_status:      ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE
    execution_status:   ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE
    capacity_status:    ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE

    overall_status:     ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE

    # Evidence for each dimension
    predictive_evidence:  str = ""
    calibration_evidence: str = ""
    feature_evidence:     str = ""
    regime_evidence:      str = ""

    survival_class:     SignalSurvivalClass = SignalSurvivalClass.INSUFFICIENT_EVIDENCE
    notes:              str = ""

    def to_dict(self) -> dict:
        return {
            "signal_id":          self.signal_id,
            "as_of":              self.as_of.isoformat(),
            "predictive_status":  self.predictive_status.value,
            "calibration_status": self.calibration_status.value,
            "feature_status":     self.feature_status.value,
            "regime_status":      self.regime_status.value,
            "execution_status":   self.execution_status.value,
            "capacity_status":    self.capacity_status.value,
            "overall_status":     self.overall_status.value,
            "survival_class":     self.survival_class.value,
        }


# ══════════════════════════════════════════════════════════════════════════════
# Concept drift framework (spec §37)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ConceptDriftRecord:
    """
    Distinguishes the type and severity of concept drift detected.
    Spec §37: data / feature / prediction / calibration / label / performance drift
    are kept separate.
    """
    drift_type:         DriftType
    severity:           DriftSeverity
    detected_at:        datetime
    reference_period:   str
    comparison_period:  str
    metric_name:        str
    metric_value:       Optional[float]
    threshold:          Optional[float]
    evidence:           EvidenceLevel
    details:            str = ""


# ══════════════════════════════════════════════════════════════════════════════
# Stability matrix (spec §64)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class StabilityMatrixCell:
    """One cell in the temporal × metric stability matrix."""
    period:         TemporalPeriod
    metric:         str
    value:          Optional[float]
    status:         ComponentStatus = ComponentStatus.INSUFFICIENT_EVIDENCE
    evidence:       EvidenceLevel = EvidenceLevel.INSUFFICIENT


@dataclass
class StabilityMatrix:
    """
    Complete temporal stability matrix.

    Rows: temporal periods (EARLY, MIDDLE, RECENT, FULL)
    Columns: IC, Rank IC, ICIR, EV, Calibration, Net Return, Turnover, Cost, Capacity

    Cells with unavailable data are explicitly marked INSUFFICIENT_EVIDENCE
    — never filled with fabricated zeros.
    """
    signal_id:  str
    cells:      list[StabilityMatrixCell] = field(default_factory=list)

    def get(self, period: TemporalPeriod, metric: str) -> Optional[StabilityMatrixCell]:
        for c in self.cells:
            if c.period == period and c.metric == metric:
                return c
        return None


# ══════════════════════════════════════════════════════════════════════════════
# Data coverage report (spec §4)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class DataCoverageReport:
    """
    Documents the maximum genuinely supported historical period.
    No history is invented.
    """
    data_snapshot_id:       str
    universe_version:       str
    feature_version:        str
    label_version:          str
    model_version:          str

    first_valid_timestamp:  Optional[datetime]
    last_valid_timestamp:   Optional[datetime]
    total_observations:     int
    unique_instruments:     int
    unique_sessions:        int
    historical_coverage:    str   # e.g. "2020-01-01 to 2024-12-31"
    notes:                  str = "INSUFFICIENT_EVIDENCE"
