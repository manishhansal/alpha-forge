"""
Phase 3N — Production-readiness gates (spec §46, §47, §61, §63).

Eight explicit gates roll up into a single paper-readiness verdict:

  DATA → FEATURES → MODELS → CALIBRATION → RISK → EXECUTION → PAPER → EVIDENCE

Each gate is READY / BLOCKED / INSUFFICIENT_EVIDENCE with machine-readable
reasons. The final state is ALPHAFORGE_PAPER_READY / _READY_WITH_LIMITATIONS /
_NOT_READY. There is deliberately NO LIVE_READY state — this phase cannot
authorize live trading (spec §61).

Readiness is NOT profitability (spec §47): it requires correctness,
reproducibility, safety, data integrity, operational stability, and evidence
quality. Economic performance is a separate question.

Determinism: pure stdlib. Import-clean.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


class GateStatus(str, Enum):
    READY                 = "READY"
    BLOCKED               = "BLOCKED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class PaperReadiness(str, Enum):
    PAPER_READY                  = "ALPHAFORGE_PAPER_READY"
    PAPER_READY_WITH_LIMITATIONS = "ALPHAFORGE_PAPER_READY_WITH_LIMITATIONS"
    PAPER_NOT_READY              = "ALPHAFORGE_PAPER_NOT_READY"
    # NOTE: there is intentionally NO LIVE_READY member (spec §61).


# The eight gates, in evaluation order (spec §46).
GATE_ORDER: tuple[str, ...] = (
    "DATA", "FEATURES", "MODELS", "CALIBRATION",
    "RISK", "EXECUTION", "PAPER", "EVIDENCE",
)


@dataclass
class GateResult:
    gate:    str
    status:  str
    reasons: list[str] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)

    @property
    def ready(self) -> bool:
        return self.status == GateStatus.READY.value

    @property
    def blocked(self) -> bool:
        return self.status == GateStatus.BLOCKED.value

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ReadinessReport:
    readiness:   str
    gates:       list[GateResult]
    generated_at: str = ""
    notes:       list[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.generated_at:
            self.generated_at = datetime.now(UTC).isoformat()

    @property
    def blocked_gates(self) -> list[str]:
        return [g.gate for g in self.gates if g.blocked]

    @property
    def insufficient_gates(self) -> list[str]:
        return [g.gate for g in self.gates
                if g.status == GateStatus.INSUFFICIENT_EVIDENCE.value]

    def to_dict(self) -> dict:
        return {
            "readiness": self.readiness,
            "blocked_gates": self.blocked_gates,
            "insufficient_gates": self.insufficient_gates,
            "gates": [g.to_dict() for g in self.gates],
            "notes": self.notes,
            "generated_at": self.generated_at,
        }


def _gate(name: str, inputs: dict) -> GateResult:
    """
    Evaluate one gate from a small dict of booleans/values. Each gate is
    fail-closed: a required signal that is missing (None) is treated as
    INSUFFICIENT_EVIDENCE, and an explicit unsafe signal is BLOCKED.
    """
    reasons: list[str] = []

    def req(flag_key: str, ok_reason: str, bad_reason: str):
        val = inputs.get(flag_key)
        if val is None:
            reasons.append(f"{flag_key}: unknown (INSUFFICIENT_EVIDENCE)")
            return GateStatus.INSUFFICIENT_EVIDENCE
        if val:
            return GateStatus.READY
        reasons.append(bad_reason)
        return GateStatus.BLOCKED

    # Combine sub-checks: BLOCKED dominates, then INSUFFICIENT_EVIDENCE.
    statuses = []
    for key, (ok_r, bad_r) in inputs.get("_checks", {}).items():
        statuses.append(req(key, ok_r, bad_r))
    if not statuses:
        return GateResult(name, GateStatus.INSUFFICIENT_EVIDENCE.value,
                          ["no checks supplied"], inputs.get("metrics", {}))
    if any(s == GateStatus.BLOCKED for s in statuses):
        status = GateStatus.BLOCKED
    elif any(s == GateStatus.INSUFFICIENT_EVIDENCE for s in statuses):
        status = GateStatus.INSUFFICIENT_EVIDENCE
    else:
        status = GateStatus.READY
        reasons.append("all checks passed")
    return GateResult(name, status.value, reasons, inputs.get("metrics", {}))


class ReadinessEvaluator:
    """
    Rolls the eight gates into a paper-readiness verdict (spec §46, §63).

    `gate_inputs` maps each gate name to a dict of the form:
        {"_checks": {"flag_key": ("ok reason", "bad reason"), ...},
         "flag_key": True|False|None, ..., "metrics": {...}}
    This keeps the readiness logic declarative and lets the caller wire it to the
    real health/monitoring/evidence outputs without this module importing heavy
    dependencies.
    """

    def evaluate(self, gate_inputs: dict) -> ReadinessReport:
        gates: list[GateResult] = []
        for name in GATE_ORDER:
            gates.append(_gate(name, gate_inputs.get(name, {})))

        blocked = [g for g in gates if g.blocked]
        insufficient = [g for g in gates
                        if g.status == GateStatus.INSUFFICIENT_EVIDENCE.value]

        # Readiness rollup (spec §61, §63):
        #  * any BLOCKED gate → NOT_READY.
        #  * all READY → PAPER_READY.
        #  * some INSUFFICIENT_EVIDENCE but none blocked → READY_WITH_LIMITATIONS
        #    (paper operation may continue, but the evidence is limited).
        notes: list[str] = []
        if blocked:
            readiness = PaperReadiness.PAPER_NOT_READY.value
            notes.append(f"blocked gates: {[g.gate for g in blocked]}")
        elif insufficient:
            readiness = PaperReadiness.PAPER_READY_WITH_LIMITATIONS.value
            notes.append(f"insufficient-evidence gates: {[g.gate for g in insufficient]}")
        else:
            readiness = PaperReadiness.PAPER_READY.value
        notes.append("readiness reflects correctness/safety/integrity/evidence "
                     "quality — NOT profitability (spec §47).")
        notes.append("LIVE trading is NOT authorized by this phase (spec §61).")
        return ReadinessReport(readiness=readiness, gates=gates, notes=notes)
