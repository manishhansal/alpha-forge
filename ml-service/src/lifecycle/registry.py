"""
Phase 3J — Persistent Versioned Model Registry.

The authoritative store of model identities, lifecycle states, evidence, and
the full audit log.

Design rules
------------
1. (model_id, model_version) is IMMUTABLE once registered (spec §9). The
   artifact underneath must never change. Re-registering the same version with
   a DIFFERENT artifact hash is rejected.
2. Every operation is atomic (temp+rename) and cross-process safe (file lock).
3. Every lifecycle event is appended to an immutable JSONL audit log (spec §54).
4. State transitions are validated against the state machine (spec §57).
   Invalid transitions fail.
5. Operations are idempotent (spec §55).
6. Fail-closed: missing/mismatched artifacts block registration/loading.
7. No np.random.* — deterministic.

This is SEPARATE from the runtime health registry in monitoring/model_registry.py.
That registry tracks HEALTHY/WARNING/DEGRADED. This registry tracks the
versioned lifecycle (REGISTERED → ... → CHAMPION) and governance.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ._storage import FileLock, append_jsonl, atomic_write_json, read_json, read_jsonl
from .schemas import (
    LifecycleState, ModelIdentity, ModelProvenance, ModelSchemaContract,
    TERMINAL_STATES, is_valid_transition,
)

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ── Registry record ────────────────────────────────────────────────────────────

@dataclass
class RegistryRecord:
    """One immutable model version in the registry."""
    identity:             dict                 # ModelIdentity.to_dict()
    provenance:           dict                 # ModelProvenance.to_dict()
    schema_contract:      Optional[dict]       # ModelSchemaContract.to_dict()
    lifecycle_state:      str                  # LifecycleState value
    evidence_package_id:  str = ""
    registered_at:        str = ""
    updated_at:           str = ""
    state_history:        list[dict] = field(default_factory=list)
    notes:                str = ""

    @property
    def full_key(self) -> str:
        return self.identity.get("full_key", "")

    @property
    def artifact_hash(self) -> str:
        return self.identity.get("artifact_hash", "")


# ── Errors ─────────────────────────────────────────────────────────────────────

class RegistryError(RuntimeError):
    pass


class ImmutabilityViolation(RegistryError):
    pass


class InvalidTransition(RegistryError):
    pass


# ── Model registry ───────────────────────────────────────────────────────────

class ModelRegistry:
    """
    Persistent versioned model registry.

    Layout under `root`:
        root/
        ├── models/<full_key>.json      — one immutable record per model version
        ├── audit_log.jsonl             — append-only lifecycle audit log
        └── .registry.lock              — cross-process lock file

    Usage
    -----
    ::
        reg = ModelRegistry(root="./registry")
        reg.register(identity, provenance, schema_contract)
        reg.transition(full_key, LifecycleState.VALIDATING, reason="...")
        rec = reg.get(full_key)
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.models_dir = self.root / "models"
        self.audit_path = self.root / "audit_log.jsonl"
        self.lock_path = self.root / ".registry.lock"
        self.models_dir.mkdir(parents=True, exist_ok=True)

    # ── Audit ─────────────────────────────────────────────────────────────────

    def _audit(
        self,
        event: str,
        obj: str,
        previous_state: Optional[str],
        new_state: Optional[str],
        reason: str,
        evidence: str = "",
        actor: str = "system",
    ) -> None:
        append_jsonl(self.audit_path, {
            "timestamp":      _now(),
            "actor":          actor,
            "event":          event,
            "object":         obj,
            "previous_state": previous_state,
            "new_state":      new_state,
            "reason":         reason,
            "evidence":       evidence,
        })

    def audit_log(self) -> list[dict]:
        """Return the full immutable audit log."""
        return read_jsonl(self.audit_path)

    # ── Paths ──────────────────────────────────────────────────────────────────

    def _record_path(self, full_key: str) -> Path:
        safe = full_key.replace("/", "-").replace("@", "__at__")
        return self.models_dir / f"{safe}.json"

    # ── Registration ─────────────────────────────────────────────────────────

    def register(
        self,
        identity: ModelIdentity,
        provenance: ModelProvenance,
        schema_contract: Optional[ModelSchemaContract] = None,
        actor: str = "system",
    ) -> RegistryRecord:
        """
        Register a model version.

        Idempotent (spec §55): re-registering an identical (same artifact_hash)
        version is a no-op that returns the existing record.

        Immutability (spec §9): re-registering the same (model_id, model_version)
        with a DIFFERENT artifact_hash raises ImmutabilityViolation.
        """
        full_key = identity.full_key
        with FileLock(self.lock_path):
            path = self._record_path(full_key)
            existing = read_json(path)

            if existing is not None:
                existing_hash = existing["identity"].get("artifact_hash", "")
                if existing_hash != identity.artifact_hash:
                    raise ImmutabilityViolation(
                        f"{full_key} already registered with artifact_hash "
                        f"{existing_hash[:16]}…; refusing to overwrite with "
                        f"{identity.artifact_hash[:16]}…. Create a NEW model_version."
                    )
                # Idempotent no-op
                return RegistryRecord(**existing)

            record = RegistryRecord(
                identity=identity.to_dict(),
                provenance=provenance.to_dict(),
                schema_contract=schema_contract.to_dict() if schema_contract else None,
                lifecycle_state=LifecycleState.REGISTERED.value,
                registered_at=_now(),
                updated_at=_now(),
                state_history=[{
                    "timestamp": _now(),
                    "from":      None,
                    "to":        LifecycleState.REGISTERED.value,
                    "reason":    "Initial registration",
                }],
            )
            atomic_write_json(path, asdict(record))
            self._audit(
                "REGISTER", full_key, None, LifecycleState.REGISTERED.value,
                "Initial registration", evidence=identity.identity_hash, actor=actor,
            )
            return record

    # ── Retrieval ──────────────────────────────────────────────────────────────

    def get(self, full_key: str) -> Optional[RegistryRecord]:
        data = read_json(self._record_path(full_key))
        return RegistryRecord(**data) if data is not None else None

    def exists(self, full_key: str) -> bool:
        return self._record_path(full_key).exists()

    def list_keys(self) -> list[str]:
        keys = []
        for p in sorted(self.models_dir.glob("*.json")):
            data = read_json(p)
            if data:
                keys.append(data["identity"].get("full_key", p.stem))
        return keys

    def list_records(self) -> list[RegistryRecord]:
        return [r for k in self.list_keys() if (r := self.get(k)) is not None]

    def list_by_state(self, state: LifecycleState) -> list[RegistryRecord]:
        return [r for r in self.list_records() if r.lifecycle_state == state.value]

    # ── State transitions ──────────────────────────────────────────────────────

    def transition(
        self,
        full_key: str,
        to_state: LifecycleState,
        reason: str,
        evidence: str = "",
        actor: str = "system",
    ) -> RegistryRecord:
        """
        Transition a model to a new lifecycle state.

        Validates the transition against the state machine (spec §57).
        Invalid transitions raise InvalidTransition. Atomic + audited.
        """
        with FileLock(self.lock_path):
            data = read_json(self._record_path(full_key))
            if data is None:
                raise RegistryError(f"Model {full_key} is not registered.")

            record = RegistryRecord(**data)
            from_state = LifecycleState(record.lifecycle_state)

            # Idempotent: transitioning to the same state is a no-op
            if from_state == to_state:
                return record

            if not is_valid_transition(from_state, to_state):
                raise InvalidTransition(
                    f"Invalid transition {from_state.value} → {to_state.value} "
                    f"for {full_key}. Allowed: "
                    f"{sorted(s.value for s in _allowed(from_state))}."
                )

            record.lifecycle_state = to_state.value
            record.updated_at = _now()
            record.state_history.append({
                "timestamp": _now(),
                "from":      from_state.value,
                "to":        to_state.value,
                "reason":    reason,
            })
            if evidence and to_state in (LifecycleState.EVIDENCE_READY, LifecycleState.PROMOTION_ELIGIBLE):
                record.evidence_package_id = evidence

            atomic_write_json(self._record_path(full_key), asdict(record))
            self._audit(
                _event_for_state(to_state), full_key, from_state.value,
                to_state.value, reason, evidence=evidence, actor=actor,
            )
            return record

    # ── Attach evidence ─────────────────────────────────────────────────────────

    def attach_evidence(self, full_key: str, evidence_package_id: str, actor: str = "system") -> RegistryRecord:
        """Attach an evidence package id to a model record."""
        with FileLock(self.lock_path):
            data = read_json(self._record_path(full_key))
            if data is None:
                raise RegistryError(f"Model {full_key} is not registered.")
            record = RegistryRecord(**data)
            record.evidence_package_id = evidence_package_id
            record.updated_at = _now()
            atomic_write_json(self._record_path(full_key), asdict(record))
            self._audit(
                "ATTACH_EVIDENCE", full_key, record.lifecycle_state,
                record.lifecycle_state, "Evidence package attached",
                evidence=evidence_package_id, actor=actor,
            )
            return record


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _allowed(state: LifecycleState) -> set:
    from .schemas import VALID_TRANSITIONS
    return VALID_TRANSITIONS.get(state, set())


def _event_for_state(state: LifecycleState) -> str:
    mapping = {
        LifecycleState.VALIDATING:         "VALIDATE",
        LifecycleState.EVIDENCE_READY:     "EVIDENCE_READY",
        LifecycleState.CANDIDATE:          "CANDIDATE",
        LifecycleState.SHADOW:             "SHADOW_START",
        LifecycleState.PAPER:              "PAPER_START",
        LifecycleState.PROMOTION_ELIGIBLE: "PROMOTION_ELIGIBLE",
        LifecycleState.CHAMPION:           "PROMOTED",
        LifecycleState.REJECTED:           "REJECTED",
        LifecycleState.BLOCKED:            "BLOCKED",
        LifecycleState.RETIRED:            "RETIRED",
        LifecycleState.ROLLED_BACK:        "ROLLBACK",
        LifecycleState.ABSTAINED:          "ABSTAINED",
    }
    return mapping.get(state, "TRANSITION")
