"""
Phase 3M — Research-to-Production Integration & Decision Orchestration.

The `decision` package is the ONE canonical, deterministic, fail-closed,
replayable decision pipeline that ORCHESTRATES the validated Phase 3A–3L
components (it never reimplements them). It provides:

  schema.py      canonical CanonicalDecision contract (spec §4)
  state.py       explicit fail-closed DecisionState machine (spec §5)
  provenance.py  ReplayManifest + DecisionProvenance + LIVE-forbidden guard
  validation.py  dependency validation, model compatibility, staleness
  events.py      immutable event log + kill switches / safety layer
  pipeline.py    DecisionPipeline orchestrator (12 stages, fail-closed)
  monitoring.py  structured 9-dimension health orchestration
  api.py         minimal FastAPI router (research/shadow/paper; LIVE disabled)

Import hygiene: this package depends only on import-clean modules (meta,
monitoring, lifecycle, stability, execution, portfolio, rl, prediction_provenance,
schemas) and lazy-imports heavy model classes. It does NOT import server.py or
models.market_regime (talib) at module load.

Guarantees: no live broker, no auto-retraining, no auto-recalibration, no
auto-promotion. LIVE deployment is forbidden.
"""

from .state import (
    DecisionState, NON_EXECUTABLE_STATES, TERMINAL_STATES, VALID_TRANSITIONS,
    is_valid_transition, is_executable, InvalidStateTransition,
)
from .schema import CanonicalDecision, new_decision_id
from .provenance import (
    ReplayManifest, DecisionProvenance, LiveExecutionForbidden,
    assert_not_live, normalize_mode, state_hash, ALLOWED_DEPLOYMENT_MODES,
)
from .validation import (
    Staleness, StalenessConfig, ValidationResult, ModelCompatibility,
    validate_data, validate_features, validate_model, validate_calibration,
    validate_portfolio, validate_execution, validate_rl, assess_staleness,
)
from .events import (
    EventType, DecisionEvent, EventLog,
    KillSwitch, SafetyGateResult, SafetyInputs, SafetyLayer,
)
from .pipeline import (
    DecisionPipeline, PipelineInputs, PipelineOutput, StageResult, StageStatus,
)
from .monitoring import (
    HealthState, DimensionHealth, SystemHealth, HealthOrchestrator,
    data_health, feature_health, model_health, calibration_health,
    alpha_health, risk_health, execution_health, rl_health,
)

__all__ = [
    # state
    "DecisionState", "NON_EXECUTABLE_STATES", "TERMINAL_STATES", "VALID_TRANSITIONS",
    "is_valid_transition", "is_executable", "InvalidStateTransition",
    # schema
    "CanonicalDecision", "new_decision_id",
    # provenance
    "ReplayManifest", "DecisionProvenance", "LiveExecutionForbidden",
    "assert_not_live", "normalize_mode", "state_hash", "ALLOWED_DEPLOYMENT_MODES",
    # validation
    "Staleness", "StalenessConfig", "ValidationResult", "ModelCompatibility",
    "validate_data", "validate_features", "validate_model", "validate_calibration",
    "validate_portfolio", "validate_execution", "validate_rl", "assess_staleness",
    # events / safety
    "EventType", "DecisionEvent", "EventLog",
    "KillSwitch", "SafetyGateResult", "SafetyInputs", "SafetyLayer",
    # pipeline
    "DecisionPipeline", "PipelineInputs", "PipelineOutput", "StageResult", "StageStatus",
    # monitoring
    "HealthState", "DimensionHealth", "SystemHealth", "HealthOrchestrator",
    "data_health", "feature_health", "model_health", "calibration_health",
    "alpha_health", "risk_health", "execution_health", "rl_health",
]
