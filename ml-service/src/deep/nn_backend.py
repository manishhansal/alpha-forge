"""
Phase 3K — Deterministic pure-NumPy neural backend.

Provides small, fully-deterministic neural primitives so Phase 3K deep-learning
research runs without a heavyweight framework and reproduces bit-for-bit given
a seed (spec §24, §62). Rationale in reports/phase-3k-current-deep-learning-audit.md §3.1.

Contents:
- SeedBundle       — explicit, recorded seeds (python/numpy/framework)
- Dense            — affine layer with deterministic init
- activations      — relu, tanh, sigmoid, identity + derivatives
- Dropout          — inverted dropout using a DEDICATED RNG (never np.random.*)
- AdamOptimizer    — deterministic Adam
- losses           — mse, huber, bce (+ grads)

Determinism rules
-----------------
1. NO global np.random.* is ever used. All stochasticity flows through a
   numpy.random.Generator seeded explicitly from SeedBundle and passed in.
2. Weight init is seeded and reproducible.
3. Dropout mask uses the model's dedicated Generator, so two runs with the same
   seed are identical.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, asdict
from typing import Optional

import numpy as np

FRAMEWORK = "numpy"
FRAMEWORK_VERSION = np.__version__


# ══════════════════════════════════════════════════════════════════════════════
# Seeds (spec §24)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class SeedBundle:
    """
    Explicit seed bundle. Recorded in provenance. `master` derives the rest so a
    single integer fully determines a run.
    """
    master:          int = 1337
    numpy_seed:      int = 0
    python_seed:     int = 0
    framework_seed:  int = 0
    deterministic_mode: bool = True

    def __post_init__(self) -> None:
        # Derive component seeds deterministically from master (no np.random.*)
        if self.numpy_seed == 0:
            self.numpy_seed = self._derive("numpy")
        if self.python_seed == 0:
            self.python_seed = self._derive("python")
        if self.framework_seed == 0:
            self.framework_seed = self._derive("framework")

    def _derive(self, tag: str) -> int:
        raw = f"{self.master}:{tag}".encode()
        return int(hashlib.sha256(raw).hexdigest()[:8], 16)

    def generator(self) -> np.random.Generator:
        """A fresh deterministic Generator for this bundle."""
        return np.random.default_rng(self.numpy_seed)

    def to_dict(self) -> dict:
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# Activations
# ══════════════════════════════════════════════════════════════════════════════

def relu(x): return np.maximum(0.0, x)
def relu_grad(x): return (x > 0.0).astype(float)

def tanh(x): return np.tanh(x)
def tanh_grad(x): return 1.0 - np.tanh(x) ** 2

def sigmoid(x):
    # numerically stable
    out = np.empty_like(x, dtype=float)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    ex = np.exp(x[~pos])
    out[~pos] = ex / (1.0 + ex)
    return out

def identity(x): return x
def identity_grad(x): return np.ones_like(x, dtype=float)

ACTIVATIONS = {
    "relu": (relu, relu_grad),
    "tanh": (tanh, tanh_grad),
    "identity": (identity, identity_grad),
}


# ══════════════════════════════════════════════════════════════════════════════
# Layers
# ══════════════════════════════════════════════════════════════════════════════

class Dense:
    """Affine layer y = xW + b with deterministic He/Xavier init."""

    def __init__(self, in_dim: int, out_dim: int, rng: np.random.Generator,
                 activation: str = "relu"):
        self.in_dim = in_dim
        self.out_dim = out_dim
        self.activation = activation
        # He init for relu, Xavier otherwise — using the passed Generator only.
        if activation == "relu":
            std = np.sqrt(2.0 / in_dim)
        else:
            std = np.sqrt(1.0 / in_dim)
        self.W = rng.standard_normal((in_dim, out_dim)) * std
        self.b = np.zeros(out_dim, dtype=float)
        # caches
        self._x = None
        self._z = None

    @property
    def n_params(self) -> int:
        return self.W.size + self.b.size

    def forward(self, x: np.ndarray) -> np.ndarray:
        self._x = x
        self._z = x @ self.W + self.b
        act, _ = ACTIVATIONS[self.activation]
        return act(self._z)

    def backward(self, grad_out: np.ndarray):
        _, act_grad = ACTIVATIONS[self.activation]
        grad_z = grad_out * act_grad(self._z)
        grad_W = self._x.T @ grad_z
        grad_b = grad_z.sum(axis=0)
        grad_in = grad_z @ self.W.T
        return grad_in, grad_W, grad_b


class Dropout:
    """Inverted dropout using a DEDICATED Generator (never np.random.*)."""

    def __init__(self, p: float, rng: np.random.Generator):
        self.p = float(p)
        self.rng = rng
        self._mask = None

    def forward(self, x: np.ndarray, training: bool) -> np.ndarray:
        if not training or self.p <= 0.0:
            self._mask = None
            return x
        keep = 1.0 - self.p
        self._mask = (self.rng.random(x.shape) < keep).astype(float) / keep
        return x * self._mask

    def backward(self, grad_out: np.ndarray) -> np.ndarray:
        if self._mask is None:
            return grad_out
        return grad_out * self._mask


# ══════════════════════════════════════════════════════════════════════════════
# Optimizer
# ══════════════════════════════════════════════════════════════════════════════

class AdamOptimizer:
    """Deterministic Adam with optional decoupled weight decay (AdamW-style)."""

    def __init__(self, lr: float = 1e-3, beta1: float = 0.9, beta2: float = 0.999,
                 eps: float = 1e-8, weight_decay: float = 0.0):
        self.lr = lr
        self.beta1 = beta1
        self.beta2 = beta2
        self.eps = eps
        self.weight_decay = weight_decay
        self._m: dict[int, np.ndarray] = {}
        self._v: dict[int, np.ndarray] = {}
        self._t = 0

    def step(self, params: list[np.ndarray], grads: list[np.ndarray]) -> None:
        self._t += 1
        for i, (p, g) in enumerate(zip(params, grads)):
            if i not in self._m:
                self._m[i] = np.zeros_like(p)
                self._v[i] = np.zeros_like(p)
            if self.weight_decay > 0.0:
                g = g + self.weight_decay * p
            self._m[i] = self.beta1 * self._m[i] + (1 - self.beta1) * g
            self._v[i] = self.beta2 * self._v[i] + (1 - self.beta2) * (g * g)
            m_hat = self._m[i] / (1 - self.beta1 ** self._t)
            v_hat = self._v[i] / (1 - self.beta2 ** self._t)
            p -= self.lr * m_hat / (np.sqrt(v_hat) + self.eps)


# ══════════════════════════════════════════════════════════════════════════════
# Losses (spec §18)
# ══════════════════════════════════════════════════════════════════════════════

def mse_loss(pred, target):
    diff = pred - target
    return float(np.mean(diff ** 2)), (2.0 / pred.shape[0]) * diff

def huber_loss(pred, target, delta: float = 1.0):
    diff = pred - target
    absd = np.abs(diff)
    quad = absd <= delta
    loss = np.where(quad, 0.5 * diff ** 2, delta * (absd - 0.5 * delta))
    grad = np.where(quad, diff, delta * np.sign(diff)) / pred.shape[0]
    return float(np.mean(loss)), grad

def bce_loss(prob, target, eps: float = 1e-7):
    p = np.clip(prob, eps, 1 - eps)
    loss = -(target * np.log(p) + (1 - target) * np.log(1 - p))
    grad = (p - target) / (p * (1 - p)) / prob.shape[0]
    return float(np.mean(loss)), grad


LOSS_FUNCS = {
    "MSE": mse_loss,
    "HUBER": huber_loss,
    "BCE": bce_loss,
}


def count_trainable_params(layers) -> int:
    return int(sum(l.n_params for l in layers if hasattr(l, "n_params")))
