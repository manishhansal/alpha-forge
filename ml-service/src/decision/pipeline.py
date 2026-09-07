"""
Phase 3M — Unified decision orchestrator (spec §6).

Coordinates the canonical decision flow:

    Data → Features → Regime → Ranker → Strategy → Meta → Calibration → EV
    → Abstention → Portfolio → Execution → RL challenger → Safety

The orchestrator does NOT reimplement any model. It CALLS existing components:
  - `meta.MetaDecisionEngine.decide` for the fused decision (Phase 3F)
  - `decision.validation` for dependency/compatibility/staleness gating
  - `decision.events.SafetyLayer` for kill-switch / safety override (spec §20)
  - `decision.provenance` for the replay manifest + deployment-mode governance

Every stage returns a `StageResult` (result / status / reason / provenance /
version / latency). Any MANDATORY stage failure is fail-closed: the pipeline
stops and the decision carries the failed `DecisionState` (never a fabricated
substitute).

Inputs are provided as a `PipelineInputs` bundle so the orchestrator is
deterministic and testable without the talib/torch-dependent model classes.
A caller (e.g. the API layer) is responsible for producing those inputs by
invoking the real predictors — the orchestrator only sequences and gates them.

Determinism: pure stdlib + reused components; no np.random.*.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from src.prediction_provenance import DeploymentMode, PredictionProvenance

from .schema import CanonicalDecision
from .state import DecisionState, is_valid_transition
from .provenance import ReplayManifest, DecisionProvenance, normalize_mode
from .validation import (
    validate_data, validate_features, validate_model, validate_calibration,
    validate_portfolio, validate_execution, validate_rl, ModelCompatibility,
    assess_staleness, Staleness, StalenessConfig,
)
from .events import EventLog, EventType, SafetyLayer, SafetyInputs

UTC = timezone.utc


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class StageStatus(str, Enum):
    OK          = "OK"
    FAILED      = "FAILED"
    SKIPPED     = "SKIPPED"
    ABSTAINED   = "ABSTAINED"


@dataclass
class StageResult:
    """Contract every pipeline stage returns (spec §6)."""
    stage:      str
    status:     StageStatus
    reason:     str = ""
    result:     Any = None
    version:    str = ""
    provenance: dict = field(default_factory=dict)
    latency_ms: float = 0.0
    failed_state: Optional[str] = None    # DecisionState value if this stage fails closed

    @property
    def ok(self) -> bool:
        return self.status == StageStatus.OK

    def to_dict(self) -> dict:
        return {"stage": self.stage, "status": self.status.value, "reason": self.reason,
                "version": self.version, "latency_ms": round(self.latency_ms, 3),
                "failed_state": self.failed_state}


# ══════════════════════════════════════════════════════════════════════════════
# Pipeline inputs (produced by the caller from real predictors)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PipelineInputs:
    """
    Everything the orchestrator needs, produced upstream by the real predictors.
    Any None field is treated as an unavailable dependency (fail closed).
    """
    instrument:             str
    as_of_time:             str                      # ISO-8601 UTC
    deployment_mode:        str = DeploymentMode.SHADOW.value

    # data
    data_snapshot_id:       Optional[str] = None
    dataset_version:        Optional[str] = None
    data_max_age_seconds:   Optional[float] = None
    expected_instrument:    Optional[str] = None

    # features
    feature_version:        Optional[str] = None
    feature_schema_hash:    Optional[str] = None
    required_features:      Optional[list[str]] = None
    present_features:       Optional[list[str]] = None

    # regime
    market_regime:          Optional[str] = None
    regime_confidence:      Optional[float] = None

    # model + compatibility
    model_ids:              list[str] = field(default_factory=list)
    model_versions:         list[str] = field(default_factory=list)
    model_hashes:           list[str] = field(default_factory=list)
    model_exists:           bool = False
    registry_status:        Optional[str] = None
    acceptance_status:      Optional[str] = None
    deployment_date:        Optional[str] = None
    compatibility:          Optional[ModelCompatibility] = None
    runtime_horizon:        Optional[int] = None

    # ranker / strategy
    alpha_score:            Optional[float] = None
    alpha_rank:             Optional[int] = None
    alpha_rank_percentile:  Optional[float] = None
    strategy:               Optional[str] = None
    direction:              Optional[str] = None

    # meta decision (from MetaDecisionEngine.decide — passed in, not recomputed)
    meta_output:            Any = None               # meta.MetaOutput (dict or object)
    prediction_provenance:  str = PredictionProvenance.HEURISTIC.value

    # calibration
    calibration_exists:     bool = False
    calibration_id:         Optional[str] = None
    calibration_fit_time:   Optional[str] = None
    raw_probability:        Optional[float] = None
    calibrated_probability: Optional[float] = None

    # EV
    expected_win:           Optional[float] = None
    expected_loss:          Optional[float] = None
    expected_cost:          Optional[float] = None
    expected_value:         Optional[float] = None

    # abstention
    abstention_state:       Optional[str] = None
    abstention_reason:      list[str] = field(default_factory=list)

    # portfolio / risk
    risk_available:         bool = False
    constraints_ok:         bool = False
    portfolio_target:       Optional[float] = None
    risk_budget:            Optional[float] = None
    position_size:          Optional[float] = None
    portfolio_reason:       str = ""

    # execution
    cost_model_version:     Optional[str] = None
    slippage_model_version: Optional[str] = None
    simulator_available:    bool = False
    execution_policy:       Optional[str] = None
    execution_policy_version: Optional[str] = None

    # RL challenger (optional)
    rl_used:                bool = False
    rl_policy_id:           Optional[str] = None
    rl_policy_version:      Optional[str] = None
    rl_action:              Optional[str] = None
    rl_action_allowed:      bool = True
    rl_ood:                 bool = False
    rl_policy_valid:        bool = True

    # health (from monitoring orchestration)
    system_health_degraded: bool = False
    excessive_drift:        bool = False

    # config / provenance
    staleness_config:       Optional[StalenessConfig] = None
    code_version:           str = ""
    environment_version:    str = ""
    random_seeds:           dict = field(default_factory=dict)


# ══════════════════════════════════════════════════════════════════════════════
# Orchestrator
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PipelineOutput:
    decision:   CanonicalDecision
    provenance: DecisionProvenance
    stages:     list[StageResult]

    def to_dict(self) -> dict:
        return {"decision": self.decision.to_dict(),
                "provenance": self.provenance.to_dict(),
                "stages": [s.to_dict() for s in self.stages]}


class DecisionPipeline:
    """
    Unified, deterministic, fail-closed decision orchestrator (spec §6).

    Reuses `meta.MetaDecisionEngine` for the fused decision — it is passed in or
    lazily constructed on first use (kept out of module import to preserve
    import-cleanliness). The orchestrator never reimplements a model.
    """

    def __init__(self, event_log: Optional[EventLog] = None,
                 safety_layer: Optional[SafetyLayer] = None):
        self.event_log = event_log
        self.safety = safety_layer or SafetyLayer()

    def _emit(self, et: EventType, decision_id: str, provenance_id: str = "", **payload):
        if self.event_log is not None:
            self.event_log.emit(et, decision_id, provenance_id, **payload)

    def evaluate(self, inp: PipelineInputs,
                 decision_id: Optional[str] = None,
                 trace_id: Optional[str] = None,
                 now: Optional[datetime] = None) -> PipelineOutput:
        """
        Run the canonical decision flow, fail-closed. Returns a PipelineOutput
        with the CanonicalDecision (carrying its final DecisionState), the
        DecisionProvenance (with replay manifest), and the per-stage results.
        """
        mode = normalize_mode(inp.deployment_mode)   # raises if LIVE
        decision_id = decision_id or f"dec-{uuid.uuid4().hex[:16]}"
        trace_id = trace_id or f"trace-{uuid.uuid4().hex[:12]}"
        stages: list[StageResult] = []
        latency: dict[str, float] = {}

        dec = CanonicalDecision(
            decision_id=decision_id,
            decision_timestamp=inp.as_of_time,
            instrument=inp.instrument,
            deployment_mode=mode.value,
            trace_id=trace_id,
            data_snapshot_id=inp.data_snapshot_id or "",
            dataset_version=inp.dataset_version or "",
            feature_version=inp.feature_version or "",
            feature_schema_hash=inp.feature_schema_hash or "",
            market_regime=inp.market_regime,
            regime_confidence=inp.regime_confidence,
            alpha_score=inp.alpha_score,
            alpha_rank=inp.alpha_rank,
            alpha_rank_percentile=inp.alpha_rank_percentile,
            strategy=inp.strategy,
            direction=inp.direction,
            raw_probability=inp.raw_probability,
            calibrated_probability=inp.calibrated_probability,
            expected_win=inp.expected_win,
            expected_loss=inp.expected_loss,
            expected_cost=inp.expected_cost,
            expected_value=inp.expected_value,
            abstention_state=inp.abstention_state,
            abstention_reason=list(inp.abstention_reason),
            portfolio_target=inp.portfolio_target,
            risk_budget=inp.risk_budget,
            position_size=inp.position_size,
            execution_policy=inp.execution_policy,
            execution_policy_version=inp.execution_policy_version,
            rl_policy_id=inp.rl_policy_id,
            rl_policy_version=inp.rl_policy_version,
            rl_action=inp.rl_action,
            rl_action_allowed=inp.rl_action_allowed if inp.rl_used else None,
            model_ids=list(inp.model_ids),
            model_versions=list(inp.model_versions),
            model_hashes=list(inp.model_hashes),
            prediction_provenance=inp.prediction_provenance,
            decision_state=DecisionState.CANDIDATE.value,
        )

        # build replay manifest + provenance envelope
        rm = ReplayManifest(
            decision_id=decision_id, data_snapshot_id=inp.data_snapshot_id or "",
            dataset_version=inp.dataset_version or "", feature_version=inp.feature_version or "",
            feature_schema_hash=inp.feature_schema_hash or "",
            model_ids=list(inp.model_ids), model_versions=list(inp.model_versions),
            model_hashes=list(inp.model_hashes), calibration_id=inp.calibration_id or "",
            execution_config_version=inp.execution_policy_version or "",
            rl_policy_id=inp.rl_policy_id or "", rl_policy_version=inp.rl_policy_version or "",
            random_seeds=dict(inp.random_seeds), environment_version=inp.environment_version,
            code_version=inp.code_version, deployment_mode=mode.value,
        )
        prov_id = f"prov-{rm.replay_id}"
        dec.provenance_id = prov_id
        prov = DecisionProvenance(
            provenance_id=prov_id, decision_id=decision_id,
            prediction_provenance=inp.prediction_provenance, deployment_mode=mode.value,
            replay_manifest=rm.to_dict(),
        )

        def _stage(name: str, fn):
            t0 = time.perf_counter()
            r = fn()
            r.latency_ms = (time.perf_counter() - t0) * 1000.0
            latency[name] = r.latency_ms
            stages.append(r)
            return r

        def _fail(state: DecisionState, stage_results: list[StageResult]) -> PipelineOutput:
            dec.set_state(state)
            dec.latency_breakdown_ms = latency
            self._emit(EventType.DECISION_STATE_CHANGED, decision_id, prov_id, state=state.value)
            return PipelineOutput(decision=dec, provenance=prov, stages=stage_results)

        # ── Stage 1: DATA ────────────────────────────────────────────────
        r = _stage("data", lambda: _wrap("data", validate_data(
            inp.data_snapshot_id, inp.as_of_time, inp.data_max_age_seconds, now,
            inp.instrument, inp.expected_instrument)))
        if not r.ok:
            return _fail(DecisionState(r.failed_state), stages)
        self._emit(EventType.DATA_ACCEPTED, decision_id, prov_id)

        # ── Stage 2: FEATURES ────────────────────────────────────────────
        r = _stage("features", lambda: _wrap("features", validate_features(
            inp.feature_version, inp.feature_schema_hash, inp.required_features,
            inp.present_features)))
        if not r.ok:
            return _fail(DecisionState(r.failed_state), stages)
        self._emit(EventType.FEATURES_GENERATED, decision_id, prov_id)

        # ── Stage 3: REGIME ──────────────────────────────────────────────
        def _regime():
            if inp.market_regime is None:
                return StageResult("regime", StageStatus.FAILED, "regime unavailable",
                                   failed_state=DecisionState.REGIME_UNAVAILABLE.value)
            return StageResult("regime", StageStatus.OK, result=inp.market_regime)
        r = _stage("regime", _regime)
        if not r.ok:
            return _fail(DecisionState(r.failed_state), stages)

        # ── Stage 4: MODEL (existence/hash/registry) + compatibility + staleness ─
        r = _stage("model", lambda: _wrap("model", validate_model(
            inp.model_exists, inp.model_hashes[0] if inp.model_hashes else None,
            inp.registry_status, inp.acceptance_status)))
        if not r.ok:
            return _fail(DecisionState(r.failed_state), stages)
        self._emit(EventType.MODEL_SELECTED, decision_id, prov_id,
                   model_ids=inp.model_ids, model_versions=inp.model_versions)

        if inp.compatibility is not None:
            r = _stage("compatibility", lambda: _wrap("compatibility", inp.compatibility.check(
                inp.feature_version or "", inp.feature_schema_hash or "",
                runtime_horizon=inp.runtime_horizon, runtime_instrument=inp.instrument,
                runtime_regime=inp.market_regime)))
            if not r.ok:
                return _fail(DecisionState(r.failed_state), stages)

        def _staleness():
            st, reason = assess_staleness(inp.deployment_date, inp.registry_status,
                                          inp.calibration_fit_time, inp.staleness_config, now)
            if st in (Staleness.STALE, Staleness.REVOKED):
                fs = DecisionState.MODEL_REVOKED if st == Staleness.REVOKED else DecisionState.MODEL_STALE
                return StageResult("staleness", StageStatus.FAILED, reason,
                                   result=st.value, failed_state=fs.value)
            return StageResult("staleness", StageStatus.OK, reason, result=st.value)
        r = _stage("staleness", _staleness)
        if not r.ok:
            return _fail(DecisionState(r.failed_state), stages)

        # ── Stage 5: META (fused decision — reuse MetaDecisionEngine output) ─
        def _meta():
            if inp.meta_output is None:
                return StageResult("meta", StageStatus.FAILED, "meta decision unavailable",
                                   failed_state=DecisionState.INSUFFICIENT_EVIDENCE.value)
            mo = inp.meta_output
            action = mo.get("action") if isinstance(mo, dict) else getattr(mo.action, "value", str(getattr(mo, "action", "")))
            dec.meta_label = action
            self._emit(EventType.PREDICTION_GENERATED, decision_id, prov_id, action=action)
            return StageResult("meta", StageStatus.OK, result=action)
        r = _stage("meta", _meta)
        if not r.ok:
            return _fail(DecisionState(r.failed_state), stages)

        # ── Stage 6: CALIBRATION (no fabricated probability) ─────────────
        r = _stage("calibration", lambda: _wrap("calibration", validate_calibration(
            inp.calibration_exists, inp.calibration_id, inp.model_ids[0] if inp.model_ids else None,
            inp.calibration_fit_time, now=now)))
        if not r.ok:
            return _fail(DecisionState(r.failed_state), stages)
        self._emit(EventType.CALIBRATION_APPLIED, decision_id, prov_id)

        # ── Stage 7: EV ──────────────────────────────────────────────────
        self._emit(EventType.EV_COMPUTED, decision_id, prov_id, ev=inp.expected_value)
        stages.append(StageResult("ev", StageStatus.OK, result=inp.expected_value))

        # ── Stage 8: ABSTENTION ──────────────────────────────────────────
        if inp.abstention_state and inp.abstention_state.upper() in ("ABSTAIN", "HARD_ABSTAIN", "SOFT_ABSTAIN"):
            stages.append(StageResult("abstention", StageStatus.ABSTAINED,
                                      reason=";".join(inp.abstention_reason)))
            self._emit(EventType.ABSTENTION_APPLIED, decision_id, prov_id)
            return _fail(DecisionState.ABSTAIN, stages)
        stages.append(StageResult("abstention", StageStatus.OK))

        # ── deployment-mode governance on the meta action ────────────────
        final_action, final_prov = prov.resolve(dec.meta_label or "NO_TRADE")
        dec.meta_label = final_action
        dec.prediction_provenance = final_prov
        if final_action in ("NO_TRADE", "WAIT"):
            stages.append(StageResult("governance", StageStatus.SKIPPED,
                                      reason=f"{final_prov} → {final_action}"))
            return _fail(DecisionState.SKIP if final_action == "WAIT" else DecisionState.INSUFFICIENT_EVIDENCE, stages)

        # candidate validated up to here
        dec.set_state(DecisionState.VALIDATED)

        # ── Stage 9: PORTFOLIO / RISK ────────────────────────────────────
        r = _stage("portfolio", lambda: _wrap("portfolio", validate_portfolio(
            inp.risk_available, inp.constraints_ok, inp.portfolio_reason)))
        if not r.ok:
            self._emit(EventType.PORTFOLIO_REJECTED, decision_id, prov_id, reason=r.reason)
            return _fail(DecisionState(r.failed_state), stages)
        self._emit(EventType.PORTFOLIO_ACCEPTED, decision_id, prov_id)

        # ── Stage 10: EXECUTION ──────────────────────────────────────────
        r = _stage("execution", lambda: _wrap("execution", validate_execution(
            inp.cost_model_version, inp.slippage_model_version, inp.simulator_available)))
        if not r.ok:
            return _fail(DecisionState(r.failed_state), stages)

        # ── Stage 11: RL CHALLENGER (optional; never bypasses safety) ────
        if inp.rl_used:
            self._emit(EventType.RL_ACTION_PROPOSED, decision_id, prov_id, action=inp.rl_action)
            r = _stage("rl", lambda: _wrap("rl", validate_rl(
                inp.rl_policy_id, inp.rl_action_allowed, inp.rl_ood)))
            if not r.ok:
                self._emit(EventType.RL_ACTION_REJECTED, decision_id, prov_id, reason=r.reason)
                return _fail(DecisionState(r.failed_state), stages)

        # ── Stage 12: SAFETY LAYER (kill switches override ML) ───────────
        safety = self.safety.evaluate(SafetyInputs(
            data_safe=True, model_revoked=(inp.registry_status or "").upper() in ("REVOKED", "DISABLED"),
            calibration_stale=False, feature_schema_match=True,
            excessive_drift=inp.excessive_drift, simulator_available=inp.simulator_available,
            portfolio_risk_ok=(inp.risk_available and inp.constraints_ok),
            rl_used=inp.rl_used, rl_ood=inp.rl_ood, rl_policy_valid=inp.rl_policy_valid,
            provenance_valid=prov.is_valid, system_health_degraded=inp.system_health_degraded,
        ))
        stages.append(StageResult("safety", StageStatus.OK if safety.allowed else StageStatus.FAILED,
                                  reason=";".join(safety.reasons), result=safety.to_dict()))
        if not safety.allowed:
            self._emit(EventType.KILL_SWITCH_TRIGGERED, decision_id, prov_id, tripped=safety.tripped)
            return _fail(DecisionState(safety.forced_state or DecisionState.BLOCKED.value), stages)

        # ── EXECUTION_PLANNED (shadow/paper executed downstream by shadow engine) ─
        dec.set_state(DecisionState.EXECUTION_PLANNED)
        dec.latency_breakdown_ms = latency
        self._emit(EventType.EXECUTION_PLANNED, decision_id, prov_id, meta_label=dec.meta_label)
        return PipelineOutput(decision=dec, provenance=prov, stages=stages)


def _wrap(stage: str, vr) -> StageResult:
    """Adapt a validation.ValidationResult to a StageResult."""
    if vr.ok:
        return StageResult(stage, StageStatus.OK)
    return StageResult(stage, StageStatus.FAILED, reason=vr.reason, failed_state=vr.failed_state)
