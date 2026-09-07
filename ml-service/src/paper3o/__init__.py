"""
Phase 3O — Paper-Trading Evidence Accumulation, Reliability & Go/No-Go Gate.

This package is a VALIDATION / EVIDENCE layer. It adds no predictive model and
introduces no parallel implementation of the canonical layers — it ORCHESTRATES
and MEASURES the already-built Phase 3A–3N stack to decide whether AlphaForge is
trustworthy enough to CONTINUE accumulating paper evidence.

Modules
-------
  session_lifecycle.py  formal PaperSession (§7 metadata + §8 state machine) with
                        immutability/revisions, replay identity, chronological guard
  journals.py           decision / order / position journals (§13/§15/§16)
  evidence_store.py     multi-session accumulation, evidence tiers E0–E5,
                        official-vs-diagnostic, experiment registry (§9,§47,§49–§52)
  analysis.py           benchmarks / alpha attribution / ablation / RL comparison /
                        cost / turnover / capacity (§18–§24)
  quality.py            calibration / EV validation / decile monotonicity /
                        cross-sectional / regime / signal-family / correlation /
                        drift / alpha-decay / latency / session-quality (§25–§31,§36,§46,§57,§58)
  reliability.py        failure-rate / provider-reliability / failover / recovery /
                        reconciliation invariants / idempotency (§37–§43)
  gate.py               7-dimension Go/No-Go → PAPER_CONTINUE /
                        PAPER_CONTINUE_WITH_LIMITATIONS / PAPER_BLOCKED (§70–§73)

Guarantees: paper/shadow/research only (LIVE forbidden, reuses
`decision.provenance.assert_not_live`); no broker path; no auto-retraining /
recalibration / promotion; no threshold tuning on paper results. Import-clean
(numpy + stdlib; heavy deps lazy).
"""

from .session_lifecycle import (
    PaperSessionState, SESSION_TERMINAL_STATES, VALID_SESSION_TRANSITIONS,
    InvalidSessionTransition, is_valid_session_transition,
    Phase3OSessionManifest, PaperSessionLifecycle, ChronologyViolation,
)

from .journals import (
    DecisionOutcome, is_deliberate_non_trade,
    DecisionSnapshot, PaperOrderJournalEntry, PositionJournalEntry,
    DecisionJournal, OrderJournal, PositionJournal,
)
from .evidence_store import (
    EvidenceTier, tier_rank, EvidenceClass, ContaminationReason,
    SessionEvidence, MultiSessionStore,
    ExperimentType, ExperimentStatus, Experiment, ExperimentRegistry,
)
from .analysis import (
    BaselineType, baseline_returns, ExecutionBaseline, execution_shortfall,
    AttributionStatus, ATTRIBUTION_STAGES, StageAttribution, alpha_attribution,
    AblationComponent, SAFETY_COMPONENTS, AblationVerdict, SafetyAblationError,
    ablation_verdict, assert_ablatable,
    RL_EXECUTION_DIMENSIONS, RLComparison, rl_execution_comparison,
    CostAttribution, cost_attribution, turnover_analysis,
    CapacityStatus, capacity_analysis,
)
from .quality import (
    CalibrationStatus, calibration_report, calibration_oos_vs_paper,
    ev_validation, MonotonicityStatus, decile_monotonicity,
    cross_sectional_ic, regime_breakdown, signal_family_correlation,
    DriftStatus, drift_status, alpha_decay, latency_vs_timeframe,
    QualityDimension, QualityStatus, QUALITY_DIMENSIONS, SessionQuality,
    StabilityClass, stability_classification,
)
from .reliability import (
    FailureCategory, FailureEvent, FailureTracker,
    ProviderObservation, ProviderReliabilityTracker,
    FailoverOutcome, UnsafeFailover, resolve_failover,
    RecoveryPhase, RecoveryOutcome, recovery_decision,
    AccountingLedger, ReconciliationStatus, reconcile_accounting,
    IdempotencyGuard,
)
from .gate import (
    GateDimension, GRADED_DIMENSIONS, BINARY_DIMENSIONS, GateStatus,
    FinalStatus, BlockerReason, GateResult, GoNoGoGate, Phase3OManifest,
)

__all__ = [
    # session lifecycle
    "PaperSessionState", "SESSION_TERMINAL_STATES", "VALID_SESSION_TRANSITIONS",
    "InvalidSessionTransition", "is_valid_session_transition",
    "Phase3OSessionManifest", "PaperSessionLifecycle", "ChronologyViolation",
    # journals
    "DecisionOutcome", "is_deliberate_non_trade",
    "DecisionSnapshot", "PaperOrderJournalEntry", "PositionJournalEntry",
    "DecisionJournal", "OrderJournal", "PositionJournal",
    # evidence store
    "EvidenceTier", "tier_rank", "EvidenceClass", "ContaminationReason",
    "SessionEvidence", "MultiSessionStore",
    "ExperimentType", "ExperimentStatus", "Experiment", "ExperimentRegistry",
    # analysis
    "BaselineType", "baseline_returns", "ExecutionBaseline", "execution_shortfall",
    "AttributionStatus", "ATTRIBUTION_STAGES", "StageAttribution", "alpha_attribution",
    "AblationComponent", "SAFETY_COMPONENTS", "AblationVerdict", "SafetyAblationError",
    "ablation_verdict", "assert_ablatable",
    "RL_EXECUTION_DIMENSIONS", "RLComparison", "rl_execution_comparison",
    "CostAttribution", "cost_attribution", "turnover_analysis",
    "CapacityStatus", "capacity_analysis",
    # quality / statistical
    "CalibrationStatus", "calibration_report", "calibration_oos_vs_paper",
    "ev_validation", "MonotonicityStatus", "decile_monotonicity",
    "cross_sectional_ic", "regime_breakdown", "signal_family_correlation",
    "DriftStatus", "drift_status", "alpha_decay", "latency_vs_timeframe",
    "QualityDimension", "QualityStatus", "QUALITY_DIMENSIONS", "SessionQuality",
    "StabilityClass", "stability_classification",
    # reliability
    "FailureCategory", "FailureEvent", "FailureTracker",
    "ProviderObservation", "ProviderReliabilityTracker",
    "FailoverOutcome", "UnsafeFailover", "resolve_failover",
    "RecoveryPhase", "RecoveryOutcome", "recovery_decision",
    "AccountingLedger", "ReconciliationStatus", "reconcile_accounting",
    "IdempotencyGuard",
    # gate + manifest
    "GateDimension", "GRADED_DIMENSIONS", "BINARY_DIMENSIONS", "GateStatus",
    "FinalStatus", "BlockerReason", "GateResult", "GoNoGoGate", "Phase3OManifest",
]
