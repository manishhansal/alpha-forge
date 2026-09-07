"""
Phase 3Q — Live-day replay without future leak (spec §23).

`ReplayDriver.replay(as_of)` reconstructs the data state that was actually
available at `as_of` — nothing that became available afterwards. Bars, corporate
actions, metadata, and corrections that were NOT yet available leak nothing into
the replay. This REUSES `PointInTimeRecord.is_available_at` and
`select_best_revision`, so the future-leak invariant is the one already enforced
by the PIT layer.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from src.data.point_in_time import (
    DataAvailabilityStatus,
    PointInTimeRecord,
    select_best_revision,
)


@dataclass
class ReplayResult:
    as_of:            str                       # ISO-8601 UTC
    available:        list[PointInTimeRecord]   # best revision available at as_of
    withheld_future:  int                       # count of records not-yet-available
    to_dict_records:  bool = field(default=True, repr=False)

    @property
    def count(self) -> int:
        return len(self.available)

    def to_dict(self) -> dict:
        return {
            "asOf":           self.as_of,
            "availableCount": len(self.available),
            "withheldFuture": self.withheld_future,
            "records":        [r.to_dict() for r in self.available],
        }


class ReplayDriver:
    """
    Deterministic point-in-time replay (spec §23). Add revisions of observations;
    `replay(as_of)` returns exactly one best revision per observation key whose
    `available_time <= as_of`. Never returns future information.
    """

    def __init__(self) -> None:
        # key -> list of revisions of the SAME logical observation
        self._revisions: dict[str, list[PointInTimeRecord]] = defaultdict(list)

    @staticmethod
    def _key(rec: PointInTimeRecord) -> str:
        # A logical observation = (symbol, exchange, event_time); revisions differ
        # only by revision_id / available_time.
        return f"{rec.symbol}|{rec.exchange}|{rec.event_time.isoformat()}"

    def add(self, record: PointInTimeRecord) -> None:
        self._revisions[self._key(record)].append(record)

    def add_many(self, records) -> None:
        for r in records:
            self.add(r)

    def replay(self, as_of: datetime) -> ReplayResult:
        """
        Reconstruct the state available at `as_of`. For each logical observation,
        select the best (latest-available) revision whose availability <= as_of.
        Records not yet available are withheld and counted — NEVER leaked.
        """
        available: list[PointInTimeRecord] = []
        withheld = 0
        for key, revs in self._revisions.items():
            best = select_best_revision(revs, as_of)
            if best is None:
                # nothing for this observation was available at as_of
                withheld += 1
                continue
            # Defensive re-assert of the PIT invariant on the chosen revision.
            if best.is_available_at(as_of) != DataAvailabilityStatus.AVAILABLE:
                withheld += 1
                continue
            available.append(best)
        available.sort(key=lambda r: (r.event_time, r.symbol))
        return ReplayResult(as_of=as_of.isoformat(), available=available,
                            withheld_future=withheld)
