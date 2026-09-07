"""
Phase 3M — Shadow execution engine (spec §10, §11).

Turns an EXECUTION_PLANNED decision into a hypothetical order + fill using the
ONE Phase 3G execution simulator, reached through the Phase 3L `SimulatorBridge`
(which wraps `BacktestEngine` + the real cost/slippage models). There is NO
second fill simulator here (spec §11).

The engine NEVER connects to a broker (spec §10, §23). It:
  1. builds a ShadowOrder from the decision,
  2. records it in the immutable ledger (idempotent — exactly-once per decision),
  3. runs the decision through the Phase 3G simulator,
  4. maps the realized ledger trade into a ShadowFill (costs + slippage + pnl),
  5. records the fill + completion.

Determinism: pure stdlib + reused numpy execution; no np.random.*.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from src.decision.provenance import assert_not_live
from src.decision.schema import CanonicalDecision
from src.decision.state import DecisionState

from .shadow_order import ShadowOrder, ShadowMode
from .shadow_fill import ShadowFill, ShadowFillStatus
from .shadow_ledger import ShadowLedger

UTC = timezone.utc


class ShadowExecutionEngine:
    """
    Executes a decision in shadow/paper mode via the Phase 3G simulator.

    `market_bars`: the PIT bars for the instrument (list of `rl.MarketBar`), so
    the engine can hand them to the Phase 3G `BacktestEngine` via the bridge.
    """

    def __init__(self, ledger: ShadowLedger):
        self.ledger = ledger

    def execute(
        self,
        decision: CanonicalDecision,
        market_bars,                      # list[rl.environment.MarketBar]
        mode: str = ShadowMode.SHADOW.value,
        lot_size: int = 1,
        instrument_type: str = "FUT_IDX",
        stop_price: Optional[float] = None,
        target_price: Optional[float] = None,
    ) -> dict:
        """
        Run shadow/paper execution. Returns a dict with the order, fill, and
        whether execution actually occurred (idempotency-aware). NEVER a broker.
        """
        assert_not_live(mode)     # fail closed on live

        # Only EXECUTION_PLANNED decisions are shadow-executed (fail-closed).
        if decision.state != DecisionState.EXECUTION_PLANNED:
            return {"executed": False, "reason": f"decision not EXECUTION_PLANNED "
                    f"(state={decision.decision_state})", "order": None, "fill": None}

        side = "BUY" if (decision.direction or "LONG").upper() == "LONG" else "SELL"
        order = ShadowOrder(
            order_id=ShadowOrder.new_id(),
            decision_id=decision.decision_id,
            instrument=decision.instrument,
            side=side,
            quantity=float(decision.position_size or 1.0),
            target_price=target_price,
            signal_timestamp=decision.decision_timestamp,
            order_timestamp=datetime.now(UTC).isoformat(),
            mode=mode,
            execution_policy=decision.execution_policy or "",
            execution_policy_version=decision.execution_policy_version or "",
            rl_policy_id=decision.rl_policy_id or "",
            rl_action=decision.rl_action or "",
            lot_size=lot_size,
            instrument_type=instrument_type,
            data_snapshot_id=decision.data_snapshot_id,
            model_ids=list(decision.model_ids),
            feature_version=decision.feature_version,
            market_regime=decision.market_regime,
        )

        created, existing = self.ledger.record_order(order)
        if not created:
            # idempotent: decision already shadow-executed — no duplicate
            return {"executed": False, "reason": "duplicate decision (idempotent)",
                    "order": existing, "fill": None}

        fill = self._simulate_fill(order, decision, market_bars, stop_price, target_price)
        self.ledger.record_fill(fill)
        self.ledger.complete_order(order.order_id, decision.decision_id,
                                   {"status": fill.status})
        return {"executed": True, "order": order.to_dict(), "fill": fill.to_dict()}

    def _simulate_fill(self, order: ShadowOrder, decision: CanonicalDecision,
                       market_bars, stop_price, target_price) -> ShadowFill:
        """Run the decision through the Phase 3G simulator (reused, not forked)."""
        # Lazy import to keep module import-clean and avoid heavy deps at load.
        from src.rl.simulator_bridge import SimulatorBridge, make_decision, market_bars_to_ohlc
        from src.execution.backtest_engine import BacktestConfig
        from src.execution.schemas import TradeSide, InstrumentType, ProductType

        cfg = BacktestConfig(backtest_id=f"shadow-{decision.decision_id}")
        bridge = SimulatorBridge(cfg)

        if not market_bars or len(market_bars) < 2:
            return ShadowFill(
                fill_id=ShadowFill.new_id(), order_id=order.order_id,
                decision_id=decision.decision_id, instrument=order.instrument,
                side=order.side, status=ShadowFillStatus.UNAVAILABLE.value,
                target_price=order.target_price, assumed_execution_price=None,
                quantity_filled=0.0, simulator_version=bridge.simulator_version().version_id,
            )

        try:
            it = InstrumentType(order.instrument_type)
        except Exception:
            it = InstrumentType.FUT_IDX
        trade_side = TradeSide.LONG if order.side == "BUY" else TradeSide.SHORT
        ohlc = market_bars_to_ohlc(market_bars)
        dec = make_decision(
            instrument_id=order.instrument, signal_time=market_bars[0].timestamp,
            trade_side=trade_side, horizon_bars=order.horizon_bars,
            stop_price_hint=stop_price, target_price_hint=target_price,
            instrument_type=it, product_type=ProductType.NRML, lot_size=order.lot_size,
            model_id=(order.model_ids[0] if order.model_ids else "decision"),
        )
        res = bridge.run_decisions([dec], {order.instrument: ohlc})

        if res.n_trades == 0 or not res.trades:
            status = (ShadowFillStatus.REJECTED.value if res.n_rejected
                      else ShadowFillStatus.UNAVAILABLE.value)
            return ShadowFill(
                fill_id=ShadowFill.new_id(), order_id=order.order_id,
                decision_id=decision.decision_id, instrument=order.instrument,
                side=order.side, status=status,
                target_price=order.target_price, assumed_execution_price=None,
                quantity_filled=0.0, simulator_version=res.simulator_version,
                pnl_reconciled=res.pnl_reconciled,
            )

        trade = res.trades[0]
        return ShadowFill(
            fill_id=ShadowFill.new_id(),
            order_id=order.order_id,
            decision_id=decision.decision_id,
            instrument=order.instrument,
            side=order.side,
            status=ShadowFillStatus.FULL.value,
            target_price=order.target_price,
            assumed_execution_price=float(trade.entry_price),
            quantity_filled=float(trade.quantity_lots * trade.lot_size),
            slippage=float(getattr(trade.entry_cost, "slippage_cost", 0.0)
                           + getattr(trade.exit_cost, "slippage_cost", 0.0)),
            fees=float(trade.entry_cost.brokerage + trade.exit_cost.brokerage),
            taxes=float(trade.entry_cost.stt + trade.exit_cost.stt),
            total_cost=float(trade.total_cost),
            realized_pnl=float(trade.net_pnl),
            unrealized_pnl=0.0,
            execution_policy=order.execution_policy,
            execution_policy_version=order.execution_policy_version,
            rl_policy_id=order.rl_policy_id,
            rl_action=order.rl_action,
            market_regime=order.market_regime,
            data_snapshot_id=order.data_snapshot_id,
            model_ids=list(order.model_ids),
            feature_version=order.feature_version,
            simulator_version=res.simulator_version,
            pnl_reconciled=res.pnl_reconciled,
            fill_timestamp=datetime.now(UTC).isoformat(),
        )
