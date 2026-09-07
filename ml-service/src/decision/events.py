"""
Phase 3M — Event sourcing / audit trail + kill switches / safety gates
(spec §20, §25).

Two responsibilities:

1. EVENT LOG (spec §25): an immutable, append-only audit trail of lifecycle
   events, each carrying provenance. Corrections create NEW events; history is
   never overwritten. Persisted via the reused stdlib `lifecycle._storage`
   (atomic JSON/JSONL + FileLock).

2. KILL SWITCHES / SAFETY GATES (spec §20, §21): a deterministic safety layer
   that OVERRIDES ML. If any gate is tripped the result is NO_EXECUTION. The
   safety layer fails CLOSED — if a required safety check is unavailable, it
   blocks (never "risk unavailable → BUY").

Determinism: pure stdlib; no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

from src.lifecycle._storage import append_jsonl, read_jsonl, FileLock

from .state import DecisionState

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# Event log (spec §25)
# ══════════════════════════════════════════════════════════════════════════════

class EventType(str, Enum):
    DATA_ACCEPTED         = "DATA_ACCEPTED"
    FEATURES_GENERATED    = "FEATURES_GENERATED"
    MODEL_SELECTED        = "MODEL_SELECTED"
    PREDICTION_GENERATED  = "PREDICTION_GENERATED"
    CALIBRATION_APPLIED   = "CALIBRATION_APPLIED"
    EV_COMPUTED           = "EV_COMPUTED"
    ABSTENTION_APPLIED    = "ABSTENTION_APPLIED"
    PORTFOLIO_ACCEPTED    = "PORTFOLIO_ACCEPTED"
    PORTFOLIO_REJECTED    = "PORTFOLIO_REJECTED"
    EXECUTION_PLANNED     = "EXECUTION_PLANNED"
    RL_ACTION_PROPOSED    = "RL_ACTION_PROPOSED"
    RL_ACTION_REJECTED    = "RL_ACTION_REJECTED"
    SHADOW_ORDER_CREATED  = "SHADOW_ORDER_CREATED"
    SHADOW_FILL_CREATED   = "SHADOW_FILL_CREATED"
    SHADOW_ORDER_COMPLETED = "SHADOW_ORDER_COMPLETED"
    OUTCOME_RECONCILED    = "OUTCOME_RECONCILED"
    MODEL_HEALTH_CHANGED  = "MODEL_HEALTH_CHANGED"
    KILL_SWITCH_TRIGGERED = "KILL_SWITCH_TRIGGERED"
    DECISION_STATE_CHANGED = "DECISION_STATE_CHANGED"


@dataclass
class DecisionEvent:
    """One immutable lifecycle event (spec §25). Carries provenance."""
    event_type:     str
    decision_id:    str
    timestamp:      str
    provenance_id:  str = ""
    payload:        dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"event_type": self.event_type, "decision_id": self.decision_id,
                "timestamp": self.timestamp, "provenance_id": self.provenance_id,
                "payload": self.payload}


class EventLog:
    """
    Immutable append-only event log (spec §25). Backed by a JSONL file via the
    reused `lifecycle._storage.append_jsonl`. There is no update/delete —
    corrections append a new event.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "decision_events.jsonl"

    def append(self, event: DecisionEvent) -> DecisionEvent:
        append_jsonl(self.path, event.to_dict())
        return event

    def emit(self, event_type: EventType, decision_id: str,
             provenance_id: str = "", **payload) -> DecisionEvent:
        ev = DecisionEvent(event_type=event_type.value, decision_id=decision_id,
                           timestamp=_now(), provenance_id=provenance_id, payload=payload)
        return self.append(ev)

    def all(self) -> list[dict]:
        return read_jsonl(self.path)

    def for_decision(self, decision_id: str) -> list[dict]:
        return [e for e in self.all() if e.get("decision_id") == decision_id]


# ══════════════════════════════════════════════════════════════════════════════
# Kill switches / safety gates (spec §20, §21)
# ══════════════════════════════════════════════════════════════════════════════

class KillSwitch(str, Enum):
    """Operational safety gates (spec §20). Any tripped gate → NO_EXECUTION."""
    DATA_UNSAFE                   = "DATA_UNSAFE"
    MODEL_REVOKED                 = "MODEL_REVOKED"
    CALIBRATION_STALE             = "CALIBRATION_STALE"
    FEATURE_SCHEMA_MISMATCH       = "FEATURE_SCHEMA_MISMATCH"
    EXCESSIVE_DRIFT               = "EXCESSIVE_DRIFT"
    EXECUTION_SIMULATOR_UNAVAILABLE = "EXECUTION_SIMULATOR_UNAVAILABLE"
    PORTFOLIO_RISK_BREACH         = "PORTFOLIO_RISK_BREACH"
    RL_OOD                        = "RL_OOD"
    RL_POLICY_INVALID             = "RL_POLICY_INVALID"
    PROVENANCE_MISSING            = "PROVENANCE_MISSING"
    SYSTEM_HEALTH_DEGRADED        = "SYSTEM_HEALTH_DEGRADED"


# Map each kill switch to the terminal decision state it forces.
_KILL_SWITCH_STATE: dict[KillSwitch, DecisionState] = {
    KillSwitch.DATA_UNSAFE:                     DecisionState.DATA_INVALID,
    KillSwitch.MODEL_REVOKED:                   DecisionState.MODEL_REVOKED,
    KillSwitch.CALIBRATION_STALE:               DecisionState.CALIBRATION_UNAVAILABLE,
    KillSwitch.FEATURE_SCHEMA_MISMATCH:         DecisionState.MODEL_INCOMPATIBLE,
    KillSwitch.EXCESSIVE_DRIFT:                 DecisionState.BLOCKED,
    KillSwitch.EXECUTION_SIMULATOR_UNAVAILABLE: DecisionState.BLOCKED,
    KillSwitch.PORTFOLIO_RISK_BREACH:           DecisionState.PORTFOLIO_REJECTED,
    KillSwitch.RL_OOD:                          DecisionState.BLOCKED,
    KillSwitch.RL_POLICY_INVALID:               DecisionState.BLOCKED,
    KillSwitch.PROVENANCE_MISSING:              DecisionState.PROVENANCE_INVALID,
    KillSwitch.SYSTEM_HEALTH_DEGRADED:          DecisionState.BLOCKED,
}


@dataclass
class SafetyGateResult:
    """Result of running the safety layer over a decision (spec §20)."""
    allowed:        bool
    tripped:        list[str] = field(default_factory=list)   # KillSwitch values
    forced_state:   Optional[str] = None                       # DecisionState value
    reasons:        list[str] = field(default_factory=list)

    @property
    def no_execution(self) -> bool:
        return not self.allowed

    def to_dict(self) -> dict:
        return {"allowed": self.allowed, "tripped": self.tripped,
                "forced_state": self.forced_state, "reasons": self.reasons,
                "no_execution": self.no_execution}


@dataclass
class SafetyInputs:
    """
    Point-in-time safety signals fed to the kill-switch layer. Any signal that
    is None/unknown is treated as UNSAFE (fail closed) where marked.
    """
    data_safe:                Optional[bool] = None       # None → unknown → unsafe
    model_revoked:            bool = False
    calibration_stale:        bool = False
    feature_schema_match:     Optional[bool] = None       # None → unknown → mismatch
    excessive_drift:          bool = False
    simulator_available:      Optional[bool] = None       # None → unknown → unavailable
    portfolio_risk_ok:        Optional[bool] = None        # None → unknown → breach
    rl_ood:                   bool = False
    rl_policy_valid:          Optional[bool] = None        # only checked if RL used
    rl_used:                  bool = False
    provenance_valid:         bool = True
    system_health_degraded:   bool = False


class SafetyLayer:
    """
    Deterministic safety layer that OVERRIDES ML (spec §20, §21). It fails
    CLOSED: an unknown mandatory signal trips the corresponding kill switch.
    The RL policy can NEVER bypass this layer.
    """

    def evaluate(self, inp: SafetyInputs) -> SafetyGateResult:
        tripped: list[str] = []
        reasons: list[str] = []

        # provenance first (spec §20 PROVENANCE_MISSING)
        if not inp.provenance_valid:
            tripped.append(KillSwitch.PROVENANCE_MISSING.value)
            reasons.append("provenance missing/invalid")

        # data: unknown → unsafe (fail closed)
        if inp.data_safe is not True:
            tripped.append(KillSwitch.DATA_UNSAFE.value)
            reasons.append("data unsafe or unknown")

        if inp.model_revoked:
            tripped.append(KillSwitch.MODEL_REVOKED.value)
            reasons.append("model revoked")

        if inp.calibration_stale:
            tripped.append(KillSwitch.CALIBRATION_STALE.value)
            reasons.append("calibration stale")

        if inp.feature_schema_match is not True:
            tripped.append(KillSwitch.FEATURE_SCHEMA_MISMATCH.value)
            reasons.append("feature schema mismatch or unknown")

        if inp.excessive_drift:
            tripped.append(KillSwitch.EXCESSIVE_DRIFT.value)
            reasons.append("excessive drift")

        if inp.simulator_available is not True:
            tripped.append(KillSwitch.EXECUTION_SIMULATOR_UNAVAILABLE.value)
            reasons.append("execution simulator unavailable or unknown")

        # portfolio risk: unknown → breach (fail closed; risk-unavailable → BLOCK)
        if inp.portfolio_risk_ok is not True:
            tripped.append(KillSwitch.PORTFOLIO_RISK_BREACH.value)
            reasons.append("portfolio/risk breach or risk engine unavailable")

        if inp.rl_used:
            if inp.rl_ood:
                tripped.append(KillSwitch.RL_OOD.value)
                reasons.append("RL action out-of-distribution")
            if inp.rl_policy_valid is not True:
                tripped.append(KillSwitch.RL_POLICY_INVALID.value)
                reasons.append("RL policy invalid or unknown")

        if inp.system_health_degraded:
            tripped.append(KillSwitch.SYSTEM_HEALTH_DEGRADED.value)
            reasons.append("system health degraded")

        if tripped:
            # forced state = the first tripped switch's mapped state (priority order above)
            first = KillSwitch(tripped[0])
            return SafetyGateResult(allowed=False, tripped=tripped,
                                    forced_state=_KILL_SWITCH_STATE[first].value,
                                    reasons=reasons)
        return SafetyGateResult(allowed=True)
