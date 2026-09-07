"""
Phase 3O — Multi-session evidence store, tiers, official/diagnostic separation,
contamination handling, and experiment registry (spec §9, §47, §48, §49–§52).

  §9   distinguish single-session / multi-session-aggregate / regime-specific.
  §47  evidence tiers E0–E5 — never claim a higher tier than actually satisfied.
  §48  once a session contributes to OFFICIAL evidence its versions freeze;
       incompatible sessions are not combined into one performance series.
  §51  OFFICIAL / DIAGNOSTIC / FAILED / INVALID / SYNTHETIC separation — only
       OFFICIAL influences the final readiness decision.
  §52  contamination (future data / unclassified synthetic / post-hoc change /
       missing provenance / unknown config) → INVALID_EVIDENCE (never deleted).
  §49  experiment registry; §50 experiment types.

Reuses `paper.DataTag` (real vs synthetic tagging) and `lifecycle._storage`.
Import-clean; stdlib only.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

UTC = timezone.utc


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# §47 Evidence tiers
# ══════════════════════════════════════════════════════════════════════════════

class EvidenceTier(str, Enum):
    E0 = "E0"   # no evidence
    E1 = "E1"   # unit / synthetic evidence
    E2 = "E2"   # historical replay
    E3 = "E3"   # OOS historical evidence
    E4 = "E4"   # paper evidence (real market)
    E5 = "E5"   # repeated multi-regime paper evidence


_TIER_ORDER = {t: i for i, t in enumerate(
    [EvidenceTier.E0, EvidenceTier.E1, EvidenceTier.E2,
     EvidenceTier.E3, EvidenceTier.E4, EvidenceTier.E5])}


def tier_rank(t: EvidenceTier) -> int:
    return _TIER_ORDER[t]


# ══════════════════════════════════════════════════════════════════════════════
# §51/§52 Evidence classification
# ══════════════════════════════════════════════════════════════════════════════

class EvidenceClass(str, Enum):
    OFFICIAL   = "OFFICIAL"     # only this influences the readiness decision
    DIAGNOSTIC = "DIAGNOSTIC"
    FAILED     = "FAILED"
    INVALID    = "INVALID"      # contaminated (§52) — kept, never counted
    SYNTHETIC  = "SYNTHETIC"


class ContaminationReason(str, Enum):
    FUTURE_DATA               = "FUTURE_DATA"
    UNCLASSIFIED_SYNTHETIC    = "UNCLASSIFIED_SYNTHETIC"
    POST_HOC_MODEL_CHANGE     = "POST_HOC_MODEL_CHANGE"
    POST_HOC_THRESHOLD_CHANGE = "POST_HOC_THRESHOLD_CHANGE"
    MISSING_PROVENANCE        = "MISSING_PROVENANCE"
    UNKNOWN_CONFIGURATION     = "UNKNOWN_CONFIGURATION"
    UNKNOWN_EXECUTION         = "UNKNOWN_EXECUTION_ASSUMPTIONS"


@dataclass
class SessionEvidence:
    """
    One paper session's contribution to the evidence corpus. `data_tag`,
    `provenance_complete`, and `contamination` decide its class deterministically.
    """
    paper_session_id:   str
    market_date:        str
    data_tag:           str = "SYNTHETIC_DATA"    # paper.DataTag value
    provenance_complete: bool = False
    reconciled:         bool = False
    regime:             Optional[str] = None
    replay_id:          str = ""
    config_frozen:      bool = False
    contamination:      list[str] = field(default_factory=list)   # ContaminationReason values
    metrics:            dict = field(default_factory=dict)
    created_at:         str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now_iso()

    @property
    def evidence_class(self) -> EvidenceClass:
        """Deterministic classification (spec §51, §52). Contamination dominates."""
        if self.contamination:
            return EvidenceClass.INVALID
        if self.data_tag != "REAL_MARKET_DATA":
            return EvidenceClass.SYNTHETIC
        if not self.reconciled:
            return EvidenceClass.FAILED
        if not self.provenance_complete:
            return EvidenceClass.DIAGNOSTIC
        return EvidenceClass.OFFICIAL

    @property
    def tier(self) -> EvidenceTier:
        """Evidence tier this session can support (spec §47) — never over-claim."""
        cls = self.evidence_class
        if cls == EvidenceClass.INVALID:
            return EvidenceTier.E0
        if cls == EvidenceClass.SYNTHETIC:
            return EvidenceTier.E1
        if cls in (EvidenceClass.FAILED, EvidenceClass.DIAGNOSTIC):
            # real data but not reconciled/complete → at most replay-grade.
            return EvidenceTier.E2
        return EvidenceTier.E4   # a single OFFICIAL paper session = E4 (E5 needs many/multi-regime)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["evidence_class"] = self.evidence_class.value
        d["tier"] = self.tier.value
        return d


# ══════════════════════════════════════════════════════════════════════════════
# §9 Multi-session store
# ══════════════════════════════════════════════════════════════════════════════

class MultiSessionStore:
    """
    Accumulates SessionEvidence across sessions, append-only and immutable. Never
    combines incompatible (different replay_id) sessions into one OFFICIAL series
    (spec §48). Distinguishes single / multi-aggregate / regime-specific views (§9).
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "evidence_corpus.jsonl"

    def add(self, ev: SessionEvidence) -> SessionEvidence:
        from src.lifecycle._storage import append_jsonl
        append_jsonl(self.path, ev.to_dict())
        return ev

    def all(self) -> list[dict]:
        from src.lifecycle._storage import read_jsonl
        return read_jsonl(self.path)

    def official(self) -> list[dict]:
        return [e for e in self.all() if e.get("evidence_class") == EvidenceClass.OFFICIAL.value]

    def by_class(self) -> dict:
        counts: dict = {c.value: 0 for c in EvidenceClass}
        for e in self.all():
            c = e.get("evidence_class")
            if c in counts:
                counts[c] += 1
        return counts

    def official_series(self) -> dict:
        """
        Build the OFFICIAL performance series (spec §48): group official sessions
        by `replay_id` so incompatible configurations are never merged. Returns
        {replay_id: [session dicts]} plus whether a single homogeneous series exists.
        """
        groups: dict[str, list[dict]] = {}
        for e in self.official():
            groups.setdefault(e.get("replay_id", ""), []).append(e)
        return {
            "series": groups,
            "n_series": len(groups),
            "homogeneous": len(groups) <= 1,
            "n_official_sessions": sum(len(v) for v in groups.values()),
        }

    def aggregate_tier(self) -> EvidenceTier:
        """
        Highest defensible tier across the corpus (spec §47). E5 requires MANY
        official sessions across MULTIPLE regimes; a single official session is E4.
        """
        official = self.official()
        if not official:
            # fall back to the best synthetic/replay tier present
            tiers = [EvidenceTier(e.get("tier", "E0")) for e in self.all()]
            return max(tiers, key=tier_rank) if tiers else EvidenceTier.E0
        regimes = {e.get("regime") for e in official if e.get("regime")}
        if len(official) >= 5 and len(regimes) >= 2:
            return EvidenceTier.E5
        return EvidenceTier.E4


# ══════════════════════════════════════════════════════════════════════════════
# §49/§50 Experiment registry
# ══════════════════════════════════════════════════════════════════════════════

class ExperimentType(str, Enum):
    BASELINE            = "BASELINE"
    FULL_SYSTEM         = "FULL_SYSTEM"
    ABLATION            = "ABLATION"
    RL_COMPARISON       = "RL_COMPARISON"
    REGIME_ANALYSIS     = "REGIME_ANALYSIS"
    PROVIDER_RELIABILITY = "PROVIDER_RELIABILITY"
    STRESS_TEST         = "STRESS_TEST"


class ExperimentStatus(str, Enum):
    REGISTERED = "REGISTERED"
    RUNNING    = "RUNNING"
    COMPLETED  = "COMPLETED"
    INVALID    = "INVALID"


@dataclass
class Experiment:
    experiment_id:    str
    experiment_type:  str                     # ExperimentType value
    hypothesis:       str = ""
    paper_session_ids: list[str] = field(default_factory=list)
    configuration:    dict = field(default_factory=dict)
    model_versions:   list[str] = field(default_factory=list)
    data_versions:    list[str] = field(default_factory=list)
    metrics:          dict = field(default_factory=dict)
    status:           str = ExperimentStatus.REGISTERED.value
    evidence_level:   str = EvidenceTier.E0.value
    created_at:       str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _now_iso()

    def to_dict(self) -> dict:
        return asdict(self)


class ExperimentRegistry:
    """Append-only registry of paper experiments (spec §49). Never overwrites."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "experiments.jsonl"

    def register(self, exp: Experiment) -> Experiment:
        from src.lifecycle._storage import append_jsonl
        append_jsonl(self.path, {"event": "REGISTER", **exp.to_dict()})
        return exp

    def update_status(self, experiment_id: str, status: ExperimentStatus,
                      evidence_level: Optional[EvidenceTier] = None,
                      metrics: Optional[dict] = None) -> None:
        """Status change is a NEW append event (never mutates the original)."""
        from src.lifecycle._storage import append_jsonl
        rec = {"event": "UPDATE", "experiment_id": experiment_id,
               "status": status.value, "timestamp": _now_iso()}
        if evidence_level is not None:
            rec["evidence_level"] = evidence_level.value
        if metrics is not None:
            rec["metrics"] = metrics
        append_jsonl(self.path, rec)

    def all(self) -> list[dict]:
        from src.lifecycle._storage import read_jsonl
        return read_jsonl(self.path)

    def current(self, experiment_id: str) -> Optional[dict]:
        """Fold the append-only log into the current state of one experiment."""
        state: Optional[dict] = None
        for rec in self.all():
            if rec.get("experiment_id") != experiment_id:
                continue
            if rec.get("event") == "REGISTER":
                state = {k: v for k, v in rec.items() if k != "event"}
            elif rec.get("event") == "UPDATE" and state is not None:
                for k in ("status", "evidence_level", "metrics"):
                    if k in rec:
                        state[k] = rec[k]
        return state
