"""
Phase 3S — Immutable data snapshot & universe control (spec §10, §11).

Every experiment must use an IMMUTABLE dataset snapshot — never `latest` or
`current` (spec §10). The snapshot identity REUSES the Phase 3Q
`data_reliability.snapshot.SnapshotIdentity` (deterministic fingerprint) and adds
the research-facing universe-construction contract (spec §11): experiments must
declare their universe, construction rule, effective date, historical eligibility,
liquidity filter, and F&O eligibility. No experiment may silently use today's
universe for historical research.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional

from src.data_reliability.snapshot import SnapshotIdentity, compute_snapshot_identity


class DataSnapshotError(ValueError):
    """Raised when a snapshot is not immutable / references a mutable source."""


# Reserved dataset ids that indicate a MUTABLE source — forbidden (spec §10).
_MUTABLE_TOKENS = {"latest", "current", "live", "today", "now", ""}


class UniverseConstruction(str, Enum):
    """How the universe is constructed (spec §11)."""
    STATIC_LIST        = "STATIC_LIST"
    INDEX_MEMBERSHIP   = "INDEX_MEMBERSHIP"     # point-in-time index membership
    LIQUIDITY_RANK     = "LIQUIDITY_RANK"
    FNO_ELIGIBLE       = "FNO_ELIGIBLE"


@dataclass(frozen=True)
class Universe:
    """
    Explicit, point-in-time universe declaration (spec §11).

    `point_in_time` MUST be True for historical research: the universe must be as
    it was on `effective_date`, never today's membership applied retroactively
    (survivorship bias, spec §0 prohibitions).
    """
    universe_id:          str
    construction:         UniverseConstruction
    effective_date:       str                 # ISO date the membership is as-of
    point_in_time:        bool                # True => PIT membership (no survivorship bias)
    liquidity_filter:     str = ""            # e.g. "ADV>=1cr, price>=20"
    fno_eligible_only:    bool = False
    members:              tuple[str, ...] = ()

    def __post_init__(self):
        if not self.universe_id:
            raise DataSnapshotError("universe_id is required (spec §11).")
        if not self.effective_date:
            raise DataSnapshotError("universe.effective_date is required (spec §11).")

    def is_survivorship_safe(self) -> bool:
        """A universe is survivorship-safe only if it is point-in-time (§11, §0)."""
        return bool(self.point_in_time)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["construction"] = self.construction.value
        d["members"] = list(self.members)
        d["survivorship_safe"] = self.is_survivorship_safe()
        return d


@dataclass(frozen=True)
class ResearchDataSnapshot:
    """
    Immutable dataset snapshot for a research experiment (spec §10).

    Wraps the reproducible `SnapshotIdentity` (§10) and the `Universe` (§11). The
    `dataset_id` must reference an immutable artifact — a token like `latest` or
    `current` is rejected.
    """
    dataset_id:           str
    identity:             SnapshotIdentity
    universe:             Universe
    pit_universe:         bool = True         # PIT universe membership enforced
    label_version:        str = ""

    def __post_init__(self):
        if str(self.dataset_id).strip().lower() in _MUTABLE_TOKENS:
            raise DataSnapshotError(
                f"dataset_id '{self.dataset_id}' references a MUTABLE source — "
                f"research requires an immutable snapshot (spec §10).")
        if not self.pit_universe or not self.universe.point_in_time:
            # Historical research against a non-PIT universe is survivorship-biased.
            raise DataSnapshotError(
                "snapshot requires a point-in-time universe (pit_universe and "
                "universe.point_in_time must both be True) — otherwise it is "
                "survivorship-biased (spec §11, §0).")

    @property
    def snapshot_hash(self) -> str:
        """Deterministic snapshot fingerprint (spec §10, §44)."""
        return self.identity.fingerprint()

    def matches(self, other: "ResearchDataSnapshot") -> bool:
        return (self.dataset_id == other.dataset_id
                and self.identity.matches(other.identity)
                and self.universe.universe_id == other.universe.universe_id)

    def to_dict(self) -> dict:
        return {
            "dataset_id":    self.dataset_id,
            "snapshot_hash": self.snapshot_hash,
            "identity":      self.identity.to_dict(),
            "universe":      self.universe.to_dict(),
            "pit_universe":  self.pit_universe,
            "label_version": self.label_version,
        }


def build_research_snapshot(
    *,
    dataset_id: str,
    providers,
    universe: Universe,
    date_start: str,
    date_end: str,
    schema_version: str,
    transformation_version: str,
    corporate_action_version: str,
    feature_version: str,
    label_version: str = "",
) -> ResearchDataSnapshot:
    """Convenience constructor: compute the SnapshotIdentity and wrap it (spec §10)."""
    identity = compute_snapshot_identity(
        providers=providers,
        universe_version=universe.universe_id,
        date_start=date_start,
        date_end=date_end,
        schema_version=schema_version,
        transformation_version=transformation_version,
        corporate_action_version=corporate_action_version,
        feature_version=feature_version,
    )
    return ResearchDataSnapshot(
        dataset_id=dataset_id,
        identity=identity,
        universe=universe,
        pit_universe=universe.point_in_time,
        label_version=label_version,
    )
