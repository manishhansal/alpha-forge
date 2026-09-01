"""
AlphaForge Meta Decision Engine
================================

Combines predictions from all base models into a single, calibrated,
explainable trading decision.

Public API
----------
    from src.meta import MetaDecisionEngine, MetaInput, MetaOutput

    engine = MetaDecisionEngine()
    result: MetaOutput = engine.decide(meta_input)

Modules
-------
calibration      — Platt scaling + isotonic regression per model
ensemble         — Contextual (regime-aware) model weighting
abstention       — WAIT / NO_TRADE abstention logic
decision_policy  — Confidence decomposition and reason codes
meta_model       — Orchestrator, OOS training, final decision assembly
"""

from .meta_model import MetaDecisionEngine, MetaInput, MetaOutput
from .abstention import AbstentionDecision, AbstentionReason
from .calibration import CalibrationStore
from .ensemble import EnsembleWeighter
from .decision_policy import ConfidenceDecomposition, DecisionPolicy

__all__ = [
    "MetaDecisionEngine",
    "MetaInput",
    "MetaOutput",
    "AbstentionDecision",
    "AbstentionReason",
    "CalibrationStore",
    "EnsembleWeighter",
    "ConfidenceDecomposition",
    "DecisionPolicy",
]
