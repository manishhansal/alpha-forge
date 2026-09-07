"""
Phase 3O — Formal PaperSession lifecycle (spec §7, §8, §10, §11, §12).

A `PaperSession` is ONE controlled chronological paper experiment. This module adds:

  §7  full session metadata (identity + all versions/hashes/seed/config hash);
  §8  an explicit state machine (CREATED / INITIALIZING / RUNNING / PAUSED /
      DEGRADED / COMPLETED / FAILED / RECONCILING / RECONCILED / BLOCKED) with
      illegal transitions rejected;
  §10 immutability — a COMPLETED/RECONCILED session's evidence is frozen; a
      correction produces a NEW revision that supersedes it (never mutate in place);
  §11 replay identity — the manifest pins everything needed to reproduce the session;
  §12 chronological processing — a decision timestamped before the session's last
      processed time is rejected (no future data leaking into a prior decision, and
      no out-of-order replay).

Reuses `decision.provenance.assert_not_live` (LIVE forbidden) and
`lifecycle._storage` (atomic write + append-only). Import-clean; stdlib only.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

UTC = timezone.utc


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# §8 Session state machine
# ══════════════════════════════════════════════════════════════════════════════

class PaperSessionState(str, Enum):
    CREATED      = "CREATED"
    INITIALIZING = "INITIALIZING"
    RUNNING      = "RUNNING"
    PAUSED       = "PAUSED"
    DEGRADED     = "DEGRADED"
    COMPLETED    = "COMPLETED"
    FAILED       = "FAILED"
    RECONCILING  = "RECONCILING"
    RECONCILED   = "RECONCILED"
    BLOCKED      = "BLOCKED"


# Terminal: no further transition (evidence-bearing end states + hard stops).
SESSION_TERMINAL_STATES: frozenset[PaperSessionState] = frozenset({
    PaperSessionState.RECONCILED,
    PaperSessionState.FAILED,
    PaperSessionState.BLOCKED,
})

# Allowed forward transitions (spec §8). Anything not listed is rejected.
VALID_SESSION_TRANSITIONS: dict[PaperSessionState, set[PaperSessionState]] = {
    PaperSessionState.CREATED: {
        PaperSessionState.INITIALIZING, PaperSessionState.FAILED, PaperSessionState.BLOCKED,
    },
    PaperSessionState.INITIALIZING: {
        PaperSessionState.RUNNING, PaperSessionState.FAILED, PaperSessionState.BLOCKED,
    },
    PaperSessionState.RUNNING: {
        PaperSessionState.PAUSED, PaperSessionState.DEGRADED, PaperSessionState.COMPLETED,
        PaperSessionState.FAILED, PaperSessionState.BLOCKED,
    },
    PaperSessionState.PAUSED: {
        PaperSessionState.RUNNING, PaperSessionState.FAILED,
        PaperSessionState.BLOCKED, PaperSessionState.COMPLETED,
    },
    PaperSessionState.DEGRADED: {
        # a degraded session may recover, complete, or fail/block — but never
        # silently pretend to be healthy without going back through RUNNING.
        PaperSessionState.RUNNING, PaperSessionState.COMPLETED,
        PaperSessionState.FAILED, PaperSessionState.BLOCKED,
    },
    PaperSessionState.COMPLETED: {
        PaperSessionState.RECONCILING, PaperSessionState.BLOCKED,
    },
    PaperSessionState.RECONCILING: {
        PaperSessionState.RECONCILED, PaperSessionState.FAILED, PaperSessionState.BLOCKED,
    },
}


class InvalidSessionTransition(Exception):
    """Raised when an illegal PaperSession state transition is attempted."""


class ChronologyViolation(Exception):
    """Raised when a decision would be processed out of chronological order (§12)."""


def is_valid_session_transition(a: PaperSessionState, b: PaperSessionState) -> bool:
    if a in SESSION_TERMINAL_STATES:
        return False
    return b in VALID_SESSION_TRANSITIONS.get(a, set())


# ══════════════════════════════════════════════════════════════════════════════
# §7 Session manifest (full identity for replay)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Phase3OSessionManifest:
    """
    Full paper-session identity (spec §7). Everything needed to replay a session
    and to pin its evidence immutably. Missing identities are empty strings /
    empty lists — never fabricated.
    """
    paper_session_id:   str
    market_date:        str
    session_start:      str = ""
    session_end:        str = ""
    mode:               str = "paper"
    # code / config identity
    git_commit:         str = ""
    code_version:       str = ""
    configuration_hash: str = ""
    random_seed:        Optional[int] = None
    environment_version: str = ""
    # data identity
    dataset_version:    str = ""
    data_snapshot_ids:  list[str] = field(default_factory=list)
    data_tag:           str = "SYNTHETIC_DATA"
    # feature identity
    feature_version:    str = ""
    feature_schema_hash: str = ""
    # model / calibration identity
    model_versions:     list[str] = field(default_factory=list)
    model_hashes:       list[str] = field(default_factory=list)
    calibration_versions: list[str] = field(default_factory=list)
    # downstream config identity
    portfolio_version:  str = ""
    execution_version:  str = ""
    rl_policy_version:  str = ""
    # revision lineage (§10)
    revision:           int = 0
    supersedes:         Optional[str] = None   # prior session_id this revises
    created_at:         str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now_iso()

    @property
    def replay_id(self) -> str:
        """Deterministic id over the replay-relevant identity (excludes timestamps
        and revision bookkeeping). Uses asdict directly to avoid recursion via
        to_dict (which embeds replay_id)."""
        key = asdict(self)
        for volatile in ("created_at", "session_start", "session_end",
                         "revision", "supersedes", "paper_session_id"):
            key.pop(volatile, None)
        raw = json.dumps(key, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    @property
    def replay_complete(self) -> bool:
        """All identities required to reproduce the session are present (§11)."""
        return bool(self.data_snapshot_ids) and bool(self.model_versions) \
            and bool(self.feature_version) and bool(self.code_version)

    def replay_gaps(self) -> list[str]:
        gaps = []
        if not self.data_snapshot_ids: gaps.append("data_snapshot_ids")
        if not self.model_versions:    gaps.append("model_versions")
        if not self.feature_version:   gaps.append("feature_version")
        if not self.code_version:      gaps.append("code_version")
        return gaps

    def to_dict(self) -> dict:
        d = asdict(self)
        d["replay_id"] = self.replay_id
        d["replay_complete"] = self.replay_complete
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Phase3OSessionManifest":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


# ══════════════════════════════════════════════════════════════════════════════
# Session lifecycle controller
# ══════════════════════════════════════════════════════════════════════════════

class PaperSessionLifecycle:
    """
    Drives a paper session through the §8 state machine, enforces chronological
    processing (§12), and persists an immutable, revisionable manifest (§10).

    Persistence layout under `root`:
        session_lifecycle_<session_id>.json   the frozen manifest + state
        session_events.jsonl                  append-only state-transition log
    """

    def __init__(self, root: str | Path, manifest: Phase3OSessionManifest,
                 mode: str = "paper"):
        from src.decision.provenance import assert_not_live
        assert_not_live(mode)                          # LIVE forbidden, fail-closed
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest = manifest
        self.mode = mode
        self.state = PaperSessionState.CREATED
        self._last_processed_ts: Optional[str] = None
        self._frozen = False
        self._append_event("CREATED", "session created")

    # ── state machine ─────────────────────────────────────────────────────
    def transition(self, to: PaperSessionState, reason: str = "") -> None:
        if to == self.state:
            return
        if not is_valid_session_transition(self.state, to):
            raise InvalidSessionTransition(
                f"illegal session transition {self.state.value} → {to.value} "
                f"(session {self.manifest.paper_session_id})")
        prev = self.state
        self.state = to
        if to in (PaperSessionState.COMPLETED, PaperSessionState.RECONCILED):
            self._frozen = True
            if not self.manifest.session_end:
                self.manifest.session_end = _now_iso()
        self._append_event(to.value, reason or f"{prev.value}→{to.value}")

    def initialize(self) -> None:
        if not self.manifest.session_start:
            self.manifest.session_start = _now_iso()
        self.transition(PaperSessionState.INITIALIZING)

    def start(self) -> None:
        self.transition(PaperSessionState.RUNNING)

    def pause(self, reason: str = "paused") -> None:
        self.transition(PaperSessionState.PAUSED, reason)

    def resume(self) -> None:
        self.transition(PaperSessionState.RUNNING, "resumed")

    def degrade(self, reason: str) -> None:
        self.transition(PaperSessionState.DEGRADED, reason)

    def complete(self) -> None:
        self.transition(PaperSessionState.COMPLETED)

    def fail(self, reason: str) -> None:
        self.transition(PaperSessionState.FAILED, reason)

    def block(self, reason: str) -> None:
        self.transition(PaperSessionState.BLOCKED, reason)

    def begin_reconciliation(self) -> None:
        self.transition(PaperSessionState.RECONCILING)

    def mark_reconciled(self) -> None:
        self.transition(PaperSessionState.RECONCILED)

    # ── §12 chronological guard ───────────────────────────────────────────
    def record_processing(self, decision_timestamp: str) -> None:
        """
        Advance the session's processed-time watermark. Rejects a decision whose
        timestamp is BEFORE the last processed timestamp — no out-of-order / future
        data may leak into a prior decision (§12). Equal timestamps are allowed
        (same-bar batch).
        """
        if self.state not in (PaperSessionState.RUNNING, PaperSessionState.DEGRADED):
            raise InvalidSessionTransition(
                f"cannot process decisions while session is {self.state.value}")
        if self._last_processed_ts is not None and decision_timestamp < self._last_processed_ts:
            raise ChronologyViolation(
                f"decision ts {decision_timestamp} < last processed "
                f"{self._last_processed_ts} — out-of-order processing forbidden")
        self._last_processed_ts = decision_timestamp

    @property
    def last_processed_ts(self) -> Optional[str]:
        return self._last_processed_ts

    @property
    def frozen(self) -> bool:
        return self._frozen

    # ── §10 immutability + revisions ──────────────────────────────────────
    def revise(self, new_session_id: str, reason: str) -> "PaperSessionLifecycle":
        """
        Create a NEW revision that supersedes this (frozen) session. The original
        evidence is never mutated. The new manifest carries revision+1 and a
        `supersedes` pointer to this session.
        """
        if not self._frozen:
            raise InvalidSessionTransition(
                "can only revise a COMPLETED/RECONCILED (frozen) session")
        new_manifest = Phase3OSessionManifest.from_dict(self.manifest.to_dict())
        new_manifest.paper_session_id = new_session_id
        new_manifest.revision = self.manifest.revision + 1
        new_manifest.supersedes = self.manifest.paper_session_id
        new_manifest.session_start = ""
        new_manifest.session_end = ""
        new_manifest.created_at = _now_iso()
        rev = PaperSessionLifecycle(self.root, new_manifest, self.mode)
        rev._append_event("REVISION", f"supersedes {self.manifest.paper_session_id}: {reason}")
        return rev

    # ── persistence (immutable freeze) ────────────────────────────────────
    def persist(self) -> str:
        from src.lifecycle._storage import atomic_write_json
        path = self.root / f"session_lifecycle_{self.manifest.paper_session_id}.json"
        atomic_write_json(path, {
            "manifest": self.manifest.to_dict(),
            "state": self.state.value,
            "frozen": self._frozen,
            "last_processed_ts": self._last_processed_ts,
        })
        return str(path)

    def _append_event(self, state: str, detail: str) -> None:
        from src.lifecycle._storage import append_jsonl
        append_jsonl(self.root / "session_events.jsonl", {
            "paper_session_id": self.manifest.paper_session_id,
            "state": state, "detail": detail, "timestamp": _now_iso()})

    @staticmethod
    def load(root: str | Path, session_id: str) -> Optional[dict]:
        from src.lifecycle._storage import read_json
        return read_json(Path(root) / f"session_lifecycle_{session_id}.json")
