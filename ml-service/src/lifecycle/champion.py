"""
Phase 3J — Scoped Champion Index.

Maps a model scope to its current champion and maintains full champion history.

Design rules
------------
1. There is NO single universal champion. Champions are SCOPED (spec §10, §11):
   scope = (asset_class, market, horizon, strategy_family, ...).
2. Promotion is ATOMIC (spec §35): the champion pointer changes only with a
   corresponding audit record, using the cross-process lock.
3. Full champion history is retained; historical champion lookup answers
   "who was champion at time T?" (spec §53).
4. Rollback restores the previous champion without modifying its artifact
   (spec §36).
5. "latest" is never a valid reference — the champion pointer is explicit.
6. No np.random.* — deterministic.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ._storage import FileLock, append_jsonl, atomic_write_json, read_json, read_jsonl

UTC = timezone.utc


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class ChampionEntry:
    """Current champion pointer for one scope."""
    scope:                str
    champion_full_key:    str            # model_id@model_version
    promoted_at:          str
    previous_champion:    Optional[str]
    promotion_reason:     str
    evidence_package_id:  str
    promotion_id:         str = ""


@dataclass
class ChampionHistoryEntry:
    """One historical champion record (append-only)."""
    scope:                str
    champion_full_key:    str
    promoted_at:          str
    retired_at:           Optional[str]
    previous_champion:    Optional[str]
    promotion_reason:     str
    retirement_reason:    str
    evidence_package_id:  str
    promotion_id:         str


class ChampionError(RuntimeError):
    pass


class ChampionIndex:
    """
    Scoped champion index with history and historical lookup.

    Layout under `root`:
        root/
        ├── champions/<scope>.json       — current champion pointer per scope
        ├── champion_history.jsonl       — append-only history
        └── .champion.lock               — cross-process lock
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.champions_dir = self.root / "champions"
        self.history_path = self.root / "champion_history.jsonl"
        self.lock_path = self.root / ".champion.lock"
        self.champions_dir.mkdir(parents=True, exist_ok=True)

    def _scope_path(self, scope: str) -> Path:
        safe = scope.replace("/", "-").replace(" ", "_")
        return self.champions_dir / f"{safe}.json"

    # ── Current champion ────────────────────────────────────────────────────

    def get_champion(self, scope: str) -> Optional[ChampionEntry]:
        data = read_json(self._scope_path(scope))
        return ChampionEntry(**data) if data is not None else None

    def has_champion(self, scope: str) -> bool:
        return self._scope_path(scope).exists()

    def list_scopes(self) -> list[str]:
        return [p.stem for p in sorted(self.champions_dir.glob("*.json"))]

    # ── Atomic promotion ────────────────────────────────────────────────────

    def promote(
        self,
        scope: str,
        champion_full_key: str,
        promotion_reason: str,
        evidence_package_id: str,
        promotion_id: str = "",
        actor: str = "system",
    ) -> ChampionEntry:
        """
        Atomically set the champion for a scope (spec §35).

        The previous champion is recorded and its history entry is closed
        (retired_at set). The new champion pointer is written atomically.
        """
        with FileLock(self.lock_path):
            prev = read_json(self._scope_path(scope))
            prev_key = prev["champion_full_key"] if prev else None

            # Close out the previous champion's history entry
            if prev_key is not None:
                self._close_history(scope, prev_key, "SUPERSEDED")

            entry = ChampionEntry(
                scope=scope,
                champion_full_key=champion_full_key,
                promoted_at=_now(),
                previous_champion=prev_key,
                promotion_reason=promotion_reason,
                evidence_package_id=evidence_package_id,
                promotion_id=promotion_id,
            )
            atomic_write_json(self._scope_path(scope), asdict(entry))

            # Append to history (append-only)
            append_jsonl(self.history_path, asdict(ChampionHistoryEntry(
                scope=scope,
                champion_full_key=champion_full_key,
                promoted_at=entry.promoted_at,
                retired_at=None,
                previous_champion=prev_key,
                promotion_reason=promotion_reason,
                retirement_reason="",
                evidence_package_id=evidence_package_id,
                promotion_id=promotion_id,
            )))
            return entry

    def rollback(
        self,
        scope: str,
        rollback_reason: str,
        actor: str = "system",
    ) -> Optional[ChampionEntry]:
        """
        Roll back to the previous champion for a scope (spec §36).

        Restores the previous champion pointer WITHOUT modifying any artifact.
        Returns the restored champion entry, or None if there is no previous
        champion (in which case the scope is left with NO champion — a valid,
        preferred state over an inadequate champion).
        """
        with FileLock(self.lock_path):
            current = read_json(self._scope_path(scope))
            if current is None:
                raise ChampionError(f"No champion to roll back for scope {scope!r}.")

            failed_key = current["champion_full_key"]
            prev_key = current.get("previous_champion")

            # Close the failed champion's history
            self._close_history(scope, failed_key, f"ROLLED_BACK: {rollback_reason}")

            if prev_key is None:
                # No previous champion → remove the pointer (no champion)
                self._scope_path(scope).unlink(missing_ok=True)
                append_jsonl(self.history_path, {
                    "scope": scope, "event": "ROLLBACK_TO_NONE",
                    "failed_champion": failed_key, "previous_champion": None,
                    "rollback_reason": rollback_reason, "rollback_time": _now(),
                    "initiated_by": actor,
                })
                return None

            # Restore the previous champion
            # Look up the previous champion's promotion details from history
            prev_details = self._latest_history_for(scope, prev_key)
            restored = ChampionEntry(
                scope=scope,
                champion_full_key=prev_key,
                promoted_at=_now(),
                previous_champion=None,   # restored; no chain beyond
                promotion_reason=f"ROLLBACK restoration: {rollback_reason}",
                evidence_package_id=prev_details.get("evidence_package_id", "") if prev_details else "",
                promotion_id=prev_details.get("promotion_id", "") if prev_details else "",
            )
            atomic_write_json(self._scope_path(scope), asdict(restored))

            append_jsonl(self.history_path, {
                "scope": scope, "event": "ROLLBACK",
                "failed_champion": failed_key, "restored_champion": prev_key,
                "rollback_reason": rollback_reason, "rollback_time": _now(),
                "initiated_by": actor,
            })
            # Re-open the restored champion's history entry
            append_jsonl(self.history_path, asdict(ChampionHistoryEntry(
                scope=scope,
                champion_full_key=prev_key,
                promoted_at=restored.promoted_at,
                retired_at=None,
                previous_champion=None,
                promotion_reason=restored.promotion_reason,
                retirement_reason="",
                evidence_package_id=restored.evidence_package_id,
                promotion_id=restored.promotion_id,
            )))
            return restored

    # ── History ────────────────────────────────────────────────────────────

    def history(self, scope: Optional[str] = None) -> list[dict]:
        """Return the full champion history, optionally filtered by scope."""
        records = read_jsonl(self.history_path)
        if scope is None:
            return records
        return [r for r in records if r.get("scope") == scope]

    def champion_at(self, scope: str, timestamp: str) -> Optional[str]:
        """
        Historical champion lookup (spec §53): which model was champion for
        `scope` at ISO timestamp `timestamp`?

        Returns the champion_full_key, or None if no champion at that time.
        """
        records = [
            r for r in read_jsonl(self.history_path)
            if r.get("scope") == scope and "champion_full_key" in r and r.get("promoted_at")
        ]
        # Sort by promoted_at ascending
        records.sort(key=lambda r: r["promoted_at"])
        champion = None
        for r in records:
            if r["promoted_at"] <= timestamp:
                retired = r.get("retired_at")
                if retired is None or retired > timestamp:
                    champion = r["champion_full_key"]
                elif retired <= timestamp:
                    # This champion was retired before the query time
                    if champion == r["champion_full_key"]:
                        champion = None
            else:
                break
        return champion

    # ── Internal ──────────────────────────────────────────────────────────────

    def _close_history(self, scope: str, full_key: str, retirement_reason: str) -> None:
        """
        Append a retirement marker for the given champion.
        (History is append-only JSONL; we append a retirement event that
        champion_at() interprets.)
        """
        append_jsonl(self.history_path, {
            "scope": scope, "champion_full_key": full_key,
            "event": "RETIRE_MARKER", "retired_at": _now(),
            "retirement_reason": retirement_reason,
        })

    def _latest_history_for(self, scope: str, full_key: str) -> Optional[dict]:
        records = [
            r for r in read_jsonl(self.history_path)
            if r.get("scope") == scope and r.get("champion_full_key") == full_key
            and r.get("promotion_reason") is not None and r.get("promoted_at")
        ]
        return records[-1] if records else None
