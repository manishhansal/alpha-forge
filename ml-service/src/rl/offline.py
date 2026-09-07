"""
Phase 3L — Offline RL: trajectory generation, behavior cloning, OOD protection
(spec §27, §28, §29, §30, §31).

Offline RL is PREFERRED over uncontrolled online exploration (spec §27). This
module:
  - generates (obs, action, reward, next_obs, done) trajectories by running
    deterministic behavior policies through the causal environment (spec §28);
  - records which behavior policy produced each action (spec §29);
  - measures state-action COVERAGE and an OOD score so an offline agent cannot
    freely choose actions unsupported by the data — it must ABSTAIN / FALL BACK
    to a deterministic baseline instead of hallucinating execution quality
    (spec §30);
  - provides a behavior-cloning baseline that learns the existing execution
    behaviour (spec §31).

Determinism: no np.random.*.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from .schemas import Transition, FallbackReason
from .environment import ExecutionEnv, MarketBar, EpisodeConfig
from .baselines import BaselinePolicy, run_baseline_schedule
from .actions import action_list


# ══════════════════════════════════════════════════════════════════════════════
# Trajectory generation (spec §28, §29)
# ══════════════════════════════════════════════════════════════════════════════

def generate_trajectory(
    env: ExecutionEnv,
    behavior_policy: BaselinePolicy,
    bars: list[MarketBar],
    episode: EpisodeConfig,
) -> list[Transition]:
    """
    Run a deterministic behavior policy through the causal environment and record
    the (obs, action, reward, next_obs, done) transitions with the behavior
    policy id and execution version (spec §28, §29).
    """
    actions = env.actions
    schedule = run_baseline_schedule(behavior_policy, bars, episode.deadline_bars, episode.target_qty)
    obs, _ = env.reset()
    exec_version = env.environment_version().simulator_version_id
    transitions: list[Transition] = []
    done = False
    i = 0
    while not done and i < len(schedule):
        action_label = schedule[i]
        mask = env.action_mask()
        idx = actions.index(action_label) if action_label in actions else 0
        if not mask[idx]:
            idx = 0  # masked → WAIT/HOLD
        prev_obs = obs
        step_bar = env.bars[min(env.t, len(env.bars) - 1)]
        obs, reward, terminated, truncated, info = env.step(idx)
        done = terminated or truncated
        transitions.append(Transition(
            timestamp=step_bar.timestamp.isoformat(),
            instrument=episode.instrument,
            policy_id=behavior_policy.policy_id,
            execution_version=exec_version,
            observation=[float(x) for x in np.asarray(prev_obs).tolist()],
            action=int(idx),
            reward=float(reward),
            next_observation=[float(x) for x in np.asarray(obs).tolist()],
            done=bool(done),
        ))
        i += 1
    return transitions


# ══════════════════════════════════════════════════════════════════════════════
# State-action coverage + OOD protection (spec §30)
# ══════════════════════════════════════════════════════════════════════════════

def _discretize(obs: list[float], bins: int = 5) -> tuple:
    """Coarse deterministic binning of an observation for coverage counting."""
    return tuple(int(np.clip(np.floor(v * bins), -bins * 4, bins * 4)) for v in obs)


@dataclass
class CoverageModel:
    """
    Tracks state-action coverage from the offline dataset (spec §30). An offline
    agent's proposed (state, action) is scored; unsupported pairs are OOD.
    """
    bins:                 int = 5
    action_frequency:     dict = field(default_factory=lambda: defaultdict(int))
    state_action_counts:  dict = field(default_factory=lambda: defaultdict(int))
    state_counts:         dict = field(default_factory=lambda: defaultdict(int))
    n_transitions:        int = 0

    def fit(self, transitions: list[Transition]) -> "CoverageModel":
        for tr in transitions:
            s = _discretize(tr.observation, self.bins)
            self.action_frequency[tr.action] += 1
            self.state_action_counts[(s, tr.action)] += 1
            self.state_counts[s] += 1
            self.n_transitions += 1
        return self

    def action_support(self) -> dict:
        total = max(1, self.n_transitions)
        return {a: c / total for a, c in self.action_frequency.items()}

    def ood_score(self, obs: list[float], action: int) -> float:
        """
        OOD score in [0,1]: 0 = well supported, 1 = never seen. Combines
        state-visitation and state-action support (spec §30).
        """
        s = _discretize(obs, self.bins)
        sa = self.state_action_counts.get((s, action), 0)
        sc = self.state_counts.get(s, 0)
        if sc == 0:
            return 1.0                       # unseen state → fully OOD
        return 1.0 - (sa / sc)               # fraction of this state's mass NOT on this action

    def is_ood(self, obs: list[float], action: int, threshold: float = 0.85) -> bool:
        return self.ood_score(obs, action) >= threshold


@dataclass
class OODGuardedAction:
    """Result of applying OOD protection to a proposed offline-RL action."""
    proposed_action:  int
    executed_action:  int
    abstained:        bool
    ood_score:        float
    fallback_reason:  Optional[str] = None

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def apply_ood_protection(
    proposed_action: int,
    obs: list[float],
    coverage: CoverageModel,
    fallback_action: int = 0,          # 0 == WAIT/HOLD
    threshold: float = 0.85,
) -> OODGuardedAction:
    """
    If the proposed action is OOD for this state, ABSTAIN → fall back to a
    deterministic baseline action (spec §30). Never hallucinate execution
    quality on unsupported actions.
    """
    score = coverage.ood_score(obs, proposed_action)
    if score >= threshold:
        return OODGuardedAction(proposed_action, fallback_action, True, score,
                                FallbackReason.OOD_ACTION.value)
    return OODGuardedAction(proposed_action, proposed_action, False, score, None)


# ══════════════════════════════════════════════════════════════════════════════
# Behavior cloning baseline (spec §31)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class BehaviorCloneModel:
    """
    Deterministic behavior-cloning baseline (spec §31): learns P(action | binned
    state) from the offline dataset and predicts the most frequent action for a
    state. Pure NumPy / counting — no gradient training needed for a tabular BC.
    """
    bins:            int = 5
    n_actions:       int = 5
    _state_action:   dict = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))
    _global_action:  dict = field(default_factory=lambda: defaultdict(int))
    _fitted:         bool = False

    def fit(self, transitions: list[Transition]) -> "BehaviorCloneModel":
        for tr in transitions:
            s = _discretize(tr.observation, self.bins)
            self._state_action[s][tr.action] += 1
            self._global_action[tr.action] += 1
        self._fitted = True
        return self

    def predict(self, obs: list[float]) -> int:
        """Most-frequent behavior action for this state; global mode fallback."""
        s = _discretize(obs, self.bins)
        counts = self._state_action.get(s)
        if counts:
            return int(max(counts.items(), key=lambda kv: (kv[1], -kv[0]))[0])
        if self._global_action:
            return int(max(self._global_action.items(), key=lambda kv: (kv[1], -kv[0]))[0])
        return 0

    def action_match_rate(self, transitions: list[Transition]) -> float:
        """Fraction of transitions where BC reproduces the behavior action."""
        if not transitions:
            return 0.0
        correct = sum(1 for tr in transitions if self.predict(tr.observation) == tr.action)
        return correct / len(transitions)
