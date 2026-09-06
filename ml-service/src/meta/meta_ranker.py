"""
Meta-Ranker Models — Phase 3F.

Second-level classifiers that predict P(primary signal succeeds)
conditional on the existence of a primary alpha candidate.

Architecture
------------
Input:  meta-features (primary signal context + stock/market context)
        Primary predictions MUST be OOS (is_oos_primary_prediction=True)
Output: RawProbabilityScore — un-calibrated probability estimate

The RawProbabilityScore must then pass through a CalibratorArtifact
before being used as a CalibratedProbability for decision-making.

Baseline-first requirement
--------------------------
AlphaThresholdBaseline and LinearMetaRanker must be evaluated before
any tree-based model is promoted.  If LightGBM does not improve over
the simple alpha-threshold baseline, the verdict is ML_ADDS_NO_CLEAR_VALUE.

Score semantics
---------------
higher raw_score = higher P(success)
After calibration this becomes P(trade succeeds) ∈ [0,1].

Missing library handling
------------------------
LightGBM and XGBoost are optional.  Their classes raise ImportError with
a clear message if not installed.  Tests use pytest.importorskip.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from .schemas import (
    PredictionProvenance,
    RawProbabilityScore,
    ScoreType,
)

UTC = timezone.utc


# ── Base interface ────────────────────────────────────────────────────────────

class BaseMetaRanker(ABC):
    """
    Abstract base for all meta-ranker models.

    Every model outputs a RawProbabilityScore — explicitly NOT calibrated.
    The caller passes this through a CalibratorArtifact before using it
    for decisions.
    """

    @property
    @abstractmethod
    def model_id(self) -> str: ...

    @property
    @abstractmethod
    def model_version(self) -> str: ...

    @property
    @abstractmethod
    def provenance(self) -> PredictionProvenance: ...

    @abstractmethod
    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        sample_weight: Optional[np.ndarray] = None,
    ) -> dict:
        """Fit the model; return training metrics."""
        ...

    @abstractmethod
    def predict_raw(self, X: np.ndarray) -> np.ndarray:
        """Return raw probability scores. NOT calibrated."""
        ...

    def predict_records(
        self,
        X: np.ndarray,
        prediction_time: datetime,
        model_id_override: Optional[str] = None,
    ) -> list[RawProbabilityScore]:
        """Wrap predict_raw output into RawProbabilityScore objects."""
        raw = self.predict_raw(X)
        mid = model_id_override or self.model_id
        return [
            RawProbabilityScore(
                value=float(v),
                model_id=mid,
                model_version=self.model_version,
                prediction_time=prediction_time,
                score_type=ScoreType.RAW_PROBABILITY,
                provenance=self.provenance,
                is_oos=True,  # caller must enforce OOS discipline
            )
            for v in raw
        ]


# ── Baseline 1: Alpha threshold ───────────────────────────────────────────────

class AlphaThresholdBaseline(BaseMetaRanker):
    """
    Baseline 1: raw_score = alpha_score / normalizer.

    The simplest meta-baseline: assume higher alpha score = higher P(success).
    Uses only the primary alpha_score column (index 0 by default).

    Score semantics: monotone transform of alpha_score, NOT calibrated.
    """

    def __init__(
        self,
        alpha_score_col_idx: int = 0,
        normalizer: float = 100.0,
    ):
        self._col = alpha_score_col_idx
        self._norm = normalizer
        self._fitted = False

    @property
    def model_id(self) -> str:
        return "alpha_threshold_baseline"

    @property
    def model_version(self) -> str:
        return "alpha_threshold_baseline-v1"

    @property
    def provenance(self) -> PredictionProvenance:
        return PredictionProvenance.BASELINE_THRESHOLD

    def fit(self, X_train, y_train, sample_weight=None) -> dict:
        self._fitted = True
        return {"model": "alpha_threshold_baseline", "status": "no_fit_required"}

    def predict_raw(self, X: np.ndarray) -> np.ndarray:
        if X.ndim != 2 or self._col >= X.shape[1]:
            return np.full(len(X), 0.5)
        scores = X[:, self._col].astype(float)
        # Clip to [0,1] as a SCORE range, not as a probability
        return np.clip(scores / self._norm, 0.0, 1.0)


# ── Baseline 2: Logistic regression ──────────────────────────────────────────

class LinearMetaRanker(BaseMetaRanker):
    """
    Baseline 2: logistic regression meta-ranker.
    Requires sklearn.
    """

    def __init__(self, C: float = 1.0, random_state: int = 42):
        self._C = C
        self._rs = random_state
        self._model = None
        self._scaler = None

    @property
    def model_id(self) -> str:
        return "linear_meta_ranker"

    @property
    def model_version(self) -> str:
        return f"linear_meta_ranker-v1-C{self._C}"

    @property
    def provenance(self) -> PredictionProvenance:
        return PredictionProvenance.BASELINE_LINEAR

    def fit(self, X_train, y_train, sample_weight=None) -> dict:
        from sklearn.linear_model import LogisticRegression
        from sklearn.preprocessing import StandardScaler

        mask = np.isfinite(y_train) & np.all(np.isfinite(X_train), axis=1)
        Xm, ym = X_train[mask].astype(float), y_train[mask].astype(float)

        self._scaler = StandardScaler()
        Xs = self._scaler.fit_transform(Xm)
        wm = sample_weight[mask] if sample_weight is not None else None

        self._model = LogisticRegression(C=self._C, solver="lbfgs",
                                         max_iter=1000, random_state=self._rs)
        self._model.fit(Xs, ym, sample_weight=wm)

        train_pred = self._model.predict_proba(Xs)[:, 1]
        from scipy.stats import spearmanr
        corr, _ = spearmanr(ym, train_pred)
        return {"train_spearman": float(corr) if math.isfinite(corr) else 0.0}

    def predict_raw(self, X: np.ndarray) -> np.ndarray:
        if self._model is None or self._scaler is None:
            return np.full(len(X), float("nan"))
        Xs = self._scaler.transform(X.astype(float))
        return self._model.predict_proba(Xs)[:, 1]


# ── Primary: LightGBM binary classifier ──────────────────────────────────────

class LightGBMMetaRanker(BaseMetaRanker):
    """
    Primary nonlinear meta-ranker: LightGBM binary classifier.
    Requires lightgbm.

    Output: raw P(meta_label=1) from LightGBM predict_proba — NOT calibrated.
    """

    DEFAULT_PARAMS = {
        "objective":        "binary",
        "metric":           "binary_logloss",
        "boosting_type":    "gbdt",
        "num_leaves":       31,
        "max_depth":        6,
        "learning_rate":    0.05,
        "n_estimators":     200,
        "min_child_samples": 10,
        "subsample":        0.8,
        "colsample_bytree": 0.8,
        "reg_alpha":        0.1,
        "reg_lambda":       1.0,
        "random_state":     42,
        "verbose":          -1,
        "is_unbalance":     True,   # handles class imbalance without SMOTE
    }

    def __init__(self, params: Optional[dict] = None, feature_names: Optional[list[str]] = None):
        self._params = params or {}
        self._feat_names = feature_names
        self._model = None

    @property
    def model_id(self) -> str:
        return "lgbm_meta_ranker"

    @property
    def model_version(self) -> str:
        return "lgbm_meta_ranker-v1"

    @property
    def provenance(self) -> PredictionProvenance:
        return PredictionProvenance.TRAINED_MODEL

    def fit(self, X_train, y_train, sample_weight=None) -> dict:
        import lightgbm as lgb

        hp = {**self.DEFAULT_PARAMS, **self._params}
        n_est = hp.pop("n_estimators", 200)

        mask = np.isfinite(y_train) & np.all(np.isfinite(X_train), axis=1)
        Xm = X_train[mask].astype(np.float32)
        ym = y_train[mask].astype(np.float32)
        wm = sample_weight[mask] if sample_weight is not None else None

        ds = lgb.Dataset(Xm, label=ym, weight=wm, feature_name=self._feat_names)
        self._model = lgb.train(
            hp, ds, num_boost_round=n_est,
            callbacks=[lgb.log_evaluation(period=50)],
        )
        train_pred = self._model.predict(Xm)
        from scipy.stats import spearmanr
        corr, _ = spearmanr(ym, train_pred)
        return {"train_spearman": float(corr) if math.isfinite(corr) else 0.0}

    def predict_raw(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.full(len(X), float("nan"))
        return self._model.predict(X.astype(np.float32))

    def get_feature_importance(self) -> dict[str, float]:
        if self._model is None:
            return {}
        imp = self._model.feature_importance(importance_type="gain")
        return {n: float(v) for n, v in zip(self._model.feature_name(), imp)}


# ── Secondary: XGBoost binary classifier ─────────────────────────────────────

class XGBoostMetaRanker(BaseMetaRanker):
    """
    Secondary nonlinear meta-ranker: XGBoost binary classifier.
    Requires xgboost.
    """

    DEFAULT_PARAMS = {
        "objective":        "binary:logistic",
        "eval_metric":      "logloss",
        "max_depth":        5,
        "learning_rate":    0.05,
        "n_estimators":     200,
        "subsample":        0.8,
        "colsample_bytree": 0.8,
        "reg_alpha":        0.1,
        "reg_lambda":       1.0,
        "scale_pos_weight": 1.0,   # adjust for class imbalance
        "seed":             42,
        "verbosity":        0,
    }

    def __init__(self, params: Optional[dict] = None):
        self._params = params or {}
        self._model = None

    @property
    def model_id(self) -> str:
        return "xgboost_meta_ranker"

    @property
    def model_version(self) -> str:
        return "xgboost_meta_ranker-v1"

    @property
    def provenance(self) -> PredictionProvenance:
        return PredictionProvenance.TRAINED_MODEL

    def fit(self, X_train, y_train, sample_weight=None) -> dict:
        import xgboost as xgb

        hp = {**self.DEFAULT_PARAMS, **self._params}
        n_est = hp.pop("n_estimators", 200)

        mask = np.isfinite(y_train) & np.all(np.isfinite(X_train), axis=1)
        Xm = X_train[mask].astype(np.float32)
        ym = y_train[mask].astype(np.float32)
        wm = sample_weight[mask] if sample_weight is not None else None

        dtrain = xgb.DMatrix(Xm, label=ym, weight=wm)
        self._model = xgb.train(hp, dtrain, num_boost_round=n_est, verbose_eval=False)

        preds = self._model.predict(dtrain)
        from scipy.stats import spearmanr
        corr, _ = spearmanr(ym, preds)
        return {"train_spearman": float(corr) if math.isfinite(corr) else 0.0}

    def predict_raw(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.full(len(X), float("nan"))
        import xgboost as xgb
        dm = xgb.DMatrix(X.astype(np.float32))
        return self._model.predict(dm)


# ── Meta model comparison ─────────────────────────────────────────────────────

def compare_meta_models(
    results: list[dict],
) -> list[dict]:
    """
    Compare meta models: apply ML_ADDS_NO_CLEAR_VALUE logic.

    If LightGBM/XGBoost do not improve over the alpha-threshold baseline
    by more than 0.01 AUC, mark them as ML_ADDS_NO_CLEAR_VALUE.

    Parameters
    ----------
    results : list of {model_id, roc_auc, pr_auc, brier, log_loss, verdict}

    Returns
    -------
    Same list with verdict updated.
    """
    baseline_ids = {"alpha_threshold_baseline", "linear_meta_ranker"}
    ml_ids       = {"lgbm_meta_ranker", "xgboost_meta_ranker"}

    base_aucs = [r.get("roc_auc") for r in results
                 if r.get("model_id") in baseline_ids and r.get("roc_auc") is not None]
    best_base = max(base_aucs) if base_aucs else None

    for r in results:
        auc = r.get("roc_auc")
        if r.get("model_id") in ml_ids:
            if auc is None:
                r["verdict"] = "INSUFFICIENT_EVIDENCE"
            elif best_base is not None and auc <= best_base + 0.01:
                r["verdict"] = "ML_ADDS_NO_CLEAR_VALUE"
            elif auc < 0.52:
                r["verdict"] = "NO_CLEAR_SIGNAL"
            else:
                r["verdict"] = "RESEARCH_SIGNAL_DETECTED"
        else:
            if auc is None:
                r.setdefault("verdict", "INSUFFICIENT_EVIDENCE")
            elif auc < 0.52:
                r.setdefault("verdict", "NO_CLEAR_SIGNAL")
            else:
                r.setdefault("verdict", "RESEARCH_SIGNAL_DETECTED")

    return results
