"""
Phase 3J — Model Artifact Integrity.

Computes and verifies SHA-256 hashes of model artifact files.

Design rules
------------
1. Every model artifact must have a SHA-256 hash (spec §5).
2. Before loading a model, verify its integrity.
3. If verification fails → MODEL_ARTIFACT_INTEGRITY_FAILURE and fail closed.
   NEVER load an artifact whose hash does not match.
4. "latest.pkl" / "current_model" are NEVER valid references (spec §52).
   Loading must be by (model_id, model_version) via the registry.
5. No np.random.* — deterministic.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .schemas import IntegrityStatus


# Filenames that must never be used as production references (spec §52)
FORBIDDEN_ARTIFACT_NAMES = {
    "latest", "latest.pkl", "latest_model", "current", "current.pkl",
    "current_model", "current_model.pkl", "model.pkl", "latest.json",
}

_HASH_CHUNK_SIZE = 1 << 20   # 1 MB


@dataclass
class ArtifactIntegrityResult:
    """Result of an artifact integrity verification."""
    status:            IntegrityStatus
    expected_hash:     str
    actual_hash:       Optional[str]
    artifact_path:     str
    artifact_size:     Optional[int]
    reason:            str = ""

    @property
    def verified(self) -> bool:
        return self.status == IntegrityStatus.VERIFIED


def compute_artifact_hash(path: str | Path) -> str:
    """
    Compute the SHA-256 hash of a file (or, for a directory artifact, a
    deterministic hash over all files sorted by relative path).

    Directory support is needed because some models (e.g. RiskPredictor)
    save multiple sub-model files into a directory.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Artifact not found: {p}")

    h = hashlib.sha256()

    if p.is_dir():
        # Hash all files in sorted order (relative path + content)
        for file in sorted(p.rglob("*")):
            if file.is_file():
                rel = str(file.relative_to(p)).encode()
                h.update(rel)
                h.update(b"\x00")
                with open(file, "rb") as f:
                    for chunk in iter(lambda: f.read(_HASH_CHUNK_SIZE), b""):
                        h.update(chunk)
    else:
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(_HASH_CHUNK_SIZE), b""):
                h.update(chunk)

    return h.hexdigest()


def artifact_size_bytes(path: str | Path) -> int:
    """Total size in bytes of a file or directory artifact."""
    p = Path(path)
    if p.is_dir():
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    return p.stat().st_size


def is_forbidden_reference(path: str | Path) -> bool:
    """
    Return True if the path uses a forbidden 'latest'/'current' reference
    (spec §52). Such references must never be used as production models.
    """
    name = Path(path).name.lower()
    stem = Path(path).stem.lower()
    return name in FORBIDDEN_ARTIFACT_NAMES or stem in {"latest", "current", "latest_model", "current_model"}


def verify_artifact_integrity(
    path: str | Path,
    expected_hash: str,
) -> ArtifactIntegrityResult:
    """
    Verify that the artifact at `path` matches `expected_hash`.

    Fail-closed behaviour (spec §5):
    - Missing artifact       → ARTIFACT_MISSING
    - Hash mismatch          → MODEL_ARTIFACT_INTEGRITY_FAILURE
    - Forbidden reference    → MODEL_ARTIFACT_INTEGRITY_FAILURE (spec §52)
    - Match                  → VERIFIED

    Returns
    -------
    ArtifactIntegrityResult. Callers MUST check `.verified` before loading.
    """
    p = Path(path)

    # Spec §52: forbidden 'latest'/'current' references are never valid
    if is_forbidden_reference(p):
        return ArtifactIntegrityResult(
            status=IntegrityStatus.INTEGRITY_FAILURE,
            expected_hash=expected_hash,
            actual_hash=None,
            artifact_path=str(p),
            artifact_size=None,
            reason=(
                f"FORBIDDEN_REFERENCE: '{p.name}' is a 'latest'/'current' style "
                "reference and must never be used as a production model. Load by "
                "(model_id, model_version) via the registry instead."
            ),
        )

    if not p.exists():
        return ArtifactIntegrityResult(
            status=IntegrityStatus.ARTIFACT_MISSING,
            expected_hash=expected_hash,
            actual_hash=None,
            artifact_path=str(p),
            artifact_size=None,
            reason=f"Artifact not found at {p}.",
        )

    actual = compute_artifact_hash(p)
    size = artifact_size_bytes(p)

    if actual != expected_hash:
        return ArtifactIntegrityResult(
            status=IntegrityStatus.INTEGRITY_FAILURE,
            expected_hash=expected_hash,
            actual_hash=actual,
            artifact_path=str(p),
            artifact_size=size,
            reason=(
                f"MODEL_ARTIFACT_INTEGRITY_FAILURE: expected hash {expected_hash[:16]}… "
                f"but computed {actual[:16]}…. The artifact has been modified or "
                "corrupted. Refusing to load (fail-closed)."
            ),
        )

    return ArtifactIntegrityResult(
        status=IntegrityStatus.VERIFIED,
        expected_hash=expected_hash,
        actual_hash=actual,
        artifact_path=str(p),
        artifact_size=size,
        reason="",
    )


def safe_load_guard(
    path: str | Path,
    expected_hash: str,
) -> ArtifactIntegrityResult:
    """
    Guard to be called BEFORE loading any model artifact.

    Raises RuntimeError (fail-closed) if integrity verification fails.
    Returns the ArtifactIntegrityResult on success.

    Usage
    -----
    ::
        result = safe_load_guard(path, expected_hash)   # raises on failure
        model = load_model(path)                        # only reached if verified
    """
    result = verify_artifact_integrity(path, expected_hash)
    if not result.verified:
        raise RuntimeError(result.reason)
    return result
