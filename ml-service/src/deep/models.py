"""
Phase 3K — Deep-learning models (pure NumPy, deterministic).

Implements the ranking interface (`predict` / `rank` / `percentile` /
`model_id` / `model_version` / `score_semantics`) so a neural model is a
drop-in for the Phase 3E `BaseRanker` — WITHOUT importing src.ranking.ranker at
module load (that module lazily pulls sklearn-adjacent code that is broken in
this environment). Structural compatibility is verified in tests.

Models in this module:
- MLPRanker            — compact feed-forward MLP baseline (spec §5)

Temporal models (causal CNN / LSTM / GRU / transformer-lite) live in
temporal_models.py.

Determinism: all randomness flows through a SeedBundle Generator (spec §24).
No np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .nn_backend import (
    Dense, Dropout, AdamOptimizer, SeedBundle, LOSS_FUNCS,
    count_trainable_params, sigmoid, FRAMEWORK, FRAMEWORK_VERSION,
)


def _rank_descending(scores: np.ndarray) -> np.ndarray:
    """Integer ranks, 1 = highest score. Average-rank ties. Deterministic."""
    s = np.asarray(scores, dtype=float)
    n = len(s)
    order = np.argsort(-s, kind="mergesort")
    ranks = np.empty(n, dtype=float)
    sorted_s = s[order]
    i = 0
    while i < n:
        j = i
        while j + 1 < n and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        avg = (i + j) / 2.0 + 1.0   # 1-based
        ranks[order[i:j + 1]] = avg
        i = j + 1
    return ranks


def _score_to_percentile(scores: np.ndarray) -> np.ndarray:
    s = np.asarray(scores, dtype=float)
    n = len(s)
    if n <= 1:
        return np.full(n, 50.0)
    order = np.argsort(s, kind="mergesort")
    pct = np.empty(n, dtype=float)
    pct[order] = np.linspace(0.0, 100.0, n)
    return pct


class RankerInterfaceMixin:
    """Provides rank()/percentile() on top of predict() — mirrors BaseRanker."""

    def predict(self, X: np.ndarray) -> np.ndarray:  # pragma: no cover - overridden
        raise NotImplementedError

    def rank(self, X: np.ndarray) -> np.ndarray:
        return _rank_descending(self.predict(X))

    def percentile(self, X: np.ndarray) -> np.ndarray:
        return _score_to_percentile(self.predict(X))


# ══════════════════════════════════════════════════════════════════════════════
# MLP config
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class MLPConfig:
    """
    Compact MLP configuration (spec §5). Small by default — avoid unnecessarily
    large networks.
    """
    hidden_sizes:     tuple[int, ...] = (16, 8)
    activation:       str = "relu"
    dropout:          float = 0.0            # configurable
    weight_decay:     float = 1e-4           # configurable
    learning_rate:    float = 1e-3
    batch_size:       int = 32
    max_epochs:       int = 100
    early_stopping_patience: int = 10        # epochs w/o val improvement
    loss:             str = "MSE"
    seed:             int = 1337
    task:             str = "REGRESSION"     # REGRESSION | CLASSIFICATION | RANKING
    output_activation: str = "identity"      # "identity" | "sigmoid"

    def to_dict(self) -> dict:
        return {
            "hidden_sizes": list(self.hidden_sizes),
            "activation": self.activation,
            "dropout": self.dropout,
            "weight_decay": self.weight_decay,
            "learning_rate": self.learning_rate,
            "batch_size": self.batch_size,
            "max_epochs": self.max_epochs,
            "early_stopping_patience": self.early_stopping_patience,
            "loss": self.loss,
            "seed": self.seed,
            "task": self.task,
            "output_activation": self.output_activation,
        }


# ══════════════════════════════════════════════════════════════════════════════
# MLP ranker
# ══════════════════════════════════════════════════════════════════════════════

class MLPRanker(RankerInterfaceMixin):
    """
    Compact deterministic MLP that produces alpha scores (spec §5).

    Score semantics: ALPHA_SCORE (higher = more attractive). If task is
    CLASSIFICATION with sigmoid output, predict_proba() returns RAW probability
    (which must be calibrated through Phase 3F before being called a calibrated
    probability — spec §35).
    """

    def __init__(self, input_dim: int, config: Optional[MLPConfig] = None,
                 model_version: str = "mlp-v1"):
        self.input_dim = input_dim
        self.config = config or MLPConfig()
        self._model_version = model_version
        self._seed_bundle = SeedBundle(master=self.config.seed)
        self._rng = self._seed_bundle.generator()
        self._dropout_rng = self._seed_bundle.generator()
        self._built = False
        self._fitted = False
        self.layers: list[Dense] = []
        self.dropouts: list[Dropout] = []
        self.best_epoch: int = 0
        self.history: dict = {}
        self._build()

    # ── identity (BaseRanker contract) ───────────────────────────────────

    @property
    def model_id(self) -> str:
        return f"mlp-{'x'.join(str(h) for h in self.config.hidden_sizes)}"

    @property
    def model_version(self) -> str:
        return self._model_version

    @property
    def score_semantics(self) -> str:
        return "ALPHA_SCORE: MLP output, higher=more attractive (NOT a probability)"

    # ── architecture ─────────────────────────────────────────────────────

    def _build(self) -> None:
        dims = [self.input_dim, *self.config.hidden_sizes]
        self.layers = []
        self.dropouts = []
        for i in range(len(dims) - 1):
            self.layers.append(Dense(dims[i], dims[i + 1], self._rng, self.config.activation))
            self.dropouts.append(Dropout(self.config.dropout, self._dropout_rng))
        # output layer
        self.layers.append(Dense(dims[-1], 1, self._rng, self.config.output_activation))
        self._built = True

    @property
    def parameter_count(self) -> int:
        return count_trainable_params(self.layers)

    @property
    def trainable_parameter_count(self) -> int:
        return self.parameter_count

    def architecture_summary(self) -> dict:
        return {
            "family": "MLP",
            "input_dim": self.input_dim,
            "hidden_sizes": list(self.config.hidden_sizes),
            "output_dim": 1,
            "activation": self.config.activation,
            "output_activation": self.config.output_activation,
            "parameter_count": self.parameter_count,
            "framework": FRAMEWORK,
            "framework_version": FRAMEWORK_VERSION,
        }

    # ── forward / backward ───────────────────────────────────────────────

    def _forward(self, X: np.ndarray, training: bool) -> np.ndarray:
        h = X
        for i, layer in enumerate(self.layers[:-1]):
            h = layer.forward(h)
            h = self.dropouts[i].forward(h, training)
        out = self.layers[-1].forward(h)
        return out.reshape(-1)

    def _backward(self, grad_out: np.ndarray):
        grad = grad_out.reshape(-1, 1)
        params: list[np.ndarray] = []
        grads: list[np.ndarray] = []
        # output layer
        grad, gW, gb = self.layers[-1].backward(grad)
        out_pw = [(self.layers[-1].W, gW), (self.layers[-1].b, gb)]
        # hidden layers in reverse
        hidden_pw = []
        for i in range(len(self.layers) - 2, -1, -1):
            grad = self.dropouts[i].backward(grad)
            grad, gW, gb = self.layers[i].backward(grad)
            hidden_pw.append((self.layers[i].W, gW))
            hidden_pw.append((self.layers[i].b, gb))
        for p, g in out_pw + hidden_pw:
            params.append(p)
            grads.append(g)
        return params, grads

    # ── fit (early stopping on VALIDATION only — spec §22) ────────────────

    def fit(self, X_train, y_train, groups=None, sample_weight=None,
            X_val=None, y_val=None) -> dict:
        cfg = self.config
        X_train = np.asarray(X_train, dtype=float)
        y_train = np.asarray(y_train, dtype=float).reshape(-1)
        opt = AdamOptimizer(lr=cfg.learning_rate, weight_decay=cfg.weight_decay)
        loss_fn = LOSS_FUNCS[cfg.loss]

        n = X_train.shape[0]
        best_val = np.inf
        best_snapshot = None
        best_epoch = 0
        patience = 0
        train_losses: list[float] = []
        val_losses: list[float] = []

        # deterministic batch order via dedicated generator
        batch_rng = self._seed_bundle.generator()

        for epoch in range(cfg.max_epochs):
            perm = batch_rng.permutation(n)
            epoch_loss = 0.0
            n_batches = 0
            for start in range(0, n, cfg.batch_size):
                idx = perm[start:start + cfg.batch_size]
                xb, yb = X_train[idx], y_train[idx]
                pred = self._forward(xb, training=True)
                loss, grad = loss_fn(pred, yb)
                params, grads = self._backward(grad)
                opt.step(params, grads)
                epoch_loss += loss
                n_batches += 1
            train_losses.append(epoch_loss / max(1, n_batches))

            # VALIDATION-only early stopping (spec §22) — NEVER OOS
            if X_val is not None and y_val is not None:
                vpred = self._forward(np.asarray(X_val, dtype=float), training=False)
                vloss, _ = loss_fn(vpred, np.asarray(y_val, dtype=float).reshape(-1))
                val_losses.append(vloss)
                if vloss < best_val - 1e-9:
                    best_val = vloss
                    best_epoch = epoch
                    best_snapshot = self._snapshot()
                    patience = 0
                else:
                    patience += 1
                    if patience >= cfg.early_stopping_patience:
                        break

        # restore best VALIDATION checkpoint (spec §23)
        if best_snapshot is not None:
            self._restore(best_snapshot)
            self.best_epoch = best_epoch

        self._fitted = True
        self.history = {
            "train_loss": train_losses,
            "val_loss": val_losses,
            "best_epoch": self.best_epoch,
            "final_train_loss": train_losses[-1] if train_losses else None,
            "best_val_loss": best_val if best_val != np.inf else None,
        }
        return self.history

    # ── predict ──────────────────────────────────────────────────────────

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Raw alpha scores (higher=better). Deterministic (dropout off)."""
        return self._forward(np.asarray(X, dtype=float), training=False)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """
        RAW probability (sigmoid of output). NOT calibrated. Must be passed
        through Phase 3F calibration before being treated as a probability
        (spec §35). Only meaningful for CLASSIFICATION/sigmoid output.
        """
        raw = self._forward(np.asarray(X, dtype=float), training=False)
        if self.config.output_activation == "sigmoid":
            return raw  # already sigmoid'd by the output layer
        return sigmoid(raw)

    # ── checkpoint snapshot (in-memory; for best-val restore) ─────────────

    def _snapshot(self):
        return [(l.W.copy(), l.b.copy()) for l in self.layers]

    def _restore(self, snap):
        for l, (W, b) in zip(self.layers, snap):
            l.W = W.copy()
            l.b = b.copy()

    def state_bytes(self) -> bytes:
        """Serialized parameters (for artifact hashing / size)."""
        parts = []
        for l in self.layers:
            parts.append(l.W.tobytes())
            parts.append(l.b.tobytes())
        return b"".join(parts)
