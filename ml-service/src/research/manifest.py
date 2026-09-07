"""
Phase 3S — Experiment identity & manifest (spec §3, §4, §44).

Every experiment receives an IMMUTABLE identity that references everything needed
to reproduce it: hypothesis, type, dataset, universe, feature/label/model version,
training/validation/cost/execution/portfolio config hashes, random seed, code
version, environment version.

Two experiments with identical inputs produce the SAME experiment hash (§44).
Historical experiment records are immutable (§4, §49) — a status change is a NEW
append event, never a mutation.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_obj(obj) -> str:
    raw = json.dumps(obj, sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


# ══════════════════════════════════════════════════════════════════════════════
# §4 Experiment status
# ══════════════════════════════════════════════════════════════════════════════

class ExperimentStatus(str, Enum):
    """Experiment lifecycle status (spec §4)."""
    CREATED                 = "CREATED"
    RUNNING                 = "RUNNING"
    COMPLETED               = "COMPLETED"
    FAILED                  = "FAILED"
    INVALIDATED             = "INVALIDATED"
    REJECTED                = "REJECTED"
    PROMOTABLE              = "PROMOTABLE"
    PROMOTED_TO_CHALLENGER  = "PROMOTED_TO_CHALLENGER"
    ABANDONED               = "ABANDONED"


# Terminal statuses — a completed/failed/invalidated/rejected experiment record is
# frozen; further work requires a NEW experiment (spec §64).
TERMINAL_STATUSES = frozenset({
    ExperimentStatus.COMPLETED,
    ExperimentStatus.FAILED,
    ExperimentStatus.INVALIDATED,
    ExperimentStatus.REJECTED,
    ExperimentStatus.PROMOTED_TO_CHALLENGER,
    ExperimentStatus.ABANDONED,
})

# Allowed forward transitions.
_VALID_TRANSITIONS: dict[ExperimentStatus, set[ExperimentStatus]] = {
    ExperimentStatus.CREATED:    {ExperimentStatus.RUNNING, ExperimentStatus.INVALIDATED,
                                  ExperimentStatus.ABANDONED},
    ExperimentStatus.RUNNING:    {ExperimentStatus.COMPLETED, ExperimentStatus.FAILED,
                                  ExperimentStatus.INVALIDATED, ExperimentStatus.ABANDONED},
    ExperimentStatus.COMPLETED:  {ExperimentStatus.PROMOTABLE, ExperimentStatus.REJECTED,
                                  ExperimentStatus.INVALIDATED},
    ExperimentStatus.PROMOTABLE: {ExperimentStatus.PROMOTED_TO_CHALLENGER,
                                  ExperimentStatus.REJECTED, ExperimentStatus.INVALIDATED},
    ExperimentStatus.FAILED:     set(),
    ExperimentStatus.INVALIDATED: set(),
    ExperimentStatus.REJECTED:   set(),
    ExperimentStatus.PROMOTED_TO_CHALLENGER: set(),
    ExperimentStatus.ABANDONED:  set(),
}


def is_valid_status_transition(frm: ExperimentStatus, to: ExperimentStatus) -> bool:
    return to in _VALID_TRANSITIONS.get(frm, set())


class ExperimentImmutabilityError(RuntimeError):
    """Raised on an attempt to mutate a frozen/completed experiment manifest."""


# ══════════════════════════════════════════════════════════════════════════════
# §3, §4, §44 Experiment manifest
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class ExperimentManifest:
    """
    Immutable experiment identity (spec §4). frozen=True enforces immutability at
    the Python level. The experiment can be reproduced from this manifest.

    `experiment_hash` (spec §44) is deterministic over code + dataset + universe +
    features + labels + model + configuration + seed + environment. Two experiments
    with identical inputs produce the same hash.
    """
    experiment_id:            str
    hypothesis_id:            str
    experiment_type:          str            # HypothesisType value
    created_at:               str = field(default_factory=_now_iso)
    author:                   str = "researcher"
    parent_experiment_id:     str = ""       # lineage (§36 data-snooping control)

    # Code / environment
    code_commit:              str = ""
    software_environment:     str = ""

    # Data identity
    dataset_id:               str = ""
    dataset_hash:             str = ""
    universe_id:              str = ""
    feature_version:          str = ""
    label_version:            str = ""

    # Model identity
    model_type:               str = ""
    model_config_hash:        str = ""

    # Configuration hashes
    training_config_hash:     str = ""
    validation_config_hash:   str = ""
    cost_config_hash:         str = ""
    execution_config_hash:    str = ""
    portfolio_config_hash:    str = ""

    # Randomness (§45)
    random_seed:              int = 12345

    # Status (initial; changes are NEW append events, never in-place)
    status:                   str = ExperimentStatus.CREATED.value

    def _identity_payload(self) -> dict:
        """Fields that define reproducible identity (§44). Excludes timestamps,
        author, status, and lineage — those don't change what the experiment
        computes."""
        return {
            "hypothesis_id":          self.hypothesis_id,
            "experiment_type":        self.experiment_type,
            "code_commit":            self.code_commit,
            "software_environment":   self.software_environment,
            "dataset_id":             self.dataset_id,
            "dataset_hash":           self.dataset_hash,
            "universe_id":            self.universe_id,
            "feature_version":        self.feature_version,
            "label_version":          self.label_version,
            "model_type":             self.model_type,
            "model_config_hash":      self.model_config_hash,
            "training_config_hash":   self.training_config_hash,
            "validation_config_hash": self.validation_config_hash,
            "cost_config_hash":       self.cost_config_hash,
            "execution_config_hash":  self.execution_config_hash,
            "portfolio_config_hash":  self.portfolio_config_hash,
            "random_seed":            self.random_seed,
        }

    @property
    def experiment_hash(self) -> str:
        """Deterministic identity hash (spec §44)."""
        return _hash_obj(self._identity_payload())

    def same_identity_as(self, other: "ExperimentManifest") -> bool:
        """True if the two manifests represent the same reproducible experiment."""
        return self.experiment_hash == other.experiment_hash

    def to_dict(self) -> dict:
        d = asdict(self)
        d["experiment_hash"] = self.experiment_hash
        return d


# ══════════════════════════════════════════════════════════════════════════════
# Experiment registry (append-only, immutable history — §49)
# ══════════════════════════════════════════════════════════════════════════════

class ResearchExperimentRegistry:
    """
    Append-only research-experiment registry (spec §4, §49). Distinct from the
    paper-oriented paper3o.ExperimentRegistry — this one tracks full research
    identity + status lineage. Never overwrites a historical record; a status
    change is a NEW append event. Duplicate experiment_id is rejected.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "experiments.jsonl"

    def register(self, manifest: ExperimentManifest) -> ExperimentManifest:
        from src.lifecycle._storage import append_jsonl
        if self._register_event(manifest.experiment_id) is not None:
            raise ExperimentImmutabilityError(
                f"experiment_id '{manifest.experiment_id}' already registered — "
                f"historical experiments are immutable (spec §4, §49)."
            )
        append_jsonl(self.path, {"event": "REGISTER", **manifest.to_dict()})
        return manifest

    def update_status(self, experiment_id: str, status: ExperimentStatus,
                      reason: str = "", metrics: Optional[dict] = None) -> None:
        """
        Record a status change as a NEW append event (never mutates the original).
        Rejects invalid transitions and mutation of terminal experiments (§64).
        """
        from src.lifecycle._storage import append_jsonl
        current = self.current(experiment_id)
        if current is None:
            raise ExperimentImmutabilityError(
                f"cannot update unknown experiment '{experiment_id}'.")
        cur_status = ExperimentStatus(current.get("status", ExperimentStatus.CREATED.value))
        if cur_status in TERMINAL_STATUSES:
            raise ExperimentImmutabilityError(
                f"experiment '{experiment_id}' is terminal ({cur_status.value}); a "
                f"change requires a NEW experiment (spec §64).")
        if not is_valid_status_transition(cur_status, status):
            raise ExperimentImmutabilityError(
                f"invalid status transition {cur_status.value} -> {status.value}.")
        rec = {"event": "UPDATE", "experiment_id": experiment_id,
               "status": status.value, "reason": reason, "timestamp": _now_iso()}
        if metrics is not None:
            rec["metrics"] = metrics
        append_jsonl(self.path, rec)

    def all(self) -> list[dict]:
        from src.lifecycle._storage import read_jsonl
        return read_jsonl(self.path) if self.path.exists() else []

    def _register_event(self, experiment_id: str) -> Optional[dict]:
        for rec in self.all():
            if rec.get("event") == "REGISTER" and rec.get("experiment_id") == experiment_id:
                return rec
        return None

    def current(self, experiment_id: str) -> Optional[dict]:
        """Fold the append-only log into the current state of one experiment."""
        state: Optional[dict] = None
        for rec in self.all():
            if rec.get("experiment_id") != experiment_id:
                continue
            if rec.get("event") == "REGISTER":
                state = {k: v for k, v in rec.items() if k != "event"}
            elif rec.get("event") == "UPDATE" and state is not None:
                for k in ("status", "reason", "metrics"):
                    if k in rec:
                        state[k] = rec[k]
        return state

    def lineage(self, experiment_id: str) -> list[str]:
        """Return the parent chain (root-most first) for data-snooping control (§36)."""
        chain: list[str] = []
        seen = set()
        cur = experiment_id
        while cur and cur not in seen:
            seen.add(cur)
            reg = self._register_event(cur)
            if reg is None:
                break
            parent = reg.get("parent_experiment_id", "")
            if parent:
                chain.append(parent)
            cur = parent
        return list(reversed(chain))
