"""
AlphaForge ML Model Monitoring Package.

Provides drift detection, performance monitoring, feature monitoring,
model registry, and alerting for all deployed ML models.

Lazy-import design
------------------
drift_detector.py imports scipy. monitoring/__init__.py must NOT force scipy
to load — only calling drift detection functions should do that.

ModelRecord and ModelRegistry are imported eagerly since they only depend
on stdlib (dataclasses, threading, json, pathlib).
"""

from __future__ import annotations


# ── Eager imports (stdlib only — no optional deps) ────────────────────────────
from .model_registry import (
    ModelRecord,
    ModelRegistry,
    ModelState,
    RetrainingRecommendation,
)

# ── Lazy imports (have optional deps — scipy, etc.) ───────────────────────────

def __getattr__(name: str):
    if name in ("DriftDetector", "DriftResult", "DriftSeverity"):
        from .drift_detector import (  # noqa: PLC0415
            DriftDetector,
            DriftResult,
            DriftSeverity,
        )
        _MAP = {
            "DriftDetector":  DriftDetector,
            "DriftResult":    DriftResult,
            "DriftSeverity":  DriftSeverity,
        }
        return _MAP[name]

    if name in ("FeatureMonitor", "FeatureDriftReport"):
        from .feature_monitor import FeatureMonitor, FeatureDriftReport  # noqa: PLC0415
        _MAP = {"FeatureMonitor": FeatureMonitor, "FeatureDriftReport": FeatureDriftReport}
        return _MAP[name]

    if name in ("Alert", "AlertSeverity", "AlertSystem"):
        from .alerts import Alert, AlertSeverity, AlertSystem  # noqa: PLC0415
        _MAP = {"Alert": Alert, "AlertSeverity": AlertSeverity, "AlertSystem": AlertSystem}
        return _MAP[name]

    raise AttributeError(f"module 'src.monitoring' has no attribute '{name}'")


__all__ = [
    "ModelRecord",
    "ModelRegistry",
    "ModelState",
    "RetrainingRecommendation",
    "DriftDetector",
    "DriftResult",
    "DriftSeverity",
    "FeatureMonitor",
    "FeatureDriftReport",
    "Alert",
    "AlertSeverity",
    "AlertSystem",
]
