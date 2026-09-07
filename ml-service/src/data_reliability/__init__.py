"""
Phase 3Q — Production Indian-market Data-Reliability layer.

An ADDITIVE package that makes the Indian-market data foundation operationally
trustworthy. It REUSES the existing foundation (paper.providers, paper.data_quality,
data.point_in_time, data.instrument_master, data.corporate_actions,
data.historical_universe, data.dataset_version, data.lineage,
execution.market_calendar, monitoring) and fills the production-reliability gaps:

  failure       — typed provider-failure taxonomy (NO_DATA vs PROVIDER_FAILURE …)
  calendar_ext  — prev_trading_session, valid-market-bar, Muhurat
  stale         — frozen-feed + timestamp-regression + combined staleness verdict
  consistency   — named PROVIDER_CONFLICT verdict over cross_provider_compare

Nothing here reintroduces NSE-in-TS, adds a model, or touches a live order path.
Import-clean: stdlib + already-import-clean src modules only.
"""

from __future__ import annotations

from .failure import (
    ProviderFailure, is_fallback_eligible, is_retryable,
    to_source_status, to_response_status,
)
from .calendar_ext import (
    IST, is_muhurat_session, prev_trading_session, BarValidity, is_valid_market_bar,
)
from .stale import (
    StaleReason, StaleAssessment, detect_frozen_feed,
    detect_timestamp_regression, assess_staleness,
)
from .consistency import (
    ConsistencyVerdict, ConsistencyResult, check_provider_consistency,
)
from .completeness import (
    INTERVAL_SECONDS, BarState, CompletenessStatus, CompletenessReport,
    classify_last_bar_state, assess_completeness,
)
from .ohlc_repair import (
    RepairAction, RepairRecord, SanitizedSeries, sanitize_bars,
)
from .adjustment import (
    AdjustmentMode, AdjustmentModeError, AdjustedSeries,
    assert_same_mode, can_compute_returns,
)
from .feature_availability import (
    FeatureAvailability, FeatureValue, available, true_zero, missing,
    data_insufficient, all_usable, unusable_features,
)
from .quality_gate import (
    DQVerdict, DataQualityDecision, evaluate_data_quality,
)
from .signal_safety import (
    SignalGate, SIGNAL_GATE_ORDER, SignalDecision, NoDecisionReason,
    SignalSafetyResult, evaluate_signal_safety, NO_SIGNAL_CONDITIONS,
)
from .retry import (
    RetryPolicy, RetryTermination, RetryOutcome, retry_with_backoff,
)
from .idempotency import (
    dedup_key, IngestResult, IdempotentIngest,
)
from .cache import (
    CacheStatus, CacheEntry, CacheLookup, CacheStore,
)
from .lineage_ext import (
    DataLineageRecord, record_lineage,
)
from .snapshot import (
    SnapshotIdentity, compute_snapshot_identity,
)
from .replay import (
    ReplayResult, ReplayDriver,
)
from .correction import (
    ObservationVersion, CorrectionEntry, CorrectionLog,
)
from .monitoring import (
    MetricRegistry, ALL_METRICS, PROVIDER_METRICS, DATA_METRICS,
    MARKET_METRICS, PIPELINE_METRICS,
)
from .alerts_ext import (
    DataAlertSeverity, DataAlertKind, DataAlert, severity_for,
    make_data_alert, to_monitoring_severity,
)
from .security import (
    REDACTED, redact_mapping, redact_headers, redact_text, contains_secret,
)
from .health import (
    ProviderHealth, DataHealthReport,
)
from .ratelimit import (
    RateDecision, TokenBucket, RateLimiter,
)
from .events import (
    ObservabilityEvent, EventRecord, EventLog,
)
from .signal_matrix import (
    SignalFamily, DataSurface, PITRequirement, SignalDataContract,
    SIGNAL_DATA_MATRIX, get_contract, all_contracts,
    OverlapKind, OverlapNote, DOUBLE_COUNTING_AUDIT, audit_notes,
)
from .harness import (
    InstrumentHealthCheck, HarnessReport, build_instrument_check,
    DEFAULT_HARNESS_INSTRUMENTS,
)

__all__ = [
    # failure taxonomy
    "ProviderFailure", "is_fallback_eligible", "is_retryable",
    "to_source_status", "to_response_status",
    # calendar extension
    "IST", "is_muhurat_session", "prev_trading_session", "BarValidity",
    "is_valid_market_bar",
    # stale detection
    "StaleReason", "StaleAssessment", "detect_frozen_feed",
    "detect_timestamp_regression", "assess_staleness",
    # consistency
    "ConsistencyVerdict", "ConsistencyResult", "check_provider_consistency",
    # completeness + forming/closed bar
    "INTERVAL_SECONDS", "BarState", "CompletenessStatus", "CompletenessReport",
    "classify_last_bar_state", "assess_completeness",
    # OHLC repair policy
    "RepairAction", "RepairRecord", "SanitizedSeries", "sanitize_bars",
    # adjustment mode
    "AdjustmentMode", "AdjustmentModeError", "AdjustedSeries",
    "assert_same_mode", "can_compute_returns",
    # feature availability
    "FeatureAvailability", "FeatureValue", "available", "true_zero", "missing",
    "data_insufficient", "all_usable", "unusable_features",
    # canonical data-quality gate
    "DQVerdict", "DataQualityDecision", "evaluate_data_quality",
    # signal safety
    "SignalGate", "SIGNAL_GATE_ORDER", "SignalDecision", "NoDecisionReason",
    "SignalSafetyResult", "evaluate_signal_safety", "NO_SIGNAL_CONDITIONS",
    # retry / backoff
    "RetryPolicy", "RetryTermination", "RetryOutcome", "retry_with_backoff",
    # idempotency
    "dedup_key", "IngestResult", "IdempotentIngest",
    # cache integrity
    "CacheStatus", "CacheEntry", "CacheLookup", "CacheStore",
    # extended lineage
    "DataLineageRecord", "record_lineage",
    # reproducible snapshot identity
    "SnapshotIdentity", "compute_snapshot_identity",
    # live-day replay
    "ReplayResult", "ReplayDriver",
    # correction policy
    "ObservationVersion", "CorrectionEntry", "CorrectionLog",
    # monitoring metrics
    "MetricRegistry", "ALL_METRICS", "PROVIDER_METRICS", "DATA_METRICS",
    "MARKET_METRICS", "PIPELINE_METRICS",
    # alert severity
    "DataAlertSeverity", "DataAlertKind", "DataAlert", "severity_for",
    "make_data_alert", "to_monitoring_severity",
    # security redaction
    "REDACTED", "redact_mapping", "redact_headers", "redact_text", "contains_secret",
    # data-health API
    "ProviderHealth", "DataHealthReport",
    # rate-limit safety
    "RateDecision", "TokenBucket", "RateLimiter",
    # observability events
    "ObservabilityEvent", "EventRecord", "EventLog",
    # signal-family data-dependency matrix + double-counting audit
    "SignalFamily", "DataSurface", "PITRequirement", "SignalDataContract",
    "SIGNAL_DATA_MATRIX", "get_contract", "all_contracts",
    "OverlapKind", "OverlapNote", "DOUBLE_COUNTING_AUDIT", "audit_notes",
    # current-day validation harness (paper/shadow only)
    "InstrumentHealthCheck", "HarnessReport", "build_instrument_check",
    "DEFAULT_HARNESS_INSTRUMENTS",
]
