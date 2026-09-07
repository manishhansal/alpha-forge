"""
Phase 3G — India-Native Transaction Cost Model.

Implements versioned cost schedules for Indian equity and F&O instruments.
Every historical simulation uses the cost schedule applicable AT the trade
date — never today's regulatory schedule applied to historical trades.

Sources
-------
- NSE transaction charges: NSE circular NCE/COMP/0021/2024 and predecessors
- STT: Finance Act schedules; Finance Act 2024 revisions
- Stamp duty: effective Aug 2019 (uniform across states for securities)
- SEBI turnover fee: SEBI circular SEBI/HO/MRD/DP/P/CIR/2022/68
- Brokerage: zero-cost model for discount brokers (Zerodha-style ceiling)

Design
------
- CostScheduleRegistry holds timestamped schedules; get_schedule(trade_date)
  returns the schedule applicable on that date.
- Each schedule documents its effective_from, effective_to, source.
- Costs are computed PER LEG (buy or sell) and then summed round-trip.
- GST applies to brokerage + exchange charges (not STT or stamp duty).
- Stamp duty applies only on BUY side.
- STT applies on SELL side for futures; SELL side for equity delivery;
  but on BOTH sides for equity intraday (MIS) — see STT rules below.

NSE STT rules (equity):
  Delivery BUY+SELL:    0.1% on both sides on turnover
  Intraday (MIS) SELL:  0.025% on sell turnover
  Futures  SELL:        0.0125% on sell turnover (futures = 0.0125% from 2023 budget)
  Options  SELL (premium): 0.0625% on premium turnover
  Options  Exercise: 0.125% on intrinsic value

F&O Budget 2023-24 change (effective 1 Oct 2023):
  Futures STT: 0.0125% (was 0.01%)
  Options STT: 0.0625% on sell (was 0.05%)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

from .schemas import (
    CostBreakdown, InstrumentType, OrderSide, ProductType, TradeSide,
)


# ── Cost schedule versioning ──────────────────────────────────────────────────

@dataclass(frozen=True)
class CostScheduleVersion:
    """Version identifier for a cost schedule."""
    version_id:     str
    effective_from: date
    effective_to:   Optional[date]   # None = still current
    source:         str
    notes:          str = ""

    def is_effective_on(self, trade_date: date) -> bool:
        if trade_date < self.effective_from:
            return False
        if self.effective_to is not None and trade_date > self.effective_to:
            return False
        return True


# ── Indian equity cost schedule ───────────────────────────────────────────────

@dataclass(frozen=True)
class IndiaEquityCostSchedule:
    """
    Cost schedule for Indian cash equity (both intraday MIS and delivery CNC).

    All rates are expressed as FRACTION of trade value (not percentage).
    E.g. brokerage_pct = 0.0003 means 0.03%.
    """
    version:             CostScheduleVersion

    # Brokerage: flat ₹0 + percentage (most discount brokers cap at ₹20/trade)
    brokerage_pct:       float = 0.0003    # 0.03% — Zerodha-style
    brokerage_cap_inr:   float = 20.0      # ₹20 per order cap

    # STT (Securities Transaction Tax) — per Finance Act
    stt_delivery_buy:    float = 0.001     # 0.1% on both sides for delivery
    stt_delivery_sell:   float = 0.001     # 0.1%
    stt_intraday_sell:   float = 0.00025   # 0.025% on sell only for intraday

    # Exchange transaction charges (NSE)
    exchange_charge_pct: float = 0.0000345  # ₹3.45 per ₹1 lakh

    # GST: 18% on brokerage + exchange charges (not on STT/stamp/SEBI)
    gst_rate:            float = 0.18

    # SEBI turnover fee (₹10 per crore = 0.000001)
    sebi_fee_pct:        float = 0.000001

    # Stamp duty: uniform 0.015% on buy side (effective Aug 2019)
    stamp_duty_buy_pct:  float = 0.00015

    def compute(
        self,
        order_side: OrderSide,
        product_type: ProductType,
        trade_value_inr: float,         # abs(price × qty)
        brokerage_override_inr: Optional[float] = None,
    ) -> CostBreakdown:
        """
        Compute leg cost for one equity trade.

        Parameters
        ----------
        order_side       : BUY or SELL
        product_type     : CNC (delivery) or MIS (intraday)
        trade_value_inr  : absolute trade value = price × quantity
        brokerage_override_inr : override brokerage (e.g. flat ₹20)
        """
        v = trade_value_inr
        is_buy  = (order_side == OrderSide.BUY)
        is_sell = (order_side == OrderSide.SELL)
        is_delivery = (product_type == ProductType.CNC)
        is_intraday = (product_type == ProductType.MIS)

        # Brokerage
        if brokerage_override_inr is not None:
            brokerage = float(brokerage_override_inr)
        else:
            brokerage = min(v * self.brokerage_pct, self.brokerage_cap_inr)

        # STT
        if is_delivery:
            stt = v * (self.stt_delivery_buy if is_buy else self.stt_delivery_sell)
        else:  # intraday
            stt = v * self.stt_intraday_sell if is_sell else 0.0

        # Exchange charge
        exchange = v * self.exchange_charge_pct

        # GST on brokerage + exchange charge
        gst = (brokerage + exchange) * self.gst_rate

        # SEBI
        sebi = v * self.sebi_fee_pct

        # Stamp duty: buy side only
        stamp = v * self.stamp_duty_buy_pct if is_buy else 0.0

        return CostBreakdown(
            brokerage=brokerage,
            stt=stt,
            exchange_charge=exchange,
            gst=gst,
            sebi_charge=sebi,
            stamp_duty=stamp,
            cost_model_version=self.version.version_id,
        )


# ── Indian F&O cost schedule ──────────────────────────────────────────────────

@dataclass(frozen=True)
class IndiaFnOCostSchedule:
    """
    Cost schedule for Indian F&O (futures and options).

    F&O costs differ materially from equity — do NOT use equity rules here.
    STT rules changed in Budget 2023-24 (effective 1 Oct 2023).

    Options note:
    - STT applies on PREMIUM turnover (not notional) on sell side
    - Brokerage is typically flat ₹20/lot for discount brokers
    """
    version: CostScheduleVersion

    # Brokerage: typically flat per lot for F&O discount brokers
    brokerage_per_lot_inr: float = 20.0     # ₹20 per lot — Zerodha style
    brokerage_pct:         float = 0.0003   # used if notional > threshold
    brokerage_cap_inr:     float = 20.0

    # STT on FUTURES — sell side only, on notional
    stt_futures_sell_pct:  float = 0.000125  # 0.0125% post Budget 2023-24
    # Pre-Oct 2023: 0.01% (overridden in older schedules)

    # STT on OPTIONS — sell side on PREMIUM turnover
    stt_options_sell_pct:  float = 0.000625  # 0.0625% post Budget 2023-24
    # Pre-Oct 2023: 0.05%

    # Exercise STT: 0.125% on intrinsic value
    stt_options_exercise_pct: float = 0.00125

    # Exchange transaction charges (NSE)
    # Futures: ₹1.9 per lakh turnover = 0.0000190
    exchange_charge_futures_pct: float = 0.0000190
    # Options: ₹5.0 per lakh of premium = 0.0000500
    exchange_charge_options_pct: float = 0.0000500

    # GST: 18% on brokerage + exchange charge
    gst_rate: float = 0.18

    # SEBI fee
    sebi_fee_pct: float = 0.000001

    # Stamp duty: 0.003% on buy side (futures), 0.003% on buy side (options)
    stamp_duty_futures_buy_pct: float = 0.00003
    stamp_duty_options_buy_pct: float = 0.00003

    def compute_futures(
        self,
        order_side: OrderSide,
        notional_inr: float,
        lot_count: int,
    ) -> CostBreakdown:
        """Compute leg cost for one futures trade."""
        v = notional_inr
        is_buy  = (order_side == OrderSide.BUY)
        is_sell = (order_side == OrderSide.SELL)

        # Brokerage: ₹20/lot or % of notional, whichever is lower
        brokerage_pct_amount  = v * self.brokerage_pct
        brokerage_flat_amount = self.brokerage_per_lot_inr * lot_count
        brokerage = min(brokerage_pct_amount, brokerage_flat_amount, self.brokerage_cap_inr * lot_count)

        # STT: sell side only, on notional
        stt = v * self.stt_futures_sell_pct if is_sell else 0.0

        # Exchange charge on notional
        exchange = v * self.exchange_charge_futures_pct

        # GST
        gst = (brokerage + exchange) * self.gst_rate

        # SEBI
        sebi = v * self.sebi_fee_pct

        # Stamp duty: buy side only
        stamp = v * self.stamp_duty_futures_buy_pct if is_buy else 0.0

        return CostBreakdown(
            brokerage=brokerage,
            stt=stt,
            exchange_charge=exchange,
            gst=gst,
            sebi_charge=sebi,
            stamp_duty=stamp,
            cost_model_version=self.version.version_id,
        )

    def compute_options(
        self,
        order_side: OrderSide,
        premium_inr: float,    # total premium value (premium_per_unit × lots × lot_size)
        lot_count:   int,
        is_exercise: bool = False,
        intrinsic_value_inr: Optional[float] = None,
    ) -> CostBreakdown:
        """Compute leg cost for one options trade on premium basis."""
        v = premium_inr
        is_buy  = (order_side == OrderSide.BUY)
        is_sell = (order_side == OrderSide.SELL)

        brokerage_pct_amount  = v * self.brokerage_pct
        brokerage_flat_amount = self.brokerage_per_lot_inr * lot_count
        brokerage = min(brokerage_pct_amount, brokerage_flat_amount, self.brokerage_cap_inr * lot_count)

        # STT: sell side on premium; exercise on intrinsic value
        if is_exercise and intrinsic_value_inr is not None:
            stt = intrinsic_value_inr * self.stt_options_exercise_pct
        else:
            stt = v * self.stt_options_sell_pct if is_sell else 0.0

        exchange = v * self.exchange_charge_options_pct
        gst      = (brokerage + exchange) * self.gst_rate
        sebi     = v * self.sebi_fee_pct
        stamp    = v * self.stamp_duty_options_buy_pct if is_buy else 0.0

        return CostBreakdown(
            brokerage=brokerage,
            stt=stt,
            exchange_charge=exchange,
            gst=gst,
            sebi_charge=sebi,
            stamp_duty=stamp,
            cost_model_version=self.version.version_id,
        )


# ── Cost schedule registry ────────────────────────────────────────────────────

# Versioned schedules ordered by effective_from (oldest first)
_EQUITY_SCHEDULES: list[tuple[CostScheduleVersion, IndiaEquityCostSchedule]] = []
_FNO_SCHEDULES:    list[tuple[CostScheduleVersion, IndiaFnOCostSchedule]]    = []


def _build_default_schedules() -> None:
    """Populate built-in versioned cost schedules."""
    global _EQUITY_SCHEDULES, _FNO_SCHEDULES

    # ── Equity schedules ──────────────────────────────────────────────────────
    ver_eq_2019 = CostScheduleVersion(
        version_id="india-equity-2019",
        effective_from=date(2019, 8, 1),
        effective_to=date(2023, 9, 30),
        source="Finance Act 2019 + NSE circulars",
        notes="Stamp duty unified Aug 2019; STT delivery 0.1%",
    )
    _EQUITY_SCHEDULES.append((ver_eq_2019, IndiaEquityCostSchedule(
        version=ver_eq_2019,
        stt_delivery_buy=0.001, stt_delivery_sell=0.001,
        stt_intraday_sell=0.00025,
    )))

    ver_eq_2023 = CostScheduleVersion(
        version_id="india-equity-2023",
        effective_from=date(2023, 10, 1),
        effective_to=None,
        source="Finance Act 2023-24 + NSE circulars",
        notes="Budget 2023-24 cost revisions",
    )
    _EQUITY_SCHEDULES.append((ver_eq_2023, IndiaEquityCostSchedule(
        version=ver_eq_2023,
        stt_delivery_buy=0.001, stt_delivery_sell=0.001,
        stt_intraday_sell=0.00025,
    )))

    # ── F&O schedules ─────────────────────────────────────────────────────────
    ver_fno_pre2023 = CostScheduleVersion(
        version_id="india-fno-pre-2023",
        effective_from=date(2010, 1, 1),
        effective_to=date(2023, 9, 30),
        source="Finance Act pre-2023",
        notes="Futures STT 0.01%, Options STT 0.05% on sell premium",
    )
    _FNO_SCHEDULES.append((ver_fno_pre2023, IndiaFnOCostSchedule(
        version=ver_fno_pre2023,
        stt_futures_sell_pct=0.0001,    # 0.01% — pre Budget 2023
        stt_options_sell_pct=0.0005,    # 0.05% — pre Budget 2023
        exchange_charge_futures_pct=0.0000190,
        exchange_charge_options_pct=0.0000500,
    )))

    ver_fno_2023 = CostScheduleVersion(
        version_id="india-fno-2023",
        effective_from=date(2023, 10, 1),
        effective_to=None,
        source="Finance Act 2023-24 Budget revisions",
        notes="Futures STT 0.0125%, Options STT 0.0625% on sell premium",
    )
    _FNO_SCHEDULES.append((ver_fno_2023, IndiaFnOCostSchedule(
        version=ver_fno_2023,
        stt_futures_sell_pct=0.000125,  # 0.0125%
        stt_options_sell_pct=0.000625,  # 0.0625%
        exchange_charge_futures_pct=0.0000190,
        exchange_charge_options_pct=0.0000500,
    )))


_build_default_schedules()


class CostScheduleRegistry:
    """
    Point-in-time cost schedule registry.

    Never applies a future schedule to a historical trade.
    get_equity_schedule(trade_date) returns the schedule effective on that date.
    """

    def get_equity_schedule(self, trade_date: date) -> IndiaEquityCostSchedule:
        """Return equity cost schedule applicable on trade_date."""
        for ver, sched in reversed(_EQUITY_SCHEDULES):
            if ver.is_effective_on(trade_date):
                return sched
        # Fallback: earliest known
        return _EQUITY_SCHEDULES[0][1]

    def get_fno_schedule(self, trade_date: date) -> IndiaFnOCostSchedule:
        """Return F&O cost schedule applicable on trade_date."""
        for ver, sched in reversed(_FNO_SCHEDULES):
            if ver.is_effective_on(trade_date):
                return sched
        return _FNO_SCHEDULES[0][1]

    def register_equity_schedule(
        self, version: CostScheduleVersion, schedule: IndiaEquityCostSchedule
    ) -> None:
        """Register a custom equity schedule (e.g. for future regulatory changes)."""
        _EQUITY_SCHEDULES.append((version, schedule))
        _EQUITY_SCHEDULES.sort(key=lambda x: x[0].effective_from)

    def register_fno_schedule(
        self, version: CostScheduleVersion, schedule: IndiaFnOCostSchedule
    ) -> None:
        _FNO_SCHEDULES.append((version, schedule))
        _FNO_SCHEDULES.sort(key=lambda x: x[0].effective_from)


# Module-level singleton
DEFAULT_REGISTRY = CostScheduleRegistry()


# ── Unified cost computation ───────────────────────────────────────────────────

def compute_trade_cost(
    instrument_type: InstrumentType,
    order_side:       OrderSide,
    product_type:     ProductType,
    trade_date:       date,
    price:            float,
    quantity_lots:    int,
    lot_size:         int,
    premium_price:    Optional[float] = None,  # for options: premium per unit
    is_exercise:      bool = False,
    intrinsic_per_unit: Optional[float] = None,
    registry:         Optional[CostScheduleRegistry] = None,
) -> CostBreakdown:
    """
    Compute transaction cost for one leg using the appropriate versioned schedule.

    Parameters
    ----------
    instrument_type  : determines which cost schedule to use
    order_side       : BUY or SELL
    product_type     : CNC / MIS / NRML
    trade_date       : determines which regulatory schedule applies
    price            : fill price
    quantity_lots    : number of lots
    lot_size         : lot size from InstrumentMasterStore (PIT)
    premium_price    : options premium per unit (only for OPT_ types)
    is_exercise      : True if this is an options exercise settlement
    intrinsic_per_unit : intrinsic value per unit for exercise STT
    registry         : CostScheduleRegistry; uses DEFAULT_REGISTRY if None

    Returns
    -------
    CostBreakdown with all components itemised.
    """
    reg = registry or DEFAULT_REGISTRY
    total_units = quantity_lots * lot_size
    notional    = price * total_units

    it = instrument_type

    # ── Equity instruments ────────────────────────────────────────────────────
    if it in (InstrumentType.EQ_DELIVERY, InstrumentType.EQ_INTRADAY):
        prod = ProductType.CNC if it == InstrumentType.EQ_DELIVERY else ProductType.MIS
        sched = reg.get_equity_schedule(trade_date)
        return sched.compute(
            order_side=order_side,
            product_type=prod,
            trade_value_inr=notional,
        )

    # ── Futures instruments ───────────────────────────────────────────────────
    if it in (InstrumentType.FUT_IDX, InstrumentType.FUT_STK):
        sched = reg.get_fno_schedule(trade_date)
        return sched.compute_futures(
            order_side=order_side,
            notional_inr=notional,
            lot_count=quantity_lots,
        )

    # ── Options instruments ───────────────────────────────────────────────────
    if it in (
        InstrumentType.OPT_IDX_CE, InstrumentType.OPT_IDX_PE,
        InstrumentType.OPT_STK_CE, InstrumentType.OPT_STK_PE,
    ):
        sched = reg.get_fno_schedule(trade_date)
        p     = premium_price if premium_price is not None else price
        premium_total = p * total_units
        intrinsic_total = (
            intrinsic_per_unit * total_units
            if intrinsic_per_unit is not None else None
        )
        return sched.compute_options(
            order_side=order_side,
            premium_inr=premium_total,
            lot_count=quantity_lots,
            is_exercise=is_exercise,
            intrinsic_value_inr=intrinsic_total,
        )

    # Unknown type — return zero cost with a note
    return CostBreakdown(
        cost_model_version=f"UNKNOWN_INSTRUMENT_TYPE:{it.value}",
    )
