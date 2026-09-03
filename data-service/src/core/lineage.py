"""
Data Lineage Engine — Phases 61-62.

Answers for every signal-consumed datum:
  WHERE DID IT COME FROM?
  WHEN WAS IT OBSERVED?
  WHEN WAS IT RECEIVED?
  WHEN DID IT BECOME AVAILABLE?
  WHAT NORMALIZATION WAS APPLIED?
  WHAT VALIDATION WAS APPLIED?
  WAS IT FALLBACK DATA?

dataObservationId links a signal to the exact market observations used to
generate it, enabling full post-trade forensics.

Phase 62: dataObservationId
Phase 61: DataLineageRecord
Phase 59: Replay via datasetFingerprint

Usage:
    from src.core.lineage import lineage_store
    obs_id = lineage_store.record(observation)
    lineage = lineage_store.get(obs_id)
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any, Optional

from src.core.schemas_v2 import DataProvenance, DataSource


class DataLineageRecord:
    """Complete lineage record for a market data observation."""

    def __init__(
        self,
        observation_id: str,
        instrument_id: str,
        symbol: str,
        data_type: str,          # QUOTE, TICK, CANDLE, OPTION_CHAIN, INSTRUMENT
        source: DataSource,
        event_time_ms: Optional[int],
        received_at_ms: int,
        available_at_ms: int,
        normalization_version: str,
        validation_applied: bool,
        is_fallback: bool,
        fallback_reason: Optional[str],
        raw_payload_hash: Optional[str] = None,
        extra: Optional[dict] = None,
    ) -> None:
        self.observation_id = observation_id
        self.instrument_id = instrument_id
        self.symbol = symbol
        self.data_type = data_type
        self.source = source
        self.event_time_ms = event_time_ms
        self.received_at_ms = received_at_ms
        self.available_at_ms = available_at_ms
        self.normalization_version = normalization_version
        self.validation_applied = validation_applied
        self.is_fallback = is_fallback
        self.fallback_reason = fallback_reason
        self.raw_payload_hash = raw_payload_hash
        self.extra = extra or {}
        self.created_at_ms = int(time.time() * 1000)

    def as_dict(self) -> dict:
        return {
            "observationId": self.observation_id,
            "instrumentId": self.instrument_id,
            "symbol": self.symbol,
            "dataType": self.data_type,
            "source": self.source.value,
            "eventTimeMs": self.event_time_ms,
            "receivedAtMs": self.received_at_ms,
            "availableAtMs": self.available_at_ms,
            "normalizationVersion": self.normalization_version,
            "validationApplied": self.validation_applied,
            "isFallback": self.is_fallback,
            "fallbackReason": self.fallback_reason,
            "rawPayloadHash": self.raw_payload_hash,
            "createdAtMs": self.created_at_ms,
        }


class LineageStore:
    """In-memory store for recent data lineage records.

    Bounded to max_size entries using LRU eviction.
    In production, important records should be persisted to Postgres.
    """

    def __init__(self, max_size: int = 10_000) -> None:
        self._store: OrderedDict[str, DataLineageRecord] = OrderedDict()
        self._max_size = max_size
        self._lock = threading.Lock()
        self._total_recorded = 0

    def record(
        self,
        instrument_id: str,
        symbol: str,
        data_type: str,
        source: DataSource,
        event_time_ms: Optional[int],
        received_at_ms: Optional[int] = None,
        available_at_ms: Optional[int] = None,
        normalization_version: str = "2.0.0",
        validation_applied: bool = True,
        is_fallback: bool = False,
        fallback_reason: Optional[str] = None,
        raw_payload_hash: Optional[str] = None,
        extra: Optional[dict] = None,
    ) -> str:
        """Record a new lineage entry and return its observation ID."""
        now_ms = int(time.time() * 1000)
        obs_id = str(uuid.uuid4())

        record = DataLineageRecord(
            observation_id=obs_id,
            instrument_id=instrument_id,
            symbol=symbol,
            data_type=data_type,
            source=source,
            event_time_ms=event_time_ms,
            received_at_ms=received_at_ms or now_ms,
            available_at_ms=available_at_ms or now_ms,
            normalization_version=normalization_version,
            validation_applied=validation_applied,
            is_fallback=is_fallback,
            fallback_reason=fallback_reason,
            raw_payload_hash=raw_payload_hash,
            extra=extra,
        )

        with self._lock:
            self._store[obs_id] = record
            self._store.move_to_end(obs_id)
            while len(self._store) > self._max_size:
                self._store.popitem(last=False)
            self._total_recorded += 1

        return obs_id

    def get(self, observation_id: str) -> Optional[DataLineageRecord]:
        """Retrieve a lineage record by ID."""
        with self._lock:
            return self._store.get(observation_id)

    def get_by_instrument(
        self,
        instrument_id: str,
        limit: int = 10,
    ) -> list[DataLineageRecord]:
        """Return recent records for an instrument."""
        with self._lock:
            records = [
                r for r in reversed(list(self._store.values()))
                if r.instrument_id == instrument_id
            ]
        return records[:limit]

    @property
    def total_recorded(self) -> int:
        with self._lock:
            return self._total_recorded

    @property
    def current_size(self) -> int:
        with self._lock:
            return len(self._store)


def compute_dataset_fingerprint(
    source: str,
    date_range_from: str,
    date_range_to: str,
    instrument_set: list[str],
    normalization_version: str,
    schema_version: str,
) -> str:
    """Compute a SHA-256 fingerprint for a dataset.

    Phase 60: Every dataset should have a fingerprint for experiment governance.

    Returns the full 64-character SHA-256 hex string.
    """
    key_data = {
        "source": source,
        "from": date_range_from,
        "to": date_range_to,
        "instruments": sorted(instrument_set),
        "normalization_version": normalization_version,
        "schema_version": schema_version,
    }
    key_str = json.dumps(key_data, sort_keys=True)
    return hashlib.sha256(key_str.encode()).hexdigest()


def compute_replay_hash(
    dataset_fingerprint: str,
    replay_start_ms: int,
    replay_end_ms: int,
    configuration_hash: str = "",
) -> str:
    """Compute a deterministic replay hash for replay reproducibility.

    Phase 59: Given same dataset + timestamp + config → same events.
    """
    key_str = f"{dataset_fingerprint}:{replay_start_ms}:{replay_end_ms}:{configuration_hash}"
    return hashlib.sha256(key_str.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

lineage_store = LineageStore(max_size=50_000)
