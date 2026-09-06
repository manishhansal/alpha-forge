"""
Phase 3I — Alpha Decay, Stability & Concept-Drift Analysis Package.

This package answers: Does AlphaForge have stable predictive information
that persists across time, regimes, instruments, sectors, market conditions
and reasonable execution assumptions?

Modules
-------
schemas.py          — all canonical types (enums, dataclasses)
ic_decay.py         — IC decay, rolling ICIR, half-life, CUSUM change-point
quantile_analysis.py — quantile/decile temporal stability, monotonicity decay
feature_stability.py — PSI, KS, Wasserstein, missingness drift
prediction_drift.py  — alpha score/probability/EV distribution drift
calibration_drift.py — Brier/ECE/slope drift through time
regime_decay.py      — regime-conditional IC/EV; transition analysis
portfolio_decay.py   — rolling portfolio metrics; concentration/turnover decay
signal_health.py     — SignalHealth classification; stability matrix; concept drift

Design invariants (all modules)
--------------------------------
1. No uncontrolled randomness — np.random.* forbidden.
2. INSUFFICIENT_EVIDENCE is a first-class return value.
3. PIT: features ≤ signal_timestamp < realized outcomes.
4. No automatic model replacement.
5. INCOMPLETE evidence → explicit status, never fabricated zeros.
"""

from .schemas import (
    # Enums
    DecayStatus,
    DriftType,
    DriftSeverity,
    ComponentStatus,
    EvidenceLevel,
    TemporalPeriod,
    MonotonicityState,
    HalfLifeStatus,
    ChangePointStatus,
    SignalSurvivalClass,
    # Dataclasses
    AlphaDecayObservation,
    RollingICWindow,
    ICDecayResult,
    QuantileWindowResult,
    QuantileDecayResult,
    FeaturePeriodStats,
    FeatureStabilityResult,
    PredictionDriftResult,
    CalibrationPeriodMetrics,
    CalibrationDriftResult,
    RegimeICStats,
    RegimeTransitionResult,
    RegimeDecayResult,
    PortfolioWindowMetrics,
    PortfolioDecayResult,
    SignalHealthRecord,
    SignalHealth,
    ConceptDriftRecord,
    StabilityMatrixCell,
    StabilityMatrix,
    DataCoverageReport,
)
from .ic_decay import (
    analyse_ic_decay,
    rolling_ic_windows,
    rolling_rank_ic_windows,
    ic_trend_slope,
    ic_autocorrelation,
    ic_half_life,
    cusum_changepoint,
    forward_horizon_decay,
    ForwardHorizonResult,
)
from .quantile_analysis import analyse_quantile_decay
from .feature_stability import (
    analyse_feature_stability,
    analyse_feature_family_stability,
)
from .prediction_drift import analyse_prediction_drift
from .calibration_drift import (
    analyse_calibration_drift,
    analyse_calibration_fold_results,
)
from .regime_decay import analyse_regime_decay
from .portfolio_decay import analyse_portfolio_decay
from .signal_health import (
    classify_signal_health,
    classify_signal_survival,
    build_stability_matrix,
    build_concept_drift_records,
    build_data_coverage,
    StabilityAlertConfig,
)

__all__ = [
    # Enums
    "DecayStatus", "DriftType", "DriftSeverity", "ComponentStatus",
    "EvidenceLevel", "TemporalPeriod", "MonotonicityState",
    "HalfLifeStatus", "ChangePointStatus", "SignalSurvivalClass",
    # Schemas
    "AlphaDecayObservation", "RollingICWindow", "ICDecayResult",
    "QuantileWindowResult", "QuantileDecayResult",
    "FeaturePeriodStats", "FeatureStabilityResult",
    "PredictionDriftResult",
    "CalibrationPeriodMetrics", "CalibrationDriftResult",
    "RegimeICStats", "RegimeTransitionResult", "RegimeDecayResult",
    "PortfolioWindowMetrics", "PortfolioDecayResult",
    "SignalHealthRecord", "SignalHealth",
    "ConceptDriftRecord", "StabilityMatrixCell", "StabilityMatrix",
    "DataCoverageReport",
    # IC decay
    "analyse_ic_decay", "rolling_ic_windows", "rolling_rank_ic_windows",
    "ic_trend_slope", "ic_autocorrelation", "ic_half_life",
    "cusum_changepoint", "forward_horizon_decay", "ForwardHorizonResult",
    # Quantile
    "analyse_quantile_decay",
    # Feature
    "analyse_feature_stability", "analyse_feature_family_stability",
    # Prediction drift
    "analyse_prediction_drift",
    # Calibration drift
    "analyse_calibration_drift", "analyse_calibration_fold_results",
    # Regime
    "analyse_regime_decay",
    # Portfolio
    "analyse_portfolio_decay",
    # Signal health
    "classify_signal_health", "classify_signal_survival",
    "build_stability_matrix", "build_concept_drift_records",
    "build_data_coverage", "StabilityAlertConfig",
]
