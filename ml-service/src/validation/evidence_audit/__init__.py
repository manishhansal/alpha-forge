"""
Phase 3P — Independent Evidence Ledger (spec §6, §7).

An INDEPENDENT record of every material claim made about AlphaForge, decoupled
from the production reports it is auditing. The ledger exists to make claims
falsifiable: each claim must name its source artifact, code path, test, dataset,
window, model version, configuration, an honestly-assigned evidence level, and
its reproducibility + independent-validation status.

Guiding rules (adversarial mindset):
  • A claim with no mapped test/code_path/artifact is UNSUPPORTED — recorded as
    such, never silently accepted (spec §6).
  • Evidence levels are NOT upgraded merely because more tests exist (spec §7).
    An E5 ("independently reproduced") requires an actual independent reproduction
    to be recorded; the ledger refuses to assign E5 without one.
  • Default result is UNVERIFIED / REPRODUCTION_INCOMPLETE — verification must be
    earned, not assumed.

Stdlib-only, import-clean. Persistence reuses lifecycle._storage (append-only).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# Evidence levels (spec §7)
# ══════════════════════════════════════════════════════════════════════════════

class EvidenceLevel(str, Enum):
    E0 = "E0"   # no evidence
    E1 = "E1"   # synthetic / unit evidence
    E2 = "E2"   # historical replay
    E3 = "E3"   # purged out-of-sample evidence
    E4 = "E4"   # paper / shadow evidence
    E5 = "E5"   # INDEPENDENTLY reproduced evidence


_LEVEL_RANK = {e: i for i, e in enumerate(
    [EvidenceLevel.E0, EvidenceLevel.E1, EvidenceLevel.E2,
     EvidenceLevel.E3, EvidenceLevel.E4, EvidenceLevel.E5])}


def level_rank(e: EvidenceLevel) -> int:
    return _LEVEL_RANK[e]


class ReproducibilityStatus(str, Enum):
    REPRODUCIBLE           = "REPRODUCIBLE"
    REPRODUCTION_INCOMPLETE = "REPRODUCTION_INCOMPLETE"   # missing a critical dependency
    NOT_ATTEMPTED          = "NOT_ATTEMPTED"


class IndependentValidationStatus(str, Enum):
    INDEPENDENTLY_CONFIRMED = "INDEPENDENTLY_CONFIRMED"   # recomputed outside production impl
    PRODUCTION_ONLY         = "PRODUCTION_ONLY"           # only the code-under-audit computed it
    NOT_ATTEMPTED           = "NOT_ATTEMPTED"


class ClaimResult(str, Enum):
    SUPPORTED             = "SUPPORTED"
    REJECTED              = "EVIDENCE_REJECTED"
    UNVERIFIABLE          = "EVIDENCE_UNVERIFIABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    UNVERIFIED            = "UNVERIFIED"                  # default — not yet assessed


# critical dependencies a claim must name to be reproducible (spec §8)
REPRODUCIBILITY_DEPENDENCIES = (
    "git_commit", "dataset_snapshot", "model_artifact", "feature_version",
    "label_version", "calibration_version", "portfolio_config",
    "execution_config", "random_seed", "environment", "evaluation_code",
)


# ══════════════════════════════════════════════════════════════════════════════
# Claim
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class EvidenceClaim:
    """
    One falsifiable claim. A claim is SUPPORTED only when it maps to a code path
    AND an executable test AND an artifact; otherwise it is UNSUPPORTED.
    """
    claim_id:        str
    claim:           str
    source_artifact: str = ""
    code_path:       str = ""
    test:            str = ""
    dataset:         str = ""
    time_window:     str = ""
    model_version:   str = ""
    configuration:   str = ""
    evidence_level:  str = EvidenceLevel.E0.value
    reproducibility_status: str = ReproducibilityStatus.NOT_ATTEMPTED.value
    independent_validation_status: str = IndependentValidationStatus.NOT_ATTEMPTED.value
    result:          str = ClaimResult.UNVERIFIED.value
    limitations:     str = ""
    # dependency presence map for the reproducibility audit (spec §8)
    dependencies:    dict = field(default_factory=dict)
    recorded_at:     str = ""

    def __post_init__(self):
        if not self.recorded_at:
            self.recorded_at = _now()

    @property
    def is_supported_shape(self) -> bool:
        """A claim is well-formed evidence only if it names code + test + artifact."""
        return bool(self.code_path) and bool(self.test) and bool(self.source_artifact)

    def missing_dependencies(self) -> list[str]:
        """Critical reproducibility dependencies that are absent/false (spec §8)."""
        return [d for d in REPRODUCIBILITY_DEPENDENCIES
                if not self.dependencies.get(d, False)]

    def validate(self) -> dict:
        """
        Independent consistency check on the claim itself (adversarial):
        - unsupported shape → result cannot be SUPPORTED
        - E5 requires INDEPENDENTLY_CONFIRMED (spec §7 — no auto-upgrade)
        - claiming REPRODUCIBLE while dependencies are missing is inconsistent
        Returns a dict of any inconsistencies (empty = internally consistent).
        """
        issues = {}
        if not self.is_supported_shape and self.result == ClaimResult.SUPPORTED.value:
            issues["unsupported_shape"] = (
                "claim marked SUPPORTED but missing code_path/test/source_artifact")
        if (self.evidence_level == EvidenceLevel.E5.value
                and self.independent_validation_status
                != IndependentValidationStatus.INDEPENDENTLY_CONFIRMED.value):
            issues["e5_without_independent"] = (
                "E5 claimed without INDEPENDENTLY_CONFIRMED validation")
        if (self.reproducibility_status == ReproducibilityStatus.REPRODUCIBLE.value
                and self.missing_dependencies()):
            issues["repro_missing_deps"] = self.missing_dependencies()
        return issues

    def to_dict(self) -> dict:
        d = asdict(self)
        d["is_supported_shape"] = self.is_supported_shape
        d["missing_dependencies"] = self.missing_dependencies()
        d["consistency_issues"] = self.validate()
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Ledger
# ══════════════════════════════════════════════════════════════════════════════

class EvidenceLedger:
    """
    Append-only, independent evidence ledger. Never overwrites a claim; a revised
    assessment is a new appended record. Refuses to persist an internally
    inconsistent claim (fail-closed) so the ledger cannot itself manufacture
    unearned certainty.
    """

    def __init__(self, root: Optional[str | Path] = None):
        self._claims: list[EvidenceClaim] = []
        self.root = Path(root) if root else None
        if self.root:
            self.root.mkdir(parents=True, exist_ok=True)
            self.path = self.root / "evidence_ledger.jsonl"
        else:
            self.path = None

    def add(self, claim: EvidenceClaim, *, allow_inconsistent: bool = False) -> EvidenceClaim:
        issues = claim.validate()
        if issues and not allow_inconsistent:
            raise ValueError(
                f"Refusing to record inconsistent claim {claim.claim_id!r}: {issues}")
        self._claims.append(claim)
        if self.path is not None:
            from src.lifecycle._storage import append_jsonl
            append_jsonl(self.path, claim.to_dict())
        return claim

    def all(self) -> list[EvidenceClaim]:
        return list(self._claims)

    def by_result(self, result: ClaimResult) -> list[EvidenceClaim]:
        return [c for c in self._claims if c.result == result.value]

    def by_level(self, level: EvidenceLevel) -> list[EvidenceClaim]:
        return [c for c in self._claims if c.evidence_level == level.value]

    def unsupported(self) -> list[EvidenceClaim]:
        """Claims that are not well-formed evidence (missing code/test/artifact)."""
        return [c for c in self._claims if not c.is_supported_shape]

    def highest_defensible_level(self) -> EvidenceLevel:
        """
        The corpus-level evidence tier: the MAX level among SUPPORTED claims only.
        Unsupported / rejected / unverifiable claims never lift the corpus level.
        """
        supported = [c for c in self._claims
                     if c.result == ClaimResult.SUPPORTED.value and c.is_supported_shape]
        if not supported:
            return EvidenceLevel.E0
        return max((EvidenceLevel(c.evidence_level) for c in supported), key=level_rank)

    def summary(self) -> dict:
        by_result: dict = {r.value: 0 for r in ClaimResult}
        by_level: dict = {e.value: 0 for e in EvidenceLevel}
        for c in self._claims:
            by_result[c.result] = by_result.get(c.result, 0) + 1
            by_level[c.evidence_level] = by_level.get(c.evidence_level, 0) + 1
        return {
            "n_claims": len(self._claims),
            "by_result": by_result,
            "by_level": by_level,
            "n_unsupported": len(self.unsupported()),
            "highest_defensible_level": self.highest_defensible_level().value,
        }


__all__ = [
    "EvidenceLevel", "level_rank", "ReproducibilityStatus",
    "IndependentValidationStatus", "ClaimResult", "REPRODUCIBILITY_DEPENDENCIES",
    "EvidenceClaim", "EvidenceLedger",
]
