"""
Phase 3Q — OHLC sanity + repair policy (spec §9).

Sanity checking itself is already done by `paper.data_quality.validate_ohlcv_bars`
(NaN/Inf, non-positive, negative volume, OHLC invariants, dup/out-of-order/future).
This module ADDS the §9 REPAIR POLICY: bad data is never silently "repaired".
A caller that wants to repair must produce a RepairRecord that PRESERVES the
original observation and records exactly what changed — and the default policy is
to QUARANTINE (reject), not repair.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class RepairAction(str, Enum):
    QUARANTINE = "QUARANTINE"    # default — reject the bar, do not use it
    REPAIRED   = "REPAIRED"      # a documented, explicit correction was applied
    NONE       = "NONE"          # bar was valid; nothing to do


@dataclass
class RepairRecord:
    """
    An auditable record of a data-quality decision on one bar (spec §9). The
    ORIGINAL observation is always preserved; a repair is only ever explicit.
    """
    instrument:  str
    bar_index:   int
    action:      str                       # RepairAction value
    reason:      str
    original:    dict                      # the untouched original bar
    repaired:    Optional[dict] = None     # only set when action == REPAIRED

    def to_dict(self) -> dict:
        return {"instrument": self.instrument, "bar_index": self.bar_index,
                "action": self.action, "reason": self.reason,
                "original": self.original, "repaired": self.repaired}


@dataclass
class SanitizedSeries:
    """Result of sanity-checking a bar series under the no-silent-repair policy."""
    instrument:  str
    usable_bars: list[dict] = field(default_factory=list)   # bars safe to consume
    quarantined: list[RepairRecord] = field(default_factory=list)
    repairs:     list[RepairRecord] = field(default_factory=list)

    @property
    def n_quarantined(self) -> int:
        return len(self.quarantined)

    @property
    def clean(self) -> bool:
        return not self.quarantined

    def to_dict(self) -> dict:
        return {"instrument": self.instrument, "n_usable": len(self.usable_bars),
                "n_quarantined": self.n_quarantined, "n_repairs": len(self.repairs),
                "clean": self.clean,
                "quarantined": [q.to_dict() for q in self.quarantined],
                "repairs": [r.to_dict() for r in self.repairs]}


def _bad(x) -> bool:
    import math
    try:
        f = float(x)
    except (TypeError, ValueError):
        return True
    return math.isnan(f) or math.isinf(f)


def _bar_ok(bar: dict) -> tuple[bool, str]:
    """Per-bar OHLC sanity (spec §9). Returns (ok, reason)."""
    o, h, l, c = bar.get("open"), bar.get("high"), bar.get("low"), bar.get("close")
    v = bar.get("volume")
    for name, val in (("open", o), ("high", h), ("low", l), ("close", c)):
        if val is None:
            return False, f"missing {name}"
        if _bad(val):
            return False, f"{name} NaN/Inf"
        if float(val) <= 0:
            return False, f"{name} <= 0"
    if v is not None and (_bad(v) or float(v) < 0):
        return False, "negative/NaN volume"
    o, h, l, c = float(o), float(h), float(l), float(c)
    if h < max(o, c):
        return False, "high < max(open,close)"
    if l > min(o, c):
        return False, "low > min(open,close)"
    if h < l:
        return False, "high < low"
    return True, ""


def sanitize_bars(bars: list[dict], instrument: str = "") -> SanitizedSeries:
    """
    Apply the §9 no-silent-repair policy: every bar that fails OHLC sanity is
    QUARANTINED (excluded from usable_bars) with a RepairRecord that preserves the
    original. Bad data is NEVER silently corrected or dropped without a record.
    """
    out = SanitizedSeries(instrument=instrument)
    for i, bar in enumerate(bars):
        ok, reason = _bar_ok(bar)
        if ok:
            out.usable_bars.append(bar)
        else:
            out.quarantined.append(RepairRecord(
                instrument=instrument, bar_index=i,
                action=RepairAction.QUARANTINE.value, reason=reason,
                original=dict(bar)))
    return out
