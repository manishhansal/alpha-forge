# Phase 3R — Paper-Trading Operational Reliability

**Scope:** Long-running, deterministic, auditable **paper-trading** operations layer for `ml-service`.
**Package:** `ml-service/src/paper_ops/` (additive; reuses existing Phase 3G/3O/3P/3Q components).
**This is NOT a live-trading phase.** No live broker connection, no live order submission, no live credentials, no alpha/threshold/weight optimization from paper results, no auto retrain/recalibrate/promote.

> Operational correctness and statistical validity are **separate gates**. This layer establishes operational correctness on synthetic evidence. It does **not** upgrade evidence status merely because tests pass.

---

## 1. Package layout

| Module | Responsibility |
| --- | --- |
| `session.py` | Immutable `PaperSession` identity, state machine, config-mutation guard, evidence status |
| `validation.py` | 25 session-start gates (DATA / MODEL / RISK / EXECUTION), fail-closed |
| `events.py` | Event-sourced append-only ledger, deterministic ordering, idempotency, hash-chain |
| `accounting.py` | Order/fill bridge over `execution.fill_engine.FillEngine`, position + F&O accounting, daily MTM |
| `reconcile.py` | Ledger reconciliation → typed discrepancies, end-of-day boundary |
| `reliability.py` | Crash recovery, provider/model/risk failure handling, kill switches, degraded modes |
| `analytics.py` | Abstention, paper performance + uncertainty, benchmarks, attribution, drift evidence, aggregation |
| `evidence_package.py` | Immutable evidence package, manifest, hashes, replay determinism |
| `monitoring.py` | Operational heartbeat, latency monitoring, 24-point daily session report |

All modules are import-clean and reuse existing engines rather than reimplementing them.

---

## 2. Session lifecycle & state machine

`PaperSession` carries immutable identity: session id, trading date, market, strategy + model identity, champion + calibrator identity, portfolio + execution config, cost/slippage version, data-snapshot + feature version, decision-policy version, config hash, start/end timestamps, status, evidence status.

State machine (`PaperOpsState`):

```
CREATED → INITIALIZING → RUNNING ⇄ PAUSED
                           RUNNING → DEGRADED ⇄ RUNNING
                           RUNNING → COMPLETED → RECONCILING → RECONCILED
                           (any)   → FAILED
                           (any)   → INVALIDATED
```

Terminal states: `RECONCILED`, `FAILED`, `INVALIDATED`. Transitions are validated by `is_valid_paper_ops_transition`; illegal transitions raise `InvalidPaperOpsTransition`. There is **no LIVE state** anywhere in the machine.

**Immutability:** model, calibrator, feature version, portfolio, cost/slippage config, thresholds, risk limits and data snapshot **must not change silently**. Any config mutation raises `ConfigMutationError`; the correct response is to terminate the session and start a new one. `PaperSession.__post_init__` calls `assert_not_live(mode)` — construction with a live mode is rejected.

---

## 3. Session-start validation

`validate_session_start(context)` runs **25 gates** across four groups (DATA / MODEL / RISK / EXECUTION). The gate set is **fail-closed**: any mandatory gate failing produces `SessionStartBlocked` (outcome `BLOCKED`). A session is **never** started silently in a degraded state.

---

## 4. Event model & ledger

Canonical event types (`OpEvent`, 26 values) span `SESSION_CREATED` … `SESSION_INVALIDATED`. Each `OpEventRecord` carries event id, session id, sequence, type, event/market timestamps, instrument, payload, provenance, config hash, and `prev_event_hash`. `content_hash` is a chained SHA-256 (16-hex) digest.

`EventStore(root, session_id)` is **append-only, idempotent, and restart-safe**:
- Duplicate `event_id` → ignored.
- Duplicate business key (same order / fill / signal) → ignored (no double state).
- Restart replays the ledger without duplicating events.

`detect_ordering_anomalies` flags `DUPLICATE_SEQUENCE`, `MISSING_SEQUENCE`, `OUT_OF_ORDER`, and `HASH_CHAIN_BREAK`. `is_chain_intact` verifies the hash chain end-to-end.

---

## 5. Order / fill lifecycle & accounting

Paper fills delegate **100%** to the existing Phase 3G `execution.fill_engine.FillEngine` through a bridge (`simulate_paper_fill`). There is **no second fill engine**. Fill realism (next-bar, market/limit, spread, slippage, volume/liquidity, gaps, circuits, price bands, partials, trading hours, lot size, short) is inherited from that engine.

**No perfect fills:** signal price ≠ execution price. A perfect-fill condition raises `PerfectFillError`. When the next bar is unavailable the fill status is `UNAVAILABLE` (never fabricated).

`PaperPosition` / `PaperPositionLedger` track qty, average entry, realized/unrealized/gross/net PnL, fees, slippage, turnover and exposure, with an F&O identity guard (contract/expiry/strike/type/lot never silently changed; correct lot enforced). `compute_daily_mark` produces reproducible daily MTM (gross/net exposure, unrealized/realized, fees, slippage, drawdown, turnover, concentration).

---

## 6. End-of-day & reconciliation

`run_end_of_day` requires the session to be `COMPLETED` and performs the ordered `EOD_SEQUENCE` (10 steps: stop decisions → complete valid fills → mark → apply costs → compute PnL/risk → reconcile → validate ledger → freeze evidence → generate report). **No auto-roll** to the next day; each trading day is an explicit session boundary.

`reconcile_ledgers` compares decision vs order vs fill vs position vs PnL ledgers and emits typed `DiscrepancyKind` values (`MISSING_ORDER`, `EXTRA_ORDER`, `MISSING_FILL`, `DUPLICATE_FILL`, `POSITION_MISMATCH`, `QUANTITY_MISMATCH`, `PRICE_MISMATCH`, `PNL_MISMATCH`, `COST_MISMATCH`, `TIMESTAMP_MISMATCH`). Discrepancies are **never silently repaired**. Verdicts: `RECONCILED`, `RECONCILED_WITH_WARNINGS`, `RECONCILIATION_FAILED`, `INVALIDATED`. A session **cannot** be `RECONCILED` with unresolved discrepancies.

---

## 7. Crash recovery & failure handling

`recover_session` (phases in `RecoveryPhase`, outcomes in `RecoveryOutcome`) restores exact state from the durable event ledger after a crash at any point (startup, after signal/decision/order/fill/partial, before/after position update, during reconciliation/close) with **no duplicate events/orders/fills** and the **same final PnL**. No critical state is in-memory-only.

- **Provider failure** (`provider_failure_action`): Angel/Upstox/Yahoo down, all-down, stale, conflict, timeout, rate-limit → suppress decision or pause by severity. Never trade from invalid data.
- **Model failure**: missing/corrupt/incompatible artifact, missing/mismatched calibrator, schema mismatch, prediction failure, invalid probability → no new trade; existing positions handled by approved deterministic safety logic. Predictions are never fabricated.
- **Risk failure**: max position/exposure/drawdown/concentration/liquidity/turnover/daily-loss/instrument-unavailable → `RISK_BLOCK`, no bypass.

`evaluate_operational_safety` combines these into an overall posture.

**Kill switches** (`KillSwitchScope`: GLOBAL / STRATEGY / INSTRUMENT / DATA / RISK / EXECUTION via `KillSwitchRegistry`) are deterministic, auditable, fail-safe and recoverable. **Degraded modes** (`DegradedMode` / `DegradedState`) are explicit (DATA / PROVIDER / MODEL / CALIBRATION / EXECUTION / RECONCILIATION_DEGRADED), never a vague `healthy=false`.

---

## 8. Analytics (evidence & attribution only)

Every analytic is **evidence/attribution only** and never optimizes.

- `summarize_abstention` — TAKE/SKIP/ABSTAIN/INSUFFICIENT_EVIDENCE/DATA_UNAVAILABLE/RISK_BLOCK frequencies (`optimization_performed=False` invariant).
- `paper_performance` — returns/risk/trading metrics with bootstrap CIs; metrics below 30 observations are marked `INSUFFICIENT_EVIDENCE`. Never claims significance on tiny samples.
- `benchmark_relative` / `Benchmark` — NIFTY buy-hold, sector, cash, simple trend/momentum, TWAP, VWAP-proxy.
- `AlphaAttribution` — beta/sector/factor/selection/timing/execution/costs (attribution only).
- `performance_by_regime` / `MarketRegime` — reports **every** regime (no cherry-pick).
- `signal_family_activity` — documented overlaps + double-counting warning; **no reweight**.
- `DriftEvidence` (`auto_action_taken=False` invariant) — evidence/alerts only; **no auto retrain/recalibrate/promote**.
- `INVALIDATION_REASONS` (10) — future-info, corrupt snapshot, invalid ts, model-id change, config change, ledger corruption, reconciliation failure, duplicate corruption, live interaction, incomplete provenance.
- `can_claim_tier` — E0/E1/E2 always; E3 needs ≥20 official sessions and ≥2 regimes; **E4/E5 can never be claimed from paper** (require independent validation).
- `aggregate_sessions` — aggregates **OFFICIAL sessions only**; non-official excluded (counted, contribute 0).

---

## 9. Evidence package, manifest & replay

`EvidencePackage.freeze` writes 12 sections (`EVIDENCE_SECTIONS`: data, decisions, orders, fills, positions, pnl, risk, reconciliation, model, configuration, monitoring, report) plus `manifest.json` and `hashes.json` via atomic writes.
- **No overwrite:** raises `FileExistsError` if the package already exists (§38 — changes require a new version).
- **No credentials:** raises `EvidenceSecretLeak` if any section contains a secret (§47).
- `verify_integrity` recomputes and compares section hashes → detects tampering.

`SessionManifest` records full identity + hashes + final status; `compute_evidence_hash` hashes the section hashes.

`replay_session(package, recompute_fn)` reconstructs decisions/orders/fills/positions/PnL from the immutable evidence and compares hashes. A mismatch produces `REPLAY_MISMATCH` (and the session should be invalidated). `RngProvenance` records the seed and RNG version for determinism.

---

## 10. Monitoring

- `OperationalHeartbeat` — seven dimensions (process alive, data freshness, decision loop, provider status, event sequence, reconciliation state, session state). **Alive ≠ healthy**: process dead / data stale / broken event sequence / failed reconciliation → `UNHEALTHY`; other single failures → `DEGRADED`.
- `compute_latency` / `LatencyThresholds` — data / feature / inference / decision / total latency from injected stage timestamps; missing timestamps yield `None` (not fabricated); alerts fire above thresholds.
- `build_paper_session_report` — 24-point daily `PAPER_SESSION_REPORT`.

---

## 11. Security & live-order boundary

- **Security (§47):** evidence freeze rejects secrets; events and health payloads are redacted via the Phase 3Q `redact_mapping` / `contains_secret` guards. No credentials appear in evidence, logs, or manifests.
- **Live-order boundary (§48):** a grep of `ml-service/src` for live-order primitives (`place_order`, `submit_order`, `execute_order`, `placeOrder`, `broker.order`, `live_order`, `place_trade`) returns **zero matches**. `PaperSession` rejects `mode='live'` via `assert_not_live`. Allowed deployment modes are `{RESEARCH, SHADOW, PAPER}`. Live-capable broker code exists only in the TypeScript frontend (`src/services/india`, `src/lib/market-data`) and is **not reachable** from the ml-service paper path and holds no credentials. Classification: all ml-service order paths = **PAPER/SHADOW**; live-capable code is isolated and disabled.

---

## 12. Known limitations & approximations

- **Synthetic-only evidence.** All tests run on deterministic synthetic data. No real paper-trading sessions have been accumulated.
- **No live credentials / no real market interaction.** Real-market behavior is not exercisable in this environment.
- **Insufficient evidence.** Because no real sessions exist, statistical evidence status is `INSUFFICIENT_EVIDENCE`. Operational machinery is green; statistical validity is a separate, unmet gate.
- **Margin is approximated** for F&O accounting (no live broker margin feed).
- **Retry logic uses no real sleep** (synthetic harness convention inherited from Phase 3Q); wall-clock timing is injected, not measured.
- No live path, no threshold/weight optimization, no auto retrain/recalibrate/promote — by design.
