"""
Phase 3L — RL model-value classification + action audit + fallback policy
(spec §53, §55, §58, §80, §88).

Provides:
  - classify_rl_value(): documented multi-criteria classification of an RL policy
    into SUPERIOR / COMPLEMENTARY / REDUNDANT / UNSTABLE / WORSE /
    SIMULATOR_DEPENDENT / INSUFFICIENT_EVIDENCE (spec §88). NO_INCREMENTAL_
    EXECUTION_ALPHA maps to WORSE/REDUNDANT and is a successful result (spec §80).
  - RLActionAudit: mandatory per-decision audit record (spec §55) with state hash.
  - FallbackController: deterministic fallback when RL cannot safely act
    (spec §53) — routes to a deterministic baseline and logs the reason.

Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .schemas import RLModelValueClass, OPEStatus, FallbackReason
from .baselines import BaselinePolicy, make_baseline
from .schemas import BehaviorPolicyId


# ══════════════════════════════════════════════════════════════════════════════
# Classification inputs / decision (spec §88)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RLClassificationInputs:
    """Structured evidence for classifying an RL execution policy (spec §88)."""
    # evidence validity (hierarchy top — spec §75-style gate)
    ope_status:            str = OPEStatus.OPE_INSUFFICIENT_EVIDENCE.value
    final_holdout_contaminated: bool = False
    n_oos_episodes:        int = 0

    # execution economics vs best deterministic baseline (net-of-cost)
    rl_net_reward:         Optional[float] = None
    best_baseline_net_reward: Optional[float] = None
    baseline_name:         str = ""

    # incremental / ensemble
    incremental_vs_baseline: Optional[float] = None   # rl - best_baseline

    # stability + robustness + failure modes
    seed_std:              Optional[float] = None
    simulator_dependency_risk: bool = False
    policy_collapse:       bool = False

    # risk (must not materially worsen)
    risk_worsened:         Optional[bool] = None

    # thresholds (documented, configurable)
    min_oos_episodes:      int = 20
    min_improvement:       float = 0.0           # RL must beat baseline by this (net INR)
    max_seed_std_frac:     float = 0.5           # std relative to |mean| tolerance


@dataclass
class RLValueDecision:
    value_class:  str          # RLModelValueClass value
    reasons:      list[str] = field(default_factory=list)
    criteria:     dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"value_class": self.value_class, "reasons": self.reasons, "criteria": self.criteria}


def classify_rl_value(inp: RLClassificationInputs) -> RLValueDecision:
    """
    Documented multi-criteria classification (spec §88). Order follows the
    research hierarchy: evidence validity gates first; then simulator dependency;
    then stability; then economics. No single metric decides.
    """
    reasons: list[str] = []
    crit = {
        "ope_status": inp.ope_status,
        "n_oos_episodes": inp.n_oos_episodes,
        "rl_net_reward": inp.rl_net_reward,
        "best_baseline_net_reward": inp.best_baseline_net_reward,
        "incremental_vs_baseline": inp.incremental_vs_baseline,
        "seed_std": inp.seed_std,
        "simulator_dependency_risk": inp.simulator_dependency_risk,
    }

    # Gate 1: evidence validity (spec §33, §87)
    if inp.final_holdout_contaminated:
        return RLValueDecision(RLModelValueClass.INSUFFICIENT_EVIDENCE.value,
                               ["FINAL_HOLDOUT_CONTAMINATED — evidence invalid (spec §87)"], crit)
    if inp.ope_status == OPEStatus.OPE_INSUFFICIENT_EVIDENCE.value:
        return RLValueDecision(RLModelValueClass.INSUFFICIENT_EVIDENCE.value,
                               ["OPE unreliable (OPE_INSUFFICIENT_EVIDENCE) — cannot trust value estimate (spec §33)"], crit)
    if inp.n_oos_episodes < inp.min_oos_episodes:
        return RLValueDecision(RLModelValueClass.INSUFFICIENT_EVIDENCE.value,
                               [f"only {inp.n_oos_episodes} OOS episodes (< {inp.min_oos_episodes})"], crit)
    if inp.rl_net_reward is None or inp.best_baseline_net_reward is None:
        return RLValueDecision(RLModelValueClass.INSUFFICIENT_EVIDENCE.value,
                               ["missing RL or baseline net reward"], crit)

    # Gate 2: simulator dependency (spec §60) → SIMULATOR_DEPENDENT
    if inp.simulator_dependency_risk:
        reasons.append("performance collapses under modest simulator perturbations (spec §60)")
        return RLValueDecision(RLModelValueClass.SIMULATOR_DEPENDENT.value, reasons, crit)

    # Gate 3: stability (spec §38, §59)
    unstable = False
    if inp.policy_collapse:
        unstable = True
        reasons.append("policy/action collapse detected (spec §59)")
    if (inp.seed_std is not None and inp.rl_net_reward not in (None, 0)
            and abs(inp.seed_std) > inp.max_seed_std_frac * abs(inp.rl_net_reward)):
        unstable = True
        reasons.append(f"seed instability: std {inp.seed_std:.2f} large vs mean {inp.rl_net_reward:.2f}")

    improvement = inp.incremental_vs_baseline
    if improvement is None:
        improvement = inp.rl_net_reward - inp.best_baseline_net_reward

    # Gate 4: economics
    if improvement < -inp.min_improvement:
        reasons.append(f"RL net {inp.rl_net_reward:.2f} < best baseline {inp.best_baseline_net_reward:.2f} (WORSE)")
        return RLValueDecision(RLModelValueClass.WORSE.value, reasons, crit)

    if unstable:
        return RLValueDecision(RLModelValueClass.UNSTABLE.value, reasons, crit)

    beats = improvement > inp.min_improvement
    risk_ok = inp.risk_worsened is not True
    if beats and risk_ok:
        reasons.append(f"RL beats best baseline by {improvement:.2f} net, stable, risk not worsened (SUPERIOR)")
        return RLValueDecision(RLModelValueClass.SUPERIOR.value, reasons, crit)

    # near-equal to baseline
    if abs(improvement) <= inp.min_improvement:
        reasons.append("RL ~= best deterministic baseline; no incremental execution alpha (REDUNDANT)")
        return RLValueDecision(RLModelValueClass.REDUNDANT.value, reasons, crit)

    # beats but risk worsened → complementary at best
    reasons.append("RL edge exists but risk worsened / not standalone-superior (COMPLEMENTARY)")
    return RLValueDecision(RLModelValueClass.COMPLEMENTARY.value, reasons, crit)


# ══════════════════════════════════════════════════════════════════════════════
# RL action audit (spec §55, §56)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RLActionAudit:
    """Mandatory per-decision audit record (spec §55)."""
    agent_id:          str
    state_hash:        str
    action_requested:  str
    action_allowed:    bool
    action_executed:   str
    safety_override:   bool
    override_reason:   str
    reward:            float
    timestamp:         str = ""

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def build_action_audit(agent_id: str, state_hash: str, safety_decision,
                       reward: float, timestamp: str = "") -> RLActionAudit:
    """Construct an audit record from a SafetyDecision (spec §55)."""
    return RLActionAudit(
        agent_id=agent_id,
        state_hash=state_hash,
        action_requested=safety_decision.requested_action,
        action_allowed=not safety_decision.safety_override,
        action_executed=safety_decision.executed_action,
        safety_override=safety_decision.safety_override,
        override_reason=safety_decision.override_reason,
        reward=float(reward),
        timestamp=timestamp,
    )


# ══════════════════════════════════════════════════════════════════════════════
# Fallback controller (spec §53)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FallbackDecision:
    used_fallback:   bool
    fallback_policy: str
    reason:          str
    action:          str

    def to_dict(self) -> dict:
        return self.__dict__.copy()


class FallbackController:
    """
    Deterministic fallback when RL cannot safely produce an action (spec §53).
    Routes to a deterministic baseline (default FIXED_PARTICIPATION / TWAP) and
    logs the reason. This is explicit and never silent.
    """

    def __init__(self, fallback_policy_id: str = BehaviorPolicyId.FIXED_PARTICIPATION.value):
        self.fallback_policy_id = fallback_policy_id
        try:
            self._policy: Optional[BaselinePolicy] = make_baseline(fallback_policy_id)
        except ValueError:
            self._policy = make_baseline(BehaviorPolicyId.TWAP.value)
            self.fallback_policy_id = BehaviorPolicyId.TWAP.value

    def decide(self, rl_available: bool, ood_abstained: bool,
               t: int, past_bars, deadline_bars: int, target_qty: float,
               rl_action: Optional[str] = None) -> FallbackDecision:
        """
        If RL is unavailable or abstained (OOD), fall back to the deterministic
        baseline; otherwise use the RL action.
        """
        if not rl_available:
            self._policy.reset(deadline_bars, target_qty)
            action = self._policy.action_at(t, past_bars)
            return FallbackDecision(True, self.fallback_policy_id,
                                    FallbackReason.RL_UNAVAILABLE.value, action)
        if ood_abstained:
            self._policy.reset(deadline_bars, target_qty)
            action = self._policy.action_at(t, past_bars)
            return FallbackDecision(True, self.fallback_policy_id,
                                    FallbackReason.OOD_ACTION.value, action)
        return FallbackDecision(False, "", "", rl_action or "WAIT")
