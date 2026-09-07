"""
Phase 3O — Reliability layer (spec §53–§62): failure rate, provider reliability,
failover, recovery, reconciliation + accounting invariants, idempotency.

Principles enforced here:
  • Never fabricate uptime or availability — everything is OBSERVED from recorded
    events; absence of data → UNKNOWN / INSUFFICIENT_EVIDENCE (spec §55).
  • Failover and all-unavailable states must resolve to a SAFE outcome
    (safe fallback data OR NO_NEW_DECISIONS) and NEVER to corrupted data (§57).
  • Recovery from a mid-session restart must be deterministic OR fail-closed, and
    must never create duplicate exposure (§58).
  • The accounting identity is the hard invariant (§56):
        opening_equity + net_flows + realized_pnl + unrealized_pnl - costs
            == closing_equity   (within tolerance)
  • Idempotency: replaying the same decision/order/fill/reconcile/finalization
    event must not change state (§59).

Reuses src.shadow.ShadowLedger (append-only, idempotent order/fill recording) for
duplicate detection. Import-clean: stdlib only at module load.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional


# ══════════════════════════════════════════════════════════════════════════════
# §53 Failure tracking
# ══════════════════════════════════════════════════════════════════════════════

class FailureCategory(str, Enum):
    DATA           = "DATA"
    PROVIDER       = "PROVIDER"
    FEATURE        = "FEATURE"
    MODEL          = "MODEL"
    CALIBRATION    = "CALIBRATION"
    PORTFOLIO      = "PORTFOLIO"
    EXECUTION      = "EXECUTION"
    RL             = "RL"
    RECONCILIATION = "RECONCILIATION"


@dataclass
class FailureEvent:
    category:     str          # FailureCategory value
    timestamp:    str
    recovered:    bool = False
    recovery_seconds: Optional[float] = None
    detail:       str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class FailureTracker:
    """
    Accumulates failure events and derives failure/recovery statistics per
    category. `total_opportunities` is the denominator for rate; when it is not
    supplied the rate is None (never a guessed base).
    """

    def __init__(self):
        self._events: list[FailureEvent] = []

    def record(self, event: FailureEvent) -> None:
        self._events.append(event)

    def stats(self, category: Optional[FailureCategory] = None,
              total_opportunities: Optional[int] = None) -> dict:
        evs = [e for e in self._events
               if category is None or e.category == category.value]
        n = len(evs)
        recovered = [e for e in evs if e.recovered]
        rec_times = [e.recovery_seconds for e in recovered
                     if e.recovery_seconds is not None]
        return {
            "category": category.value if category else "ALL",
            "failure_count": n,
            "failure_rate": (n / total_opportunities)
                            if total_opportunities and total_opportunities > 0 else None,
            "recovery_count": len(recovered),
            "recovery_rate": (len(recovered) / n) if n > 0 else None,
            "mean_recovery_seconds": (sum(rec_times) / len(rec_times))
                                     if rec_times else None,
        }

    def by_category(self, total_opportunities: Optional[int] = None) -> dict:
        return {c.value: self.stats(c, total_opportunities) for c in FailureCategory}


# ══════════════════════════════════════════════════════════════════════════════
# §55 Provider reliability (observed only — never fabricated)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ProviderObservation:
    provider:   str
    available:  bool
    stale:      bool = False
    malformed:  bool = False
    mismatch:   bool = False       # cross-provider disagreement
    used_as_fallback: bool = False


class ProviderReliabilityTracker:
    """
    Derives OBSERVED provider reliability from recorded observations (spec §55).
    We report availability as observed_available / observed_total — we do not
    invent an SLA uptime figure. With zero observations everything is None.
    """

    def __init__(self):
        self._obs: list[ProviderObservation] = []

    def record(self, obs: ProviderObservation) -> None:
        self._obs.append(obs)

    def reliability(self, provider: str) -> dict:
        obs = [o for o in self._obs if o.provider == provider]
        n = len(obs)
        if n == 0:
            return {"provider": provider, "n_observations": 0,
                    "observed_availability": None, "stale_freq": None,
                    "malformed_freq": None, "mismatch_freq": None,
                    "fallback_freq": None,
                    "note": "no observations — availability UNKNOWN, not assumed"}
        return {"provider": provider, "n_observations": n,
                "observed_availability": sum(o.available for o in obs) / n,
                "stale_freq": sum(o.stale for o in obs) / n,
                "malformed_freq": sum(o.malformed for o in obs) / n,
                "mismatch_freq": sum(o.mismatch for o in obs) / n,
                "fallback_freq": sum(o.used_as_fallback for o in obs) / n}

    def all(self) -> dict:
        providers = sorted({o.provider for o in self._obs})
        return {p: self.reliability(p) for p in providers}


# ══════════════════════════════════════════════════════════════════════════════
# §57 Failover — must resolve safely, never corrupt
# ══════════════════════════════════════════════════════════════════════════════

class FailoverOutcome(str, Enum):
    PRIMARY_OK        = "PRIMARY_OK"
    FELL_BACK         = "FELL_BACK"           # used a healthy secondary
    NO_NEW_DECISIONS  = "NO_NEW_DECISIONS"    # all unavailable → safe halt
    CORRUPTED         = "CORRUPTED"           # MUST never be produced


class UnsafeFailover(RuntimeError):
    """Raised if failover logic would ever accept corrupted/stale/malformed data."""


def resolve_failover(chain_health: list[dict]) -> str:
    """
    Given an ordered provider chain with health flags, pick the safe outcome
    (spec §57). chain_health: [{"provider":..., "available":bool, "stale":bool,
    "malformed":bool}]. Returns PRIMARY_OK / FELL_BACK / NO_NEW_DECISIONS. It will
    NEVER return CORRUPTED — a stale/malformed provider is treated as unusable, and
    if nothing is usable the safe result is NO_NEW_DECISIONS.
    """
    for i, h in enumerate(chain_health):
        usable = h.get("available") and not h.get("stale") and not h.get("malformed")
        if usable:
            return FailoverOutcome.PRIMARY_OK.value if i == 0 else FailoverOutcome.FELL_BACK.value
    return FailoverOutcome.NO_NEW_DECISIONS.value


# ══════════════════════════════════════════════════════════════════════════════
# §58 Recovery — deterministic resume or fail-closed, no duplicate exposure
# ══════════════════════════════════════════════════════════════════════════════

class RecoveryPhase(str, Enum):
    INIT       = "INIT"
    DECISION   = "DECISION"
    ORDER      = "ORDER"
    FILL       = "FILL"
    POSITION   = "POSITION"
    RECONCILE  = "RECONCILE"


class RecoveryOutcome(str, Enum):
    RESUMED       = "RESUMED"        # deterministic resume from persisted state
    FAILED_CLOSED = "FAILED_CLOSED"  # could not resume safely → halt (no exposure)


def recovery_decision(phase: RecoveryPhase, persisted_state_present: bool,
                      would_duplicate_exposure: bool) -> str:
    """
    Decide recovery outcome after a restart in a given phase (spec §58). Resume
    ONLY if persisted state exists AND resuming would not duplicate exposure;
    otherwise fail closed. Never a silent partial resume.
    """
    if persisted_state_present and not would_duplicate_exposure:
        return RecoveryOutcome.RESUMED.value
    return RecoveryOutcome.FAILED_CLOSED.value


# ══════════════════════════════════════════════════════════════════════════════
# §56 Reconciliation + accounting invariants
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class AccountingLedger:
    """One session's equity movement. The invariant is checked, never assumed."""
    opening_equity: float
    net_flows:      float = 0.0     # deposits(+) / withdrawals(-)
    realized_pnl:   float = 0.0
    unrealized_pnl: float = 0.0
    costs:          float = 0.0     # brokerage + taxes + fees + slippage etc.
    closing_equity: float = 0.0

    @property
    def expected_closing(self) -> float:
        return (self.opening_equity + self.net_flows + self.realized_pnl
                + self.unrealized_pnl - self.costs)

    def residual(self) -> float:
        return self.closing_equity - self.expected_closing

    def reconciles(self, tolerance: float = 0.01) -> bool:
        return abs(self.residual()) <= tolerance

    def to_dict(self) -> dict:
        d = asdict(self)
        d["expected_closing"] = self.expected_closing
        d["residual"] = self.residual()
        d["reconciles"] = self.reconciles()
        return d


class ReconciliationStatus(str, Enum):
    RECONCILED          = "RECONCILED"
    UNEXPLAINED_MISMATCH = "UNEXPLAINED_MISMATCH"   # → PAPER_BLOCKED trigger


def reconcile_accounting(ledger: AccountingLedger, tolerance: float = 0.01) -> dict:
    """
    Verify the accounting identity (spec §56). A residual beyond tolerance is an
    UNEXPLAINED_MISMATCH — a hard blocker, never silently absorbed.
    """
    ok = ledger.reconciles(tolerance)
    return {"status": (ReconciliationStatus.RECONCILED.value if ok
                       else ReconciliationStatus.UNEXPLAINED_MISMATCH.value),
            "tolerance": tolerance, **ledger.to_dict()}


# ══════════════════════════════════════════════════════════════════════════════
# §59 Idempotency
# ══════════════════════════════════════════════════════════════════════════════

class IdempotencyGuard:
    """
    Records processed event keys so replaying the same decision/order/fill/
    reconcile/finalization is a no-op (spec §59). `seen(key)` returns True if the
    key was already processed (i.e. this is a duplicate that must be ignored).
    """

    def __init__(self):
        self._seen: set[str] = set()

    def seen(self, key: str) -> bool:
        """Register the key; return True iff it was already present (duplicate)."""
        if key in self._seen:
            return True
        self._seen.add(key)
        return False

    def check(self, key: str) -> bool:
        """Non-mutating peek: True iff already processed."""
        return key in self._seen

    @property
    def count(self) -> int:
        return len(self._seen)
