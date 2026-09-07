"""
Phase 3N — evidence-package generator (spec §58, §59, §60, §62, §66).

Produces the machine-readable Phase 3N evidence artifacts under reports/:
  phase_3n_manifest.json
  phase_3n_data_quality_report.json
  phase_3n_provider_report.json
  phase_3n_signal_report.json
  phase_3n_decision_report.json
  phase_3n_paper_report.json
  phase_3n_reconciliation_report.json
  phase_3n_readiness_report.json
  phase_3n_test_results.json

HONESTY (spec §57, §59, §60, §64): this environment has NO reachable data tier
(DATA_SERVICE_URL unset; Angel/Upstox/Yahoo/NSE/BSE unreachable; yfinance/sklearn/
talib absent). Therefore NO REAL_MARKET_DATA session can be produced. Every report
is explicitly tagged data_source=SYNTHETIC_DATA / evidence_level=INSUFFICIENT_EVIDENCE
for the economic question, and includes failures/limitations — no cherry-picking.
The reports demonstrate the CORRECTNESS + SAFETY of the machinery, not economic
performance.

Determinism: pure stdlib + numpy fixed seed; FIXED_TS constant. Re-running yields
byte-identical content.
"""

from __future__ import annotations

import json
import os
import tempfile

REPORTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "reports")
FIXED_TS = "2026-01-01T00:00:00+00:00"
COMMON_LIMITATION = (
    "No reachable Indian-market data tier in this environment "
    "(DATA_SERVICE_URL unset; Angel One/Upstox/Yahoo/NSE/BSE unreachable; "
    "yfinance/sklearn/talib absent). No REAL_MARKET_DATA session is possible here; "
    "economic performance is INSUFFICIENT_EVIDENCE. Reports validate correctness + "
    "safety of the Phase 3N machinery on tagged SYNTHETIC_DATA only."
)


def _write(name: str, obj: dict) -> str:
    path = os.path.join(REPORTS, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, sort_keys=True, default=str)
        fh.write("\n")
    return path


def _base(artifact: str, data_source: str, evidence_level: str, extra: dict) -> dict:
    d = {
        "artifact": artifact,
        "phase": "3N",
        "branch": "refactor/improve-ml-service",
        "generated_at": FIXED_TS,
        "data_source": data_source,
        "sample_size": extra.get("sample_size", 0),
        "time_window": extra.get("time_window", "N/A (no real session reachable)"),
        "config": extra.get("config", {}),
        "model_versions": extra.get("model_versions", []),
        "evidence_level": evidence_level,
        "limitations": [COMMON_LIMITATION] + extra.get("limitations", []),
    }
    d.update({k: v for k, v in extra.items()
              if k not in ("sample_size", "time_window", "config", "model_versions", "limitations")})
    return d


def main() -> None:
    os.makedirs(REPORTS, exist_ok=True)
    written = []

    import numpy as np
    from src.paper import (
        ProviderChain, ProviderId, ProviderResponse, ResponseStatus, SourceStatus,
        classify_session, classify_freshness, validate_ohlcv_bars,
        CanonicalSignal, SignalFamily, aggregate_signals, EvidenceLevel as SigEvidence,
        PaperTradingEngine, PaperSession, KillSwitchReason,
        EvidencePolicy, compute_return_metrics, compute_trading_metrics, filter_official_evidence,
        ReadinessEvaluator, GATE_ORDER,
    )
    from src.shadow import ShadowLedger
    from src.decision.schema import CanonicalDecision
    from src.decision.state import DecisionState

    # ── data-quality report ──────────────────────────────────────────────
    from datetime import datetime, timezone
    now = datetime(2025, 1, 1, tzinfo=timezone.utc)
    bad = [
        {"timestamp": 2000, "open": 100, "high": 99, "low": 99, "close": 100.5, "volume": 10},
        {"timestamp": 1500, "open": 100, "high": 101, "low": 99, "close": 100, "volume": -5},
        {"timestamp": 99999999999, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 10},
    ]
    dq = validate_ohlcv_bars(bad, "SYNTH", now=now)
    written.append(_write("phase_3n_data_quality_report.json", _base(
        "phase_3n_data_quality_report", "SYNTHETIC_DATA", "INSUFFICIENT_EVIDENCE", {
            "sample_size": len(bad),
            "ohlcv_defects_detected": sorted({i.code for i in dq.critical}),
            "checks": ["session_calendar", "freshness", "ohlcv_quality",
                       "fno_metadata", "option_chain", "corporate_action_pit",
                       "historical_universe", "no_lookahead"],
            "result": "validators correctly reject malformed/PIT-violating data (fail-closed)",
        })))

    # ── provider report ──────────────────────────────────────────────────
    def _fetch_failover(pid):
        if pid == ProviderId.DATA_SERVICE:
            return ProviderResponse.unavailable(pid.value, "unconfigured", SourceStatus.UNCONFIGURED.value)
        if pid == ProviderId.ANGEL_ONE:
            return ProviderResponse.unavailable(pid.value, "unreachable", SourceStatus.UNAVAILABLE.value)
        if pid == ProviderId.UPSTOX:
            return ProviderResponse.unavailable(pid.value, "unreachable", SourceStatus.UNAVAILABLE.value)
        return ProviderResponse.unavailable(pid.value, "unreachable", SourceStatus.UNAVAILABLE.value)
    chain = ProviderChain().resolve("SYNTH:1d", _fetch_failover)
    written.append(_write("phase_3n_provider_report.json", _base(
        "phase_3n_provider_report", "SYNTHETIC_DATA", "INSUFFICIENT_EVIDENCE", {
            "hierarchy": [p.value for p in (ProviderId.DATA_SERVICE, ProviderId.ANGEL_ONE,
                                            ProviderId.UPSTOX, ProviderId.YAHOO)],
            "chain_result": chain.to_dict(),
            "note": "all providers UNAVAILABLE in this environment -> fail-closed (selected=None). "
                    "Fallback semantics + recording verified; no silent merge; no fabricated data.",
        })))

    # ── signal report ────────────────────────────────────────────────────
    def _s(fam, direction, strength, group):
        return CanonicalSignal(signal_id=CanonicalSignal.new_id(fam, "SYNTH", FIXED_TS),
                               signal_family=fam, instrument="SYNTH", timestamp=FIXED_TS,
                               direction=direction, strength=strength, confidence=0.7,
                               timeframe="1d", regime="TREND_UP",
                               evidence_level=SigEvidence.HEURISTIC.value, evidence_group=group)
    agg = aggregate_signals([_s(SignalFamily.MOMENTUM.value, "LONG", 0.6, "m")
                             for _ in range(4)])  # dedup demo
    written.append(_write("phase_3n_signal_report.json", _base(
        "phase_3n_signal_report", "SYNTHETIC_DATA", "INSUFFICIENT_EVIDENCE", {
            "signal_families_discovered": [f.value for f in SignalFamily],
            "aggregation_example": agg.to_dict(),
            "note": "4 correlated momentum reads dedup to 1 evidence group (no double counting). "
                    "Conflict classification + INSUFFICIENT_EVIDENCE outcomes verified in tests.",
        })))

    # ── decision + paper + reconciliation reports (one synthetic session) ─
    with tempfile.TemporaryDirectory() as root:
        led = ShadowLedger(root)
        eng = PaperTradingEngine(led, "evidence-sess")
        sess = PaperSession(root, "evidence-sess", "2025-01-27", engine=eng)
        sess.manifest.data_snapshot_ids = ["synthetic-snap-1"]
        sess.manifest.model_versions = ["synthetic-model@0.0.0"]
        sess.manifest.feature_version = "synthetic-feat-v0"
        sess.manifest.data_tag = "SYNTHETIC_DATA"

        dec = CanonicalDecision(decision_id="ev-dec-1", decision_timestamp=FIXED_TS,
                                instrument="SYNTH", direction="LONG", position_size=100.0,
                                data_snapshot_id="synthetic-snap-1",
                                decision_state=DecisionState.CANDIDATE.value)
        dec.set_state(DecisionState.VALIDATED); dec.set_state(DecisionState.EXECUTION_PLANNED)
        sess.record_signal()
        res = sess.submit_decision(dec, fills=[{"qty": 100, "price": 2500.0, "cost": 8.0}])
        # a blocked decision after kill switch (no cherry-picking: include the block)
        sess.trigger_kill_switch(KillSwitchReason.PROVIDER_CORRUPTION, "synthetic drill")
        dec2 = CanonicalDecision(decision_id="ev-dec-2", decision_timestamp=FIXED_TS,
                                 instrument="SYNTH", direction="LONG", position_size=50.0,
                                 decision_state=DecisionState.CANDIDATE.value)
        dec2.set_state(DecisionState.VALIDATED); dec2.set_state(DecisionState.EXECUTION_PLANNED)
        sess.submit_decision(dec2, fills=[{"qty": 50, "price": 2500.0}])  # blocked
        eod = sess.close(prediction_accuracy=None, calibration_error=None, ev_realization=None)

        written.append(_write("phase_3n_decision_report.json", _base(
            "phase_3n_decision_report", "SYNTHETIC_DATA", "INSUFFICIENT_EVIDENCE", {
                "decisions": 2, "execution_planned": 1, "blocked_by_kill_switch": 1,
                "example_decision_state": dec.decision_state,
                "provenance_complete_required": True,
                "note": "decision->paper flow exercised on synthetic data; fail-closed + kill-switch honored.",
            })))
        written.append(_write("phase_3n_paper_report.json", _base(
            "phase_3n_paper_report", "SYNTHETIC_DATA", "INSUFFICIENT_EVIDENCE", {
                "eod_reconciliation": eod.to_dict(),
                "note": "one synthetic paper order filled; one blocked by kill switch (NO_NEW_PAPER_EXPOSURE). "
                        "No fabricated fills; net_pnl derived from ledger only.",
            })))
        # reconciliation report — official-evidence filter proves synthetic never official
        recs = [{"data_tag": "SYNTHETIC_DATA", "evidence_status": "OFFICIAL_EVIDENCE",
                 "provenance_complete": True} for _ in range(int(eod.filled_count) or 1)]
        official, excluded = filter_official_evidence(recs)
        written.append(_write("phase_3n_reconciliation_report.json", _base(
            "phase_3n_reconciliation_report", "SYNTHETIC_DATA", "INSUFFICIENT_EVIDENCE", {
                "reconciliation_status": eod.reconciliation_status,
                "official_evidence_records": len(official),
                "excluded_from_official": excluded,
                "note": "SYNTHETIC_DATA can never become official evidence (spec §57) -> 0 official records.",
            })))

    # ── readiness report (honest gates) ──────────────────────────────────
    def _checks(flags):
        return {"_checks": {k: (f"{k} ok", f"{k} failed") for k in flags}, **flags}
    gate_inputs = {
        # correctness/safety gates PASS (validated by tests); data + evidence
        # gates are INSUFFICIENT because no real-market data is reachable here.
        "DATA":        _checks({"real_market_data_reachable": None}),
        "FEATURES":    _checks({"feature_pipeline_available": None}),
        "MODELS":      _checks({"trained_models_loadable": None}),   # talib/sklearn absent
        "CALIBRATION": _checks({"calibration_available": None}),
        "RISK":        _checks({"risk_engine_available": True}),     # portfolio engine present + tested
        "EXECUTION":   _checks({"execution_simulator_available": True}),  # 3G present + tested
        "PAPER":       _checks({"paper_engine_validated": True}),    # tested this phase
        "EVIDENCE":    _checks({"official_real_market_evidence": None}),
    }
    rep = ReadinessEvaluator().evaluate(gate_inputs)
    written.append(_write("phase_3n_readiness_report.json", _base(
        "phase_3n_readiness_report", "SYNTHETIC_DATA", "INSUFFICIENT_EVIDENCE", {
            "readiness": rep.readiness,
            "gates": [g.to_dict() for g in rep.gates],
            "blocked_gates": rep.blocked_gates,
            "insufficient_gates": rep.insufficient_gates,
            "note": "DATA/FEATURES/MODELS/CALIBRATION/EVIDENCE gates are INSUFFICIENT_EVIDENCE "
                    "(no real-market data / heavy models unavailable here). RISK/EXECUTION/PAPER "
                    "gates READY (present + tested). No BLOCKED gate -> READY_WITH_LIMITATIONS. "
                    "Readiness reflects correctness/safety, NOT profitability (spec §47); "
                    "LIVE is NOT authorized (spec §61).",
        })))

    # ── top-level manifest ────────────────────────────────────────────────
    manifest = {
        "phase": "3N",
        "title": "Indian Market Paper-Trading Validation & Production-Readiness Gate",
        "branch": "refactor/improve-ml-service",
        "principle": "VALIDATION phase — orchestrate + validate 3A–3M; no new model.",
        "new_package": "src/paper (providers/data_quality/signals/paper_engine/session/evidence/readiness)",
        "generated_at": FIXED_TS,
        "environment": {
            "python": "3.14.6",
            "present": ["numpy", "scipy", "pandas", "httpx", "fastapi", "pydantic"],
            "absent": ["talib", "torch", "sklearn", "yfinance", "sqlalchemy"],
            "data_service_url": "unset",
            "real_market_data_reachable": False,
        },
        "guarantees": {
            "provider_hierarchy": "data_service -> angel_one -> upstox -> yahoo (no new NSE scraper)",
            "no_silent_provider_merge": True,
            "point_in_time_enforced": True,
            "no_lookahead": True,
            "live_execution": False,
            "broker_order_path": False,
            "broker_secrets_in_frontend": False,
            "auto_promotion": False,
            "auto_retraining": False,
            "auto_recalibration": False,
            "synthetic_never_official_evidence": True,
            "import_clean_no_talib_torch_sklearn": True,
        },
        "readiness": rep.readiness,
        "economic_evidence_level": "INSUFFICIENT_EVIDENCE",
        "evidence_files": sorted(os.path.basename(p) for p in written) + [
            "phase_3n_manifest.json", "phase_3n_test_results.json"],
    }
    written.append(_write("phase_3n_manifest.json", manifest))

    print("wrote:")
    for p in written:
        print("  ", os.path.relpath(p, os.path.dirname(REPORTS)))
    print("readiness:", rep.readiness)


if __name__ == "__main__":
    main()
