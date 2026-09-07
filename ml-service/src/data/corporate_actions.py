"""
Corporate Actions — Point-in-Time Interface for AlphaForge ML Service.

Provides a point-in-time view of corporate actions (splits, bonuses, mergers,
delistings) with explicit DATA_UNAVAILABLE semantics.

Critical invariant
------------------
A future corporate action must NOT alter the adjusted price or other metadata
that was available to a model prediction BEFORE the action became public.

    announcement_date = when the action was announced (AVAILABLE to a model from this date)
    effective_date    = when the action takes effect at the exchange

Example:
    Split 2:1 announced on 2024-01-10, effective 2024-01-20.
    A model prediction on 2024-01-15 KNOWS about the split (announced 10 Jan).
    A model prediction on 2024-01-05 does NOT know about the split.

Price adjustment semantics
--------------------------
    raw_price      = price as reported by the exchange (unadjusted)
    adjusted_price = raw_price * adjustment_factor
    factor         = adjusted_price / raw_price
                     (< 1 for splits/bonuses, > 1 for reversal)

For pre-split history:
    adjusted_close = raw_close * factor  (e.g. 0.5 for 2:1 split)

Current data availability
--------------------------
AlphaForge does not currently maintain a historical corporate-action database.
All queries return CorporateActionStatus.DATA_UNAVAILABLE.
This is explicitly documented in DatasetSnapshot.limitations.

When historical corporate-action data becomes available:
  - Populate the CorporateActionStore
  - Queries will return TRUE adjustment factors
  - Remove the DATA_UNAVAILABLE returns
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import Enum
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)

UTC = timezone.utc


# ── CorporateActionType ───────────────────────────────────────────────────────

class CorporateActionType(str, Enum):
    SPLIT           = "SPLIT"
    BONUS           = "BONUS"
    DIVIDEND        = "DIVIDEND"
    RIGHTS          = "RIGHTS"
    MERGER          = "MERGER"
    DEMERGER        = "DEMERGER"
    SYMBOL_CHANGE   = "SYMBOL_CHANGE"
    DELISTING       = "DELISTING"
    CONSOLIDATION   = "CONSOLIDATION"   # reverse split


# ── AdjustmentStatus ──────────────────────────────────────────────────────────

class AdjustmentStatus(str, Enum):
    ADJUSTED         = "ADJUSTED"          # adjustment factor applied; price is adjusted
    RAW              = "RAW"               # no adjustment applied; raw price
    DATA_UNAVAILABLE = "DATA_UNAVAILABLE"  # cannot determine; return raw price
    NOT_REQUIRED     = "NOT_REQUIRED"      # no corporate actions affect this period


# ── CorporateActionRecord ─────────────────────────────────────────────────────

@dataclass
class CorporateActionRecord:
    """
    A single corporate action event with point-in-time metadata.

    Fields
    ------
    symbol              : Affected symbol (NSE uppercase).
    action_type         : Type of corporate action.
    effective_date      : When the action takes effect at the exchange.
    announcement_date   : When the action was announced (publicly known from this date).
    availability_date   : When AlphaForge's data layer received this information.
                          For ML: a model at query_time T can use this record only if
                          availability_date <= T.
    adjustment_factor   : Price factor to apply: adjusted = raw * factor.
                          For 2:1 split: factor = 0.5.
                          None when factor is unknown or not applicable.
    raw_numerator       : For splits/bonuses: new shares per old share (numerator).
    raw_denominator     : For splits/bonuses: old shares (denominator).
    description         : Human-readable description.
    source              : Data source identifier.
    """

    symbol:             str
    action_type:        CorporateActionType
    effective_date:     date
    announcement_date:  date
    availability_date:  date
    adjustment_factor:  Optional[float] = None   # None = unknown / not applicable
    raw_numerator:      Optional[int]   = None
    raw_denominator:    Optional[int]   = None
    description:        str = ""
    source:             str = "UNKNOWN"
    new_symbol:         Optional[str] = None     # for SYMBOL_CHANGE actions

    def was_known_at(self, query_date: date) -> bool:
        """True if this action was publicly known (announced) by query_date."""
        return self.announcement_date <= query_date

    def was_available_at(self, query_date: date) -> bool:
        """True if AlphaForge had this data by query_date."""
        return self.availability_date <= query_date

    def was_effective_at(self, query_date: date) -> bool:
        """True if this action had taken effect by query_date."""
        return self.effective_date <= query_date

    def to_dict(self) -> dict:
        return {
            "symbol":           self.symbol,
            "actionType":       self.action_type.value,
            "effectiveDate":    str(self.effective_date),
            "announcementDate": str(self.announcement_date),
            "availabilityDate": str(self.availability_date),
            "adjustmentFactor": self.adjustment_factor,
            "description":      self.description,
            "source":           self.source,
        }


# ── PriceAdjustmentResult ─────────────────────────────────────────────────────

@dataclass
class PriceAdjustmentResult:
    """Result of a price adjustment query."""

    symbol:            str
    query_date:        date
    raw_price:         Optional[float]
    adjusted_price:    Optional[float]
    adjustment_factor: Optional[float]
    status:            AdjustmentStatus
    actions_applied:   list[str] = field(default_factory=list)
    notes:             str = ""

    @property
    def price(self) -> Optional[float]:
        """Return adjusted price if available, else raw price."""
        if self.status == AdjustmentStatus.ADJUSTED:
            return self.adjusted_price
        return self.raw_price

    def to_dict(self) -> dict:
        return {
            "symbol":           self.symbol,
            "queryDate":        str(self.query_date),
            "rawPrice":         self.raw_price,
            "adjustedPrice":    self.adjusted_price,
            "adjustmentFactor": self.adjustment_factor,
            "status":           self.status.value,
            "actionsApplied":   self.actions_applied,
            "notes":            self.notes,
        }


# ── CorporateActionStore ──────────────────────────────────────────────────────

class CorporateActionStore:
    """
    Point-in-time corporate action store for ML training.

    Current state: DATA_UNAVAILABLE for all queries.
    AlphaForge does not yet maintain a historical corporate-action database.

    When data becomes available, populate via register_action() and the
    get_* methods will return actual adjustment factors.

    Usage
    -----
    ::
        store = CorporateActionStore.empty()
        result = store.get_adjusted_price("RELIANCE", date(2023, 6, 1), raw_close=2500.0)
        if result.status == AdjustmentStatus.DATA_UNAVAILABLE:
            # Use raw price; document limitation
            price = result.raw_price
    """

    VERSION = "DATA_UNAVAILABLE"

    def __init__(self) -> None:
        self._actions: list[CorporateActionRecord] = []
        # Index: symbol → sorted list of records by effective_date
        self._index: dict[str, list[CorporateActionRecord]] = {}

    @classmethod
    def empty(cls) -> "CorporateActionStore":
        """Create an empty store (DATA_UNAVAILABLE for all queries)."""
        return cls()

    def register_action(self, action: CorporateActionRecord) -> None:
        """Register a corporate action record."""
        sym = action.symbol.upper()
        self._actions.append(action)
        self._index.setdefault(sym, []).append(action)
        self._index[sym].sort(key=lambda a: a.effective_date)
        logger.info(
            "corporate_action_registered",
            symbol=sym,
            action_type=action.action_type.value,
            effective_date=str(action.effective_date),
        )

    def get_actions_for_symbol(
        self,
        symbol: str,
        from_date: Optional[date] = None,
        to_date: Optional[date] = None,
    ) -> list[CorporateActionRecord]:
        """Return all actions for symbol within the date range."""
        sym = symbol.upper()
        actions = self._index.get(sym, [])
        if from_date:
            actions = [a for a in actions if a.effective_date >= from_date]
        if to_date:
            actions = [a for a in actions if a.effective_date <= to_date]
        return actions

    def get_adjusted_price(
        self,
        symbol: str,
        query_date: date,
        raw_price: Optional[float],
        prediction_date: Optional[date] = None,
    ) -> PriceAdjustmentResult:
        """
        Return adjusted price for symbol on query_date.

        Parameters
        ----------
        symbol          : NSE trading symbol.
        query_date      : The historical date of the raw price observation.
        raw_price       : The raw (unadjusted) price.
        prediction_date : The date at which the ML model is making predictions.
                          Corporate actions are only applied if they were announced
                          before prediction_date. Default: same as query_date.

        Returns
        -------
        PriceAdjustmentResult with status=DATA_UNAVAILABLE if no adjustment
        data is available.  The raw_price is always returned as a fallback.
        """
        sym = symbol.upper()
        pred_date = prediction_date or query_date

        # Check if we have any historical data for this symbol
        actions = self._index.get(sym, [])

        if not actions:
            # No data for this symbol at all
            return PriceAdjustmentResult(
                symbol=sym,
                query_date=query_date,
                raw_price=raw_price,
                adjusted_price=None,
                adjustment_factor=None,
                status=AdjustmentStatus.DATA_UNAVAILABLE,
                notes=(
                    "Corporate action data not available for this symbol. "
                    "Raw price returned. Document as limitation in DatasetSnapshot."
                ),
            )

        # Find actions that:
        # 1. Were effective AFTER query_date (so they affect historical prices)
        # 2. Were announced/available before or on prediction_date (model knew about them)
        applicable = [
            a for a in actions
            if a.effective_date > query_date
            and a.was_available_at(pred_date)
            and a.adjustment_factor is not None
        ]

        if not applicable:
            return PriceAdjustmentResult(
                symbol=sym,
                query_date=query_date,
                raw_price=raw_price,
                adjusted_price=raw_price,
                adjustment_factor=1.0,
                status=AdjustmentStatus.NOT_REQUIRED,
                notes="No applicable corporate actions found for this period.",
            )

        # Apply all applicable adjustment factors cumulatively
        cumulative_factor = 1.0
        applied_actions = []
        for action in applicable:
            if action.adjustment_factor is not None:
                cumulative_factor *= action.adjustment_factor
                applied_actions.append(
                    f"{action.action_type.value}@{action.effective_date}"
                )

        adjusted = raw_price * cumulative_factor if raw_price is not None else None

        return PriceAdjustmentResult(
            symbol=sym,
            query_date=query_date,
            raw_price=raw_price,
            adjusted_price=adjusted,
            adjustment_factor=cumulative_factor,
            status=AdjustmentStatus.ADJUSTED,
            actions_applied=applied_actions,
        )

    def get_symbol_at_date(
        self,
        symbol: str,
        query_date: date,
    ) -> tuple[str, str]:
        """
        Return (current_symbol, canonical_symbol) for symbol on query_date.

        Handles SYMBOL_CHANGE actions so that a symbol renamed after query_date
        is still accessible by its old name.

        Returns (symbol, "NO_CHANGE") when no symbol change is found.
        Returns (new_symbol, "SYMBOL_CHANGE") when the symbol changed after query_date.
        """
        sym = symbol.upper()
        changes = [
            a for a in self._index.get(sym, [])
            if a.action_type == CorporateActionType.SYMBOL_CHANGE
            and a.effective_date > query_date
            and a.new_symbol is not None
        ]
        if not changes:
            return sym, "NO_CHANGE"
        # Use the earliest change after query_date
        change = min(changes, key=lambda a: a.effective_date)
        return change.new_symbol.upper(), "SYMBOL_CHANGE"  # type: ignore[union-attr]

    @property
    def has_data(self) -> bool:
        return len(self._actions) > 0

    @property
    def version(self) -> str:
        return "with-data-v1" if self.has_data else self.VERSION

    @property
    def symbol_count(self) -> int:
        return len(self._index)
