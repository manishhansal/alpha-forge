"""
Historical F&O Universe — AlphaForge ML Service.

Provides point-in-time universe membership answering:
  "Which instruments were eligible for the AlphaForge F&O universe at timestamp T?"

Five independent boolean dimensions
------------------------------------
FO_ELIGIBLE   — NSE has published this symbol in the F&O lot-size file
                 for the given date (quarterly revision).
FO_BANNED     — symbol is currently in the MWPL >95% ban list for this date.
TRADABLE      — FO_ELIGIBLE AND NOT FO_BANNED
DATA_AVAILABLE — we have OHLCV + derivatives data for this symbol on this date.
LIQUID        — sufficient volume/OI for the model (heuristic threshold).
MODEL_ELIGIBLE — TRADABLE AND DATA_AVAILABLE AND LIQUID

These dimensions are NOT collapsed into a single boolean.  Callers must
check the dimension they care about.

Data availability policy
-------------------------
Historical F&O eligibility per date: DATA_UNAVAILABLE
Historical MWPL ban state per date:  DATA_UNAVAILABLE

Where data is unavailable:
  - FO_ELIGIBLE returns AvailabilityValue.DATA_UNAVAILABLE (not True/False)
  - FO_BANNED returns AvailabilityValue.DATA_UNAVAILABLE
  - TRADABLE is DATA_UNAVAILABLE if either FO_ELIGIBLE or FO_BANNED is DATA_UNAVAILABLE
  - MODEL_ELIGIBLE is DATA_UNAVAILABLE conservatively when any input is DATA_UNAVAILABLE
  
The calling code (data_pipeline.py) uses CURRENT_UNIVERSE as a fallback with
a WARNING logged and a limitation recorded in the DatasetSnapshot.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from enum import Enum
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)

UTC = timezone.utc


# ── AvailabilityValue ─────────────────────────────────────────────────────────

class AvailabilityValue(str, Enum):
    """
    A three-valued boolean for point-in-time universe fields.

    TRUE             — confirmed eligible/tradable/available
    FALSE            — confirmed NOT eligible/tradable/available
    DATA_UNAVAILABLE — historical data not available; cannot determine
    """
    TRUE             = "TRUE"
    FALSE            = "FALSE"
    DATA_UNAVAILABLE = "DATA_UNAVAILABLE"

    @property
    def is_known(self) -> bool:
        return self != AvailabilityValue.DATA_UNAVAILABLE

    @property
    def is_true(self) -> bool:
        return self == AvailabilityValue.TRUE

    @property
    def is_false(self) -> bool:
        return self == AvailabilityValue.FALSE


# ── UniverseMembership ────────────────────────────────────────────────────────

@dataclass
class UniverseMembership:
    """
    Point-in-time universe membership for one symbol on one date.

    Attributes
    ----------
    symbol          : Trading symbol (NSE uppercase).
    query_date      : The date for which membership was queried.
    fo_eligible     : In NSE F&O eligibility list on this date.
    fo_banned       : In NSE MWPL ban list on this date.
    tradable        : fo_eligible AND NOT fo_banned.
    data_available  : OHLCV and/or derivatives data exists for this date.
    liquid          : Passes the minimum volume/OI liquidity threshold.
    model_eligible  : All of the above are TRUE.
    notes           : Explanation for any DATA_UNAVAILABLE fields.
    """

    symbol:         str
    query_date:     date
    fo_eligible:    AvailabilityValue
    fo_banned:      AvailabilityValue
    tradable:       AvailabilityValue
    data_available: AvailabilityValue
    liquid:         AvailabilityValue
    model_eligible: AvailabilityValue
    notes:          str = ""

    def to_dict(self) -> dict:
        return {
            "symbol":         self.symbol,
            "queryDate":      str(self.query_date),
            "fo_eligible":    self.fo_eligible.value,
            "fo_banned":      self.fo_banned.value,
            "tradable":       self.tradable.value,
            "data_available": self.data_available.value,
            "liquid":         self.liquid.value,
            "model_eligible": self.model_eligible.value,
            "notes":          self.notes,
        }

    @property
    def is_safe_to_use(self) -> bool:
        """
        True when it is safe to include this symbol in a training dataset.
        Requires model_eligible == TRUE (all dimensions known and positive).
        """
        return self.model_eligible == AvailabilityValue.TRUE

    @property
    def needs_warning(self) -> bool:
        """True when any dimension is DATA_UNAVAILABLE (use with caution)."""
        dims = [self.fo_eligible, self.fo_banned, self.data_available,
                self.liquid, self.model_eligible]
        return any(d == AvailabilityValue.DATA_UNAVAILABLE for d in dims)


# ── HistoricalUniverse ────────────────────────────────────────────────────────

class HistoricalUniverse:
    """
    Point-in-time F&O universe.

    For any query date T, returns UniverseMembership for each symbol
    based on what was known at time T.

    Current limitations (DATA_UNAVAILABLE policy)
    -----------------------------------------------
    This implementation uses today's TRAINING_UNIVERSE as a fallback because
    historical F&O eligibility records per date are not yet stored in AlphaForge.
    ALL queries return FO_ELIGIBLE = DATA_UNAVAILABLE with a warning.
    The model_eligible dimension falls back to DATA_UNAVAILABLE for strict mode,
    or APPROXIMATE in lenient mode (used for research).

    When full historical data becomes available:
      - Load eligibility records from a database / CSV snapshot
      - Return TRUE/FALSE per symbol per date
      - Remove the DATA_UNAVAILABLE fallback

    Usage
    -----
    ::
        universe = HistoricalUniverse.default()
        members = universe.get_universe(date(2023, 1, 15))
        eligible = [m for m in members if m.model_eligible.is_true]

    ::
        membership = universe.get_membership("RELIANCE", date(2023, 1, 15))
        if membership.model_eligible == AvailabilityValue.TRUE:
            # safe to include
            ...
    """

    VERSION = "static-v1"

    # Current F&O universe — used as fallback when historical data is absent.
    # This is the same TRAINING_UNIVERSE from data_pipeline.py, reproduced here
    # so the data package is self-contained.
    _CURRENT_UNIVERSE: frozenset[str] = frozenset({
        "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
        "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR",
        "SBIN", "BHARTIARTL", "ITC", "KOTAKBANK", "LT", "AXISBANK",
        "BAJFINANCE", "MARUTI", "TATAMOTORS", "SUNPHARMA", "TITAN",
        "WIPRO", "HCLTECH", "NTPC", "POWERGRID", "ONGC", "JSWSTEEL",
        "TATASTEEL", "ADANIENT", "ADANIPORTS", "HINDALCO", "DRREDDY",
        "CIPLA", "BAJAJFINSV", "TECHM", "DIVISLAB", "NESTLEIND",
        "BRITANNIA", "INDUSINDBK", "M&M", "COALINDIA", "EICHERMOT",
        "HAL", "BEL", "TRENT", "JIOFIN", "ZOMATO", "DLF",
        "ABB", "SIEMENS", "GODREJCP", "DABUR", "VEDL", "GAIL",
    })

    # Minimum liquidity thresholds
    _MIN_VOLUME = 100_000        # minimum daily volume
    _MIN_OI = 0                  # minimum OI (0 = any OI present)

    def __init__(
        self,
        strict_mode: bool = False,
        current_universe: Optional[frozenset[str]] = None,
    ) -> None:
        """
        Parameters
        ----------
        strict_mode
            If True, DATA_UNAVAILABLE for fo_eligible → model_eligible = DATA_UNAVAILABLE.
            If False (default, research mode), DATA_UNAVAILABLE for fo_eligible →
            assume symbol is in universe (use current list as approximation).
        current_universe
            Override the default universe set.
        """
        self._strict = strict_mode
        self._current = current_universe or self._CURRENT_UNIVERSE
        self._historical_eligibility: dict[tuple[str, date], bool] = {}
        self._historical_bans: dict[tuple[str, date], bool] = {}

    @classmethod
    def default(cls) -> "HistoricalUniverse":
        return cls(strict_mode=False)

    @classmethod
    def strict(cls) -> "HistoricalUniverse":
        """Strict mode: DATA_UNAVAILABLE observations are excluded from training."""
        return cls(strict_mode=True)

    def register_eligibility(
        self,
        symbol: str,
        eligible_from: date,
        eligible_to: Optional[date],
    ) -> None:
        """Register a known eligibility period for a symbol."""
        # For now, store as a simple entry.
        # In a full implementation this would be a temporal database.
        self._historical_eligibility[(symbol.upper(), eligible_from)] = True

    def get_membership(
        self,
        symbol: str,
        query_date: date,
        volume: Optional[float] = None,
        open_interest: Optional[float] = None,
    ) -> UniverseMembership:
        """
        Return UniverseMembership for symbol on query_date.

        Parameters
        ----------
        symbol      : NSE trading symbol (case-insensitive).
        query_date  : The historical date being queried.
        volume      : Daily volume for liquidity check (optional).
        open_interest: Daily OI for liquidity check (optional).
        """
        sym = symbol.upper()
        notes_parts: list[str] = []

        # ── FO_ELIGIBLE ───────────────────────────────────────────────────────
        # Historical eligibility data not available — return DATA_UNAVAILABLE
        # but note whether it is in the current universe as a hint.
        if self._strict:
            fo_eligible = AvailabilityValue.DATA_UNAVAILABLE
            notes_parts.append(
                "fo_eligible=DATA_UNAVAILABLE: historical F&O eligibility per date "
                "is not stored. Use HistoricalUniverse.default() for research mode."
            )
        else:
            # Research/lenient mode: use current universe as approximation
            if sym in self._current:
                fo_eligible = AvailabilityValue.TRUE
                notes_parts.append(
                    "fo_eligible=TRUE (APPROXIMATE): using current F&O list; "
                    "historical eligibility per date is DATA_UNAVAILABLE."
                )
            else:
                fo_eligible = AvailabilityValue.FALSE

        # ── FO_BANNED ─────────────────────────────────────────────────────────
        # Historical ban state not available
        fo_banned = AvailabilityValue.DATA_UNAVAILABLE
        notes_parts.append(
            "fo_banned=DATA_UNAVAILABLE: historical MWPL ban state per date "
            "is not stored in AlphaForge."
        )

        # ── TRADABLE ──────────────────────────────────────────────────────────
        # Can only be TRUE if fo_eligible=TRUE and fo_banned=FALSE.
        if fo_eligible == AvailabilityValue.TRUE and fo_banned == AvailabilityValue.FALSE:
            tradable = AvailabilityValue.TRUE
        elif fo_eligible == AvailabilityValue.FALSE:
            tradable = AvailabilityValue.FALSE
        else:
            # Any DATA_UNAVAILABLE input → tradable is DATA_UNAVAILABLE
            tradable = AvailabilityValue.DATA_UNAVAILABLE

        # ── DATA_AVAILABLE ────────────────────────────────────────────────────
        # We cannot verify historical data availability at query time here.
        # The data pipeline sets this after actually loading the data.
        # Default to DATA_UNAVAILABLE; pipeline sets TRUE when data is loaded.
        data_available = AvailabilityValue.DATA_UNAVAILABLE

        # ── LIQUID ────────────────────────────────────────────────────────────
        if volume is None and open_interest is None:
            liquid = AvailabilityValue.DATA_UNAVAILABLE
        elif volume is not None and volume >= self._MIN_VOLUME:
            liquid = AvailabilityValue.TRUE
        elif volume is not None:
            liquid = AvailabilityValue.FALSE
        else:
            liquid = AvailabilityValue.DATA_UNAVAILABLE

        # ── MODEL_ELIGIBLE ────────────────────────────────────────────────────
        model_eligible = _compute_model_eligible(
            tradable, data_available, liquid, self._strict
        )

        return UniverseMembership(
            symbol=sym,
            query_date=query_date,
            fo_eligible=fo_eligible,
            fo_banned=fo_banned,
            tradable=tradable,
            data_available=data_available,
            liquid=liquid,
            model_eligible=model_eligible,
            notes=" | ".join(notes_parts) if notes_parts else "",
        )

    def get_universe(
        self,
        query_date: date,
    ) -> list[UniverseMembership]:
        """
        Return UniverseMembership for all known symbols on query_date.
        """
        return [
            self.get_membership(sym, query_date)
            for sym in sorted(self._current)
        ]

    def get_model_eligible_symbols(
        self,
        query_date: date,
        include_approximate: bool = True,
    ) -> list[str]:
        """
        Return symbols that are (or appear to be) model-eligible on query_date.

        Parameters
        ----------
        include_approximate
            If True (default), include symbols where model_eligible is
            DATA_UNAVAILABLE but fo_eligible is TRUE (APPROXIMATE).
            Log a WARNING about the approximation.
        """
        members = self.get_universe(query_date)
        result = []
        approx = []
        for m in members:
            if m.model_eligible == AvailabilityValue.TRUE:
                result.append(m.symbol)
            elif (
                include_approximate
                and m.fo_eligible == AvailabilityValue.TRUE
                and m.model_eligible == AvailabilityValue.DATA_UNAVAILABLE
            ):
                approx.append(m.symbol)

        if approx:
            logger.warning(
                "universe_approximation",
                query_date=str(query_date),
                n_approximate=len(approx),
                note="Historical F&O eligibility data unavailable; using current list as approximation.",
            )
            result.extend(approx)

        return result

    def get_fno_state(
        self,
        symbol: str,
        query_date: date,
    ) -> dict:
        """
        Compatibility API: return a dict describing the F&O state on query_date.
        """
        m = self.get_membership(symbol, query_date)
        return {
            "symbol":       m.symbol,
            "queryDate":    str(m.query_date),
            "fo_eligible":  m.fo_eligible.value,
            "fo_banned":    m.fo_banned.value,
            "tradable":     m.tradable.value,
        }

    @property
    def version(self) -> str:
        return self.VERSION

    @property
    def known_symbol_count(self) -> int:
        return len(self._current)


# ── Helper ─────────────────────────────────────────────────────────────────────

def _compute_model_eligible(
    tradable: AvailabilityValue,
    data_available: AvailabilityValue,
    liquid: AvailabilityValue,
    strict: bool,
) -> AvailabilityValue:
    """Compute MODEL_ELIGIBLE from the three input dimensions."""
    if tradable == AvailabilityValue.FALSE:
        return AvailabilityValue.FALSE
    if data_available == AvailabilityValue.FALSE:
        return AvailabilityValue.FALSE
    if liquid == AvailabilityValue.FALSE:
        return AvailabilityValue.FALSE

    # All three are either TRUE or DATA_UNAVAILABLE
    if (tradable == AvailabilityValue.TRUE
            and data_available == AvailabilityValue.TRUE
            and liquid == AvailabilityValue.TRUE):
        return AvailabilityValue.TRUE

    # At least one is DATA_UNAVAILABLE
    if strict:
        return AvailabilityValue.DATA_UNAVAILABLE
    else:
        # Lenient: if tradable is TRUE (APPROXIMATE) and data_available is
        # DATA_UNAVAILABLE (will be set by pipeline), return DATA_UNAVAILABLE
        # rather than FALSE.
        return AvailabilityValue.DATA_UNAVAILABLE
