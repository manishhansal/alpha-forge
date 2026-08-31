"""
AlphaForge ML Model Monitoring Package.

Provides drift detection, performance monitoring, feature monitoring,
model registry, and alerting for all deployed ML models.

Sub-modules
-----------
drift_detector      : PSI, KS-statistic, population-level distribution shift
feature_monitor     : Per-feature drift tracking with reference distributions
performance_monitor : Brier score, calibration error, trading expectancy,
                      strategy decay (rolling Sharpe / win-rate / drawdown)
model_registry      : Model versioning, health states, auto safety actions
alerts              : Alert rules, severity levels, structured alert dispatch
"""

from .alerts import Alert, AlertSeverity, AlertSystem
from .drift_detector import DriftDetector, DriftResult, DriftSeverity
from .feature_monitor import FeatureMonitor, FeatureDriftReport
from .model_registry import (
    ModelRecord,
    ModelRegistry,
    ModelState,
    RetrainingRecommendation,
)
from .performance_monitor import (
    PerformanceMonitor,
    PerformanceSnapshot,
    StrategyDecayMetrics,
    TradeOutcome,
)

__all__ = [
    # alerts
    "Alert",
    "AlertSeverity",
    "AlertSystem",
    # drift_detector
    "DriftDetector",
    "DriftResult",
    "DriftSeverity",
    # feature_monitor
    "FeatureMonitor",
    "FeatureDriftReport",
    # model_registry
    "ModelRecord",
    "ModelRegistry",
    "ModelState",
    "RetrainingRecommendation",
    # performance_monitor
    "PerformanceMonitor",
    "PerformanceSnapshot",
    "StrategyDecayMetrics",
    "TradeOutcome",
]
