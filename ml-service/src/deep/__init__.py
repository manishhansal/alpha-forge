"""
Phase 3K — Advanced ML / Deep-Learning research package.

Determines whether advanced models (MLP, temporal CNN, LSTM/GRU,
transformer-lite) provide statistically credible, economically meaningful,
stable, INCREMENTAL out-of-sample information beyond the existing classical
AlphaForge stack.

This is a RESEARCH / GOVERNANCE-integrated phase. It:
  - keeps the classical stack as the baseline (a DL model must PROVE value),
  - consumes the same PIT data foundation (Phase 3B/3C/3D),
  - uses the existing walk-forward validation (Phase 3A),
  - calibrates through Phase 3F, executes through Phase 3G, builds portfolios
    through Phase 3H, and measures decay through Phase 3I,
  - registers every deep model into Phase 3J as a CHALLENGER,
  - NEVER auto-promotes a deep model and NEVER auto-replaces the champion.

Implementation is framework-agnostic on a pure-NumPy neural backend for
determinism and dependency-light reproducibility (see
reports/phase-3k-current-deep-learning-audit.md §3.1). An optional torch adapter
is used only if torch is importable.

Modules
-------
schemas.py            — experiment/provenance/complexity/value enums & dataclasses
experiment_registry.py — persistent DL experiment registry + Phase 3J challenger wiring
sequence_builder.py   — PIT-safe versioned sequence construction
normalization.py      — PIT-safe (train-fit only) scalers + cross-sectional transforms
nn_backend.py         — deterministic pure-NumPy neural primitives (layers, optim, seeds)
models.py             — MLP, causal Temporal CNN, LSTM/GRU, transformer-lite; BaseRanker adapters
classical_baselines.py — linear/ridge/elastic-net baselines for fair comparison
training.py           — walk-forward training loop, early stopping, checkpoints, multi-seed
incremental_alpha.py  — incremental IC/EV, residual model, ensemble, disagreement/abstention
integration.py        — calibration/EV/execution/portfolio/decay + complexity/latency
leakage_tests.py      — causality/permutation/negative-control/contamination probes
classification.py     — model-value classification (SUPERIOR/COMPLEMENTARY/...)
"""

from .schemas import (
    ExperimentStatus,
    VALID_EXPERIMENT_TRANSITIONS,
    is_valid_experiment_transition,
    ArchitectureFamily,
    TaskType,
    LossType,
    ComplexityClass,
    ModelValueClass,
    ContaminationStatus,
    OverfitStatus,
    ResearchEvidenceLevel,
    DeepModelProvenance,
    LatencyProfile,
    ComplexityProfile,
    DeepLearningExperiment,
)
from .experiment_registry import (
    DeepExperimentRegistry,
    ExperimentRegistryError,
    InvalidExperimentTransition,
)
from .sequence_builder import (
    SequenceBuilder, SequenceConfig, SequenceBatch,
    MissingnessPolicy, PaddingPolicy, assert_no_future_in_sequence,
)
from .normalization import (
    fit_scaler, FittedScaler, ScalerMethod,
    CrossSectionalNormalizer, CrossSectionalMethod, NormalizationError,
)
from .nn_backend import SeedBundle
from .models import MLPRanker, MLPConfig
from .temporal_models import (
    TemporalConfig, CausalTemporalCNN, RecurrentRanker, TransformerLiteRanker,
)
from .classical_baselines import (
    LinearRanker, RidgeRanker, ElasticNetRanker, LinearConfig,
)
from .comparison import WalkForwardComparator, ModelEvaluation, FoldEvaluation
from .training import (
    DataSplit, grid_search_hpo, HPOResult, SeedRobustness,
    multi_seed_evaluation, select_seed_by_validation,
)
from .incremental_alpha import (
    incremental_alpha_report, IncrementalAlphaReport,
    compute_residual_target, evaluate_residual_model, ResidualModelReport,
    EnsembleWeighter, EnsembleWeights, disagreement_report, DisagreementReport,
)
from .integration import (
    calibrate_deep_probabilities, overfit_report, measure_latency,
    profile_complexity, ic_decay_for_deep,
    execution_adapter_available, portfolio_adapter_available,
)
from .leakage_tests import (
    ProbeResult, causality_probe, future_scaler_probe, future_label_probe,
    label_permutation_probe, negative_control_probe, permutation_importance,
    final_oos_contamination_check, ContaminationCheck,
)
from .classification import (
    classify_model_value, ClassificationInputs, ModelValueDecision,
)

__all__ = [
    "ExperimentStatus",
    "VALID_EXPERIMENT_TRANSITIONS",
    "is_valid_experiment_transition",
    "ArchitectureFamily",
    "TaskType",
    "LossType",
    "ComplexityClass",
    "ModelValueClass",
    "ContaminationStatus",
    "OverfitStatus",
    "ResearchEvidenceLevel",
    "DeepModelProvenance",
    "LatencyProfile",
    "ComplexityProfile",
    "DeepLearningExperiment",
    "DeepExperimentRegistry",
    "ExperimentRegistryError",
    "InvalidExperimentTransition",
    # sequence
    "SequenceBuilder", "SequenceConfig", "SequenceBatch",
    "MissingnessPolicy", "PaddingPolicy", "assert_no_future_in_sequence",
    # normalization
    "fit_scaler", "FittedScaler", "ScalerMethod",
    "CrossSectionalNormalizer", "CrossSectionalMethod", "NormalizationError",
    # backend / models
    "SeedBundle", "MLPRanker", "MLPConfig",
    "TemporalConfig", "CausalTemporalCNN", "RecurrentRanker", "TransformerLiteRanker",
    "LinearRanker", "RidgeRanker", "ElasticNetRanker", "LinearConfig",
    # comparison / training
    "WalkForwardComparator", "ModelEvaluation", "FoldEvaluation",
    "DataSplit", "grid_search_hpo", "HPOResult", "SeedRobustness",
    "multi_seed_evaluation", "select_seed_by_validation",
    # incremental alpha
    "incremental_alpha_report", "IncrementalAlphaReport",
    "compute_residual_target", "evaluate_residual_model", "ResidualModelReport",
    "EnsembleWeighter", "EnsembleWeights", "disagreement_report", "DisagreementReport",
    # integration
    "calibrate_deep_probabilities", "overfit_report", "measure_latency",
    "profile_complexity", "ic_decay_for_deep",
    "execution_adapter_available", "portfolio_adapter_available",
    # leakage / controls
    "ProbeResult", "causality_probe", "future_scaler_probe", "future_label_probe",
    "label_permutation_probe", "negative_control_probe", "permutation_importance",
    "final_oos_contamination_check", "ContaminationCheck",
    # classification
    "classify_model_value", "ClassificationInputs", "ModelValueDecision",
]
