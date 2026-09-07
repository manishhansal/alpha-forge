"""
Phase 3M — Immutable shadow ledger (spec §12).

An append-only event ledger for shadow orders/fills. There are NO mutable
historical results — corrections create NEW events rather than overwriting
history. Backed by the reused stdlib `lifecycle._storage.append_jsonl`
(atomic per-line append + fsync) + a FileLock for cross-process safety.

Idempotency (spec §30): recording an order/fill whose id already exists is a
no-op; the same decision cannot be shadow-executed twice.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

from src.lifecycle._storage import append_jsonl, read_jsonl, FileLock

from .shadow_order import ShadowOrder
from .shadow_fill import ShadowFill

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


class ShadowLedgerEvent(str, Enum):
    ORDER_CREATED     = "ORDER_CREATED"
    FILL_CREATED      = "FILL_CREATED"
    ORDER_COMPLETED   = "ORDER_COMPLETED"
    ORDER_CANCELLED   = "ORDER_CANCELLED"
    CORRECTION        = "CORRECTION"


@dataclass
class ShadowLedger:
    """
    Immutable append-only shadow ledger (spec §12). One JSONL event stream; an
    in-memory index of seen order/fill ids gives idempotency + exactly-once.
    """
    root: Path

    def __post_init__(self):
        self.root = Path(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "shadow_ledger.jsonl"
        self.lock_path = self.root / ".shadow_ledger.lock"

    # ── internal ──────────────────────────────────────────────────────────

    def _events(self) -> list[dict]:
        return read_jsonl(self.path)

    def _has(self, event_type: str, key: str, value: str) -> bool:
        for e in self._events():
            if e.get("event_type") == event_type and e.get(key) == value:
                return True
        return False

    def _append(self, event_type: str, payload: dict, **ids) -> dict:
        rec = {"event_type": event_type, "timestamp": _now(), **ids, "payload": payload}
        append_jsonl(self.path, rec)
        return rec

    # ── order lifecycle (idempotent, append-only) ────────────────────────

    def record_order(self, order: ShadowOrder) -> tuple[bool, dict]:
        """
        Record a new shadow order. Idempotent: if the order_id (or its
        decision_id) already produced an ORDER_CREATED event, this is a no-op
        (returns (False, existing)) — no duplicate shadow execution (spec §30).
        """
        with FileLock(self.lock_path):
            # exactly-once per decision: one order per decision_id
            for e in self._events():
                if e.get("event_type") == ShadowLedgerEvent.ORDER_CREATED.value \
                        and e.get("decision_id") == order.decision_id:
                    return False, e
            rec = self._append(ShadowLedgerEvent.ORDER_CREATED.value, order.to_dict(),
                               order_id=order.order_id, decision_id=order.decision_id)
            return True, rec

    def record_fill(self, fill: ShadowFill) -> tuple[bool, dict]:
        """Record a fill (idempotent per fill_id)."""
        with FileLock(self.lock_path):
            if self._has(ShadowLedgerEvent.FILL_CREATED.value, "fill_id", fill.fill_id):
                for e in self._events():
                    if e.get("event_type") == ShadowLedgerEvent.FILL_CREATED.value \
                            and e.get("fill_id") == fill.fill_id:
                        return False, e
            rec = self._append(ShadowLedgerEvent.FILL_CREATED.value, fill.to_dict(),
                               fill_id=fill.fill_id, order_id=fill.order_id,
                               decision_id=fill.decision_id)
            return True, rec

    def complete_order(self, order_id: str, decision_id: str, payload: Optional[dict] = None) -> dict:
        with FileLock(self.lock_path):
            return self._append(ShadowLedgerEvent.ORDER_COMPLETED.value, payload or {},
                               order_id=order_id, decision_id=decision_id)

    def record_correction(self, decision_id: str, reason: str, payload: dict) -> dict:
        """Corrections NEVER overwrite; they append a new CORRECTION event."""
        with FileLock(self.lock_path):
            return self._append(ShadowLedgerEvent.CORRECTION.value,
                               {"reason": reason, **payload}, decision_id=decision_id)

    # ── queries ───────────────────────────────────────────────────────────

    def all_events(self) -> list[dict]:
        return self._events()

    def for_decision(self, decision_id: str) -> list[dict]:
        return [e for e in self._events() if e.get("decision_id") == decision_id]

    def orders(self) -> list[dict]:
        return [e for e in self._events()
                if e.get("event_type") == ShadowLedgerEvent.ORDER_CREATED.value]

    def fills(self) -> list[dict]:
        return [e for e in self._events()
                if e.get("event_type") == ShadowLedgerEvent.FILL_CREATED.value]

    def has_order_for_decision(self, decision_id: str) -> bool:
        return any(e.get("event_type") == ShadowLedgerEvent.ORDER_CREATED.value
                   and e.get("decision_id") == decision_id for e in self._events())
