"""
Phase 3Q — Corporate-action adjustment mode (spec §10).

The existing `data.corporate_actions` computes PIT-correct split/bonus factors but
has NO explicit adjustment-MODE concept, so nothing structurally prevents mixing
an adjusted close with raw OHLC. This module ADDS the RAW / SPLIT_ADJUSTED /
TOTAL_RETURN_ADJUSTED mode as a first-class tag on a price series and a guard that
REFUSES to combine series of different modes (§10, §44).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class AdjustmentMode(str, Enum):
    RAW                   = "RAW"                    # unadjusted, as-traded prices
    SPLIT_ADJUSTED        = "SPLIT_ADJUSTED"         # split/bonus adjusted
    TOTAL_RETURN_ADJUSTED = "TOTAL_RETURN_ADJUSTED"  # + dividends reinvested
    UNKNOWN               = "UNKNOWN"                # mode not declared → unusable


class AdjustmentModeError(ValueError):
    """Raised when price series of incompatible adjustment modes would be mixed."""


@dataclass
class AdjustedSeries:
    """A price series tagged with its adjustment mode (spec §10)."""
    instrument:      str
    adjustment_mode: str                 # AdjustmentMode value
    ca_version:      str = ""            # corporate-action dataset version
    bars:            list[dict] = field(default_factory=list)

    @property
    def declared(self) -> bool:
        return self.adjustment_mode not in ("", AdjustmentMode.UNKNOWN.value)

    def to_dict(self) -> dict:
        return {"instrument": self.instrument, "adjustment_mode": self.adjustment_mode,
                "ca_version": self.ca_version, "n_bars": len(self.bars),
                "declared": self.declared}


def assert_same_mode(*series: AdjustedSeries) -> str:
    """
    Refuse to combine series of different adjustment modes (spec §10). Also
    refuses an UNKNOWN/undeclared mode (fail-closed — a series must declare how it
    was adjusted before it can be used in a return calculation). Returns the
    common mode on success.
    """
    if not series:
        raise AdjustmentModeError("no series supplied")
    modes = {s.adjustment_mode for s in series}
    if any(not s.declared for s in series):
        raise AdjustmentModeError(
            "an adjustment mode is UNKNOWN/undeclared; declare RAW / SPLIT_ADJUSTED "
            "/ TOTAL_RETURN_ADJUSTED before using the series")
    if len(modes) > 1:
        raise AdjustmentModeError(
            f"cannot mix adjustment modes {sorted(modes)}; returns computed across "
            "different adjustment modes are invalid (spec §10)")
    return next(iter(modes))


def can_compute_returns(*series: AdjustedSeries) -> tuple[bool, str]:
    """Non-raising variant: (ok, reason). ok iff all series share a declared mode."""
    try:
        mode = assert_same_mode(*series)
        return True, mode
    except AdjustmentModeError as exc:
        return False, str(exc)
