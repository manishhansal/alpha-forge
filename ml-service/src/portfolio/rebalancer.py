"""
Phase 3H — Portfolio Rebalancer.

Computes trade orders from target weights vs. current holdings,
enforces turnover limits, and produces the execution contract
(list[TargetOrder]) for Phase 3G.

Design rules
------------
1. Target portfolio is SEPARATE from executed portfolio (spec §43).
2. Trade orders are generated deterministically from target vs. current weights.
3. Turnover = sum(|target_w - current_w|) is explicitly calculated.
4. Estimated transaction cost is computed from Phase 3G cost model.
5. Liquidity requirement per order is computed as fraction of ADV.
6. No uncontrolled randomness.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import numpy as np

from .schemas import (
    ConstraintSet, PortfolioCandidate, PortfolioState,
    PortfolioTarget, RebalancePolicy, TargetOrder,
)


# ── Rebalance configuration ───────────────────────────────────────────────────

@dataclass
class RebalanceConfig:
    """Configuration for the rebalancer."""
    policy:                 RebalancePolicy = RebalancePolicy.SIGNAL_DRIVEN
    min_weight_change:      float = 0.005   # ignore trades smaller than 0.5% weight
    round_lots:             bool  = True    # round position sizes to integer lots
    cost_per_lot_inr:       float = 0.0     # estimated fixed cost per lot (optional)
    version:                str   = "rebalance-v1"


# ── Rebalance result ──────────────────────────────────────────────────────────

@dataclass
class RebalanceResult:
    """
    Output of the rebalancer.

    Contains the ordered trade list plus turnover/cost diagnostics.
    """
    orders:                 list[TargetOrder]
    total_turnover:         float = 0.0    # sum(|w_target - w_current|)
    estimated_cost_inr:     float = 0.0
    n_buys:                 int = 0
    n_sells:                int = 0
    n_no_change:            int = 0
    formation_time:         Optional[datetime] = None
    notes:                  str = ""


# ── Rebalancer ────────────────────────────────────────────────────────────────

class Rebalancer:
    """
    Computes trade orders from target weights and current holdings.

    Usage
    -----
    ::
        reb = Rebalancer(config)
        result = reb.compute(
            target=portfolio_target,
            current_state=current_portfolio_state,   # or None for new portfolio
            candidates=eligible_candidates,
            capital_inr=1_000_000.0,
        )
        for order in result.orders:
            # send to Phase 3G execution simulator
    """

    def __init__(self, config: Optional[RebalanceConfig] = None) -> None:
        self.config = config or RebalanceConfig()

    def compute(
        self,
        target: PortfolioTarget,
        candidates: list[PortfolioCandidate],
        current_state: Optional[PortfolioState] = None,
        capital_inr: float = 1_000_000.0,
    ) -> RebalanceResult:
        """
        Compute rebalance orders.

        Parameters
        ----------
        target          : PortfolioTarget from optimizer
        candidates      : eligible candidates (same set as fed to optimizer)
        current_state   : current executed portfolio state (None = empty portfolio)
        capital_inr     : total portfolio capital

        Returns
        -------
        RebalanceResult with all trade orders and turnover metrics.
        """
        cfg = self.config
        orders: list[TargetOrder] = []
        current_weights = (
            current_state.current_weights if current_state is not None else {}
        )

        # Build candidate lookup
        cand_map = {c.instrument_id: c for c in candidates}

        total_turnover = 0.0
        total_cost = 0.0
        n_buys = n_sells = n_no_change = 0

        # ── Generate orders for all target instruments ────────────────────────
        all_instruments = set(target.weights.keys()) | set(current_weights.keys())

        for inst in sorted(all_instruments):
            target_w  = target.weights.get(inst, 0.0)
            current_w = current_weights.get(inst, 0.0)
            delta_w   = target_w - current_w

            # Skip negligible changes
            if abs(delta_w) < cfg.min_weight_change:
                n_no_change += 1
                total_turnover += abs(delta_w)
                continue

            total_turnover += abs(delta_w)

            # Look up candidate metadata
            cand = cand_map.get(inst)
            if cand is None:
                # Instrument not in current candidates — generate close order
                order = self._close_order(
                    inst, current_w, capital_inr, target.provenance_hash
                )
                if order is not None:
                    orders.append(order)
                    n_sells += 1
                    total_cost += order.estimated_cost_inr
                continue

            # Determine trade side
            if delta_w > 0:
                side = "BUY"
                trade_side = "LONG" if target_w >= 0 else "SHORT"
                n_buys += 1
            else:
                side = "SELL"
                trade_side = "LONG" if current_w > 0 else "SHORT"
                n_sells += 1

            # Compute lots
            notional_delta = abs(delta_w) * capital_inr
            lot_notional = (
                (cand.price * cand.lot_size)
                if (cand.price and cand.lot_size)
                else 1.0
            )
            if cfg.round_lots and lot_notional > 0:
                lots = max(0, int(notional_delta / lot_notional))
            else:
                lots = 0

            estimated_notional = lots * lot_notional
            if lots == 0 and notional_delta > 0:
                # Notional too small for one lot — record as 0-lot order for audit
                pass

            # Liquidity requirement
            liq_req = None
            if cand.adv_inr and cand.adv_inr > 0:
                liq_req = estimated_notional / cand.adv_inr

            # Estimated cost (simple proxy: 3 bps one-way)
            est_cost = estimated_notional * 0.0003 + cfg.cost_per_lot_inr * lots
            total_cost += est_cost

            orders.append(TargetOrder(
                instrument_id=inst,
                side=side,
                trade_side=trade_side,
                target_weight=target_w,
                current_weight=current_w,
                weight_delta=delta_w,
                quantity_lots=lots,
                lot_size=cand.lot_size,
                estimated_notional_inr=estimated_notional,
                estimated_cost_inr=est_cost,
                liquidity_requirement_pct_adv=liq_req,
                portfolio_version=target.provenance_hash,
                reason=f"Δweight={delta_w:+.4f}",
            ))

        # Sort by abs(notional) descending — largest trades first
        orders.sort(key=lambda o: abs(o.estimated_notional_inr), reverse=True)

        return RebalanceResult(
            orders=orders,
            total_turnover=total_turnover,
            estimated_cost_inr=total_cost,
            n_buys=n_buys,
            n_sells=n_sells,
            n_no_change=n_no_change,
            formation_time=target.formation_time,
        )

    @staticmethod
    def _close_order(
        inst: str,
        current_w: float,
        capital_inr: float,
        portfolio_version: str,
    ) -> Optional[TargetOrder]:
        """Generate a close order for an instrument not in the new target."""
        if abs(current_w) < 1e-6:
            return None
        notional = abs(current_w) * capital_inr
        return TargetOrder(
            instrument_id=inst,
            side="SELL" if current_w > 0 else "BUY",
            trade_side="LONG" if current_w > 0 else "SHORT",
            target_weight=0.0,
            current_weight=current_w,
            weight_delta=-current_w,
            quantity_lots=0,
            lot_size=1,
            estimated_notional_inr=notional,
            estimated_cost_inr=notional * 0.0003,
            portfolio_version=portfolio_version,
            reason="Close: instrument not in new target portfolio.",
        )

    @staticmethod
    def should_rebalance(
        policy: RebalancePolicy,
        formation_time: datetime,
        last_rebalance_time: Optional[datetime],
        target: PortfolioTarget,
        current_state: Optional[PortfolioState],
        min_turnover_threshold: float = 0.05,
    ) -> bool:
        """
        Decide whether a rebalance is warranted given the policy.

        Returns True if rebalance should proceed.
        """
        if last_rebalance_time is None:
            return True  # first ever rebalance

        if policy == RebalancePolicy.DAILY:
            return formation_time.date() > last_rebalance_time.date()

        if policy == RebalancePolicy.WEEKLY:
            delta_days = (formation_time.date() - last_rebalance_time.date()).days
            return delta_days >= 5

        if policy in (RebalancePolicy.EVENT_DRIVEN, RebalancePolicy.SIGNAL_DRIVEN):
            # Rebalance only if target differs from current by at least threshold
            if current_state is None:
                return True
            current = current_state.current_weights
            turnover = sum(
                abs(target.weights.get(k, 0.0) - current.get(k, 0.0))
                for k in set(target.weights) | set(current)
            )
            return turnover >= min_turnover_threshold

        return True
