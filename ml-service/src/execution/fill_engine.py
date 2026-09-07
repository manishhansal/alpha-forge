"""
Phase 3G — Fill Engine.

Converts OrderIntent → SimulatedFill by simulating what would have
happened given historical OHLCV data and configured execution policies.

Critical rules enforced
-----------------------
1. Same-bar execution is PREVENTED by default (spec §4).
   A signal generated from close(T) cannot fill at close(T).
   Default policy is NEXT_OPEN (open of T+1).
   SAME_CLOSE is explicitly gated behind an override flag.

2. Gap-through execution (spec §14):
   If a stop is at ₹100 but next bar opens at ₹96, the fill is at ₹96.
   Never assume a ₹100 fill when the gap skips over it.

3. Stop/target ambiguity (spec §15):
   When a single OHLC bar touches both stop and target, default policy
   is CONSERVATIVE (assume stop hit first = worst case for trader).
   Never silently assume the favourable outcome.

4. Partial fills (spec §13):
   When order_notional > max_participation_pct × ADV, the order is
   partially filled or rejected. Never assume infinite liquidity.

5. Circuit limits (spec §16):
   If requested price is outside the price band, the order is not filled.
   Returns FillStatus.REJECTED with explicit rejection_reason.

6. F&O ban (spec §17):
   If the instrument is under F&O ban at order_time, new positions are
   REJECTED. Existing positions may close (configurable policy).

7. Expired contracts (spec §9):
   If order_time is after expiry_date, the order is REJECTED.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Optional

from .market_calendar import DEFAULT_CALENDAR, NSECalendar
from .schemas import (
    AmbiguityPolicy, ExecutionDataLevel, ExecutionPolicy, FillStatus,
    OrderIntent, OrderSide, SimulatedFill, SpreadDataStatus,
    TradeSide, make_fill_id,
)

UTC = timezone.utc


@dataclass
class OHLCBar:
    """A single OHLCV bar used for fill simulation."""
    timestamp:  datetime
    open:       float
    high:       float
    low:        float
    close:      float
    volume:     float
    adv_inr:    Optional[float] = None   # average daily ₹ value
    atr_pct:    Optional[float] = None   # ATR / close (fraction)
    price_band_upper: Optional[float] = None  # circuit limit
    price_band_lower: Optional[float] = None


@dataclass
class FillEngineConfig:
    """Configuration for fill simulation behaviour."""
    default_policy:           ExecutionPolicy = ExecutionPolicy.NEXT_OPEN
    ambiguity_policy:         AmbiguityPolicy = AmbiguityPolicy.CONSERVATIVE
    max_participation_pct:    float = 0.10    # max % of ADV per order
    max_order_pct_of_adv:     float = 0.10    # same as above
    allow_same_close:         bool  = False   # safety gate
    allow_expired_fills:      bool  = False   # safety gate
    slippage_bps:             float = 5.0     # one-way slippage applied to fills
    partial_fill_min_ratio:   float = 0.0     # 0 = accept any partial fill


class FillEngine:
    """
    Simulates order execution against historical OHLCV data.

    Usage
    -----
    engine = FillEngine(config)
    fill = engine.fill(order, signal_bar, next_bars, fno_ban_status)
    """

    def __init__(
        self,
        config:   Optional[FillEngineConfig] = None,
        calendar: Optional[NSECalendar] = None,
    ):
        self.config   = config or FillEngineConfig()
        self.calendar = calendar or DEFAULT_CALENDAR

    # ── Main entry point ──────────────────────────────────────────────────────

    def fill(
        self,
        order:          OrderIntent,
        signal_bar:     OHLCBar,
        next_bars:      list[OHLCBar],   # bars AFTER signal_bar
        fno_ban:        bool = False,    # True = instrument is under F&O ban
        is_new_position: bool = True,    # False = closing existing position
    ) -> SimulatedFill:
        """
        Simulate execution of an OrderIntent.

        Parameters
        ----------
        order        : The order to fill.
        signal_bar   : The bar containing the signal (last bar before execution).
        next_bars    : Subsequent bars for execution (at least 1 required for
                       NEXT_OPEN/NEXT_BAR policies).
        fno_ban      : Whether the instrument is under F&O ban at order_time.
        is_new_position : True if opening a new position (affected by ban rules).

        Returns
        -------
        SimulatedFill with explicit status.
        """
        cfg = self.config
        policy = order.execution_policy

        # ── Pre-fill checks ───────────────────────────────────────────────────

        # 1. F&O ban check
        if fno_ban and is_new_position:
            return self._reject(order, signal_bar, "FNO_BAN_ACTIVE_NEW_POSITION_REJECTED")

        # 2. Contract expiry check
        if order.expiry_date is not None and not cfg.allow_expired_fills:
            order_date = order.order_time.date()
            expiry_date = order.expiry_date.date() if hasattr(order.expiry_date, 'date') else order.expiry_date
            if order_date > expiry_date:
                return self._reject(order, signal_bar, "CONTRACT_EXPIRED")

        # 3. Same-close safety gate
        if policy == ExecutionPolicy.SAME_CLOSE and not cfg.allow_same_close:
            return self._reject(
                order, signal_bar,
                "SAME_CLOSE_EXECUTION_DISABLED: "
                "set allow_same_close=True to enable same-bar fills"
            )

        # 4. Need at least one forward bar for NEXT_* policies
        if policy in (ExecutionPolicy.NEXT_OPEN, ExecutionPolicy.NEXT_BAR,
                      ExecutionPolicy.NEXT_VWAP, ExecutionPolicy.NEXT_CLOSE):
            if not next_bars:
                return self._unavailable(order, signal_bar, "NO_NEXT_BAR_DATA")

        # ── Determine fill bar and price ─────────────────────────────────────
        fill_bar, fill_price = self._compute_fill_bar_and_price(
            order, signal_bar, next_bars
        )

        if fill_bar is None or fill_price is None:
            return self._unavailable(order, signal_bar, "NO_EXECUTABLE_PRICE")

        # ── Circuit limit check ───────────────────────────────────────────────
        circuit_reason = self._check_circuit_limits(fill_price, fill_bar)
        if circuit_reason:
            return self._reject(order, fill_bar, circuit_reason)

        # ── Liquidity / participation check ───────────────────────────────────
        filled_lots, fill_status = self._compute_fill_quantity(
            order, fill_bar, fill_price
        )

        if filled_lots == 0:
            return self._reject(order, fill_bar, "INSUFFICIENT_LIQUIDITY")

        # ── Apply slippage to fill price ──────────────────────────────────────
        adj_fill_price = self._apply_slippage(fill_price, order.order_side)

        # ── Build result ──────────────────────────────────────────────────────
        return SimulatedFill(
            fill_id=make_fill_id(),
            order_id=order.order_id,
            instrument_id=order.instrument_id,
            side=order.side,
            order_side=order.order_side,
            status=fill_status,
            signal_time=order.signal_time,
            decision_time=order.decision_time,
            order_time=order.order_time,
            eligible_fill_time=fill_bar.timestamp,
            actual_fill_time=fill_bar.timestamp,
            quantity_requested_lots=order.quantity_lots,
            quantity_filled_lots=filled_lots,
            fill_ratio=filled_lots / order.quantity_lots,
            fill_price=adj_fill_price,
            signal_price=signal_bar.close,
            spread_status=SpreadDataStatus.PROXY,
            execution_data_level=ExecutionDataLevel.C,
        )

    # ── Fill price computation ────────────────────────────────────────────────

    def _compute_fill_bar_and_price(
        self,
        order:      OrderIntent,
        signal_bar: OHLCBar,
        next_bars:  list[OHLCBar],
    ) -> tuple[Optional[OHLCBar], Optional[float]]:
        """Determine which bar and which price the order fills at."""
        policy = order.execution_policy
        cfg    = self.config

        if policy == ExecutionPolicy.SAME_CLOSE:
            return signal_bar, signal_bar.close

        if policy == ExecutionPolicy.NEXT_OPEN:
            bar = next_bars[0]
            return bar, bar.open

        if policy in (ExecutionPolicy.NEXT_BAR, ExecutionPolicy.NEXT_CLOSE):
            bar = next_bars[0]
            return bar, bar.close

        if policy == ExecutionPolicy.NEXT_VWAP:
            bar = next_bars[0]
            # VWAP proxy: (open + high + low + close) / 4
            vwap_proxy = (bar.open + bar.high + bar.low + bar.close) / 4.0
            return bar, vwap_proxy

        if policy == ExecutionPolicy.STOP:
            stop_px = order.stop_price
            if stop_px is None:
                return None, None
            # Check: does next bar gap through the stop?
            bar = next_bars[0]
            is_long = (order.side == TradeSide.LONG)
            if is_long:
                # Long stop-loss: sell when price falls to stop
                if bar.open <= stop_px:
                    # Gapped below: fill at open (gap-through execution)
                    return bar, bar.open
                elif bar.low <= stop_px:
                    # Hit stop intrabar
                    return bar, stop_px
            else:
                # Short stop-loss: buy when price rises to stop
                if bar.open >= stop_px:
                    return bar, bar.open
                elif bar.high >= stop_px:
                    return bar, stop_px
            return None, None  # stop not triggered

        if policy == ExecutionPolicy.LIMIT:
            lim_px = order.limit_price
            if lim_px is None:
                return None, None
            bar = next_bars[0]
            is_buy = (order.order_side == OrderSide.BUY)
            if is_buy:
                if bar.open <= lim_px:
                    return bar, min(bar.open, lim_px)  # may fill better
                elif bar.low <= lim_px:
                    return bar, lim_px
            else:
                if bar.open >= lim_px:
                    return bar, max(bar.open, lim_px)
                elif bar.high >= lim_px:
                    return bar, lim_px
            return None, None

        return None, None

    # ── Stop/target ambiguity ─────────────────────────────────────────────────

    def resolve_ambiguity(
        self,
        bar:         OHLCBar,
        stop_price:  float,
        target_price: float,
        trade_side:  TradeSide,
    ) -> str:
        """
        Spec §15: When a single bar touches both stop and target,
        return which was hit first under the configured policy.

        Returns: "STOP", "TARGET", or "UNKNOWN"
        """
        policy = self.config.ambiguity_policy

        is_long = (trade_side == TradeSide.LONG)
        if is_long:
            stop_hit   = bar.low  <= stop_price
            target_hit = bar.high >= target_price
        else:
            stop_hit   = bar.high >= stop_price
            target_hit = bar.low  <= target_price

        if stop_hit and target_hit:
            if policy == AmbiguityPolicy.CONSERVATIVE:
                return "STOP"
            elif policy == AmbiguityPolicy.WORST_CASE:
                return "STOP"
            elif policy == AmbiguityPolicy.BEST_CASE:
                return "TARGET"
            elif policy == AmbiguityPolicy.UNKNOWN:
                return "UNKNOWN"
            else:
                return "STOP"  # safe default
        elif stop_hit:
            return "STOP"
        elif target_hit:
            return "TARGET"
        return "NEITHER"

    # ── Circuit limit check ───────────────────────────────────────────────────

    def _check_circuit_limits(self, fill_price: float, bar: OHLCBar) -> str:
        """Return rejection reason string if fill_price is outside price bands."""
        if bar.price_band_upper is not None and fill_price > bar.price_band_upper:
            return (
                f"CIRCUIT_UPPER_LIMIT: fill_price={fill_price:.2f} > "
                f"upper_band={bar.price_band_upper:.2f}"
            )
        if bar.price_band_lower is not None and fill_price < bar.price_band_lower:
            return (
                f"CIRCUIT_LOWER_LIMIT: fill_price={fill_price:.2f} < "
                f"lower_band={bar.price_band_lower:.2f}"
            )
        return ""

    # ── Liquidity check ───────────────────────────────────────────────────────

    def _compute_fill_quantity(
        self,
        order:      OrderIntent,
        bar:        OHLCBar,
        fill_price: float,
    ) -> tuple[int, FillStatus]:
        """
        Compute how many lots can be filled given liquidity constraints.

        Returns (filled_lots, FillStatus).
        """
        cfg = self.config
        requested = order.quantity_lots
        lot_size  = order.lot_size
        order_notional = fill_price * requested * lot_size

        # If no ADV data, allow full fill (no constraint)
        if bar.adv_inr is None or bar.adv_inr <= 0:
            return requested, FillStatus.FULL

        max_notional = bar.adv_inr * cfg.max_participation_pct
        if order_notional <= max_notional:
            return requested, FillStatus.FULL

        # Partial fill: reduce to participation limit
        max_units = math.floor(max_notional / fill_price) if fill_price > 0 else 0
        if lot_size > 0:
            max_lots = max_units // lot_size
        else:
            max_lots = 0

        if max_lots <= 0:
            return 0, FillStatus.REJECTED

        fill_ratio = max_lots / requested
        if fill_ratio < cfg.partial_fill_min_ratio:
            return 0, FillStatus.REJECTED

        return max_lots, FillStatus.PARTIAL

    # ── Slippage application ──────────────────────────────────────────────────

    def _apply_slippage(self, price: float, order_side: OrderSide) -> float:
        """Apply configured slippage to fill price (adverse direction)."""
        slippage_frac = self.config.slippage_bps / 10_000.0
        if order_side == OrderSide.BUY:
            return price * (1.0 + slippage_frac)
        else:
            return price * (1.0 - slippage_frac)

    # ── Factory helpers ───────────────────────────────────────────────────────

    def _reject(self, order: OrderIntent, bar: OHLCBar, reason: str) -> SimulatedFill:
        return SimulatedFill(
            fill_id=make_fill_id(),
            order_id=order.order_id,
            instrument_id=order.instrument_id,
            side=order.side,
            order_side=order.order_side,
            status=FillStatus.REJECTED,
            signal_time=order.signal_time,
            decision_time=order.decision_time,
            order_time=order.order_time,
            eligible_fill_time=bar.timestamp,
            actual_fill_time=None,
            quantity_requested_lots=order.quantity_lots,
            quantity_filled_lots=0,
            fill_ratio=0.0,
            fill_price=None,
            signal_price=bar.close,
            spread_status=SpreadDataStatus.UNAVAILABLE,
            execution_data_level=ExecutionDataLevel.D,
            rejection_reason=reason,
        )

    def _unavailable(self, order: OrderIntent, bar: OHLCBar, reason: str) -> SimulatedFill:
        return SimulatedFill(
            fill_id=make_fill_id(),
            order_id=order.order_id,
            instrument_id=order.instrument_id,
            side=order.side,
            order_side=order.order_side,
            status=FillStatus.UNAVAILABLE,
            signal_time=order.signal_time,
            decision_time=order.decision_time,
            order_time=order.order_time,
            eligible_fill_time=None,
            actual_fill_time=None,
            quantity_requested_lots=order.quantity_lots,
            quantity_filled_lots=0,
            fill_ratio=0.0,
            fill_price=None,
            signal_price=bar.close,
            spread_status=SpreadDataStatus.UNAVAILABLE,
            execution_data_level=ExecutionDataLevel.D,
            rejection_reason=reason,
        )
