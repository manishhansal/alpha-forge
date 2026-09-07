"""
Phase 3N — Indian Market Paper-Trading Validation & Production-Readiness Gate.

This package is a VALIDATION + PAPER-TRADING layer. It does NOT add a predictive
model and it does NOT acquire data itself — it ORCHESTRATES and VALIDATES the
already-built Phase 3A–3M stack against (tagged) Indian-market data and produces
honest, reproducible evidence for a production-readiness decision.

Hard guarantees (enforced in code + tests):
  * Paper / shadow / research ONLY. LIVE is forbidden (reuses
    `decision.provenance.assert_not_live`). No broker order path.
  * No auto-retraining, no auto-recalibration, no auto-promotion.
  * No new NSE scraper; the canonical provider hierarchy is
    DataService → Angel One → Upstox → Yahoo (Tier 0→3).
  * Point-in-time: information_timestamp ≤ decision_time for every input.
  * Real vs synthetic vs replay data is always tagged; synthetic data can never
    become official performance evidence.

Modules
-------
  providers.py   canonical provider-response contract + fallback classification
                 + config-driven cross-provider consistency validation
  (later tasks add: data_quality.py, signals.py, paper_engine.py,
   session.py, evidence.py, readiness.py)

Import hygiene: pure stdlib + numpy; any heavy dependency is lazy-imported.
"""

from .providers import (
    ProviderId, PROVIDER_HIERARCHY,
    SourceStatus, ResponseStatus, FallbackRole,
    AssetType, DataTag,
    ProviderResponse, ProviderChainResult, FallbackEvent,
    ConsistencyPolicy, FieldTolerance, CrossProviderComparison, FieldMismatch,
    ProviderChain, cross_provider_compare,
)
from .data_quality import (
    QualitySeverity, QualityIssue, QualityReport,
    SessionType, SessionClassification, classify_session,
    assert_no_regular_session_on_holiday,
    Freshness, FreshnessPolicy, classify_freshness,
    validate_ohlcv_bars,
    validate_fno_metadata, validate_option_chain,
    validate_corporate_action_pit,
    validate_universe_membership, reject_future_universe_membership,
    TimestampedInput, assert_no_lookahead,
)

__all__ = [
    # providers
    "ProviderId", "PROVIDER_HIERARCHY",
    "SourceStatus", "ResponseStatus", "FallbackRole",
    "AssetType", "DataTag",
    "ProviderResponse", "ProviderChainResult", "FallbackEvent",
    "ConsistencyPolicy", "FieldTolerance", "CrossProviderComparison", "FieldMismatch",
    "ProviderChain", "cross_provider_compare",
    # data quality / PIT
    "QualitySeverity", "QualityIssue", "QualityReport",
    "SessionType", "SessionClassification", "classify_session",
    "assert_no_regular_session_on_holiday",
    "Freshness", "FreshnessPolicy", "classify_freshness",
    "validate_ohlcv_bars",
    "validate_fno_metadata", "validate_option_chain",
    "validate_corporate_action_pit",
    "validate_universe_membership", "reject_future_universe_membership",
    "TimestampedInput", "assert_no_lookahead",
]

from .signals import (
    SignalFamily, Direction, EvidenceLevel, SignalStatus,
    CanonicalSignal, ConflictType, ProposedAction,
    AggregationPolicy, SignalAggregate, aggregate_signals,
)

__all__ += [
    "SignalFamily", "Direction", "EvidenceLevel", "SignalStatus",
    "CanonicalSignal", "ConflictType", "ProposedAction",
    "AggregationPolicy", "SignalAggregate", "aggregate_signals",
]

from .paper_engine import (
    PaperOrderState, InvalidPaperOrderTransition, is_valid_order_transition,
    PaperOrder, PaperPositionBook, PaperFillResult, PaperTradingEngine,
)

__all__ += [
    "PaperOrderState", "InvalidPaperOrderTransition", "is_valid_order_transition",
    "PaperOrder", "PaperPositionBook", "PaperFillResult", "PaperTradingEngine",
]

from .session import (
    KillSwitchReason, EvidenceStatus, ReconciliationStatus,
    PaperSessionManifest, EODReconciliation, PaperSession,
)

__all__ += [
    "KillSwitchReason", "EvidenceStatus", "ReconciliationStatus",
    "PaperSessionManifest", "EODReconciliation", "PaperSession",
]

from .evidence import (
    MetricStatus, EvidencePolicy, Metric,
    bootstrap_ci, compute_return_metrics, compute_trading_metrics,
    compute_decision_quality, conditional_breakdown,
    benjamini_hochberg, bonferroni, filter_official_evidence,
)
from .readiness import (
    GateStatus, PaperReadiness, GATE_ORDER,
    GateResult, ReadinessReport, ReadinessEvaluator,
)

__all__ += [
    "MetricStatus", "EvidencePolicy", "Metric",
    "bootstrap_ci", "compute_return_metrics", "compute_trading_metrics",
    "compute_decision_quality", "conditional_breakdown",
    "benjamini_hochberg", "bonferroni", "filter_official_evidence",
    "GateStatus", "PaperReadiness", "GATE_ORDER",
    "GateResult", "ReadinessReport", "ReadinessEvaluator",
]
