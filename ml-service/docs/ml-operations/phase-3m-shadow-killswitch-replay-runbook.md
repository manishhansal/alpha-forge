# Phase 3M — Operations Runbook: Shadow Execution, Kill Switches & Replay

Audience: ML / trading operators. Scope: the Phase 3M decision pipeline
(`src/decision`) and hypothetical execution layer (`src/shadow`).

> **Non-negotiable:** Phase 3M has **no live broker path**. Nothing in this
> runbook can place a real order. Live / production modes fail closed. There is no
> auto-retraining, auto-recalibration, or auto-promotion.

---

## 1. Deployment modes

| Mode | Meaning | Serviceable |
|------|---------|-------------|
| `research` | Offline exploration; heuristics allowed | ✅ |
| `shadow` | Decisions logged + hypothetically executed via the 3G simulator | ✅ |
| `paper` | Same as shadow but tracked separately as paper trading | ✅ |
| `live` / `production` | **Forbidden** — raises `LiveExecutionForbidden` / HTTP 403 | ❌ |

Confirm the running surface at any time:

```
GET /decision/modes
→ { "live_enabled": false, "broker_execution_enabled": false,
    "auto_retrain_enabled": false, "auto_recalibrate_enabled": false,
    "auto_promote_enabled": false, ... }
```

If any of these ever reports `true`, **stop** — that is out of scope for Phase 3M.

## 2. Evaluating a decision

Upstream predictors produce a `PipelineInputs` bundle (data snapshot id, feature
version + schema hash, regime, model identity, meta output, calibration, EV,
portfolio, execution, optional RL). The pipeline sequences and gates them.

```
POST /decision/decision/evaluate
{ "deployment_mode": "shadow", "inputs": { ...PipelineInputs fields... } }
```

Outcomes:

- `decision_state = EXECUTION_PLANNED` and `executable = true` → all gates passed.
- Any `NON_EXECUTABLE_STATES` value (e.g. `DATA_UNAVAILABLE`, `MODEL_REVOKED`,
  `CALIBRATION_UNAVAILABLE`, `PORTFOLIO_REJECTED`, `BLOCKED`, `INSUFFICIENT_EVIDENCE`)
  → fail-closed; **do not** attempt to "fix" it by supplying a default. Fix the
  underlying dependency and re-evaluate.

Every evaluation emits an immutable audit trail:

```
GET /decision/decision/{decision_id}   → ordered DecisionEvents
```

## 3. Shadow / paper execution

Only an `EXECUTION_PLANNED` decision can be shadow-executed. The engine builds a
`ShadowOrder`, records it (idempotent — exactly once per `decision_id`), runs the
decision through the **reused Phase 3G simulator** (via the 3L `SimulatorBridge`),
maps the resulting trade into a `ShadowFill` (assumed price, slippage, fees, taxes,
total cost, net P&L, pinned simulator version), and completes the order.

```
POST /decision/shadow/execute
{ "deployment_mode": "shadow", "decision": {…CanonicalDecision…}, "market_bars": [...] }
```

- Re-submitting the same decision is a **no-op** (`executed: false`,
  reason `duplicate decision (idempotent)`).
- Corrections **never overwrite** history — call the ledger correction path, which
  appends a new `CORRECTION` event.

Read-only views:

```
GET /decision/shadow/orders          all shadow orders
GET /decision/shadow/positions       net hypothetical position per instrument
GET /decision/shadow/performance     net P&L / win rate / reconciled-fill count
GET /decision/reconciliation/{id}    predicted-vs-realized errors for a decision
```

Reconciliation errors are `null` when an input is genuinely absent — they are
**never fabricated**.

## 4. Kill switches & the safety layer

The safety layer runs as the final pipeline stage and **overrides ML output**. Any
tripped switch forces a non-executable state (usually `BLOCKED`):

| Kill switch | Trigger |
|-------------|---------|
| `DATA_UNSAFE` | data marked unsafe |
| `MODEL_REVOKED` | registry status REVOKED / DISABLED |
| `CALIBRATION_STALE` | calibration past its max age |
| `FEATURE_SCHEMA_MISMATCH` | runtime schema hash ≠ model’s |
| `EXCESSIVE_DRIFT` | drift beyond threshold (report — **no auto-swap**) |
| `EXECUTION_SIMULATOR_UNAVAILABLE` | simulator missing |
| `PORTFOLIO_RISK_BREACH` | risk unavailable or constraints breached |
| `RL_OOD` / `RL_POLICY_INVALID` | RL out-of-distribution or invalid policy |
| `PROVENANCE_MISSING` | provenance / replay manifest incomplete |
| `SYSTEM_HEALTH_DEGRADED` | health orchestration flags the system |

Operator response: a tripped switch is a **signal to investigate the dependency**,
not to bypass the gate. There is no override flag that forces execution.

### Health monitoring

```
GET  /decision/monitoring/report       counts of events / orders / fills / reconciliations
POST /decision/health/system           roll up supplied dimensions → blocking?/degraded?
```

`system_state` is structured. `UNSAFE` or `UNAVAILABLE` = **blocking**. Treat
`INSUFFICIENT_EVIDENCE` as "not enough data to judge" — it is neutral, not a pass.

## 5. Replaying a decision

Every decision carries a `DecisionProvenance` with a `ReplayManifest` capturing all
immutable input identities and a deterministic `replay_id`.

To replay: rebuild the exact `PipelineInputs` from the manifest’s pinned versions /
hashes / seeds and re-run `evaluate` with the **same** `decision_id`. The resulting
`content_hash` and `replay_id` must match the originals. A mismatch means an input
identity drifted (data snapshot, feature schema, model hash, calibration, seed, or
code/environment version) — investigate before trusting the newer result.

A worked manifest: `reports/phase-3m-replay-manifest-example.json`.

## 6. What operators must NOT do

- Do not enable a live / production mode (there is no supported path).
- Do not add a second execution simulator — always reuse Phase 3G.
- Do not auto-retrain, auto-recalibrate, or auto-promote in response to a health
  alert. Detection is automatic; remediation is a deliberate, separate, human-run
  research action.
- Do not edit the append-only ledgers or event logs. Corrections are new events.
