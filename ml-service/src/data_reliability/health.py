"""
Phase 3Q — Data-health API shape (spec §27).

A serialisable, secret-free snapshot of data-layer health for an operator
dashboard. It carries market/provider status, latest market + ingestion
timestamps, selected provider + fallback state, DQ verdict, missing-bar count,
stale instruments, conflicts, last refresh, and schema version. The builder runs
the payload through the security redactor and fail-closes (raises) if a
credential would ever leak into it (spec §28).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .security import contains_secret, redact_mapping


@dataclass
class ProviderHealth:
    provider:       str
    status:         str            # ProviderFailure value
    is_selected:    bool = False
    is_fallback:    bool = False
    latency_ms:     Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider, "status": self.status,
            "isSelected": self.is_selected, "isFallback": self.is_fallback,
            "latencyMs": self.latency_ms,
        }


@dataclass
class DataHealthReport:
    """Operator-facing data-health snapshot (spec §27). Contains NO secrets."""
    market_session:       str
    selected_provider:    str
    providers:            list[ProviderHealth]
    dq_verdict:           str
    latest_market_ts:     Optional[str] = None
    latest_ingestion_ts:  Optional[str] = None
    fallback_active:      bool = False
    missing_bar_count:    int = 0
    stale_instruments:    list[str] = field(default_factory=list)
    conflicts:            list[str] = field(default_factory=list)
    last_refresh_ts:      Optional[str] = None
    schema_version:       str = ""
    extra:                dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "marketSession":     self.market_session,
            "selectedProvider":  self.selected_provider,
            "providers":         [p.to_dict() for p in self.providers],
            "dqVerdict":         self.dq_verdict,
            "latestMarketTs":    self.latest_market_ts,
            "latestIngestionTs": self.latest_ingestion_ts,
            "fallbackActive":    self.fallback_active,
            "missingBarCount":   self.missing_bar_count,
            "staleInstruments":  self.stale_instruments,
            "conflicts":         self.conflicts,
            "lastRefreshTs":     self.last_refresh_ts,
            "schemaVersion":     self.schema_version,
            "extra":             self.extra,
        }
        # Fail-closed: a health payload must never carry a credential (spec §28).
        if contains_secret(payload):
            raise ValueError("data-health payload would leak a credential — refused")
        # Belt-and-braces: redact anything credential-shaped that slipped into extra.
        return redact_mapping(payload)
