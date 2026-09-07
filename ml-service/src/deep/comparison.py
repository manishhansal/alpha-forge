"""
Phase 3K — Fair walk-forward comparison harness (spec §19, §20, §74).

Runs any set of rankers (classical or deep, all implementing the BaseRanker
interface) on the SAME walk-forward folds, SAME features, SAME labels, SAME
universe. This is the apparatus that guarantees apples-to-apples comparison so
"deep beat classical" claims are fair (spec §74).

Guarantees:
  - Uses the existing Phase 3A WalkForwardValidator (no random splits, spec §20).
  - Scaler is fit on the TRAIN window of each fold ONLY, then applied to
    val/OOS (PIT-safe, spec §13) — via src.deep.normalization.
  - OOS predictions are collected per fold; IC computed via the existing
    Phase 3E compute_rank_ic / compute_ic (no duplication, spec §19, §30).
  - The final OOS block is NEVER used to choose hyperparameters / seed /
    checkpoint / architecture (that discipline lives in training.py; this
    harness only *evaluates* on OOS after everything is fixed).

Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from src.validation.walk_forward import WalkForwardValidator, WalkForwardConfig
from src.ranking.evaluation import compute_rank_ic, compute_ic
from .normalization import fit_scaler, ScalerMethod


@dataclass
class FoldEvaluation:
    """Per-fold OOS evaluation for one model."""
    fold_index:   int
    rank_ic:      Optional[float]
    ic:           Optional[float]
    n_test:       int
    train_metrics: dict = field(default_factory=dict)


@dataclass
class ModelEvaluation:
    """Aggregated walk-forward OOS evaluation for one model."""
    model_id:      str
    model_version: str
    score_semantics: str
    folds:         list[FoldEvaluation]
    oos_predictions: np.ndarray            # concatenated OOS predictions
    oos_realized:    np.ndarray            # aligned realized targets
    oos_fold_id:     np.ndarray            # fold index per OOS row

    def rank_ic_values(self) -> list[float]:
        return [f.rank_ic for f in self.folds if f.rank_ic is not None]

    def mean_rank_ic(self) -> Optional[float]:
        vals = self.rank_ic_values()
        return float(np.mean(vals)) if vals else None

    def icir(self) -> Optional[float]:
        vals = self.rank_ic_values()
        if len(vals) < 2:
            return None
        sd = float(np.std(vals, ddof=1))
        return float(np.mean(vals) / sd) if sd > 0 else None

    def pooled_rank_ic(self) -> Optional[float]:
        return compute_rank_ic(self.oos_predictions, self.oos_realized)

    def to_dict(self) -> dict:
        return {
            "model_id": self.model_id,
            "model_version": self.model_version,
            "score_semantics": self.score_semantics,
            "n_folds": len(self.folds),
            "mean_rank_ic": self.mean_rank_ic(),
            "icir": self.icir(),
            "pooled_rank_ic": self.pooled_rank_ic(),
            "per_fold_rank_ic": [f.rank_ic for f in self.folds],
            "n_oos": int(self.oos_predictions.size),
        }


class WalkForwardComparator:
    """
    Fair walk-forward comparison for classical + deep rankers.

    model_factories: mapping name -> callable(input_dim) -> ranker. A factory so
    each fold gets a FRESH model (no state leakage across folds).
    """

    def __init__(
        self,
        wf_config: WalkForwardConfig,
        scaler_method: ScalerMethod = ScalerMethod.STANDARD,
        embargo_bars: int = 0,
    ) -> None:
        self.wf_config = wf_config
        self.scaler_method = scaler_method
        self.embargo_bars = embargo_bars

    def compare(
        self,
        X: np.ndarray,               # (n, n_features) time-ordered
        y: np.ndarray,               # (n,)
        feature_names: list[str],
        model_factories: dict[str, Callable[[int], object]],
    ) -> dict[str, ModelEvaluation]:
        X = np.asarray(X, dtype=float)
        y = np.asarray(y, dtype=float).reshape(-1)
        n, n_feat = X.shape
        validator = WalkForwardValidator(self.wf_config)
        folds = validator.split(n)

        results: dict[str, ModelEvaluation] = {}
        for name, factory in model_factories.items():
            fold_evals: list[FoldEvaluation] = []
            oos_pred_parts: list[np.ndarray] = []
            oos_real_parts: list[np.ndarray] = []
            oos_fold_parts: list[np.ndarray] = []

            for fold in folds:
                # embargo: shrink the train window tail to gap train->val (spec §20)
                tr_end = max(fold.train_start + 1, fold.train_end - self.embargo_bars)
                Xtr, ytr = X[fold.train_start:tr_end], y[fold.train_start:tr_end]
                Xval, yval = X[fold.val_slice], y[fold.val_slice]
                Xte, yte = X[fold.test_slice], y[fold.test_slice]

                # PIT-safe scaler: fit on TRAIN only, apply to val/OOS (spec §13)
                scaler = fit_scaler(Xtr, feature_names, self.scaler_method)
                Xtr_s = scaler.transform(Xtr)
                Xval_s = scaler.transform(Xval)
                Xte_s = scaler.transform(Xte)

                model = factory(n_feat)
                train_metrics = model.fit(Xtr_s, ytr, X_val=Xval_s, y_val=yval)  # type: ignore[attr-defined]
                preds = np.asarray(model.predict(Xte_s), dtype=float)            # type: ignore[attr-defined]

                fold_evals.append(FoldEvaluation(
                    fold_index=fold.fold_index,
                    rank_ic=compute_rank_ic(preds, yte),
                    ic=compute_ic(preds, yte),
                    n_test=len(yte),
                    train_metrics=train_metrics if isinstance(train_metrics, dict) else {},
                ))
                oos_pred_parts.append(preds)
                oos_real_parts.append(yte)
                oos_fold_parts.append(np.full(len(yte), fold.fold_index, dtype=int))

            probe = factory(n_feat)
            results[name] = ModelEvaluation(
                model_id=getattr(probe, "model_id", name),
                model_version=getattr(probe, "model_version", "v1"),
                score_semantics=getattr(probe, "score_semantics", "ALPHA_SCORE"),
                folds=fold_evals,
                oos_predictions=np.concatenate(oos_pred_parts) if oos_pred_parts else np.array([]),
                oos_realized=np.concatenate(oos_real_parts) if oos_real_parts else np.array([]),
                oos_fold_id=np.concatenate(oos_fold_parts) if oos_fold_parts else np.array([]),
            )
        return results
