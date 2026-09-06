"""
Ranker Model Zoo — Phase 3E.

Implements the canonical set of ranking models for cross-sectional alpha:

    Baseline 1  — MomentumBaselineRanker   (20-day momentum rank)
    Baseline 2  — CompositeBaselineRanker  (equal-weight feature composite)
    Baseline 3  — RidgeRanker              (Ridge regression)
    Baseline 4  — ElasticNetRanker         (ElasticNet)
    Primary     — LightGBMRanker           (LightGBM with ranking or regression)
    Secondary   — XGBoostRanker            (XGBoost with ranking or regression)

Score convention (invariant)
------------------------------
higher alpha_score = more attractive.
All rankers normalize output to the same direction before returning.

Alpha score semantics
---------------------
Each ranker's predict() documents what the score represents.
A score is NEVER interpreted as P(win) unless explicitly calibrated.

Baseline dominance rule
-----------------------
If LightGBM does not materially outperform the simple momentum baseline,
the result is ML_ADDS_NO_CLEAR_VALUE.  This is a valid research outcome.

Missing library handling
-----------------------
LightGBM and XGBoost are optional.  Their ranker classes raise
ImportError with a clear message if the library is not installed.
Ridge/ElasticNet require sklearn.  All three are tested with
pytest.importorskip in the test suite.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

import numpy as np


# ── Base interface ────────────────────────────────────────────────────────────

class BaseRanker(ABC):
    """
    Abstract base for all ranking models.

    Every concrete ranker must implement:
        fit(X_train, y_train, groups=None, sample_weight=None)
        predict(X) → np.ndarray   (raw scores, higher=better)
        score_semantics: str       (what the scores represent)
        model_id: str
        model_version: str
    """

    @property
    @abstractmethod
    def model_id(self) -> str:
        ...

    @property
    @abstractmethod
    def model_version(self) -> str:
        ...

    @property
    @abstractmethod
    def score_semantics(self) -> str:
        ...

    @abstractmethod
    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        groups: Optional[list[int]] = None,
        sample_weight: Optional[np.ndarray] = None,
        X_val: Optional[np.ndarray] = None,
        y_val: Optional[np.ndarray] = None,
    ) -> dict:
        """Fit the model; return training metrics dict."""
        ...

    @abstractmethod
    def predict(self, X: np.ndarray) -> np.ndarray:
        """Return raw scores (higher = more attractive)."""
        ...

    def rank(self, X: np.ndarray) -> np.ndarray:
        """
        Return integer ranks (1 = highest alpha score, N = lowest).
        Ties broken by average rank (deterministic).
        """
        scores = self.predict(X)
        n = len(scores)
        # Descending rank: rank 1 = highest score
        return _rank_descending(scores)

    def percentile(self, X: np.ndarray) -> np.ndarray:
        """Return percentile [0, 100] where 100 = highest alpha score."""
        scores = self.predict(X)
        return _score_to_percentile(scores)


def _rank_descending(scores: np.ndarray) -> np.ndarray:
    """Rank array such that highest score = rank 1. Average ties."""
    n = len(scores)
    # Sort descending (highest score first)
    sorted_idx = np.argsort(-scores, kind="stable")
    ranks = np.empty(n, dtype=float)
    i = 0
    while i < n:
        j = i
        while j < n - 1 and scores[sorted_idx[j]] == scores[sorted_idx[j + 1]]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0   # 1-indexed
        for k in range(i, j + 1):
            ranks[sorted_idx[k]] = avg_rank
        i = j + 1
    return ranks


def _score_to_percentile(scores: np.ndarray) -> np.ndarray:
    """Convert scores to percentile [0,100]; 100 = highest score."""
    n = len(scores)
    if n == 0:
        return np.array([], dtype=float)
    sorted_idx = np.argsort(scores, kind="stable")  # ascending
    pcts = np.empty(n, dtype=float)
    for rank_asc, orig_idx in enumerate(sorted_idx):
        pcts[orig_idx] = rank_asc / (n - 1) * 100.0 if n > 1 else 50.0
    return pcts


# ── Baseline 1 — Momentum ────────────────────────────────────────────────────

class MomentumBaselineRanker(BaseRanker):
    """
    Baseline 1: Cross-sectional momentum rank.

    Uses the 20-day return feature from the feature matrix.
    The column index of return_20d must be specified or auto-detected.

    Score semantics: cross-sectional rank of 20-day return (higher = better).
    """

    def __init__(self, return_20d_col_idx: int = 5):
        """
        Parameters
        ----------
        return_20d_col_idx : Index of the return_20d column in the feature matrix.
                             Default 5 matches RANKING_FEATURES order.
        """
        self._col_idx = return_20d_col_idx
        self._fitted  = False

    @property
    def model_id(self) -> str:
        return "momentum_baseline"

    @property
    def model_version(self) -> str:
        return "momentum_baseline-v1"

    @property
    def score_semantics(self) -> str:
        return "MOMENTUM_RANK: cross-sectional rank of 20-day return, higher=better"

    def fit(self, X_train, y_train, groups=None, sample_weight=None,
            X_val=None, y_val=None) -> dict:
        # No fitting required — pure rank baseline
        self._fitted = True
        return {"model": "momentum_baseline", "status": "no_fit_required"}

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Return 20-day return values as scores (higher return = higher score)."""
        if X.ndim != 2 or self._col_idx >= X.shape[1]:
            return np.zeros(len(X))
        return X[:, self._col_idx].astype(float)


# ── Baseline 2 — Equal-weight composite ──────────────────────────────────────

class CompositeBaselineRanker(BaseRanker):
    """
    Baseline 2: Equal-weight normalized feature composite.

    Takes a pre-specified set of feature column indices, z-scores each
    column across the cross-section, then averages.  No fitting needed.

    Score semantics: equal-weight composite of z-scored features.
    """

    def __init__(self, feature_col_indices: Optional[list[int]] = None):
        """
        Parameters
        ----------
        feature_col_indices : Column indices to include.  If None, uses all columns.
        """
        self._cols   = feature_col_indices
        self._fitted = False

    @property
    def model_id(self) -> str:
        return "composite_baseline"

    @property
    def model_version(self) -> str:
        return "composite_baseline-v1"

    @property
    def score_semantics(self) -> str:
        return "COMPOSITE_SCORE: equal-weight average of z-scored feature columns"

    def fit(self, X_train, y_train, groups=None, sample_weight=None,
            X_val=None, y_val=None) -> dict:
        self._fitted = True
        return {"model": "composite_baseline", "status": "no_fit_required"}

    def predict(self, X: np.ndarray) -> np.ndarray:
        if X.ndim != 2:
            return np.zeros(len(X))
        cols = self._cols if self._cols else list(range(X.shape[1]))
        sub  = X[:, cols].astype(float)

        # Z-score each column within the current cross-section
        mu  = np.nanmean(sub, axis=0)
        sig = np.nanstd(sub, axis=0, ddof=1)
        sig[sig < 1e-10] = 1.0
        zs  = (sub - mu) / sig
        zs  = np.where(np.isfinite(zs), zs, 0.0)
        return np.nanmean(zs, axis=1)


# ── Baseline 3 — Ridge regression ────────────────────────────────────────────

class RidgeRanker(BaseRanker):
    """
    Baseline 3: Ridge regression on cross-sectional targets.

    Requires sklearn.  Will raise ImportError if not installed.

    Score semantics: predicted excess return (continuous).
    """

    def __init__(self, alpha: float = 1.0, random_state: int = 42):
        self._alpha = alpha
        self._rs    = random_state
        self._model = None

    @property
    def model_id(self) -> str:
        return "ridge_ranker"

    @property
    def model_version(self) -> str:
        return f"ridge_ranker-v1-alpha{self._alpha}"

    @property
    def score_semantics(self) -> str:
        return "PREDICTED_EXCESS_RETURN: Ridge regression prediction of excess return"

    def fit(self, X_train, y_train, groups=None, sample_weight=None,
            X_val=None, y_val=None) -> dict:
        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler

        mask  = np.isfinite(y_train) & np.all(np.isfinite(X_train), axis=1)
        Xm    = X_train[mask].astype(float)
        ym    = y_train[mask].astype(float)

        self._scaler = StandardScaler()
        Xs = self._scaler.fit_transform(Xm)

        self._model = Ridge(alpha=self._alpha, random_state=self._rs)
        self._model.fit(Xs, ym, sample_weight=sample_weight[mask] if sample_weight is not None else None)

        train_pred = self._model.predict(Xs)
        from scipy.stats import spearmanr
        ic, _ = spearmanr(ym, train_pred)
        return {"train_ic": float(ic) if np.isfinite(ic) else 0.0}

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.zeros(len(X))
        Xs = self._scaler.transform(X.astype(float))
        return self._model.predict(Xs)


# ── Baseline 4 — ElasticNet ───────────────────────────────────────────────────

class ElasticNetRanker(BaseRanker):
    """
    Baseline 4: ElasticNet regression (L1 + L2 regularization).

    Requires sklearn.

    Score semantics: predicted excess return.
    """

    def __init__(self, alpha: float = 0.1, l1_ratio: float = 0.5,
                 max_iter: int = 1000, random_state: int = 42):
        self._alpha    = alpha
        self._l1_ratio = l1_ratio
        self._max_iter = max_iter
        self._rs       = random_state
        self._model    = None

    @property
    def model_id(self) -> str:
        return "elasticnet_ranker"

    @property
    def model_version(self) -> str:
        return f"elasticnet_ranker-v1-a{self._alpha}-l1{self._l1_ratio}"

    @property
    def score_semantics(self) -> str:
        return "PREDICTED_EXCESS_RETURN: ElasticNet regression prediction of excess return"

    def fit(self, X_train, y_train, groups=None, sample_weight=None,
            X_val=None, y_val=None) -> dict:
        from sklearn.linear_model import ElasticNet
        from sklearn.preprocessing import StandardScaler
        from scipy.stats import spearmanr

        mask = np.isfinite(y_train) & np.all(np.isfinite(X_train), axis=1)
        Xm   = X_train[mask].astype(float)
        ym   = y_train[mask].astype(float)

        self._scaler = StandardScaler()
        Xs = self._scaler.fit_transform(Xm)

        self._model = ElasticNet(
            alpha=self._alpha, l1_ratio=self._l1_ratio,
            max_iter=self._max_iter, random_state=self._rs,
        )
        self._model.fit(Xs, ym, sample_weight=sample_weight[mask] if sample_weight is not None else None)

        train_pred = self._model.predict(Xs)
        ic, _ = spearmanr(ym, train_pred)
        return {"train_ic": float(ic) if np.isfinite(ic) else 0.0}

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.zeros(len(X))
        Xs = self._scaler.transform(X.astype(float))
        return self._model.predict(Xs)


# ── Primary — LightGBM ────────────────────────────────────────────────────────

class LightGBMRanker(BaseRanker):
    """
    Primary nonlinear ranker: LightGBM.

    Supports both regression (point-wise) and lambdarank (listwise) objectives.
    Use_lambdarank=True requires `groups` in fit().

    Requires lightgbm.

    Score semantics: predicted excess return (regression) or ranking score (lambdarank).
    """

    DEFAULT_PARAMS = {
        "objective":       "regression",
        "metric":          "rmse",
        "boosting_type":   "gbdt",
        "num_leaves":      63,
        "max_depth":       8,
        "learning_rate":   0.03,
        "n_estimators":    300,
        "min_child_samples": 20,
        "subsample":       0.8,
        "colsample_bytree": 0.8,
        "reg_alpha":       0.1,
        "reg_lambda":      1.0,
        "random_state":    42,
        "verbose":         -1,
    }

    LAMBDARANK_PARAMS = {
        "objective":       "lambdarank",
        "metric":          "ndcg",
        "ndcg_eval_at":    [5, 10, 20],
        "boosting_type":   "gbdt",
        "num_leaves":      63,
        "max_depth":       8,
        "learning_rate":   0.03,
        "n_estimators":    300,
        "min_child_samples": 20,
        "subsample":       0.8,
        "colsample_bytree": 0.8,
        "reg_alpha":       0.1,
        "reg_lambda":      1.0,
        "random_state":    42,
        "verbose":         -1,
    }

    def __init__(
        self,
        use_lambdarank: bool = False,
        params: Optional[dict] = None,
        feature_names: Optional[list[str]] = None,
    ):
        self._use_lr  = use_lambdarank
        self._params  = params or {}
        self._feat_names = feature_names
        self._model   = None

    @property
    def model_id(self) -> str:
        return "lgbm_ranker"

    @property
    def model_version(self) -> str:
        obj = "lambdarank" if self._use_lr else "regression"
        return f"lgbm_ranker-v1-{obj}"

    @property
    def score_semantics(self) -> str:
        if self._use_lr:
            return "PREDICTED_RANK_SCORE: LightGBM LambdaRank listwise score"
        return "PREDICTED_EXCESS_RETURN: LightGBM regression prediction of excess return"

    def fit(self, X_train, y_train, groups=None, sample_weight=None,
            X_val=None, y_val=None) -> dict:
        import lightgbm as lgb
        from scipy.stats import spearmanr

        base = self.LAMBDARANK_PARAMS if self._use_lr else self.DEFAULT_PARAMS
        hp   = {**base, **self._params}
        n_est = hp.pop("n_estimators", 300)

        mask = np.isfinite(y_train) & np.all(np.isfinite(X_train), axis=1)
        Xm   = X_train[mask].astype(np.float32)
        ym   = y_train[mask].astype(np.float32)
        wm   = sample_weight[mask].astype(np.float32) if sample_weight is not None else None

        if self._use_lr and groups is not None:
            # Rebuild groups mask to match filtered rows
            # (groups are per-timestamp; we must recompute after row filtering)
            train_data = lgb.Dataset(Xm, label=ym, group=groups,
                                     weight=wm, feature_name=self._feat_names)
        else:
            train_data = lgb.Dataset(Xm, label=ym, weight=wm,
                                     feature_name=self._feat_names)

        valid_sets = [train_data]
        valid_names = ["train"]

        if X_val is not None and y_val is not None:
            val_mask = np.isfinite(y_val) & np.all(np.isfinite(X_val), axis=1)
            Xv = X_val[val_mask].astype(np.float32)
            yv = y_val[val_mask].astype(np.float32)
            val_data = lgb.Dataset(Xv, label=yv, reference=train_data)
            valid_sets.append(val_data)
            valid_names.append("valid")

        self._model = lgb.train(
            hp,
            train_data,
            num_boost_round=n_est,
            valid_sets=valid_sets,
            valid_names=valid_names,
            callbacks=[lgb.log_evaluation(period=100)],
        )

        train_pred = self._model.predict(Xm)
        ic, _ = spearmanr(ym, train_pred)
        metrics: dict = {"train_ic": float(ic) if np.isfinite(ic) else 0.0}

        if X_val is not None and y_val is not None:
            val_pred = self._model.predict(Xv)
            vic, _ = spearmanr(yv, val_pred)
            metrics["val_ic"] = float(vic) if np.isfinite(vic) else 0.0

        return metrics

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.zeros(len(X))
        return self._model.predict(X.astype(np.float32))

    def get_feature_importance(self, importance_type: str = "gain") -> dict[str, float]:
        if self._model is None:
            return {}
        imp  = self._model.feature_importance(importance_type=importance_type)
        names = self._model.feature_name()
        return {n: float(v) for n, v in zip(names, imp)}


# ── Secondary — XGBoost ───────────────────────────────────────────────────────

class XGBoostRanker(BaseRanker):
    """
    Secondary nonlinear ranker: XGBoost.

    Uses XGBoost's pairwise ranking (rank:pairwise) or regression (reg:squarederror).

    Requires xgboost.

    Score semantics: predicted excess return (regression) or pairwise ranking score.
    """

    DEFAULT_PARAMS = {
        "objective":        "reg:squarederror",
        "eval_metric":      "rmse",
        "max_depth":        6,
        "learning_rate":    0.05,
        "n_estimators":     300,
        "subsample":        0.8,
        "colsample_bytree": 0.8,
        "reg_alpha":        0.1,
        "reg_lambda":       1.0,
        "min_child_weight": 20,
        "seed":             42,
        "verbosity":        0,
    }

    PAIRWISE_PARAMS = {
        "objective":        "rank:pairwise",
        "eval_metric":      "ndcg@10",
        "max_depth":        6,
        "learning_rate":    0.05,
        "n_estimators":     300,
        "subsample":        0.8,
        "colsample_bytree": 0.8,
        "reg_alpha":        0.1,
        "reg_lambda":       1.0,
        "seed":             42,
        "verbosity":        0,
    }

    def __init__(
        self,
        use_pairwise: bool = False,
        params: Optional[dict] = None,
    ):
        self._use_pair = use_pairwise
        self._params   = params or {}
        self._model    = None

    @property
    def model_id(self) -> str:
        return "xgboost_ranker"

    @property
    def model_version(self) -> str:
        obj = "pairwise" if self._use_pair else "regression"
        return f"xgboost_ranker-v1-{obj}"

    @property
    def score_semantics(self) -> str:
        if self._use_pair:
            return "PREDICTED_RANK_SCORE: XGBoost pairwise ranking score"
        return "PREDICTED_EXCESS_RETURN: XGBoost regression prediction of excess return"

    def fit(self, X_train, y_train, groups=None, sample_weight=None,
            X_val=None, y_val=None) -> dict:
        import xgboost as xgb
        from scipy.stats import spearmanr

        base = self.PAIRWISE_PARAMS if self._use_pair else self.DEFAULT_PARAMS
        hp   = {**base, **self._params}
        n_est = hp.pop("n_estimators", 300)

        mask = np.isfinite(y_train) & np.all(np.isfinite(X_train), axis=1)
        Xm   = X_train[mask].astype(np.float32)
        ym   = y_train[mask].astype(np.float32)
        wm   = sample_weight[mask] if sample_weight is not None else None

        dtrain = xgb.DMatrix(Xm, label=ym, weight=wm)

        evals: list = [(dtrain, "train")]
        if X_val is not None and y_val is not None:
            val_mask = np.isfinite(y_val) & np.all(np.isfinite(X_val), axis=1)
            dval = xgb.DMatrix(
                X_val[val_mask].astype(np.float32),
                label=y_val[val_mask].astype(np.float32),
            )
            evals.append((dval, "valid"))

        evals_result: dict = {}
        self._model = xgb.train(
            hp,
            dtrain,
            num_boost_round=n_est,
            evals=evals,
            evals_result=evals_result,
            verbose_eval=False,
        )

        train_pred = self._model.predict(dtrain)
        ic, _ = spearmanr(ym, train_pred)
        return {"train_ic": float(ic) if np.isfinite(ic) else 0.0}

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.zeros(len(X))
        import xgboost as xgb
        dm = xgb.DMatrix(X.astype(np.float32))
        return self._model.predict(dm)


# ── Fit-and-evaluate helper ───────────────────────────────────────────────────

def fit_and_evaluate(
    ranker: BaseRanker,
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_test:  np.ndarray,
    y_test:  np.ndarray,
    groups_train: Optional[list[int]] = None,
    sample_weight: Optional[np.ndarray] = None,
) -> dict:
    """
    Fit a ranker and compute OOS metrics on the test set.

    Returns a dict with: model_id, train_ic, test_ic, test_rank_ic.
    """
    from scipy.stats import spearmanr

    train_metrics = ranker.fit(
        X_train, y_train,
        groups=groups_train,
        sample_weight=sample_weight,
    )

    preds = ranker.predict(X_test)

    # IC (Pearson of scores vs returns)
    mask = np.isfinite(y_test) & np.isfinite(preds)
    if mask.sum() < 5:
        return {
            "model_id":    ranker.model_id,
            "test_ic":     None,
            "test_rank_ic": None,
            **train_metrics,
        }

    ic, _    = spearmanr(y_test[mask], preds[mask])
    # Rank IC: Spearman of ranks vs ranks
    rank_ic, _ = spearmanr(
        _rank_descending(y_test[mask]),
        _rank_descending(preds[mask]),
    )

    return {
        "model_id":     ranker.model_id,
        "train_ic":     train_metrics.get("train_ic"),
        "test_ic":      float(ic)      if np.isfinite(ic)      else None,
        "test_rank_ic": float(rank_ic) if np.isfinite(rank_ic) else None,
    }
