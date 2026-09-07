"""
Phase 3R — Session-start validation (spec §4).

Before a session may enter RUNNING, four gate groups must pass: DATA, MODEL, RISK,
EXECUTION. If any MANDATORY check fails, the result is `SESSION_START_BLOCKED` and
the session must NOT start (never start degraded paper trading silently, spec §4).

This is a deterministic aggregator: the caller supplies the already-computed
health booleans (from the 3Q data-reliability gates, the model/artifact checks,
the risk-limit checks, and the execution-simulator/calendar checks). The gate does
not fetch anything itself — it fails CLOSED when a mandatory signal is missing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class StartGate(str, Enum):
    # DATA group
    MARKET_CALENDAR      = "MARKET_CALENDAR"
    PROVIDER_HEALTH      = "PROVIDER_HEALTH"
    TIMESTAMP_INTEGRITY  = "TIMESTAMP_INTEGRITY"
    DATA_FRESHNESS       = "DATA_FRESHNESS"
    REQUIRED_INSTRUMENTS = "REQUIRED_INSTRUMENTS"
    REQUIRED_HISTORY     = "REQUIRED_HISTORY"
    FEATURE_AVAILABILITY = "FEATURE_AVAILABILITY"
    # MODEL group
    CHAMPION_ARTIFACT    = "CHAMPION_ARTIFACT"
    ARTIFACT_HASH        = "ARTIFACT_HASH"
    MODEL_COMPATIBILITY  = "MODEL_COMPATIBILITY"
    FEATURE_SCHEMA       = "FEATURE_SCHEMA"
    CALIBRATOR           = "CALIBRATOR"
    META_MODEL           = "META_MODEL"
    PORTFOLIO_CONFIG     = "PORTFOLIO_CONFIG"
    # RISK group
    RISK_LIMITS          = "RISK_LIMITS"
    MAX_POSITION         = "MAX_POSITION"
    MAX_TURNOVER         = "MAX_TURNOVER"
    MAX_DRAWDOWN         = "MAX_DRAWDOWN"
    CONCENTRATION_LIMITS = "CONCENTRATION_LIMITS"
    LIQUIDITY_LIMITS     = "LIQUIDITY_LIMITS"
    # EXECUTION group
    COST_MODEL           = "COST_MODEL"
    SLIPPAGE_MODEL       = "SLIPPAGE_MODEL"
    FILL_MODEL           = "FILL_MODEL"
    EXEC_MARKET_CALENDAR = "EXEC_MARKET_CALENDAR"
    TRADING_HOURS        = "TRADING_HOURS"


# Group membership, for reporting.
GATE_GROUPS: dict[str, tuple[StartGate, ...]] = {
    "DATA": (StartGate.MARKET_CALENDAR, StartGate.PROVIDER_HEALTH,
             StartGate.TIMESTAMP_INTEGRITY, StartGate.DATA_FRESHNESS,
             StartGate.REQUIRED_INSTRUMENTS, StartGate.REQUIRED_HISTORY,
             StartGate.FEATURE_AVAILABILITY),
    "MODEL": (StartGate.CHAMPION_ARTIFACT, StartGate.ARTIFACT_HASH,
              StartGate.MODEL_COMPATIBILITY, StartGate.FEATURE_SCHEMA,
              StartGate.CALIBRATOR, StartGate.META_MODEL, StartGate.PORTFOLIO_CONFIG),
    "RISK": (StartGate.RISK_LIMITS, StartGate.MAX_POSITION, StartGate.MAX_TURNOVER,
             StartGate.MAX_DRAWDOWN, StartGate.CONCENTRATION_LIMITS,
             StartGate.LIQUIDITY_LIMITS),
    "EXECUTION": (StartGate.COST_MODEL, StartGate.SLIPPAGE_MODEL, StartGate.FILL_MODEL,
                  StartGate.EXEC_MARKET_CALENDAR, StartGate.TRADING_HOURS),
}

ALL_START_GATES: tuple[StartGate, ...] = tuple(
    g for group in GATE_GROUPS.values() for g in group)


class GateOutcome(str, Enum):
    PASS    = "PASS"
    BLOCKED = "BLOCKED"


class SessionStartBlocked(Exception):
    """Raised when a mandatory start gate fails (spec §4). Fail-closed."""


@dataclass
class StartValidationResult:
    outcome:       str                      # GateOutcome value
    failed_gates:  list[str] = field(default_factory=list)
    group_status:  dict = field(default_factory=dict)   # group -> PASS/BLOCKED
    reasons:       list[str] = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return self.outcome == GateOutcome.PASS.value

    def to_dict(self) -> dict:
        return {"outcome": self.outcome, "failed_gates": self.failed_gates,
                "group_status": self.group_status, "reasons": self.reasons,
                "allowed": self.allowed}


def validate_session_start(gate_conditions: dict) -> StartValidationResult:
    """
    Aggregate the four gate groups (spec §4). `gate_conditions` maps each
    `StartGate` value → bool (True = satisfied). A missing gate is treated as
    FAILED (fail-closed) — the session may not start on an unverified check.

    Returns a result; if any gate is BLOCKED the outcome is `SESSION_START_BLOCKED`
    (never start degraded silently). The caller then transitions the session to
    FAILED / does NOT enter RUNNING.
    """
    failed: list[str] = []
    reasons: list[str] = []
    group_status: dict[str, str] = {}

    for group_name, gates in GATE_GROUPS.items():
        group_ok = True
        for gate in gates:
            ok = bool(gate_conditions.get(gate.value, False))
            if not ok:
                failed.append(gate.value)
                reasons.append(f"{group_name}: gate {gate.value} failed or missing")
                group_ok = False
        group_status[group_name] = (GateOutcome.PASS.value if group_ok
                                    else GateOutcome.BLOCKED.value)

    if failed:
        return StartValidationResult(GateOutcome.BLOCKED.value, failed,
                                    group_status, reasons)
    return StartValidationResult(GateOutcome.PASS.value, [], group_status, [])
