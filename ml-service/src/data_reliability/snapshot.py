"""
Phase 3Q — Reproducible snapshot identity (spec §22).

A snapshot's IDENTITY is a deterministic hash over everything that can change its
downstream meaning: provider set, universe version, date range, schema version,
transformation version, corporate-action version, and feature version. Same
inputs -> same identity -> same downstream results. This REUSES the existing
`data.dataset_version.DatasetSnapshot` for the persisted artefact and only adds
the compact identity used for equality / reproducibility checks.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field


@dataclass(frozen=True)
class SnapshotIdentity:
    """
    Deterministic identity of a data snapshot (spec §22). Two snapshots with the
    same identity MUST reproduce the same downstream state.
    """
    providers:              tuple[str, ...]
    universe_version:       str
    date_start:             str            # ISO date
    date_end:               str            # ISO date
    schema_version:         str
    transformation_version: str
    corporate_action_version: str
    feature_version:        str

    def fingerprint(self) -> str:
        """SHA-256 (first 16 hex) over the sorted, canonical identity payload."""
        payload = {
            "providers":              sorted(self.providers),
            "universe_version":       self.universe_version,
            "date_start":             self.date_start,
            "date_end":               self.date_end,
            "schema_version":         self.schema_version,
            "transformation_version": self.transformation_version,
            "corporate_action_version": self.corporate_action_version,
            "feature_version":        self.feature_version,
        }
        raw = json.dumps(payload, sort_keys=True).encode()
        return hashlib.sha256(raw).hexdigest()[:16]

    def matches(self, other: "SnapshotIdentity") -> bool:
        return self.fingerprint() == other.fingerprint()

    def to_dict(self) -> dict:
        return {
            "fingerprint":            self.fingerprint(),
            "providers":              sorted(self.providers),
            "universeVersion":        self.universe_version,
            "dateStart":              self.date_start,
            "dateEnd":                self.date_end,
            "schemaVersion":          self.schema_version,
            "transformationVersion":  self.transformation_version,
            "corporateActionVersion": self.corporate_action_version,
            "featureVersion":         self.feature_version,
        }


def compute_snapshot_identity(
    *,
    providers,
    universe_version: str,
    date_start: str,
    date_end: str,
    schema_version: str,
    transformation_version: str,
    corporate_action_version: str,
    feature_version: str,
) -> SnapshotIdentity:
    return SnapshotIdentity(
        providers=tuple(providers),
        universe_version=universe_version,
        date_start=date_start,
        date_end=date_end,
        schema_version=schema_version,
        transformation_version=transformation_version,
        corporate_action_version=corporate_action_version,
        feature_version=feature_version,
    )
