"""
F&O Ban and MWPL State — AlphaForge ML Service.

Provides historical F&O ban status and Market-Wide Position Limit (MWPL)
state for NSE F&O instruments.

F&O ban mechanics
-----------------
When a stock's total open interest across all market participants exceeds
95% of the Market-Wide Position Limit (MWPL = 20% of free-float supply):

  - The stock enters the F&O BAN list.
  - Only CLOSING POSITIONS are allowed (no new positions).
  - The OI data during ban shows artificial decline (only unwinds, no new builds).
  - PCR and other OI-derived signals are unreliable during ban.

The ban is lifted when OI falls below 80% of MWPL.

NSE publishes the daily F&O ban list at the end of every trading day.

Data availability
-----------------
AlphaForge does NOT currently maintain a historical F&O ban list database.
All historical queries return BanStatus.DATA_UNAVAILABLE.

For live trading, the ban list must be fetched from NSE daily.
For historical research, the absence of ban data means:
  - We CANNOT guarantee an observation was tradable on a given date.
  - We document this limitation in DatasetSnapshot.limitations.
  - We do NOT fabricate ban states.

MWPL state (MWPL_NORMAL, MWPL_WARNING, MWPL_BAN) is also DATA_UNAVAILABLE.

When data becomes available:
  - Implement a persistent store (Postgres or parquet snapshots).
  - Load daily ban lists from NSE historical archives.
  - Remove DATA_UNAVAILABLE returns.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import Enum
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)


# ── BanStatus ─────────────────────────────────────────────────────────────────

class BanStatus(str, Enum):
    """F&O ban state for a symbol on a given date."""
    NOT_BANNED       = "NOT_BANNED"       # confirmed not in ban list
    BANNED           = "BANNED"           # confirmed in ban list (only closing allowed)
    DATA_UNAVAILABLE = "DATA_UNAVAILABLE" # historical data not available


# ── MWPLState ─────────────────────────────────────────────────────────────────

class MWPLState(str, Enum):
    """MWPL utilisation level."""
    NORMAL           = "NORMAL"           # OI < 80% of MWPL
    WARNING          = "WARNING"          # OI 80-95% of MWPL (approaching ban)
    BANNED           = "BANNED"           # OI > 95% of MWPL (ban triggered)
    DATA_UNAVAILABLE = "DATA_UNAVAILABLE" # historical data not available


# ── FnOEligibilityRecord ──────────────────────────────────────────────────────

@dataclass
class FnOEligibilityRecord:
    """
    NSE F&O eligibility record for a symbol with effective dates.

    Represents a period during which a symbol was F&O-eligible on NSE.
    NSE revises the F&O eligibility list quarterly (Jan, Apr, Jul, Oct).

    Fields
    ------
    symbol         : NSE trading symbol (uppercase).
    eligible_from  : First date this symbol was F&O-eligible (inclusive).
    eligible_to    : Last date this symbol was F&O-eligible (inclusive).
                     None means still eligible as of the latest known date.
    source         : How this record was created.
    lot_size       : Lot size during this eligibility period.
    notes          : e.g. "Removed Oct 2024 quarterly revision".
    """
    symbol:        str
    eligible_from: date
    eligible_to:   Optional[date]
    source:        str = "BEST_KNOWN"
    lot_size:      Optional[int] = None
    notes:         str = ""

    def was_eligible_on(self, query_date: date) -> bool:
        """True if this record covers query_date."""
        if query_date < self.eligible_from:
            return False
        if self.eligible_to is not None and query_date > self.eligible_to:
            return False
        return True


# ── FnOBanRecord ──────────────────────────────────────────────────────────────

@dataclass
class FnOBanRecord:
    """
    A single day's F&O ban entry for one symbol.

    Fields
    ------
    symbol     : NSE trading symbol (uppercase).
    ban_date   : Date when the ban was active.
    mwpl_pct   : MWPL utilisation percentage on this date (0-100).
                 None if MWPL % data is not available.
    source     : "NSE_DAILY_CIRCULAR" | "BEST_KNOWN" | "INFERRED"
    """
    symbol:    str
    ban_date:  date
    mwpl_pct:  Optional[float] = None
    source:    str = "UNKNOWN"

    def to_dict(self) -> dict:
        return {
            "symbol":   self.symbol,
            "banDate":  str(self.ban_date),
            "mwplPct":  self.mwpl_pct,
            "source":   self.source,
        }


# ── FnOStateResult ────────────────────────────────────────────────────────────

@dataclass
class FnOStateResult:
    """Result of an F&O state query for one symbol on one date."""

    symbol:           str
    query_date:       date
    ban_status:       BanStatus
    mwpl_state:       MWPLState
    mwpl_utilisation: Optional[float]  # 0.0-100.0, None if DATA_UNAVAILABLE
    is_tradable:      Optional[bool]   # None if DATA_UNAVAILABLE
    notes:            str = ""

    def to_dict(self) -> dict:
        return {
            "symbol":          self.symbol,
            "queryDate":       str(self.query_date),
            "banStatus":       self.ban_status.value,
            "mwplState":       self.mwpl_state.value,
            "mwplUtilisation": self.mwpl_utilisation,
            "isTradable":      self.is_tradable,
            "notes":           self.notes,
        }


# ── FnOStateStore ─────────────────────────────────────────────────────────────

class FnOStateStore:
    """
    Historical F&O state store with point-in-time lookup.

    Current state: DATA_UNAVAILABLE for all historical queries.
    See module docstring for full rationale.

    Usage
    -----
    ::
        store = FnOStateStore.empty()
        state = store.get_fno_state("RELIANCE", date(2023, 6, 1))
        if state.ban_status == BanStatus.DATA_UNAVAILABLE:
            # Cannot confirm tradability; document in DatasetSnapshot
            ...
    """

    VERSION = "DATA_UNAVAILABLE"

    def __init__(self) -> None:
        # symbol → list[FnOBanRecord] sorted by ban_date
        self._ban_records: dict[str, list[FnOBanRecord]] = {}
        # symbol → list[FnOEligibilityRecord]
        self._eligibility_records: dict[str, list[FnOEligibilityRecord]] = {}

    @classmethod
    def empty(cls) -> "FnOStateStore":
        """Create an empty store (returns DATA_UNAVAILABLE for all queries)."""
        return cls()

    def register_ban(self, record: FnOBanRecord) -> None:
        """Register a single-day ban record."""
        sym = record.symbol.upper()
        self._ban_records.setdefault(sym, []).append(record)
        self._ban_records[sym].sort(key=lambda r: r.ban_date)

    def register_eligibility(self, record: FnOEligibilityRecord) -> None:
        """Register an eligibility period record."""
        sym = record.symbol.upper()
        self._eligibility_records.setdefault(sym, []).append(record)

    def get_ban_status(
        self,
        symbol: str,
        query_date: date,
    ) -> tuple[BanStatus, Optional[float]]:
        """
        Return (BanStatus, mwpl_pct) for symbol on query_date.

        Returns (DATA_UNAVAILABLE, None) when no historical data exists.
        Returns (BANNED, mwpl_pct) when a ban record exists for this date.
        Returns (NOT_BANNED, None) when the date is explicitly not banned
          AND historical data is available for that date.
        """
        sym = symbol.upper()
        records = self._ban_records.get(sym, [])

        if not records:
            return BanStatus.DATA_UNAVAILABLE, None

        for rec in records:
            if rec.ban_date == query_date:
                return BanStatus.BANNED, rec.mwpl_pct

        # We have records for this symbol but not for this specific date.
        # If the date is within the range of known records, it was NOT banned.
        # Otherwise, DATA_UNAVAILABLE.
        known_dates = {r.ban_date for r in records}
        min_known = min(known_dates)
        max_known = max(known_dates)

        if min_known <= query_date <= max_known:
            return BanStatus.NOT_BANNED, None

        return BanStatus.DATA_UNAVAILABLE, None

    def get_fno_state(
        self,
        symbol: str,
        query_date: date,
    ) -> FnOStateResult:
        """Return the complete F&O state for symbol on query_date."""
        sym = symbol.upper()
        ban_status, mwpl_pct = self.get_ban_status(sym, query_date)

        if ban_status == BanStatus.DATA_UNAVAILABLE:
            mwpl_state = MWPLState.DATA_UNAVAILABLE
            is_tradable = None
            notes = (
                "Historical F&O ban state is DATA_UNAVAILABLE for this symbol/date. "
                "AlphaForge does not maintain a historical MWPL ban list database. "
                "Cannot confirm whether this symbol was tradable on this date."
            )
        elif ban_status == BanStatus.BANNED:
            mwpl_state = MWPLState.BANNED
            is_tradable = False
            notes = f"Symbol was in F&O ban list on {query_date}. Only closing positions allowed."
            if mwpl_pct is not None:
                notes += f" MWPL utilisation: {mwpl_pct:.1f}%."
        else:
            mwpl_state = MWPLState.NORMAL
            is_tradable = True
            notes = ""

        return FnOStateResult(
            symbol=sym,
            query_date=query_date,
            ban_status=ban_status,
            mwpl_state=mwpl_state,
            mwpl_utilisation=mwpl_pct,
            is_tradable=is_tradable,
            notes=notes,
        )

    def get_ban_dates_for_symbol(
        self,
        symbol: str,
    ) -> list[date]:
        """Return all known ban dates for a symbol (empty if DATA_UNAVAILABLE)."""
        return [r.ban_date for r in self._ban_records.get(symbol.upper(), [])]

    @property
    def has_ban_data(self) -> bool:
        return len(self._ban_records) > 0

    @property
    def has_eligibility_data(self) -> bool:
        return len(self._eligibility_records) > 0

    @property
    def version(self) -> str:
        if self.has_ban_data:
            return "with-ban-data-v1"
        return self.VERSION
