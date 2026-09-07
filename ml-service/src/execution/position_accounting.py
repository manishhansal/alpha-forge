"""
Phase 3G — Position Accounting and Trade Ledger.

Maintains position state, P&L, and turnover across a backtest.
Every completed round-trip trade is verified for P&L reconciliation.

Accounting invariants (spec §21)
--------------------------------
net_pnl  = gross_pnl - total_cost
gross_pnl = (exit_price - entry_price) × qty × lot_size × direction_sign

Turnover (spec §24)
-------------------
Every fill contributes to gross turnover = fill_price × filled_qty × lot_size.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from .cost_model import (
    CostScheduleRegistry, DEFAULT_REGISTRY, compute_trade_cost,
)
from .schemas import (
    CostBreakdown, ExecutionDataLevel, ExecutionLedger, FillStatus,
    InstrumentType, OrderSide, ProductType, SimulatedFill,
    TradeRecord, TradeSide, make_trade_id,
)


# ── Open position ─────────────────────────────────────────────────────────────

@dataclass
class Position:
    """
    An open position — awaiting exit fill.
    Tracks entry details and current P&L.
    """
    position_id:    str
    instrument_id:  str
    instrument_type: InstrumentType
    product_type:   ProductType
    trade_side:     TradeSide
    quantity_lots:  int
    lot_size:       int
    entry_price:    float
    entry_fill:     SimulatedFill
    entry_cost:     CostBreakdown
    entry_time:     datetime
    bars_held:      int = 0

    @property
    def entry_notional(self) -> float:
        return self.entry_price * self.quantity_lots * self.lot_size

    def unrealized_pnl(self, current_price: float) -> float:
        direction = 1 if self.trade_side == TradeSide.LONG else -1
        return direction * (current_price - self.entry_price) * self.quantity_lots * self.lot_size

    def unrealized_pnl_pct(self, current_price: float) -> Optional[float]:
        if self.entry_notional <= 0:
            return None
        return self.unrealized_pnl(current_price) / self.entry_notional * 100.0


# ── Portfolio state ────────────────────────────────────────────────────────────

@dataclass
class PortfolioState:
    """
    Current portfolio state at any point in the backtest.
    """
    timestamp:            datetime
    cash_inr:             float          # available cash
    open_positions:       dict[str, Position] = field(default_factory=dict)
    total_margin_used_inr: float = 0.0   # placeholder (margin model not implemented)

    @property
    def total_unrealized_pnl(self) -> float:
        # No mark-to-market without current prices; return 0
        return 0.0

    @property
    def n_open_positions(self) -> int:
        return len(self.open_positions)

    @property
    def gross_notional(self) -> float:
        return sum(p.entry_notional for p in self.open_positions.values())

    def add_position(self, pos: Position) -> None:
        self.open_positions[pos.position_id] = pos

    def remove_position(self, position_id: str) -> Optional[Position]:
        return self.open_positions.pop(position_id, None)


# ── Turnover tracker ─────────────────────────────────────────────────────────

@dataclass
class TurnoverStats:
    """Running turnover statistics."""
    gross_turnover_inr:  float = 0.0   # buy + sell turnover
    buy_turnover_inr:    float = 0.0
    sell_turnover_inr:   float = 0.0
    n_trades:            int   = 0
    total_holding_bars:  int   = 0

    def record_fill(self, fill: SimulatedFill, lot_size: int) -> None:
        if not fill.filled or fill.fill_price is None:
            return
        value = fill.fill_price * fill.quantity_filled_lots * lot_size
        self.gross_turnover_inr += value
        if fill.order_side == OrderSide.BUY:
            self.buy_turnover_inr += value
        else:
            self.sell_turnover_inr += value

    @property
    def avg_holding_bars(self) -> Optional[float]:
        return self.total_holding_bars / self.n_trades if self.n_trades > 0 else None


# ── Trade accounting ledger ───────────────────────────────────────────────────

class TradeAccountingLedger:
    """
    Converts entry + exit fills into completed TradeRecords with full
    cost accounting and P&L reconciliation.

    Usage
    -----
    ledger = TradeAccountingLedger(initial_capital_inr=1_000_000)
    # Open position
    pos = ledger.open_position(entry_fill, instrument_type, product_type, lot_size, trade_date)
    # Close position
    trade = ledger.close_position(pos, exit_fill, trade_date)
    # Access results
    print(ledger.execution_ledger.total_net_pnl)
    """

    def __init__(
        self,
        initial_capital_inr: float = 1_000_000.0,
        backtest_id:         str   = "backtest-1",
        cost_registry:       Optional[CostScheduleRegistry] = None,
    ):
        self._capital = initial_capital_inr
        self._registry = cost_registry or DEFAULT_REGISTRY
        self.portfolio = PortfolioState(
            timestamp=datetime.now(),
            cash_inr=initial_capital_inr,
        )
        self.execution_ledger = ExecutionLedger(
            backtest_id=backtest_id,
            created_at=datetime.now(),
        )
        self.turnover = TurnoverStats()
        self._position_counter = 0

    # ── Open position ─────────────────────────────────────────────────────────

    def open_position(
        self,
        entry_fill:      SimulatedFill,
        instrument_type: InstrumentType,
        product_type:    ProductType,
        lot_size:        int,
        trade_date,      # date
        model_id:        str = "",
        model_version:   str = "",
        cost_model_version: str = "",
    ) -> Optional[Position]:
        """
        Record an entry fill and create a Position.
        Returns None if fill is not actually filled.
        """
        if not entry_fill.filled or entry_fill.fill_price is None:
            return None

        # Compute entry cost
        entry_cost = compute_trade_cost(
            instrument_type=instrument_type,
            order_side=entry_fill.order_side,
            product_type=product_type,
            trade_date=trade_date,
            price=entry_fill.fill_price,
            quantity_lots=entry_fill.quantity_filled_lots,
            lot_size=lot_size,
            registry=self._registry,
        )

        # Deduct from cash
        entry_notional = entry_fill.fill_price * entry_fill.quantity_filled_lots * lot_size
        self.portfolio.cash_inr -= (entry_notional + entry_cost.total)

        # Track turnover
        self.turnover.record_fill(entry_fill, lot_size)

        self._position_counter += 1
        pos = Position(
            position_id=f"POS-{self._position_counter:06d}",
            instrument_id=entry_fill.instrument_id,
            instrument_type=instrument_type,
            product_type=product_type,
            trade_side=entry_fill.side,
            quantity_lots=entry_fill.quantity_filled_lots,
            lot_size=lot_size,
            entry_price=entry_fill.fill_price,
            entry_fill=entry_fill,
            entry_cost=entry_cost,
            entry_time=entry_fill.actual_fill_time or entry_fill.order_time,
        )
        self.portfolio.add_position(pos)
        return pos

    # ── Close position ─────────────────────────────────────────────────────────

    def close_position(
        self,
        position:    Position,
        exit_fill:   SimulatedFill,
        trade_date,  # date
        holding_bars: int = 0,
        mfe_inr:     Optional[float] = None,
        mae_inr:     Optional[float] = None,
        cost_model_version: str = "",
    ) -> Optional[TradeRecord]:
        """
        Record an exit fill and complete the TradeRecord.
        Returns None if exit fill is not actually filled.
        """
        if not exit_fill.filled or exit_fill.fill_price is None:
            return None

        # Compute exit cost
        exit_cost = compute_trade_cost(
            instrument_type=position.instrument_type,
            order_side=exit_fill.order_side,
            product_type=position.product_type,
            trade_date=trade_date,
            price=exit_fill.fill_price,
            quantity_lots=exit_fill.quantity_filled_lots,
            lot_size=position.lot_size,
            registry=self._registry,
        )

        # Compute gross P&L
        direction = 1 if position.trade_side == TradeSide.LONG else -1
        gross_pnl = (
            direction
            * (exit_fill.fill_price - position.entry_price)
            * position.quantity_lots
            * position.lot_size
        )

        total_cost = position.entry_cost.total + exit_cost.total
        net_pnl    = gross_pnl - total_cost

        # Update cash
        exit_notional = exit_fill.fill_price * exit_fill.quantity_filled_lots * position.lot_size
        self.portfolio.cash_inr += (exit_notional - exit_cost.total)

        # Track turnover
        self.turnover.record_fill(exit_fill, position.lot_size)
        self.turnover.n_trades += 1
        self.turnover.total_holding_bars += holding_bars

        # Remove from open positions
        self.portfolio.remove_position(position.position_id)

        trade = TradeRecord(
            trade_id=make_trade_id(),
            instrument_id=position.instrument_id,
            underlying=position.instrument_id.split("_")[0] if "_" in position.instrument_id else position.instrument_id,
            instrument_type=position.instrument_type,
            product_type=position.product_type,
            trade_side=position.trade_side,
            entry_fill=position.entry_fill,
            exit_fill=exit_fill,
            entry_price=position.entry_price,
            exit_price=exit_fill.fill_price,
            quantity_lots=position.quantity_lots,
            lot_size=position.lot_size,
            gross_pnl=gross_pnl,
            entry_cost=position.entry_cost,
            exit_cost=exit_cost,
            net_pnl=net_pnl,
            holding_bars=holding_bars,
            max_adverse_excursion=mae_inr,
            max_favourable_excursion=mfe_inr,
            cost_model_version=cost_model_version or position.entry_cost.cost_model_version,
        )

        # Append with P&L reconciliation check
        self.execution_ledger.append_trade(trade)
        return trade

    # ── Summary ───────────────────────────────────────────────────────────────

    def summary(self) -> dict:
        """Return a summary of portfolio performance."""
        ledger = self.execution_ledger
        n = ledger.n_trades
        returns = [t.net_return_pct for t in ledger.completed_trades if t.net_return_pct is not None]
        wins    = [r for r in returns if r > 0]
        losses  = [r for r in returns if r <= 0]

        return {
            "n_trades":            n,
            "total_gross_pnl":     round(ledger.total_gross_pnl, 2),
            "total_cost":          round(ledger.total_cost, 2),
            "total_net_pnl":       round(ledger.total_net_pnl, 2),
            "gross_turnover_inr":  round(self.turnover.gross_turnover_inr, 2),
            "win_rate":            round(ledger.win_rate or 0.0, 4),
            "avg_win_pct":         round(sum(wins) / len(wins), 4) if wins else 0.0,
            "avg_loss_pct":        round(sum(losses) / len(losses), 4) if losses else 0.0,
            "avg_holding_bars":    self.turnover.avg_holding_bars,
            "cost_to_gross_ratio": (
                abs(round(ledger.total_cost / ledger.total_gross_pnl, 4))
                if abs(ledger.total_gross_pnl) > 0 else None
            ),
            "current_cash_inr":    round(self.portfolio.cash_inr, 2),
            "pnl_reconciled":      ledger.verify_cost_reconciliation(),
        }
