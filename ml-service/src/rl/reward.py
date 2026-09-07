"""
Phase 3L — Net-of-cost reward computation (spec §17, §18, §19, §21).

The reward reflects ACTUAL economics: realized net P&L minus transaction cost,
slippage, and impact, plus configurable risk penalties. It is NEVER raw price
change (spec §17). Transaction costs come from the Phase 3G cost model so the
agent cannot learn to over-trade for free (spec §18).

Reward weights are hyperparameters (versioned `RewardFunctionVersion`) and must
never be tuned on the final OOS (spec §37).

Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

from src.execution.cost_model import compute_trade_cost, DEFAULT_REGISTRY
from src.execution.schemas import InstrumentType, OrderSide, ProductType
from src.execution.slippage import SlippageModelRegistry

from .schemas import RewardFunctionVersion, RewardComponents


@dataclass
class StepEconomics:
    """
    Raw economic inputs for one execution/management step, produced by the
    environment from the Phase 3G simulator (spec §18, §21).
    """
    gross_pnl:          float = 0.0     # realized/mark-to-fill gross P&L this step (INR)
    executed_qty:       float = 0.0     # units traded this step (for cost)
    fill_price:         float = 0.0
    order_side:         str = OrderSide.BUY.value
    instrument_type:    str = InstrumentType.FUT_IDX.value
    product_type:       str = ProductType.NRML.value
    lot_size:           int = 1
    trade_date:         Optional[date] = None
    slippage_bps:       float = 0.0     # from Phase 3G slippage model
    impact_bps:         float = 0.0     # optional market-impact component
    # risk-state inputs
    drawdown:           float = 0.0     # current drawdown (INR, >=0)
    volatility:         float = 0.0
    inventory_deviation: float = 0.0    # |current - target| units
    turnover_qty:       float = 0.0     # units turned over this step
    risk_limit_hit:     bool = False


class RewardEngine:
    """
    Computes a per-step net-of-cost reward and its component ledger using the
    Phase 3G cost model. The reward function is versioned.
    """

    def __init__(self, reward_version: RewardFunctionVersion,
                 cost_registry=None,
                 risk_limit_penalty_inr: float = 0.0):
        self.rf = reward_version
        self.cost_registry = cost_registry or DEFAULT_REGISTRY
        self.risk_limit_penalty_inr = risk_limit_penalty_inr

    def compute(self, econ: StepEconomics) -> RewardComponents:
        """Return a fully-populated, reconcilable RewardComponents ledger."""
        rc = RewardComponents()
        rc.gross_pnl = float(econ.gross_pnl)

        # Transaction cost via Phase 3G (spec §18). Zero-qty step → zero cost.
        txn_cost = 0.0
        if econ.executed_qty > 0 and econ.fill_price > 0:
            lots = max(1, int(round(econ.executed_qty / max(1, econ.lot_size))))
            cb = compute_trade_cost(
                instrument_type=InstrumentType(econ.instrument_type),
                order_side=OrderSide(econ.order_side),
                product_type=ProductType(econ.product_type),
                trade_date=econ.trade_date or date(2023, 1, 2),
                price=econ.fill_price,
                quantity_lots=lots,
                lot_size=econ.lot_size,
                registry=self.cost_registry,
            )
            txn_cost = cb.total
        rc.transaction_cost = float(txn_cost)

        # Slippage / impact costs in INR from bps × traded notional.
        notional = econ.executed_qty * econ.fill_price
        rc.slippage_cost = float(econ.slippage_bps / 10_000.0 * notional)
        rc.impact_cost = float(econ.impact_bps / 10_000.0 * notional)

        # Risk-aware penalties (spec §19). Configurable, versioned.
        rf = self.rf
        rc.risk_penalty = float(
            rf.drawdown_penalty * econ.drawdown
            + rf.volatility_penalty * econ.volatility
            + (self.risk_limit_penalty_inr if econ.risk_limit_hit else 0.0)
            + (rf.risk_limit_penalty if econ.risk_limit_hit else 0.0)
        )
        rc.turnover_penalty = float(rf.turnover_penalty * econ.turnover_qty)
        rc.inventory_penalty = float(rf.inventory_penalty * econ.inventory_deviation)

        rc.compute_net(rf)
        return rc

    @staticmethod
    def slippage_bps_from_model(model_id: str, price: float, quantity_units: float,
                                **kwargs) -> float:
        """
        Get slippage bps from a Phase 3G slippage model (spec §13). Falls back to
        0 bps if the model id is unknown (documented, not silent — caller checks).
        """
        try:
            model = SlippageModelRegistry.get(model_id)
        except KeyError:
            return 0.0
        est = model.estimate(price=price, quantity_units=quantity_units, **kwargs)
        return float(est.slippage_bps)
