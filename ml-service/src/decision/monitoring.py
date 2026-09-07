"""
Phase 3M — Health orchestration (spec §14–§19, §28).

Aggregates structured health across nine dimensions:
    DATA / FEATURE / MODEL / CALIBRATION / ALPHA / RISK / EXECUTION / RL / SYSTEM

Each dimension is a STRUCTURED state with explicit reasons — NOT collapsed into
a single arbitrary numeric score (spec §19). This layer ORCHESTRATES existing
components; it does not reimplement drift / calibration / performance logic and
it NEVER auto-recalibrates or auto-replaces a model (spec §14, §16, §33):
  - drift → `monitoring.drift_detector` / Phase 3I `stability`
  - calibration metrics → `meta.calibration_engine.compute_calibration_metrics`
  - model health → `monitoring.model_registry.ModelState`
  - performance/decay → `monitoring.performance_monitor`

Produces a machine-readable monitoring contract (spec §28) for the frontend.

Determinism: pure stdlib + reused numpy; no np.random.*.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

UTC = timezone.utc


class HealthState(str, Enum):
    """Structured health state (spec §17, §18, §19)."""
    HEALTHY               = "HEALTHY"
    WATCH                 = "WATCH"          # aka DEGRADED/WARNING tier
    DEGRADED              = "DEGRADED"
    UNSAFE                = "UNSAFE"         # blocks decisions (data)
    UNAVAILABLE           = "UNAVAILABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


_SEVERITY = {
    HealthState.HEALTHY: 0, HealthState.INSUFFICIENT_EVIDENCE: 1,
    HealthState.WATCH: 2, HealthState.DEGRADED: 3,
    HealthState.UNAVAILABLE: 4, HealthState.UNSAFE: 5,
}


@dataclass
class DimensionHealth:
    """Health of one dimension (spec §19) — structured, with reasons."""
    dimension:  str
    state:      HealthState
    reasons:    list[str] = field(default_factory=list)
    metrics:    dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"dimension": self.dimension, "state": self.state.value,
                "reasons": self.reasons, "metrics": self.metrics}


# ══════════════════════════════════════════════════════════════════════════════
# Per-dimension assessors (spec §14–§18)
# ══════════════════════════════════════════════════════════════════════════════

def data_health(
    missing_bars: int = 0, duplicate_bars: int = 0, future_timestamps: int = 0,
    stale_prices: int = 0, zero_volume_bars: int = 0, negative_prices: int = 0,
    invalid_ohlc: int = 0, instrument_mismatch: int = 0,
) -> DimensionHealth:
    """Data-quality health (spec §17). UNSAFE data must block decisions."""
    reasons = []
    unsafe = (future_timestamps > 0 or negative_prices > 0 or invalid_ohlc > 0
              or instrument_mismatch > 0)
    degraded = (missing_bars > 0 or duplicate_bars > 0 or stale_prices > 0
                or zero_volume_bars > 0)
    if future_timestamps: reasons.append(f"{future_timestamps} future timestamps")
    if negative_prices:   reasons.append(f"{negative_prices} negative prices")
    if invalid_ohlc:      reasons.append(f"{invalid_ohlc} invalid OHLC")
    if instrument_mismatch: reasons.append("instrument mismatch")
    if missing_bars:      reasons.append(f"{missing_bars} missing bars")
    if duplicate_bars:    reasons.append(f"{duplicate_bars} duplicate bars")
    if stale_prices:      reasons.append(f"{stale_prices} stale prices")
    if zero_volume_bars:  reasons.append(f"{zero_volume_bars} zero-volume bars")
    state = HealthState.UNSAFE if unsafe else (HealthState.DEGRADED if degraded else HealthState.HEALTHY)
    return DimensionHealth("DATA", state, reasons,
                           {"missing_bars": missing_bars, "future_timestamps": future_timestamps,
                            "negative_prices": negative_prices, "invalid_ohlc": invalid_ohlc})


def feature_health(feature_states: Optional[dict[str, str]] = None) -> DimensionHealth:
    """
    Feature-drift health (spec §16). `feature_states` maps feature →
    HEALTHY/WATCH/DRIFT/SEVERE_DRIFT/UNAVAILABLE (from Phase 3I / monitoring).
    Feature drift does NOT auto-replace a model.
    """
    fs = feature_states or {}
    reasons = []
    severe = [f for f, s in fs.items() if s == "SEVERE_DRIFT"]
    drift = [f for f, s in fs.items() if s == "DRIFT"]
    watch = [f for f, s in fs.items() if s == "WATCH"]
    unavail = [f for f, s in fs.items() if s == "UNAVAILABLE"]
    if severe: reasons.append(f"severe drift: {severe[:5]}")
    if drift:  reasons.append(f"drift: {drift[:5]}")
    if watch:  reasons.append(f"watch: {watch[:5]}")
    if unavail: reasons.append(f"unavailable: {unavail[:5]}")
    if severe:
        state = HealthState.DEGRADED
    elif drift:
        state = HealthState.WATCH
    elif watch or unavail:
        state = HealthState.WATCH
    else:
        state = HealthState.HEALTHY
    return DimensionHealth("FEATURE", state, reasons,
                           {"n_severe": len(severe), "n_drift": len(drift), "n_watch": len(watch)})


def model_health(model_states: Optional[dict[str, str]] = None) -> DimensionHealth:
    """
    Model health from `monitoring.model_registry.ModelState`
    (healthy/warning/degraded/disabled). Never silently continues after
    corruption (spec §18): DISABLED → UNAVAILABLE.
    """
    ms = model_states or {}
    reasons = []
    disabled = [m for m, s in ms.items() if s.lower() == "disabled"]
    degraded = [m for m, s in ms.items() if s.lower() == "degraded"]
    warning = [m for m, s in ms.items() if s.lower() == "warning"]
    if disabled: reasons.append(f"disabled: {disabled}")
    if degraded: reasons.append(f"degraded: {degraded}")
    if warning:  reasons.append(f"warning: {warning}")
    if disabled:
        state = HealthState.UNAVAILABLE
    elif degraded:
        state = HealthState.DEGRADED
    elif warning:
        state = HealthState.WATCH
    else:
        state = HealthState.HEALTHY
    return DimensionHealth("MODEL", state, reasons,
                           {"n_disabled": len(disabled), "n_degraded": len(degraded)})


def calibration_health(
    baseline_brier: Optional[float] = None, observed_brier: Optional[float] = None,
    baseline_ece: Optional[float] = None, observed_ece: Optional[float] = None,
    degrade_brier_frac: float = 0.25, degrade_ece_abs: float = 0.05,
    n_observations: int = 0, min_observations: int = 30,
) -> DimensionHealth:
    """
    Calibration health from Phase 3F metrics (spec §14). Detects DEGRADATION but
    does NOT auto-recalibrate. INSUFFICIENT_EVIDENCE below min observations.
    """
    if n_observations < min_observations:
        return DimensionHealth("CALIBRATION", HealthState.INSUFFICIENT_EVIDENCE,
                               [f"only {n_observations} obs (< {min_observations})"],
                               {"n_observations": n_observations})
    reasons = []
    degraded = False
    metrics = {}
    if baseline_brier is not None and observed_brier is not None:
        metrics["baseline_brier"] = baseline_brier
        metrics["observed_brier"] = observed_brier
        if observed_brier > baseline_brier * (1 + degrade_brier_frac):
            degraded = True
            reasons.append(f"Brier {observed_brier:.3f} > baseline {baseline_brier:.3f} +{degrade_brier_frac:.0%}")
    if baseline_ece is not None and observed_ece is not None:
        metrics["baseline_ece"] = baseline_ece
        metrics["observed_ece"] = observed_ece
        if observed_ece > baseline_ece + degrade_ece_abs:
            degraded = True
            reasons.append(f"ECE {observed_ece:.3f} > baseline {baseline_ece:.3f} +{degrade_ece_abs}")
    state = HealthState.DEGRADED if degraded else HealthState.HEALTHY
    return DimensionHealth("CALIBRATION", state, reasons, metrics)


def alpha_health(
    baseline_ic: Optional[float] = None, observed_ic: Optional[float] = None,
    n_observations: int = 0, min_observations: int = 30,
    decay_frac: float = 0.5,
) -> DimensionHealth:
    """
    Alpha health from realized IC vs baseline (spec §15). Decomposition by
    regime/sector/etc. is done by the reconciliation aggregation (spec §13);
    this is the top-level rollup. INSUFFICIENT_EVIDENCE below min obs.
    """
    if n_observations < min_observations:
        return DimensionHealth("ALPHA", HealthState.INSUFFICIENT_EVIDENCE,
                               [f"only {n_observations} obs (< {min_observations})"],
                               {"n_observations": n_observations})
    reasons = []
    metrics = {"baseline_ic": baseline_ic, "observed_ic": observed_ic}
    state = HealthState.HEALTHY
    if baseline_ic is not None and observed_ic is not None and baseline_ic > 0:
        if observed_ic <= 0:
            state = HealthState.DEGRADED
            reasons.append(f"observed IC {observed_ic:.3f} <= 0 (baseline {baseline_ic:.3f})")
        elif observed_ic < baseline_ic * decay_frac:
            state = HealthState.WATCH
            reasons.append(f"IC decay: {observed_ic:.3f} < {decay_frac:.0%} of baseline {baseline_ic:.3f}")
    return DimensionHealth("ALPHA", state, reasons, metrics)


def risk_health(risk_available: bool, breaches: Optional[list[str]] = None) -> DimensionHealth:
    """Risk health. Risk engine unavailable → UNAVAILABLE (fail closed)."""
    if not risk_available:
        return DimensionHealth("RISK", HealthState.UNAVAILABLE, ["risk engine unavailable"], {})
    br = breaches or []
    state = HealthState.DEGRADED if br else HealthState.HEALTHY
    return DimensionHealth("RISK", state, [f"breach: {b}" for b in br], {"n_breaches": len(br)})


def execution_health(simulator_available: bool,
                     cost_error_bps: Optional[float] = None,
                     drift_threshold_bps: float = 50.0) -> DimensionHealth:
    """Execution health. Simulator unavailable → UNAVAILABLE (fail closed)."""
    if not simulator_available:
        return DimensionHealth("EXECUTION", HealthState.UNAVAILABLE,
                               ["execution simulator unavailable"], {})
    reasons = []
    state = HealthState.HEALTHY
    if cost_error_bps is not None and abs(cost_error_bps) > drift_threshold_bps:
        state = HealthState.WATCH
        reasons.append(f"cost drift {cost_error_bps:.1f}bps > {drift_threshold_bps}bps")
    return DimensionHealth("EXECUTION", state, reasons, {"cost_error_bps": cost_error_bps})


def rl_health(rl_used: bool, ood_rate: Optional[float] = None,
              simulator_dependency_risk: bool = False,
              ood_threshold: float = 0.2) -> DimensionHealth:
    """RL health (spec §18). RL is a challenger; degradation never auto-promotes."""
    if not rl_used:
        return DimensionHealth("RL", HealthState.INSUFFICIENT_EVIDENCE, ["RL not in use"], {})
    reasons = []
    state = HealthState.HEALTHY
    if simulator_dependency_risk:
        state = HealthState.DEGRADED
        reasons.append("SIMULATOR_DEPENDENCY_RISK")
    if ood_rate is not None and ood_rate > ood_threshold:
        state = max(state, HealthState.WATCH, key=lambda s: _SEVERITY[s])
        reasons.append(f"OOD rate {ood_rate:.2f} > {ood_threshold}")
    return DimensionHealth("RL", state, reasons, {"ood_rate": ood_rate})


# ══════════════════════════════════════════════════════════════════════════════
# System health rollup (spec §19, §28)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class SystemHealth:
    """
    End-to-end operational health summary (spec §19). NOT a single arbitrary
    score — a structured set of dimension states plus the worst (system) state
    and whether decisions should be blocked.
    """
    dimensions:     list[DimensionHealth]
    system_state:   HealthState
    degraded:       bool
    blocking:       bool                # any dimension UNSAFE/UNAVAILABLE → block
    generated_at:   str = ""

    def __post_init__(self):
        if not self.generated_at:
            self.generated_at = datetime.now(UTC).isoformat()

    def to_dict(self) -> dict:
        """Machine-readable monitoring contract (spec §28)."""
        return {
            "system_state": self.system_state.value,
            "degraded": self.degraded,
            "blocking": self.blocking,
            "generated_at": self.generated_at,
            "dimensions": {d.dimension: d.to_dict() for d in self.dimensions},
        }


class HealthOrchestrator:
    """
    Rolls up the nine dimensions into a SystemHealth (spec §19). System state is
    the worst dimension state (structured, not a numeric average). A DATA=UNSAFE
    or any UNAVAILABLE mandatory dimension makes the system blocking.
    """

    BLOCKING_STATES = {HealthState.UNSAFE, HealthState.UNAVAILABLE}

    def assess(self, dimensions: list[DimensionHealth]) -> SystemHealth:
        if not dimensions:
            return SystemHealth([], HealthState.INSUFFICIENT_EVIDENCE, degraded=False, blocking=True)
        # INSUFFICIENT_EVIDENCE dimensions (e.g. an unused RL challenger, or a
        # metric below its min-observations floor) are NEUTRAL for the system
        # rollup — they neither degrade nor block. They are still reported
        # per-dimension for transparency.
        rollup = [d for d in dimensions if d.state != HealthState.INSUFFICIENT_EVIDENCE]
        if not rollup:
            worst = HealthState.INSUFFICIENT_EVIDENCE
            blocking = False
        else:
            worst = max(rollup, key=lambda d: _SEVERITY[d.state]).state
            blocking = any(d.state in self.BLOCKING_STATES for d in rollup)
        degraded = worst in (HealthState.WATCH, HealthState.DEGRADED) or blocking
        return SystemHealth(dimensions=dimensions, system_state=worst,
                            degraded=degraded, blocking=blocking)
