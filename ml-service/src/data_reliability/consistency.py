"""
Phase 3Q — Cross-provider consistency → named PROVIDER_CONFLICT verdict (spec §4).

The existing `paper.providers.cross_provider_compare` already classifies field
disagreements STRICT / TOLERANT_NUMERIC / PROVIDER_SPECIFIC against a config-driven
`ConsistencyPolicy`. This module ADDS the named CONFLICT verdict the spec requires
and — critically — NEVER picks "whichever provider is more favorable" (§4). On a
material disagreement it flags CONFLICT and defers to the deterministic hierarchy
priority, not to the better-looking number.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class ConsistencyVerdict(str, Enum):
    CONSISTENT       = "CONSISTENT"
    PROVIDER_CONFLICT = "PROVIDER_CONFLICT"
    INSUFFICIENT     = "INSUFFICIENT"        # not enough overlapping data to compare


@dataclass
class ConsistencyResult:
    verdict:      str            # ConsistencyVerdict value
    provider_a:   str
    provider_b:   str
    instrument:   str
    strict_mismatch: bool = False
    tolerant_breaches: list[str] = field(default_factory=list)
    detail:       str = ""

    @property
    def is_conflict(self) -> bool:
        return self.verdict == ConsistencyVerdict.PROVIDER_CONFLICT.value

    def to_dict(self) -> dict:
        return {"verdict": self.verdict, "provider_a": self.provider_a,
                "provider_b": self.provider_b, "instrument": self.instrument,
                "strict_mismatch": self.strict_mismatch,
                "tolerant_breaches": self.tolerant_breaches, "detail": self.detail}


def check_provider_consistency(
    provider_a: str, provider_b: str, instrument: str,
    bar_a: dict, bar_b: dict, policy=None,
) -> ConsistencyResult:
    """
    Compare two providers' bars (spec §4) via the existing cross_provider_compare,
    and map the outcome to a named verdict. A strict-field mismatch (timestamp /
    instrument / exchange) or any tolerant field out of tolerance → PROVIDER_CONFLICT.
    The result NEVER selects a provider — it only reports agreement; provider
    selection is owned by the deterministic hierarchy (§4).
    """
    from src.paper.providers import cross_provider_compare
    cmp = cross_provider_compare(provider_a, provider_b, instrument, bar_a, bar_b, policy)
    if not bar_a or not bar_b:
        return ConsistencyResult(ConsistencyVerdict.INSUFFICIENT.value, provider_a,
                                 provider_b, instrument, detail="empty bar(s)")
    breaches = [m.field for m in cmp.tolerant_breaches]
    if cmp.strict_mismatch or breaches:
        return ConsistencyResult(
            ConsistencyVerdict.PROVIDER_CONFLICT.value, provider_a, provider_b, instrument,
            strict_mismatch=cmp.strict_mismatch, tolerant_breaches=breaches,
            detail="strict mismatch" if cmp.strict_mismatch
                   else f"tolerant breach: {breaches}")
    return ConsistencyResult(ConsistencyVerdict.CONSISTENT.value, provider_a,
                             provider_b, instrument)
