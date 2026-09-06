"""
Phase 3G — Execution Schemas.

Canonical data structures for the execution/backtest layer.

Design rules
------------
1. Every simulated trade records the full timing chain:
       signal_time → decision_time → order_time → eligible_fill_time → actual_fill_time
2. FillStatus is explicit — FULL/PARTIAL/REJECTED/CANCELLED/UNAVAILABLE.
   A PARTIAL fill is not silently upgraded to FULL.
3. GrossPnL, total_cost, and NetPnL must satisfy:
       net_pnl = gross_pnl - total_cost   (verified in TradeRecord.validate_pnl())
4. Every TradeRecord carries versioned provenance — cost model version,
   slippage model version, instrument metadata version, etc.
5. SpreadDataStatus distinguishes OBSERVED / PROXY / UNAVAILABLE.
   A PROXY spread must never be presented as OBSERVED.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


# ── Enumerations ──────────────────────────────────────────────────────────────

class ExecutionPolicy(str, Enum):
    """
    How the order is executed relative to signal time.
    Policy documentation: what data is required, latency assumption.
    """
    NEXT_OPEN    = "NEXT_OPEN"     # Open of next bar; requires next open price
    NEXT_BAR     = "NEXT_BAR"      # Close of next bar; requires next close price
    NEXT_VWAP    = "NEXT_VWAP"     # VWAP of next bar; derived from OHLCV
    NEXT_CLOSE   = "NEXT_CLOSE"    # Close of next bar (alias for NEXT_BAR)
    LIMIT        = "LIMIT"         # Limit price; may not fill
    STOP         = "STOP"          # Stop price; gap-through risk
    STOP_LIMIT   = "STOP_LIMIT"    # Stop then limit; may not fill
    SAME_CLOSE   = "SAME_CLOSE"    # Signal-bar close — ONLY for special intrabar strategies


class FillStatus(str, Enum):
    """Explicit outcome of an order attempt."""
    FULL         = "FULL"          # Fully executed
    PARTIAL      = "PARTIAL"       # Partially executed (liquidity constraint)
    REJECTED     = "REJECTED"      # Rejected before reaching market
    CANCELLED    = "CANCELLED"     # Cancelled by policy (e.g. F&O ban)
    UNAVAILABLE  = "UNAVAILABLE"   # Price/liquidity data not available


class ProductType(str, Enum):
    """NSE/BSE product type — determines cost rules."""
    MIS          = "MIS"           # Margin intraday square-off (intraday equity)
    CNC          = "CNC"           # Cash and carry (delivery equity)
    NRML         = "NRML"          # Normal (F&O overnight)
    BO           = "BO"            # Bracket order
    CO           = "CO"            # Cover order


class InstrumentType(str, Enum):
    """Instrument classification for cost rule routing."""
    EQ_DELIVERY  = "EQ_DELIVERY"   # Cash equity, CNC/delivery
    EQ_INTRADAY  = "EQ_INTRADAY"   # Cash equity, MIS/intraday
    FUT_IDX      = "FUT_IDX"       # Index futures (NIFTY, BANKNIFTY, etc.)
    FUT_STK      = "FUT_STK"       # Single-stock futures
    OPT_IDX_CE   = "OPT_IDX_CE"    # Index call options
    OPT_IDX_PE   = "OPT_IDX_PE"    # Index put options
    OPT_STK_CE   = "OPT_STK_CE"    # Stock call options
    OPT_STK_PE   = "OPT_STK_PE"    # Stock put options


class TradeSide(str, Enum):
    LONG         = "LONG"
    SHORT        = "SHORT"


class OrderSide(str, Enum):
    BUY          = "BUY"
    SELL         = "SELL"


class SpreadDataStatus(str, Enum):
    """
    Whether spread data is real, derived, or absent.
    PROXY data must never be silently presented as OBSERVED.
    """
    OBSERVED     = "OBSERVED"      # Real bid-ask from order book data
    PROXY        = "PROXY"         # Derived from OHLCV (H-L range proxy, etc.)
    UNAVAILABLE  = "UNAVAILABLE"   # No spread estimate possible


class SlippageModel(str, Enum):
    FIXED_BPS    = "FIXED_BPS"
    SPREAD_PROXY = "SPREAD_PROXY"
    VOL_PARTICIPATION = "VOL_PARTICIPATION"
    MARKET_IMPACT = "MARKET_IMPACT"
    NONE         = "NONE"


class ExecutionDataLevel(str, Enum):
    """Evidence quality classification for execution data (spec §39)."""
    A = "A"   # Observed historical execution/quote data
    B = "B"   # High-quality derived market data
    C = "C"   # Documented parametric proxy
    D = "D"   # Insufficient evidence


class AmbiguityPolicy(str, Enum):
    """
    For OHLC bars where both stop and target are touched in the same bar.
    Default: CONSERVATIVE (worst-case for trader).
    """
    CONSERVATIVE     = "CONSERVATIVE"    # Assume stop hit first
    WORST_CASE       = "WORST_CASE"      # Alias for CONSERVATIVE
    BEST_CASE        = "BEST_CASE"       # Assume target hit first (optimistic)
    UNKNOWN          = "UNKNOWN"         # Record as UNKNOWN; exclude from performance
    LOWER_TF         = "LOWER_TF"        # Use lower-timeframe data if available


# ── Order intent (pre-fill) ───────────────────────────────────────────────────

@dataclass
class OrderIntent:
    """
    An instruction to execute a trade — NOT yet filled.

    Created by the decision layer; consumed by FillEngine.
    Every field is explicit — no inferred prices.
    """
    order_id:         str
    instrument_id:    str
    underlying:       str
    instrument_type:  InstrumentType
    product_type:     ProductType
    side:             TradeSide
    order_side:       OrderSide           # BUY or SELL (entry/exit)
    quantity_lots:    int                 # integer lots — NEVER fractional
    lot_size:         int                 # must come from InstrumentMasterStore PIT lookup
    limit_price:      Optional[float]     # None for market orders
    stop_price:       Optional[float]     # for STOP / STOP_LIMIT

    # Timing chain
    signal_time:      datetime
    decision_time:    datetime
    order_time:       datetime

    # Context
    execution_policy:    ExecutionPolicy
    model_id:            str
    model_version:       str
    dataset_id:          str
    feature_set_id:      str
    label_version:       str
    calibrator_id:       str = ""
    decision_reason:     str = ""
    meta_probability:    Optional[float] = None   # CalibratedProbability.value
    alpha_score:         Optional[float] = None
    expected_value:      Optional[float] = None

    # Contract metadata
    expiry_date:         Optional[datetime] = None
    strike:              Optional[float]    = None
    option_type:         Optional[str]      = None    # "CE" | "PE"

    @property
    def notional(self) -> float:
        """Reference notional at limit/stop price or zero if market."""
        px = self.limit_price or 0.0
        return px * self.quantity_lots * self.lot_size


# ── Simulated fill ────────────────────────────────────────────────────────────

@dataclass
class SimulatedFill:
    """
    The result of attempting to execute an OrderIntent.

    Records EXACTLY what was filled and at what price.
    Does NOT fabricate fills — UNAVAILABLE is a valid outcome.
    """
    fill_id:              str
    order_id:             str
    instrument_id:        str
    side:                 TradeSide
    order_side:           OrderSide
    status:               FillStatus

    # Timing chain (spec §4)
    signal_time:          datetime
    decision_time:        datetime
    order_time:           datetime
    eligible_fill_time:   Optional[datetime]   # earliest possible fill
    actual_fill_time:     Optional[datetime]   # when fill was simulated

    # Fill details
    quantity_requested_lots: int
    quantity_filled_lots:    int               # 0 if REJECTED/UNAVAILABLE
    fill_ratio:              float             # 0.0..1.0
    fill_price:              Optional[float]   # None if not filled
    signal_price:            Optional[float]   # close at signal bar (reference)

    # Execution data quality
    spread_status:           SpreadDataStatus
    execution_data_level:    ExecutionDataLevel

    # Rejection / cancellation reason
    rejection_reason:        str = ""

    @property
    def filled(self) -> bool:
        return self.status in (FillStatus.FULL, FillStatus.PARTIAL)

    @property
    def filled_notional(self) -> float:
        if self.fill_price is None:
            return 0.0
        return self.fill_price * self.quantity_filled_lots * (
            1 if self.quantity_filled_lots else 0
        )


# ── Cost breakdown ────────────────────────────────────────────────────────────

@dataclass
class CostBreakdown:
    """
    Itemised transaction cost for one leg (entry or exit).
    All values are in absolute INR.
    """
    brokerage:          float = 0.0
    stt:                float = 0.0    # Securities Transaction Tax
    exchange_charge:    float = 0.0
    gst:                float = 0.0    # on brokerage + exchange charge
    sebi_charge:        float = 0.0
    stamp_duty:         float = 0.0    # on buy side only
    spread_cost:        float = 0.0    # half-spread × notional
    slippage_cost:      float = 0.0    # estimated market impact
    other:              float = 0.0
    cost_model_version: str = "unknown"

    @property
    def total(self) -> float:
        return (
            self.brokerage + self.stt + self.exchange_charge
            + self.gst + self.sebi_charge + self.stamp_duty
            + self.spread_cost + self.slippage_cost + self.other
        )

    def to_dict(self) -> dict:
        return {
            "brokerage":       round(self.brokerage, 4),
            "stt":             round(self.stt, 4),
            "exchange_charge": round(self.exchange_charge, 4),
            "gst":             round(self.gst, 4),
            "sebi_charge":     round(self.sebi_charge, 4),
            "stamp_duty":      round(self.stamp_duty, 4),
            "spread_cost":     round(self.spread_cost, 4),
            "slippage_cost":   round(self.slippage_cost, 4),
            "other":           round(self.other, 4),
            "total":           round(self.total, 4),
            "cost_model_version": self.cost_model_version,
        }


# ── Trade record (completed round-trip) ──────────────────────────────────────

@dataclass
class TradeRecord:
    """
    A completed round-trip trade (entry + exit).

    net_pnl = gross_pnl - total_cost  must hold to within 0.01 INR.
    """
    trade_id:             str
    instrument_id:        str
    underlying:           str
    instrument_type:      InstrumentType
    product_type:         ProductType
    trade_side:           TradeSide

    # Fills
    entry_fill:           SimulatedFill
    exit_fill:            SimulatedFill

    # Prices and sizing
    entry_price:          float
    exit_price:           float
    quantity_lots:        int
    lot_size:             int

    # P&L
    gross_pnl:            float              # (exit_price - entry_price) × lots × lot_size × direction
    entry_cost:           CostBreakdown
    exit_cost:            CostBreakdown
    net_pnl:              float              # gross_pnl - total_cost

    # Metrics
    holding_bars:         int
    max_adverse_excursion: Optional[float]   # ₹ drawdown during trade
    max_favourable_excursion: Optional[float]

    # Provenance (spec §20, §33)
    signal_id:            str = ""
    order_id_entry:       str = ""
    order_id_exit:        str = ""
    model_id:             str = ""
    model_version:        str = ""
    meta_model_id:        str = ""
    calibrator_id:        str = ""
    cost_model_version:   str = ""
    slippage_model_version: str = ""
    instrument_metadata_version: str = ""
    data_snapshot_id:     str = ""
    execution_policy:     str = ""
    ambiguity_policy:     str = ""
    execution_data_level: ExecutionDataLevel = ExecutionDataLevel.D

    def validate_pnl(self, tolerance: float = 0.01) -> bool:
        """Verify net_pnl = gross_pnl - total_cost within tolerance."""
        total_cost = self.entry_cost.total + self.exit_cost.total
        expected_net = self.gross_pnl - total_cost
        return abs(self.net_pnl - expected_net) <= tolerance

    @property
    def total_cost(self) -> float:
        return self.entry_cost.total + self.exit_cost.total

    @property
    def direction_sign(self) -> int:
        return 1 if self.trade_side == TradeSide.LONG else -1

    @property
    def gross_return_pct(self) -> Optional[float]:
        notional = self.entry_price * self.quantity_lots * self.lot_size
        if notional <= 0:
            return None
        return self.gross_pnl / notional * 100.0

    @property
    def net_return_pct(self) -> Optional[float]:
        notional = self.entry_price * self.quantity_lots * self.lot_size
        if notional <= 0:
            return None
        return self.net_pnl / notional * 100.0


# ── Execution ledger ──────────────────────────────────────────────────────────

@dataclass
class ExecutionLedger:
    """
    Immutable, append-only record of all trade events in a backtest.

    Reproducing the same backtest from the same provenance fields
    must produce the same ledger (spec §33).
    """
    backtest_id:      str
    created_at:       datetime
    completed_trades: list[TradeRecord] = field(default_factory=list)
    open_orders:      list[OrderIntent] = field(default_factory=list)
    rejected_orders:  list[SimulatedFill] = field(default_factory=list)

    def append_trade(self, trade: TradeRecord) -> None:
        """Add a completed trade. Validates P&L before appending."""
        if not trade.validate_pnl():
            raise ValueError(
                f"Trade {trade.trade_id}: net_pnl reconciliation failed. "
                f"gross={trade.gross_pnl:.4f}, cost={trade.total_cost:.4f}, "
                f"net={trade.net_pnl:.4f}"
            )
        self.completed_trades.append(trade)

    @property
    def n_trades(self) -> int:
        return len(self.completed_trades)

    @property
    def total_gross_pnl(self) -> float:
        return sum(t.gross_pnl for t in self.completed_trades)

    @property
    def total_net_pnl(self) -> float:
        return sum(t.net_pnl for t in self.completed_trades)

    @property
    def total_cost(self) -> float:
        return sum(t.total_cost for t in self.completed_trades)

    @property
    def win_rate(self) -> Optional[float]:
        wins = sum(1 for t in self.completed_trades if t.net_pnl > 0)
        n = len(self.completed_trades)
        return wins / n if n > 0 else None

    def verify_cost_reconciliation(self, tolerance: float = 0.01) -> bool:
        """total_net_pnl + total_cost == total_gross_pnl within tolerance."""
        return abs(self.total_net_pnl + self.total_cost - self.total_gross_pnl) <= tolerance


def make_trade_id() -> str:
    return f"T-{uuid.uuid4().hex[:12].upper()}"


def make_order_id() -> str:
    return f"O-{uuid.uuid4().hex[:12].upper()}"


def make_fill_id() -> str:
    return f"F-{uuid.uuid4().hex[:12].upper()}"
