"""
Phase 3R — Long-running paper-trading operational reliability layer.

An ADDITIVE orchestration package that turns the already-built research / shadow /
paper components into a deterministic, auditable, long-running paper-trading
operation. It REUSES the existing foundation and does NOT rebuild it:

  paper3o.session_lifecycle  — PaperSessionState machine + Phase3OSessionManifest
  paper.paper_engine         — PaperOrder lifecycle + PaperTradingEngine
  shadow.shadow_ledger       — immutable, idempotent, append-only order/fill ledger
  execution.fill_engine      — THE single Phase 3G fill simulator (no second engine)
  execution.position_accounting / cost_model / slippage
  shadow.shadow_reconciliation — predicted-vs-realized reconciliation
  decision.events            — SafetyLayer + KillSwitch + immutable EventLog
  decision.provenance        — assert_not_live (LIVE forbidden, fail-closed)
  paper3o.journals / evidence_store / reliability / gate
  paper.evidence / readiness
  lifecycle._storage         — atomic_write_json / append_jsonl / read_jsonl / FileLock
  data_reliability (3Q)      — ProviderFailure / staleness / redaction / metrics

Phase 3R fills the operational GAPS on top of that foundation:
  session      — PaperSession identity + immutability + config hash (+ INVALIDATED)
  validation   — session-start gate (data / model / risk / execution → START_BLOCKED)
  events       — canonical operational event taxonomy + hash-chained event store
  reconcile    — operational reconciliation across decision/order/fill/position/PnL
  heartbeat    — liveness + latency monitoring (alive ≠ healthy)
  aggregate    — multi-session evidence aggregation (valid + reconciled only)
  report       — the 24-point daily PAPER_SESSION_REPORT

NOTHING here enables a live order path, adds a model, or optimises anything from
paper results. Import-clean: stdlib + already-import-clean src modules only.
"""

from __future__ import annotations

from .session import (
    PaperOpsState, PAPER_OPS_TERMINAL_STATES, VALID_PAPER_OPS_TRANSITIONS,
    is_valid_paper_ops_transition, InvalidPaperOpsTransition,
    EvidenceStatus, SessionConfig, PaperSession,
)
from .validation import (
    StartGate, GateOutcome, StartValidationResult, validate_session_start,
    SessionStartBlocked,
)
from .events import (
    OpEvent, OpEventRecord, EventStore, OrderingAnomaly,
    detect_ordering_anomalies, is_chain_intact,
)
from .accounting import (
    FillLeg, PerfectFillError, simulate_paper_fill,
    PaperPosition, PaperPositionLedger, DailyMark, compute_daily_mark,
)
from .reconcile import (
    DiscrepancyKind, DiscrepancySeverity, Discrepancy, ReconVerdict,
    ReconciliationResult, reconcile_ledgers,
    EODStep, EOD_SEQUENCE, EODResult, run_end_of_day,
)
from .reliability import (
    RecoveryReport, recover_session, RecoveryPhase, RecoveryOutcome,
    ProviderFailureAction, provider_failure_action, evaluate_operational_safety,
    KillSwitchScope, KillSwitchState, KillSwitchRegistry,
    DegradedMode, DegradedState,
)
from .analytics import (
    AbstentionSummary, summarize_abstention, paper_performance,
    Benchmark, benchmark_relative, AlphaAttribution, MarketRegime,
    performance_by_regime, signal_family_activity,
    DriftSignal, DriftEvidence, InvalidationReason, INVALIDATION_REASONS,
    can_claim_tier, MultiSessionAggregate, aggregate_sessions,
)
from .evidence_package import (
    EVIDENCE_SECTIONS, SessionManifest, EvidencePackage, EvidenceSecretLeak,
    ReplayResult, replay_session, RngProvenance,
)
from .monitoring import (
    HealthState, HeartbeatDimension, OperationalHeartbeat,
    LatencyThresholds, LatencyReport, compute_latency,
    build_paper_session_report, PAPER_SESSION_REPORT_FIELDS,
)

__all__ = [
    # session model + state machine
    "PaperOpsState", "PAPER_OPS_TERMINAL_STATES", "VALID_PAPER_OPS_TRANSITIONS",
    "is_valid_paper_ops_transition", "InvalidPaperOpsTransition",
    "EvidenceStatus", "SessionConfig", "PaperSession",
    # session-start validation
    "StartGate", "GateOutcome", "StartValidationResult", "validate_session_start",
    "SessionStartBlocked",
    # event-sourced ledger
    "OpEvent", "OpEventRecord", "EventStore", "OrderingAnomaly",
    "detect_ordering_anomalies", "is_chain_intact",
    # fill bridge + accounting + MTM
    "FillLeg", "PerfectFillError", "simulate_paper_fill",
    "PaperPosition", "PaperPositionLedger", "DailyMark", "compute_daily_mark",
    # end-of-day + reconciliation
    "DiscrepancyKind", "DiscrepancySeverity", "Discrepancy", "ReconVerdict",
    "ReconciliationResult", "reconcile_ledgers",
    "EODStep", "EOD_SEQUENCE", "EODResult", "run_end_of_day",
    # crash recovery + failure handling + kill switches + degraded modes
    "RecoveryReport", "recover_session", "RecoveryPhase", "RecoveryOutcome",
    "ProviderFailureAction", "provider_failure_action", "evaluate_operational_safety",
    "KillSwitchScope", "KillSwitchState", "KillSwitchRegistry",
    "DegradedMode", "DegradedState",
    # evidence + analytics + aggregation
    "AbstentionSummary", "summarize_abstention", "paper_performance",
    "Benchmark", "benchmark_relative", "AlphaAttribution", "MarketRegime",
    "performance_by_regime", "signal_family_activity",
    "DriftSignal", "DriftEvidence", "InvalidationReason", "INVALIDATION_REASONS",
    "can_claim_tier", "MultiSessionAggregate", "aggregate_sessions",
    # evidence package + manifest + replay + determinism
    "EVIDENCE_SECTIONS", "SessionManifest", "EvidencePackage", "EvidenceSecretLeak",
    "ReplayResult", "replay_session", "RngProvenance",
    # heartbeat + latency + daily report
    "HealthState", "HeartbeatDimension", "OperationalHeartbeat",
    "LatencyThresholds", "LatencyReport", "compute_latency",
    "build_paper_session_report", "PAPER_SESSION_REPORT_FIELDS",
]
