"""
Phase 3L — Deterministic execution baselines + ORACLE_ONLY upper bound
(spec §25, §26, §41, §64).

Before any RL is trained, deterministic execution policies establish the bar RL
must beat. Every baseline is a pure function of PIT information only (spec §25)
and produces a per-step execution action label for the RL environment's action
space, so RL and baselines run through the IDENTICAL environment + Phase 3G
simulator (spec §41, §85).

Baselines (spec §25):
  - NEXT_OPEN            execute everything at the next bar (front-loaded)
  - TWAP                 equal slices across the deadline
  - VWAP_PROXY           slice proportional to (past) volume profile
  - FIXED_PARTICIPATION  constant participation-rate action
  - PASSIVE              minimal participation
  - AGGRESSIVE           maximal participation

ORACLE_ONLY (spec §26, §64): a research-only upper bound that MAY use future
information to pick the best fill bar. It is CLEARLY LABELLED and must NEVER be
used for training or production — it only quantifies available headroom.

Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .schemas import ExecutionAction, BehaviorPolicyId
from .environment import MarketBar
from .actions import EXECUTION_ACTIONS


# Sentinel label so an oracle policy can never be confused with a real one.
ORACLE_ONLY_LABEL = "ORACLE_ONLY"


class BaselinePolicy:
    """
    A deterministic execution policy. `action_at(t, obs, mask, bars_seen)` returns
    an ExecutionAction label using ONLY information available at step t.
    `uses_future` is False for every real baseline.
    """
    policy_id: str = "BASELINE"
    uses_future: bool = False

    def reset(self, deadline_bars: int, target_qty: float) -> None:
        self.deadline_bars = deadline_bars
        self.target_qty = target_qty

    def action_at(self, t: int, past_bars: list[MarketBar]) -> str:  # pragma: no cover
        raise NotImplementedError


class NextOpenPolicy(BaselinePolicy):
    policy_id = BehaviorPolicyId.NEXT_OPEN.value

    def action_at(self, t: int, past_bars: list[MarketBar]) -> str:
        # Execute the full remaining target immediately at the next bar.
        return ExecutionAction.FULL.value if t == 0 else ExecutionAction.WAIT.value


class TWAPPolicy(BaselinePolicy):
    policy_id = BehaviorPolicyId.TWAP.value

    def action_at(self, t: int, past_bars: list[MarketBar]) -> str:
        # Equal, steady slices → NORMAL every step until the deadline.
        return ExecutionAction.NORMAL.value if t < self.deadline_bars else ExecutionAction.WAIT.value


class VWAPProxyPolicy(BaselinePolicy):
    policy_id = BehaviorPolicyId.VWAP_PROXY.value

    def action_at(self, t: int, past_bars: list[MarketBar]) -> str:
        # Trade more aggressively when the PAST (already-seen) volume is above its
        # trailing average — a causal VWAP proxy (never uses future volume).
        if not past_bars:
            return ExecutionAction.PASSIVE.value
        vols = np.array([b.volume for b in past_bars], dtype=float)
        avg = float(np.mean(vols))
        last = float(vols[-1])
        if avg <= 0:
            return ExecutionAction.NORMAL.value
        ratio = last / avg
        if ratio >= 1.3:
            return ExecutionAction.AGGRESSIVE.value
        if ratio >= 0.8:
            return ExecutionAction.NORMAL.value
        return ExecutionAction.PASSIVE.value


class FixedParticipationPolicy(BaselinePolicy):
    policy_id = BehaviorPolicyId.FIXED_PARTICIPATION.value

    def __init__(self, action: str = ExecutionAction.NORMAL.value):
        self._action = action

    def action_at(self, t: int, past_bars: list[MarketBar]) -> str:
        return self._action if t < self.deadline_bars else ExecutionAction.WAIT.value


class PassivePolicy(BaselinePolicy):
    policy_id = BehaviorPolicyId.PASSIVE.value

    def action_at(self, t: int, past_bars: list[MarketBar]) -> str:
        return ExecutionAction.PASSIVE.value if t < self.deadline_bars else ExecutionAction.WAIT.value


class AggressivePolicy(BaselinePolicy):
    policy_id = BehaviorPolicyId.AGGRESSIVE.value

    def action_at(self, t: int, past_bars: list[MarketBar]) -> str:
        return ExecutionAction.AGGRESSIVE.value if t < self.deadline_bars else ExecutionAction.WAIT.value


DETERMINISTIC_BASELINES: dict[str, type[BaselinePolicy]] = {
    NextOpenPolicy.policy_id:          NextOpenPolicy,
    TWAPPolicy.policy_id:              TWAPPolicy,
    VWAPProxyPolicy.policy_id:         VWAPProxyPolicy,
    FixedParticipationPolicy.policy_id: FixedParticipationPolicy,
    PassivePolicy.policy_id:           PassivePolicy,
    AggressivePolicy.policy_id:        AggressivePolicy,
}


def make_baseline(policy_id: str) -> BaselinePolicy:
    cls = DETERMINISTIC_BASELINES.get(policy_id)
    if cls is None:
        raise ValueError(f"Unknown baseline policy: {policy_id}")
    return cls()


# ══════════════════════════════════════════════════════════════════════════════
# ORACLE_ONLY upper bound (spec §26, §64) — research-only, uses future data
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class OracleResult:
    """
    Research-only oracle upper bound. `uses_future` is ALWAYS True; this object
    is tagged ORACLE_ONLY and must never feed training or production (spec §26).
    """
    label:            str
    uses_future:      bool
    best_fill_index:  int
    best_fill_price:  float
    arrival_price:    float
    max_improvement_bps: float

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d["WARNING"] = "ORACLE_ONLY: uses future information; research upper bound only, never train/prod."
        return d


def oracle_best_execution(
    bars: list[MarketBar],
    trade_side: str = "LONG",
    deadline_bars: Optional[int] = None,
) -> OracleResult:
    """
    ORACLE_ONLY (spec §26): with full future knowledge, find the single best fill
    bar within the deadline to quantify the theoretical execution headroom vs the
    arrival price. LABELLED ORACLE_ONLY, uses_future=True. NEVER call this in
    training or production — only in offline headroom analysis (spec §64).
    """
    n = len(bars)
    horizon = min(n, deadline_bars or n)
    if horizon < 1:
        return OracleResult(ORACLE_ONLY_LABEL, True, -1, 0.0, 0.0, 0.0)
    arrival = bars[0].open
    window = bars[:horizon]
    if trade_side == "LONG":
        # buying: best = lowest price in the future window
        idx = int(np.argmin([b.low for b in window]))
        best_price = window[idx].low
        improvement = (arrival - best_price) / arrival * 10_000.0 if arrival else 0.0
    else:
        # selling: best = highest price in the future window
        idx = int(np.argmax([b.high for b in window]))
        best_price = window[idx].high
        improvement = (best_price - arrival) / arrival * 10_000.0 if arrival else 0.0
    return OracleResult(
        label=ORACLE_ONLY_LABEL, uses_future=True, best_fill_index=idx,
        best_fill_price=float(best_price), arrival_price=float(arrival),
        max_improvement_bps=float(max(0.0, improvement)),
    )


def run_baseline_schedule(policy: BaselinePolicy, bars: list[MarketBar],
                          deadline_bars: int, target_qty: float) -> list[str]:
    """
    Produce a deterministic action schedule for a baseline over an episode using
    ONLY past bars at each step (causal). Returns the per-step action labels.
    """
    policy.reset(deadline_bars, target_qty)
    schedule: list[str] = []
    for t in range(min(len(bars), deadline_bars + 1)):
        past = bars[: t + 1]   # bars available up to and including t (PIT)
        action = policy.action_at(t, past)
        if action not in EXECUTION_ACTIONS:
            action = ExecutionAction.WAIT.value
        schedule.append(action)
    return schedule
