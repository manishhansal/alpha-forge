"""
Phase 3Q — Structured observability events (spec §39).

A typed event stream for the data-reliability layer. Every event carries enough
context to reconstruct what happened (provider, instrument, session, detail) and
is run through the security redactor so a credential can never leak into an event
payload. Events are the audit trail behind monitoring metrics and alerts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from .security import redact_mapping


class ObservabilityEvent(str, Enum):
    DATA_RECEIVED       = "DATA_RECEIVED"
    DATA_REJECTED       = "DATA_REJECTED"
    DATA_STALE          = "DATA_STALE"
    PROVIDER_CONFLICT   = "PROVIDER_CONFLICT"
    PROVIDER_SWITCH     = "PROVIDER_SWITCH"
    RECOVERED           = "RECOVERED"
    CACHE_HIT           = "CACHE_HIT"
    CACHE_MISS          = "CACHE_MISS"
    FEATURE_UNAVAILABLE = "FEATURE_UNAVAILABLE"
    SIGNAL_SUPPRESSED   = "SIGNAL_SUPPRESSED"
    DECISION_BLOCKED    = "DECISION_BLOCKED"


@dataclass(frozen=True)
class EventRecord:
    event:      str            # ObservabilityEvent value
    provider:   str
    instrument: str
    session:    str
    detail:     str = ""
    timestamp:  str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata:   dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "event": self.event, "provider": self.provider,
            "instrument": self.instrument, "session": self.session,
            "detail": self.detail, "timestamp": self.timestamp,
            "metadata": self.metadata,
        }


class EventLog:
    """
    Append-only, redaction-safe observability log (spec §39). `emit(...)` records
    a typed event; the metadata is redacted at emit time so no credential is ever
    persisted into the audit trail.
    """

    def __init__(self, max_size: int = 10_000) -> None:
        self._events: list[EventRecord] = []
        self._max = max_size

    def emit(
        self,
        event: ObservabilityEvent | str,
        *,
        provider: str,
        instrument: str,
        session: str,
        detail: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> EventRecord:
        rec = EventRecord(
            event=ObservabilityEvent(event).value,
            provider=provider, instrument=instrument, session=session,
            detail=detail, metadata=redact_mapping(metadata or {}),
        )
        self._events.append(rec)
        if len(self._events) > self._max:
            self._events.pop(0)
        return rec

    def recent(self, limit: int = 100) -> list[EventRecord]:
        return self._events[-limit:]

    def count(self, event: Optional[ObservabilityEvent | str] = None) -> int:
        if event is None:
            return len(self._events)
        ev = ObservabilityEvent(event).value
        return sum(1 for e in self._events if e.event == ev)
