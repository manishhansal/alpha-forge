# PHASE 3T — Final ML-Service Production Readiness, Security & Quant Certification

**Repository:** alpha-forge
**Branch:** `refactor/improve-ml-service`
**Commit at certification:** `abbc403` (PHASE_3S HEAD; 3T is additive on top)
**Python:** 3.14.6
**Date:** 2026-09-06
**Certification type:** FINAL GATE — independent audit of actual executable behavior (prior-phase claims NOT trusted)
**Live trading:** DISABLED (default and enforced)

---

## 1. Executive summary

AlphaForge's ML service is a deterministic, fail-closed, evidence-first Indian-market research and paper-trading stack. This final gate independently verified the critical path — data validation, PIT/leakage guards, ranking, meta-model, calibration, expected value, costs, execution, portfolio risk, decision engine, shadow/paper, monitoring, and the research factory — against actual code, and added 44 independent certification tests.

The service is **ENGINEERING_READY** and **PRODUCTION_READY_WITH_LIMITATIONS** as a research/paper platform. Alpha evidence is **INSUFFICIENT_EVIDENCE** (synthetic and historical machinery is green; no real profitable alpha has been established, and none is claimed). Live trading is **DISABLED**: there are zero live-order primitives in `ml-service/src`. No blocking condition (§62) was found.

The correct scientific conclusion: **ENGINEERING_READY / ALPHA_EVIDENCE_INSUFFICIENT.** Engineering readiness, alpha validation, and profitability are distinct; only the first is asserted.

## 2. Scope

The ML service (`ml-service/`): data reliability, features, labels, ranking, meta, calibration, EV, execution simulation, portfolio/risk, lifecycle, decision engine, shadow/paper, monitoring, validation, stability, research factory, security, and the decision API. Live broker order placement lives outside this boundary (TypeScript, gated) and is explicitly excluded from and isolated from the ML-service certification boundary.

## 3. Repository inventory

Categorized components (all under `ml-service/src/`, verified present and importable):
DATA (`data`, `data_reliability`), FEATURES (`features`), LABELS (`labels`), RANKING (`ranking`), META (`meta`), CALIBRATION (`meta`, `models`), MODELS (`models`), DEEP LEARNING (`deep`), RL (`rl`), EXECUTION (`execution`), PORTFOLIO (`portfolio`), RISK (`portfolio`, `decision`), LIFECYCLE (`lifecycle`), DECISION (`decision`), SHADOW (`shadow`), PAPER (`paper`, `paper3o`, `paper_ops`), MONITORING (`monitoring`), VALIDATION (`validation`), STABILITY (`stability`), RESEARCH (`research`), SECURITY (`data_reliability.security`, artifact guards), API (`decision.api`, `server.py`), OPERATIONS (`paper_ops`, `lifecycle`). Reports for phases 3C–3Q exist under `ml-service/reports/`. Test files `test_phase3a` … `test_phase3t` all present.

## 4. Phase 3A–3S audit

All phases verified as executable code (not labels). Summary:

| Phase | Area | Status | Evidence |
| --- | --- | --- | --- |
| 3A | Calibration/meta core | IMPLEMENTED | `src/meta`, test_phase3a |
| 3B | (foundational) | IMPLEMENTED | test_phase3b |
| 3C | Label integrity | IMPLEMENTED | `src/labels`, test_phase3c, reports/phase-3c-* |
| 3D | Feature quality/PIT | IMPLEMENTED | `src/features`, test_phase3d, reports/phase-3d-* |
| 3E | Cross-sectional ranking | IMPLEMENTED | `src/ranking/evaluation`, test_phase3e |
| 3F | Meta-model + calibration + EV | IMPLEMENTED | `src/meta`, test_phase3f |
| 3G | Execution simulation | IMPLEMENTED | `src/execution`, test_phase3g |
| 3H | Portfolio/risk | IMPLEMENTED | `src/portfolio`, test_phase3h |
| 3I | Alpha decay/stability | IMPLEMENTED | `src/stability`, test_phase3i |
| 3J | Champion/challenger lifecycle | IMPLEMENTED | `src/lifecycle`, test_phase3j |
| 3K | Deep learning (experimental) | IMPLEMENTED | `src/deep`, test_phase3k |
| 3L | RL (execution) | IMPLEMENTED | `src/rl`, test_phase3l |
| 3M | Decision engine/monitoring | IMPLEMENTED | `src/decision`, `src/monitoring`, test_phase3m |
| 3N | Indian-market validation | IMPLEMENTED | test_phase3n, reports/phase_3n_* |
| 3O | Paper evidence/go-no-go | IMPLEMENTED | `src/paper3o`, test_phase3o |
| 3P | Independent validation/red-team | IMPLEMENTED | `src/validation/evidence_audit`, `src/deep/leakage_tests`, test_phase3p |
| 3Q | Data reliability/security | IMPLEMENTED | `src/data_reliability`, test_phase3q |
| 3R | Paper operations | IMPLEMENTED | `src/paper_ops`, test_phase3r (59 tests) |
| 3S | Research factory | IMPLEMENTED | `src/research`, test_phase3s (77 tests) |

No phase found MISSING or BLOCKED. Regression across all of them passes.

## 5. Architecture

The verified flow matches the target: Indian market data → canonical normalization → PIT validation → data quality → historical universe → feature engine → market regime → cross-sectional ranking → strategy candidate → meta model → calibration → expected value → portfolio/risk → execution simulation → decision engine → shadow/paper → reconciliation → monitoring → evidence/research factory. The `DecisionPipeline` (`src/decision/pipeline.py`) is the canonical orchestrator; every dependency is validated in order and any missing/invalid input fails closed (no BUY/SELL fallthrough). No uncontrolled bypass of the decision engine was found.

## 6. Data certification

Provider hierarchy (Data Service/Scrapling → Angel One → Upstox → Yahoo) is preserved behind the data-service boundary; no uncontrolled NSE scraping in the TS production layer (per the retained Phase 3Q/3N audits). `validate_data` rejects missing snapshot (DATA_UNAVAILABLE), unparseable/future timestamps (DATA_INVALID), stale data (DATA_UNAVAILABLE), and instrument mismatch (DATA_INVALID). Verified by certification tests.

## 7. PIT certification

Future timestamps, future-dated calibration, future returns in covariance estimation, and future features are all rejected or invalidated. `validate_data` future-timestamp → DATA_INVALID; `validate_calibration` future fit-time → CALIBRATION_UNAVAILABLE; `RiskModel.estimate` returns_end > formation → UNAVAILABLE; `future_label_probe`/`future_scaler_probe` detect look-ahead. No future information silently enters a model input. **PASS.**

## 8. Feature certification

Features carry documented provenance and PIT metadata (Phase 3D + research feature registry). Leakage guards (`future_label_probe`, `future_scaler_probe`, normalization-causality checks) reject future-dependent features. Certification test confirms a leaky scaler-fit is caught.

## 9. Label certification

Labels are versioned and point-in-time (Phase 3C, `src/labels/registry`). Meta-label leakage is guarded by the OOS-prediction requirement (`RawProbabilityScore.assert_oos`) and EV leakage guard.

## 10. Ranking certification

`ranking.evaluation` computes IC/Rank IC/ICIR/deciles cross-sectionally per timestamp, never globally. Rank IC independently matches `scipy.stats.spearmanr` in a certification test. Alpha scores are typed `ScoreType.ALPHA_SCORE` and never mislabeled as probabilities.

## 11. Meta-model certification

Meta pipeline (`src/meta`) enforces OOS primary predictions (`assert_oos`), separates raw vs calibrated probability, and computes EV downstream of calibration. No final-OOS tuning path in the research factory (sealed OOS, §24).

## 12. Calibration certification

Calibration is OOS-aware (`CalibrationQualityV2.eval_is_oos`). A raw score clipped to [0,1] is never labeled CALIBRATED — `CalibratedProbability.unavailable` is the only factory for a missing calibrator, and `is_usable()` requires status==CALIBRATED. Missing/mismatched/stale/future calibration → CALIBRATION_UNAVAILABLE. **PASS.**

## 13. EV certification

`ExpectedValueCalculator.compute` implements `EV = P·E[win] + (1-P)·E[loss] - cost`. Independently recalculated in certification tests (deterministic + hypothesis property test) — matches to 1e-6. Missing probability → PROBABILITY_UNCALIBRATED (value None); missing payoff → OUTCOME_DATA_INSUFFICIENT; missing cost → EV numeric but status COST_DATA_UNAVAILABLE (not VALID, not takeable); leakage → INSUFFICIENT_EVIDENCE. No missing input yields a favorable default EV. **PASS.**

## 14. Cost certification

`compute_trade_cost` uses versioned, point-in-time Indian cost schedules (brokerage/STT/exchange/GST/SEBI/stamp duty). Certification test confirms PIT versioning (F&O STT 0.01% pre-2023 vs 0.0125% from 2023) and that stamp duty applies to the BUY side only. Costs are configurable/versioned, not hardcoded-as-empirical. **PASS.**

## 15. Execution certification

Phase 3G `FillEngine`: default NEXT_OPEN, `allow_same_close=False`, slippage always applied. Certification confirms `fill_price != signal_price`, SAME_CLOSE rejected by default, and missing next bar → UNAVAILABLE. No `signal price == fill price` assumption. **PASS.**

## 16. Portfolio certification

`RiskModel.estimate` uses only historical returns (np.cov/EWMA/Ledoit-Wolf/OAS) with PSD repair and condition checks; the portfolio package forbids `np.random`. Certification confirms deterministic covariance and the PIT gate. No synthetic/random covariance is used as market evidence. **PASS.**

## 17. Stability certification

Phase 3I provides rolling IC/Rank IC/ICIR, IC decay, half-life, feature/prediction/calibration drift, and regime decay (`src/stability`). Unstable alpha is not labeled validated; the research factory's incremental-alpha verdicts (NO_OOS_ALPHA / INSUFFICIENT_EVIDENCE) prevent overclaiming.

## 18. Deep-learning certification

Deep models (`src/deep`) are experimental and gated by leakage probes (causality, future-scaler, label-permutation, negative-control) and incremental-alpha checks. Torch is absent in this environment, so deep-model runtime tests are dependency-skipped; deep learning is **NOT** claimed to add incremental value here — `NO_INCREMENTAL_ALPHA` is the honest default. Status: PARTIAL (framework present, runtime unexercised without torch).

## 19. RL certification

RL (`src/rl`) is execution/trade-management focused, is a challenger only, and is rejected on OOD/invalid-action by `validate_rl`. It is never promoted and never reaches a broker. Without demonstrated incremental execution value, `NO_INCREMENTAL_EXECUTION_ALPHA` is the honest status. Status: PARTIAL (framework present, not promoted).

## 20. Lifecycle certification

`src/lifecycle` provides immutable model identity + artifact hashing, champion/challenger registry, promotion gates (fail-closed), human-approval boundary, and rollback. No mutable `latest.pkl` champion mechanism. Promotion requires evidence and human approval.

## 21. Decision certification

The `DecisionPipeline` consumes validated data/features/model/calibration/EV/risk/portfolio state and emits explicit `DecisionState` values. No unsafe fallback becomes an executable trade; the happy-path terminal is EXECUTION_PLANNED (a simulated intent), never a broker order. Full fail-closed matrix verified. **PASS.**

## 22. Shadow/paper certification

Phase 3O/3R provide immutable sessions, event-sourced ledgers with idempotency and hash-chaining, realistic fills (reusing FillEngine), reconciliation with typed discrepancies, crash recovery, and replay. 59 Phase 3R tests + 77 Phase 3S tests pass.

## 23. Research-factory certification

Phase 3S: falsifiable hypotheses + pre-registration, immutable experiment identity/hash, versioned snapshots, feature registry, baseline-first, ablation, placebo/negative controls, HPO governance, multiple-testing (Bonferroni/Holm/BH + Deflated Sharpe + PBO + Reality Check), reproduction, immutable artifacts, lineage. Failed experiments preserved; no post-hoc mutation; recommend-only challenger boundary (never promotes).

## 24. Reproducibility

Deterministic seeds and immutable snapshots underpin reproduction. `ExperimentArtifact` freeze/verify_integrity/reproduce detects tampering and mismatch (REPRODUCTION_FAILURE). Risk covariance is bit-repeatable. Certification tests confirm reproduction mismatch is detected and integrity verified.

## 25. Security

Zero hardcoded secrets in `ml-service/src` (independent grep). Evidence packages and experiment artifacts reject credentials (`contains_secret` / `ArtifactSecretLeak`). No `NEXT_PUBLIC_*` secret vars in the frontend. **PASS.**

## 26. Live-order boundary

Independent grep of `ml-service/src` for `place_order|submit_order|execute_order|placeOrder|create_order|broker.order|live_order|place_trade` → **zero matches** (asserted in a certification test). Live-capable broker code is TypeScript (`src/services/india/broker/openalgo-adapter.ts`), gated by `assertLiveTradingEnabled()` (throws unless `LIVE_TRADING_ENABLED==="true"`), not importable from Python, and outside the certification boundary. **NO accidental live order possible from the ML service.**

## 27. Failure injection

Missing/invalid data, missing model, revoked model, missing calibration, risk-engine unavailable, constraint breach, missing simulator, abstention, future timestamp — all verified fail-closed to the correct terminal DecisionState. EV missing-input matrix and FillEngine reject/unavailable paths verified.

## 28. Mutation testing

Test-the-tests: leaky scaler fit → detected; future feature → detected; altered artifact metric → reproduction failure; tampered artifact on disk → integrity failure (via Phase 3S suite); corrupt one pipeline input → fail-safe. Guards detect each injected fault.

## 29. Independent calculations

EV independently recalculated (deterministic + property-based) — matches implementation to 1e-6. Rank IC independently matches `scipy.stats.spearmanr`. India cost PIT schedule boundaries independently checked. Net-PnL identity (`net = gross - costs - slippage`) asserted as a property.

## 30. Regression results

Full suite 3A–3T (excluding 6 known dependency-absence files): **1570 passed / 28 skipped / 0 failed** (baseline 1526 + 44 new 3T). Zero new regressions. Two pre-existing numpy divide warnings in test_phase3d (not errors).

## 31. Performance

The decision pipeline and EV/cost/fill calculations are pure-Python/numpy and complete in milliseconds; the full 3T suite runs in ~1.7s and the full regression in ~7s. No memory-growth or leak issues observed in the deterministic tests. Latency monitoring exists in Phase 3R (`compute_latency`).

## 32. Risk register

See `ml-service/reports/PHASE_3T_RISK_REGISTER.md`. No Critical risks. High risks relate to alpha-evidence insufficiency and dependency-absence test coverage gaps (torch/talib/sklearn), both explicitly documented.

## 33. Known limitations

Synthetic/historical-only evidence; no real profitable alpha established; deep-learning and RL runtime unexercised (torch absent); sklearn-dependent tests skipped (cloudpickle); statistical operating points provisional; paper evidence not yet accumulated on real market data.

## 34. Evidence certificate

See `ml-service/reports/PHASE_3T_EVIDENCE_CERTIFICATE.md` for versions, hashes, test/security/reproducibility/independent-calculation/failure-injection results.

## 35. Final readiness level

**LEVEL 3 — Paper operationally reliable**, trending toward Level 4 for engineering. Not Level 4 as a *trading* service because alpha evidence is insufficient and real paper sessions have not accumulated. Engineering is Level-4-grade (fail-closed, reproducible, secured, tested); trading readiness is gated on evidence.

## 36. Final recommendation

Certify the ML service as **ENGINEERING_READY / PRODUCTION_READY_WITH_LIMITATIONS** for research and paper operations, with **ALPHA_EVIDENCE: INSUFFICIENT_EVIDENCE** and **LIVE_TRADING: DISABLED**. Do not enable live trading. Do not promote any model based on this certification. Next step (separate, authorized phase): accumulate real/high-fidelity paper sessions and run real research experiments through the factory to build genuine alpha evidence and calibrate statistical operating points. Install torch/talib/sklearn in a certified environment to exercise the deep/RL/portfolio-optimizer test paths.

---

**PHASE_3T_STATUS: PASS**
**ML_SERVICE_READINESS: PRODUCTION_READY_WITH_LIMITATIONS**
**ALPHA_EVIDENCE: INSUFFICIENT_EVIDENCE**
**LIVE_TRADING_STATUS: DISABLED**
