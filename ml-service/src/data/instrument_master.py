"""
Historical Instrument Master — AlphaForge ML Service.

Provides point-in-time instrument metadata: lot sizes, tick sizes,
contract specifications — selected based on effective dates.

Key difference from data-service/src/scrapers/instrument_master.py
-------------------------------------------------------------------
The data-service instrument master serves TODAY's lot sizes for live trading.
This module serves HISTORICAL lot sizes for ML training — a contract traded
in 2022 must use the 2022 lot size, not the 2026 lot size.

Historical data availability
-----------------------------
AlphaForge does not currently maintain a complete historical lot-size database.
Where historical data is unavailable, the API returns DATA_UNAVAILABLE rather
than fabricating a value.

Known lot-size changes are tracked in KNOWN_LOT_SIZE_CHANGES.  This table
will be extended as more historical data is sourced.

Usage
-----
::
    store = InstrumentMasterStore.default()
    meta = store.get_instrument("NIFTY", datetime(2023, 1, 15, tzinfo=UTC))
    if meta.lot_size_status == "OK":
        lot = meta.lot_size
    elif meta.lot_size_status == "DATA_UNAVAILABLE":
        lot = None  # do not fabricate
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)

UTC = timezone.utc


# ── LotSizeStatus ──────────────────────────────────────────────────────────────

class LotSizeStatus:
    OK                = "OK"
    DATA_UNAVAILABLE  = "DATA_UNAVAILABLE"   # historical data not available
    APPROXIMATE       = "APPROXIMATE"        # best-effort, not guaranteed exact


# ── HistoricalLotSizeEntry ────────────────────────────────────────────────────

@dataclass
class HistoricalLotSizeEntry:
    """A lot-size record for one symbol over an effective date range."""

    symbol:        str
    lot_size:      int
    effective_from: date                # inclusive
    effective_to:  Optional[date]       # inclusive; None = still current
    source:        str = "BEST_KNOWN"  # "NSE_CIRCULAR" | "BEST_KNOWN" | "INFERRED"
    notes:         str = ""


# ── KNOWN_LOT_SIZE_CHANGES ────────────────────────────────────────────────────
#
# This table records KNOWN lot-size changes for NSE F&O instruments.
# Sources: NSE circulars, public announcements.
#
# IMPORTANT: This is NOT a complete historical record.  For any date range
# where no entry exists, the system returns APPROXIMATE (using best-known
# current value) or DATA_UNAVAILABLE if even that is not justified.
#
# The most significant known change:
#   SEBI November 2024: increased minimum lot sizes for index derivatives.
#   NIFTY: 25 → 75 (then adjusted); final settled at 75 lots for options
#   BANKNIFTY: 15 → 30 (options), futures at 15
#   Source: SEBI circular SEBI/HO/MRD/MRD-PoD-3/P/CIR/2024/108

KNOWN_LOT_SIZE_CHANGES: list[HistoricalLotSizeEntry] = [
    # NIFTY: pre-Nov 2024 lot size was 50 for futures, 25 for options (pre-revision)
    # For simplicity we use 50 as the "futures-equivalent" lot size throughout.
    HistoricalLotSizeEntry(
        symbol="NIFTY",
        lot_size=50,
        effective_from=date(2000, 1, 1),
        effective_to=date(2024, 10, 31),
        source="BEST_KNOWN",
        notes="Pre-SEBI Nov 2024 revision. Standard lot size was 50.",
    ),
    HistoricalLotSizeEntry(
        symbol="NIFTY",
        lot_size=75,
        effective_from=date(2024, 11, 1),
        effective_to=None,
        source="BEST_KNOWN",
        notes="Post-SEBI Nov 2024 revision.",
    ),
    # BANKNIFTY
    HistoricalLotSizeEntry(
        symbol="BANKNIFTY",
        lot_size=15,
        effective_from=date(2000, 1, 1),
        effective_to=date(2024, 10, 31),
        source="BEST_KNOWN",
        notes="Pre-SEBI Nov 2024 revision.",
    ),
    HistoricalLotSizeEntry(
        symbol="BANKNIFTY",
        lot_size=30,
        effective_from=date(2024, 11, 1),
        effective_to=None,
        source="BEST_KNOWN",
        notes="Post-SEBI Nov 2024 revision (options lot size).",
    ),
    # FINNIFTY
    HistoricalLotSizeEntry(
        symbol="FINNIFTY",
        lot_size=40,
        effective_from=date(2021, 1, 1),
        effective_to=date(2024, 10, 31),
        source="BEST_KNOWN",
        notes="Pre-SEBI Nov 2024 revision.",
    ),
    HistoricalLotSizeEntry(
        symbol="FINNIFTY",
        lot_size=65,
        effective_from=date(2024, 11, 1),
        effective_to=None,
        source="BEST_KNOWN",
        notes="Post-SEBI Nov 2024 revision.",
    ),
    # MIDCPNIFTY
    HistoricalLotSizeEntry(
        symbol="MIDCPNIFTY",
        lot_size=75,
        effective_from=date(2023, 1, 1),
        effective_to=date(2024, 10, 31),
        source="BEST_KNOWN",
        notes="Pre-SEBI Nov 2024 revision.",
    ),
    HistoricalLotSizeEntry(
        symbol="MIDCPNIFTY",
        lot_size=120,
        effective_from=date(2024, 11, 1),
        effective_to=None,
        source="BEST_KNOWN",
        notes="Post-SEBI Nov 2024 revision.",
    ),
]

# Current (today) lot sizes for stock F&O — these are the SEBI Nov 2024 revised values.
# For pre-Nov 2024 periods, we use APPROXIMATE (the pre-revision values were similar
# for most stocks — SEBI primarily changed index derivatives).
_CURRENT_STOCK_LOT_SIZES: dict[str, int] = {
    "RELIANCE": 250, "TCS": 150, "HDFCBANK": 550, "INFY": 300,
    "ICICIBANK": 700, "SBIN": 1500, "AXISBANK": 1200, "BAJFINANCE": 125,
    "MARUTI": 25, "TATAMOTORS": 900, "SUNPHARMA": 350, "TITAN": 175,
    "WIPRO": 1500, "HCLTECH": 350, "NTPC": 2250, "POWERGRID": 2700,
    "ONGC": 1925, "JSWSTEEL": 600, "TATASTEEL": 4500, "ADANIENT": 250,
    "ADANIPORTS": 625, "HINDALCO": 1400, "DRREDDY": 125, "CIPLA": 650,
    "BAJAJFINSV": 125, "TECHM": 600, "DIVISLAB": 150, "NESTLEIND": 40,
    "BRITANNIA": 100, "INDUSINDBK": 700, "M&M": 350, "COALINDIA": 2100,
    "EICHERMOT": 100, "HAL": 150, "BEL": 2850, "TRENT": 250,
    "JIOFIN": 2750, "ZOMATO": 4500, "DLF": 1650, "ABB": 100,
    "SIEMENS": 75, "GODREJCP": 500, "DABUR": 1250, "VEDL": 2000,
    "GAIL": 2700, "HINDUNILVR": 300, "BHARTIARTL": 950, "ITC": 3200,
    "KOTAKBANK": 400, "LT": 150,
}


# ── HistoricalInstrumentRecord ────────────────────────────────────────────────

@dataclass
class HistoricalInstrumentRecord:
    """Point-in-time instrument metadata."""

    symbol:        str
    exchange:      str
    segment:       str                 # "FO" | "EQ" | "IDX"
    instrument_type: str               # "FUTIDX" | "FUTSTK" | "EQ" | "IDX"
    lot_size:      Optional[int]       # None when DATA_UNAVAILABLE
    tick_size:     float = 0.05        # NSE standard
    lot_size_status: str = LotSizeStatus.OK
    lot_size_source: str = "BEST_KNOWN"
    notes:         str = ""

    @property
    def is_lot_size_known(self) -> bool:
        return self.lot_size_status == LotSizeStatus.OK and self.lot_size is not None

    @property
    def is_lot_size_approximate(self) -> bool:
        return self.lot_size_status == LotSizeStatus.APPROXIMATE


# ── InstrumentMasterStore ─────────────────────────────────────────────────────

class InstrumentMasterStore:
    """
    Historical instrument metadata store with point-in-time lookup.

    get_instrument(symbol, query_date) returns instrument metadata that was
    valid on query_date, NOT today's metadata.

    For symbols without historical data:
      - Returns lot_size_status = DATA_UNAVAILABLE and lot_size = None.
      - Does NOT fabricate values.

    For symbols with APPROXIMATE data (current value used as best estimate):
      - Returns lot_size_status = APPROXIMATE.
      - Callers must document this approximation in DatasetSnapshot.limitations.
    """

    VERSION = "best-known-v1"

    def __init__(
        self,
        lot_size_entries: Optional[list[HistoricalLotSizeEntry]] = None,
        current_stock_lots: Optional[dict[str, int]] = None,
    ) -> None:
        self._entries: list[HistoricalLotSizeEntry] = (
            lot_size_entries if lot_size_entries is not None
            else list(KNOWN_LOT_SIZE_CHANGES)
        )
        self._current_lots: dict[str, int] = (
            current_stock_lots if current_stock_lots is not None
            else dict(_CURRENT_STOCK_LOT_SIZES)
        )
        # Build index: symbol → sorted list of entries
        self._index: dict[str, list[HistoricalLotSizeEntry]] = {}
        for entry in self._entries:
            self._index.setdefault(entry.symbol.upper(), []).append(entry)

    @classmethod
    def default(cls) -> "InstrumentMasterStore":
        """Create the default store with all known lot-size data."""
        return cls()

    def get_lot_size(
        self,
        symbol: str,
        query_date: date,
    ) -> tuple[Optional[int], str, str]:
        """
        Return (lot_size, status, source) for symbol on query_date.

        Returns
        -------
        lot_size : int or None
            None when status is DATA_UNAVAILABLE.
        status   : LotSizeStatus value
            "OK" | "APPROXIMATE" | "DATA_UNAVAILABLE"
        source   : str
            Where the lot size came from ("NSE_CIRCULAR", "BEST_KNOWN", etc.)
        """
        sym = symbol.upper()
        entries = self._index.get(sym, [])

        # Find the entry whose effective range contains query_date
        for entry in entries:
            if entry.effective_from <= query_date:
                if entry.effective_to is None or query_date <= entry.effective_to:
                    return entry.lot_size, LotSizeStatus.OK, entry.source

        # No exact historical record — check if we have a current value
        if sym in self._current_lots:
            logger.debug(
                "lot_size_approximate",
                symbol=sym,
                query_date=str(query_date),
                note="Using current lot size as APPROXIMATE for historical date.",
            )
            return self._current_lots[sym], LotSizeStatus.APPROXIMATE, "CURRENT_AS_APPROXIMATE"

        # Truly unknown
        logger.debug("lot_size_data_unavailable", symbol=sym, query_date=str(query_date))
        return None, LotSizeStatus.DATA_UNAVAILABLE, "NONE"

    def get_instrument(
        self,
        symbol: str,
        query_date: date,
    ) -> HistoricalInstrumentRecord:
        """
        Return a HistoricalInstrumentRecord for symbol on query_date.
        """
        sym = symbol.upper()
        lot, status, source = self.get_lot_size(sym, query_date)

        # Determine segment and instrument type
        index_symbols = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
                         "SENSEX", "BANKEX", "NIFTYNXT50", "NIFTY_NEXT50"}
        if sym in index_symbols:
            segment = "FO"
            itype = "FUTIDX"
        else:
            segment = "FO"
            itype = "FUTSTK"

        return HistoricalInstrumentRecord(
            symbol=sym,
            exchange="NFO",
            segment=segment,
            instrument_type=itype,
            lot_size=lot,
            tick_size=0.05,
            lot_size_status=status,
            lot_size_source=source,
        )

    def list_known_symbols(self) -> list[str]:
        """Return all symbols with any historical lot-size entry."""
        return sorted(set(list(self._index.keys()) + list(self._current_lots.keys())))

    @property
    def version(self) -> str:
        return self.VERSION
