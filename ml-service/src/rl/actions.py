"""
Phase 3L — Action space, deterministic safety layer, and action masking
(spec §10, §11, §12, §54).

Architecture (spec §11):

    RL action
        ↓
    Safety / Constraint Layer   (deterministic; never bypassed)
        ↓
    Executable action

The RL agent NEVER reaches a broker directly (spec §11, §76). Every action is
passed through the deterministic safety layer, which can override an unsafe
action with a SAFE_ACTION and record the override.

Action masking (spec §12): invalid actions (expired contract, F&O ban, market
closed, max position, no liquidity) are removed from the valid-action set so the
agent never sees them as opportunities.

Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .schemas import ExecutionAction, TradeManagementAction, RLTrack, FallbackReason


# Ordered action lists per track (index == discrete action id).
EXECUTION_ACTIONS: list[str] = [a.value for a in ExecutionAction]
TRADE_MGMT_ACTIONS: list[str] = [a.value for a in TradeManagementAction]

# Participation-rate mapping for execution actions (fraction of allowed ADV).
EXECUTION_PARTICIPATION: dict[str, float] = {
    ExecutionAction.WAIT.value:       0.0,
    ExecutionAction.PASSIVE.value:    0.02,
    ExecutionAction.NORMAL.value:     0.05,
    ExecutionAction.AGGRESSIVE.value: 0.10,
    ExecutionAction.FULL.value:       1.00,   # subject to safety cap
}

# Reduction fraction for trade-management actions.
TRADE_MGMT_REDUCTION: dict[str, float] = {
    TradeManagementAction.HOLD.value:      0.0,
    TradeManagementAction.REDUCE_25.value: 0.25,
    TradeManagementAction.REDUCE_50.value: 0.50,
    TradeManagementAction.EXIT.value:      1.00,
}


def action_list(track: str) -> list[str]:
    if track == RLTrack.EXECUTION_OPTIMIZATION.value:
        return EXECUTION_ACTIONS
    if track == RLTrack.TRADE_MANAGEMENT.value:
        return TRADE_MGMT_ACTIONS
    raise ValueError(f"Unknown track: {track}")


# ══════════════════════════════════════════════════════════════════════════════
# Market context for masking / safety (all PIT — no future information)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class MarketContext:
    """
    Point-in-time market/portfolio context used by the safety layer and mask.
    Every field is available at the decision timestamp (spec §15, §16).
    """
    market_open:        bool = True
    contract_expired:   bool = False
    fno_ban:            bool = False
    instrument_valid:   bool = True
    liquidity_available: bool = True
    adv_inr:            Optional[float] = None      # available daily volume value
    remaining_target_qty: float = 0.0               # qty still to execute (exec track)
    current_position_qty: float = 0.0
    max_position_qty:   float = 1e18
    max_participation_pct: float = 0.10
    max_turnover_qty:   float = 1e18                # per-step turnover cap
    price:              float = 0.0
    risk_limit_breached: bool = False


# ══════════════════════════════════════════════════════════════════════════════
# Action masking (spec §12)
# ══════════════════════════════════════════════════════════════════════════════

def valid_action_mask(track: str, ctx: MarketContext) -> list[bool]:
    """
    Return a boolean mask over the track's action list; True = valid.

    Invalid actions are masked (spec §12):
      - market closed / expired / invalid instrument -> only WAIT/HOLD valid
      - F&O ban -> no new/executing trade actions
      - max position reached -> no additional exposure
      - no liquidity -> only WAIT/HOLD valid
    """
    actions = action_list(track)
    mask = [True] * len(actions)

    hard_block = (not ctx.market_open) or ctx.contract_expired \
        or (not ctx.instrument_valid) or (not ctx.liquidity_available)

    if track == RLTrack.EXECUTION_OPTIMIZATION.value:
        for i, a in enumerate(actions):
            if a == ExecutionAction.WAIT.value:
                continue  # WAIT always valid
            if hard_block or ctx.fno_ban:
                mask[i] = False
                continue
            # already at/over max position → no additional execution
            if ctx.current_position_qty >= ctx.max_position_qty and ctx.remaining_target_qty > 0:
                mask[i] = False
            # nothing left to execute → only WAIT
            if ctx.remaining_target_qty <= 0:
                mask[i] = False
    else:  # TRADE_MANAGEMENT
        for i, a in enumerate(actions):
            if a == TradeManagementAction.HOLD.value:
                continue  # HOLD always valid
            if hard_block:
                # can't trade to reduce/exit when market closed/invalid → HOLD only
                mask[i] = False
                continue
            # nothing to manage if no position
            if ctx.current_position_qty == 0:
                mask[i] = False

    # guarantee at least one valid action (WAIT/HOLD)
    if not any(mask):
        mask[0] = True
    return mask


# ══════════════════════════════════════════════════════════════════════════════
# Safety layer (spec §11, §54)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class SafetyDecision:
    """Result of passing an RL action through the safety layer."""
    requested_action:   str
    executed_action:    str
    safety_override:    bool
    override_reason:    str = ""
    allowed_participation: float = 0.0     # fraction actually permitted
    allowed_qty:        float = 0.0        # qty actually permitted this step
    fallback_reason:    Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "requested_action": self.requested_action,
            "executed_action":  self.executed_action,
            "safety_override":  self.safety_override,
            "override_reason":  self.override_reason,
            "allowed_participation": self.allowed_participation,
            "allowed_qty":      self.allowed_qty,
            "fallback_reason":  self.fallback_reason,
        }


class SafetyLayer:
    """
    Deterministic constraint layer. Every RL action passes through here before
    it can affect the simulator. It can ONLY make an action safer (reduce
    aggressiveness / quantity), never more aggressive (spec §11, §54).
    """

    SAFE_EXECUTION = ExecutionAction.WAIT.value
    SAFE_MGMT      = TradeManagementAction.HOLD.value

    def __init__(self, track: str):
        self.track = track

    def apply(self, requested_action: str, ctx: MarketContext) -> SafetyDecision:
        actions = action_list(self.track)
        if requested_action not in actions:
            # unknown action → safest action + fallback
            safe = self.SAFE_EXECUTION if self.track == RLTrack.EXECUTION_OPTIMIZATION.value else self.SAFE_MGMT
            return SafetyDecision(requested_action, safe, True,
                                  "unknown_action", 0.0, 0.0, FallbackReason.RL_UNAVAILABLE.value)

        # Hard blocks → force the safe action
        if not ctx.market_open:
            return self._forced(requested_action, "market_closed", FallbackReason.MARKET_CLOSED.value)
        if ctx.contract_expired or not ctx.instrument_valid:
            return self._forced(requested_action, "instrument_invalid", FallbackReason.INSTRUMENT_INVALID.value)
        if ctx.risk_limit_breached:
            return self._forced(requested_action, "risk_limit_breached", FallbackReason.SAFETY_OVERRIDE.value)

        if self.track == RLTrack.EXECUTION_OPTIMIZATION.value:
            return self._apply_execution(requested_action, ctx)
        return self._apply_trade_mgmt(requested_action, ctx)

    def _forced(self, requested: str, reason: str, fallback: str) -> SafetyDecision:
        safe = self.SAFE_EXECUTION if self.track == RLTrack.EXECUTION_OPTIMIZATION.value else self.SAFE_MGMT
        override = (requested != safe)
        return SafetyDecision(requested, safe, override, reason if override else "",
                              0.0, 0.0, fallback if override else None)

    def _apply_execution(self, requested: str, ctx: MarketContext) -> SafetyDecision:
        target_part = EXECUTION_PARTICIPATION.get(requested, 0.0)
        # cap participation at the configured max (safety can only reduce)
        allowed_part = min(target_part, ctx.max_participation_pct) \
            if requested != ExecutionAction.WAIT.value else 0.0

        # translate to a quantity given ADV and remaining target
        if ctx.adv_inr and ctx.price > 0 and allowed_part > 0:
            max_qty_by_adv = (ctx.adv_inr * allowed_part) / ctx.price
        else:
            max_qty_by_adv = ctx.remaining_target_qty  # no ADV constraint info
        allowed_qty = max(0.0, min(ctx.remaining_target_qty, max_qty_by_adv, ctx.max_turnover_qty))
        # respect max position
        room = max(0.0, ctx.max_position_qty - ctx.current_position_qty)
        allowed_qty = min(allowed_qty, room)

        # F&O ban → cannot execute; force WAIT
        if ctx.fno_ban and requested != ExecutionAction.WAIT.value:
            return SafetyDecision(requested, ExecutionAction.WAIT.value, True,
                                  "fno_ban", 0.0, 0.0, FallbackReason.SAFETY_OVERRIDE.value)

        # if the requested action would exceed caps, it is downgraded but the
        # SAME action label is kept unless quantity is fully clipped to zero
        override = False
        reason = ""
        executed = requested
        if requested != ExecutionAction.WAIT.value and allowed_qty <= 0:
            executed = ExecutionAction.WAIT.value
            override = True
            reason = "no_executable_quantity"
        elif allowed_part < target_part:
            override = True
            reason = "participation_capped"

        return SafetyDecision(requested, executed, override, reason,
                              allowed_part, allowed_qty,
                              FallbackReason.SAFETY_OVERRIDE.value if override else None)

    def _apply_trade_mgmt(self, requested: str, ctx: MarketContext) -> SafetyDecision:
        reduce_frac = TRADE_MGMT_REDUCTION.get(requested, 0.0)
        if ctx.current_position_qty == 0 and requested != TradeManagementAction.HOLD.value:
            return SafetyDecision(requested, TradeManagementAction.HOLD.value, True,
                                  "no_position_to_manage", 0.0, 0.0,
                                  FallbackReason.SAFETY_OVERRIDE.value)
        allowed_qty = ctx.current_position_qty * reduce_frac
        return SafetyDecision(requested, requested, False, "", reduce_frac, allowed_qty, None)
