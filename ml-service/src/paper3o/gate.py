"""
Phase 3O — Go/No-Go gate + final manifest (spec §70–§75).

This is the decision surface for the whole phase. It combines seven gate
dimensions into exactly ONE of:

    PAPER_CONTINUE                    — machinery is trustworthy; keep accumulating
                                        paper evidence (NOT profitable, NOT
                                        live-ready, NOT confirmed alpha).
    PAPER_CONTINUE_WITH_LIMITATIONS   — trustworthy but some dimension is only
                                        INSUFFICIENT_EVIDENCE (e.g. no real-market
                                        economic evidence yet).
    PAPER_BLOCKED                     — a hard integrity/safety violation, OR the
                                        gate cannot be determined (fail-closed).

There is NO LIVE_READY state and this module NEVER authorises live trading
(spec §3). It is fail-closed: unknown → BLOCKED for hard checks, and any single
hard blocker forces PAPER_BLOCKED regardless of everything else.

Reuses the PASS/FAIL/INSUFFICIENT_EVIDENCE vocabulary consistent with
src.paper.readiness. Import-clean: stdlib only at module load.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

UTC = timezone.utc


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# Gate dimensions + statuses
# ══════════════════════════════════════════════════════════════════════════════

class GateDimension(str, Enum):
    DATA_INTEGRITY        = "DATA_INTEGRITY"
    DECISION_INTEGRITY    = "DECISION_INTEGRITY"
    EXECUTION_INTEGRITY   = "EXECUTION_INTEGRITY"
    ACCOUNTING_INTEGRITY  = "ACCOUNTING_INTEGRITY"
    STATISTICAL_EVIDENCE  = "STATISTICAL_EVIDENCE"
    OPERATIONAL_RELIABILITY = "OPERATIONAL_RELIABILITY"
    SECURITY              = "SECURITY"


# The six graded dimensions can be PASS / FAIL / INSUFFICIENT_EVIDENCE.
GRADED_DIMENSIONS = (
    GateDimension.DATA_INTEGRITY, GateDimension.DECISION_INTEGRITY,
    GateDimension.EXECUTION_INTEGRITY, GateDimension.ACCOUNTING_INTEGRITY,
    GateDimension.STATISTICAL_EVIDENCE, GateDimension.OPERATIONAL_RELIABILITY,
)
# Security is binary PASS / FAIL (no "insufficient" — unknown security = FAIL).
BINARY_DIMENSIONS = (GateDimension.SECURITY,)


class GateStatus(str, Enum):
    PASS                  = "PASS"
    FAIL                  = "FAIL"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class FinalStatus(str, Enum):
    PAPER_CONTINUE                  = "PAPER_CONTINUE"
    PAPER_CONTINUE_WITH_LIMITATIONS = "PAPER_CONTINUE_WITH_LIMITATIONS"
    PAPER_BLOCKED                   = "PAPER_BLOCKED"


# Hard blockers — any TRUE forces PAPER_BLOCKED (spec §71). Fail-closed.
class BlockerReason(str, Enum):
    LOOKAHEAD                 = "LOOKAHEAD_LEAKAGE"
    ACCOUNTING_CORRUPTION     = "ACCOUNTING_CORRUPTION"
    DUPLICATE_EXPOSURE        = "DUPLICATE_EXPOSURE"
    FAKE_FILLS                = "FAKE_FILLS"
    UNKNOWN_PROVENANCE        = "UNKNOWN_PROVENANCE"
    UNSAFE_FALLBACK           = "UNSAFE_FALLBACK"
    LIVE_PATH_REACHABLE       = "LIVE_PATH_REACHABLE"
    SECRET_EXPOSURE           = "SECRET_EXPOSURE"
    INVALID_METADATA          = "INVALID_METADATA"
    UNEXPLAINED_MISMATCH      = "UNEXPLAINED_MISMATCH"
    CRITICAL_RECONCILIATION_FAIL = "CRITICAL_RECONCILIATION_FAIL"
    MODEL_CALIBRATION_MISMATCH = "MODEL_CALIBRATION_MISMATCH"
    CANNOT_DETERMINE          = "CANNOT_DETERMINE"


@dataclass
class GateResult:
    dimension: str
    status:    str
    reason:    str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# Gate evaluation
# ══════════════════════════════════════════════════════════════════════════════

class GoNoGoGate:
    """
    Collects per-dimension results + hard blockers and derives the final status.

    Decision logic (fail-closed):
      1. Any hard blocker present            → PAPER_BLOCKED.
      2. Security != PASS                    → PAPER_BLOCKED (unknown security fails).
      3. Any graded dimension FAIL           → PAPER_BLOCKED.
      4. A graded dimension missing          → treated as INSUFFICIENT_EVIDENCE.
      5. Any graded dimension INSUFFICIENT   → PAPER_CONTINUE_WITH_LIMITATIONS.
      6. All graded PASS + Security PASS + no blockers → PAPER_CONTINUE.
    """

    def __init__(self):
        self._results: dict[str, GateResult] = {}
        self._blockers: list[dict] = []

    # ── inputs ──
    def set_dimension(self, dim: GateDimension, status: GateStatus, reason: str = "") -> None:
        if dim in BINARY_DIMENSIONS and status == GateStatus.INSUFFICIENT_EVIDENCE:
            # unknown security is not allowed to pass — record as FAIL
            status = GateStatus.FAIL
            reason = (reason + " | security could not be verified → FAIL").strip(" |")
        self._results[dim.value] = GateResult(dim.value, status.value, reason)

    def raise_blocker(self, reason: BlockerReason, detail: str = "") -> None:
        self._blockers.append({"reason": reason.value, "detail": detail})

    # ── derivation ──
    def _graded_status(self, dim: GateDimension) -> str:
        r = self._results.get(dim.value)
        return r.status if r else GateStatus.INSUFFICIENT_EVIDENCE.value

    def final_status(self) -> str:
        if self._blockers:
            return FinalStatus.PAPER_BLOCKED.value
        # security must be explicitly PASS
        sec = self._results.get(GateDimension.SECURITY.value)
        if sec is None or sec.status != GateStatus.PASS.value:
            return FinalStatus.PAPER_BLOCKED.value
        graded = [self._graded_status(d) for d in GRADED_DIMENSIONS]
        if GateStatus.FAIL.value in graded:
            return FinalStatus.PAPER_BLOCKED.value
        if GateStatus.INSUFFICIENT_EVIDENCE.value in graded:
            return FinalStatus.PAPER_CONTINUE_WITH_LIMITATIONS.value
        return FinalStatus.PAPER_CONTINUE.value

    def evaluate(self) -> dict:
        # ensure every dimension appears (missing graded → INSUFFICIENT; missing
        # security is already handled as BLOCKED in final_status)
        dims = {}
        for d in GRADED_DIMENSIONS:
            r = self._results.get(d.value)
            dims[d.value] = (r.to_dict() if r
                             else GateResult(d.value,
                                             GateStatus.INSUFFICIENT_EVIDENCE.value,
                                             "no result supplied").to_dict())
        sec = self._results.get(GateDimension.SECURITY.value)
        dims[GateDimension.SECURITY.value] = (
            sec.to_dict() if sec
            else GateResult(GateDimension.SECURITY.value, GateStatus.FAIL.value,
                            "security not evaluated → FAIL").to_dict())
        return {
            "dimensions": dims,
            "blockers": list(self._blockers),
            "final_status": self.final_status(),
            "live_authorized": False,   # ALWAYS False in this phase (spec §3)
            "note": "PAPER_CONTINUE != LIVE_READY != profitable != confirmed alpha",
        }


# ══════════════════════════════════════════════════════════════════════════════
# §75 Final phase manifest
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Phase3OManifest:
    """The phase-level manifest (spec §75). Metadata about the whole evidence run."""
    phase:            str = "PHASE_3O"
    git_commit:       str = ""
    code_version:     str = ""
    environment_version: str = ""
    model_versions:   list[str] = field(default_factory=list)
    calibration_versions: list[str] = field(default_factory=list)
    portfolio_version: str = ""
    execution_version: str = ""
    rl_policy_version: str = ""
    paper_session_ids: list[str] = field(default_factory=list)
    experiment_ids:   list[str] = field(default_factory=list)
    test_command:     str = ""
    test_result:      str = ""          # e.g. "N passed / 0 failed / M skipped"
    evidence_level:   str = "E1"        # EvidenceTier value
    economic_evidence: str = "INSUFFICIENT_EVIDENCE"
    final_status:     str = FinalStatus.PAPER_BLOCKED.value   # fail-closed default
    gate:             dict = field(default_factory=dict)
    created_at:       str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now_iso()

    def to_dict(self) -> dict:
        d = asdict(self)
        d["live_authorized"] = False
        return d

    def persist(self, root: str | Path, filename: str = "phase_3o_manifest.json") -> Path:
        from src.lifecycle._storage import atomic_write_json
        p = Path(root) / filename
        atomic_write_json(p, self.to_dict())
        return p
