"""
Phase 3Q — Current-day validation harness (spec §36).

A PAPER / SHADOW-ONLY harness that, for a set of instruments (NIFTY, BANKNIFTY,
SENSEX, liquid equities, F&O), reports the data-reliability picture: selected
provider, market timestamp, freshness, completeness, OHLC sanity, cross-provider
consistency, derivatives availability, feature availability, and the resulting
signal eligibility. It NEVER places an order and never produces a BUY/SELL — it
composes the existing 3Q assessors and the signal-safety gate into a read-only
report.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .quality_gate import DataQualityDecision, DQVerdict
from .signal_safety import SignalDecision, SignalSafetyResult


@dataclass
class InstrumentHealthCheck:
    """Read-only per-instrument reliability snapshot (spec §36). No trade."""
    instrument:            str
    selected_provider:     str
    market_timestamp:      Optional[str]
    freshness:             str
    completeness_status:   str
    ohlc_sane:             bool
    cross_provider_status: str
    derivatives_available: bool
    feature_availability:  dict[str, str]     # feature name -> availability value
    dq_verdict:            str
    signal_decision:       str                # SignalDecision value (PROCEED/NO_DECISION)
    signal_reason:         str                # NoDecisionReason value
    notes:                 list[str] = field(default_factory=list)

    @property
    def eligible(self) -> bool:
        """Signal-eligible ONLY if the safety gate says PROCEED (fail-closed)."""
        return self.signal_decision == SignalDecision.PROCEED.value

    def to_dict(self) -> dict[str, Any]:
        return {
            "instrument": self.instrument,
            "selectedProvider": self.selected_provider,
            "marketTimestamp": self.market_timestamp,
            "freshness": self.freshness,
            "completenessStatus": self.completeness_status,
            "ohlcSane": self.ohlc_sane,
            "crossProviderStatus": self.cross_provider_status,
            "derivativesAvailable": self.derivatives_available,
            "featureAvailability": self.feature_availability,
            "dqVerdict": self.dq_verdict,
            "signalDecision": self.signal_decision,
            "signalReason": self.signal_reason,
            "eligible": self.eligible,
            "notes": self.notes,
        }


@dataclass
class HarnessReport:
    """Aggregate current-day report across instruments (spec §36). Paper/shadow only."""
    checks: list[InstrumentHealthCheck] = field(default_factory=list)
    is_paper_shadow_only: bool = True     # invariant: this harness NEVER trades

    @property
    def eligible_count(self) -> int:
        return sum(1 for c in self.checks if c.eligible)

    @property
    def total(self) -> int:
        return len(self.checks)

    def to_dict(self) -> dict[str, Any]:
        return {
            "isPaperShadowOnly": self.is_paper_shadow_only,
            "total": self.total,
            "eligibleCount": self.eligible_count,
            "checks": [c.to_dict() for c in self.checks],
        }


def build_instrument_check(
    *,
    instrument: str,
    selected_provider: str,
    market_timestamp: Optional[str],
    freshness: str,
    completeness_status: str,
    ohlc_sane: bool,
    cross_provider_status: str,
    derivatives_available: bool,
    feature_availability: dict[str, str],
    dq_decision: DataQualityDecision,
    signal_safety: SignalSafetyResult,
    notes: Optional[list[str]] = None,
) -> InstrumentHealthCheck:
    """
    Assemble a single instrument's read-only check from already-computed 3Q
    assessments. Signal eligibility is taken STRICTLY from the signal-safety gate
    — the harness never overrides a NO_DECISION into an actionable signal.
    """
    return InstrumentHealthCheck(
        instrument=instrument,
        selected_provider=selected_provider,
        market_timestamp=market_timestamp,
        freshness=freshness,
        completeness_status=completeness_status,
        ohlc_sane=ohlc_sane,
        cross_provider_status=cross_provider_status,
        derivatives_available=derivatives_available,
        feature_availability=dict(feature_availability),
        dq_verdict=dq_decision.verdict,
        signal_decision=signal_safety.decision,
        signal_reason=signal_safety.reason,
        notes=list(notes or []),
    )


# Canonical default instrument set for the current-day harness (spec §36).
DEFAULT_HARNESS_INSTRUMENTS = (
    "NSE:NIFTY 50:INDEX",
    "NSE:NIFTY BANK:INDEX",
    "BSE:SENSEX:INDEX",
    "NSE:RELIANCE:EQ",
    "NSE:HDFCBANK:EQ",
    "NFO:NIFTY:FUT",
)
