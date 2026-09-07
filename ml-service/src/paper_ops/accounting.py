"""
Phase 3R — Paper fill bridge + position/F&O accounting + daily MTM (spec §8-§13).

Fill realism is delegated ENTIRELY to the single Phase 3G `execution.fill_engine`
— this module NEVER simulates a fill itself (spec §9). It only bridges the paper
order/decision world into an `OrderIntent`, runs the reused `FillEngine`, and
converts the resulting `SimulatedFill` into the `{qty, price, cost}` fill legs that
`paper.paper_engine.PaperTradingEngine` consumes.

`NO PERFECT FILLS` (spec §10): the default policy is NEXT_OPEN and slippage is
applied by the engine, so the fill price is (almost) never equal to the signal
price; this module asserts that invariant when it builds a leg.

Position + F&O accounting reuses `execution.position_accounting` and F&O costs come
from `execution.cost_model.compute_trade_cost` (PIT-versioned). Lot size must be
supplied by the caller from the PIT instrument master (3Q) — this module never
guesses a lot size.

Daily MTM is a deterministic aggregation (no wall-clock, no RNG).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

from src.execution.fill_engine import FillEngine, FillEngineConfig, OHLCBar
from src.execution.schemas import (
    OrderIntent, SimulatedFill, FillStatus, InstrumentType, ProductType,
    TradeSide, OrderSide, ExecutionPolicy, make_order_id,
)


# ══════════════════════════════════════════════════════════════════════════════
# §9-§10 Fill bridge — the ONLY entry into the reused Phase 3G FillEngine
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FillLeg:
    """A single applied fill leg for PaperTradingEngine ({qty, price, cost})."""
    qty:    float          # units (lots × lot_size)
    price:  float          # slipped fill price (NOT the signal price)
    cost:   float          # transaction cost for this leg (₹)
    status: str = FillStatus.FULL.value
    fill_time: Optional[str] = None
    signal_price: Optional[float] = None

    def as_engine_leg(self) -> dict:
        return {"qty": self.qty, "price": self.price, "cost": self.cost}


class PerfectFillError(Exception):
    """Raised if a paper fill would use signal_price == execution_price (spec §10)."""


def simulate_paper_fill(
    *,
    instrument_id: str,
    underlying: str,
    instrument_type: InstrumentType,
    product_type: ProductType,
    side: TradeSide,
    order_side: OrderSide,
    quantity_lots: int,
    lot_size: int,
    signal_bar: OHLCBar,
    next_bars: list[OHLCBar],
    trade_date: date,
    signal_time: datetime,
    decision_time: datetime,
    order_time: datetime,
    execution_policy: ExecutionPolicy = ExecutionPolicy.NEXT_OPEN,
    fno_ban: bool = False,
    is_new_position: bool = True,
    limit_price: Optional[float] = None,
    stop_price: Optional[float] = None,
    expiry_date: Optional[datetime] = None,
    strike: Optional[float] = None,
    option_type: Optional[str] = None,
    fill_config: Optional[FillEngineConfig] = None,
    cost_registry=None,
    model_id: str = "", model_version: str = "", dataset_id: str = "",
    feature_set_id: str = "", label_version: str = "",
) -> tuple[SimulatedFill, Optional[FillLeg]]:
    """
    Build an OrderIntent, run the reused FillEngine, compute PIT-versioned cost, and
    return (SimulatedFill, FillLeg | None). Returns leg=None when the engine did not
    produce a usable fill (REJECTED / UNAVAILABLE) — never fabricates a fill.

    `lot_size` MUST be the PIT lot size from the instrument master (3Q); this
    function does not look it up (spec §12: never a wrong/guessed lot).
    """
    if lot_size <= 0:
        raise ValueError("lot_size must be a positive PIT value (never guessed, spec §12)")

    intent = OrderIntent(
        order_id=make_order_id(),
        instrument_id=instrument_id, underlying=underlying,
        instrument_type=instrument_type, product_type=product_type,
        side=side, order_side=order_side,
        quantity_lots=int(quantity_lots), lot_size=int(lot_size),
        limit_price=limit_price, stop_price=stop_price,
        signal_time=signal_time, decision_time=decision_time, order_time=order_time,
        execution_policy=execution_policy,
        model_id=model_id, model_version=model_version, dataset_id=dataset_id,
        feature_set_id=feature_set_id, label_version=label_version,
        expiry_date=expiry_date, strike=strike, option_type=option_type,
    )

    engine = FillEngine(fill_config)
    fill = engine.fill(intent, signal_bar, next_bars, fno_ban=fno_ban,
                       is_new_position=is_new_position)

    if fill.status in (FillStatus.REJECTED, FillStatus.UNAVAILABLE) or fill.fill_price is None:
        return fill, None

    filled_units = fill.quantity_filled_lots * lot_size
    cost = _leg_cost(instrument_type, order_side, product_type, trade_date,
                     fill.fill_price, fill.quantity_filled_lots, lot_size,
                     option_type=option_type, cost_registry=cost_registry)

    # §10 no-perfect-fill invariant: with NEXT_* + slippage the fill price must
    # differ from the signal close (unless a genuine same-close policy is used).
    if (execution_policy != ExecutionPolicy.SAME_CLOSE
            and fill.fill_price == signal_bar.close):
        raise PerfectFillError(
            f"paper fill price equals signal price ({signal_bar.close}) under "
            f"{execution_policy.value} — perfect fills are forbidden (spec §10)")

    leg = FillLeg(qty=filled_units, price=fill.fill_price, cost=cost,
                  status=fill.status.value,
                  fill_time=(fill.actual_fill_time.isoformat()
                             if fill.actual_fill_time else None),
                  signal_price=signal_bar.close)
    return fill, leg


def _leg_cost(instrument_type, order_side, product_type, trade_date, price,
              quantity_lots, lot_size, option_type=None, cost_registry=None) -> float:
    """PIT-versioned transaction cost for one leg via the reused cost model."""
    from src.execution.cost_model import compute_trade_cost
    premium = price if option_type in ("CE", "PE") else None
    cb = compute_trade_cost(
        instrument_type=instrument_type, order_side=order_side,
        product_type=product_type, trade_date=trade_date, price=price,
        quantity_lots=quantity_lots, lot_size=lot_size,
        premium_price=premium, registry=cost_registry,
    )
    return cb.total


# ══════════════════════════════════════════════════════════════════════════════
# §11-§12 Position + F&O accounting (deterministic)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PaperPosition:
    """
    A paper position with full accounting (spec §11-§12). Signed quantity: >0 long,
    <0 short. Handles partial entry/exit, scale-in/out, and reversal deterministically.
    F&O identity (expiry/strike/type/lot) is carried and NEVER silently changed.
    """
    instrument:      str
    instrument_type: str = InstrumentType.EQ_DELIVERY.value
    quantity:        float = 0.0        # signed units
    avg_entry:       float = 0.0
    realized_pnl:    float = 0.0
    total_cost:      float = 0.0        # accumulated fees + charges
    total_slippage:  float = 0.0
    # F&O identity (spec §12)
    expiry:          Optional[str] = None
    strike:          Optional[float] = None
    option_type:     Optional[str] = None
    lot_size:        int = 1
    sector:          str = ""

    def apply(self, side: str, units: float, price: float, cost: float = 0.0,
              slippage: float = 0.0) -> None:
        """
        Apply a fill. `side` is BUY/SELL. Realizes PnL on the reducing portion and
        rolls the average entry on the increasing portion. Reversal is handled as
        close-then-open. Deterministic (spec §11, §42).
        """
        signed = units if side.upper() in ("BUY", "LONG") else -units
        self.total_cost += cost
        self.total_slippage += slippage

        if self.quantity == 0 or (self.quantity > 0) == (signed > 0):
            # opening or scaling in the SAME direction → roll weighted avg entry
            new_qty = self.quantity + signed
            if new_qty != 0:
                self.avg_entry = (
                    (self.avg_entry * abs(self.quantity)) + price * abs(signed)
                ) / abs(new_qty)
            self.quantity = new_qty
            return

        # reducing / closing / reversing (opposite direction)
        closing = min(abs(signed), abs(self.quantity))
        direction = 1.0 if self.quantity > 0 else -1.0
        # realized pnl on the closed portion
        self.realized_pnl += direction * (price - self.avg_entry) * closing
        remaining_signed = signed + self.quantity  # net after applying
        if abs(signed) <= abs(self.quantity):
            # partial or full close, no reversal
            self.quantity = self.quantity + signed
            if self.quantity == 0:
                self.avg_entry = 0.0
        else:
            # reversal: close fully then open the remainder at this price
            self.quantity = remaining_signed
            self.avg_entry = price

    def unrealized_pnl(self, mark_price: float) -> float:
        if self.quantity == 0:
            return 0.0
        direction = 1.0 if self.quantity > 0 else -1.0
        return direction * (mark_price - self.avg_entry) * abs(self.quantity)

    def exposure(self, mark_price: float) -> float:
        return abs(self.quantity) * mark_price

    @property
    def is_flat(self) -> bool:
        return abs(self.quantity) < 1e-9

    def to_dict(self) -> dict:
        return {
            "instrument": self.instrument, "instrument_type": self.instrument_type,
            "quantity": self.quantity, "avg_entry": self.avg_entry,
            "realized_pnl": self.realized_pnl, "total_cost": self.total_cost,
            "total_slippage": self.total_slippage, "expiry": self.expiry,
            "strike": self.strike, "option_type": self.option_type,
            "lot_size": self.lot_size, "sector": self.sector,
            "is_flat": self.is_flat,
        }


class PaperPositionLedger:
    """
    Deterministic per-instrument position book (spec §11). All state is derived
    from applied fills; nothing is fabricated. Turnover accumulates on every fill.
    """

    def __init__(self):
        self.positions: dict[str, PaperPosition] = {}
        self.turnover: float = 0.0

    def get(self, instrument: str, **identity) -> PaperPosition:
        if instrument not in self.positions:
            self.positions[instrument] = PaperPosition(instrument=instrument, **identity)
        return self.positions[instrument]

    def apply_fill(self, instrument: str, side: str, units: float, price: float,
                   cost: float = 0.0, slippage: float = 0.0, **identity) -> PaperPosition:
        pos = self.get(instrument, **identity)
        # §12 fail-closed: F&O identity must not silently change across fills
        for k in ("expiry", "strike", "option_type", "lot_size"):
            v = identity.get(k)
            if v is not None and getattr(pos, k) not in (None, 1, "") and getattr(pos, k) != v:
                raise ValueError(
                    f"{instrument} {k} changed {getattr(pos, k)!r}->{v!r} mid-position "
                    "(historical contract metadata must not silently change, spec §12)")
        pos.apply(side, units, price, cost, slippage)
        self.turnover += abs(units) * price
        return pos

    def realized_pnl(self) -> float:
        return sum(p.realized_pnl for p in self.positions.values())

    def total_cost(self) -> float:
        return sum(p.total_cost for p in self.positions.values())

    def total_slippage(self) -> float:
        return sum(p.total_slippage for p in self.positions.values())

    def unrealized_pnl(self, marks: dict[str, float]) -> float:
        return sum(p.unrealized_pnl(marks[p.instrument])
                   for p in self.positions.values()
                   if p.instrument in marks and not p.is_flat)

    def open_positions(self) -> list[PaperPosition]:
        return [p for p in self.positions.values() if not p.is_flat]


# ══════════════════════════════════════════════════════════════════════════════
# §13 Daily mark-to-market (deterministic, reproducible)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class DailyMark:
    """Reproducible daily MTM snapshot (spec §13)."""
    trading_date:    str
    gross_exposure:  float
    net_exposure:    float
    unrealized_pnl:  float
    realized_pnl:    float
    fees:            float
    slippage:        float
    net_pnl:         float
    turnover:        float
    drawdown:        float
    concentration:   float                 # max single-instrument share of gross
    sector_exposure: dict = field(default_factory=dict)
    instrument_exposure: dict = field(default_factory=dict)
    n_open_positions: int = 0

    def to_dict(self) -> dict:
        return {
            "trading_date": self.trading_date, "gross_exposure": self.gross_exposure,
            "net_exposure": self.net_exposure, "unrealized_pnl": self.unrealized_pnl,
            "realized_pnl": self.realized_pnl, "fees": self.fees,
            "slippage": self.slippage, "net_pnl": self.net_pnl,
            "turnover": self.turnover, "drawdown": self.drawdown,
            "concentration": self.concentration, "sector_exposure": self.sector_exposure,
            "instrument_exposure": self.instrument_exposure,
            "n_open_positions": self.n_open_positions,
        }


def compute_daily_mark(
    ledger: PaperPositionLedger,
    marks: dict[str, float],
    trading_date: str,
    prior_peak_equity: float = 0.0,
) -> DailyMark:
    """
    Deterministically compute the daily MTM from the position ledger + a marks map
    (spec §13). `prior_peak_equity` lets the caller track running drawdown across a
    session. Missing marks are excluded from exposure (never fabricated).
    """
    gross = 0.0
    net = 0.0
    instrument_exposure: dict[str, float] = {}
    sector_exposure: dict[str, float] = {}
    n_open = 0

    for pos in ledger.open_positions():
        mk = marks.get(pos.instrument)
        if mk is None:
            continue   # no mark → exclude (do not fabricate, spec §56)
        exp = pos.exposure(mk)
        signed_exp = exp * (1.0 if pos.quantity > 0 else -1.0)
        gross += exp
        net += signed_exp
        instrument_exposure[pos.instrument] = exp
        sector_exposure[pos.sector] = sector_exposure.get(pos.sector, 0.0) + exp
        n_open += 1

    unreal = ledger.unrealized_pnl(marks)
    real = ledger.realized_pnl()
    fees = ledger.total_cost()
    slip = ledger.total_slippage()
    net_pnl = real + unreal - fees
    concentration = (max(instrument_exposure.values()) / gross) if gross > 0 else 0.0

    equity = net_pnl
    peak = max(prior_peak_equity, equity)
    drawdown = max(0.0, peak - equity)

    return DailyMark(
        trading_date=trading_date, gross_exposure=gross, net_exposure=net,
        unrealized_pnl=unreal, realized_pnl=real, fees=fees, slippage=slip,
        net_pnl=net_pnl, turnover=ledger.turnover, drawdown=drawdown,
        concentration=concentration, sector_exposure=sector_exposure,
        instrument_exposure=instrument_exposure, n_open_positions=n_open,
    )
