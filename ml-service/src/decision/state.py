"""
Phase 3M — Canonical decision state machine (spec §5).

The decision lifecycle is an explicit, fail-closed state machine. If any
mandatory dependency fails, the decision transitions to a terminal
NO_EXECUTION state — it NEVER silently substitutes 0 / 0.5 / 1 / a random value
/ a heuristic probability / the latest model / the latest calibration / current
metadata for historical metadata.

Determinism: pure stdlib; no np.random.*.
"""

from __future__ import annotations

from enum import Enum


class DecisionState(str, Enum):
    """Canonical decision lifecycle states (spec §5)."""
    # ── dependency-failure (fail-closed) states ──────────────────────────
    DATA_UNAVAILABLE        = "DATA_UNAVAILABLE"
    DATA_INVALID            = "DATA_INVALID"
    FEATURES_UNAVAILABLE    = "FEATURES_UNAVAILABLE"
    REGIME_UNAVAILABLE      = "REGIME_UNAVAILABLE"
    MODEL_UNAVAILABLE       = "MODEL_UNAVAILABLE"
    MODEL_STALE             = "MODEL_STALE"
    MODEL_REVOKED           = "MODEL_REVOKED"
    MODEL_INCOMPATIBLE      = "MODEL_INCOMPATIBLE"
    CALIBRATION_UNAVAILABLE = "CALIBRATION_UNAVAILABLE"
    PROVENANCE_INVALID      = "PROVENANCE_INVALID"

    # ── evidence / decision states ───────────────────────────────────────
    INSUFFICIENT_EVIDENCE   = "INSUFFICIENT_EVIDENCE"
    ABSTAIN                 = "ABSTAIN"
    SKIP                    = "SKIP"
    CANDIDATE               = "CANDIDATE"
    VALIDATED               = "VALIDATED"

    # ── portfolio / risk rejection ───────────────────────────────────────
    PORTFOLIO_REJECTED      = "PORTFOLIO_REJECTED"
    RISK_REJECTED           = "RISK_REJECTED"

    # ── execution states ─────────────────────────────────────────────────
    EXECUTION_PLANNED       = "EXECUTION_PLANNED"
    SHADOW_EXECUTED         = "SHADOW_EXECUTED"
    PAPER_EXECUTED          = "PAPER_EXECUTED"

    # ── terminal lifecycle ───────────────────────────────────────────────
    EXPIRED                 = "EXPIRED"
    COMPLETED               = "COMPLETED"
    CANCELLED               = "CANCELLED"

    # ── explicit fail-closed / blocked ───────────────────────────────────
    BLOCKED                 = "BLOCKED"           # kill switch / safety gate


# States that mean "no executable trade decision was produced" (fail-closed).
NON_EXECUTABLE_STATES: frozenset[DecisionState] = frozenset({
    DecisionState.DATA_UNAVAILABLE,
    DecisionState.DATA_INVALID,
    DecisionState.FEATURES_UNAVAILABLE,
    DecisionState.REGIME_UNAVAILABLE,
    DecisionState.MODEL_UNAVAILABLE,
    DecisionState.MODEL_STALE,
    DecisionState.MODEL_REVOKED,
    DecisionState.MODEL_INCOMPATIBLE,
    DecisionState.CALIBRATION_UNAVAILABLE,
    DecisionState.PROVENANCE_INVALID,
    DecisionState.INSUFFICIENT_EVIDENCE,
    DecisionState.ABSTAIN,
    DecisionState.SKIP,
    DecisionState.PORTFOLIO_REJECTED,
    DecisionState.RISK_REJECTED,
    DecisionState.BLOCKED,
    DecisionState.EXPIRED,
    DecisionState.CANCELLED,
})

# Terminal states — no further transition.
TERMINAL_STATES: frozenset[DecisionState] = frozenset({
    DecisionState.DATA_UNAVAILABLE,
    DecisionState.DATA_INVALID,
    DecisionState.FEATURES_UNAVAILABLE,
    DecisionState.REGIME_UNAVAILABLE,
    DecisionState.MODEL_UNAVAILABLE,
    DecisionState.MODEL_STALE,
    DecisionState.MODEL_REVOKED,
    DecisionState.MODEL_INCOMPATIBLE,
    DecisionState.CALIBRATION_UNAVAILABLE,
    DecisionState.PROVENANCE_INVALID,
    DecisionState.INSUFFICIENT_EVIDENCE,
    DecisionState.ABSTAIN,
    DecisionState.SKIP,
    DecisionState.PORTFOLIO_REJECTED,
    DecisionState.RISK_REJECTED,
    DecisionState.BLOCKED,
    DecisionState.EXPIRED,
    DecisionState.COMPLETED,
    DecisionState.CANCELLED,
})


# Allowed forward transitions. A decision walks the happy path
# CANDIDATE → VALIDATED → EXECUTION_PLANNED → SHADOW/PAPER_EXECUTED → COMPLETED,
# but at any pre-execution stage may drop to a terminal fail-closed state.
VALID_TRANSITIONS: dict[DecisionState, set[DecisionState]] = {
    # A CANDIDATE may advance to VALIDATED or drop to ANY fail-closed dependency
    # state (every NON_EXECUTABLE_STATES member is reachable from CANDIDATE —
    # data/feature/regime/model/calibration/provenance failures are all detected
    # during candidate evaluation). It may NOT jump to an execution/terminal
    # success state (EXECUTION_PLANNED / SHADOW/PAPER_EXECUTED / COMPLETED)
    # without first being VALIDATED.
    DecisionState.CANDIDATE: {
        DecisionState.VALIDATED,
        DecisionState.DATA_UNAVAILABLE, DecisionState.DATA_INVALID,
        DecisionState.FEATURES_UNAVAILABLE, DecisionState.REGIME_UNAVAILABLE,
        DecisionState.MODEL_UNAVAILABLE, DecisionState.MODEL_STALE,
        DecisionState.MODEL_REVOKED, DecisionState.MODEL_INCOMPATIBLE,
        DecisionState.CALIBRATION_UNAVAILABLE, DecisionState.PROVENANCE_INVALID,
        DecisionState.INSUFFICIENT_EVIDENCE, DecisionState.ABSTAIN, DecisionState.SKIP,
        DecisionState.PORTFOLIO_REJECTED, DecisionState.RISK_REJECTED,
        DecisionState.BLOCKED, DecisionState.EXPIRED,
    },
    DecisionState.VALIDATED: {
        DecisionState.EXECUTION_PLANNED,
        DecisionState.PORTFOLIO_REJECTED, DecisionState.RISK_REJECTED,
        DecisionState.ABSTAIN, DecisionState.BLOCKED,
    },
    DecisionState.EXECUTION_PLANNED: {
        DecisionState.SHADOW_EXECUTED, DecisionState.PAPER_EXECUTED,
        DecisionState.BLOCKED, DecisionState.CANCELLED, DecisionState.EXPIRED,
    },
    DecisionState.SHADOW_EXECUTED: {DecisionState.COMPLETED, DecisionState.EXPIRED},
    DecisionState.PAPER_EXECUTED:  {DecisionState.COMPLETED, DecisionState.EXPIRED},
}


class InvalidStateTransition(Exception):
    """Raised when an invalid decision state transition is attempted."""


def is_valid_transition(a: DecisionState, b: DecisionState) -> bool:
    """True if transition a→b is allowed. Terminal states allow no transition."""
    if a in TERMINAL_STATES:
        return False
    return b in VALID_TRANSITIONS.get(a, set())


def is_executable(state: DecisionState) -> bool:
    """A decision is executable ONLY if it is not in a non-executable state."""
    return state not in NON_EXECUTABLE_STATES
