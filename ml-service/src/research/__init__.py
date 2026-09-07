"""
Phase 3S — Research Factory & Experimentation Governance.

An additive research layer over the existing AlphaForge ML/quant stack. It lets
AlphaForge discover alpha WITHOUT fooling itself: pre-registered falsifiable
hypotheses, immutable experiment identity, versioned data snapshots, leakage
guards, walk-forward validation with an untouched final OOS, baseline-first and
ablation frameworks, incremental-alpha tests, placebo/negative controls,
multiple-testing correction, deterministic reproduction, immutable evidence
packages, and a strict promotion boundary (research may only RECOMMEND a
challenger candidate — it never promotes, retrains, recalibrates, or trades).

This package NEVER: enables live trading, places orders, auto-promotes, auto-
retrains/recalibrates, optimizes thresholds/weights from paper results, tunes
against the final OOS, or mutates historical evidence.
"""

from __future__ import annotations

# §5-§7 hypothesis + pre-registration
from src.research.hypothesis import (
    HypothesisType,
    HYPOTHESIS_TYPES,
    ExpectedDirection,
    Hypothesis,
    HypothesisError,
    PreRegistration,
    PreRegistrationError,
    HypothesisRegistry,
)

# §3, §4, §44 experiment identity + manifest
from src.research.manifest import (
    ExperimentStatus,
    TERMINAL_STATUSES,
    is_valid_status_transition,
    ExperimentImmutabilityError,
    ExperimentManifest,
    ResearchExperimentRegistry,
)

# §8, §9 metric registry + primary metric
from src.research.metrics import (
    MetricDirection,
    UncertaintyMethod,
    MetricError,
    MetricDefinition,
    MetricRegistry,
    DEFAULT_METRIC_REGISTRY,
)

# §10, §11 data snapshot + universe
from src.research.data_snapshot import (
    DataSnapshotError,
    UniverseConstruction,
    Universe,
    ResearchDataSnapshot,
    build_research_snapshot,
)

# §12-§15 feature registry + provenance + leakage guards
from src.research.features import (
    FeatureCategory,
    FeatureError,
    LeakageInvalidation,
    FeatureProvenance,
    ResearchFeature,
    ResearchFeatureRegistry,
    LeakageReport,
    audit_feature_leakage,
    check_normalization_causal,
)

# §16 validation engine + untouched OOS
from src.research.validation import (
    ValidationScheme,
    OOSAccessError,
    ResearchSplit,
    build_research_split,
    walk_forward_folds,
    SealedOOS,
)

# §17 experiment tiers
from src.research.experiment_tiers import (
    ExperimentTier,
    tier_rank,
    PROMOTABLE_TIER,
    TierEvidence,
    classify_tier,
    is_promotable,
)

# §18 baseline-first
from src.research.baseline import (
    BaselineType,
    ALL_BASELINES,
    BaselineError,
    BaselineResult,
    BaselineComparison,
    compare_to_baseline,
    require_baseline,
)

# §19 ablation
from src.research.ablation import (
    AblationKind,
    AblationCase,
    AblationContribution,
    AblationReport,
    build_ablation_report,
)

# §20-§23 incremental alpha + correlated signal + diagnostics
from src.research.incremental import (
    IncrementalVerdict,
    IncrementalResult,
    incremental_alpha_test,
    SignalRelationship,
    CorrelatedSignalResult,
    audit_correlated_signal,
    CrossSectionalReport,
    cross_sectional_diagnostics,
    TimeSeriesReport,
    time_series_diagnostics,
)

# §29, §30, §35 statistics + multiple testing + DSR + PBO + reality check
from src.research.statistics import (
    bootstrap_ci_for,
    CorrectionMethod,
    holm_correction,
    MultipleTestingResult,
    correct_multiple_testing,
    DeflatedSharpeResult,
    deflated_sharpe_ratio,
    PBOResult,
    probability_backtest_overfitting,
    RealityCheckResult,
    whites_reality_check,
)

# §32-§37, §45, §46 controls
from src.research.controls import (
    PlaceboResult,
    placebo_test,
    NegativeControlResult,
    negative_control_test,
    MultiSeedResult,
    multi_seed_evaluate,
    DEGREES_OF_FREEDOM,
    DegreesOfFreedomReport,
    DataSnoopingReport,
    data_snooping_report,
    HPOGovernanceError,
    HPORunRecord,
)

# §40, §50 research status + failure taxonomy
from src.research.status import (
    ResearchStatus,
    status_rank,
    NEGATIVE_STATES,
    FailureReason,
    FAILURE_REASONS,
)

# §38 experiment comparison
from src.research.comparison import (
    ComparabilityStatus,
    COMPARISON_KEYS,
    ComparisonResult,
    check_comparable,
)

# §39 leaderboard
from src.research.leaderboard import (
    LeaderboardClass,
    LEADERBOARD_COLUMNS,
    LeaderboardRow,
    Leaderboard,
)

# §51 research gates
from src.research.gates import (
    ResearchGate,
    RESEARCH_GATE_ORDER,
    GateResult,
    GateConditions,
    GateOutcome,
    GateReport,
    evaluate_research_gates,
)

# §42, §43, §44 artifact + reproduction
from src.research.artifact import (
    ARTIFACT_SECTIONS,
    ArtifactError,
    ArtifactSecretLeak,
    ReproductionStatus,
    ExperimentArtifact,
    ReproductionResult,
    reproduce,
)

# §41, §52, §56 factory + promotion boundary + isolation
from src.research.factory import (
    RecommendationOutcome,
    PromotionBoundaryError,
    RecommendationDecision,
    ResearchFactory,
    IsolationGuard,
)

__all__ = [
    # hypothesis
    "HypothesisType", "HYPOTHESIS_TYPES", "ExpectedDirection", "Hypothesis",
    "HypothesisError", "PreRegistration", "PreRegistrationError", "HypothesisRegistry",
    # manifest
    "ExperimentStatus", "TERMINAL_STATUSES", "is_valid_status_transition",
    "ExperimentImmutabilityError", "ExperimentManifest", "ResearchExperimentRegistry",
    # metrics
    "MetricDirection", "UncertaintyMethod", "MetricError", "MetricDefinition",
    "MetricRegistry", "DEFAULT_METRIC_REGISTRY",
    # data snapshot
    "DataSnapshotError", "UniverseConstruction", "Universe", "ResearchDataSnapshot",
    "build_research_snapshot",
    # features
    "FeatureCategory", "FeatureError", "LeakageInvalidation", "FeatureProvenance",
    "ResearchFeature", "ResearchFeatureRegistry", "LeakageReport",
    "audit_feature_leakage", "check_normalization_causal",
    # validation
    "ValidationScheme", "OOSAccessError", "ResearchSplit", "build_research_split",
    "walk_forward_folds", "SealedOOS",
    # tiers
    "ExperimentTier", "tier_rank", "PROMOTABLE_TIER", "TierEvidence",
    "classify_tier", "is_promotable",
    # baseline
    "BaselineType", "ALL_BASELINES", "BaselineError", "BaselineResult",
    "BaselineComparison", "compare_to_baseline", "require_baseline",
    # ablation
    "AblationKind", "AblationCase", "AblationContribution", "AblationReport",
    "build_ablation_report",
    # incremental / diagnostics
    "IncrementalVerdict", "IncrementalResult", "incremental_alpha_test",
    "SignalRelationship", "CorrelatedSignalResult", "audit_correlated_signal",
    "CrossSectionalReport", "cross_sectional_diagnostics",
    "TimeSeriesReport", "time_series_diagnostics",
    # statistics
    "bootstrap_ci_for", "CorrectionMethod", "holm_correction",
    "MultipleTestingResult", "correct_multiple_testing", "DeflatedSharpeResult",
    "deflated_sharpe_ratio", "PBOResult", "probability_backtest_overfitting",
    "RealityCheckResult", "whites_reality_check",
    # controls
    "PlaceboResult", "placebo_test", "NegativeControlResult", "negative_control_test",
    "MultiSeedResult", "multi_seed_evaluate", "DEGREES_OF_FREEDOM",
    "DegreesOfFreedomReport", "DataSnoopingReport", "data_snooping_report",
    "HPOGovernanceError", "HPORunRecord",
    # status
    "ResearchStatus", "status_rank", "NEGATIVE_STATES", "FailureReason",
    "FAILURE_REASONS",
    # comparison
    "ComparabilityStatus", "COMPARISON_KEYS", "ComparisonResult", "check_comparable",
    # leaderboard
    "LeaderboardClass", "LEADERBOARD_COLUMNS", "LeaderboardRow", "Leaderboard",
    # gates
    "ResearchGate", "RESEARCH_GATE_ORDER", "GateResult", "GateConditions",
    "GateOutcome", "GateReport", "evaluate_research_gates",
    # artifact
    "ARTIFACT_SECTIONS", "ArtifactError", "ArtifactSecretLeak", "ReproductionStatus",
    "ExperimentArtifact", "ReproductionResult", "reproduce",
    # factory
    "RecommendationOutcome", "PromotionBoundaryError", "RecommendationDecision",
    "ResearchFactory", "IsolationGuard",
]
