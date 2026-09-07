"""
Phase 3Q — Correction policy (spec §24).

Corrections NEVER overwrite the original observation. An ORIGINAL is preserved and
a CORRECTED revision is appended with a strictly higher revision_id. The full
version history is retained so any point-in-time replay remains reproducible: a
query at time T still sees only what was available at T (via
`data.point_in_time.select_best_revision`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class ObservationVersion(str, Enum):
    ORIGINAL  = "ORIGINAL"
    CORRECTED = "CORRECTED"


@dataclass(frozen=True)
class CorrectionEntry:
    observation_key: str            # logical observation identity
    version:         str            # ObservationVersion value
    revision_id:     int
    available_time:  str            # ISO-8601 UTC — when this revision became usable
    payload:         dict = field(default_factory=dict)
    reason:          str = ""
    recorded_at:     str = ""

    def to_dict(self) -> dict:
        return {
            "observationKey": self.observation_key,
            "version":        self.version,
            "revisionId":     self.revision_id,
            "availableTime":  self.available_time,
            "reason":         self.reason,
            "recordedAt":     self.recorded_at,
        }


class CorrectionLog:
    """
    Append-only correction ledger (spec §24). `record_original` seeds revision 0;
    `record_correction` appends a higher revision WITHOUT mutating any prior entry.
    History is never rewritten, so replay stays reproducible.
    """

    def __init__(self) -> None:
        self._log: dict[str, list[CorrectionEntry]] = {}

    def record_original(self, observation_key: str, available_time: datetime,
                        payload: Optional[dict] = None) -> CorrectionEntry:
        if observation_key in self._log and self._log[observation_key]:
            raise ValueError(
                f"ORIGINAL already recorded for {observation_key}; "
                "use record_correction to append a revision (no overwrite)."
            )
        entry = CorrectionEntry(
            observation_key=observation_key,
            version=ObservationVersion.ORIGINAL.value,
            revision_id=0,
            available_time=available_time.isoformat(),
            payload=dict(payload or {}),
            recorded_at=datetime.now(available_time.tzinfo).isoformat(),
        )
        self._log.setdefault(observation_key, []).append(entry)
        return entry

    def record_correction(self, observation_key: str, available_time: datetime,
                          payload: Optional[dict] = None,
                          reason: str = "") -> CorrectionEntry:
        history = self._log.get(observation_key)
        if not history:
            raise ValueError(
                f"No ORIGINAL exists for {observation_key}; "
                "record_original first (corrections never precede the original)."
            )
        next_rev = max(e.revision_id for e in history) + 1
        entry = CorrectionEntry(
            observation_key=observation_key,
            version=ObservationVersion.CORRECTED.value,
            revision_id=next_rev,
            available_time=available_time.isoformat(),
            payload=dict(payload or {}),
            reason=reason,
            recorded_at=datetime.now(available_time.tzinfo).isoformat(),
        )
        history.append(entry)  # append-only — prior revisions untouched
        return entry

    def history(self, observation_key: str) -> list[CorrectionEntry]:
        return list(self._log.get(observation_key, []))

    def revision_count(self, observation_key: str) -> int:
        return len(self._log.get(observation_key, []))
