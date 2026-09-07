"""
Phase 3K — Classical baselines for fair deep-vs-classical comparison (spec §19).

Every deep-learning experiment must be compared against equivalent classical
baselines on the SAME dataset / period / features / labels / universe /
execution / cost model / portfolio constraints (spec §19, §74).

This module provides pure-NumPy classical rankers that implement the same
BaseRanker interface as the neural models, so they slot into the identical
comparison harness. They are pure NumPy (closed-form / coordinate descent) so
they do NOT depend on scikit-learn (broken in this environment) and remain
deterministic.

  - LinearRanker      — OLS (ridge with alpha=0)
  - RidgeRanker       — L2-regularized linear (closed form)
  - ElasticNetRanker  — L1+L2 via deterministic coordinate descent

The repository also ships LightGBM/XGBoost rankers in src.ranking.ranker; those
require the (currently broken) sklearn/lightgbm stack. The comparison harness
accepts ANY object implementing the BaseRanker interface, so those can be added
in an environment where they import cleanly — documented as a limitation.

Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .models import RankerInterfaceMixin


@dataclass
class LinearConfig:
    l2: float = 1.0            # ridge strength
    l1: float = 0.0            # lasso strength (elastic net)
    fit_intercept: bool = True
    max_iter: int = 200        # coordinate descent iterations (elastic net)
    tol: float = 1e-6
    model_version: str = "v1"


class _LinearBase(RankerInterfaceMixin):
    family = "LINEAR"

    def __init__(self, config: Optional[LinearConfig] = None):
        self.config = config or LinearConfig()
        self.coef_: Optional[np.ndarray] = None
        self.intercept_: float = 0.0
        self._fitted = False

    @property
    def model_id(self) -> str:
        return self.family.lower() + "-ranker"

    @property
    def model_version(self) -> str:
        return f"{self.model_id}-{self.config.model_version}"

    @property
    def score_semantics(self) -> str:
        return f"ALPHA_SCORE: {self.family} linear predictor, higher=more attractive"

    @property
    def parameter_count(self) -> int:
        return (self.coef_.size if self.coef_ is not None else 0) + 1

    @property
    def trainable_parameter_count(self) -> int:
        return self.parameter_count

    def predict(self, X: np.ndarray) -> np.ndarray:
        X = np.asarray(X, dtype=float)
        if self.coef_ is None:
            return np.zeros(X.shape[0])
        return X @ self.coef_ + self.intercept_

    def _center(self, X, y):
        if self.config.fit_intercept:
            xm = X.mean(axis=0)
            ym = float(y.mean())
            return X - xm, y - ym, xm, ym
        return X, y, np.zeros(X.shape[1]), 0.0

    def _set_intercept(self, xm, ym):
        if self.config.fit_intercept and self.coef_ is not None:
            self.intercept_ = ym - float(xm @ self.coef_)
        else:
            self.intercept_ = 0.0


class RidgeRanker(_LinearBase):
    """Closed-form ridge: coef = (XᵀX + l2·I)⁻¹ Xᵀy."""
    family = "RIDGE"

    def fit(self, X_train, y_train, groups=None, sample_weight=None, X_val=None, y_val=None) -> dict:
        X = np.asarray(X_train, dtype=float)
        y = np.asarray(y_train, dtype=float).reshape(-1)
        Xc, yc, xm, ym = self._center(X, y)
        n_feat = Xc.shape[1]
        A = Xc.T @ Xc + self.config.l2 * np.eye(n_feat)
        b = Xc.T @ yc
        self.coef_ = np.linalg.solve(A, b)
        self._set_intercept(xm, ym)
        self._fitted = True
        return {"model": self.model_id, "l2": self.config.l2, "n_features": n_feat}


class LinearRanker(RidgeRanker):
    """OLS = ridge with tiny l2 for numerical stability."""
    family = "LINEAR"

    def __init__(self, config: Optional[LinearConfig] = None):
        cfg = config or LinearConfig(l2=1e-8)
        cfg.l2 = max(cfg.l2, 1e-8)
        super().__init__(cfg)


class ElasticNetRanker(_LinearBase):
    """Elastic net via deterministic cyclic coordinate descent."""
    family = "ELASTIC_NET"

    def fit(self, X_train, y_train, groups=None, sample_weight=None, X_val=None, y_val=None) -> dict:
        X = np.asarray(X_train, dtype=float)
        y = np.asarray(y_train, dtype=float).reshape(-1)
        Xc, yc, xm, ym = self._center(X, y)
        n, p = Xc.shape
        beta = np.zeros(p)
        l1, l2 = self.config.l1, self.config.l2
        col_norm = (Xc ** 2).sum(axis=0) + l2
        col_norm[col_norm == 0] = 1.0

        def soft(z, g):
            return np.sign(z) * max(abs(z) - g, 0.0)

        for _ in range(self.config.max_iter):
            beta_old = beta.copy()
            r = yc - Xc @ beta
            for j in range(p):
                r = r + Xc[:, j] * beta[j]
                rho = Xc[:, j] @ r
                beta[j] = soft(rho, l1 * n) / col_norm[j]
                r = r - Xc[:, j] * beta[j]
            if np.max(np.abs(beta - beta_old)) < self.config.tol:
                break
        self.coef_ = beta
        self._set_intercept(xm, ym)
        self._fitted = True
        n_nonzero = int(np.sum(np.abs(beta) > 1e-10))
        return {"model": self.model_id, "l1": l1, "l2": l2, "n_nonzero": n_nonzero}
