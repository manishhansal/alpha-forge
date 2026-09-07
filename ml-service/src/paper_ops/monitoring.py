"""
Phase 3R — Operational heartbeat + latency monitoring + daily report (§43-§45).

A process being alive must NEVER imply the trading pipeline is healthy (spec §43):
`OperationalHeartbeat` reports an EXPLICIT health state across seven independent
dimensions, and `HealthState.HEALTHY` requires ALL of them — a stale feed or a
stalled decision loop yields DEGRADED / UNHEALTHY even while the process runs.

`LatencyMonitor` derives the pipeline latencies from the recorded timestamp chain
and flags any stage that exceeds its threshold (spec §44).

`build_paper_session_report` produces the 24-point daily PAPER_SESSION_REPORT
(spec §45) as a serialisable dict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

UTC = timezone.utc


# ══════════════════════════════════════════════════════════════════════════════
# §43 Operational heartbeat (alive != healthy)
# ══════════════════════════════════════════════════════════════════════════════

class HealthState(str, Enum):
    HEALTHY   = "HEALTHY"
    DEGRADED  = "DEGRADED"
    UNHEALTHY = "UNHEALTHY"
    UNKNOWN   = "UNKNOWN"


class HeartbeatDimension(str, Enum):
    PROCESS_ALIVE       = "PROCESS_ALIVE"
    DATA_FRESHNESS      = "DATA_FRESHNESS"
    DECISION_LOOP       = "DECISION_LOOP"
    PROVIDER_STATUS     = "PROVIDER_STATUS"
    EVENT_SEQUENCE      = "EVENT_SEQUENCE"
    RECONCILIATION_STATE = "RECONCILIATION_STATE"
    SESSION_STATE       = "SESSION_STATE"


@dataclass
class OperationalHeartbeat:
    """
    Explicit per-dimension health (spec §43). `overall` is HEALTHY only if every
    mandatory dimension is healthy; a dead decision loop or stale data forces
    DEGRADED/UNHEALTHY even when `process_alive` is True.
    """
    process_alive:        bool = True
    data_fresh:           bool = True
    decision_loop_alive:  bool = True
    provider_ok:          bool = True
    event_sequence_intact: bool = True
    reconciliation_ok:    bool = True
    session_state_ok:     bool = True
    at:                   str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def dimension_states(self) -> dict[str, bool]:
        return {
            HeartbeatDimension.PROCESS_ALIVE.value: self.process_alive,
            HeartbeatDimension.DATA_FRESHNESS.value: self.data_fresh,
            HeartbeatDimension.DECISION_LOOP.value: self.decision_loop_alive,
            HeartbeatDimension.PROVIDER_STATUS.value: self.provider_ok,
            HeartbeatDimension.EVENT_SEQUENCE.value: self.event_sequence_intact,
            HeartbeatDimension.RECONCILIATION_STATE.value: self.reconciliation_ok,
            HeartbeatDimension.SESSION_STATE.value: self.session_state_ok,
        }

    @property
    def overall(self) -> HealthState:
        # process not alive → UNHEALTHY (nothing else matters)
        if not self.process_alive:
            return HealthState.UNHEALTHY
        dims = self.dimension_states()
        # data-integrity / sequence problems are UNHEALTHY (unsafe to trade)
        unhealthy_if_false = (HeartbeatDimension.DATA_FRESHNESS.value,
                              HeartbeatDimension.EVENT_SEQUENCE.value,
                              HeartbeatDimension.RECONCILIATION_STATE.value)
        if any(not dims[d] for d in unhealthy_if_false):
            return HealthState.UNHEALTHY
        # a stalled loop / provider / session issue is DEGRADED (alive != healthy)
        if not all(dims.values()):
            return HealthState.DEGRADED
        return HealthState.HEALTHY

    @property
    def is_healthy(self) -> bool:
        return self.overall == HealthState.HEALTHY

    def to_dict(self) -> dict:
        return {"overall": self.overall.value, "is_healthy": self.is_healthy,
                "dimensions": self.dimension_states(), "at": self.at}


# ══════════════════════════════════════════════════════════════════════════════
# §44 Latency monitoring
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class LatencyThresholds:
    """Per-stage latency alert thresholds in seconds (spec §44)."""
    data_latency_s:      float = 5.0
    feature_latency_s:   float = 2.0
    inference_latency_s: float = 2.0
    decision_latency_s:  float = 2.0
    total_latency_s:     float = 10.0


@dataclass
class LatencyReport:
    data_latency:      Optional[float]
    feature_latency:   Optional[float]
    inference_latency: Optional[float]
    decision_latency:  Optional[float]
    total_latency:     Optional[float]
    alerts:            list = field(default_factory=list)

    @property
    def has_alert(self) -> bool:
        return bool(self.alerts)

    def to_dict(self) -> dict:
        return {"data_latency": self.data_latency, "feature_latency": self.feature_latency,
                "inference_latency": self.inference_latency,
                "decision_latency": self.decision_latency, "total_latency": self.total_latency,
                "alerts": self.alerts, "has_alert": self.has_alert}


def _epoch(ts) -> Optional[float]:
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return float(ts)
    if isinstance(ts, datetime):
        return ts.timestamp()
    try:
        return datetime.fromisoformat(str(ts)).timestamp()
    except ValueError:
        return None


def compute_latency(
    *,
    market_ts, data_received_ts, feature_ts, prediction_ts, decision_ts,
    paper_order_ts=None, fill_ts=None,
    thresholds: Optional[LatencyThresholds] = None,
) -> LatencyReport:
    """
    Derive per-stage latency from the recorded timestamp chain (spec §44) and flag
    any stage over threshold. Missing timestamps yield None for that stage (never
    fabricated) and are not alerted on.
    """
    th = thresholds or LatencyThresholds()
    m, d, f = _epoch(market_ts), _epoch(data_received_ts), _epoch(feature_ts)
    p, dec = _epoch(prediction_ts), _epoch(decision_ts)
    o = _epoch(paper_order_ts)

    def _diff(a, b):
        return (b - a) if (a is not None and b is not None) else None

    data_lat = _diff(m, d)
    feat_lat = _diff(d, f)
    inf_lat = _diff(f, p)
    dec_lat = _diff(p, dec)
    total_end = o if o is not None else dec
    total_lat = _diff(m, total_end)

    alerts: list[str] = []
    for name, val, limit in (
        ("data_latency", data_lat, th.data_latency_s),
        ("feature_latency", feat_lat, th.feature_latency_s),
        ("inference_latency", inf_lat, th.inference_latency_s),
        ("decision_latency", dec_lat, th.decision_latency_s),
        ("total_latency", total_lat, th.total_latency_s),
    ):
        if val is not None and val > limit:
            alerts.append(f"{name} {val:.3f}s exceeds {limit}s")

    return LatencyReport(data_lat, feat_lat, inf_lat, dec_lat, total_lat, alerts)


# ══════════════════════════════════════════════════════════════════════════════
# §45 Daily PAPER_SESSION_REPORT (24 points)
# ══════════════════════════════════════════════════════════════════════════════

def build_paper_session_report(
    *,
    session_summary: dict,
    data_health: dict,
    provider_usage: dict,
    provider_fallbacks: dict,
    signal_count: int,
    decision_count: int,
    blocked_decisions: int,
    orders: dict,
    fills: dict,
    positions: dict,
    pnl: dict,
    costs: dict,
    slippage: dict,
    drawdown: float,
    exposure: dict,
    benchmark: dict,
    regime: dict,
    signal_family_attribution: dict,
    model_health: dict,
    calibration_health: dict,
    reconciliation: dict,
    anomalies: list,
    evidence_hash: str,
    final_status: str,
) -> dict:
    """
    Assemble the 24-point daily PAPER_SESSION_REPORT (spec §45). Pure assembly of
    already-computed evidence — computes nothing new, fabricates nothing.
    """
    return {
        "1_session_summary": session_summary,
        "2_data_health": data_health,
        "3_provider_usage": provider_usage,
        "4_provider_fallbacks": provider_fallbacks,
        "5_signal_count": signal_count,
        "6_decision_count": decision_count,
        "7_blocked_decisions": blocked_decisions,
        "8_orders": orders,
        "9_fills": fills,
        "10_positions": positions,
        "11_pnl": pnl,
        "12_costs": costs,
        "13_slippage": slippage,
        "14_drawdown": drawdown,
        "15_exposure": exposure,
        "16_benchmark": benchmark,
        "17_regime": regime,
        "18_signal_family_attribution": signal_family_attribution,
        "19_model_health": model_health,
        "20_calibration_health": calibration_health,
        "21_reconciliation": reconciliation,
        "22_anomalies": anomalies,
        "23_evidence_hash": evidence_hash,
        "24_final_status": final_status,
    }


PAPER_SESSION_REPORT_FIELDS: tuple[str, ...] = (
    "1_session_summary", "2_data_health", "3_provider_usage", "4_provider_fallbacks",
    "5_signal_count", "6_decision_count", "7_blocked_decisions", "8_orders",
    "9_fills", "10_positions", "11_pnl", "12_costs", "13_slippage", "14_drawdown",
    "15_exposure", "16_benchmark", "17_regime", "18_signal_family_attribution",
    "19_model_health", "20_calibration_health", "21_reconciliation", "22_anomalies",
    "23_evidence_hash", "24_final_status",
)
