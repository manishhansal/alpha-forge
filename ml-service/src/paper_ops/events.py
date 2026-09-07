"""
Phase 3R — Event-sourced paper trading (spec §5-§7).

All paper-trading state transitions are reconstructable from an append-only,
hash-chained event stream. Each event carries a monotonically increasing sequence
number, the session config hash, and the hash of the previous event — so a
reordered, dropped, duplicated, or tampered event is detectable. The store is
idempotent: an event with an already-seen `event_id` (or an already-seen
order/fill/signal business key) is a no-op, so a duplicate never mutates the
ledger twice and a restart replays without duplicating state.

Reuses `lifecycle._storage` (atomic append-only JSONL + cross-process FileLock).
This is the canonical operational event taxonomy; downstream ledgers
(shadow_ledger, journals) remain the source of truth for their own domains — this
store is the ordered, tamper-evident spine that ties a session together.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

from src.lifecycle._storage import append_jsonl, read_jsonl, FileLock

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# §5 Canonical operational event taxonomy
# ══════════════════════════════════════════════════════════════════════════════

class OpEvent(str, Enum):
    SESSION_CREATED             = "SESSION_CREATED"
    SESSION_STARTED             = "SESSION_STARTED"
    DATA_SNAPSHOT_ACCEPTED      = "DATA_SNAPSHOT_ACCEPTED"
    DATA_WARNING                = "DATA_WARNING"
    DATA_REJECTED               = "DATA_REJECTED"
    SIGNAL_CREATED              = "SIGNAL_CREATED"
    SIGNAL_SUPPRESSED           = "SIGNAL_SUPPRESSED"
    DECISION_CREATED            = "DECISION_CREATED"
    DECISION_REJECTED           = "DECISION_REJECTED"
    ORDER_CREATED               = "ORDER_CREATED"
    ORDER_REJECTED              = "ORDER_REJECTED"
    ORDER_SUBMITTED_PAPER       = "ORDER_SUBMITTED_PAPER"
    ORDER_FILLED_PAPER          = "ORDER_FILLED_PAPER"
    ORDER_PARTIALLY_FILLED_PAPER = "ORDER_PARTIALLY_FILLED_PAPER"
    ORDER_CANCELLED_PAPER       = "ORDER_CANCELLED_PAPER"
    POSITION_OPENED             = "POSITION_OPENED"
    POSITION_INCREASED          = "POSITION_INCREASED"
    POSITION_REDUCED            = "POSITION_REDUCED"
    POSITION_CLOSED             = "POSITION_CLOSED"
    RISK_BLOCK                  = "RISK_BLOCK"
    SESSION_PAUSED              = "SESSION_PAUSED"
    SESSION_DEGRADED            = "SESSION_DEGRADED"
    SESSION_RESUMED             = "SESSION_RESUMED"
    SESSION_COMPLETED           = "SESSION_COMPLETED"
    RECONCILIATION_STARTED      = "RECONCILIATION_STARTED"
    RECONCILIATION_COMPLETED    = "RECONCILIATION_COMPLETED"
    SESSION_INVALIDATED         = "SESSION_INVALIDATED"


# Business-key field per event type that must be unique (idempotency dedup key).
# e.g. two ORDER_CREATED with the same order_id collapse to one.
_DEDUP_KEY_FIELD: dict[OpEvent, str] = {
    OpEvent.ORDER_CREATED:                "order_id",
    OpEvent.ORDER_SUBMITTED_PAPER:        "order_id",
    OpEvent.ORDER_FILLED_PAPER:           "fill_id",
    OpEvent.ORDER_PARTIALLY_FILLED_PAPER: "fill_id",
    OpEvent.ORDER_CANCELLED_PAPER:        "order_id",
    OpEvent.SIGNAL_CREATED:               "signal_id",
    OpEvent.DECISION_CREATED:             "decision_id",
}


@dataclass
class OpEventRecord:
    """One ordered, hash-chained operational event (spec §5)."""
    event_id:        str
    session_id:      str
    sequence:        int
    event_type:      str            # OpEvent value
    event_ts:        str            # when recorded (UTC ISO)
    market_ts:       Optional[str] = None   # market timestamp the event refers to
    instrument:      Optional[str] = None
    payload:         dict = field(default_factory=dict)
    provenance:      str = ""
    config_hash:     str = ""
    prev_event_hash: Optional[str] = None

    def content_hash(self) -> str:
        """
        Deterministic hash over the event's ordered content INCLUDING the previous
        hash — this is what chains the log (tamper-evident, spec §6).
        """
        key = {
            "event_id": self.event_id, "session_id": self.session_id,
            "sequence": self.sequence, "event_type": self.event_type,
            "event_ts": self.event_ts, "market_ts": self.market_ts,
            "instrument": self.instrument, "payload": self.payload,
            "provenance": self.provenance, "config_hash": self.config_hash,
            "prev_event_hash": self.prev_event_hash,
        }
        raw = json.dumps(key, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["content_hash"] = self.content_hash()
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "OpEventRecord":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


# ══════════════════════════════════════════════════════════════════════════════
# §6/§7 Append-only, hash-chained, idempotent event store
# ══════════════════════════════════════════════════════════════════════════════

class DuplicateEvent(Exception):
    """Non-fatal marker: caller may inspect; append() returns (False, existing)."""


@dataclass
class OrderingAnomaly:
    kind:     str    # DUPLICATE_SEQUENCE / MISSING_SEQUENCE / OUT_OF_ORDER / HASH_CHAIN_BREAK
    sequence: int
    detail:   str

    def to_dict(self) -> dict:
        return {"kind": self.kind, "sequence": self.sequence, "detail": self.detail}


class EventStore:
    """
    Per-session append-only event log with deterministic ordering + idempotency
    (spec §5-§7). One JSONL stream per session; a cross-process FileLock serialises
    appends. An in-memory index (rebuilt from disk on construction — restart-safe)
    tracks seen event_ids and business dedup keys.
    """

    def __init__(self, root: str | Path, session_id: str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.session_id = session_id
        self.path = self.root / f"op_events_{session_id}.jsonl"
        self.lock_path = self.root / f".op_events_{session_id}.lock"
        # rebuilt from disk → restart replays without duplicating state (§7, §18)
        self._seen_event_ids: set[str] = set()
        self._seen_dedup: set[str] = set()
        self._max_seq: int = -1
        self._last_hash: Optional[str] = None
        self._load()

    def _load(self) -> None:
        for raw in read_jsonl(self.path):
            self._index(raw)

    def _index(self, raw: dict) -> None:
        eid = raw.get("event_id")
        if eid:
            self._seen_event_ids.add(eid)
        dk = self._dedup_key(raw)
        if dk:
            self._seen_dedup.add(dk)
        seq = raw.get("sequence", -1)
        if isinstance(seq, int) and seq > self._max_seq:
            self._max_seq = seq
        self._last_hash = raw.get("content_hash")

    @staticmethod
    def _dedup_key(raw: dict) -> Optional[str]:
        try:
            et = OpEvent(raw.get("event_type"))
        except ValueError:
            return None
        field_name = _DEDUP_KEY_FIELD.get(et)
        if not field_name:
            return None
        val = (raw.get("payload") or {}).get(field_name)
        return f"{et.value}|{field_name}|{val}" if val is not None else None

    # ── append (idempotent + chained) ────────────────────────────────────
    def append(
        self,
        event_type: OpEvent | str,
        *,
        payload: Optional[dict] = None,
        market_ts: Optional[str] = None,
        instrument: Optional[str] = None,
        provenance: str = "",
        config_hash: str = "",
        event_id: Optional[str] = None,
    ) -> tuple[bool, OpEventRecord]:
        """
        Append one event. Returns (created, record). Idempotent: if the event_id or
        the business dedup key was already recorded, this is a no-op that returns
        (False, existing-reconstructed-record) — no double mutation (spec §7).
        """
        et = OpEvent(event_type)
        payload = dict(payload or {})

        with FileLock(self.lock_path):
            # explicit event_id dedup
            if event_id and event_id in self._seen_event_ids:
                return False, self._find(event_id)
            # business-key dedup (e.g. same order_id / fill_id)
            probe = {"event_type": et.value, "payload": payload}
            dk = self._dedup_key(probe)
            if dk and dk in self._seen_dedup:
                return False, self._find_by_dedup(dk)

            seq = self._max_seq + 1
            eid = event_id or self._new_event_id(et, seq, payload)
            rec = OpEventRecord(
                event_id=eid, session_id=self.session_id, sequence=seq,
                event_type=et.value, event_ts=_now(), market_ts=market_ts,
                instrument=instrument, payload=payload, provenance=provenance,
                config_hash=config_hash, prev_event_hash=self._last_hash,
            )
            append_jsonl(self.path, rec.to_dict())
            self._index(rec.to_dict())
            return True, rec

    def _new_event_id(self, et: OpEvent, seq: int, payload: dict) -> str:
        raw = f"{self.session_id}|{et.value}|{seq}|{json.dumps(payload, sort_keys=True, default=str)}"
        return "ev-" + hashlib.sha256(raw.encode()).hexdigest()[:16]

    def _find(self, event_id: str) -> OpEventRecord:
        for raw in read_jsonl(self.path):
            if raw.get("event_id") == event_id:
                return OpEventRecord.from_dict(raw)
        raise KeyError(event_id)

    def _find_by_dedup(self, dk: str) -> OpEventRecord:
        for raw in read_jsonl(self.path):
            if self._dedup_key(raw) == dk:
                return OpEventRecord.from_dict(raw)
        raise KeyError(dk)

    # ── queries ───────────────────────────────────────────────────────────
    def all(self) -> list[OpEventRecord]:
        return [OpEventRecord.from_dict(r) for r in read_jsonl(self.path)]

    def count(self, event_type: Optional[OpEvent | str] = None) -> int:
        rows = read_jsonl(self.path)
        if event_type is None:
            return len(rows)
        et = OpEvent(event_type).value
        return sum(1 for r in rows if r.get("event_type") == et)

    @property
    def next_sequence(self) -> int:
        return self._max_seq + 1

    @property
    def head_hash(self) -> Optional[str]:
        return self._last_hash


# ══════════════════════════════════════════════════════════════════════════════
# §6 Ordering + integrity verification
# ══════════════════════════════════════════════════════════════════════════════

def detect_ordering_anomalies(events: list[dict]) -> list[OrderingAnomaly]:
    """
    Scan a raw event list (as read from the store) for ordering / integrity
    problems (spec §6): duplicate sequence, missing sequence (gap), out-of-order
    sequence, and a broken hash chain (prev_event_hash mismatch or content_hash
    tamper). Returns the anomalies found — never repairs them.
    """
    anomalies: list[OrderingAnomaly] = []
    seen_seq: set[int] = set()
    prev_seq: Optional[int] = None
    prev_hash: Optional[str] = None

    for raw in events:
        seq = raw.get("sequence")
        if not isinstance(seq, int):
            anomalies.append(OrderingAnomaly("OUT_OF_ORDER", -1, "non-integer sequence"))
            continue

        if seq in seen_seq:
            anomalies.append(OrderingAnomaly("DUPLICATE_SEQUENCE", seq,
                                             f"sequence {seq} seen more than once"))
        seen_seq.add(seq)

        if prev_seq is not None:
            if seq == prev_seq:
                pass  # already flagged as duplicate above
            elif seq < prev_seq:
                anomalies.append(OrderingAnomaly("OUT_OF_ORDER", seq,
                                                 f"sequence {seq} < previous {prev_seq}"))
            elif seq > prev_seq + 1:
                for missing in range(prev_seq + 1, seq):
                    anomalies.append(OrderingAnomaly("MISSING_SEQUENCE", missing,
                                                     f"gap: sequence {missing} absent"))

        # hash-chain integrity
        rec = OpEventRecord.from_dict(raw)
        recomputed = rec.content_hash()
        stored = raw.get("content_hash")
        if stored is not None and stored != recomputed:
            anomalies.append(OrderingAnomaly("HASH_CHAIN_BREAK", seq,
                                             "content_hash does not match event content (tamper)"))
        if prev_hash is not None and rec.prev_event_hash != prev_hash:
            anomalies.append(OrderingAnomaly("HASH_CHAIN_BREAK", seq,
                                             "prev_event_hash does not match prior event"))
        prev_hash = stored if stored is not None else recomputed
        prev_seq = seq

    return anomalies


def is_chain_intact(events: list[dict]) -> bool:
    """True iff no ordering or hash-chain anomalies are present."""
    return not detect_ordering_anomalies(events)
