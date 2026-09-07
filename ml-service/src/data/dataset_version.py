"""
Dataset Versioning and Snapshot — AlphaForge ML Service.

Every training dataset must be reproducible.  Given the same:
  - dataset_version
  - source versions
  - code commit

the exact same dataset should be produced deterministically.

DatasetSnapshot is the authoritative provenance record attached to every
.npz training artefact.  It extends the existing DatasetMetadata in
market_data_client.py with full lineage fields required by Phase 3B.

The snapshot is saved as a JSON sidecar alongside the .npz file.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import structlog

logger = structlog.get_logger(__name__)

UTC = timezone.utc

# ── Version constants (bump when semantics change) ─────────────────────────────

PIPELINE_VERSION = "v3.1"    # Phase 3B added PIT validation
FEATURE_VERSION  = "fv4"     # Phase 3A feature set
LABEL_VERSION    = "lv2"     # Phase 3C Label V2 (triple-barrier, event-based)
SCHEMA_VERSION   = "3b.0"    # DatasetSnapshot schema version


# ── DatasetSnapshot ────────────────────────────────────────────────────────────

@dataclass
class DatasetSnapshot:
    """
    Complete provenance snapshot for a training dataset artefact.

    Every .npz training file must have a companion DatasetSnapshot saved
    as <name>_snapshot.json.  This snapshot records:
      - What data was used
      - What versions produced it
      - What quality checks were applied
      - What limitations exist (DATA_UNAVAILABLE fields)
      - Whether the dataset is reproducible

    Fields
    ------
    dataset_id        : UUID for this generation run (unique per invocation).
    dataset_version   : Semantic version (pipeline+feature+label: "af-v3.1-fv4-lv1").
    schema_version    : Schema version of this snapshot format.
    created_at        : ISO-8601 UTC string when the snapshot was created.
    git_commit        : Git SHA at dataset creation time (or "unknown").
    pipeline_version  : data_pipeline.py version tag.
    feature_version   : features/engineer.py version tag.
    label_version     : Label generation version tag.
    source_fingerprint: SHA-256 of source_versions + pipeline + feature + label.
    universe_version  : Identifier for the historical universe used.
    instrument_master_version : Version of lot-size / instrument data.
    corporate_action_version  : Version of corporate action data ("unavailable" if absent).
    training_start    : ISO date string, first date in training window.
    training_end      : ISO date string, last date in training window.
    symbol_count      : Number of distinct symbols.
    row_count         : Total training rows in the .npz file.
    quality_status    : "CLEAN" | "HAS_WARNINGS" | "HAS_ERRORS" | "BLOCKED"
    quality_issues    : Count of WARNING-level quality issues.
    quality_errors    : Count of ERROR-level quality issues.
    pit_violations    : Count of point-in-time violations (must be 0 for CLEAN).
    limitations       : List of documented DATA_UNAVAILABLE or other limitations.
    source_versions   : Dict of source_identifier → version/checksum.
    is_reproducible   : True when the dataset can be exactly reproduced.
    reproducibility_notes: Explains why not reproducible (if False).
    """

    dataset_id:                str
    dataset_version:           str
    schema_version:            str
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
    quality_issues:            int = 0
    quality_errors:            int = 0
    pit_violations:            int = 0
    limitations:               list[str] = field(default_factory=list)
    source_versions:           dict[str, str] = field(default_factory=dict)
    is_reproducible:           bool = True
    reproducibility_notes:     str = ""

    # ── Phase 3C label provenance fields ─────────────────────────────────
    label_id:                  str = ""          # LABEL_REGISTRY key used
    label_config_hash:         str = ""          # LabelConfig.hash
    label_family:              str = ""          # LabelFamily value
    label_horizons:            list[int] = field(default_factory=list)
    barrier_pt_multiplier:     float = 0.0
    barrier_sl_multiplier:     float = 0.0
    price_basis:               str = "RAW"
    cost_model_version:        str = "DATA_UNAVAILABLE"
    n_events:                  int = 0           # total label events generated
    n_valid_labels:            int = 0           # non-incomplete, non-insufficient
    n_insufficient_events:     int = 0           # is_incomplete=True
    n_ambiguous_events:        int = 0           # intrabar_ambiguous=True
    label_tp_pct:              float | None = None
    label_sl_pct:              float | None = None
    label_time_pct:            float | None = None
    label_positive_rate:       float | None = None  # for classification labels
    event_overlap_fraction:    float | None = None

    def attach_label_diagnostics(self, diag: object) -> None:
        """
        Populate label provenance fields from a LabelDiagnostics object.
        Call this after generating labels to record their statistics.
        """
        try:
            self.label_family         = getattr(diag, "label_family", "")
            self.label_config_hash    = getattr(diag, "label_config_hash", "")
            self.label_version        = getattr(diag, "label_version", self.label_version)
            self.n_events             = getattr(diag, "sample_count", 0)
            self.n_insufficient_events = getattr(diag, "incomplete_count", 0)
            self.n_ambiguous_events   = getattr(diag, "ambiguous_count", 0)
            self.n_valid_labels       = self.n_events - self.n_insufficient_events

            tp_pct  = getattr(diag, "tp_pct", None)
            sl_pct  = getattr(diag, "sl_pct", None)
            t_pct   = getattr(diag, "time_pct", None)
            pos_cnt = getattr(diag, "positive_count", None)

            if tp_pct is not None:
                self.label_tp_pct   = tp_pct
                self.label_sl_pct   = sl_pct
                self.label_time_pct = t_pct
            if pos_cnt is not None and self.n_valid_labels > 0:
                self.label_positive_rate = round(pos_cnt / self.n_valid_labels, 4)
        except Exception:
            pass  # Non-blocking — provenance fields stay at defaults

    # ── Serialization ────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    def save(self, path: Path) -> Path:
        """
        Save snapshot as JSON to path.

        Historical snapshots are NEVER overwritten — if path exists a
        timestamped suffix is appended.
        """
        path = Path(path)
        if path.exists():
            ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            path = path.with_stem(f"{path.stem}_{ts}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.to_json(), encoding="utf-8")
        logger.info("dataset_snapshot_saved", path=str(path), dataset_id=self.dataset_id)
        return path

    @classmethod
    def load(cls, path: Path) -> "DatasetSnapshot":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(**data)

    # ── Factory ──────────────────────────────────────────────────────────

    @classmethod
    def create(
        cls,
        *,
        dataset_version: Optional[str] = None,
        training_start: str,
        training_end: str,
        symbol_count: int,
        row_count: int,
        source_versions: Optional[dict[str, str]] = None,
        universe_version: str = "static-v1",
        instrument_master_version: str = "best-known-v1",
        corporate_action_version: str = "DATA_UNAVAILABLE",
        quality_status: str = "CLEAN",
        quality_issues: int = 0,
        quality_errors: int = 0,
        pit_violations: int = 0,
        limitations: Optional[list[str]] = None,
        is_reproducible: bool = True,
        reproducibility_notes: str = "",
    ) -> "DatasetSnapshot":
        """
        Create a new DatasetSnapshot with auto-generated IDs and fingerprint.

        Automatically captures the git commit via subprocess.
        """
        sv = source_versions or {}
        fp = _compute_fingerprint(sv)
        dv = dataset_version or f"af-{PIPELINE_VERSION}-{FEATURE_VERSION}-{LABEL_VERSION}"

        return cls(
            dataset_id=str(uuid.uuid4()),
            dataset_version=dv,
            schema_version=SCHEMA_VERSION,
            created_at=datetime.now(UTC).isoformat(),
            git_commit=_get_git_commit(),
            pipeline_version=PIPELINE_VERSION,
            feature_version=FEATURE_VERSION,
            label_version=LABEL_VERSION,
            source_fingerprint=fp,
            universe_version=universe_version,
            instrument_master_version=instrument_master_version,
            corporate_action_version=corporate_action_version,
            training_start=training_start,
            training_end=training_end,
            symbol_count=symbol_count,
            row_count=row_count,
            quality_status=quality_status,
            quality_issues=quality_issues,
            quality_errors=quality_errors,
            pit_violations=pit_violations,
            limitations=limitations or _default_limitations(),
            source_versions=sv,
            is_reproducible=is_reproducible,
            reproducibility_notes=reproducibility_notes,
        )


# ── DatasetVersionRegistry ─────────────────────────────────────────────────────

class DatasetVersionRegistry:
    """
    Registry of all dataset snapshots created in a training run.

    Persists to a JSONL file where each line is one snapshot.
    Supports lookup by dataset_id, version, or date range.
    """

    def __init__(self, registry_path: Optional[Path] = None) -> None:
        self._records: list[DatasetSnapshot] = []
        self._path = registry_path

    def register(self, snapshot: DatasetSnapshot) -> None:
        """Register a new snapshot.  Append to file if path is set."""
        self._records.append(snapshot)
        if self._path:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._path, "a", encoding="utf-8") as fh:
                # Single line JSON — indent=None with separators ensures no whitespace
                fh.write(json.dumps(snapshot.to_dict(), separators=(",", ":")) + "\n")
        logger.info(
            "dataset_registered",
            dataset_id=snapshot.dataset_id,
            version=snapshot.dataset_version,
            rows=snapshot.row_count,
            status=snapshot.quality_status,
        )

    def get_by_id(self, dataset_id: str) -> Optional[DatasetSnapshot]:
        for r in reversed(self._records):
            if r.dataset_id == dataset_id:
                return r
        return None

    def get_latest(self) -> Optional[DatasetSnapshot]:
        return self._records[-1] if self._records else None

    def list_all(self) -> list[DatasetSnapshot]:
        return list(self._records)

    @classmethod
    def load_from_file(cls, path: Path) -> "DatasetVersionRegistry":
        reg = cls(registry_path=path)
        if not path.exists():
            return reg
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                reg._records.append(DatasetSnapshot(**json.loads(line)))
            except Exception as exc:
                logger.warning("registry_line_parse_error", error=str(exc))
        return reg


# ── Helpers ────────────────────────────────────────────────────────────────────

def _compute_fingerprint(source_versions: dict[str, str]) -> str:
    key = {
        "sources":   dict(sorted(source_versions.items())),
        "pipeline":  PIPELINE_VERSION,
        "features":  FEATURE_VERSION,
        "labels":    LABEL_VERSION,
    }
    return hashlib.sha256(
        json.dumps(key, sort_keys=True).encode()
    ).hexdigest()[:16]


def _get_git_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def _default_limitations() -> list[str]:
    """
    Default limitations that apply to every dataset until resolved.
    These are documented honestly rather than silently ignored.
    """
    return [
        "UNIVERSE_SURVIVORSHIP_BIAS: TRAINING_UNIVERSE is today's F&O list; "
        "historical eligibility data is DATA_UNAVAILABLE.",

        "CORPORATE_ACTION_UNADJUSTED: Raw prices used; historical corporate-action "
        "adjustment data is DATA_UNAVAILABLE.",

        "FO_BAN_HISTORY_UNAVAILABLE: Historical MWPL ban state per date is "
        "DATA_UNAVAILABLE; banned observations are not filtered from historical data.",

        "TRANSACTION_COSTS_EXCLUDED: Labels are gross returns; NSE STT, "
        "brokerage, exchange charges are not deducted.",
    ]
