"""
Phase 3M — Single canonical decision contract (spec §4).

`CanonicalDecision` is the ONE structure every final decision carries. It
preserves point-in-time correctness, full provenance, model/dataset/feature/
label/calibration/portfolio/execution/RL identity, timestamp, regime, decision
state, and evidence state — so any decision is replayable later.

Semantic invariants (spec §4) — NEVER conflate:
    alpha_score        != probability
    probability        != expected_return
    expected_return    != expected_value
    decision           != prediction

Determinism: pure stdlib; no np.random.*.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .state import DecisionState, is_executable

UTC = timezone.utc


def new_decision_id(prefix: str = "dec") -> str:
    """Deterministic-per-content decision id is set by the pipeline; this is a
    fallback uuid-free id for ad-hoc construction."""
    import uuid
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


@dataclass
class CanonicalDecision:
    """
    The canonical decision record (spec §4). Every field is explicit; there is
    no semantic ambiguity between score / probability / return / value.
    """
    # ── identity / timing ────────────────────────────────────────────────
    decision_id:            str
    decision_timestamp:     str                    # ISO-8601 UTC (as-of time)
    instrument:             str
    instrument_type:        str = ""
    market:                 str = "NSE"
    timeframe:              str = "1D"

    # ── data / feature identity ──────────────────────────────────────────
    data_snapshot_id:       str = ""
    dataset_version:        str = ""
    feature_version:        str = ""
    feature_schema_hash:    str = ""

    # ── V8 canonical data provenance ─────────────────────────────────────
    # Every ML decision must reference the canonical data snapshot it consumed.
    # ABSOLUTE RULE: ML service must NEVER fetch raw broker data directly.
    # Flow: provider → canonical data → validated snapshot → features → ML
    # 3m is permanently out of scope — any decision with timeframe="3m" is INVALID.
    data_provenance_type:   Optional[str] = None   # BROKER_AUTHENTICATED | OPEN_SOURCE_NSE_DERIVED | YAHOO_FALLBACK | UNKNOWN
    data_trust_status:      Optional[str] = None   # VERIFIED_RECONCILED | VERIFIED_SINGLE_SOURCE | DEGRADED | UNVERIFIED | INVALID
    data_quality_score:     Optional[float] = None # [0-100] deterministic score from quality engine
    data_authenticated:     Optional[bool] = None  # True if broker-authenticated source
    snapshot_timestamp:     Optional[str] = None   # UTC ISO-8601 of the data snapshot used

    # ── regime ───────────────────────────────────────────────────────────
    market_regime:          Optional[str] = None
    regime_confidence:      Optional[float] = None

    # ── alpha (NOT a probability) ─────────────────────────────────────────
    alpha_score:            Optional[float] = None
    alpha_rank:             Optional[int] = None
    alpha_rank_percentile:  Optional[float] = None

    # ── strategy / direction ─────────────────────────────────────────────
    strategy:               Optional[str] = None
    direction:              Optional[str] = None    # LONG | SHORT | FLAT

    # ── probability (raw vs calibrated — NOT interchangeable) ────────────
    raw_probability:        Optional[float] = None
    calibrated_probability: Optional[float] = None

    # ── expected value decomposition (NOT the same as return) ────────────
    expected_win:           Optional[float] = None
    expected_loss:          Optional[float] = None
    expected_cost:          Optional[float] = None
    expected_value:         Optional[float] = None

    # ── meta / abstention ────────────────────────────────────────────────
    meta_label:             Optional[str] = None    # BUY | SELL | WAIT | NO_TRADE
    abstention_state:       Optional[str] = None
    abstention_reason:      list[str] = field(default_factory=list)

    # ── portfolio / risk ─────────────────────────────────────────────────
    portfolio_target:       Optional[float] = None
    risk_budget:            Optional[float] = None
    position_size:          Optional[float] = None

    # ── execution ────────────────────────────────────────────────────────
    execution_policy:       Optional[str] = None
    execution_policy_version: Optional[str] = None

    # ── RL challenger ────────────────────────────────────────────────────
    rl_policy_id:           Optional[str] = None
    rl_policy_version:      Optional[str] = None
    rl_action:              Optional[str] = None
    rl_action_allowed:      Optional[bool] = None

    # ── decision state ───────────────────────────────────────────────────
    decision_state:         str = DecisionState.CANDIDATE.value

    # ── model identity ───────────────────────────────────────────────────
    model_ids:              list[str] = field(default_factory=list)
    model_versions:         list[str] = field(default_factory=list)
    model_hashes:           list[str] = field(default_factory=list)

    # ── provenance / evidence ────────────────────────────────────────────
    provenance_id:          str = ""
    prediction_provenance:  Optional[str] = None    # trained_model|heuristic|...
    deployment_mode:        str = "shadow"
    evidence_level:         Optional[str] = None

    # ── observability ────────────────────────────────────────────────────
    trace_id:               str = ""
    latency_breakdown_ms:   dict = field(default_factory=dict)

    created_at:             str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(UTC).isoformat()
        # V8: 3m is permanently out of scope — reject at construction time
        if self.timeframe and str(self.timeframe).lower() in ("3m", "3min", "3-minute"):
            raise ValueError(
                f"CanonicalDecision: timeframe '{self.timeframe}' is permanently removed "
                "from AlphaForge (V8 refactor/signals). No ML decisions are generated "
                "for 3m data. Supported timeframes: 1m 5m 10m 15m 30m 1h 1d 1w 1M"
            )

    # ── state helpers ────────────────────────────────────────────────────

    @property
    def state(self) -> DecisionState:
        return DecisionState(self.decision_state)

    @property
    def executable(self) -> bool:
        return is_executable(self.state)

    def set_state(self, state: DecisionState) -> None:
        """
        Transition the decision to `state`, enforcing the fail-closed state
        machine. An illegal transition (e.g. CANDIDATE → COMPLETED without
        going through VALIDATED / EXECUTION_PLANNED) raises
        InvalidStateTransition — the state is never silently forced.
        A no-op (state unchanged) is always allowed.
        """
        from .state import is_valid_transition, InvalidStateTransition
        current = self.state
        if state == current:
            return
        if not is_valid_transition(current, state):
            raise InvalidStateTransition(
                f"illegal decision state transition {current.value} → {state.value}")
        self.decision_state = state.value

    # ── content hash (for replay identity) ───────────────────────────────

    def content_hash(self) -> str:
        """
        Deterministic hash of the decision-relevant content (excludes the
        volatile `created_at` and `latency_breakdown_ms`, which do not change
        the decision semantics). Used to verify deterministic replay.
        """
        d = self.to_dict()
        d.pop("created_at", None)
        d.pop("latency_breakdown_ms", None)
        d.pop("trace_id", None)
        raw = json.dumps(d, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CanonicalDecision":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})
