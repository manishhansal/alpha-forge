"""
Phase 3S — Immutable experiment artifact, hash & reproduction (spec §42, §43, §44).

Every completed experiment produces an IMMUTABLE artifact: manifest, hypothesis,
configuration, dataset manifest, metrics, predictions, trades, portfolio,
statistics, ablations, robustness, comparison, report, and hashes. No credentials
are ever written (spec §55 — reuses the Phase 3Q secret guard).

reproduce(experiment_id) regenerates the experiment's outputs from the immutable
artifact and compares hashes; a mismatch is REPRODUCTION_FAILURE and the
experiment is INVALIDATED (spec §43).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Optional


# The artifact sections (spec §42). `hashes` and `manifest` are written separately.
ARTIFACT_SECTIONS = (
    "hypothesis", "configuration", "dataset_manifest", "metrics", "predictions",
    "trades", "portfolio", "statistics", "ablations", "robustness", "comparison",
    "report",
)


def _hash_obj(obj) -> str:
    raw = json.dumps(obj, sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


class ArtifactError(RuntimeError):
    """Raised on overwrite attempts or secret leakage in an artifact."""


class ArtifactSecretLeak(ArtifactError):
    """Raised when an artifact section contains a credential (spec §55)."""


class ReproductionStatus(str, Enum):
    REPRODUCED           = "REPRODUCED"
    REPRODUCTION_FAILURE = "REPRODUCTION_FAILURE"


@dataclass
class ExperimentArtifact:
    """
    Immutable, hashed experiment artifact (spec §42, §44). Writing an artifact that
    already exists raises ArtifactError (no overwrite — spec §64/§49). Any section
    containing a secret raises ArtifactSecretLeak (spec §55).
    """
    root:            str | Path
    experiment_id:   str

    def __post_init__(self):
        self.dir = Path(self.root) / self.experiment_id

    def freeze(self, *, manifest: dict, sections: dict) -> dict:
        """
        Write the artifact atomically and return the hashes record. `manifest` is
        the ExperimentManifest.to_dict(); `sections` maps ARTIFACT_SECTIONS names to
        JSON-serializable payloads. Missing sections are written as empty. Refuses
        to overwrite an existing artifact directory.
        """
        from src.lifecycle._storage import atomic_write_json
        from src.data_reliability.security import contains_secret

        if self.dir.exists():
            raise ArtifactError(
                f"artifact for '{self.experiment_id}' already exists — experiment "
                f"artifacts are immutable; a change is a NEW experiment (spec §64).")

        # secret guard over manifest + all sections (spec §55)
        if contains_secret(manifest):
            raise ArtifactSecretLeak("manifest contains a credential (spec §55).")
        for name, payload in sections.items():
            if contains_secret(payload):
                raise ArtifactSecretLeak(f"section '{name}' contains a credential (spec §55).")

        self.dir.mkdir(parents=True, exist_ok=True)
        section_hashes: dict[str, str] = {}
        for name in ARTIFACT_SECTIONS:
            payload = sections.get(name, {})
            atomic_write_json(self.dir / f"{name}.json", payload)
            section_hashes[name] = _hash_obj(payload)

        atomic_write_json(self.dir / "manifest.json", manifest)
        artifact_hash = _hash_obj({"manifest": manifest, "sections": section_hashes})
        hashes = {
            "experiment_id":  self.experiment_id,
            "section_hashes": section_hashes,
            "manifest_hash":  _hash_obj(manifest),
            "artifact_hash":  artifact_hash,
        }
        atomic_write_json(self.dir / "hashes.json", hashes)
        return hashes

    def load_hashes(self) -> Optional[dict]:
        from src.lifecycle._storage import read_json
        return read_json(self.dir / "hashes.json")

    def load_section(self, name: str) -> Optional[dict]:
        from src.lifecycle._storage import read_json
        return read_json(self.dir / f"{name}.json")

    def load_manifest(self) -> Optional[dict]:
        from src.lifecycle._storage import read_json
        return read_json(self.dir / "manifest.json")

    def verify_integrity(self) -> tuple[bool, list[str]]:
        """Recompute section hashes and compare to stored (tamper detection)."""
        stored = self.load_hashes()
        if not stored:
            return False, ["hashes.json missing"]
        mismatched = []
        for name, h in stored.get("section_hashes", {}).items():
            payload = self.load_section(name)
            if _hash_obj(payload if payload is not None else {}) != h:
                mismatched.append(name)
        return (len(mismatched) == 0), mismatched


@dataclass
class ReproductionResult:
    status:          ReproductionStatus
    experiment_id:   str
    original_hash:   str
    reproduced_hash: str
    mismatched:      list[str] = field(default_factory=list)

    @property
    def reproduced(self) -> bool:
        return self.status == ReproductionStatus.REPRODUCED

    def to_dict(self) -> dict:
        return {
            "status":          self.status.value,
            "experiment_id":   self.experiment_id,
            "original_hash":   self.original_hash,
            "reproduced_hash": self.reproduced_hash,
            "mismatched":      self.mismatched,
        }


def reproduce(
    artifact: ExperimentArtifact,
    recompute_fn: Callable[[dict], dict],
) -> ReproductionResult:
    """
    Reproduce an experiment (spec §43). `recompute_fn` receives the frozen sections
    and returns a dict of recomputed sections (features/predictions/metrics/trades/
    portfolio/statistics). The recomputed section hashes are compared to the frozen
    ones. Any mismatch => REPRODUCTION_FAILURE (the experiment should be INVALIDATED).
    """
    stored = artifact.load_hashes()
    if not stored:
        return ReproductionResult(ReproductionStatus.REPRODUCTION_FAILURE,
                                  artifact.experiment_id, "", "", ["hashes.json missing"])

    frozen_sections = {n: (artifact.load_section(n) or {}) for n in ARTIFACT_SECTIONS}
    recomputed = recompute_fn(frozen_sections)

    mismatched = []
    for name, payload in recomputed.items():
        if name not in stored.get("section_hashes", {}):
            continue
        if _hash_obj(payload) != stored["section_hashes"][name]:
            mismatched.append(name)

    original_hash = stored.get("artifact_hash", "")
    repro_section_hashes = dict(stored.get("section_hashes", {}))
    for name, payload in recomputed.items():
        repro_section_hashes[name] = _hash_obj(payload)
    reproduced_hash = _hash_obj({"manifest": artifact.load_manifest() or {},
                                 "sections": repro_section_hashes})

    status = (ReproductionStatus.REPRODUCED if not mismatched
              else ReproductionStatus.REPRODUCTION_FAILURE)
    return ReproductionResult(status, artifact.experiment_id, original_hash,
                              reproduced_hash, mismatched)
