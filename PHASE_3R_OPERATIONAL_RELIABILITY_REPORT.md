# PHASE 3R — Operational Reliability Report

**Phase:** 3R — Long-running paper-trading operational reliability layer
**Service:** `ml-service`
**Branch:** `refactor/improve-ml-service`
**Base commit:** `1547278` (PHASE_3Q)
**Date:** 2026-09-06
**Type:** ADDITIVE — new package `ml-service/src/paper_ops/`, no HEAD-tracked file modified
**This is NOT a live-trading phase.**

---

## 1. Executive summary

Phase 3R adds a deterministic, auditable, event-sourced **paper-trading operations** layer to `ml-service`. It establishes an immutable session model with an explicit state machine, fail-closed session-start validation, an append-only event ledger with idempotency and hash-chaining, an order/fill/position/F&O accounting layer that reuses the existing Phase 3G fill engine (no perfect fills), an end-of-day reconciliation engine emitting typed discrepancies, crash recovery and failure handling (provider/model/risk) with kill switches and explicit degraded modes, evidence-only analytics, an immutable evidence package with manifest/hashes/replay, and operational monitoring (heartbeat + latency + 24-point daily report).

**Operational correctness is achieved on synthetic evidence.** Statistical validity is a separate gate that is **not** met: no real paper sessions have been accumulated and no live credentials exist. Evidence status is therefore `INSUFFICIENT_EVIDENCE` and is deliberately **not** upgraded because tests pass.

## 2. Scope & non-goals

**In scope:** paper session lifecycle, event sourcing, order/fill/position/F&O accounting, daily MTM, end-of-day boundary, reconciliation, crash recovery, provider/model/risk failure handling, kill switches, degraded modes, decision journal, attribution (no reweight), abstention analysis, paper performance + uncertainty + benchmarks + attribution, drift evidence (no auto action), champion/challenger isolation, evidence tiers, session invalidation, multi-session aggregation, immutable evidence package + replay, heartbeat + latency + daily report, failure injection, security audit, live-order boundary audit.

**Non-goals (prohibited):** live orders/credentials, auto retrain/recalibrate/promote, threshold/weight optimization from paper, removing unfavorable trades/sessions, cherry-picking, altering historical evidence, silent repair/fabrication, treating insufficient evidence as success. No new models/DL/RL. No Phase 3S/3T. No refactor of existing code.

## 3. Entry audit (§0)

Verified Phase 3M–3Q exist as executable code (not just docs) before building 3R. Phase 3Q is the HEAD commit `1547278` and is on origin. Existing components reused by 3R:
- `execution.fill_engine.FillEngine` (Phase 3G) — fill realism.
- `paper.evidence` — return/trading/decision metrics + `EvidencePolicy`.
- `paper3o.session_lifecycle`, `paper3o.evidence_store.EvidenceTier` — lifecycle/manifest/tiers.
- `lifecycle._storage.atomic_write_json` — durable writes.
- Phase 3Q `security` (`redact_mapping`, `contains_secret`), `data_reliability` (SignalFamily, audit_notes).

Baseline regression (3A–3Q) confirmed at **1390 passed / 28 skipped** before 3R work. No blocking issue required fixing for 3R entry. 3R is purely additive; no HEAD-tracked file was modified.

## 4. Session model & state machine (§2–§4)

`PaperSession` — immutable identity (session/date/market/strategy+model/champion+calibrator/portfolio+execution config/cost+slippage version/data snapshot+feature version/decision policy version/config hash/timestamps/status/evidence status). State machine `PaperOpsState` (CREATED→INITIALIZING→RUNNING⇄PAUSED / →DEGRADED / →COMPLETED→RECONCILING→RECONCILED; →FAILED; →INVALIDATED). Terminal: RECONCILED/FAILED/INVALIDATED. No LIVE state. Illegal transitions raise `InvalidPaperOpsTransition`.

## 5. Session immutability (§4)

Config mutation of protected identity fields raises `ConfigMutationError`; correct response is terminate + start new session. `assert_not_live(mode)` in `__post_init__` rejects live construction.

## 6. Session-start validation (§3)

`validate_session_start` — 25 gates in 4 groups (DATA/MODEL/RISK/EXECUTION), fail-closed → `SessionStartBlocked` on any mandatory failure. Never starts degraded silently.

## 7. Event sourcing & ordering (§5–§6)

26 canonical `OpEvent` types. `OpEventRecord` with chained SHA-256 `content_hash`. `detect_ordering_anomalies` → DUPLICATE_SEQUENCE / MISSING_SEQUENCE / OUT_OF_ORDER / HASH_CHAIN_BREAK. `is_chain_intact` verifies the full chain.

## 8. Idempotency & restart safety (§7)

`EventStore` append-only, idempotent (dedup on event id + business key), restart-safe. Same order twice → 1 order; same fill twice → no double position; same bar twice → no duplicate decisions; re-run reconciliation → same result; restart → no duplicate state.

## 9. Order & fill lifecycle (§8–§9)

Paper fills delegate 100% to `execution.fill_engine.FillEngine` via `simulate_paper_fill` (no second engine). No perfect fills — signal price ≠ execution price; `PerfectFillError` guards against it; missing next bar → `FillStatus.UNAVAILABLE`.

## 10. Position & F&O accounting (§10–§12)

`PaperPosition` / `PaperPositionLedger` — long/short/partial/scale/reversal/stop/target/expiry/forced-close; qty/avg-entry/realized+unrealized+gross+net PnL/fees/slippage/turnover/exposure. F&O identity guard: correct lot enforced, metadata never silently changed.

## 11. Daily mark-to-market (§13)

`compute_daily_mark` — gross/net exposure, unrealized/realized, fees, slippage, net, drawdown, turnover, concentration. Reproducible.

## 12. End-of-day boundary (§14)

`run_end_of_day` requires `COMPLETED`; runs ordered `EOD_SEQUENCE` (10 steps). No auto-roll to next day; explicit session boundary per trading day.

## 13. Reconciliation engine (§15–§16)

`reconcile_ledgers` — decision vs order vs fill vs position vs PnL → typed `DiscrepancyKind` (10 kinds). Never silently repairs. Verdicts RECONCILED / RECONCILED_WITH_WARNINGS / RECONCILIATION_FAILED / INVALIDATED. Cannot be RECONCILED with unresolved discrepancies.

## 14. Crash recovery (§17–§18)

`recover_session` restores exact state from the durable event ledger at any crash point with no duplicate events/orders/fills and identical final PnL. Graceful and ungraceful restart covered. No in-memory-only critical state.

## 15. Provider / model / risk failure handling (§19–§22)

Provider (`provider_failure_action`): down/all-down/stale/conflict/timeout/rate-limit → suppress or pause by severity; never trade from invalid data. Model: missing/corrupt/incompatible/missing-calibrator/mismatch/prediction-fail/invalid-prob → no new trade, existing positions via approved deterministic safety logic; never fabricate predictions. Risk: limit breaches → `RISK_BLOCK`, no bypass. `evaluate_operational_safety` combines posture.

## 16. Kill switches & degraded modes (§23)

`KillSwitchRegistry` scopes GLOBAL/STRATEGY/INSTRUMENT/DATA/RISK/EXECUTION — deterministic, auditable, fail-safe, recoverable. `DegradedMode`/`DegradedState` explicit (DATA/PROVIDER/MODEL/CALIBRATION/EXECUTION/RECONCILIATION_DEGRADED), never a vague `healthy=false`.

## 17. Decision journal & attribution (§24–§25)

Decision journal authoritative (ts/instrument/side/alpha/rank/raw+calibrated prob/EV+cost+value/regime/risk+portfolio state/decision/abstention reason/model+feature+data identity). `signal_family_activity` attribution-only, documented overlaps + double-counting warning; **no reweight**.

## 18. Abstention & performance (§26–§28)

`summarize_abstention` — frequencies only (`optimization_performed=False`). `paper_performance` — returns/risk/trading metrics; `INSUFFICIENT_EVIDENCE` below 30 observations; no significance on tiny samples.

## 19. Statistical uncertainty & benchmarks (§29–§30)

Bootstrap CIs (seed 12345), Sharpe/hit-rate CIs, INSUFFICIENT_SAMPLE marking. Benchmarks: NIFTY buy-hold, sector, cash, simple trend/momentum, TWAP, VWAP-proxy.

## 20. Alpha / regime / signal-family attribution (§31–§33)

`AlphaAttribution` (beta/sector/factor/selection/timing/execution/costs). `performance_by_regime` reports every regime (no cherry-pick). Signal-family analysis avoids double-counting.

## 21. Model drift, champion/challenger, evidence tiers, invalidation (§34–§37)

`DriftEvidence` (`auto_action_taken=False`) — evidence/alerts only; no auto retrain/recalibrate/promote. Champion immutable per evidence period; challenger shadow-only, separate predictions. `can_claim_tier` — E4/E5 never from paper. `INVALIDATION_REASONS` (10) exclude sessions from aggregates.

## 22. Evidence package, manifest, replay & determinism (§38–§42)

`EvidencePackage.freeze` — 12 sections + manifest + hashes, atomic writes, no overwrite (`FileExistsError`), no credentials (`EvidenceSecretLeak`), `verify_integrity` tamper detection. `SessionManifest` full identity + evidence hash + final status. `replay_session` → `REPLAY_MISMATCH` on divergence + invalidate. `RngProvenance` records seed + RNG version.

## 23. Monitoring — heartbeat, latency, daily report (§43–§45)

`OperationalHeartbeat` — 7 dimensions; alive ≠ healthy. `compute_latency` — data/feature/inference/decision/total; missing ts → None (not fabricated); threshold alerts. `build_paper_session_report` — 24-point daily report.

## 24. Testing, failure injection & audits (§46–§51)

`tests/test_phase3r.py` — **59 deterministic tests** (tmp_path, injected timestamps, no network/creds). 12 classes: Session(7), Events(4), Accounting(6), Reconciliation(6), Reliability(5), Analytics(9), EvidencePackageMonitoring(6), FailureInjection(4 §46), TheTests(5 §50), Performance(2 §51), LiveBoundaryAndSecurity(3 §47/§48), Properties(2 hypothesis).
- **Failure injection (§46):** provider outage/stale/malformed/missing/dup bar/dup event/dup fill/crash/restart/corrupt model/missing calibrator/risk breach/reconciliation mismatch/clock skew/partial fill/unexpected termination → fail safe.
- **Test-the-tests (§50):** deliberately breaking event ordering/dedup/fill accounting/reconciliation/replay/PnL/session immutability/model identity → tests detect.
- **Performance (§51):** multi-session/high event count/restarts; state bounded.
- **Security (§47):** freeze rejects secrets; events/health redacted. CLEAN.
- **Live-order boundary (§48):** grep for live-order primitives across `ml-service/src` → **zero matches**. All ml-service order paths = PAPER/SHADOW. Live-capable broker code isolated in TS frontend, disabled, no creds.

## 25. Results, limitations, risks & final status

**Regression (3A–3R):** **1449 passed / 28 skipped** = baseline 1390 + 59 new 3R. **Zero new regressions.** (6 dep-absence test files excluded: test_validation, test_talib_perf, test_technical, test_portfolio_optimizer, test_gex, test_data_pipeline — talib/torch/sklearn/riskfolio/yfinance absent; unchanged from baseline.) 2 pre-existing numpy divide warnings in test_phase3d (not errors, not 3R). Import-clean: 79 exports.

**§53 acceptance gates:**
- Session — PASS (immutable identity, explicit state machine, no LIVE, config guard).
- Trading — PASS (reused fill engine, no perfect fills, F&O identity guard, reconciliation never silent).
- Evidence — PASS operationally (immutable package, hashes, replay determinism, no-overwrite, no-credentials).
- Reliability — PASS (crash recovery, provider/model/risk handling, kill switches, degraded modes).
- Statistics — machinery PASS; **evidence INSUFFICIENT** (no real sessions) — correctly reported, not upgraded.
- Security — PASS (no secrets in evidence/events/logs/manifests).
- Testing — PASS (59 deterministic tests incl. failure injection + test-the-tests + performance).

**Known limitations:** synthetic-only evidence; no live credentials / no real-market interaction; no real paper sessions accumulated; margin approximated for F&O; retry uses no real sleep (injected timing).

**Remaining risks:** statistical claims cannot be validated until real paper sessions accumulate; live-capable TS broker code must remain isolated and credential-free; approximations (margin, timing) documented and must not be mistaken for live behavior.

**Recommended next phase:** accumulate real (or high-fidelity) paper sessions under the 3R machinery to move statistical evidence toward sufficiency — as a separate, explicitly-authorized phase. No live path without a dedicated, separately-gated authorization.

**Final status:** `PHASE_3R_PASS`
