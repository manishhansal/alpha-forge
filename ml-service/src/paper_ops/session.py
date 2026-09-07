"""
Phase 3R — PaperSession model, immutability, and state machine (spec §2-§3).

An immutable operating identity for one paper-trading session plus an explicit
state machine that includes the terminal `INVALIDATED` state (spec §2, §36) which
the existing `paper3o.PaperSessionState` lacks. This wraps — and stays compatible
with — the existing `paper3o.session_lifecycle` machine (CREATED..RECONCILED/
BLOCKED) and only ADDS the operational-reliability concepts 3R needs:

  * a `SessionConfig` whose SHA-256 hash pins every immutable knob (model /
    calibrator / feature version / portfolio / cost / slippage / thresholds /
    risk limits / data snapshot);
  * `INVALIDATED` as an explicit terminal state reachable from any non-frozen
    state (spec §36) — an invalid session is excluded from aggregates;
  * a fail-closed `config change → terminate + revise` rule (spec §3): a running
    session's immutable config can never change silently.

No arbitrary state mutation: every transition goes through `transition(...)`.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# §2 Session state machine (adds INVALIDATED on top of the paper3o states)
# ══════════════════════════════════════════════════════════════════════════════

class PaperOpsState(str, Enum):
    CREATED      = "CREATED"
    INITIALIZING = "INITIALIZING"
    RUNNING      = "RUNNING"
    PAUSED       = "PAUSED"
    DEGRADED     = "DEGRADED"
    COMPLETED    = "COMPLETED"
    FAILED       = "FAILED"
    RECONCILING  = "RECONCILING"
    RECONCILED   = "RECONCILED"
    INVALIDATED  = "INVALIDATED"   # spec §2/§36 — additive terminal state


PAPER_OPS_TERMINAL_STATES: frozenset[PaperOpsState] = frozenset({
    PaperOpsState.RECONCILED,
    PaperOpsState.FAILED,
    PaperOpsState.INVALIDATED,
})


# Explicit forward transitions (spec §2). INVALIDATED is reachable from ANY
# non-terminal state (a corruption/contamination can be discovered at any point)
# and, uniquely, also from RECONCILED (evidence found bad after the fact, spec §36
# + §41 REPLAY_MISMATCH). Nothing else leaves a terminal state.
VALID_PAPER_OPS_TRANSITIONS: dict[PaperOpsState, set[PaperOpsState]] = {
    PaperOpsState.CREATED: {
        PaperOpsState.INITIALIZING, PaperOpsState.FAILED, PaperOpsState.INVALIDATED,
    },
    PaperOpsState.INITIALIZING: {
        PaperOpsState.RUNNING, PaperOpsState.FAILED, PaperOpsState.INVALIDATED,
    },
    PaperOpsState.RUNNING: {
        PaperOpsState.PAUSED, PaperOpsState.DEGRADED, PaperOpsState.COMPLETED,
        PaperOpsState.FAILED, PaperOpsState.INVALIDATED,
    },
    PaperOpsState.PAUSED: {
        PaperOpsState.RUNNING, PaperOpsState.COMPLETED,
        PaperOpsState.FAILED, PaperOpsState.INVALIDATED,
    },
    PaperOpsState.DEGRADED: {
        PaperOpsState.RUNNING, PaperOpsState.COMPLETED,
        PaperOpsState.FAILED, PaperOpsState.INVALIDATED,
    },
    PaperOpsState.COMPLETED: {
        PaperOpsState.RECONCILING, PaperOpsState.INVALIDATED,
    },
    PaperOpsState.RECONCILING: {
        PaperOpsState.RECONCILED, PaperOpsState.FAILED, PaperOpsState.INVALIDATED,
    },
    # A reconciled session can still be invalidated if later evidence (e.g. a
    # replay mismatch) proves it corrupt (spec §36, §41).
    PaperOpsState.RECONCILED: {
        PaperOpsState.INVALIDATED,
    },
}


class InvalidPaperOpsTransition(Exception):
    """Raised on an illegal PaperSession state transition (fail-closed)."""


def is_valid_paper_ops_transition(a: PaperOpsState, b: PaperOpsState) -> bool:
    if a in (PaperOpsState.FAILED, PaperOpsState.INVALIDATED):
        return False   # hard-terminal
    return b in VALID_PAPER_OPS_TRANSITIONS.get(a, set())


# ══════════════════════════════════════════════════════════════════════════════
# Evidence status of a session (separate from operational status)
# ══════════════════════════════════════════════════════════════════════════════

class EvidenceStatus(str, Enum):
    PENDING             = "PENDING"               # session not yet reconciled
    OFFICIAL            = "OFFICIAL"              # valid + reconciled → aggregatable
    QUARANTINED         = "QUARANTINED"          # reconciled_with_warnings
    INVALID             = "INVALID"              # excluded from aggregates (spec §36)


# ══════════════════════════════════════════════════════════════════════════════
# §2 Immutable session configuration + identity
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class SessionConfig:
    """
    The FROZEN, immutable configuration of a paper session (spec §2, §3). Its
    SHA-256 hash pins every knob that must not change mid-session. Two sessions
    with different configs are different sessions — a config change terminates the
    current session and requires a new one (spec §3).
    """
    market:               str = "NSE"
    strategy_id:          str = ""
    model_id:             str = ""
    champion_artifact_id: str = ""
    calibrator_id:        str = ""
    portfolio_config_id:  str = ""
    execution_config_id:  str = ""
    cost_model_version:   str = ""
    slippage_model_version: str = ""
    data_snapshot_id:     str = ""
    feature_version:      str = ""
    decision_policy_version: str = ""
    # risk limits (immutable per session)
    max_position:         Optional[float] = None
    max_turnover:         Optional[float] = None
    max_drawdown:         Optional[float] = None
    concentration_limit:  Optional[float] = None
    daily_loss_limit:     Optional[float] = None

    def config_hash(self) -> str:
        """Deterministic SHA-256 (first 16 hex) over the full immutable config."""
        raw = json.dumps(asdict(self), sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["config_hash"] = self.config_hash()
        return d


class ConfigMutationError(Exception):
    """Raised if a running session's immutable config is changed (spec §3)."""


@dataclass
class PaperSession:
    """
    An immutable-identity paper session with an explicit lifecycle (spec §2-§3).

    Identity fields (session_id / trading_date / config / config_hash / start /
    created_at) are set once. `status` and `evidence_status` advance only through
    the explicit `transition` / `invalidate` methods. The config object is frozen
    and its hash is checked on every state advance — a silent mutation is refused
    (spec §3).
    """
    session_id:      str
    trading_date:    str
    config:          SessionConfig
    status:          PaperOpsState = PaperOpsState.CREATED
    evidence_status: EvidenceStatus = EvidenceStatus.PENDING
    config_hash:     str = ""
    start_ts:        Optional[str] = None
    end_ts:          Optional[str] = None
    created_at:      str = ""
    mode:            str = "paper"
    invalidation_reason: str = ""

    def __post_init__(self):
        # LIVE forbidden, fail-closed — reuse the decision-layer guard (spec §48/§56).
        from src.decision.provenance import assert_not_live
        assert_not_live(self.mode)
        if not self.created_at:
            self.created_at = _now()
        # pin the config hash at construction; it can never change afterwards
        self.config_hash = self.config.config_hash()

    # ── §3 immutability guard ─────────────────────────────────────────────
    def assert_config_unchanged(self) -> None:
        """Fail-closed: the frozen config's hash must equal the pinned hash."""
        if self.config.config_hash() != self.config_hash:
            raise ConfigMutationError(
                f"session {self.session_id} config changed mid-session "
                "(config change requires a NEW session, spec §3)")

    # ── §2 explicit state machine ─────────────────────────────────────────
    @property
    def is_terminal(self) -> bool:
        return self.status in PAPER_OPS_TERMINAL_STATES

    @property
    def frozen(self) -> bool:
        """Evidence is frozen once RECONCILED or INVALIDATED (spec §38)."""
        return self.status in (PaperOpsState.RECONCILED, PaperOpsState.INVALIDATED)

    def transition(self, to: PaperOpsState, reason: str = "") -> None:
        if to == self.status:
            return
        self.assert_config_unchanged()
        if not is_valid_paper_ops_transition(self.status, to):
            raise InvalidPaperOpsTransition(
                f"illegal session transition {self.status.value} → {to.value} "
                f"(session {self.session_id})")
        prev = self.status
        self.status = to
        if to == PaperOpsState.RUNNING and self.start_ts is None:
            self.start_ts = _now()
        if to in (PaperOpsState.COMPLETED, PaperOpsState.RECONCILED,
                  PaperOpsState.FAILED, PaperOpsState.INVALIDATED):
            if self.end_ts is None:
                self.end_ts = _now()
        if to == PaperOpsState.RECONCILED and self.evidence_status == EvidenceStatus.PENDING:
            self.evidence_status = EvidenceStatus.OFFICIAL
        _ = prev  # (reason/prev are recorded by the caller's event store)

    def invalidate(self, reason: str) -> None:
        """
        Force the session to INVALIDATED (spec §36). Reachable from any state,
        including RECONCILED. An invalidated session is excluded from all
        performance aggregates. Never silently discards — records the reason.
        """
        if self.status == PaperOpsState.INVALIDATED:
            return
        # invalidation bypasses the normal forward-only guard by design, but is
        # still explicit + audited; it can never be reversed.
        self.status = PaperOpsState.INVALIDATED
        self.evidence_status = EvidenceStatus.INVALID
        self.invalidation_reason = reason
        if self.end_ts is None:
            self.end_ts = _now()

    def mark_quarantined(self, reason: str = "reconciled_with_warnings") -> None:
        """Evidence usable-with-caution: kept out of official aggregates."""
        if self.evidence_status not in (EvidenceStatus.INVALID,):
            self.evidence_status = EvidenceStatus.QUARANTINED
            self.invalidation_reason = reason

    @property
    def is_official(self) -> bool:
        """Only OFFICIAL sessions enter performance aggregates (spec §37)."""
        return (self.status == PaperOpsState.RECONCILED
                and self.evidence_status == EvidenceStatus.OFFICIAL)

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "trading_date": self.trading_date,
            "status": self.status.value,
            "evidence_status": self.evidence_status.value,
            "config": self.config.to_dict(),
            "config_hash": self.config_hash,
            "start_ts": self.start_ts,
            "end_ts": self.end_ts,
            "created_at": self.created_at,
            "mode": self.mode,
            "invalidation_reason": self.invalidation_reason,
            "is_official": self.is_official,
        }

    @staticmethod
    def new_id(trading_date: str, config: SessionConfig) -> str:
        """Deterministic session id per (trading_date, config_hash)."""
        raw = f"{trading_date}|{config.config_hash()}"
        return "ps-" + hashlib.sha256(raw.encode()).hexdigest()[:16]

    @classmethod
    def create(cls, trading_date: str, config: SessionConfig,
               mode: str = "paper") -> "PaperSession":
        return cls(session_id=cls.new_id(trading_date, config),
                   trading_date=trading_date, config=config, mode=mode)
