"""
ML Observation Lineage — AlphaForge ML Service.

Provides per-observation and per-dataset lineage tracing for the ML pipeline.
This is distinct from the data-service live-signal lineage (data-service/src/core/lineage.py)
which tracks real-time quotes.  This module tracks TRAINING OBSERVATIONS.

Design principles
-----------------
- Every training observation gets an observation_id linking it to its source.
- Every dataset artifact records all source versions used to create it.
- Lineage is append-only: records are never mutated after creation.
- No external service dependency: in-memory + optional JSON persistence.

Relation to data-service lineage
----------------------------------
The data-service lineage tracks live-signal observations (quotes, ticks, candles)
for real-time debugging.  This module tracks ML training observations for:
  - Reproducibility: which data version produced which model?
  - Audit: why did the model behave a certain way on a date?
  - Debugging: which rows in the training dataset came from which source?

These are different concerns; we do NOT import from data-service.
"""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import structlog

logger = structlog.get_logger(__name__)

UTC = timezone.utc


# ── MLObservationLineage ───────────────────────────────────────────────────────

@dataclass
class MLObservationLineage:
    """
    Full lineage record for a single ML training observation.

    Every row contributed to a training dataset should produce one of these.
    The observation_id links the row in the .npz training file to the source
    data that generated it.

    Fields
    ------
    observation_id  : UUID, primary key for this lineage record.
    symbol          : Trading symbol (NSE uppercase).
    data_type       : "OHLCV" | "DERIVATIVES" | "MARKET_BREADTH" | "VIX"
    provider        : Source provider (mirrors DataSource enum values from data-service).
    event_time      : When the market event occurred (UTC ISO string).
    available_time  : When this datum became available (UTC ISO string).
    ingestion_time  : When ml-service fetched/recorded it (UTC ISO string).
    dataset_version : Dataset version this observation contributed to.
    is_fallback     : True if this came from a fallback/stale source.
    revision_id     : Revision number (0 = original; higher = correction).
    raw_hash        : SHA-256 of the raw row values (for integrity checking).
    """

    observation_id:   str
    symbol:           str
    data_type:        str
    provider:         str
    event_time:       str          # ISO-8601 UTC
    available_time:   str          # ISO-8601 UTC
    ingestion_time:   str          # ISO-8601 UTC
    dataset_version:  str
    is_fallback:      bool = False
    revision_id:      int  = 0
    raw_hash:         Optional[str] = None
    notes:            str = ""
    created_at:       str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ── MLObservationLineageStore ─────────────────────────────────────────────────

class MLObservationLineageStore:
    """
    In-memory store for ML observation lineage records.

    Thread-safe, bounded by max_size with LRU eviction.
    Optionally persists to a JSONL file (one record per line).

    Usage
    -----
    ::
        store = MLObservationLineageStore()
        obs_id = store.record(
            symbol="RELIANCE",
            data_type="OHLCV",
            provider="NSE_BHAVCOPY",
            event_time=event_dt,
            available_time=avail_dt,
            ingestion_time=now,
            dataset_version="af-v3.0-fv4",
        )
        lineage = store.get(obs_id)
    """

    def __init__(
        self,
        max_size: int = 100_000,
        persist_path: Optional[Path] = None,
    ) -> None:
        self._store: dict[str, MLObservationLineage] = {}
        self._order: list[str] = []
        self._max_size = max_size
        self._persist_path = persist_path
        self._lock = threading.Lock()
        self._total_recorded = 0

    def record(
        self,
        symbol: str,
        data_type: str,
        provider: str,
        event_time: datetime,
        available_time: datetime,
        ingestion_time: Optional[datetime] = None,
        dataset_version: str = "",
        is_fallback: bool = False,
        revision_id: int = 0,
        raw_values: Optional[dict] = None,
        notes: str = "",
    ) -> str:
        """Record a new lineage entry and return its observation_id."""
        now = datetime.now(UTC)
        obs_id = str(uuid.uuid4())

        raw_hash: Optional[str] = None
        if raw_values is not None:
            h = hashlib.sha256(
                json.dumps(raw_values, sort_keys=True, default=str).encode()
            ).hexdigest()
            raw_hash = h[:16]  # first 16 hex chars for brevity

        record = MLObservationLineage(
            observation_id=obs_id,
            symbol=symbol.upper(),
            data_type=data_type,
            provider=provider,
            event_time=event_time.astimezone(UTC).isoformat(),
            available_time=available_time.astimezone(UTC).isoformat(),
            ingestion_time=(ingestion_time or now).astimezone(UTC).isoformat(),
            dataset_version=dataset_version,
            is_fallback=is_fallback,
            revision_id=revision_id,
            raw_hash=raw_hash,
            notes=notes,
        )

        with self._lock:
            self._store[obs_id] = record
            self._order.append(obs_id)
            if len(self._order) > self._max_size:
                oldest = self._order.pop(0)
                self._store.pop(oldest, None)
            self._total_recorded += 1

        if self._persist_path is not None:
            self._append_to_file(record)

        return obs_id

    def get(self, observation_id: str) -> Optional[MLObservationLineage]:
        with self._lock:
            return self._store.get(observation_id)

    def get_by_symbol(self, symbol: str, limit: int = 20) -> list[MLObservationLineage]:
        sym = symbol.upper()
        with self._lock:
            return [
                r for r in reversed(
                    [self._store[oid] for oid in self._order if oid in self._store]
                )
                if r.symbol == sym
            ][:limit]

    @property
    def total_recorded(self) -> int:
        with self._lock:
            return self._total_recorded

    @property
    def current_size(self) -> int:
        with self._lock:
            return len(self._store)

    def _append_to_file(self, record: MLObservationLineage) -> None:
        try:
            path = self._persist_path
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record.to_dict()) + "\n")
        except Exception as exc:
            logger.warning("lineage_persist_failed", error=str(exc))


# ── DatasetLineage ─────────────────────────────────────────────────────────────

@dataclass
class DatasetLineage:
    """
    Lineage record for a complete training dataset.

    Records every source version that contributed to the dataset so the
    full provenance chain is traceable: code → data → features → labels → model.

    Fields
    ------
    dataset_id          : UUID for this dataset generation run.
    dataset_version     : Human-readable version tag (e.g. "af-v3.0-fv4").
    created_at          : When the dataset was created (UTC ISO string).
    git_commit          : Git SHA at dataset creation time.
    pipeline_version    : data_pipeline.py version tag.
    feature_version     : feature engineering version tag.
    label_version       : label generation version tag.
    source_fingerprint  : SHA-256 of all input source identifiers + dates.
    universe_version    : Identifier for the training universe used.
    instrument_master_version : Version of the instrument master consulted.
    corporate_action_version  : Version of corporate action data consulted.
    training_start      : First date in the training window (ISO date string).
    training_end        : Last date in the training window (ISO date string).
    symbol_count        : Number of distinct symbols in the dataset.
    row_count           : Total number of training rows.
    quality_status      : "CLEAN" | "HAS_WARNINGS" | "HAS_ERRORS"
    limitations         : List of documented limitations / DATA_UNAVAILABLE flags.
    observation_ids     : Sample of observation IDs (not all, for large datasets).
    """

    dataset_id:                str
    dataset_version:           str
    created_at:                str
    git_commit:                str
    pipeline_version:          str
    feature_version:           str
    label_version:             str
    source_fingerprint:        str
    universe_version:          str
    instrument_master_version: str
    corporate_action_version:  str
    training_start:            str
    training_end:              str
    symbol_count:              int
    row_count:                 int
    quality_status:            str
    limitations:               list[str] = field(default_factory=list)
    observation_ids_sample:    list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

    @classmethod
    def create(
        cls,
        *,
        dataset_version: str,
        git_commit: str,
        pipeline_version: str,
        feature_version: str,
        label_version: str,
        source_identifiers: list[str],
        universe_version: str,
        instrument_master_version: str,
        corporate_action_version: str,
        training_start: str,
        training_end: str,
        symbol_count: int,
        row_count: int,
        quality_status: str = "CLEAN",
        limitations: Optional[list[str]] = None,
        observation_ids_sample: Optional[list[str]] = None,
    ) -> "DatasetLineage":
        """Factory with auto-generated dataset_id and source_fingerprint."""
        fp = compute_source_fingerprint(
            source_identifiers=source_identifiers,
            pipeline_version=pipeline_version,
            feature_version=feature_version,
            label_version=label_version,
        )
        return cls(
            dataset_id=str(uuid.uuid4()),
            dataset_version=dataset_version,
            created_at=datetime.now(UTC).isoformat(),
            git_commit=git_commit,
            pipeline_version=pipeline_version,
            feature_version=feature_version,
            label_version=label_version,
            source_fingerprint=fp,
            universe_version=universe_version,
            instrument_master_version=instrument_master_version,
            corporate_action_version=corporate_action_version,
            training_start=training_start,
            training_end=training_end,
            symbol_count=symbol_count,
            row_count=row_count,
            quality_status=quality_status,
            limitations=limitations or [],
            observation_ids_sample=observation_ids_sample or [],
        )


# ── Fingerprint helper ─────────────────────────────────────────────────────────

def compute_source_fingerprint(
    source_identifiers: list[str],
    pipeline_version: str,
    feature_version: str,
    label_version: str,
) -> str:
    """
    Compute a SHA-256 fingerprint for a dataset's input sources.

    Two datasets with identical inputs (same sources, same versions) will
    produce the same fingerprint, enabling deduplication and caching.

    Mirrors data-service's compute_dataset_fingerprint() algorithm
    without importing from it.
    """
    key = {
        "sources": sorted(source_identifiers),
        "pipeline": pipeline_version,
        "features": feature_version,
        "labels":   label_version,
    }
    return hashlib.sha256(
        json.dumps(key, sort_keys=True).encode()
    ).hexdigest()


# ── Module-level singleton ─────────────────────────────────────────────────────

# A default in-memory store for the training pipeline.
# Tests and training scripts can use this directly or create their own.
observation_lineage_store = MLObservationLineageStore(max_size=500_000)
