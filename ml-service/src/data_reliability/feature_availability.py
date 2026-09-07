"""
Phase 3Q — Feature availability contract (spec §15).

A feature must distinguish a genuine TRUE_ZERO from MISSING data. Fragments of this
concept existed (data.point_in_time.DataAvailabilityStatus,
historical_universe.AvailabilityValue) but there was no unified contract for a
feature value. This module ADDS one so that missing market information is NEVER
silently converted to 0.0 / 1.0 (spec §15, §44).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class FeatureAvailability(str, Enum):
    AVAILABLE         = "AVAILABLE"          # a real, usable value is present
    TRUE_ZERO         = "TRUE_ZERO"          # genuinely zero (e.g. zero volume)
    MISSING           = "MISSING"            # value absent (do not substitute)
    NOT_APPLICABLE    = "NOT_APPLICABLE"     # feature undefined for this instrument
    NOT_YET_AVAILABLE = "NOT_YET_AVAILABLE"  # will exist later; not at decision time
    DATA_INSUFFICIENT = "DATA_INSUFFICIENT"  # too little history to compute


@dataclass
class FeatureValue:
    """
    A feature reading carrying its availability semantics (spec §15). `value` is
    only meaningful when availability is AVAILABLE or TRUE_ZERO; for every other
    state it MUST be None (never a substituted default).
    """
    name:          str
    availability:  str            # FeatureAvailability value
    value:         Optional[float] = None
    reason:        str = ""

    def __post_init__(self):
        # fail-closed: a non-usable availability may not carry a numeric value
        if self.availability not in (FeatureAvailability.AVAILABLE.value,
                                     FeatureAvailability.TRUE_ZERO.value):
            self.value = None

    @property
    def is_usable(self) -> bool:
        """Usable for computation iff a real value or a genuine zero (spec §15)."""
        return self.availability in (FeatureAvailability.AVAILABLE.value,
                                     FeatureAvailability.TRUE_ZERO.value)

    def resolved(self) -> Optional[float]:
        """The numeric value to use, or None if not usable. NEVER a silent default."""
        if self.availability == FeatureAvailability.TRUE_ZERO.value:
            return 0.0
        return self.value if self.availability == FeatureAvailability.AVAILABLE.value else None

    def to_dict(self) -> dict:
        return {"name": self.name, "availability": self.availability,
                "value": self.value, "is_usable": self.is_usable, "reason": self.reason}


def available(name: str, value: float) -> FeatureValue:
    return FeatureValue(name, FeatureAvailability.AVAILABLE.value, value)


def true_zero(name: str, reason: str = "genuine zero") -> FeatureValue:
    return FeatureValue(name, FeatureAvailability.TRUE_ZERO.value, 0.0, reason)


def missing(name: str, reason: str = "") -> FeatureValue:
    return FeatureValue(name, FeatureAvailability.MISSING.value, None, reason)


def data_insufficient(name: str, reason: str = "insufficient history") -> FeatureValue:
    return FeatureValue(name, FeatureAvailability.DATA_INSUFFICIENT.value, None, reason)


def all_usable(features: list[FeatureValue]) -> bool:
    """True iff every required feature is usable (spec §16 gate input)."""
    return bool(features) and all(f.is_usable for f in features)


def unusable_features(features: list[FeatureValue]) -> list[str]:
    return [f.name for f in features if not f.is_usable]
