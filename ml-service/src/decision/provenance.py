"""
Phase 3M — Decision provenance + deterministic replay manifest (spec §24).

Reuses the existing `prediction_provenance.DeploymentMode` / `resolve_action`
governance and adds:
  - `ReplayManifest`: everything needed to re-derive a decision from immutable
    inputs (data snapshot, feature/schema/model/calibration/portfolio/execution/
    RL versions, seeds, code + environment version).
  - `LIVE` mode is EXPLICITLY FORBIDDEN in Phase 3M — `assert_not_live()` raises
    if any live deployment is attempted (spec §22, §23).
  - `state_hash` / `replay_id` for deterministic replay verification.

Determinism: pure stdlib; no np.random.*.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

from src.prediction_provenance import DeploymentMode, PredictionProvenance, resolve_action

UTC = timezone.utc


# Phase 3M allows RESEARCH / SHADOW / PAPER only. LIVE is FORBIDDEN.
ALLOWED_DEPLOYMENT_MODES: frozenset[DeploymentMode] = frozenset({
    DeploymentMode.RESEARCH,
    DeploymentMode.SHADOW,
    DeploymentMode.PAPER,
})

# A sentinel string a caller might pass to attempt live mode — always rejected.
LIVE_MODE_TOKENS: frozenset[str] = frozenset({"live", "LIVE", "production", "PRODUCTION"})


class LiveExecutionForbidden(Exception):
    """Raised if any live-execution / live deployment is attempted (spec §23)."""


def assert_not_live(mode) -> None:
    """
    Fail closed if a live mode is requested. Phase 3M is research/shadow/paper
    ONLY (spec §22, §23). VALIDATED_ML_ONLY is permitted as a research gating
    mode but never triggers a broker order (there is no broker path).
    """
    raw = mode.value if isinstance(mode, DeploymentMode) else str(mode)
    if raw in LIVE_MODE_TOKENS:
        raise LiveExecutionForbidden(
            f"Live execution is FORBIDDEN in Phase 3M (requested mode={raw!r}). "
            "Only RESEARCH / SHADOW / PAPER are permitted."
        )


def normalize_mode(mode) -> DeploymentMode:
    """Coerce to a DeploymentMode, rejecting live modes."""
    assert_not_live(mode)
    if isinstance(mode, DeploymentMode):
        return mode
    return DeploymentMode(str(mode))


# ══════════════════════════════════════════════════════════════════════════════
# Replay manifest (spec §24)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ReplayManifest:
    """
    Everything needed to replay a decision from immutable inputs (spec §24).
    Running the same decision twice against these inputs must produce equivalent
    outputs.
    """
    decision_id:            str
    data_snapshot_id:       str = ""
    dataset_version:        str = ""
    feature_version:        str = ""
    feature_schema_hash:    str = ""
    label_version:          str = ""
    label_config_hash:      str = ""
    model_ids:              list[str] = field(default_factory=list)
    model_versions:         list[str] = field(default_factory=list)
    model_hashes:           list[str] = field(default_factory=list)
    calibration_id:         str = ""
    calibration_version:    str = ""
    portfolio_config_version: str = ""
    execution_config_version: str = ""
    rl_policy_id:           str = ""
    rl_policy_version:      str = ""
    random_seeds:           dict = field(default_factory=dict)
    environment_version:    str = ""
    code_version:           str = ""
    deployment_mode:        str = DeploymentMode.SHADOW.value
    created_at:             str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(UTC).isoformat()

    @property
    def replay_id(self) -> str:
        """Deterministic id of the replayable input set (excludes created_at)."""
        key = self.to_dict()
        key.pop("created_at", None)
        raw = json.dumps(key, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ReplayManifest":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


def state_hash(components: dict) -> str:
    """Deterministic hash of a state/observation dict for replay verification."""
    raw = json.dumps(components, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


@dataclass
class DecisionProvenance:
    """
    Provenance envelope attached to a decision. Ties the decision to a replay
    manifest and the prediction-provenance / deployment-mode governance.
    """
    provenance_id:          str
    decision_id:            str
    prediction_provenance:  str = PredictionProvenance.UNAVAILABLE.value
    deployment_mode:        str = DeploymentMode.SHADOW.value
    replay_manifest:        Optional[dict] = None
    created_at:             str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(UTC).isoformat()

    @property
    def is_valid(self) -> bool:
        """A provenance is valid only if it has a replay manifest with an id and
        a data snapshot (fail-closed: missing provenance blocks execution)."""
        if not self.replay_manifest:
            return False
        rm = self.replay_manifest
        return bool(rm.get("data_snapshot_id")) and bool(rm.get("feature_version"))

    def resolve(self, proposed_action: str) -> tuple[str, str]:
        """
        Apply deployment-mode governance to a proposed action (spec §22).
        Returns (final_action, final_provenance_value).
        """
        prov = PredictionProvenance(self.prediction_provenance)
        mode = normalize_mode(self.deployment_mode)
        action, final_prov = resolve_action(prov, proposed_action, mode)
        return action, final_prov.value

    def to_dict(self) -> dict:
        return asdict(self)
