"""
Phase 3Q — Data-reliability alert severity classification (spec §26).

Maps data-reliability conditions to a 4-level severity (INFO / WARNING / ERROR /
CRITICAL). The existing `src.monitoring.alerts.AlertSeverity` has no ERROR level,
so Phase 3Q defines its own `DataAlertSeverity` (additive) and a mapping onto the
existing model-alert severity for dispatch. Every alert identifies instrument,
provider, and session so an operator can act.

Severity policy (spec §26):
  - delayed / aging data                 -> WARNING
  - cross-provider conflict              -> ERROR
  - invalid prices reaching a decision   -> CRITICAL
  - stale data producing a decision      -> CRITICAL
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional


class DataAlertSeverity(str, Enum):
    INFO     = "INFO"
    WARNING  = "WARNING"
    ERROR    = "ERROR"
    CRITICAL = "CRITICAL"


class DataAlertKind(str, Enum):
    DATA_DELAYED             = "DATA_DELAYED"
    DATA_MISSING             = "DATA_MISSING"
    PROVIDER_CONFLICT        = "PROVIDER_CONFLICT"
    PROVIDER_OUTAGE          = "PROVIDER_OUTAGE"
    INVALID_PRICE_TO_DECISION = "INVALID_PRICE_TO_DECISION"
    STALE_DATA_TO_DECISION   = "STALE_DATA_TO_DECISION"
    RATE_LIMITED             = "RATE_LIMITED"
    RECOVERED                = "RECOVERED"


# Fixed severity per condition (spec §26). Defined explicitly, not inferred, so
# the escalation contract is auditable.
_SEVERITY: dict[DataAlertKind, DataAlertSeverity] = {
    DataAlertKind.DATA_DELAYED:              DataAlertSeverity.WARNING,
    DataAlertKind.DATA_MISSING:              DataAlertSeverity.WARNING,
    DataAlertKind.PROVIDER_CONFLICT:         DataAlertSeverity.ERROR,
    DataAlertKind.PROVIDER_OUTAGE:           DataAlertSeverity.ERROR,
    DataAlertKind.INVALID_PRICE_TO_DECISION: DataAlertSeverity.CRITICAL,
    DataAlertKind.STALE_DATA_TO_DECISION:    DataAlertSeverity.CRITICAL,
    DataAlertKind.RATE_LIMITED:              DataAlertSeverity.WARNING,
    DataAlertKind.RECOVERED:                 DataAlertSeverity.INFO,
}


def severity_for(kind: DataAlertKind | str) -> DataAlertSeverity:
    return _SEVERITY[DataAlertKind(kind)]


@dataclass(frozen=True)
class DataAlert:
    """A data-reliability alert (spec §26). Always names instrument/provider/session."""
    kind:       str            # DataAlertKind value
    severity:   str            # DataAlertSeverity value
    instrument: str
    provider:   str
    session:    str
    message:    str
    timestamp:  str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata:   dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind, "severity": self.severity,
            "instrument": self.instrument, "provider": self.provider,
            "session": self.session, "message": self.message,
            "timestamp": self.timestamp, "metadata": self.metadata,
        }


def make_data_alert(
    kind: DataAlertKind | str,
    *,
    instrument: str,
    provider: str,
    session: str,
    message: str,
    metadata: Optional[dict[str, Any]] = None,
) -> DataAlert:
    k = DataAlertKind(kind)
    return DataAlert(
        kind=k.value, severity=severity_for(k).value,
        instrument=instrument, provider=provider, session=session,
        message=message, metadata=metadata or {},
    )


def to_monitoring_severity(sev: DataAlertSeverity | str):
    """
    Map Phase 3Q severity onto the existing `src.monitoring.alerts.AlertSeverity`
    (which lacks ERROR) so data alerts can be dispatched through the existing
    AlertSystem: ERROR/CRITICAL -> CRITICAL, WARNING -> WARNING, INFO -> INFO.
    """
    from src.monitoring.alerts import AlertSeverity
    s = DataAlertSeverity(sev)
    if s in (DataAlertSeverity.ERROR, DataAlertSeverity.CRITICAL):
        return AlertSeverity.CRITICAL
    if s == DataAlertSeverity.WARNING:
        return AlertSeverity.WARNING
    return AlertSeverity.INFO
