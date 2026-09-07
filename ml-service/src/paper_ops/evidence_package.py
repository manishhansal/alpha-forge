"""
Phase 3R — Immutable evidence package + manifest + replay + determinism (§38-§42).

At session close every journal (data / decisions / orders / fills / positions /
pnl / risk / reconciliation / model / configuration / monitoring / report) is
FROZEN into an evidence package with SHA-256 hashes (spec §38-§39). The package is
credential-free (guarded by the 3Q `security.contains_secret` check, spec §47).

`replay(session_id)` reconstructs the session outcome from the immutable evidence
and compares it byte-for-byte with the frozen result; a mismatch is REPLAY_MISMATCH
and the session must be invalidated (spec §41). Determinism is pinned by recording
the RNG seed alongside the manifest (spec §42).

Reuses `paper3o.session_lifecycle.Phase3OSessionManifest` (replay_id) for identity,
`data_reliability.snapshot.SnapshotIdentity` for the dataset fingerprint, and
`lifecycle._storage.atomic_write_json` for crash-safe writes.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _hash_obj(obj: Any) -> str:
    raw = json.dumps(obj, sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


# The canonical evidence sections (spec §39). Every completed session writes these.
EVIDENCE_SECTIONS: tuple[str, ...] = (
    "data", "decisions", "orders", "fills", "positions", "pnl", "risk",
    "reconciliation", "model", "configuration", "monitoring", "report",
)


# ══════════════════════════════════════════════════════════════════════════════
# §40 Session manifest
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class SessionManifest:
    """
    Full identity of a completed session (spec §40). Everything needed to pin and
    replay the evidence. `evidence_hash` is the hash-of-hashes over all sections.
    """
    session_id:        str
    trading_date:      str
    model_id:          str = ""
    model_hash:        str = ""
    calibrator_id:     str = ""
    calibrator_hash:   str = ""
    feature_version:   str = ""
    dataset_version:   str = ""
    cost_model_version: str = ""
    slippage_model_version: str = ""
    portfolio_version: str = ""
    decision_policy_version: str = ""
    code_version:      str = ""
    config_hash:       str = ""
    random_seed:       Optional[int] = None
    rng_version:       str = ""
    section_hashes:    dict = field(default_factory=dict)
    evidence_hash:     str = ""
    final_status:      str = ""
    created_at:        str = field(default_factory=_now)

    def compute_evidence_hash(self) -> str:
        """Hash-of-hashes over the section hashes (spec §40)."""
        return _hash_obj({k: self.section_hashes.get(k) for k in EVIDENCE_SECTIONS})

    def to_dict(self) -> dict:
        d = {
            "session_id": self.session_id, "trading_date": self.trading_date,
            "model_id": self.model_id, "model_hash": self.model_hash,
            "calibrator_id": self.calibrator_id, "calibrator_hash": self.calibrator_hash,
            "feature_version": self.feature_version, "dataset_version": self.dataset_version,
            "cost_model_version": self.cost_model_version,
            "slippage_model_version": self.slippage_model_version,
            "portfolio_version": self.portfolio_version,
            "decision_policy_version": self.decision_policy_version,
            "code_version": self.code_version, "config_hash": self.config_hash,
            "random_seed": self.random_seed, "rng_version": self.rng_version,
            "section_hashes": self.section_hashes, "evidence_hash": self.evidence_hash,
            "final_status": self.final_status, "created_at": self.created_at,
        }
        return d


# ══════════════════════════════════════════════════════════════════════════════
# §38-§39 Immutable evidence package
# ══════════════════════════════════════════════════════════════════════════════

class EvidenceSecretLeak(Exception):
    """Raised if an evidence section would persist a credential (spec §47)."""


class EvidencePackage:
    """
    Writes an immutable, credential-free, hashed evidence package for one session
    (spec §38-§39). Layout under `root/<session_id>/`:
        manifest.json + one <section>.json per EVIDENCE_SECTIONS + hashes.json

    Historical evidence is NEVER overwritten: freezing a session whose directory
    already exists raises (a change must create a NEW version, spec §38).
    """

    def __init__(self, root: str | Path, session_id: str):
        self.root = Path(root)
        self.session_id = session_id
        self.dir = self.root / session_id

    def freeze(self, sections: dict[str, Any], manifest: SessionManifest) -> SessionManifest:
        """
        Freeze all sections + manifest with hashes. Fail-closed on secret leakage.
        Returns the manifest with section_hashes + evidence_hash populated.
        """
        from src.lifecycle._storage import atomic_write_json
        from src.data_reliability import contains_secret

        if self.dir.exists():
            raise FileExistsError(
                f"evidence for {self.session_id} already frozen — a change must "
                "create a new version (spec §38, no overwrite)")
        self.dir.mkdir(parents=True, exist_ok=True)

        section_hashes: dict[str, str] = {}
        for name in EVIDENCE_SECTIONS:
            payload = sections.get(name, {})
            if contains_secret(payload):
                raise EvidenceSecretLeak(
                    f"evidence section '{name}' contains a credential — refused (spec §47)")
            atomic_write_json(self.dir / f"{name}.json", payload)
            section_hashes[name] = _hash_obj(payload)

        manifest.section_hashes = section_hashes
        manifest.evidence_hash = manifest.compute_evidence_hash()
        atomic_write_json(self.dir / "manifest.json", manifest.to_dict())
        atomic_write_json(self.dir / "hashes.json", section_hashes)
        return manifest

    def load_manifest(self) -> Optional[dict]:
        from src.lifecycle._storage import read_json
        return read_json(self.dir / "manifest.json")

    def load_section(self, name: str) -> Any:
        from src.lifecycle._storage import read_json
        return read_json(self.dir / f"{name}.json")

    def verify_integrity(self) -> tuple[bool, list[str]]:
        """
        Recompute every section hash and compare to the frozen manifest (spec §38).
        Returns (ok, mismatched_sections). A mismatch means the evidence was
        tampered with after freezing.
        """
        manifest = self.load_manifest()
        if manifest is None:
            return False, ["manifest_missing"]
        mismatched: list[str] = []
        for name, frozen_hash in manifest.get("section_hashes", {}).items():
            payload = self.load_section(name)
            if _hash_obj(payload) != frozen_hash:
                mismatched.append(name)
        return (not mismatched), mismatched


# ══════════════════════════════════════════════════════════════════════════════
# §41 Replay + §42 determinism
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ReplayResult:
    session_id:   str
    matches:      bool
    original_hash: str
    replayed_hash: str
    mismatch:     bool = False

    def to_dict(self) -> dict:
        return {"session_id": self.session_id, "matches": self.matches,
                "original_hash": self.original_hash, "replayed_hash": self.replayed_hash,
                "mismatch": self.mismatch}


def replay_session(package: EvidencePackage, recompute_fn) -> ReplayResult:
    """
    Reconstruct the session outcome from the immutable evidence and compare to the
    frozen result (spec §41). `recompute_fn(sections) -> dict` rebuilds the outcome
    (decisions/orders/fills/positions/pnl) deterministically from the frozen inputs.
    A byte-for-byte hash mismatch is REPLAY_MISMATCH.
    """
    manifest = package.load_manifest()
    if manifest is None:
        return ReplayResult(package.session_id, False, "", "", mismatch=True)

    sections = {name: package.load_section(name) for name in EVIDENCE_SECTIONS}
    original = {k: sections.get(k) for k in ("decisions", "orders", "fills",
                                             "positions", "pnl")}
    original_hash = _hash_obj(original)

    replayed = recompute_fn(sections)
    replayed_hash = _hash_obj({k: replayed.get(k) for k in ("decisions", "orders",
                                                            "fills", "positions", "pnl")})
    matches = (original_hash == replayed_hash)
    return ReplayResult(package.session_id, matches, original_hash, replayed_hash,
                        mismatch=not matches)


@dataclass
class RngProvenance:
    """Records the RNG seed + version so a run is reproducible (spec §42)."""
    seed:    int
    version: str = "python-random-v1"

    def to_dict(self) -> dict:
        return {"seed": self.seed, "version": self.version}
