"""
Phase 3N — Paper session manifest, EOD reconciliation, replay & recovery
(spec §49–§53).

A `PaperSession` is the reproducible unit of paper-trading evidence. It:
  §49  carries a full manifest (id, market date, times, data snapshot ids,
       provider usage, model/feature/calibration versions, counts, positions,
       costs, P&L, health + kill-switch events, reconciliation + evidence status);
  §50  produces a deterministic end-of-day reconciliation (no manual editing);
  §51  is replayable from its manifest (all required version identities pinned);
  §52  recovers safely on restart (never duplicates exposure — reuses the
       idempotent ShadowLedger);
  §53  honours a kill switch → NO_NEW_PAPER_EXPOSURE (existing positions may still
       be reconciled/closed, but no new paper order may be created).

Reuse: `lifecycle._storage` (atomic JSON + append-only JSONL), `shadow.ShadowLedger`
(idempotent order/fill store), `paper.PaperTradingEngine`. No broker. Import-clean.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

UTC = timezone.utc


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# Kill switch (spec §53)
# ══════════════════════════════════════════════════════════════════════════════

class KillSwitchReason(str, Enum):
    DATA_UNSAFE            = "DATA_UNSAFE"
    MODEL_REVOKED          = "MODEL_REVOKED"
    CALIBRATION_STALE      = "CALIBRATION_STALE"
    FEATURE_DRIFT_SEVERE   = "FEATURE_DRIFT_SEVERE"
    EXECUTION_UNAVAILABLE  = "EXECUTION_UNAVAILABLE"
    RISK_BREACH            = "RISK_BREACH"
    RL_OOD                 = "RL_OOD"
    PROVENANCE_FAILURE     = "PROVENANCE_FAILURE"
    PROVIDER_CORRUPTION    = "PROVIDER_CORRUPTION"
    SYSTEM_HEALTH_DEGRADED = "SYSTEM_HEALTH_DEGRADED"


class EvidenceStatus(str, Enum):
    """Official-evidence classification for the whole session (spec §45)."""
    OFFICIAL_EVIDENCE = "OFFICIAL_EVIDENCE"
    DIAGNOSTIC        = "DIAGNOSTIC"
    DEGRADED          = "DEGRADED"
    UNTRUSTED         = "UNTRUSTED"


class ReconciliationStatus(str, Enum):
    RECONCILED   = "RECONCILED"
    PARTIAL      = "PARTIAL"
    UNRECONCILED = "UNRECONCILED"
    NOT_RUN      = "NOT_RUN"


# ══════════════════════════════════════════════════════════════════════════════
# Session manifest (spec §49)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PaperSessionManifest:
    """Reproducible session manifest (spec §49). Everything needed to replay."""
    paper_session_id:   str
    market_date:        str                     # ISO date of the session
    start_time:         str = ""
    end_time:           str = ""
    mode:               str = "paper"
    data_snapshot_ids:  list[str] = field(default_factory=list)
    provider_usage:     dict = field(default_factory=dict)   # provider -> count/role
    model_versions:     list[str] = field(default_factory=list)
    feature_version:    str = ""
    calibration_version: str = ""
    # counts
    signals_generated:  int = 0
    decisions:          int = 0
    orders:             int = 0
    fills:              int = 0
    # book / economics
    positions:          dict = field(default_factory=dict)
    total_cost:         float = 0.0
    gross_pnl:          Optional[float] = None
    net_pnl:            Optional[float] = None
    # governance
    health_events:      list[dict] = field(default_factory=list)
    kill_switch_events: list[dict] = field(default_factory=list)
    reconciliation_status: str = ReconciliationStatus.NOT_RUN.value
    evidence_status:    str = EvidenceStatus.DIAGNOSTIC.value
    data_tag:           str = "SYNTHETIC_DATA"  # REAL_MARKET_DATA/REPLAY_DATA/...
    code_version:       str = ""
    environment_version: str = ""
    created_at:         str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now_iso()

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "PaperSessionManifest":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


# ══════════════════════════════════════════════════════════════════════════════
# EOD reconciliation (spec §50)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class EODReconciliation:
    """Deterministic end-of-day reconciliation (spec §50). No manual editing."""
    paper_session_id:   str
    signal_count:       int
    decision_count:     int
    blocked_count:      int
    abstention_count:   int
    order_count:        int
    filled_count:       int
    rejected_count:     int
    cancelled_count:    int
    gross_pnl:          Optional[float]
    net_pnl:            Optional[float]
    total_cost:         float
    total_slippage:     Optional[float]
    turnover:           float
    prediction_accuracy: Optional[float]
    calibration_error:  Optional[float]
    ev_realization:     Optional[float]
    provider_failures:  int
    data_gaps:          int
    model_failures:     int
    risk_blocks:        int
    reconciliation_status: str
    generated_at:       str = ""

    def __post_init__(self):
        if not self.generated_at:
            self.generated_at = _now_iso()

    def to_dict(self) -> dict:
        return asdict(self)


# ══════════════════════════════════════════════════════════════════════════════
# Paper session controller
# ══════════════════════════════════════════════════════════════════════════════

class PaperSession:
    """
    Session controller (spec §49–§53). Owns the manifest, gates new exposure on
    the kill switch, drives the paper engine, and produces the EOD reconciliation.
    Persists manifest + reconciliation via the reused append-only `_storage`.
    """

    def __init__(self, root: str | Path, paper_session_id: str, market_date: str,
                 engine=None, mode: str = "paper"):
        from src.decision.provenance import assert_not_live
        assert_not_live(mode)
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.mode = mode
        self.manifest = PaperSessionManifest(
            paper_session_id=paper_session_id, market_date=market_date,
            mode=mode, start_time=_now_iso())
        self._engine = engine     # PaperTradingEngine (may be injected/lazy)
        self._kill_switch_active = False
        # counters for reconciliation
        self._blocked = 0
        self._abstained = 0
        self._rejected = 0
        self._cancelled = 0
        self._provider_failures = 0
        self._data_gaps = 0
        self._model_failures = 0
        self._risk_blocks = 0

    # ── kill switch (spec §53) ────────────────────────────────────────────
    def trigger_kill_switch(self, reason: KillSwitchReason, detail: str = "") -> None:
        """Activate the kill switch → NO_NEW_PAPER_EXPOSURE. Existing positions
        may still be reconciled/closed; no new order may be created."""
        self._kill_switch_active = True
        self.manifest.kill_switch_events.append(
            {"reason": reason.value, "detail": detail, "timestamp": _now_iso(),
             "effect": "NO_NEW_PAPER_EXPOSURE"})

    @property
    def kill_switch_active(self) -> bool:
        return self._kill_switch_active

    def record_health_event(self, dimension: str, state: str, detail: str = "") -> None:
        self.manifest.health_events.append(
            {"dimension": dimension, "state": state, "detail": detail, "timestamp": _now_iso()})

    # ── new exposure (gated) ──────────────────────────────────────────────
    def submit_decision(self, decision, fills: Optional[list] = None):
        """
        Route a decision to the paper engine, but block NEW exposure when the kill
        switch is active (spec §53). Returns the engine's PaperFillResult, or a
        blocked result if the kill switch is active.
        """
        from .paper_engine import PaperFillResult
        self.manifest.decisions += 1

        if self._kill_switch_active:
            self._blocked += 1
            return PaperFillResult(accepted=False, order=None,
                                   reason="KILL_SWITCH_ACTIVE: NO_NEW_PAPER_EXPOSURE")
        if self._engine is None:
            raise RuntimeError("PaperSession has no engine attached")

        res = self._engine.submit_decision(decision, fills=fills)
        if res.accepted:
            self.manifest.orders += 1
            if res.order and res.order.get("filled_quantity", 0) > 0:
                self.manifest.fills += 1
        elif not res.duplicate:
            self._rejected += 1
        return res

    def record_signal(self) -> None:
        self.manifest.signals_generated += 1

    def record_abstention(self) -> None:
        self._abstained += 1

    def record_failure(self, kind: str) -> None:
        if kind == "provider":
            self._provider_failures += 1
        elif kind == "data_gap":
            self._data_gaps += 1
        elif kind == "model":
            self._model_failures += 1
        elif kind == "risk":
            self._risk_blocks += 1

    # ── close + reconcile (spec §50) ──────────────────────────────────────
    def close(self, reconciliation_engine=None,
              prediction_accuracy: Optional[float] = None,
              calibration_error: Optional[float] = None,
              ev_realization: Optional[float] = None) -> EODReconciliation:
        """
        Finalize the session: compute the deterministic EOD reconciliation from the
        ledger, freeze the manifest, and persist both. No manual editing.
        """
        self.manifest.end_time = _now_iso()
        ledger = self._engine.ledger if self._engine is not None else None
        orders = ledger.orders() if ledger else []
        fills = ledger.fills() if ledger else []

        # derive economics from fills (never fabricated)
        pnls = [f["payload"].get("realized_pnl") for f in fills
                if isinstance(f.get("payload"), dict) and f["payload"].get("realized_pnl") is not None]
        costs = [f["payload"].get("total_cost") for f in fills
                 if isinstance(f.get("payload"), dict) and f["payload"].get("total_cost") is not None]
        slips = [f["payload"].get("slippage") for f in fills
                 if isinstance(f.get("payload"), dict) and f["payload"].get("slippage") is not None]
        net_pnl = sum(pnls) if pnls else None
        total_cost = sum(costs) if costs else 0.0
        total_slip = sum(slips) if slips else None
        gross_pnl = (net_pnl + total_cost) if net_pnl is not None else None
        turnover = sum(abs(o["payload"].get("quantity", 0)) for o in orders
                       if isinstance(o.get("payload"), dict))

        filled = len([f for f in fills])
        book = self._engine.book.to_dict() if self._engine is not None else {}

        recon_status = (ReconciliationStatus.RECONCILED.value if fills
                        else ReconciliationStatus.NOT_RUN.value)

        # update manifest
        self.manifest.orders = len(orders)
        self.manifest.fills = len(fills)
        self.manifest.positions = book.get("positions", {})
        self.manifest.total_cost = total_cost
        self.manifest.gross_pnl = gross_pnl
        self.manifest.net_pnl = net_pnl
        self.manifest.reconciliation_status = recon_status

        eod = EODReconciliation(
            paper_session_id=self.manifest.paper_session_id,
            signal_count=self.manifest.signals_generated,
            decision_count=self.manifest.decisions,
            blocked_count=self._blocked, abstention_count=self._abstained,
            order_count=len(orders), filled_count=filled,
            rejected_count=self._rejected, cancelled_count=self._cancelled,
            gross_pnl=gross_pnl, net_pnl=net_pnl, total_cost=total_cost,
            total_slippage=total_slip, turnover=turnover,
            prediction_accuracy=prediction_accuracy, calibration_error=calibration_error,
            ev_realization=ev_realization,
            provider_failures=self._provider_failures, data_gaps=self._data_gaps,
            model_failures=self._model_failures, risk_blocks=self._risk_blocks,
            reconciliation_status=recon_status)

        self._persist(eod)
        return eod

    def _persist(self, eod: EODReconciliation) -> None:
        from src.lifecycle._storage import atomic_write_json, append_jsonl
        sid = self.manifest.paper_session_id
        atomic_write_json(self.root / f"session_{sid}.json", self.manifest.to_dict())
        atomic_write_json(self.root / f"reconciliation_{sid}.json", eod.to_dict())
        append_jsonl(self.root / "paper_sessions.jsonl",
                     {"paper_session_id": sid, "market_date": self.manifest.market_date,
                      "evidence_status": self.manifest.evidence_status,
                      "reconciliation_status": self.manifest.reconciliation_status,
                      "closed_at": self.manifest.end_time})

    # ── replay (spec §51) ─────────────────────────────────────────────────
    @staticmethod
    def load_manifest(root: str | Path, paper_session_id: str) -> Optional[PaperSessionManifest]:
        """Load a persisted manifest for replay (spec §51)."""
        from src.lifecycle._storage import read_json
        d = read_json(Path(root) / f"session_{paper_session_id}.json")
        return PaperSessionManifest.from_dict(d) if d else None

    @staticmethod
    def replay_requirements(manifest: PaperSessionManifest) -> dict:
        """
        Identify everything required to reproduce the session (spec §51):
        data snapshots, model/feature/calibration versions, config, mode.
        Missing identities are reported as gaps (fail-closed for replay).
        """
        gaps = []
        if not manifest.data_snapshot_ids:
            gaps.append("data_snapshot_ids")
        if not manifest.model_versions:
            gaps.append("model_versions")
        if not manifest.feature_version:
            gaps.append("feature_version")
        return {
            "paper_session_id": manifest.paper_session_id,
            "market_date": manifest.market_date,
            "data_snapshot_ids": list(manifest.data_snapshot_ids),
            "model_versions": list(manifest.model_versions),
            "feature_version": manifest.feature_version,
            "calibration_version": manifest.calibration_version,
            "code_version": manifest.code_version,
            "environment_version": manifest.environment_version,
            "mode": manifest.mode,
            "data_tag": manifest.data_tag,
            "replayable": len(gaps) == 0,
            "missing": gaps,
        }
