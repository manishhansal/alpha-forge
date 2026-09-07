"""
Phase 3L — Reinforcement-Learning Execution & Adaptive Trade Management.

A CONTROLLED RL research layer that operates DOWNSTREAM of the existing
alpha/ranker/meta/EV/portfolio/execution stack (spec §1, §3). It optimises
execution and trade management — WHEN/HOW/HOW-MUCH to execute — never the
trading thesis itself.

Guarantees:
  - Reuses the Phase 3G execution simulator, cost, and slippage (no second
    simulator; spec §5, §13).
  - Reward is NET of cost via Phase 3G (spec §17, §18).
  - RL action -> deterministic safety/constraint layer -> executable action;
    never RL -> broker (spec §11, §76, §92).
  - Offline RL preferred; off-policy evaluation with uncertainty (spec §27-§33).
  - Every RL agent enters Phase 3J as a CHALLENGER; never auto-promoted
    (spec §40, §75, §92).
  - Deterministic pure-NumPy backend (torch/SB3/gymnasium unavailable here); a
    gymnasium-compatible interface is exposed behind a capability check. See
    reports/phase-3l-current-rl-audit.md §3.1.

Modules
-------
schemas.py    versioned contracts, provenance, reward ledger, experiment record
registry.py   RL experiment registry + immutable trajectory registry + 3J wiring
environment.py causal, deterministic, replayable execution environment
actions.py    action space + deterministic safety layer + action masking
reward.py     net-of-cost reward computation via Phase 3G
baselines.py  TWAP/VWAP/participation/passive/aggressive + ORACLE_ONLY bound
offline.py    trajectory generation, behavior cloning, OOD protection
agent.py      pure-NumPy tabular/linear Q-learning + walk-forward + multi-seed
ope.py        off-policy evaluation (IS/WIS/DR/FQE) + uncertainty
evaluation.py execution/risk/capacity metrics, robustness, failure modes
classification.py RL model-value classification
"""

from .schemas import (
    RLTrack, ExecutionAction, TradeManagementAction, RLAlgorithm,
    ExperimentStatus, VALID_EXPERIMENT_TRANSITIONS, is_valid_experiment_transition,
    BehaviorPolicyId, RLModelValueClass, OPEStatus, FallbackReason,
    ExecutionSimulatorVersion, RewardFunctionVersion, ObservationSchema,
    ActionSchema, EnvironmentVersion, RLAgentProvenance, RewardComponents,
    RLExperiment, Transition, TrajectoryDatasetMeta,
)
from .registry import (
    RLExperimentRegistry, TrajectoryRegistry, RLRegistryError,
    InvalidExperimentTransition,
)
from .actions import (
    MarketContext, SafetyLayer, SafetyDecision, valid_action_mask,
    action_list, EXECUTION_ACTIONS, TRADE_MGMT_ACTIONS,
    EXECUTION_PARTICIPATION, TRADE_MGMT_REDUCTION,
)
from .reward import RewardEngine, StepEconomics
from .environment import (
    ExecutionEnv, MarketBar, EpisodeConfig, StepRecord, gymnasium_available,
    EXECUTION_OBS_FIELDS, TRADE_MGMT_OBS_FIELDS,
)
from .simulator_bridge import (
    SimulatorBridge, SimulatedEpisodeResult, make_decision, market_bars_to_ohlc,
)
from .baselines import (
    BaselinePolicy, NextOpenPolicy, TWAPPolicy, VWAPProxyPolicy,
    FixedParticipationPolicy, PassivePolicy, AggressivePolicy,
    DETERMINISTIC_BASELINES, make_baseline, oracle_best_execution, OracleResult,
    ORACLE_ONLY_LABEL, run_baseline_schedule,
)
from .offline import (
    generate_trajectory, CoverageModel, OODGuardedAction, apply_ood_protection,
    BehaviorCloneModel,
)
from .agent import (
    OfflineQAgent, QLearnConfig, RLDataSplit, grid_search_hpo,
    SeedRobustness, multi_seed_train_eval, mean_policy_value_on,
)
from .ope import (
    EmpiricalBehaviorPolicy, greedy_target_prob, OPEResult, evaluate_policy,
)
from .evaluation import (
    ExecutionMetrics, execution_metrics, RiskMetrics, risk_metrics,
    FailureModeReport, detect_failure_modes, PerturbationSpec,
    DEFAULT_PERTURBATIONS, RobustnessReport, robustness_report,
)
from .classification import (
    RLClassificationInputs, RLValueDecision, classify_rl_value,
    RLActionAudit, build_action_audit, FallbackController, FallbackDecision,
)

__all__ = [
    "RLTrack", "ExecutionAction", "TradeManagementAction", "RLAlgorithm",
    "ExperimentStatus", "VALID_EXPERIMENT_TRANSITIONS", "is_valid_experiment_transition",
    "BehaviorPolicyId", "RLModelValueClass", "OPEStatus", "FallbackReason",
    "ExecutionSimulatorVersion", "RewardFunctionVersion", "ObservationSchema",
    "ActionSchema", "EnvironmentVersion", "RLAgentProvenance", "RewardComponents",
    "RLExperiment", "Transition", "TrajectoryDatasetMeta",
    "RLExperimentRegistry", "TrajectoryRegistry", "RLRegistryError",
    "InvalidExperimentTransition",
    # actions / safety
    "MarketContext", "SafetyLayer", "SafetyDecision", "valid_action_mask",
    "action_list", "EXECUTION_ACTIONS", "TRADE_MGMT_ACTIONS",
    "EXECUTION_PARTICIPATION", "TRADE_MGMT_REDUCTION",
    # reward
    "RewardEngine", "StepEconomics",
    # environment
    "ExecutionEnv", "MarketBar", "EpisodeConfig", "StepRecord", "gymnasium_available",
    "EXECUTION_OBS_FIELDS", "TRADE_MGMT_OBS_FIELDS",
    # simulator bridge
    "SimulatorBridge", "SimulatedEpisodeResult", "make_decision", "market_bars_to_ohlc",
    # baselines
    "BaselinePolicy", "NextOpenPolicy", "TWAPPolicy", "VWAPProxyPolicy",
    "FixedParticipationPolicy", "PassivePolicy", "AggressivePolicy",
    "DETERMINISTIC_BASELINES", "make_baseline", "oracle_best_execution",
    "OracleResult", "ORACLE_ONLY_LABEL", "run_baseline_schedule",
    # offline
    "generate_trajectory", "CoverageModel", "OODGuardedAction",
    "apply_ood_protection", "BehaviorCloneModel",
    # agent
    "OfflineQAgent", "QLearnConfig", "RLDataSplit", "grid_search_hpo",
    "SeedRobustness", "multi_seed_train_eval", "mean_policy_value_on",
    # ope
    "EmpiricalBehaviorPolicy", "greedy_target_prob", "OPEResult", "evaluate_policy",
    # evaluation
    "ExecutionMetrics", "execution_metrics", "RiskMetrics", "risk_metrics",
    "FailureModeReport", "detect_failure_modes", "PerturbationSpec",
    "DEFAULT_PERTURBATIONS", "RobustnessReport", "robustness_report",
    # classification / audit / fallback
    "RLClassificationInputs", "RLValueDecision", "classify_rl_value",
    "RLActionAudit", "build_action_audit", "FallbackController", "FallbackDecision",
]
