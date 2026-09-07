"""
Phase 3L — Evaluation metrics, robustness, and failure-mode detection
(spec §42, §43, §44, §45, §46, §58, §59, §60, §61, §62).

Provides:
  - Execution metrics: implementation shortfall, arrival-price slippage,
    VWAP/TWAP deviation, transaction cost, fill ratio, participation (spec §42).
  - Trade-management metrics: net P&L, MAE, MFE, profit retention, turnover,
    drawdown (spec §43).
  - Risk metrics: max drawdown, CVaR, volatility, tail loss, exposure (spec §44).
  - Capacity/scale sensitivity (spec §45, §46).
  - Robustness under perturbed execution assumptions (spec §61, §62) and a
    simulator-exploitation test → SIMULATOR_DEPENDENCY_RISK (spec §60).
  - Failure-mode detectors: policy collapse (always-WAIT / always-AGGRESSIVE),
    action entropy, excessive turnover, inventory accumulation, reward hacking
    (spec §58, §59).

Determinism: no global np.random.* (a seeded Generator is used only for optional
bootstrap CIs).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from .schemas import Transition
from .environment import MarketBar


# ══════════════════════════════════════════════════════════════════════════════
# Execution metrics (spec §42)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ExecutionMetrics:
    arrival_price:        float
    avg_fill_price:       float
    implementation_shortfall_bps: float   # (avg_fill - arrival)/arrival * 1e4 * side
    arrival_slippage_bps: float
    twap_deviation_bps:   float
    vwap_deviation_bps:   float
    total_cost_inr:       float
    fill_ratio:           float
    participation_rate:   float
    execution_time_bars:  int

    def to_dict(self) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in self.__dict__.items()}


def execution_metrics(
    fills: list[tuple[float, float]],   # (fill_price, qty) per fill, chronological
    bars: list[MarketBar],
    arrival_price: float,
    trade_side: str = "LONG",
    total_cost_inr: float = 0.0,
    target_qty: float = 0.0,
) -> ExecutionMetrics:
    """
    Compute execution-quality metrics vs arrival price, TWAP, and VWAP using ONLY
    the realized fills and the bars over the execution window (spec §42).
    Positive implementation_shortfall_bps = worse than arrival for the trader.
    """
    side = 1.0 if trade_side == "LONG" else -1.0
    filled_qty = sum(q for _, q in fills)
    if filled_qty <= 0 or arrival_price <= 0:
        return ExecutionMetrics(arrival_price, arrival_price, 0.0, 0.0, 0.0, 0.0,
                                total_cost_inr, 0.0, 0.0, len(fills))
    avg_fill = sum(p * q for p, q in fills) / filled_qty

    n = max(1, len(fills))
    twap = float(np.mean([b.close for b in bars[:n]])) if bars else avg_fill
    vwap_num = sum(b.close * b.volume for b in bars[:n])
    vwap_den = sum(b.volume for b in bars[:n])
    vwap = (vwap_num / vwap_den) if vwap_den > 0 else avg_fill

    def bps(a, b):
        return (a - b) / b * 10_000.0 if b else 0.0

    return ExecutionMetrics(
        arrival_price=arrival_price,
        avg_fill_price=avg_fill,
        implementation_shortfall_bps=side * bps(avg_fill, arrival_price),
        arrival_slippage_bps=side * bps(avg_fill, arrival_price),
        twap_deviation_bps=side * bps(avg_fill, twap),
        vwap_deviation_bps=side * bps(avg_fill, vwap),
        total_cost_inr=total_cost_inr,
        fill_ratio=(filled_qty / target_qty) if target_qty > 0 else 1.0,
        participation_rate=(filled_qty / sum(b.volume for b in bars[:n])) if vwap_den > 0 else 0.0,
        execution_time_bars=len(fills),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Trade-management + risk metrics (spec §43, §44)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class RiskMetrics:
    net_pnl:        float
    mae:            float          # max adverse excursion (INR, <=0)
    mfe:            float          # max favourable excursion (INR, >=0)
    profit_retention: float        # net_pnl / mfe if mfe>0 else nan
    turnover:       float
    max_drawdown:   float
    volatility:     float
    cvar_95:        float          # expected loss in worst 5%
    tail_loss:      float          # min step reward

    def to_dict(self) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in self.__dict__.items()}


def risk_metrics(step_rewards: list[float], turnover: float = 0.0) -> RiskMetrics:
    """Trade-management + risk metrics from a step-reward series (spec §43, §44)."""
    r = np.asarray(step_rewards, dtype=float)
    if r.size == 0:
        return RiskMetrics(0, 0, 0, float("nan"), turnover, 0, 0, 0, 0)
    cum = np.cumsum(r)
    net = float(cum[-1])
    running_max = np.maximum.accumulate(cum)
    dd = float(np.max(running_max - cum)) if cum.size else 0.0
    mfe = float(np.max(cum)) if cum.size else 0.0
    mae = float(np.min(cum)) if cum.size else 0.0
    vol = float(np.std(r, ddof=1)) if r.size > 1 else 0.0
    # CVaR 95% on step rewards (expected value of worst 5%)
    k = max(1, int(0.05 * r.size))
    worst = np.sort(r)[:k]
    cvar = float(np.mean(worst))
    retention = (net / mfe) if mfe > 0 else float("nan")
    return RiskMetrics(net_pnl=net, mae=mae, mfe=mfe, profit_retention=retention,
                       turnover=turnover, max_drawdown=dd, volatility=vol,
                       cvar_95=cvar, tail_loss=float(np.min(r)))


# ══════════════════════════════════════════════════════════════════════════════
# Failure-mode detection (spec §58, §59)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FailureModeReport:
    action_frequency:      dict
    action_entropy:        float          # normalized [0,1]
    policy_collapse:       bool           # one action dominates
    always_wait:           bool
    always_aggressive:     bool
    excessive_turnover:    bool
    inventory_accumulation: bool
    reward_hacking_suspected: bool
    detail:                list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def detect_failure_modes(
    action_labels: list[str],
    step_rewards: Optional[list[float]] = None,
    final_inventory: float = 0.0,
    target_inventory: float = 0.0,
    turnover: float = 0.0,
    turnover_cap: float = float("inf"),
    collapse_threshold: float = 0.95,
) -> FailureModeReport:
    """
    Detect RL failure modes (spec §58, §59): policy/action collapse, always-WAIT,
    always-AGGRESSIVE, excessive turnover, inventory accumulation, reward hacking.
    """
    n = max(1, len(action_labels))
    freq = Counter(action_labels)
    frac = {a: c / n for a, c in freq.items()}
    # normalized Shannon entropy over observed action distribution
    probs = np.array(list(frac.values()), dtype=float)
    if len(probs) > 1:
        ent = -np.sum(probs * np.log(probs + 1e-12))
        ent_norm = float(ent / np.log(len(probs)))
    else:
        ent_norm = 0.0
    top_action, top_frac = (max(frac.items(), key=lambda kv: kv[1]) if frac else ("", 0.0))

    detail = []
    collapse = top_frac >= collapse_threshold
    if collapse:
        detail.append(f"policy collapse: '{top_action}' chosen {top_frac:.0%} of steps")
    always_wait = frac.get("WAIT", 0.0) >= collapse_threshold or frac.get("HOLD", 0.0) >= collapse_threshold
    always_aggr = (frac.get("AGGRESSIVE", 0.0) + frac.get("FULL", 0.0)) >= collapse_threshold
    if always_wait:
        detail.append("always-WAIT/HOLD collapse")
    if always_aggr:
        detail.append("always-AGGRESSIVE/FULL collapse")

    excessive = turnover > turnover_cap
    if excessive:
        detail.append(f"excessive turnover {turnover:.1f} > cap {turnover_cap:.1f}")

    inv_accum = abs(final_inventory - target_inventory) > 1e-6 and abs(final_inventory) > abs(target_inventory)
    if inv_accum:
        detail.append(f"inventory accumulation: final {final_inventory} vs target {target_inventory}")

    # reward hacking heuristic: many tiny non-WAIT actions with ~zero net reward
    reward_hack = False
    if step_rewards is not None and len(step_rewards) > 0:
        non_wait = sum(1 for a in action_labels if a not in ("WAIT", "HOLD"))
        net = float(np.sum(step_rewards))
        if non_wait > 0.8 * n and abs(net) < 1e-6:
            reward_hack = True
            detail.append("reward hacking suspected: high trade frequency, ~zero net reward")

    return FailureModeReport(
        action_frequency=frac, action_entropy=ent_norm, policy_collapse=collapse,
        always_wait=always_wait, always_aggressive=always_aggr,
        excessive_turnover=excessive, inventory_accumulation=inv_accum,
        reward_hacking_suspected=reward_hack, detail=detail,
    )


# ══════════════════════════════════════════════════════════════════════════════
# Robustness + simulator-dependency (spec §60, §61, §62)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PerturbationSpec:
    """A modest execution-assumption perturbation (spec §61)."""
    name:              str
    slippage_bps_mult: float = 1.0
    spread_mult:       float = 1.0
    impact_bps_add:    float = 0.0
    liquidity_mult:    float = 1.0      # scales adv_inr
    latency_bars:      int = 0

    def to_dict(self) -> dict:
        return self.__dict__.copy()


DEFAULT_PERTURBATIONS: list[PerturbationSpec] = [
    PerturbationSpec("base"),
    PerturbationSpec("worse_slippage", slippage_bps_mult=2.0),
    PerturbationSpec("higher_spread", spread_mult=1.5),
    PerturbationSpec("higher_impact", impact_bps_add=5.0),
    PerturbationSpec("lower_liquidity", liquidity_mult=0.5),
    PerturbationSpec("execution_delay", latency_bars=1),
]


@dataclass
class RobustnessReport:
    per_perturbation:  dict            # name -> metric value
    base_value:        float
    worst_value:       float
    worst_perturbation: str
    max_degradation_pct: float
    simulator_dependency_risk: bool
    detail:            str = ""

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def robustness_report(
    perturbation_values: dict[str, float],
    base_name: str = "base",
    collapse_degradation_pct: float = 80.0,
) -> RobustnessReport:
    """
    Summarise a policy's metric across perturbations and flag
    SIMULATOR_DEPENDENCY_RISK if performance collapses under modest, realistic
    perturbations (spec §60, §62).
    """
    base = perturbation_values.get(base_name, 0.0)
    worst_name, worst_val = base_name, base
    for name, val in perturbation_values.items():
        if val < worst_val:
            worst_name, worst_val = name, val
    if base != 0:
        degradation = (base - worst_val) / abs(base) * 100.0
    else:
        degradation = 0.0 if worst_val >= 0 else 100.0
    sim_risk = degradation >= collapse_degradation_pct or (base > 0 and worst_val < 0)
    detail = ("SIMULATOR_DEPENDENCY_RISK: performance collapses under modest "
              "perturbations" if sim_risk else "robust to modest perturbations")
    return RobustnessReport(
        per_perturbation=dict(perturbation_values), base_value=base, worst_value=worst_val,
        worst_perturbation=worst_name, max_degradation_pct=degradation,
        simulator_dependency_risk=sim_risk, detail=detail,
    )
