"""
providers/common/universe.py — Data Foundation V8 §3/§4.

F&O Universe discovery + refresh service.

Discovers the CURRENT NSE F&O equity underlyings dynamically from provider
instrument masters (Angel One ScripMaster / Upstox instrument dump). Produces
a versioned, checksummed universe snapshot with per-symbol lifecycle tracking.

WHAT IS THE UNIVERSE?
  CURRENT NSE F&O EQUITY UNDERLYINGS.

What is NOT in the universe:
  - All NSE equities (too broad)
  - Expired contracts as primary equity universe
  - Random indices or ETFs unless they have active F&O
  - Penny stocks without F&O listing

LIFECYCLE STATUS:
  ACTIVE    — symbol is currently F&O listed
  ADDED     — symbol was added in this refresh vs previous
  REMOVED   — symbol was removed (no longer F&O listed)
  SUSPENDED — symbol is suspended but may re-list
  UNRESOLVED — symbol could not be confirmed from provider data

UNIVERSE VERSIONING:
  Version string: "YYYY-MM-DD-HH:MM:SSZ#provider"
  Checksum: SHA-256 of canonical-sorted constituent list
  Old snapshots are NEVER deleted — immutable historical record.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timezone
from typing import Optional


# ---------------------------------------------------------------------------
# F&O instrument type identifiers
# ---------------------------------------------------------------------------

FNO_EQUITY_TYPES = frozenset({"FUTSTK", "OPTSTK"})      # underlying is equity
FNO_INDEX_TYPES  = frozenset({"FUTIDX", "OPTIDX"})       # underlying is index


# ---------------------------------------------------------------------------
# Universe entry types
# ---------------------------------------------------------------------------

LIFECYCLE_ACTIVE     = "ACTIVE"
LIFECYCLE_ADDED      = "ADDED"
LIFECYCLE_REMOVED    = "REMOVED"
LIFECYCLE_SUSPENDED  = "SUSPENDED"
LIFECYCLE_UNRESOLVED = "UNRESOLVED"


@dataclass
class FnoUniverseEntry:
    """
    One F&O equity/index entry in the universe.
    All broker-specific tokens are stored per provider for cross-referencing.
    """
    symbol:          str
    exchange:        str           = "NSE"
    isin:            Optional[str] = None
    instrumentType:  str           = "EQ"   # "EQ" | "INDEX"
    # Angel One
    angelToken:      Optional[str] = None
    angelSymbol:     Optional[str] = None
    # Upstox
    upstoxKey:       Optional[str] = None
    upstoxSymbol:    Optional[str] = None
    # Lifecycle
    lifecycleStatus: str           = LIFECYCLE_ACTIVE
    firstSeen:       str           = field(default_factory=lambda:
        datetime.now(timezone.utc).isoformat())
    lastSeen:        str           = field(default_factory=lambda:
        datetime.now(timezone.utc).isoformat())
    latestExpiry:    Optional[str] = None
    fnoEligible:     bool          = True

    def canonical_key(self) -> str:
        """Unique key for checksum computation."""
        return f"{self.symbol}:{self.exchange}"

    def to_db_dict(self) -> dict:
        return asdict(self)


@dataclass
class FnoUniverseSnapshot:
    """
    Versioned, immutable F&O universe snapshot.
    Written once on refresh; never mutated.
    """
    universeVersion:   str
    generatedAt:       str
    effectiveFrom:     str            # IST YYYY-MM-DD
    effectiveTo:       Optional[str]  # None = current
    sourceProvider:    str
    checksum:          str
    constituentCount:  int
    fnoEquityCount:    int            = 0
    fnoIndexCount:     int            = 0
    addedCount:        int            = 0
    removedCount:      int            = 0
    suspendedCount:    int            = 0
    unresolvedCount:   int            = 0
    constituents:      list[FnoUniverseEntry] = field(default_factory=list)

    def to_db_dict(self) -> dict:
        d = asdict(self)
        d.pop("constituents", None)  # stored separately
        return d


# ---------------------------------------------------------------------------
# Universe builder
# ---------------------------------------------------------------------------

def compute_universe_checksum(entries: list[FnoUniverseEntry]) -> str:
    """
    Compute a deterministic SHA-256 checksum of the universe entries.
    Sorted by canonical_key() for determinism.
    """
    sorted_keys = sorted(e.canonical_key() for e in entries)
    payload = json.dumps(sorted_keys, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_universe_snapshot(
    source_provider: str,
    entries: list[FnoUniverseEntry],
    previous_entries: Optional[list[FnoUniverseEntry]] = None,
    effective_from: Optional[str] = None,
) -> FnoUniverseSnapshot:
    """
    Build a versioned F&O universe snapshot from a list of resolved entries.

    Parameters
    ----------
    source_provider : str
        The provider whose instrument master was used ("angel_one" | "upstox").
    entries : list[FnoUniverseEntry]
        All resolved F&O entries for this refresh.
    previous_entries : list[FnoUniverseEntry], optional
        Entries from the previous snapshot — used to compute lifecycle deltas.
    effective_from : str, optional
        IST YYYY-MM-DD date from which this universe is effective.
        Defaults to today.
    """
    now = datetime.now(timezone.utc)
    today_ist = _ist_date_str(now)
    version = f"{today_ist}T{now.strftime('%H:%M:%SZ')}#{source_provider}"

    if effective_from is None:
        effective_from = today_ist

    checksum = compute_universe_checksum(entries)

    # Compute lifecycle deltas
    if previous_entries is not None:
        prev_keys = {e.canonical_key() for e in previous_entries}
        curr_keys = {e.canonical_key() for e in entries}
        added_keys = curr_keys - prev_keys
        removed_keys = prev_keys - curr_keys

        for e in entries:
            if e.canonical_key() in added_keys:
                e.lifecycleStatus = LIFECYCLE_ADDED
            else:
                e.lifecycleStatus = LIFECYCLE_ACTIVE

        # Build removed entries from previous snapshot
        removed_map = {e.canonical_key(): e for e in previous_entries}
        for key in removed_keys:
            prev_entry = removed_map[key]
            removed_entry = FnoUniverseEntry(
                symbol=prev_entry.symbol,
                exchange=prev_entry.exchange,
                isin=prev_entry.isin,
                instrumentType=prev_entry.instrumentType,
                angelToken=prev_entry.angelToken,
                upstoxKey=prev_entry.upstoxKey,
                lifecycleStatus=LIFECYCLE_REMOVED,
                fnoEligible=False,
            )
            entries.append(removed_entry)
    else:
        added_keys = set()
        removed_keys = set()

    # Counts
    fno_equity = sum(
        1 for e in entries
        if e.instrumentType == "EQ" and e.lifecycleStatus != LIFECYCLE_REMOVED
    )
    fno_index = sum(
        1 for e in entries
        if e.instrumentType == "INDEX" and e.lifecycleStatus != LIFECYCLE_REMOVED
    )
    added = sum(1 for e in entries if e.lifecycleStatus == LIFECYCLE_ADDED)
    removed = sum(1 for e in entries if e.lifecycleStatus == LIFECYCLE_REMOVED)
    suspended = sum(1 for e in entries if e.lifecycleStatus == LIFECYCLE_SUSPENDED)
    unresolved = sum(1 for e in entries if e.lifecycleStatus == LIFECYCLE_UNRESOLVED)

    return FnoUniverseSnapshot(
        universeVersion=version,
        generatedAt=now.isoformat(),
        effectiveFrom=effective_from,
        effectiveTo=None,
        sourceProvider=source_provider,
        checksum=checksum,
        constituentCount=len([e for e in entries if e.lifecycleStatus != LIFECYCLE_REMOVED]),
        fnoEquityCount=fno_equity,
        fnoIndexCount=fno_index,
        addedCount=added,
        removedCount=removed,
        suspendedCount=suspended,
        unresolvedCount=unresolved,
        constituents=entries,
    )


def extract_fno_equity_underlyings_from_master(
    instrument_master: list[dict],
    provider: str = "angel_one",
) -> list[FnoUniverseEntry]:
    """
    Extract F&O equity underlyings from a raw instrument master entry list.

    Identifies stocks that have active FUTSTK or OPTSTK contracts.
    Returns one entry per unique underlying (the equity spot instrument),
    annotated with the provider-specific token/key.

    Parameters
    ----------
    instrument_master : list[dict]
        Raw instrument master rows. Expected keys vary by provider:
          angel_one: symbol, instrumenttype, isin, token, name
          upstox:    tradingsymbol, instrument_type, isin, instrument_key, name
    provider : str
        "angel_one" | "upstox"
    """
    seen_underlyings: dict[str, FnoUniverseEntry] = {}

    for row in instrument_master:
        try:
            if provider == "angel_one":
                instr_type = str(row.get("instrumenttype", "")).upper()
                symbol = str(row.get("symbol", "")).upper().strip()
                name = str(row.get("name", "")).upper().strip()
                token = str(row.get("token", "")).strip()
                isin = str(row.get("isin", "")).strip() or None
                underlying = _extract_underlying_angel(symbol, instr_type, name)
            elif provider == "upstox":
                instr_type = str(row.get("instrument_type", "")).upper()
                symbol = str(row.get("tradingsymbol", "")).upper().strip()
                name = str(row.get("name", "")).upper().strip()
                key = str(row.get("instrument_key", "")).strip()
                isin = str(row.get("isin", "")).strip() or None
                underlying = _extract_underlying_upstox(symbol, instr_type, name)
                token = ""  # Upstox uses instrument_key
            else:
                continue

            # Only care about F&O equity underlyings
            if instr_type not in FNO_EQUITY_TYPES:
                continue
            if not underlying:
                continue

            if underlying not in seen_underlyings:
                entry = FnoUniverseEntry(
                    symbol=underlying,
                    exchange="NSE",
                    isin=isin,
                    instrumentType="EQ",
                    fnoEligible=True,
                )
                if provider == "angel_one":
                    entry.angelToken = token or None
                    entry.angelSymbol = underlying
                elif provider == "upstox":
                    entry.upstoxKey = key or None
                    entry.upstoxSymbol = symbol

                seen_underlyings[underlying] = entry
            else:
                # Augment existing entry with additional provider data
                existing = seen_underlyings[underlying]
                if provider == "angel_one" and not existing.angelToken:
                    existing.angelToken = token or None
                    existing.angelSymbol = underlying
                elif provider == "upstox" and not existing.upstoxKey:
                    existing.upstoxKey = key or None

                # Keep best ISIN
                if isin and not existing.isin:
                    existing.isin = isin

        except Exception:
            continue

    return list(seen_underlyings.values())


# ---------------------------------------------------------------------------
# Symbol extraction helpers
# ---------------------------------------------------------------------------

def _extract_underlying_angel(symbol: str, instr_type: str, name: str) -> Optional[str]:
    """
    Extract the equity underlying from an Angel One F&O instrument symbol.
    Angel F&O symbols: RELIANCENOV2601500CE, RELIANCENOV26FUT, etc.
    Approach: use 'name' field which usually contains the underlying name.
    """
    if instr_type not in FNO_EQUITY_TYPES:
        return None
    # Name often contains the underlying cleanly for equity F&O
    if name and len(name) >= 2:
        # Remove common suffixes that aren't the underlying name
        clean = name.split(" ")[0].upper()
        if clean and len(clean) >= 2:
            return clean
    # Fall back: strip trailing expiry/strike info from symbol
    # This is approximate — instrument master 'name' field is more reliable
    return symbol[:8].rstrip("0123456789JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC") or None


def _extract_underlying_upstox(symbol: str, instr_type: str, name: str) -> Optional[str]:
    """
    Extract the equity underlying from an Upstox F&O instrument symbol.
    Upstox tradingsymbol: RELIANCE24NOV1500CE, RELIANCE24NOVFUT, etc.
    """
    if instr_type not in FNO_EQUITY_TYPES:
        return None
    # Upstox name field: underlying name
    if name and len(name) >= 2:
        return name.split(" ")[0].upper()
    return None


def _ist_date_str(dt: datetime) -> str:
    """Convert UTC datetime to IST date string."""
    from zoneinfo import ZoneInfo
    ist = dt.astimezone(ZoneInfo("Asia/Kolkata"))
    return ist.strftime("%Y-%m-%d")
