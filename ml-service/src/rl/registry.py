"""
Phase 3L — RL experiment + offline-trajectory registries.

Persistent, append-only registries for RL experiments and immutable offline
trajectory datasets. Integrates with Phase 3J: `register_as_challenger` wires a
COMPLETED experiment into the lifecycle `ModelRegistry` + `ChallengerRegistry`
so an RL agent can ONLY reach production through the existing governance
(spec §39, §40, §71, §72, §75). It never auto-promotes (spec §92).

Stdlib only. Reuses lifecycle._storage atomic writes + JSONL. No np.random.*.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from src.lifecycle._storage import atomic_write_json, read_json, append_jsonl, read_jsonl, FileLock
from .schemas import (
    RLExperiment, ExperimentStatus, is_valid_experiment_transition,
    Transition, TrajectoryDatasetMeta,
)

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


class RLRegistryError(Exception):
    pass


class InvalidExperimentTransition(RLRegistryError):
    pass


# ══════════════════════════════════════════════════════════════════════════════
# Experiment registry
# ══════════════════════════════════════════════════════════════════════════════

class RLExperimentRegistry:
    """Persistent RL experiment registry (spec §71)."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.exp_dir = self.root / "experiments"
        self.prov_dir = self.root / "provenance"
        self.audit_path = self.root / "rl_experiment_log.jsonl"
        self.exp_dir.mkdir(parents=True, exist_ok=True)
        self.prov_dir.mkdir(parents=True, exist_ok=True)

    def _exp_path(self, experiment_id: str) -> Path:
        return self.exp_dir / f"{experiment_id}.json"

    def _lock(self, experiment_id: str) -> FileLock:
        return FileLock(self.root / f".{experiment_id}.lock")

    def register(self, experiment: RLExperiment, provenance: Optional[dict] = None) -> RLExperiment:
        path = self._exp_path(experiment.experiment_id)
        with self._lock(experiment.experiment_id):
            existing = read_json(path)
            if existing is not None:
                if (existing.get("agent_id") != experiment.agent_id
                        or existing.get("algorithm") != experiment.algorithm):
                    raise RLRegistryError(
                        f"Experiment {experiment.experiment_id} exists with different identity."
                    )
                return RLExperiment.from_dict(existing)
            now = _now()
            experiment.created_at = experiment.created_at or now
            experiment.updated_at = now
            experiment.status_history = experiment.status_history or [
                {"status": experiment.status.value, "at": now, "reason": "registered"}
            ]
            atomic_write_json(path, experiment.to_dict())
            if provenance is not None:
                atomic_write_json(self.prov_dir / f"{experiment.experiment_id}.json", provenance)
            append_jsonl(self.audit_path, {
                "event": "REGISTER", "experiment_id": experiment.experiment_id,
                "agent_id": experiment.agent_id, "algorithm": experiment.algorithm,
                "status": experiment.status.value, "at": now,
            })
        return experiment

    def get(self, experiment_id: str) -> Optional[RLExperiment]:
        data = read_json(self._exp_path(experiment_id))
        return RLExperiment.from_dict(data) if data is not None else None

    def list_experiments(self) -> list[RLExperiment]:
        out = []
        for p in sorted(self.exp_dir.glob("*.json")):
            data = read_json(p)
            if data is not None:
                out.append(RLExperiment.from_dict(data))
        return out

    def list_by_status(self, status: ExperimentStatus) -> list[RLExperiment]:
        return [e for e in self.list_experiments() if e.status == status]

    def transition(self, experiment_id: str, to_status: ExperimentStatus, reason: str = "") -> RLExperiment:
        with self._lock(experiment_id):
            data = read_json(self._exp_path(experiment_id))
            if data is None:
                raise RLRegistryError(f"Unknown experiment: {experiment_id}")
            exp = RLExperiment.from_dict(data)
            if exp.status == to_status:
                return exp
            if not is_valid_experiment_transition(exp.status, to_status):
                raise InvalidExperimentTransition(
                    f"Invalid transition {exp.status.value} -> {to_status.value}"
                )
            now = _now()
            prev = exp.status.value
            exp.status = to_status
            exp.updated_at = now
            if to_status == ExperimentStatus.REJECTED and reason:
                exp.rejection_reason = reason
            exp.status_history.append({"status": to_status.value, "at": now, "reason": reason})
            atomic_write_json(self._exp_path(experiment_id), exp.to_dict())
            append_jsonl(self.audit_path, {
                "event": "TRANSITION", "experiment_id": experiment_id,
                "from": prev, "to": to_status.value, "reason": reason, "at": now,
            })
        return exp

    def record_results(self, experiment_id: str, results: dict,
                       model_value_class: str = "", ope_status: str = "") -> RLExperiment:
        with self._lock(experiment_id):
            data = read_json(self._exp_path(experiment_id))
            if data is None:
                raise RLRegistryError(f"Unknown experiment: {experiment_id}")
            exp = RLExperiment.from_dict(data)
            exp.results = dict(results)
            if model_value_class:
                exp.model_value_class = model_value_class
            if ope_status:
                exp.ope_status = ope_status
            exp.updated_at = _now()
            atomic_write_json(self._exp_path(experiment_id), exp.to_dict())
            append_jsonl(self.audit_path, {
                "event": "RESULTS", "experiment_id": experiment_id,
                "model_value_class": exp.model_value_class, "at": exp.updated_at,
            })
        return exp

    def mark_final_holdout_used(self, experiment_id: str) -> tuple[bool, str]:
        """
        Record a single evaluation of the final holdout (spec §87).
        Returns (ok, status). If used more than once -> FINAL_HOLDOUT_CONTAMINATED.
        """
        with self._lock(experiment_id):
            data = read_json(self._exp_path(experiment_id))
            if data is None:
                raise RLRegistryError(f"Unknown experiment: {experiment_id}")
            exp = RLExperiment.from_dict(data)
            exp.final_holdout_used_count += 1
            exp.updated_at = _now()
            atomic_write_json(self._exp_path(experiment_id), exp.to_dict())
            if exp.final_holdout_used_count > 1:
                append_jsonl(self.audit_path, {
                    "event": "FINAL_HOLDOUT_CONTAMINATED", "experiment_id": experiment_id,
                    "count": exp.final_holdout_used_count, "at": exp.updated_at,
                })
                return False, "FINAL_HOLDOUT_CONTAMINATED"
            return True, "OK"

    def register_as_challenger(
        self, experiment_id: str, lifecycle_registry, challenger_registry,
        identity, provenance, scope: str, schema_contract=None, evidence_package_id: str = "",
    ) -> str:
        """
        Wire a COMPLETED RL experiment into Phase 3J as a CHALLENGER (spec §40).
        Blocks if the experiment's final holdout was contaminated (spec §87) or
        RL showed no incremental value (caller sets status).
        """
        exp = self.get(experiment_id)
        if exp is None:
            raise RLRegistryError(f"Unknown experiment: {experiment_id}")
        if exp.status not in (ExperimentStatus.COMPLETED, ExperimentStatus.PROMOTION_ELIGIBLE):
            raise RLRegistryError(
                f"Experiment {experiment_id} must be COMPLETED before challenger (status={exp.status.value})."
            )
        if exp.final_holdout_used_count > 1:
            raise RLRegistryError(
                f"Experiment {experiment_id}: FINAL_HOLDOUT_CONTAMINATED; cannot become challenger (spec §87)."
            )
        lifecycle_registry.register(identity, provenance, schema_contract, actor="phase3l")
        challenger_id = f"chal-{exp.agent_id}"
        challenger_registry.register(
            challenger_id=challenger_id, model_full_key=identity.full_key,
            scope=scope, evidence_package_id=evidence_package_id,
        )
        append_jsonl(self.audit_path, {
            "event": "REGISTER_AS_CHALLENGER", "experiment_id": experiment_id,
            "challenger_id": challenger_id, "model_full_key": identity.full_key,
            "scope": scope, "at": _now(),
        })
        return challenger_id

    def audit_log(self) -> list[dict]:
        return read_jsonl(self.audit_path)


# ══════════════════════════════════════════════════════════════════════════════
# Offline trajectory registry (immutable — spec §72)
# ══════════════════════════════════════════════════════════════════════════════

class TrajectoryRegistry:
    """
    Immutable offline-trajectory dataset store (spec §72). Trajectories are
    NEVER modified once written; a content hash detects tampering.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.traj_dir = self.root / "trajectories"
        self.meta_dir = self.root / "trajectory_meta"
        self.traj_dir.mkdir(parents=True, exist_ok=True)
        self.meta_dir.mkdir(parents=True, exist_ok=True)

    def _traj_path(self, trajectory_id: str) -> Path:
        return self.traj_dir / f"{trajectory_id}.jsonl"

    def _meta_path(self, trajectory_id: str) -> Path:
        return self.meta_dir / f"{trajectory_id}.json"

    @staticmethod
    def _content_hash(transitions: list[Transition]) -> str:
        raw = json.dumps([t.to_dict() for t in transitions], sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()

    def write(
        self, trajectory_id: str, transitions: list[Transition],
        source_policy: str, data_snapshot: str, environment_version: str,
        episode_count: int,
    ) -> TrajectoryDatasetMeta:
        """Write a new immutable trajectory dataset. Re-writing raises."""
        tp = self._traj_path(trajectory_id)
        if tp.exists():
            raise RLRegistryError(f"Trajectory {trajectory_id} already exists (immutable).")
        for t in transitions:
            append_jsonl(tp, t.to_dict())
        meta = TrajectoryDatasetMeta(
            trajectory_id=trajectory_id, source_policy=source_policy,
            data_snapshot=data_snapshot, environment_version=environment_version,
            episode_count=episode_count, observation_count=len(transitions),
            created_at=_now(), content_hash=self._content_hash(transitions),
        )
        atomic_write_json(self._meta_path(trajectory_id), meta.to_dict())
        return meta

    def read(self, trajectory_id: str) -> list[Transition]:
        rows = read_jsonl(self._traj_path(trajectory_id))
        return [Transition(**r) for r in rows]

    def meta(self, trajectory_id: str) -> Optional[TrajectoryDatasetMeta]:
        data = read_json(self._meta_path(trajectory_id))
        return TrajectoryDatasetMeta(**data) if data is not None else None

    def verify_integrity(self, trajectory_id: str) -> bool:
        """Recompute the content hash and compare to stored (spec §72)."""
        meta = self.meta(trajectory_id)
        if meta is None:
            return False
        transitions = self.read(trajectory_id)
        return self._content_hash(transitions) == meta.content_hash
