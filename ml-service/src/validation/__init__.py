"""
AlphaForge Financial Machine Learning Validation Framework.

Provides institutional-grade cross-validation tools that respect the temporal
ordering of financial time series and prevent information leakage.

Modules
-------
walk_forward
    Walk-forward validation with configurable rolling or expanding windows.
    Produces strictly time-ordered train/validate/test folds.

purged_kfold
    K-Fold Cross-Validation with label purging and embargo periods.
    scikit-learn compatible (BaseCrossValidator interface).

embargo
    Embargo period applier — excludes observations adjacent to fold boundaries
    to prevent serial correlation leakage from overlapping labels.
    Supports bars, minutes, and days as the embargo unit.

combinatorial_cv
    Combinatorial Purged Cross-Validation (CPCV) for high-confidence
    strategy evaluation.  Generates C(N, k) unique train/test paths.

metrics
    Classification metrics (accuracy, precision, recall, F1, ROC-AUC) and
    trading metrics (Sharpe, Sortino, max drawdown, profit factor, expectancy,
    turnover).  Includes a ModelAcceptanceGate that enforces the dual-pass
    requirement: classification performance AND trading performance must both
    meet their respective thresholds.

Quick start
-----------
    from src.validation import (
        WalkForwardValidator, WalkForwardConfig,
        PurgedKFold, build_t1_series,
        EmbargoConfig,
        CombinatorialPurgedCV, CPCVConfig,
        FinancialMetricsEvaluator, ModelAcceptanceGate,
    )

    # Walk-forward with 1-year train, 3-month val, 3-month test windows
    cfg = WalkForwardConfig(train_bars=252, val_bars=63, test_bars=63)
    wfv = WalkForwardValidator(cfg)
    folds = wfv.split(n_periods=len(X))

    for fold, data in wfv.iter_splits(X, y, folds):
        X_train, y_train = data["train"]
        X_val,   y_val   = data["val"]
        X_test,  y_test  = data["test"]
        # ... train model, evaluate, etc.
"""

from .walk_forward import (
    WalkForwardFold,
    WalkForwardConfig,
    WalkForwardValidator,
    walk_forward_splits,
    walk_forward_splits_on_dates,
    save_fold_manifest,
)

from .embargo import (
    EmbargoUnit,
    EmbargoConfig,
    EmbargoApplier,
    compute_embargo_times,
    purge_train_indices_by_t1,
)

# sklearn-dependent modules — imported lazily to allow tests that only
# need walk_forward / embargo to run without scikit-learn installed.

def __getattr__(name: str):
    _PURGED_KFOLD = {"PurgedKFold", "build_t1_series", "build_t1_series_from_events", "detect_label_overlap"}
    _CPCV = {"CPCVFold", "CPCVConfig", "CombinatorialPurgedCV", "cpcv_splits"}
    _METRICS = {
        "ClassificationMetrics", "TradingMetrics", "FoldResult", "StabilityAnalysis",
        "ValidationResult", "AcceptanceThresholds", "AcceptanceDecision",
        "FinancialMetricsEvaluator", "ModelAcceptanceGate",
        "compute_stability", "aggregate_fold_results",
        "save_validation_result", "load_validation_history",
    }

    if name in _PURGED_KFOLD:
        from .purged_kfold import (  # noqa: PLC0415
            PurgedKFold, build_t1_series, build_t1_series_from_events, detect_label_overlap
        )
        _MAP = {
            "PurgedKFold": PurgedKFold,
            "build_t1_series": build_t1_series,
            "build_t1_series_from_events": build_t1_series_from_events,
            "detect_label_overlap": detect_label_overlap,
        }
        return _MAP[name]

    if name in _CPCV:
        from .combinatorial_cv import (  # noqa: PLC0415
            CPCVFold, CPCVConfig, CombinatorialPurgedCV, cpcv_splits
        )
        _MAP = {
            "CPCVFold": CPCVFold, "CPCVConfig": CPCVConfig,
            "CombinatorialPurgedCV": CombinatorialPurgedCV, "cpcv_splits": cpcv_splits,
        }
        return _MAP[name]

    if name in _METRICS:
        from .metrics import (  # noqa: PLC0415
            ClassificationMetrics, TradingMetrics, FoldResult, StabilityAnalysis,
            ValidationResult, AcceptanceThresholds, AcceptanceDecision,
            FinancialMetricsEvaluator, ModelAcceptanceGate,
            compute_stability, aggregate_fold_results,
            save_validation_result, load_validation_history,
        )
        import importlib
        m = importlib.import_module(".metrics", package=__name__)
        return getattr(m, name)

    raise AttributeError(f"module 'src.validation' has no attribute '{name}'")

__all__ = [
    # walk_forward
    "WalkForwardFold",
    "WalkForwardConfig",
    "WalkForwardValidator",
    "walk_forward_splits",
    "walk_forward_splits_on_dates",
    "save_fold_manifest",
    # embargo
    "EmbargoUnit",
    "EmbargoConfig",
    "EmbargoApplier",
    "compute_embargo_times",
    "purge_train_indices_by_t1",
    # purged_kfold
    "PurgedKFold",
    "build_t1_series",
    "build_t1_series_from_events",
    "detect_label_overlap",
    # combinatorial_cv
    "CPCVFold",
    "CPCVConfig",
    "CombinatorialPurgedCV",
    "cpcv_splits",
    # metrics
    "ClassificationMetrics",
    "TradingMetrics",
    "FoldResult",
    "StabilityAnalysis",
    "ValidationResult",
    "AcceptanceThresholds",
    "AcceptanceDecision",
    "FinancialMetricsEvaluator",
    "ModelAcceptanceGate",
    "compute_stability",
    "aggregate_fold_results",
    "save_validation_result",
    "load_validation_history",
]

__version__ = "1.0.0"
