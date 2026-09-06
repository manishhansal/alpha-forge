"""
Phase 3J — Challenger Registry, Shadow & Paper Mode.

Tracks challengers, their shadow/paper soak periods, and selection-bias metadata.

Design rules
------------
1. Each challenger has an explicit status (spec §12).
2. Shadow mode (spec §38): a challenger generates predictions/decisions/targets
   but does NOT influence the champion portfolio. Shadow outputs are logged.
3. Paper mode (spec §39): the challenger is evaluated through simulated execution
   (Phase 3G), isolated from live execution.
4. Soak periods (spec §40) are configurable — no hardcoded numbers.
5. A degraded challenger is marked REJECTED/RETIRED but its evidence is NEVER
   deleted (spec §41).
6. Selection-bias tracking (spec §61): count tested / rejected / promoted.
7. No np.random.* — deterministic.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ._storage import FileLock, append_jsonl, atomic_write_json, read_json, read_jsonl
from .schemas import ChallengerStatus

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ── Soak configuration (configurable, spec §40) ───────────────────────────────

@dataclass
class SoakConfig:
    """Minimum shadow/paper soak requirements. All configurable — no hardcoding."""
    min_shadow_days:        int = 20
    min_shadow_observations: int = 200
    min_paper_days:         int = 20
    min_paper_trades:       int = 30
    version:                str = "soak-config-v1"


# ── Challenger record ──────────────────────────────────────────────────────────

@dataclass
class ChallengerRecord:
    """One challenger (spec §12)."""
    challenger_id:        str
    model_full_key:       str            # model_id@model_version
    scope:                str
    status:               str            # ChallengerStatus value
    created_at:           str
    evidence_package_id:  str = ""
    comparison_id:        str = ""

    # Soak tracking
    shadow_started_at:    Optional[str] = None
    shadow_ended_at:      Optional[str] = None
    shadow_observations:  int = 0
    paper_started_at:     Optional[str] = None
    paper_ended_at:       Optional[str] = None
    paper_trades:         int = 0

    status_history:       list[dict] = field(default_factory=list)
    notes:                str = ""


@dataclass
class ShadowOutput:
    """One logged shadow-mode prediction/decision (spec §38)."""
    challenger_id:        str
    timestamp:            str
    instrument_id:        str
    prediction:           Optional[float]
    decision:             str
    influenced_champion:  bool = False   # MUST always be False in shadow


class ChallengerError(RuntimeError):
    pass


class ChallengerRegistry:
    """
    Challenger registry with shadow/paper mode and selection-bias tracking.

    Layout under `root`:
        root/
        ├── challengers/<challenger_id>.json
        ├── shadow_log.jsonl              — logged shadow outputs
        ├── selection_bias.jsonl          — tested/rejected/promoted counters
        └── .challenger.lock
    """

    def __init__(self, root: str | Path, soak_config: Optional[SoakConfig] = None) -> None:
        self.root = Path(root)
        self.challengers_dir = self.root / "challengers"
        self.shadow_log_path = self.root / "shadow_log.jsonl"
        self.selection_bias_path = self.root / "selection_bias.jsonl"
        self.lock_path = self.root / ".challenger.lock"
        self.challengers_dir.mkdir(parents=True, exist_ok=True)
        self.soak = soak_config or SoakConfig()

    def _path(self, challenger_id: str) -> Path:
        safe = challenger_id.replace("/", "-")
        return self.challengers_dir / f"{safe}.json"

    # ── Registration ─────────────────────────────────────────────────────────

    def register(
        self,
        challenger_id: str,
        model_full_key: str,
        scope: str,
        evidence_package_id: str = "",
    ) -> ChallengerRecord:
        """Register a challenger (idempotent)."""
        with FileLock(self.lock_path):
            existing = read_json(self._path(challenger_id))
            if existing is not None:
                return ChallengerRecord(**existing)

            record = ChallengerRecord(
                challenger_id=challenger_id,
                model_full_key=model_full_key,
                scope=scope,
                status=ChallengerStatus.REGISTERED.value,
                created_at=_now(),
                evidence_package_id=evidence_package_id,
                status_history=[{
                    "timestamp": _now(), "from": None,
                    "to": ChallengerStatus.REGISTERED.value, "reason": "Registered",
                }],
            )
            atomic_write_json(self._path(challenger_id), asdict(record))
            self._record_tested(scope, challenger_id)
            return record

    def get(self, challenger_id: str) -> Optional[ChallengerRecord]:
        data = read_json(self._path(challenger_id))
        return ChallengerRecord(**data) if data is not None else None

    def list_challengers(self, scope: Optional[str] = None) -> list[ChallengerRecord]:
        out = []
        for p in sorted(self.challengers_dir.glob("*.json")):
            data = read_json(p)
            if data and (scope is None or data.get("scope") == scope):
                out.append(ChallengerRecord(**data))
        return out

    # ── Status transitions ─────────────────────────────────────────────────

    def _set_status(self, challenger_id: str, status: ChallengerStatus, reason: str) -> ChallengerRecord:
        data = read_json(self._path(challenger_id))
        if data is None:
            raise ChallengerError(f"Challenger {challenger_id} not found.")
        record = ChallengerRecord(**data)
        old = record.status
        record.status = status.value
        record.status_history.append({
            "timestamp": _now(), "from": old, "to": status.value, "reason": reason,
        })
        atomic_write_json(self._path(challenger_id), asdict(record))
        return record

    def start_shadow(self, challenger_id: str) -> ChallengerRecord:
        with FileLock(self.lock_path):
            record = self._set_status(challenger_id, ChallengerStatus.SHADOW, "Shadow started")
            record.shadow_started_at = _now()
            atomic_write_json(self._path(challenger_id), asdict(record))
            return record

    def log_shadow_output(self, output: ShadowOutput) -> None:
        """
        Log a shadow-mode output (spec §38).
        influenced_champion MUST be False — enforced here.
        """
        if output.influenced_champion:
            raise ChallengerError(
                "Shadow output must NOT influence the champion. "
                "influenced_champion must be False."
            )
        append_jsonl(self.shadow_log_path, asdict(output))
        with FileLock(self.lock_path):
            data = read_json(self._path(output.challenger_id))
            if data is not None:
                record = ChallengerRecord(**data)
                record.shadow_observations += 1
                atomic_write_json(self._path(output.challenger_id), asdict(record))

    def start_paper(self, challenger_id: str) -> ChallengerRecord:
        with FileLock(self.lock_path):
            record = self._set_status(challenger_id, ChallengerStatus.PAPER, "Paper started")
            record.shadow_ended_at = _now()
            record.paper_started_at = _now()
            atomic_write_json(self._path(challenger_id), asdict(record))
            return record

    def record_paper_trade(self, challenger_id: str) -> None:
        with FileLock(self.lock_path):
            data = read_json(self._path(challenger_id))
            if data is not None:
                record = ChallengerRecord(**data)
                record.paper_trades += 1
                atomic_write_json(self._path(challenger_id), asdict(record))

    def reject(self, challenger_id: str, reason: str) -> ChallengerRecord:
        """Reject a challenger. Evidence is retained (spec §41)."""
        with FileLock(self.lock_path):
            record = self._set_status(challenger_id, ChallengerStatus.REJECTED, reason)
            self._record_rejected(record.scope, challenger_id)
            return record

    def retire(self, challenger_id: str, reason: str) -> ChallengerRecord:
        with FileLock(self.lock_path):
            return self._set_status(challenger_id, ChallengerStatus.RETIRED, reason)

    def mark_promotion_eligible(self, challenger_id: str, reason: str = "Soak complete") -> ChallengerRecord:
        with FileLock(self.lock_path):
            return self._set_status(challenger_id, ChallengerStatus.PROMOTION_ELIGIBLE, reason)

    def mark_promoted(self, challenger_id: str) -> ChallengerRecord:
        with FileLock(self.lock_path):
            record = self._set_status(challenger_id, ChallengerStatus.PROMOTED, "Promoted to champion")
            self._record_promoted(record.scope, challenger_id)
            return record

    # ── Soak checks (spec §40) ──────────────────────────────────────────────

    def shadow_soak_complete(self, challenger_id: str) -> tuple[bool, str]:
        record = self.get(challenger_id)
        if record is None:
            return False, "Challenger not found."
        if record.shadow_started_at is None:
            return False, "Shadow not started."
        days = self._days_since(record.shadow_started_at)
        if days < self.soak.min_shadow_days:
            return False, f"Shadow {days:.1f}d < required {self.soak.min_shadow_days}d."
        if record.shadow_observations < self.soak.min_shadow_observations:
            return False, (
                f"Shadow observations {record.shadow_observations} < required "
                f"{self.soak.min_shadow_observations}."
            )
        return True, "Shadow soak complete."

    def paper_soak_complete(self, challenger_id: str) -> tuple[bool, str]:
        record = self.get(challenger_id)
        if record is None:
            return False, "Challenger not found."
        if record.paper_started_at is None:
            return False, "Paper not started."
        days = self._days_since(record.paper_started_at)
        if days < self.soak.min_paper_days:
            return False, f"Paper {days:.1f}d < required {self.soak.min_paper_days}d."
        if record.paper_trades < self.soak.min_paper_trades:
            return False, (
                f"Paper trades {record.paper_trades} < required "
                f"{self.soak.min_paper_trades}."
            )
        return True, "Paper soak complete."

    @staticmethod
    def _days_since(iso_ts: str) -> float:
        start = datetime.fromisoformat(iso_ts)
        if start.tzinfo is None:
            start = start.replace(tzinfo=UTC)
        return (datetime.now(UTC) - start).total_seconds() / 86400.0

    # ── Selection bias tracking (spec §61) ──────────────────────────────────

    def _record_tested(self, scope: str, challenger_id: str) -> None:
        append_jsonl(self.selection_bias_path, {
            "scope": scope, "challenger_id": challenger_id,
            "event": "TESTED", "timestamp": _now(),
        })

    def _record_rejected(self, scope: str, challenger_id: str) -> None:
        append_jsonl(self.selection_bias_path, {
            "scope": scope, "challenger_id": challenger_id,
            "event": "REJECTED", "timestamp": _now(),
        })

    def _record_promoted(self, scope: str, challenger_id: str) -> None:
        append_jsonl(self.selection_bias_path, {
            "scope": scope, "challenger_id": challenger_id,
            "event": "PROMOTED", "timestamp": _now(),
        })

    def selection_bias_summary(self, scope: Optional[str] = None) -> dict:
        """
        Return tested/rejected/promoted counts (spec §61).
        Multiple-testing awareness: reveals how many challengers were tested.
        """
        records = read_jsonl(self.selection_bias_path)
        if scope is not None:
            records = [r for r in records if r.get("scope") == scope]
        return {
            "scope":           scope or "ALL",
            "number_tested":   sum(1 for r in records if r["event"] == "TESTED"),
            "number_rejected": sum(1 for r in records if r["event"] == "REJECTED"),
            "number_promoted": sum(1 for r in records if r["event"] == "PROMOTED"),
        }
