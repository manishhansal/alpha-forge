"""
Phase 3L — Pure-NumPy deterministic offline RL agent (spec §24, §35, §36, §37, §38).

A discrete-action, DQN-equivalent value learner implemented in pure NumPy so it
is fully deterministic and reproducible (torch/SB3/gymnasium are unavailable in
this environment; see reports/phase-3l-current-rl-audit.md §3.1).

Two interchangeable value representations:
  - TABULAR_Q: Q[state_bin, action] tabular Fitted-Q iteration on the offline
    dataset (a batch, offline analogue of DQN target-network iteration).
  - LINEAR_Q: linear function approximation Q(s,a) = phi(s)·W[:,a], solved by
    least-squares Fitted-Q iteration (deterministic).

Discipline (hard rules):
  - Trained OFFLINE on a fixed trajectory dataset (spec §27) — no uncontrolled
    online exploration.
  - Walk-forward validation with purge/embargo (spec §35).
  - HPO (gamma / lr / bins / iterations) and REWARD weights are hyperparameters
    selected on train/validation ONLY — never the final OOS (spec §36, §37).
  - Multi-seed robustness reports mean/median/std/worst/best (spec §38).
  - The greedy policy is OOD-guarded at inference (spec §30) via the offline
    CoverageModel; unsupported actions ABSTAIN to a fallback.

Determinism: all randomness flows through a seeded numpy.random.Generator.
No global np.random.*.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .schemas import Transition, RLAlgorithm
from .offline import _discretize, CoverageModel, apply_ood_protection


@dataclass
class QLearnConfig:
    """Offline Q-learning hyperparameters (tuned on train/val ONLY; spec §36)."""
    algorithm:       str = RLAlgorithm.TABULAR_Q.value
    n_actions:       int = 5
    gamma:           float = 0.99
    learning_rate:   float = 0.5        # tabular blend factor for FQI updates
    bins:            int = 4
    fqi_iterations:  int = 20
    l2:              float = 1.0        # linear-Q ridge
    seed:            int = 1337

    def hyperparameter_hash(self) -> str:
        raw = json.dumps({
            "algo": self.algorithm, "gamma": self.gamma, "lr": self.learning_rate,
            "bins": self.bins, "iters": self.fqi_iterations, "l2": self.l2,
        }, sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]


class OfflineQAgent:
    """Deterministic offline Fitted-Q agent (tabular or linear)."""

    def __init__(self, config: Optional[QLearnConfig] = None):
        self.config = config or QLearnConfig()
        self._rng = np.random.default_rng(self.config.seed)
        self.Q: Optional[np.ndarray] = None            # tabular: state_id -> action values
        self.W: Optional[np.ndarray] = None            # linear: (n_features, n_actions)
        self._state_index: dict = {}                    # binned-state tuple -> row id
        self._coverage: Optional[CoverageModel] = None
        self._fitted = False
        self.best_iteration = 0

    # ── state representation ──────────────────────────────────────────────

    def _state_id(self, obs: list[float], add: bool = False) -> int:
        key = _discretize(obs, self.config.bins)
        if key not in self._state_index:
            if not add:
                return -1
            self._state_index[key] = len(self._state_index)
        return self._state_index[key]

    @staticmethod
    def _phi(obs) -> np.ndarray:
        v = np.asarray(obs, dtype=float)
        return np.concatenate([[1.0], v])   # bias + raw features

    # ── fit (offline Fitted-Q Iteration; deterministic) ───────────────────

    def fit(self, transitions: list[Transition],
            coverage: Optional[CoverageModel] = None) -> dict:
        cfg = self.config
        self._coverage = coverage or CoverageModel(bins=cfg.bins).fit(transitions)

        if cfg.algorithm == RLAlgorithm.LINEAR_Q.value:
            history = self._fit_linear(transitions)
        else:
            history = self._fit_tabular(transitions)
        self._fitted = True
        return history

    def _fit_tabular(self, transitions: list[Transition]) -> dict:
        cfg = self.config
        # index all states (train states only)
        for tr in transitions:
            self._state_id(tr.observation, add=True)
            self._state_id(tr.next_observation, add=True)
        n_states = len(self._state_index)
        self.Q = np.zeros((n_states, cfg.n_actions))

        deltas = []
        for _ in range(cfg.fqi_iterations):
            newQ = self.Q.copy()
            for tr in transitions:
                s = self._state_id(tr.observation)
                ns = self._state_id(tr.next_observation)
                target = tr.reward
                if not tr.done and ns >= 0:
                    target += cfg.gamma * float(np.max(self.Q[ns]))
                newQ[s, tr.action] = (1 - cfg.learning_rate) * self.Q[s, tr.action] \
                    + cfg.learning_rate * target
            delta = float(np.max(np.abs(newQ - self.Q))) if n_states else 0.0
            self.Q = newQ
            deltas.append(delta)
        self.best_iteration = len(deltas)
        return {"algorithm": "TABULAR_Q", "n_states": n_states,
                "final_delta": deltas[-1] if deltas else 0.0, "deltas": deltas}

    def _fit_linear(self, transitions: list[Transition]) -> dict:
        cfg = self.config
        X = np.array([self._phi(tr.observation) for tr in transitions])   # (N, d)
        Xn = np.array([self._phi(tr.next_observation) for tr in transitions])
        A = np.array([tr.action for tr in transitions])
        R = np.array([tr.reward for tr in transitions], dtype=float)
        done = np.array([tr.done for tr in transitions], dtype=bool)
        d = X.shape[1]
        self.W = np.zeros((d, cfg.n_actions))

        deltas = []
        for _ in range(cfg.fqi_iterations):
            # bootstrap target using current W
            q_next = Xn @ self.W                       # (N, n_actions)
            max_next = np.max(q_next, axis=1)
            targets = R + cfg.gamma * np.where(done, 0.0, max_next)
            newW = self.W.copy()
            for a in range(cfg.n_actions):
                mask = (A == a)
                if mask.sum() == 0:
                    continue
                Xa = X[mask]
                ya = targets[mask]
                # ridge least squares: (XᵀX + l2 I)⁻¹ Xᵀy
                G = Xa.T @ Xa + cfg.l2 * np.eye(d)
                newW[:, a] = np.linalg.solve(G, Xa.T @ ya)
            delta = float(np.max(np.abs(newW - self.W)))
            self.W = newW
            deltas.append(delta)
        self.best_iteration = len(deltas)
        return {"algorithm": "LINEAR_Q", "n_features": d,
                "final_delta": deltas[-1] if deltas else 0.0, "deltas": deltas}

    # ── inference (greedy, OOD-guarded — spec §30) ────────────────────────

    def q_values(self, obs: list[float]) -> np.ndarray:
        if self.config.algorithm == RLAlgorithm.LINEAR_Q.value and self.W is not None:
            return self._phi(obs) @ self.W
        if self.Q is not None:
            sid = self._state_id(obs)
            if sid >= 0:
                return self.Q[sid]
            return np.zeros(self.config.n_actions)   # unseen tabular state → neutral
        return np.zeros(self.config.n_actions)

    def act(self, obs: list[float], mask: Optional[list[bool]] = None,
            ood_threshold: float = 0.85, fallback_action: int = 0) -> dict:
        """
        Greedy action, respecting the action mask and OOD protection.
        Returns {'action', 'greedy_action', 'abstained', 'ood_score', 'fallback_reason'}.
        """
        q = self.q_values(obs).copy()
        if mask is not None:
            for i, ok in enumerate(mask):
                if not ok:
                    q[i] = -np.inf
        greedy = int(np.argmax(q)) if np.any(np.isfinite(q)) else fallback_action

        abstained = False
        ood_score = 0.0
        fallback_reason = None
        if self._coverage is not None:
            guard = apply_ood_protection(greedy, obs, self._coverage,
                                         fallback_action=fallback_action, threshold=ood_threshold)
            abstained = guard.abstained
            ood_score = guard.ood_score
            fallback_reason = guard.fallback_reason
            action = guard.executed_action
        else:
            action = greedy
        # respect mask on the final action too
        if mask is not None and not mask[action]:
            action = fallback_action
        return {"action": int(action), "greedy_action": greedy, "abstained": abstained,
                "ood_score": float(ood_score), "fallback_reason": fallback_reason}

    # ── serialization / checkpoint (spec §24, §57) ────────────────────────

    def state_dict(self) -> dict:
        return {
            "config": self.config.__dict__,
            "algorithm": self.config.algorithm,
            "Q": self.Q.tolist() if self.Q is not None else None,
            "W": self.W.tolist() if self.W is not None else None,
            "state_index": {json.dumps(list(k)): v for k, v in self._state_index.items()},
            "best_iteration": self.best_iteration,
        }

    def artifact_hash(self) -> str:
        raw = json.dumps(self.state_dict(), sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()

    @classmethod
    def from_state_dict(cls, sd: dict) -> "OfflineQAgent":
        cfg = QLearnConfig(**sd["config"])
        agent = cls(cfg)
        agent.Q = np.array(sd["Q"]) if sd["Q"] is not None else None
        agent.W = np.array(sd["W"]) if sd["W"] is not None else None
        agent._state_index = {tuple(json.loads(k)): v for k, v in sd["state_index"].items()}
        agent.best_iteration = sd.get("best_iteration", 0)
        agent._fitted = True
        return agent


# ══════════════════════════════════════════════════════════════════════════════
# Walk-forward RL validation (spec §35) + multi-seed robustness (spec §38)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RLDataSplit:
    """Chronological, disjoint train/val/OOS transition index sets (spec §35)."""
    train: list[int]
    val:   list[int]
    oos:   list[int]

    def __post_init__(self):
        if self.train and self.val:
            assert max(self.train) < min(self.val), "train must precede val"
        if self.val and self.oos:
            assert max(self.val) < min(self.oos), "val must precede oos"

    @staticmethod
    def chronological(n: int, train_frac=0.6, val_frac=0.2, embargo: int = 0) -> "RLDataSplit":
        n_tr = int(n * train_frac)
        n_va = int(n * val_frac)
        train = list(range(0, n_tr))
        val = list(range(n_tr + embargo, n_tr + n_va))
        oos = list(range(n_tr + n_va + embargo, n))
        return RLDataSplit(train, val, oos)


def _subset(transitions: list[Transition], idx: list[int]) -> list[Transition]:
    return [transitions[i] for i in idx if 0 <= i < len(transitions)]


def mean_policy_value_on(transitions: list[Transition], agent: OfflineQAgent) -> float:
    """
    A simple, deterministic value proxy: mean recorded reward on transitions where
    the agent's greedy action matches the logged (behavior) action. This is a
    lower-variance train/val SELECTION signal only; true OOS uses OPE (Task 10).
    """
    matched = [tr.reward for tr in transitions
               if agent.act(tr.observation)["greedy_action"] == tr.action]
    return float(np.mean(matched)) if matched else float("nan")


def grid_search_hpo(
    transitions: list[Transition],
    split: RLDataSplit,
    param_grid: list[dict],
) -> dict:
    """
    Select hyperparameters on train/VALIDATION only (spec §36). The OOS set is
    NEVER touched here. Reward weights, if varied, are treated as hyperparameters
    too (spec §37) and belong in the grid.
    """
    train = _subset(transitions, split.train)
    val = _subset(transitions, split.val)
    trials = []
    best_cfg, best_score = None, -np.inf
    for params in param_grid:
        agent = OfflineQAgent(QLearnConfig(**params))
        agent.fit(train)
        score = mean_policy_value_on(val, agent)
        s = score if np.isfinite(score) else -np.inf
        trials.append({"params": params, "val_score": None if not np.isfinite(score) else score})
        if s > best_score:
            best_score, best_cfg = s, params
    return {"best_config": best_cfg or {}, "best_val_score": best_score if best_score != -np.inf else None,
            "trials": trials, "touched_oos": False}


@dataclass
class SeedRobustness:
    """Multi-seed OOS metric distribution (spec §38)."""
    metric_name: str
    seeds:       list[int]
    values:      list[float]

    def summary(self) -> dict:
        vals = [v for v in self.values if v is not None and np.isfinite(v)]
        if not vals:
            return {"metric": self.metric_name, "n_seeds": len(self.seeds),
                    "mean": None, "median": None, "std": None, "worst": None,
                    "best": None, "n_valid": 0}
        arr = np.array(vals)
        return {"metric": self.metric_name, "n_seeds": len(self.seeds),
                "mean": float(np.mean(arr)), "median": float(np.median(arr)),
                "std": float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0,
                "worst": float(np.min(arr)), "best": float(np.max(arr)),
                "n_valid": len(vals)}


def multi_seed_train_eval(
    transitions: list[Transition],
    split: RLDataSplit,
    base_config: QLearnConfig,
    seeds: list[int],
    metric_fn=None,
    metric_name: str = "oos_matched_reward",
) -> SeedRobustness:
    """
    Train the SAME configuration under multiple seeds; report the OOS metric
    distribution (spec §38). OOS is used only to REPORT after the config is
    fixed — never to pick a seed (that would be leakage; the seed is fixed
    beforehand or chosen on validation).
    """
    train = _subset(transitions, split.train)
    oos = _subset(transitions, split.oos)
    metric_fn = metric_fn or mean_policy_value_on
    values = []
    for seed in seeds:
        cfg = QLearnConfig(**{**base_config.__dict__, "seed": seed})
        agent = OfflineQAgent(cfg)
        agent.fit(train)
        values.append(metric_fn(oos, agent))
    return SeedRobustness(metric_name=metric_name, seeds=list(seeds), values=values)
