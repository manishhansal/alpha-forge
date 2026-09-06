"""
Phase 3K — Deep-Learning experiment registry.

Persistent, append-only registry of deep-learning experiments. Every experiment
is reproducible from code + data snapshot + seed (spec §60, §62). Failed and
rejected experiments are recorded, never hidden (spec §59).

Integrates with Phase 3J: `register_as_challenger` wires a completed experiment
into `lifecycle.ModelRegistry` + `lifecycle.ChallengerRegistry` so a deep model
can ONLY reach production through the existing governance (spec §28). It never
auto-promotes (spec §29, §83).

Stdlib only. Reuses lifecycle._storage atomic writes (temp + os.replace) and
JSONL audit. No np.random.*.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from src.lifecycle._storage import atomic_write_json, read_json, append_jsonl, FileLock
from .schemas import (
    DeepLearningExperiment,
    ExperimentStatus,
    is_valid_experiment_transition,
    DeepModelProvenance,
)

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


class ExperimentRegistryError(Exception):
    """Raised on invalid experiment-registry operations."""


class InvalidExperimentTransition(ExperimentRegistryError):
    """Raised when an experiment status transition is not allowed."""


class DeepExperimentRegistry:
    """
    Persistent registry of deep-learning experiments.

    Layout:
        root/
          experiments/<experiment_id>.json   — one record per experiment
          provenance/<experiment_id>.json     — frozen provenance
          experiment_log.jsonl                — append-only audit
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.exp_dir = self.root / "experiments"
        self.prov_dir = self.root / "provenance"
        self.audit_path = self.root / "experiment_log.jsonl"
        self.exp_dir.mkdir(parents=True, exist_ok=True)
        self.prov_dir.mkdir(parents=True, exist_ok=True)

    # ── paths ────────────────────────────────────────────────────────────

    def _exp_path(self, experiment_id: str) -> Path:
        return self.exp_dir / f"{experiment_id}.json"

    def _prov_path(self, experiment_id: str) -> Path:
        return self.prov_dir / f"{experiment_id}.json"

    def _lock(self, experiment_id: str) -> FileLock:
        return FileLock(self.root / f".{experiment_id}.lock")

    # ── register ─────────────────────────────────────────────────────────

    def register(
        self,
        experiment: DeepLearningExperiment,
        provenance: Optional[DeepModelProvenance] = None,
    ) -> DeepLearningExperiment:
        """
        Register a new experiment (idempotent for an identical record).

        Re-registering the same experiment_id with a different architecture or
        model_id raises ExperimentRegistryError (immutable identity).
        """
        path = self._exp_path(experiment.experiment_id)
        with self._lock(experiment.experiment_id):
            existing = read_json(path)
            if existing is not None:
                if (existing.get("architecture") != experiment.architecture
                        or existing.get("model_id") != experiment.model_id):
                    raise ExperimentRegistryError(
                        f"Experiment {experiment.experiment_id} already exists with "
                        f"different identity (immutable)."
                    )
                return DeepLearningExperiment.from_dict(existing)

            now = _now()
            experiment.created_at = experiment.created_at or now
            experiment.updated_at = now
            experiment.status_history = experiment.status_history or [
                {"status": experiment.status.value, "at": now, "reason": "registered"}
            ]
            atomic_write_json(path, experiment.to_dict())
            if provenance is not None:
                atomic_write_json(self._prov_path(experiment.experiment_id), provenance.to_dict())
            append_jsonl(self.audit_path, {
                "event": "REGISTER",
                "experiment_id": experiment.experiment_id,
                "model_id": experiment.model_id,
                "architecture": experiment.architecture,
                "status": experiment.status.value,
                "at": now,
            })
        return experiment

    # ── get / list ───────────────────────────────────────────────────────

    def get(self, experiment_id: str) -> Optional[DeepLearningExperiment]:
        data = read_json(self._exp_path(experiment_id))
        return DeepLearningExperiment.from_dict(data) if data is not None else None

    def get_provenance(self, experiment_id: str) -> Optional[dict]:
        return read_json(self._prov_path(experiment_id))

    def list_experiments(self) -> list[DeepLearningExperiment]:
        out: list[DeepLearningExperiment] = []
        for p in sorted(self.exp_dir.glob("*.json")):
            data = read_json(p)
            if data is not None:
                out.append(DeepLearningExperiment.from_dict(data))
        return out

    def list_by_status(self, status: ExperimentStatus) -> list[DeepLearningExperiment]:
        return [e for e in self.list_experiments() if e.status == status]

    # ── transition ───────────────────────────────────────────────────────

    def transition(
        self,
        experiment_id: str,
        to_status: ExperimentStatus,
        reason: str = "",
    ) -> DeepLearningExperiment:
        """Move an experiment to a new status, enforcing the status machine."""
        with self._lock(experiment_id):
            data = read_json(self._exp_path(experiment_id))
            if data is None:
                raise ExperimentRegistryError(f"Unknown experiment: {experiment_id}")
            exp = DeepLearningExperiment.from_dict(data)
            if exp.status == to_status:
                return exp
            if not is_valid_experiment_transition(exp.status, to_status):
                raise InvalidExperimentTransition(
                    f"Invalid experiment transition {exp.status.value} -> {to_status.value}"
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
                "event": "TRANSITION",
                "experiment_id": experiment_id,
                "from": prev,
                "to": to_status.value,
                "reason": reason,
                "at": now,
            })
        return exp

    # ── record results ───────────────────────────────────────────────────

    def record_results(
        self,
        experiment_id: str,
        results: dict,
        model_value_class: str = "",
        contamination_status: str = "",
        overfit_status: str = "",
        evidence_package_id: str = "",
    ) -> DeepLearningExperiment:
        """Attach results to an experiment (does not change status)."""
        with self._lock(experiment_id):
            data = read_json(self._exp_path(experiment_id))
            if data is None:
                raise ExperimentRegistryError(f"Unknown experiment: {experiment_id}")
            exp = DeepLearningExperiment.from_dict(data)
            exp.results = dict(results)
            if model_value_class:
                exp.model_value_class = model_value_class
            if contamination_status:
                exp.contamination_status = contamination_status
            if overfit_status:
                exp.overfit_status = overfit_status
            if evidence_package_id:
                exp.evidence_package_id = evidence_package_id
            exp.updated_at = _now()
            atomic_write_json(self._exp_path(experiment_id), exp.to_dict())
            append_jsonl(self.audit_path, {
                "event": "RESULTS",
                "experiment_id": experiment_id,
                "model_value_class": exp.model_value_class,
                "contamination_status": exp.contamination_status,
                "at": exp.updated_at,
            })
        return exp

    # ── Phase 3J integration ─────────────────────────────────────────────

    def register_as_challenger(
        self,
        experiment_id: str,
        lifecycle_registry,          # src.lifecycle.ModelRegistry
        challenger_registry,         # src.lifecycle.ChallengerRegistry
        identity,                    # src.lifecycle.ModelIdentity
        provenance,                  # src.lifecycle.ModelProvenance
        scope: str,
        schema_contract=None,        # src.lifecycle.ModelSchemaContract | None
        evidence_package_id: str = "",
    ) -> str:
        """
        Wire a COMPLETED experiment into Phase 3J as a CHALLENGER.

        The deep model is registered in the versioned lifecycle registry and the
        challenger registry. It does NOT auto-promote — it must pass the Phase 3J
        promotion gate through SHADOW → PAPER like any other challenger
        (spec §28, §29).

        Blocks challenger registration if the experiment's final OOS was
        contaminated (spec §69).
        """
        exp = self.get(experiment_id)
        if exp is None:
            raise ExperimentRegistryError(f"Unknown experiment: {experiment_id}")
        if exp.status not in (ExperimentStatus.COMPLETED, ExperimentStatus.PROMOTION_ELIGIBLE):
            raise ExperimentRegistryError(
                f"Experiment {experiment_id} must be COMPLETED before it can become "
                f"a challenger (status={exp.status.value})."
            )
        if exp.contamination_status == "FINAL_OOS_CONTAMINATED":
            raise ExperimentRegistryError(
                f"Experiment {experiment_id} has FINAL_OOS_CONTAMINATED evidence; "
                f"it cannot enter Phase 3J as a challenger (spec §69)."
            )

        # Register in the versioned lifecycle registry.
        lifecycle_registry.register(identity, provenance, schema_contract, actor="phase3k")
        challenger_id = f"chal-{exp.model_id}"
        challenger_registry.register(
            challenger_id=challenger_id,
            model_full_key=identity.full_key,
            scope=scope,
            evidence_package_id=evidence_package_id or exp.evidence_package_id,
        )
        append_jsonl(self.audit_path, {
            "event": "REGISTER_AS_CHALLENGER",
            "experiment_id": experiment_id,
            "challenger_id": challenger_id,
            "model_full_key": identity.full_key,
            "scope": scope,
            "at": _now(),
        })
        return challenger_id

    # ── audit ────────────────────────────────────────────────────────────

    def audit_log(self) -> list[dict]:
        if not self.audit_path.exists():
            return []
        out: list[dict] = []
        for line in self.audit_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                import json as _json
                out.append(_json.loads(line))
        return out
