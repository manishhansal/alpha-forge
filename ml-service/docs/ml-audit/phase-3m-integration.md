# Phase 3M — Research-to-Production Integration, Shadow Execution & ML Operations

**Branch:** `refactor/improve-ml-service`
**Principle:** ORCHESTRATE phases 3A–3L into ONE canonical decision pipeline; never duplicate.
**Result:** `PHASE_3M_PASS`

---

## 1. Intent

Phase 3M does not add a new model or a new alpha source. It wires the already-built
and already-certified components of phases 3A–3L into a **single, canonical,
deterministic, fail-closed, replayable** decision pipeline, plus a hypothetical
(shadow / paper) execution layer and a structured ML-operations health surface.

Hard constraints (enforced in code and tests):

- **No live broker execution.** There is no broker code path anywhere in
  `src/decision` or `src/shadow` (verified by a static-audit test).
- **No auto-retraining, no auto-recalibration, no auto-promotion.** Degradation is
  detected and reported; it is never silently repaired.
- **LIVE / PRODUCTION deployment modes are forbidden** and fail closed.
- **Import-clean:** importing the package never pulls `talib`, `torch`, `sklearn`,
  or `gymnasium`. Heavy components are lazy-imported only when actually executed.

## 2. What is reused (never re-implemented)

| Concern | Reused from | How |
|--------|-------------|-----|
| Fused decision | 3F `MetaDecisionEngine` | pipeline consumes its output; never re-fuses |
| Execution simulator | 3G `BacktestEngine` | reached via 3L `SimulatorBridge`; **no second simulator** |
| Portfolio / risk | 3H | validated via `validate_portfolio` |
| Drift / stability | 3I | surfaced through health orchestration |
| Registry / storage | 3J `_storage`, `model_registry` | append-only JSONL persistence |
| RL challenger | 3L | optional downstream challenger, never bypasses safety |
| Provenance / governance | `prediction_provenance` | `DeploymentMode` / `resolve_action` reused; **no third provenance system** |

## 3. New packages

```
src/decision/         the ONE canonical decision pipeline
  schema.py           CanonicalDecision contract (spec §4)
  state.py            fail-closed DecisionState machine (spec §5)
  provenance.py       ReplayManifest + DecisionProvenance + LIVE-forbidden guard
  validation.py       dependency validation, model compatibility, staleness
  events.py           immutable event log + kill switches + SafetyLayer
  pipeline.py         DecisionPipeline orchestrator (fail-closed, 12 stages)
  monitoring.py       structured 9-dimension health orchestration
  api.py              minimal FastAPI router (research/shadow/paper; LIVE disabled)

src/shadow/           hypothetical execution — NEVER a broker
  shadow_order.py     ShadowOrder (assert_not_live on construction)
  shadow_fill.py      ShadowFill
  shadow_ledger.py    immutable append-only ledger (corrections = new events)
  shadow_engine.py    ShadowExecutionEngine (reuses 3G via SimulatorBridge)
  shadow_reconciliation.py  predicted-vs-realized reconciliation, aggregatable
```

## 4. Canonical decision flow (sequence)

The pipeline walks a fixed, ordered sequence of stages. Each stage returns a
`StageResult(stage, status, reason, version, latency_ms, failed_state)`. The FIRST
failing dependency drops the decision to a terminal non-executable state — the
pipeline **never** substitutes a default probability, a "latest" model, or a
"closest" calibration.

```
Caller (upstream predictors produce PipelineInputs)
   │
   ▼
DecisionPipeline.evaluate(inputs, decision_id, trace_id)
   │  normalize_mode(mode)            ── raises LiveExecutionForbidden on live/production
   │  build CanonicalDecision (CANDIDATE) + ReplayManifest + DecisionProvenance
   │
   ├─▶ 1  DATA          validate_data          ──fail──▶ DATA_UNAVAILABLE / DATA_INVALID
   ├─▶ 2  FEATURES      validate_features      ──fail──▶ FEATURES_UNAVAILABLE
   ├─▶ 3  REGIME        regime present?        ──fail──▶ REGIME_UNAVAILABLE
   ├─▶ 4  MODEL         validate_model         ──fail──▶ MODEL_UNAVAILABLE / MODEL_REVOKED
   │      COMPATIBILITY ModelCompatibility.check──fail──▶ MODEL_INCOMPATIBLE
   │      STALENESS     assess_staleness       ──fail──▶ MODEL_STALE / MODEL_REVOKED
   ├─▶ 5  META          consume MetaDecisionEngine output ──fail──▶ INSUFFICIENT_EVIDENCE
   ├─▶ 6  CALIBRATION   validate_calibration   ──fail──▶ CALIBRATION_UNAVAILABLE
   ├─▶ 7  EV            record expected value
   ├─▶ 8  ABSTENTION    abstain?               ──abstain▶ ABSTAIN
   │      GOVERNANCE    provenance.resolve()   ──NO_TRADE▶ INSUFFICIENT_EVIDENCE / SKIP
   │      set_state(VALIDATED)
   ├─▶ 9  PORTFOLIO     validate_portfolio     ──fail──▶ RISK_REJECTED / PORTFOLIO_REJECTED
   ├─▶ 10 EXECUTION     validate_execution     ──fail──▶ BLOCKED
   ├─▶ 11 RL CHALLENGER validate_rl (optional) ──fail──▶ BLOCKED
   ├─▶ 12 SAFETY LAYER  SafetyLayer.evaluate   ──trip──▶ BLOCKED (kill switch overrides ML)
   │
   ▼
set_state(EXECUTION_PLANNED)  ── executable=True
   │
   ▼
ShadowExecutionEngine.execute(decision, market_bars, mode)   [downstream, optional]
   │  assert_not_live(mode)
   │  ledger.record_order  ── idempotent, exactly-once per decision_id
   │  _simulate_fill  ── LAZY import → 3L SimulatorBridge → 3G BacktestEngine
   │  ledger.record_fill + complete_order    (append-only; corrections = new events)
   ▼
ReconciliationEngine.reconcile_from_fill   ── predicted vs realized (errors = None if absent)
```

Every stage transition and every kill-switch trip is emitted as an immutable
`DecisionEvent` to the append-only event log, giving a complete audit trail.

## 5. Fail-closed guarantee (spec §30)

Each mandatory dependency has a dedicated terminal state. When it is missing,
invalid, stale, revoked, incompatible, or unsafe, the decision lands in a state in
`NON_EXECUTABLE_STATES` and `decision.executable is False`. Notably:

- **Risk unavailable → BLOCK**, never a silent BUY.
- **Excessive drift → kill switch**, never an automatic model swap.
- **Future-dated data / features / calibration → rejected** (point-in-time violation).
- **Heuristic provenance in a validated-ML-only research gate → INSUFFICIENT_EVIDENCE**,
  never a fabricated trade.

## 6. Determinism & replay (spec §24)

`ReplayManifest` captures every immutable input identity (data snapshot, dataset /
feature / label / model / calibration / portfolio / execution / RL versions and
hashes, seeds, code + environment version, deployment mode). Its `replay_id` is a
stable SHA-256 over the sorted manifest (excluding `created_at`). Re-running the
same inputs yields the same `content_hash` and the same `replay_id`
(see `tests/test_phase3m.py::TestReplay`). A worked example lives in
`reports/phase-3m-replay-manifest-example.json`.

## 7. Health orchestration (spec §14–19, §28)

`HealthOrchestrator.assess()` rolls nine structured dimensions (DATA, FEATURE,
MODEL, CALIBRATION, ALPHA, RISK, EXECUTION, RL, and the system rollup) into a
machine-readable `SystemHealth`. States are structured
(`HEALTHY / WATCH / DEGRADED / UNSAFE / UNAVAILABLE / INSUFFICIENT_EVIDENCE`), not a
single opaque number. `UNSAFE` or `UNAVAILABLE` makes the system **blocking**.
`INSUFFICIENT_EVIDENCE` dimensions (e.g. an unused RL challenger) are **neutral** in
the rollup — they neither degrade nor block a healthy system.

## 8. API surface (spec §26)

`src/decision/api.py` exposes a minimal `APIRouter` (built lazily via `get_router()`).
It does **not** redesign `server.py`; it is mounted only if an operator chooses to.
Every mode-bearing endpoint distinguishes research / shadow / paper and rejects
live / production with HTTP 403. `GET /decision/modes` advertises
`live_enabled`, `broker_execution_enabled`, `auto_retrain_enabled`,
`auto_recalibrate_enabled`, and `auto_promote_enabled` — all `false`.

## 9. Tests

`tests/test_phase3m.py` — 64 tests, all passing: pipeline happy path + stage
contract; every fail-closed state; model compatibility; deterministic replay;
shadow execution via 3G with idempotency and append-only ledger; reconciliation;
health rollup; the §31 adversarial suite (future data/label/calibration,
NaN/negative prices, duplicate decision/fill, invalid transition, invalid schema,
live-mode rejection); and a static audit proving no broker tokens and
import-cleanliness.

**Reused-component regression:** phases 3A–3M + vpin + meta + monitoring —
1067 passed, 0 failed, 28 skipped. Phase 3M introduced zero regressions.
