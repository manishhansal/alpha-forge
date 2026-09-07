"""
Phase 3L — Causal, deterministic, replayable RL execution environment
(spec §6, §7, §8, §9, §15, §16, §52, §56, §57).

The environment is:
  - CAUSAL: the observation at time t uses ONLY data available at or before t.
    Only next_state and reward may use the bar that follows t (spec §15, §16).
  - DETERMINISTIC under a fixed seed (no global np.random.*; spec §6).
  - REPLAYABLE: identical episode_id + seed + market data → identical trajectory
    (spec §57).
  - VERSIONED: references an EnvironmentVersion (spec §74).

It is EVENT-DRIVEN over a pre-supplied list of PIT market bars (spec §7). Each
bar is a market event; the agent chooses an action; the safety layer filters it;
the environment advances to the next bar and computes a net-of-cost reward.

Two tracks (spec §4) share the machinery:
  - EXECUTION_OPTIMIZATION: execute a target quantity by a deadline.
  - TRADE_MANAGEMENT: manage an already-open position (hold/reduce/exit).

A gymnasium-compatible façade is exposed behind a capability check; the core is
pure NumPy and does not require gymnasium.

Determinism: no np.random.* (a seeded numpy.random.Generator is used only for
optional domain-randomization perturbations, never for core transitions).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

import numpy as np

from src.execution.schemas import InstrumentType, OrderSide, ProductType, TradeSide

from .schemas import (
    RLTrack, ExecutionAction, TradeManagementAction, EnvironmentVersion,
    RewardFunctionVersion, ObservationSchema, ActionSchema, ExecutionSimulatorVersion,
    RewardComponents,
)
from .actions import (
    action_list, valid_action_mask, SafetyLayer, MarketContext,
    EXECUTION_PARTICIPATION, TRADE_MGMT_REDUCTION,
)
from .reward import RewardEngine, StepEconomics


# Canonical observation fields (PIT — none reference the future; spec §8).
EXECUTION_OBS_FIELDS: tuple[str, ...] = (
    "position_qty", "remaining_target_qty", "fraction_target_remaining",
    "time_remaining_frac", "current_price_norm", "unrealized_pnl_norm",
    "spread_proxy_bps", "adv_participation_cap", "volatility_norm",
    "inventory_deviation_norm",
)
TRADE_MGMT_OBS_FIELDS: tuple[str, ...] = (
    "position_qty_norm", "unrealized_pnl_norm", "mae_norm", "mfe_norm",
    "holding_frac", "current_price_norm", "volatility_norm", "drawdown_norm",
)


@dataclass
class MarketBar:
    """A single PIT market event (mirrors the fields the env needs from OHLCBar)."""
    timestamp:  datetime
    open:       float
    high:       float
    low:        float
    close:      float
    volume:     float
    adv_inr:    Optional[float] = None
    atr_pct:    Optional[float] = None
    fno_ban:    bool = False


@dataclass
class EpisodeConfig:
    """Explicit episode boundaries + instrument context (spec §22, §23)."""
    episode_id:        str
    instrument:        str
    track:             str = RLTrack.EXECUTION_OPTIMIZATION.value
    target_qty:        float = 100.0          # execution track: qty to fill
    initial_position:  float = 0.0            # trade-mgmt track: starting position
    trade_side:        str = TradeSide.LONG.value
    deadline_bars:     int = 10               # execution deadline
    lot_size:          int = 1
    instrument_type:   str = InstrumentType.FUT_IDX.value
    product_type:      str = ProductType.NRML.value
    max_position_qty:  float = 1e9
    max_participation_pct: float = 0.10
    seed:              int = 1337


@dataclass
class StepRecord:
    """Audit record for one env step (spec §55)."""
    step:               int
    timestamp:          str
    state_hash:         str
    action_requested:   str
    action_executed:    str
    safety_override:    bool
    override_reason:    str
    reward:             float
    reward_components:  dict
    done:               bool

    def to_dict(self) -> dict:
        return {
            "step": self.step, "timestamp": self.timestamp, "state_hash": self.state_hash,
            "action_requested": self.action_requested, "action_executed": self.action_executed,
            "safety_override": self.safety_override, "override_reason": self.override_reason,
            "reward": self.reward, "reward_components": self.reward_components, "done": self.done,
        }


class ExecutionEnv:
    """
    Causal execution / trade-management environment.

    Usage:
        env = ExecutionEnv(bars, episode_cfg, reward_version, ...)
        obs, info = env.reset()
        while not done:
            mask = env.action_mask()
            action = policy(obs, mask)
            obs, reward, terminated, truncated, info = env.step(action)
    """

    def __init__(
        self,
        bars: list[MarketBar],
        episode: EpisodeConfig,
        reward_version: Optional[RewardFunctionVersion] = None,
        simulator_version: Optional[ExecutionSimulatorVersion] = None,
        slippage_bps: float = 5.0,
        cost_registry=None,
    ):
        if len(bars) < 2:
            raise ValueError("ExecutionEnv requires >= 2 bars (need a next bar for transitions).")
        self.bars = bars
        self.ep = episode
        self.track = episode.track
        self.rf = reward_version or RewardFunctionVersion()
        self.sim_version = simulator_version or ExecutionSimulatorVersion()
        self.slippage_bps = slippage_bps
        self.reward_engine = RewardEngine(self.rf, cost_registry=cost_registry)
        self.safety = SafetyLayer(self.track)

        self.obs_fields = (EXECUTION_OBS_FIELDS
                           if self.track == RLTrack.EXECUTION_OPTIMIZATION.value
                           else TRADE_MGMT_OBS_FIELDS)
        self.actions = action_list(self.track)

        # deterministic RNG (only for optional perturbations; never core transitions)
        self._rng = np.random.default_rng(episode.seed)

        # episode state
        self.t = 0
        self.position_qty = 0.0
        self.remaining_target = 0.0
        self.entry_price = 0.0
        self.peak_pnl = 0.0
        self.trough_pnl = 0.0
        self.done = False
        self.step_log: list[StepRecord] = []

    # ── versioning ───────────────────────────────────────────────────────

    def environment_version(self) -> EnvironmentVersion:
        obs_schema = ObservationSchema(fields=self.obs_fields)
        act_schema = ActionSchema(track=self.track, actions=tuple(self.actions))
        return EnvironmentVersion(
            observation_schema_id=obs_schema.version_id,
            action_schema_id=act_schema.version_id,
            reward_version_id=self.rf.version_id,
            simulator_version_id=self.sim_version.version_id,
        )

    # ── reset ────────────────────────────────────────────────────────────

    def reset(self, seed: Optional[int] = None):
        if seed is not None:
            self._rng = np.random.default_rng(seed)
        self.t = 0
        self.done = False
        self.step_log = []
        if self.track == RLTrack.EXECUTION_OPTIMIZATION.value:
            self.position_qty = 0.0
            self.remaining_target = self.ep.target_qty
        else:
            self.position_qty = self.ep.initial_position
            self.remaining_target = 0.0
        self.entry_price = self.bars[0].close
        self.peak_pnl = 0.0
        self.trough_pnl = 0.0
        obs = self._observation()
        return obs, {"state_hash": self.state_hash()}

    # ── observation (CAUSAL — only data up to self.t; spec §8, §15) ───────

    def _current_bar(self) -> MarketBar:
        return self.bars[self.t]

    def _observation(self) -> np.ndarray:
        bar = self._current_bar()             # bar at time t (available now)
        price = bar.close
        # normalisers use ONLY the current + past; never the next bar.
        base = self.bars[0].close or 1.0
        px_norm = (price - base) / base
        direction = 1.0 if self.ep.trade_side == TradeSide.LONG.value else -1.0
        unreal = direction * (price - self.entry_price) * self.position_qty
        unreal_norm = unreal / (base * max(1.0, abs(self.ep.target_qty)))
        spread_bps = (abs(bar.high - bar.low) / price * 10_000.0) if price > 0 else 0.0
        adv_cap = self.ep.max_participation_pct
        vol = bar.atr_pct if bar.atr_pct is not None else spread_bps / 10_000.0

        if self.track == RLTrack.EXECUTION_OPTIMIZATION.value:
            frac_remaining = (self.remaining_target / self.ep.target_qty
                              if self.ep.target_qty else 0.0)
            time_remaining = max(0.0, (self.ep.deadline_bars - self.t) / self.ep.deadline_bars) \
                if self.ep.deadline_bars else 0.0
            inv_dev = abs(self.remaining_target) / max(1.0, self.ep.target_qty)
            vec = [
                self.position_qty / max(1.0, self.ep.target_qty),
                self.remaining_target / max(1.0, self.ep.target_qty),
                frac_remaining,
                time_remaining,
                px_norm,
                unreal_norm,
                spread_bps,
                adv_cap,
                float(vol),
                inv_dev,
            ]
        else:
            holding_frac = self.t / max(1, len(self.bars) - 1)
            mae_norm = self.trough_pnl / (base * max(1.0, abs(self.position_qty) or 1.0))
            mfe_norm = self.peak_pnl / (base * max(1.0, abs(self.position_qty) or 1.0))
            dd = (self.peak_pnl - unreal)
            dd_norm = dd / (base * max(1.0, abs(self.position_qty) or 1.0))
            vec = [
                self.position_qty / max(1.0, abs(self.ep.initial_position) or 1.0),
                unreal_norm,
                mae_norm,
                mfe_norm,
                holding_frac,
                px_norm,
                float(vol),
                dd_norm,
            ]
        return np.asarray(vec, dtype=float)

    # ── state hash (spec §56) ─────────────────────────────────────────────

    def state_hash(self) -> str:
        key = {
            "t": self.t,
            "position_qty": round(self.position_qty, 8),
            "remaining_target": round(self.remaining_target, 8),
            "entry_price": round(self.entry_price, 8),
            "obs": [round(float(x), 8) for x in self._observation().tolist()],
            "env_version": self.environment_version().version_id,
        }
        raw = json.dumps(key, sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    # ── market context for safety/mask (PIT) ──────────────────────────────

    def _market_context(self) -> MarketContext:
        bar = self._current_bar()
        return MarketContext(
            market_open=True,
            contract_expired=False,
            fno_ban=bar.fno_ban,
            instrument_valid=True,
            liquidity_available=(bar.volume > 0),
            adv_inr=bar.adv_inr,
            remaining_target_qty=self.remaining_target,
            current_position_qty=self.position_qty,
            max_position_qty=self.ep.max_position_qty,
            max_participation_pct=self.ep.max_participation_pct,
            max_turnover_qty=self.ep.target_qty if self.ep.target_qty else 1e18,
            price=bar.close,
        )

    def action_mask(self) -> list[bool]:
        return valid_action_mask(self.track, self._market_context())

    # ── step (transition uses the NEXT bar for reward; spec §15, §16) ─────

    def step(self, action):
        if self.done:
            raise RuntimeError("step() called on a finished episode; call reset().")
        actions = self.actions
        if isinstance(action, (int, np.integer)):
            action_label = actions[int(action)]
        else:
            action_label = str(action)

        ctx = self._market_context()
        state_hash = self.state_hash()
        decision = self.safety.apply(action_label, ctx)

        cur_bar = self._current_bar()
        next_bar = self.bars[self.t + 1] if self.t + 1 < len(self.bars) else cur_bar

        # execute the safety-approved action; economics use the NEXT bar's fill
        econ = self._apply_and_price(decision, cur_bar, next_bar)
        rc: RewardComponents = self.reward_engine.compute(econ)

        # advance time
        self.t += 1
        terminated, truncated = self._check_termination()
        self.done = terminated or truncated

        rec = StepRecord(
            step=self.t, timestamp=next_bar.timestamp.isoformat(), state_hash=state_hash,
            action_requested=decision.requested_action, action_executed=decision.executed_action,
            safety_override=decision.safety_override, override_reason=decision.override_reason,
            reward=rc.net_reward, reward_components=rc.to_dict(), done=self.done,
        )
        self.step_log.append(rec)

        obs = self._observation()
        info = {
            "state_hash": state_hash,
            "safety": decision.to_dict(),
            "reward_components": rc.to_dict(),
        }
        return obs, rc.net_reward, terminated, truncated, info

    def _apply_and_price(self, decision, cur_bar: MarketBar, next_bar: MarketBar) -> StepEconomics:
        """
        Apply the executed action and compute step economics using the NEXT bar
        as the fill reference (causal: decision at t, fill at t+1). Net-of-cost.
        """
        fill_price = next_bar.open if next_bar is not cur_bar else cur_bar.close
        direction = 1.0 if self.ep.trade_side == TradeSide.LONG.value else -1.0
        qty = decision.allowed_qty
        side = OrderSide.BUY.value if direction > 0 else OrderSide.SELL.value

        gross_pnl = 0.0
        turnover = 0.0
        if self.track == RLTrack.EXECUTION_OPTIMIZATION.value:
            if qty > 0:
                self.position_qty += qty
                self.remaining_target = max(0.0, self.remaining_target - qty)
                turnover = qty
                if self.position_qty > 0:
                    self.entry_price = fill_price  # simplistic running entry
            # mark-to-next-close gross P&L on held inventory
            gross_pnl = direction * (next_bar.close - fill_price) * self.position_qty
        else:  # TRADE_MANAGEMENT
            reduce_qty = decision.allowed_qty
            if reduce_qty > 0:
                # realize P&L on the reduced quantity
                gross_pnl = direction * (fill_price - self.entry_price) * reduce_qty
                self.position_qty = max(0.0, self.position_qty - reduce_qty)
                turnover = reduce_qty
            else:
                gross_pnl = direction * (next_bar.close - cur_bar.close) * self.position_qty

        # track peak/trough for MAE/MFE and drawdown
        self.peak_pnl = max(self.peak_pnl, gross_pnl)
        self.trough_pnl = min(self.trough_pnl, gross_pnl)
        drawdown = max(0.0, self.peak_pnl - gross_pnl)

        return StepEconomics(
            gross_pnl=gross_pnl,
            executed_qty=turnover,
            fill_price=fill_price,
            order_side=side,
            instrument_type=self.ep.instrument_type,
            product_type=self.ep.product_type,
            lot_size=self.ep.lot_size,
            trade_date=next_bar.timestamp.date() if isinstance(next_bar.timestamp, datetime) else None,
            slippage_bps=self.slippage_bps if turnover > 0 else 0.0,
            drawdown=drawdown,
            inventory_deviation=abs(self.remaining_target),
            turnover_qty=turnover,
        )

    def _check_termination(self) -> tuple[bool, bool]:
        """Termination rules (spec §52)."""
        terminated = False
        truncated = False
        # target executed
        if self.track == RLTrack.EXECUTION_OPTIMIZATION.value and self.remaining_target <= 0:
            terminated = True
        # position fully exited
        if self.track == RLTrack.TRADE_MANAGEMENT.value and self.position_qty <= 0:
            terminated = True
        # deadline reached (execution)
        if (self.track == RLTrack.EXECUTION_OPTIMIZATION.value
                and self.t >= self.ep.deadline_bars):
            terminated = True
        # ran out of bars (market close / end of data)
        if self.t >= len(self.bars) - 1:
            truncated = True
        return terminated, truncated

    # ── replay (spec §57) ─────────────────────────────────────────────────

    def replay_log(self) -> list[dict]:
        """Reconstruct the recorded trajectory without modifying it."""
        return [r.to_dict() for r in self.step_log]


# ══════════════════════════════════════════════════════════════════════════════
# Gymnasium capability check (spec §6 — optional façade)
# ══════════════════════════════════════════════════════════════════════════════

def gymnasium_available() -> bool:
    try:
        import gymnasium  # noqa: F401
        return True
    except Exception:
        return False
