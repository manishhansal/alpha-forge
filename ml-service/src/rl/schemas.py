"""
Phase 3L — Reinforcement-Learning execution research schemas.

Versioned identities, contracts, provenance, and classifications for the
controlled RL execution / trade-management research layer.

Design invariants
-----------------
1. RL is DOWNSTREAM of alpha/portfolio; it never learns alpha from scratch
   (spec §1, §3). The existing system provides the trading thesis.
2. Reward is NET of cost via Phase 3G — never raw price change (spec §17, §18).
3. Determinism: no global np.random.*; all stochasticity flows through an
   explicit seed (spec §6, §38, §56).
4. Every RL agent enters Phase 3J as a CHALLENGER; never auto-promoted
   (spec §40, §75, §92).
5. Everything is versioned: environment, reward, simulator, dataset
   (spec §14, §70, §73, §74).
6. NO live broker connection (spec §76, §92).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional


# ══════════════════════════════════════════════════════════════════════════════
# Enums
# ══════════════════════════════════════════════════════════════════════════════

class RLTrack(str, Enum):
    """Initial RL scope (spec §4). Tracks are NOT combined initially."""
    EXECUTION_OPTIMIZATION = "EXECUTION_OPTIMIZATION"   # Track A
    TRADE_MANAGEMENT       = "TRADE_MANAGEMENT"         # Track B


class ExecutionAction(str, Enum):
    """Execution action space (spec §10). Small, interpretable."""
    WAIT       = "WAIT"
    PASSIVE    = "PASSIVE"
    NORMAL     = "NORMAL"
    AGGRESSIVE = "AGGRESSIVE"
    FULL       = "FULL"


class TradeManagementAction(str, Enum):
    """Trade-management action space (spec §10)."""
    HOLD      = "HOLD"
    REDUCE_25 = "REDUCE_25"
    REDUCE_50 = "REDUCE_50"
    EXIT      = "EXIT"


class RLAlgorithm(str, Enum):
    """Supported algorithms (spec §24). Start with discrete-action DQN-equivalent."""
    TABULAR_Q       = "TABULAR_Q"        # tabular Q-learning (deterministic)
    LINEAR_Q        = "LINEAR_Q"         # linear function-approx Q (DQN-equivalent)
    BEHAVIOR_CLONE  = "BEHAVIOR_CLONE"   # behavior-cloning baseline
    # continuous-action algorithms considered only later (not implemented now):
    SAC             = "SAC"
    TD3             = "TD3"


class ExperimentStatus(str, Enum):
    """RL experiment status (spec §71)."""
    PLANNED             = "PLANNED"
    RUNNING             = "RUNNING"
    COMPLETED           = "COMPLETED"
    FAILED              = "FAILED"
    REJECTED            = "REJECTED"
    PROMOTION_ELIGIBLE  = "PROMOTION_ELIGIBLE"
    PROMOTED            = "PROMOTED"
    RETIRED             = "RETIRED"


VALID_EXPERIMENT_TRANSITIONS: dict[ExperimentStatus, set[ExperimentStatus]] = {
    ExperimentStatus.PLANNED:            {ExperimentStatus.RUNNING, ExperimentStatus.REJECTED},
    ExperimentStatus.RUNNING:            {ExperimentStatus.COMPLETED, ExperimentStatus.FAILED, ExperimentStatus.REJECTED},
    ExperimentStatus.COMPLETED:          {ExperimentStatus.PROMOTION_ELIGIBLE, ExperimentStatus.REJECTED, ExperimentStatus.RETIRED},
    ExperimentStatus.FAILED:             {ExperimentStatus.RETIRED},
    ExperimentStatus.REJECTED:           set(),
    ExperimentStatus.PROMOTION_ELIGIBLE: {ExperimentStatus.PROMOTED, ExperimentStatus.REJECTED, ExperimentStatus.RETIRED},
    ExperimentStatus.PROMOTED:           {ExperimentStatus.RETIRED},
    ExperimentStatus.RETIRED:            set(),
}


def is_valid_experiment_transition(a: ExperimentStatus, b: ExperimentStatus) -> bool:
    return b in VALID_EXPERIMENT_TRANSITIONS.get(a, set())


class BehaviorPolicyId(str, Enum):
    """Behavior policies that generate historical trajectories (spec §29)."""
    TWAP                = "TWAP"
    VWAP_PROXY          = "VWAP_PROXY"
    FIXED_PARTICIPATION = "FIXED_PARTICIPATION"
    PASSIVE             = "PASSIVE"
    AGGRESSIVE          = "AGGRESSIVE"
    NEXT_OPEN           = "NEXT_OPEN"
    EXISTING_DETERMINISTIC = "EXISTING_DETERMINISTIC"


class RLModelValueClass(str, Enum):
    """RL research decision (spec §88)."""
    SUPERIOR              = "SUPERIOR"
    COMPLEMENTARY         = "COMPLEMENTARY"
    REDUNDANT             = "REDUNDANT"
    UNSTABLE              = "UNSTABLE"
    WORSE                 = "WORSE"
    SIMULATOR_DEPENDENT   = "SIMULATOR_DEPENDENT"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class OPEStatus(str, Enum):
    """Off-policy-evaluation reliability (spec §33)."""
    RELIABLE                = "RELIABLE"
    OPE_INSUFFICIENT_EVIDENCE = "OPE_INSUFFICIENT_EVIDENCE"


class FallbackReason(str, Enum):
    """Why the deterministic fallback fired (spec §53)."""
    RL_UNAVAILABLE      = "RL_UNAVAILABLE"
    OOD_ACTION          = "OOD_ACTION"
    SAFETY_OVERRIDE     = "SAFETY_OVERRIDE"
    MARKET_CLOSED       = "MARKET_CLOSED"
    INSTRUMENT_INVALID  = "INSTRUMENT_INVALID"


# ══════════════════════════════════════════════════════════════════════════════
# Versioned contracts (spec §14, §70, §73, §74)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class ExecutionSimulatorVersion:
    """Pins the exact Phase 3G simulator used (spec §14)."""
    execution_engine_version: str = "backtest-engine-v1"
    cost_schedule_version:    str = "india-fno-2023"
    slippage_model_version:   str = "spread_proxy-k0.3-slippage-v1"
    market_calendar_version:  str = "nse-calendar-v1"
    backtest_config_hash:     str = ""

    @property
    def version_id(self) -> str:
        key = asdict(self)
        raw = json.dumps(key, sort_keys=True)
        return f"exec-sim-{hashlib.sha256(raw.encode()).hexdigest()[:12]}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["version_id"] = self.version_id
        return d


@dataclass(frozen=True)
class RewardFunctionVersion:
    """
    Versioned reward configuration (spec §19, §37, §73). Reward weights are
    HYPERPARAMETERS — never tuned on the final OOS.
    """
    gross_pnl_weight:   float = 1.0
    cost_weight:        float = 1.0     # subtract realized cost
    slippage_weight:    float = 1.0     # subtract slippage
    impact_weight:      float = 1.0     # subtract impact
    drawdown_penalty:   float = 0.0
    volatility_penalty: float = 0.0
    inventory_penalty:  float = 0.0
    turnover_penalty:   float = 0.0
    risk_limit_penalty: float = 0.0
    version_tag:        str = "reward-v1"

    @property
    def version_id(self) -> str:
        key = asdict(self)
        raw = json.dumps(key, sort_keys=True)
        return f"{self.version_tag}-{hashlib.sha256(raw.encode()).hexdigest()[:12]}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["version_id"] = self.version_id
        return d


@dataclass(frozen=True)
class ObservationSchema:
    """Explicit observation contract (spec §8). No future-information fields."""
    fields:        tuple[str, ...]
    feature_version: str = "fv4"
    version_tag:   str = "obs-v1"

    @property
    def version_id(self) -> str:
        raw = json.dumps({"fields": list(self.fields), "fv": self.feature_version,
                          "tag": self.version_tag}, sort_keys=True)
        return f"{self.version_tag}-{hashlib.sha256(raw.encode()).hexdigest()[:12]}"

    @property
    def dim(self) -> int:
        return len(self.fields)

    def to_dict(self) -> dict:
        return {"fields": list(self.fields), "feature_version": self.feature_version,
                "version_id": self.version_id, "dim": self.dim}


@dataclass(frozen=True)
class ActionSchema:
    """Explicit action contract (spec §10)."""
    track:   str                   # RLTrack value
    actions: tuple[str, ...]
    version_tag: str = "act-v1"

    @property
    def version_id(self) -> str:
        raw = json.dumps({"track": self.track, "actions": list(self.actions),
                          "tag": self.version_tag}, sort_keys=True)
        return f"{self.version_tag}-{hashlib.sha256(raw.encode()).hexdigest()[:12]}"

    @property
    def n_actions(self) -> int:
        return len(self.actions)

    def to_dict(self) -> dict:
        return {"track": self.track, "actions": list(self.actions),
                "n_actions": self.n_actions, "version_id": self.version_id}


@dataclass(frozen=True)
class EnvironmentVersion:
    """Complete environment version (spec §74)."""
    observation_schema_id: str
    action_schema_id:      str
    reward_version_id:     str
    simulator_version_id:  str
    transition_rules:      str = "event-driven-execution-v1"
    termination_rules:     str = "target/deadline/close/expiry/impossible/kill-switch"
    version_tag:           str = "env-v1"

    @property
    def version_id(self) -> str:
        key = asdict(self)
        raw = json.dumps(key, sort_keys=True)
        return f"{self.version_tag}-{hashlib.sha256(raw.encode()).hexdigest()[:12]}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["version_id"] = self.version_id
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Provenance (spec §9, §39, §70)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class RLAgentProvenance:
    """Full provenance for a trained RL agent (spec §39, §70)."""
    agent_id:              str
    agent_version:         str
    algorithm:             str            # RLAlgorithm value
    policy_scope:          str            # e.g. "equity_execution" / "index_futures"
    environment_version:   str
    reward_version:        str
    dataset_version:       str
    execution_version:     str
    cost_version:          str
    seed:                  int
    numpy_seed:            int
    hyperparameters:       dict = field(default_factory=dict)
    artifact_hash:         str = ""
    code_version:          str = ""
    determinism_limitations: str = ""

    @property
    def hyperparameter_hash(self) -> str:
        raw = json.dumps(self.hyperparameters, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["hyperparameter_hash"] = self.hyperparameter_hash
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Reward component ledger (spec §21)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RewardComponents:
    """Per-episode reward ledger (spec §21). net_reward must reconcile."""
    gross_pnl:          float = 0.0
    transaction_cost:   float = 0.0
    slippage_cost:      float = 0.0
    impact_cost:        float = 0.0
    risk_penalty:       float = 0.0
    turnover_penalty:   float = 0.0
    inventory_penalty:  float = 0.0
    net_reward:         float = 0.0
    reward_version:     str = ""

    def compute_net(self, rf: "RewardFunctionVersion") -> float:
        """Deterministically compute net_reward from components + weights."""
        self.net_reward = (
            rf.gross_pnl_weight * self.gross_pnl
            - rf.cost_weight * self.transaction_cost
            - rf.slippage_weight * self.slippage_cost
            - rf.impact_weight * self.impact_cost
            - self.risk_penalty
            - self.turnover_penalty
            - self.inventory_penalty
        )
        self.reward_version = rf.version_id
        return self.net_reward

    def reconciles(self, rf: "RewardFunctionVersion", tol: float = 1e-6) -> bool:
        """
        Verify net_reward == weighted sum of components under `rf` (spec §21).
        Recomputes the weighted expectation and compares to the stored value.
        """
        expected = (
            rf.gross_pnl_weight * self.gross_pnl
            - rf.cost_weight * self.transaction_cost
            - rf.slippage_weight * self.slippage_cost
            - rf.impact_weight * self.impact_cost
            - self.risk_penalty
            - self.turnover_penalty
            - self.inventory_penalty
        )
        return abs(self.net_reward - expected) <= tol

    def to_dict(self) -> dict:
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# RL experiment record (spec §71)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RLExperiment:
    """A reproducible RL experiment (spec §71). Failed experiments are recorded."""
    experiment_id:       str
    agent_id:            str
    track:               str                 # RLTrack value
    algorithm:           str                 # RLAlgorithm value
    status:              ExperimentStatus

    environment_version: str = ""
    reward_version:      str = ""
    dataset_snapshot:    str = ""
    behavior_policy:     str = ""
    hyperparameters:     dict = field(default_factory=dict)
    seed:                int = 1337
    training_period:     str = ""
    validation_period:   str = ""
    oos_period:          str = ""
    final_holdout_used_count: int = 0        # spec §87 — must stay <= 1

    results:             dict = field(default_factory=dict)
    model_value_class:   str = ""            # RLModelValueClass value
    ope_status:          str = ""            # OPEStatus value
    rejection_reason:    str = ""

    created_at:          str = ""
    updated_at:          str = ""
    status_history:      list[dict] = field(default_factory=list)
    notes:               list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value if isinstance(self.status, ExperimentStatus) else self.status
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "RLExperiment":
        data = dict(d)
        if isinstance(data.get("status"), str):
            data["status"] = ExperimentStatus(data["status"])
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


# ══════════════════════════════════════════════════════════════════════════════
# Offline trajectory schemas (spec §28, §72)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Transition:
    """One (obs, action, reward, next_obs, done) tuple (spec §28)."""
    timestamp:          str
    instrument:         str
    policy_id:          str
    execution_version:  str
    observation:        list[float]
    action:             int
    reward:             float
    next_observation:   list[float]
    done:               bool

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TrajectoryDatasetMeta:
    """Immutable trajectory-dataset metadata (spec §72)."""
    trajectory_id:      str
    source_policy:      str
    data_snapshot:      str
    environment_version: str
    episode_count:      int
    observation_count:  int
    created_at:         str = ""
    content_hash:       str = ""

    def to_dict(self) -> dict:
        return asdict(self)
