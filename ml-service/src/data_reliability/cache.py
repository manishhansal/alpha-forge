"""
Phase 3Q — Cache integrity (spec §20).

A cached datum is only usable when its provider, schema, adjustment mode, and
dataset version match the request AND its TTL has not expired. A stale, corrupt,
schema-mismatched, or provider-mismatched entry is treated as a MISS (never
served, never allowed to override a fresh value). The cache NEVER weakens the
point-in-time contract: it only ever returns a previously-stored, still-valid
value — it cannot invent availability.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Optional

from .adjustment import AdjustmentMode


class CacheStatus(str, Enum):
    HIT               = "HIT"
    MISS              = "MISS"                  # key absent
    STALE             = "STALE"                # TTL expired
    SCHEMA_MISMATCH   = "SCHEMA_MISMATCH"
    PROVIDER_MISMATCH = "PROVIDER_MISMATCH"
    ADJUSTMENT_MISMATCH = "ADJUSTMENT_MISMATCH"
    VERSION_MISMATCH  = "VERSION_MISMATCH"
    CORRUPT           = "CORRUPT"


_USABLE = {CacheStatus.HIT}


@dataclass
class CacheEntry:
    key:             str
    provider:        str
    instrument:      str
    timestamp:       str                      # market timestamp (ISO)
    stored_at:       datetime                 # tz-aware UTC
    ttl_seconds:     float
    dataset_version: str
    adjustment_mode: str
    schema_version:  str
    payload:         Any = None

    def is_expired(self, now: datetime) -> bool:
        return now >= self.stored_at + timedelta(seconds=self.ttl_seconds)


@dataclass
class CacheLookup:
    status: str                               # CacheStatus value
    entry:  Optional[CacheEntry] = None

    @property
    def is_hit(self) -> bool:
        return self.status == CacheStatus.HIT.value

    def to_dict(self) -> dict:
        return {"status": self.status,
                "hasEntry": self.entry is not None}


class CacheStore:
    """
    Integrity-checked cache (spec §20). `get(...)` validates freshness + schema +
    provider + adjustment-mode + version match before returning a HIT. Any
    mismatch or expiry is reported as a typed non-hit and the caller must refetch
    — a stale entry can NEVER override a fresh one.
    """

    def __init__(self) -> None:
        self._store: dict[str, CacheEntry] = {}

    def put(self, entry: CacheEntry) -> None:
        # Never downgrade a fresher entry with a staler one for the same key.
        existing = self._store.get(entry.key)
        if existing is not None and entry.stored_at < existing.stored_at:
            return
        self._store[entry.key] = entry

    def get(
        self,
        key: str,
        *,
        provider: str,
        schema_version: str,
        adjustment_mode: str,
        dataset_version: str,
        now: Optional[datetime] = None,
    ) -> CacheLookup:
        now = now or datetime.now(timezone.utc)
        entry = self._store.get(key)
        if entry is None:
            return CacheLookup(CacheStatus.MISS.value)
        if entry.payload is None:
            return CacheLookup(CacheStatus.CORRUPT.value, entry)
        if entry.provider != provider:
            return CacheLookup(CacheStatus.PROVIDER_MISMATCH.value, entry)
        if entry.schema_version != schema_version:
            return CacheLookup(CacheStatus.SCHEMA_MISMATCH.value, entry)
        if entry.adjustment_mode != adjustment_mode or \
           entry.adjustment_mode == AdjustmentMode.UNKNOWN.value:
            return CacheLookup(CacheStatus.ADJUSTMENT_MISMATCH.value, entry)
        if entry.dataset_version != dataset_version:
            return CacheLookup(CacheStatus.VERSION_MISMATCH.value, entry)
        if entry.is_expired(now):
            return CacheLookup(CacheStatus.STALE.value, entry)
        return CacheLookup(CacheStatus.HIT.value, entry)

    def invalidate(self, key: str) -> None:
        self._store.pop(key, None)

    @property
    def size(self) -> int:
        return len(self._store)
