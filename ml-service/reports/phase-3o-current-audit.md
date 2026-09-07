# Phase 3O — Current-Branch Audit

**Branch:** `refactor/improve-ml-service`  **HEAD:** `611b4f7` (PHASE_3N_PASS)
**Phase:** 3O — Paper-Trading Evidence Accumulation, Reliability & Go/No-Go Gate
**Nature:** VALIDATION / EVIDENCE phase. No new predictive model. Determine whether
the existing AlphaForge system is operationally reliable, statistically credible,
economically meaningful after costs, reproducible, robust across regimes, safe under
failure, and sufficiently evidenced for continued paper operation — producing a
`PAPER_CONTINUE` / `PAPER_BLOCKED` / `PAPER_CONTINUE_WITH_LIMITATIONS` decision.

This audit traces actual execution paths (not filenames) and records what Phase 3O
builds on. It is read-only; no source was changed.

---

## 0. Environment reality (unchanged from Phase 3N — determines evidence ceiling)

| Dependency | State | Consequence |
|-----------|-------|-------------|
| Python | 3.14.6 | ok |
| numpy / scipy / pandas / fastapi / pydantic | present | paper/decision/execution/portfolio runnable |
| talib / torch / sklearn | **absent** | `server.py`, `models.market_regime`, `src/validation` fail import; heavy model inference not runnable here |
| yfinance / sqlalchemy | **absent** | Tier-3 (Yahoo) + Tier-2 (PostgreSQL) providers not runnable |
| `DATA_SERVICE_URL` | **unset** | Tier-0 Scrapling data-service not reachable |
| network to Angel/Upstox/NSE/BSE/Yahoo | **unavailable** | no live acquisition |

**Consequence for Phase 3O:** no `REAL_MARKET_DATA` paper session can be produced in
this environment. Per §52/§72/§73, fabricating one would invalidate the evidence and
is a hard-stop violation. Phase 3O therefore validates **correctness, safety,
determinism, accounting integrity, reconciliation, recovery, statistical machinery,
and the go/no-go gate** on clearly-tagged `SYNTHETIC_DATA`, and reports the economic
question as `INSUFFICIENT_EVIDENCE` (evidence tier ≤ E1 for economics; the machinery
itself is E1/E2-validatable).

## 1. Canonical layers to reuse (verified present; do NOT re-implement)

- `src/decision/` (3M): `DecisionPipeline.evaluate(PipelineInputs)` fail-closed;
  `DecisionState` (no LIVE_EXECUTED); `assert_not_live`/`normalize_mode`;
  `ReplayManifest` (deterministic `replay_id`); `EventLog`; `SafetyLayer`.
- `src/execution/` (3G): `cost_model` (date-versioned Indian equity + F&O costs,
  PIT-correct), `slippage` (observed/proxy/parametric with evidence levels),
  `fill_engine.FillEngine` (gaps/circuits/price-bands/partial fills/F&O ban/expiry),
  `backtest_engine.BacktestEngine`, `position_accounting.TradeAccountingLedger`,
  `market_calendar.NSECalendar`.
- `src/shadow/` (3M): `ShadowExecutionEngine`, idempotent append-only `ShadowLedger`,
  `ReconciliationEngine`. No broker path; `assert_not_live` on order construction.
- `src/lifecycle/` (3J): `PromotionOrchestrator` human-gated (no auto-promote);
  `_storage` (atomic_write_json/read_json/append_jsonl/FileLock).
- `src/monitoring/`, `src/stability/`, `src/portfolio/`, `src/rl/`: drift/health,
  alpha stability, eligibility/constraints/risk/sizing, RL challenger + SimulatorBridge.
- `src/data/`: PIT stores (point_in_time / corporate_actions / fno_eligibility /
  historical_universe / instrument_master).

## 2. Phase 3N `src/paper/` surface (verified present; the Phase 3O foundation)

8 modules, 74 exports, import-clean (no talib/torch/sklearn/gymnasium at load):

- `providers.py` — `ProviderChain` (DataService→AngelOne→Upstox→Yahoo, explicit
  fallback states, no silent merge), `ProviderResponse` canonical contract,
  `cross_provider_compare`, `DataTag` (REAL_MARKET_DATA/REPLAY/SYNTHETIC/MOCK).
- `data_quality.py` — session/freshness/OHLCV/F&O/option-chain/CA/universe validation
  + `assert_no_lookahead` (all fail-closed, PIT-correct).
- `signals.py` — `CanonicalSignal` + `aggregate_signals` (dedup by evidence_group,
  conflict classification; resolution owned by DecisionPipeline).
- `paper_engine.py` — `PaperOrderState` machine (CREATED→…→CLOSED),
  `PaperTradingEngine` (idempotent, EXECUTION_PLANNED-only, no fabricated fills, no
  broker), `PaperPositionBook`; persists fills to `ShadowLedger`.
- `session.py` — `PaperSession` (manifest + EOD reconciliation + replay +
  restart recovery + kill switch → NO_NEW_PAPER_EXPOSURE), `EODReconciliation`.
- `evidence.py` — metrics with sample-size/effective-n/CI/status (INSUFFICIENT below
  policy), conditional breakdowns, bootstrap/block-bootstrap, BH/Bonferroni,
  `filter_official_evidence` (only REAL+OFFICIAL+complete-provenance counts).
- `readiness.py` — 8 readiness gates → `PaperReadiness` (no LIVE_READY member).

**Gap Phase 3O fills (net-new, on top of 3N):** a *session state machine* with the
richer §8 states (INITIALIZING/RUNNING/PAUSED/DEGRADED/FAILED/RECONCILING/RECONCILED
in addition to what 3N had), full §7 session metadata (git_commit/configuration_hash/
random_seed/environment_version), *multi-session* evidence accumulation + experiment
registry + evidence tiers E0–E5, the analysis layer (benchmarks / alpha attribution /
ablation / RL comparison / cost / turnover / capacity / calibration / EV validation /
decile monotonicity / cross-sectional / regime / signal-family / correlation / drift /
alpha-decay / latency), session-quality dimensions, reliability layer
(failure-rate / provider-reliability / failover / recovery / accounting invariants /
idempotency), and the 7-dimension **Go/No-Go gate**. All of these ORCHESTRATE the
existing layers; none re-implement a model or a second simulator/ledger.

## 3. Security & live-path posture (verified first-hand)

- `grep NEXT_PUBLIC_*(TOKEN|SECRET|KEY|PASSWORD|PIN|TOTP)` over the Next.js `src/`
  → **zero matches** (no secret inlined into the browser bundle).
- `grep place_order|submit_order|placeOrder|cancel_order|modify_order|SmartConnect|
  kiteconnect` over `ml-service/src/**.py` (excluding test guardrail lists and "No
  broker" docstrings) → **zero matches**. No reachable live-order path.
- Live mode fails closed at every choke point (`decision.pipeline`, `shadow` order +
  engine, `paper` order/engine/session). `PaperReadiness` has no LIVE_READY member.
- Auto-promotion human-gated; auto-retraining recommendation-only; auto-recalibration
  none. All remain **DISABLED**.

## 4. Test baseline

- Phase 3N suite: 62 passed. Full regression (3A–3N + vpin + meta + monitoring):
  **1129 passed / 0 failed / 28 skipped**.
- Pre-existing failures (unrelated, env/stale): `test_validation` (sklearn),
  `test_talib_perf` / `test_technical` (talib), `test_portfolio_optimizer`
  (riskfolio), `test_gex` (stale LOT_SIZES=75 constant), `test_data_pipeline`
  (`_scrapling` attribute). None involve `src/paper` or the Phase 3O scope.

## 5. Phase 3O plan (all orchestration, fail-closed, import-clean)

New package `src/paper3o/` (keeps the 3N `src/paper` surface stable and additive):
`session_lifecycle.py` (rich §7/§8 session + immutability/revisions),
`journals.py` (decision/order/position journals, §13/§15/§16),
`evidence_store.py` (multi-session accumulation + tiers E0–E5 + official/diagnostic +
experiment registry),
`analysis.py` (benchmarks / attribution / ablation / RL comparison / cost / turnover /
capacity),
`quality.py` (calibration / EV validation / decile monotonicity / cross-sectional /
regime / signal-family / correlation / drift / alpha-decay / latency + session-quality
dimensions),
`reliability.py` (failure-rate / provider-reliability / failover / recovery /
reconciliation invariants / idempotency),
`gate.py` (7-dimension Go/No-Go → PAPER_CONTINUE / _WITH_LIMITATIONS / _BLOCKED).

Everything reuses the verified 3A–3N layers; nothing enables live, auto-promotes,
auto-retrains, auto-recalibrates, adds a model, or tunes thresholds on paper results.
