"""
Phase 3Q — Idempotent ingestion (spec §19).

Repeated retrieval of the same (provider, instrument, timestamp, dataset_version)
must NOT create duplicate canonical records — under retry, replay, out-of-order
delivery, or restart-after-partial-ingest. A deterministic dedup key drives an
append-only, restart-safe ledger (reuses `lifecycle._storage`).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def dedup_key(provider: str, instrument: str, timestamp, dataset_version: str = "") -> str:
    """
    Deterministic dedup key (spec §19). Order-independent of delivery: the same
    logical bar always maps to the same key regardless of when/how it arrives.
    """
    raw = f"{provider}|{instrument}|{timestamp}|{dataset_version}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


@dataclass
class IngestResult:
    accepted: bool          # True = newly ingested; False = duplicate no-op
    key:      str
    reason:   str = ""

    def to_dict(self) -> dict:
        return {"accepted": self.accepted, "key": self.key, "reason": self.reason}


class IdempotentIngest:
    """
    In-memory + optional persistent dedup guard. `ingest(...)` returns
    accepted=False (a no-op) for any key already seen — so duplicate / replayed /
    out-of-order / restart-resumed events never double-count (spec §19).
    """

    def __init__(self, root: Optional[str | Path] = None):
        self._seen: set[str] = set()
        self.root = Path(root) if root else None
        if self.root:
            self.root.mkdir(parents=True, exist_ok=True)
            self.path = self.root / "ingest_ledger.jsonl"
            self._load()
        else:
            self.path = None

    def _load(self) -> None:
        """Restart-safe: rebuild the seen-set from the append-only ledger (§19)."""
        if self.path is None:
            return
        from src.lifecycle._storage import read_jsonl
        for rec in read_jsonl(self.path):
            k = rec.get("key")
            if k:
                self._seen.add(k)

    def ingest(self, provider: str, instrument: str, timestamp,
               dataset_version: str = "") -> IngestResult:
        key = dedup_key(provider, instrument, timestamp, dataset_version)
        if key in self._seen:
            return IngestResult(False, key, "duplicate — no-op")
        self._seen.add(key)
        if self.path is not None:
            from src.lifecycle._storage import append_jsonl
            append_jsonl(self.path, {"key": key, "provider": provider,
                                     "instrument": instrument,
                                     "timestamp": str(timestamp),
                                     "dataset_version": dataset_version})
        return IngestResult(True, key)

    def has(self, provider: str, instrument: str, timestamp,
            dataset_version: str = "") -> bool:
        return dedup_key(provider, instrument, timestamp, dataset_version) in self._seen

    @property
    def count(self) -> int:
        return len(self._seen)
