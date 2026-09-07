"""
Phase 3Q — Signal-safety gate (spec §16, §37).

Before a signal may be emitted, ten mandatory conditions must hold. If ANY fails,
the system must return an explicit NO_DECISION with a typed reason — it must NEVER
convert uncertainty into a neutral-looking BUY/SELL (§16, §44). This gate sits
downstream of the DataQualityGate and upstream of any model inference; it does not
itself make a directional call.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class SignalGate(str, Enum):
    MARKET_TIMESTAMP_VALID   = "MARKET_TIMESTAMP_VALID"
    BARS_COMPLETE            = "BARS_COMPLETE"          # closed, not forming
    FEATURES_AVAILABLE       = "FEATURES_AVAILABLE"
    DATA_QUALITY_PASSED      = "DATA_QUALITY_PASSED"
    MODEL_VALID              = "MODEL_VALID"
    MODEL_CALIBRATOR_COMPATIBLE = "MODEL_CALIBRATOR_COMPATIBLE"
    PROBABILITY_SEMANTICS_VALID = "PROBABILITY_SEMANTICS_VALID"
    DECISION_PROVENANCE_EXISTS  = "DECISION_PROVENANCE_EXISTS"
    NO_FUTURE_INFORMATION    = "NO_FUTURE_INFORMATION"
    PROVIDER_STATUS_ACCEPTABLE = "PROVIDER_STATUS_ACCEPTABLE"


# Mandatory gate order (spec §16). Evaluated in order; first failure decides.
SIGNAL_GATE_ORDER: tuple[SignalGate, ...] = (
    SignalGate.MARKET_TIMESTAMP_VALID,
    SignalGate.BARS_COMPLETE,
    SignalGate.FEATURES_AVAILABLE,
    SignalGate.DATA_QUALITY_PASSED,
    SignalGate.MODEL_VALID,
    SignalGate.MODEL_CALIBRATOR_COMPATIBLE,
    SignalGate.PROBABILITY_SEMANTICS_VALID,
    SignalGate.DECISION_PROVENANCE_EXISTS,
    SignalGate.NO_FUTURE_INFORMATION,
    SignalGate.PROVIDER_STATUS_ACCEPTABLE,
)


class SignalDecision(str, Enum):
    PROCEED     = "PROCEED"       # all gates pass — model inference MAY proceed
    NO_DECISION = "NO_DECISION"   # a mandatory condition failed — DO NOT TRADE


class NoDecisionReason(str, Enum):
    INSUFFICIENT_EVIDENCE   = "INSUFFICIENT_EVIDENCE"
    DATA_UNAVAILABLE        = "DATA_UNAVAILABLE"
    DATA_STALE              = "DATA_STALE"
    MODEL_UNAVAILABLE       = "MODEL_UNAVAILABLE"
    CALIBRATION_UNAVAILABLE = "CALIBRATION_UNAVAILABLE"
    MARKET_CLOSED           = "MARKET_CLOSED"
    FUTURE_INFORMATION      = "FUTURE_INFORMATION"
    PROVIDER_UNACCEPTABLE   = "PROVIDER_UNACCEPTABLE"
    NONE                    = "NONE"


# Map a failed gate → the typed no-decision reason it produces (spec §16).
_GATE_REASON = {
    SignalGate.MARKET_TIMESTAMP_VALID:      NoDecisionReason.MARKET_CLOSED,
    SignalGate.BARS_COMPLETE:               NoDecisionReason.INSUFFICIENT_EVIDENCE,
    SignalGate.FEATURES_AVAILABLE:          NoDecisionReason.DATA_UNAVAILABLE,
    SignalGate.DATA_QUALITY_PASSED:         NoDecisionReason.DATA_STALE,
    SignalGate.MODEL_VALID:                 NoDecisionReason.MODEL_UNAVAILABLE,
    SignalGate.MODEL_CALIBRATOR_COMPATIBLE: NoDecisionReason.CALIBRATION_UNAVAILABLE,
    SignalGate.PROBABILITY_SEMANTICS_VALID: NoDecisionReason.CALIBRATION_UNAVAILABLE,
    SignalGate.DECISION_PROVENANCE_EXISTS:  NoDecisionReason.INSUFFICIENT_EVIDENCE,
    SignalGate.NO_FUTURE_INFORMATION:       NoDecisionReason.FUTURE_INFORMATION,
    SignalGate.PROVIDER_STATUS_ACCEPTABLE:  NoDecisionReason.PROVIDER_UNACCEPTABLE,
}


@dataclass
class SignalSafetyResult:
    decision:      str            # SignalDecision value
    reason:        str            # NoDecisionReason value
    failed_gate:   Optional[str] = None
    gate_results:  dict = field(default_factory=dict)   # gate -> bool
    detail:        str = ""

    @property
    def may_proceed(self) -> bool:
        return self.decision == SignalDecision.PROCEED.value

    def to_dict(self) -> dict:
        return {"decision": self.decision, "reason": self.reason,
                "failed_gate": self.failed_gate, "gate_results": self.gate_results,
                "detail": self.detail}


def evaluate_signal_safety(gate_conditions: dict) -> SignalSafetyResult:
    """
    Evaluate the ten mandatory signal-safety gates (spec §16). `gate_conditions`
    maps each SignalGate value → bool (True = condition satisfied). A missing gate
    is treated as FAILED (fail-closed). The FIRST failing gate in the canonical
    order decides the NO_DECISION reason. Never returns a directional signal.
    """
    gate_results: dict = {}
    for gate in SIGNAL_GATE_ORDER:
        ok = bool(gate_conditions.get(gate.value, gate_conditions.get(gate, False)))
        gate_results[gate.value] = ok
        if not ok:
            reason = _GATE_REASON[gate]
            return SignalSafetyResult(
                decision=SignalDecision.NO_DECISION.value,
                reason=reason.value, failed_gate=gate.value,
                gate_results=gate_results,
                detail=f"gate {gate.value} failed → NO_DECISION ({reason.value})")
    return SignalSafetyResult(
        decision=SignalDecision.PROCEED.value,
        reason=NoDecisionReason.NONE.value, gate_results=gate_results)


# ── §37 No-signal conditions (explicit catalogue) ─────────────────────────────

NO_SIGNAL_CONDITIONS: tuple[str, ...] = (
    "STALE_FEED", "MISSING_MANDATORY_FEATURE", "UNRESOLVED_PROVIDER_CONFLICT",
    "INCOMPLETE_CANDLE", "MISSING_INSTRUMENT_METADATA", "INVALID_CONTRACT",
    "UNAVAILABLE_CALIBRATION", "MODEL_COMPATIBILITY_FAILURE",
    "PIT_VALIDATION_FAILURE", "INSUFFICIENT_HISTORICAL_CONTEXT",
    "MARKET_CLOSED", "UNKNOWN_MARKET_SESSION",
)
