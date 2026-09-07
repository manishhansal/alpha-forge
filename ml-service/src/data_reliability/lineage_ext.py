"""
Phase 3Q — Extended data lineage (spec §21).

Wraps the existing `data.lineage.MLObservationLineage` with the additional
operational-provenance fields required by Phase 3Q so that every prediction is
traceable to its exact input state: fallback reason, source priority, validation
status, adjustment mode, and transformation version. The underlying lineage
record and its append-only store are REUSED, not duplicated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from .adjustment import AdjustmentMode
from .failure import ProviderFailure


@dataclass
class DataLineageRecord:
    """
    Full operational lineage for one observation (spec §21). Composes the
    existing lineage record's core fields with Phase 3Q provenance so a
    prediction can be traced back to the exact upstream input.
    """
    observation_id:         str
    instrument_id:          str            # canonical id, NOT display symbol
    provider:               str
    market_time:            str            # ISO-8601 UTC
    retrieval_time:         str            # ISO-8601 UTC
    dataset_version:        str = ""
    schema_version:         str = ""
    adjustment_mode:        str = AdjustmentMode.UNKNOWN.value
    validation_status:      str = ""       # DQVerdict value
    fallback_reason:        Optional[str] = None
    source_priority:        int = 0        # position in provider hierarchy (0 = primary)
    transformation_version: str = ""
    provider_status:        str = ProviderFailure.OK.value
    extra:                  dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "observationId":        self.observation_id,
            "instrumentId":         self.instrument_id,
            "provider":             self.provider,
            "marketTime":           self.market_time,
            "retrievalTime":        self.retrieval_time,
            "datasetVersion":       self.dataset_version,
            "schemaVersion":        self.schema_version,
            "adjustmentMode":       self.adjustment_mode,
            "validationStatus":     self.validation_status,
            "fallbackReason":       self.fallback_reason,
            "sourcePriority":       self.source_priority,
            "transformationVersion": self.transformation_version,
            "providerStatus":       self.provider_status,
            "extra":                self.extra,
        }


def record_lineage(
    store,                          # data.lineage.MLObservationLineageStore
    *,
    instrument_id: str,
    data_type: str,
    provider: str,
    event_time: datetime,
    available_time: datetime,
    ingestion_time: Optional[datetime] = None,
    dataset_version: str = "",
    schema_version: str = "",
    adjustment_mode: str = AdjustmentMode.UNKNOWN.value,
    validation_status: str = "",
    fallback_reason: Optional[str] = None,
    source_priority: int = 0,
    transformation_version: str = "",
    provider_status: str = ProviderFailure.OK.value,
    raw_values: Optional[dict] = None,
) -> DataLineageRecord:
    """
    Persist a core lineage entry via the EXISTING store, then return the extended
    Phase 3Q lineage record carrying the operational-provenance fields. The
    Phase 3Q fields are stored in the core record's `notes` (JSON) so they survive
    persistence without modifying the existing schema.
    """
    import json

    ext = DataLineageRecord(
        observation_id="",  # filled after store.record returns the id
        instrument_id=instrument_id,
        provider=provider,
        market_time=event_time.isoformat(),
        retrieval_time=(ingestion_time or available_time).isoformat(),
        dataset_version=dataset_version,
        schema_version=schema_version,
        adjustment_mode=adjustment_mode,
        validation_status=validation_status,
        fallback_reason=fallback_reason,
        source_priority=source_priority,
        transformation_version=transformation_version,
        provider_status=provider_status,
    )

    obs_id = store.record(
        symbol=instrument_id,
        data_type=data_type,
        provider=provider,
        event_time=event_time,
        available_time=available_time,
        ingestion_time=ingestion_time,
        dataset_version=dataset_version,
        is_fallback=fallback_reason is not None,
        raw_values=raw_values,
        notes=json.dumps({k: v for k, v in ext.to_dict().items()
                          if k not in ("observationId",)}),
    )
    ext.observation_id = obs_id
    return ext
