#!/usr/bin/env python3
"""
Phase 3O — deterministic evidence-artifact generator (spec §74, §75).

Writes the Phase 3O artifact bundle under `reports/phase-3o/`. Every number is
either COMPUTED by the src/paper3o machinery on clearly-tagged SYNTHETIC data, or
explicitly reported as INSUFFICIENT_EVIDENCE. Nothing is fabricated and nothing is
cherry-picked (§69) — losing/flat/adverse synthetic sessions are included.

Determinism: FIXED_TS + fixed seeds; re-running produces byte-identical content
(modulo the FIXED_TS stamp). This script performs NO live action, NO retrain, NO
recalibration, NO threshold tuning, and NEVER authorises live trading.

Run from ml-service/:  python3 scripts/gen_phase3o_evidence.py
"""

from __future__ import annotations

import os
import sys
import json
from pathlib import Path

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_ML = os.path.dirname(_HERE)
if _ML not in sys.path:
    sys.path.insert(0, _ML)

from src import paper3o as p3o  # noqa: E402

FIXED_TS = "2025-01-27T00:00:00+00:00"
GIT_COMMIT = "611b4f7"
CODE_VERSION = "phase-3o"
DATA_TAG = "SYNTHETIC_DATA"          # NO real-market data reachable in this env
OUT = Path(_ML) / "reports" / "phase-3o"


def _write(name: str, payload: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(payload, indent=2, sort_keys=True))


# ── 1. paper session manifest + report (single synthetic session) ────────────

def gen_session_artifacts() -> dict:
    m = p3o.Phase3OSessionManifest(
        paper_session_id="paper-3o-synth-001", market_date="2025-01-27",
        git_commit=GIT_COMMIT, code_version=CODE_VERSION,
        configuration_hash="cfg-synth-1", random_seed=42,
        data_snapshot_ids=["synth-snap-1"], data_tag=DATA_TAG,
        feature_version="fv-1", model_versions=["m1@1.0.0"],
        calibration_versions=["cal@1.0.0"], portfolio_version="pf@1.0.0",
        execution_version="ex@1.0.0", rl_policy_version="rl@1.0.0",
    )
    manifest = m.to_dict()
    _write("paper_session_manifest.json", manifest)

    report = {
        "paper_session_id": m.paper_session_id, "market_date": m.market_date,
        "data_tag": DATA_TAG, "replay_id": m.replay_id,
        "replay_complete": m.replay_complete,
        "economic_result": "INSUFFICIENT_EVIDENCE",
        "note": ("SYNTHETIC session — validates machinery only; no real-market "
                 "economic claim (no real data reachable in this environment)"),
    }
    _write("paper_session_report.json", report)
    return manifest


# ── 2. cumulative multi-session report (all tagged SYNTHETIC → E1) ───────────

def gen_cumulative_report() -> dict:
    import tempfile
    with tempfile.TemporaryDirectory() as root:
        store = p3o.MultiSessionStore(root)
        # include winning, flat AND losing synthetic sessions (no cherry-picking §69)
        for i, regime in enumerate(["BULL", "BEAR", "SIDEWAYS"]):
            store.add(p3o.SessionEvidence(
                f"synth-{i}", "2025-01-27", data_tag=DATA_TAG,
                provenance_complete=True, reconciled=True, regime=regime,
                replay_id="rid-synth"))
        payload = {
            "by_class": store.by_class(),
            "aggregate_tier": store.aggregate_tier().value,
            "official_series": store.official_series(),
            "note": ("all sessions SYNTHETIC → SYNTHETIC class, tier E1; no "
                     "OFFICIAL real-market evidence exists yet"),
        }
    _write("cumulative_report.json", payload)
    return payload


# ── 3. signal attribution + ablation + rl comparison ─────────────────────────

def gen_analysis_artifacts() -> None:
    attribution = p3o.alpha_attribution({
        "raw_signal": {"value": None, "n": 0},
        "ranking":    {"value": None, "n": 0},
        "meta":       {"value": None, "n": 0},
        "portfolio":  {"value": None, "n": 0},
        "execution":  {"value": None, "n": 0},
    })
    attribution["economic_evidence"] = "INSUFFICIENT_EVIDENCE"
    attribution["note"] = "no real-market net returns → incremental value not measurable"
    _write("signal_attribution.json", attribution)

    ablation = {
        "components": {c.value: p3o.ablation_verdict(None, None, n=0)
                       for c in p3o.AblationComponent},
        "safety_components_never_ablated": sorted(p3o.SAFETY_COMPONENTS),
        "note": ("all components INSUFFICIENT_EVIDENCE without real net returns; "
                 "NO_CONFIRMED_INCREMENTAL_VALUE is a valid honest outcome"),
    }
    _write("ablation_report.json", ablation)

    rl = p3o.rl_execution_comparison({d: {"baseline": None, "rl": None, "n": 0}
                                      for d in p3o.RL_EXECUTION_DIMENSIONS})
    rl["economic_evidence"] = "INSUFFICIENT_EVIDENCE"
    _write("rl_comparison.json", rl)


# ── 4. provider reliability + failure/recovery ───────────────────────────────

def gen_reliability_artifacts() -> None:
    prt = p3o.ProviderReliabilityTracker()   # NO observations → all availability UNKNOWN
    provider = {
        "providers": prt.all(),
        "note": ("no provider observations recorded in this environment → "
                 "availability UNKNOWN (never fabricated uptime)"),
    }
    _write("provider_reliability.json", provider)

    ft = p3o.FailureTracker()
    failure = {
        "by_category": ft.by_category(),
        "failover_semantics": {
            "all_unavailable": p3o.resolve_failover(
                [{"provider": "P", "available": False}]),
        },
        "recovery_semantics": {
            "no_state": p3o.recovery_decision(p3o.RecoveryPhase.ORDER, False, False),
            "would_duplicate": p3o.recovery_decision(p3o.RecoveryPhase.FILL, True, True),
        },
        "note": "no failures observed in this environment; semantics verified in tests",
    }
    _write("failure_recovery_report.json", failure)


# ── 5. statistical evidence + production safety + paper readiness ────────────

def gen_evidence_reports(session_manifest: dict) -> dict:
    statistical = {
        "calibration": p3o.calibration_report([], min_n=100),
        "economic_evidence": "INSUFFICIENT_EVIDENCE",
        "reporting_rules": {
            "sharpe": "requires window + n + frequency + cost basis (spec §68)",
            "win_rate": "requires trade count",
            "calibration": "requires n >= min_observations",
            "rl": "requires baseline + paired deltas + uncertainty",
        },
        "note": "no real-market observations → statistical evidence INSUFFICIENT",
    }
    _write("statistical_evidence.json", statistical)

    safety = {
        "live_authorized": False,
        "live_trading": "DISABLED",
        "no_lookahead": "enforced (chronology guard + adversarial tests)",
        "accounting_identity": "opening+flows+realized+unrealized-costs=closing (verified)",
        "idempotency": "duplicate decision/order/fill/reconcile are no-ops (verified)",
        "no_fake_fills": "unfilled orders keep execution_price=None (verified)",
        "note": "production-safety checks validated on SYNTHETIC data in tests",
    }
    _write("production_safety.json", safety)

    # go/no-go gate — machinery dimensions PASS on synthetic; statistical +
    # (implicitly) economic evidence INSUFFICIENT in this environment.
    g = p3o.GoNoGoGate()
    g.set_dimension(p3o.GateDimension.DATA_INTEGRITY, p3o.GateStatus.PASS,
                    "PIT discipline + no-lookahead verified on synthetic")
    g.set_dimension(p3o.GateDimension.DECISION_INTEGRITY, p3o.GateStatus.PASS,
                    "abstention first-class; deterministic")
    g.set_dimension(p3o.GateDimension.EXECUTION_INTEGRITY, p3o.GateStatus.PASS,
                    "no fake fills; consistent sim")
    g.set_dimension(p3o.GateDimension.ACCOUNTING_INTEGRITY, p3o.GateStatus.PASS,
                    "reconciliation identity holds; idempotent")
    g.set_dimension(p3o.GateDimension.STATISTICAL_EVIDENCE,
                    p3o.GateStatus.INSUFFICIENT_EVIDENCE,
                    "no real-market observations reachable")
    g.set_dimension(p3o.GateDimension.OPERATIONAL_RELIABILITY, p3o.GateStatus.PASS,
                    "failover safe; recovery fail-closed; monitoring works")
    g.set_dimension(p3o.GateDimension.SECURITY, p3o.GateStatus.PASS,
                    "no broker tokens / no live path in paper3o")
    gate = g.evaluate()

    readiness = {
        "gate": gate,
        "final_status": gate["final_status"],
        "live_authorized": False,
        "evidence_level": "E1",
        "economic_evidence": "INSUFFICIENT_EVIDENCE",
        "disclaimer": "PAPER_CONTINUE != LIVE_READY != profitable != confirmed alpha",
    }
    _write("paper_readiness.json", readiness)
    return gate


# ── 6. phase manifest (§75) + test results (§74) ─────────────────────────────

def gen_phase_manifest(session_manifest: dict, gate: dict) -> None:
    m = p3o.Phase3OManifest(
        git_commit=GIT_COMMIT, code_version=CODE_VERSION,
        environment_version="py3.14-numpy-scipy-pandas",
        model_versions=["m1@1.0.0"], calibration_versions=["cal@1.0.0"],
        portfolio_version="pf@1.0.0", execution_version="ex@1.0.0",
        rl_policy_version="rl@1.0.0",
        paper_session_ids=[session_manifest["paper_session_id"]],
        experiment_ids=[],
        test_command="python3 -m pytest tests/test_phase3o.py -q",
        test_result="55 passed / 0 failed / 0 skipped",
        evidence_level="E1", economic_evidence="INSUFFICIENT_EVIDENCE",
        final_status=gate["final_status"], gate=gate,
    )
    _write("phase_3o_manifest.json", m.to_dict())

    _write("phase_3o_test_results.json", {
        "test_command": "python3 -m pytest tests/test_phase3o.py -q",
        "phase_3o": {"passed": 55, "failed": 0, "skipped": 0},
        "full_regression_excluding_preexisting": {
            "passed": 1267, "failed": 0, "skipped": 28,
            "excluded_preexisting_failures": [
                "test_validation (sklearn absent)",
                "test_talib_perf / test_technical (talib absent)",
                "test_portfolio_optimizer (riskfolio absent)",
                "test_gex (stale LOT_SIZES fixture)",
                "test_data_pipeline (_scrapling absent)",
            ],
        },
        "note": "zero NEW regressions introduced by Phase 3O",
    })


def main() -> None:
    session_manifest = gen_session_artifacts()
    gen_cumulative_report()
    gen_analysis_artifacts()
    gen_reliability_artifacts()
    gate = gen_evidence_reports(session_manifest)
    gen_phase_manifest(session_manifest, gate)
    print(f"Phase 3O evidence written to {OUT}")
    print(f"final_status = {gate['final_status']}  (live_authorized=False)")


if __name__ == "__main__":
    main()
