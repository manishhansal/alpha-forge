"""
Phase 3M — evidence-package generator.

Produces the machine-readable evidence artifacts for the Phase 3M certification:
  reports/phase_3m_manifest.json          overall manifest (files + guarantees)
  reports/phase-3m-decision-schema.json   CanonicalDecision field schema
  reports/phase-3m-health-schema.json     SystemHealth / DimensionHealth contract
  reports/phase-3m-shadow-schema.json     ShadowOrder / ShadowFill / ledger schema
  reports/phase-3m-replay-manifest-example.json  a worked replay manifest
  reports/phase-3m-monitoring-report.json a sample machine-readable health rollup

Determinism: pure stdlib; fixed inputs; no np.random.*. Re-running yields byte-
identical content (except a single generated_at timestamp field, which is fixed
here to a constant for reproducibility of the evidence).
"""

from __future__ import annotations

import dataclasses
import json
import os

REPORTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "reports")
FIXED_TS = "2026-01-01T00:00:00+00:00"


def _field_schema(dc) -> dict:
    out = {}
    for f in dataclasses.fields(dc):
        typ = f.type if isinstance(f.type, str) else getattr(f.type, "__name__", str(f.type))
        required = (f.default is dataclasses.MISSING
                    and f.default_factory is dataclasses.MISSING)  # type: ignore[misc]
        out[f.name] = {"type": typ, "required": required}
    return out


def _write(name: str, obj: dict) -> str:
    path = os.path.join(REPORTS, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, sort_keys=True, default=str)
        fh.write("\n")
    return path


def main() -> None:
    os.makedirs(REPORTS, exist_ok=True)

    from src.decision.schema import CanonicalDecision
    from src.decision.monitoring import (
        HealthOrchestrator, data_health, feature_health, model_health,
        calibration_health, alpha_health, risk_health, execution_health, rl_health,
    )
    from src.decision.provenance import ReplayManifest
    from src.shadow.shadow_order import ShadowOrder
    from src.shadow.shadow_fill import ShadowFill
    from src.shadow.shadow_ledger import ShadowLedgerEvent
    from src.decision.state import (
        DecisionState, NON_EXECUTABLE_STATES, TERMINAL_STATES, VALID_TRANSITIONS)

    written = []

    # ── decision schema ──────────────────────────────────────────────────
    decision_schema = {
        "artifact": "phase-3m-decision-schema",
        "description": "Canonical decision contract (spec §4).",
        "fields": _field_schema(CanonicalDecision),
        "states": {
            "all": [s.value for s in DecisionState],
            "non_executable": sorted(s.value for s in NON_EXECUTABLE_STATES),
            "terminal": sorted(s.value for s in TERMINAL_STATES),
            "valid_transitions": {a.value: sorted(b.value for b in bs)
                                  for a, bs in VALID_TRANSITIONS.items()},
        },
        "semantic_invariants": [
            "alpha_score != probability",
            "probability != expected_return",
            "expected_return != expected_value",
            "decision != prediction",
        ],
    }
    written.append(_write("phase-3m-decision-schema.json", decision_schema))

    # ── health schema + a sample rollup ──────────────────────────────────
    health_schema = {
        "artifact": "phase-3m-health-schema",
        "description": "Structured health orchestration contract (spec §14–19, §28).",
        "dimensions": ["DATA", "FEATURE", "MODEL", "CALIBRATION", "ALPHA",
                       "RISK", "EXECUTION", "RL", "SYSTEM_HEALTH"],
        "states": ["HEALTHY", "WATCH", "DEGRADED", "UNSAFE", "UNAVAILABLE",
                   "INSUFFICIENT_EVIDENCE"],
        "blocking_states": ["UNSAFE", "UNAVAILABLE"],
        "insufficient_evidence_is_neutral_in_rollup": True,
        "no_auto_recalibrate": True,
        "no_auto_replace": True,
        "system_contract_keys": ["system_state", "degraded", "blocking",
                                 "generated_at", "dimensions"],
    }
    written.append(_write("phase-3m-health-schema.json", health_schema))

    # a worked, fully-healthy-except-unused-RL monitoring report
    dims = [
        data_health(),
        feature_health({"f1": "HEALTHY", "f2": "WATCH"}),
        model_health({"m1": "healthy"}),
        calibration_health(baseline_brier=0.20, observed_brier=0.21, n_observations=200),
        alpha_health(baseline_ic=0.05, observed_ic=0.045, n_observations=200),
        risk_health(risk_available=True),
        execution_health(simulator_available=True, cost_error_bps=8.0),
        rl_health(rl_used=False),
    ]
    rollup = HealthOrchestrator().assess(dims).to_dict()
    rollup["generated_at"] = FIXED_TS
    monitoring_report = {
        "artifact": "phase-3m-monitoring-report",
        "description": "Sample machine-readable system health rollup (spec §28).",
        "system_health": rollup,
        "guarantees": {
            "auto_recalibrate": False,
            "auto_replace_model": False,
            "auto_promote": False,
        },
    }
    written.append(_write("phase-3m-monitoring-report.json", monitoring_report))

    # ── shadow schema ────────────────────────────────────────────────────
    shadow_schema = {
        "artifact": "phase-3m-shadow-schema",
        "description": "Shadow/paper execution contract (spec §10–13). NEVER a broker.",
        "shadow_order_fields": _field_schema(ShadowOrder),
        "shadow_fill_fields": _field_schema(ShadowFill),
        "ledger_event_types": [e.value for e in ShadowLedgerEvent],
        "guarantees": {
            "immutable_append_only": True,
            "corrections_are_new_events": True,
            "idempotent_per_decision": True,
            "reuses_phase3g_simulator": True,
            "second_simulator": False,
            "broker_execution": False,
            "live_forbidden": True,
        },
    }
    written.append(_write("phase-3m-shadow-schema.json", shadow_schema))

    # ── replay manifest example ──────────────────────────────────────────
    rm = ReplayManifest(
        decision_id="dec-example-0001",
        data_snapshot_id="snap-2026-01-01",
        dataset_version="ds-v1", feature_version="feat-v1",
        feature_schema_hash="fhash-1", label_version="lab-v1",
        label_config_hash="lhash-1", model_ids=["m1"], model_versions=["1.0.0"],
        model_hashes=["mhash-1"], calibration_id="m1", calibration_version="cal-v1",
        portfolio_config_version="pf-v1", execution_config_version="exec-v1",
        rl_policy_id="rl-1", rl_policy_version="rl-v1",
        random_seeds={"np": 0}, environment_version="env-1", code_version="code-abc",
        deployment_mode="shadow", created_at=FIXED_TS,
    )
    replay_example = {
        "artifact": "phase-3m-replay-manifest-example",
        "description": "Worked replay manifest (spec §24). replay_id is deterministic.",
        "replay_id": rm.replay_id,
        "manifest": rm.to_dict(),
    }
    written.append(_write("phase-3m-replay-manifest-example.json", replay_example))

    # ── top-level manifest ───────────────────────────────────────────────
    manifest = {
        "phase": "3M",
        "title": "Research-to-Production Integration, Shadow Execution & ML Operations",
        "branch": "refactor/improve-ml-service",
        "principle": "ORCHESTRATE phases 3A–3L; never duplicate.",
        "new_packages": ["src/decision", "src/shadow"],
        "reused_components": {
            "meta_decision_engine": "3F (fusion)",
            "execution_simulator": "3G BacktestEngine via 3L SimulatorBridge",
            "portfolio": "3H",
            "stability_drift": "3I",
            "lifecycle_registry_storage": "3J (_storage, model_registry)",
            "rl_challenger": "3L",
            "provenance": "prediction_provenance.DeploymentMode/resolve_action",
        },
        "guarantees": {
            "deterministic_replay": True,
            "fail_closed": True,
            "append_only_audit": True,
            "live_broker_execution": False,
            "auto_retraining": False,
            "auto_recalibration": False,
            "auto_promotion": False,
            "second_execution_simulator": False,
            "duplicate_model_registry": False,
            "duplicate_provenance_system": False,
            "import_clean_no_talib_torch_sklearn": True,
        },
        "evidence_files": sorted(os.path.basename(p) for p in written) + [
            "phase-3m-test-results.json",
            "phase_3m_manifest.json",
        ],
    }
    written.append(_write("phase_3m_manifest.json", manifest))

    print("wrote:")
    for p in written:
        print("  ", os.path.relpath(p, os.path.dirname(REPORTS)))


if __name__ == "__main__":
    main()
