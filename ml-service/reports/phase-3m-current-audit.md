# Phase 3M — Current-Branch Audit

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service` (HEAD `37be45b`, Phase 3L)  
**Scope:** `src/{data,features,labels,meta,models,ranking,training,validation,monitoring,lifecycle,stability,execution,portfolio,rl}`, `prediction_provenance.py`, `schemas.py`, `server.py`, `tests/`.

---

## 1. Current Inference Flow

`server.py` (FastAPI) exposes ISOLATED per-model endpoints
(`/predict/regime|rankings|strategy|risk|portfolio|execution|price-regime|iv-regime`,
`/explain`, `/analytics/*`). Each endpoint calls ONE model and returns. **There
is no server-side chaining** of data → features → models → decision. The only
component that FUSES base-model predictions into a `BUY/SELL/WAIT/NO_TRADE`
decision is `meta.MetaDecisionEngine.decide(MetaInput) -> MetaOutput`, and it
consumes already-computed predictions (no data fetch, no feature engineering).

## 2. Current Training Flow

`src/training/` assembles feature+label matrices + `DatasetSnapshot` (Phase 3B).
Walk-forward validation lives in `src/validation/` (Phase 3A). No automatic
retraining hooks in the server.

## 3. Current Model Registry Flow

TWO registries, different concerns (both reused, not duplicated):
- `monitoring.model_registry.ModelRegistry` — runtime HEALTH (ModelState
  HEALTHY/WARNING/DEGRADED/DISABLED) + weight multipliers + retraining
  recommendations (never auto-retrains).
- `lifecycle` (Phase 3J) `ModelRegistry`/`ChallengerRegistry` — versioned
  identity, evidence-gated promotion, champion/challenger.

## 4. Current Provenance Flow

`prediction_provenance.py`: `PredictionProvenance` (TRAINED_MODEL/HEURISTIC/
INSUFFICIENT_EVIDENCE/UNAVAILABLE) + `DeploymentMode`
(RESEARCH/PAPER/SHADOW/VALIDATED_ML_ONLY) + `resolve_action()`. Phase 3J adds
`ModelIdentity`/`ModelProvenance` (dataset/feature/label/calibration/execution
versions + artifact hash). Phase 3B `DatasetSnapshot` fingerprints data.

## 5. Current Monitoring Flow

`src/monitoring/`: `drift_detector` (PSI/KS/JS), `feature_monitor`,
`performance_monitor` (Brier/log-loss/ECE/Sharpe/decay), `alerts`, `router`
(`/monitoring/*` incl. `record-outcomes`). Phase 3I `src/stability/`
(IC decay, drift, regime, signal health).

## 6. Current RL Flow

Phase 3L `src/rl/` — governed offline RL execution layer (causal env, safety
layer, offline agent, OPE, classification, challenger wiring). Pre-existing
`src/models/rl_executor.py` (SB3 PPO with its own synthetic simulator + raw
reward) is an ANTI-PATTERN, referenced by `_rule_based_execution` fallback only;
NOT used by Phase 3L/3M.

## 7. Current Portfolio Flow

Phase 3H `src/portfolio/` — `RiskModel`, `PortfolioOptimizer`, `ConstraintSet`,
`SizingEngine`, `Rebalancer`. `models/portfolio_optimizer.py` is the simpler
HRP/CVaR endpoint helper.

## 8. Current Execution / Backtest Flow

Phase 3G `src/execution/` — `BacktestEngine.run`, `compute_trade_cost`,
slippage, fill engine, position accounting, `NSECalendar`. This is the ONE
execution-simulation truth. Phase 3L `rl.SimulatorBridge` already wraps it.

## 9. Current Server / API Flow

FastAPI + CORS + `lifespan._load_models()` + monitoring router. **No broker /
order-placement / live-execution code anywhere** (verified). `/predict/execution`
returns an advisory `ExecutionDecision` from `_rule_based_execution`.

## 10. Missing Production / Shadow Boundaries

- No canonical end-to-end decision contract (`CanonicalDecision`).
- No explicit decision state machine.
- No shadow execution engine / immutable shadow ledger.
- No predicted-vs-realized reconciliation engine.
- No unified dependency-validation / compatibility / staleness gate.
- No kill-switch / safety-gate layer overriding ML.
- No deterministic replay manifest.
- No unified structured health (DATA/FEATURE/MODEL/CALIBRATION/ALPHA/RISK/
  EXECUTION/RL/SYSTEM).

These are exactly what Phase 3M adds — as an ORCHESTRATION layer, not new engines.

## 11. Inconsistent Schemas

Two `PredictionProvenance` enums exist: the top-level one
(`prediction_provenance.py`, lowercase values, re-exported by `schemas.py`) and a
separate one in `meta/schemas.py` (uppercase, more members). Phase 3M uses the
top-level one for governance and does not unify them (out of scope; documented).

## 12. Duplicated Logic

`models/rl_executor.py` duplicates execution simulation (own GBM sim) — flagged
in Phase 3L as an anti-pattern, left unmodified. Phase 3M must NOT add a second
simulator; it reuses Phase 3G.

## 13. Unsafe Fallbacks

`_rule_based_execution` in `server.py` and heuristic fallbacks in each `models/*`
class produce signals with `HEURISTIC` provenance. `resolve_action` already gates
these in VALIDATED_ML_ONLY mode. Phase 3M formalises fail-closed behaviour: a
missing MANDATORY dependency yields a NO_EXECUTION state, never a fabricated
0/0.5/1/latest-model substitute.

## 14. Fail-Open Behaviour

The per-model endpoints return 503 if a model is unloaded (fail-closed at the
HTTP layer) but there is no unified decision-level fail-closed gate. Phase 3M
adds the safety layer that overrides ML (risk-unavailable → BLOCK, never BUY).

## 15. Non-Determinism

Existing inference is largely deterministic given inputs; `models/rl_executor.py`
uses `np.random.*` (anti-pattern, unused by 3M). Phase 3M's pipeline is
deterministic and produces a replay manifest so a decision can be re-derived from
immutable inputs.

---

## Reuse Decisions (spec §38 — orchestrate, never duplicate)

| Capability | Reused from | Phase 3M role |
|-----------|-------------|---------------|
| Decision fusion | `meta.MetaDecisionEngine` | called by pipeline; not reimplemented |
| Deployment/provenance gating | `prediction_provenance` (`DeploymentMode`, `resolve_action`) | reused; LIVE explicitly blocked |
| Model identity / champion / challenger | `lifecycle` (3J) | RL/model registration; shadow via `ChallengerRegistry` |
| Execution simulation | `execution` (3G) via `rl.SimulatorBridge` (3L) | ONE simulator; shadow fills |
| Portfolio / risk | `portfolio` (3H) | portfolio/risk stage |
| Decay / drift / stability | `stability` (3I) + `monitoring` | health orchestration |
| Calibration metrics | `meta.calibration_engine` (3F) | calibration health |
| RL execution challenger | `rl` (3L) | RL stage + safety |
| Persistence | `lifecycle._storage` (atomic JSON/JSONL + FileLock) | decision store, shadow ledger, event log |
| Health registry | `monitoring.ModelRegistry` / `ModelState` | model health |

## Import Hygiene (critical)

`server.py` and `models.market_regime` fail to import in this environment
(`talib` missing). Therefore `src/decision/` and `src/shadow/` MUST NOT import
`server.py` or `models.market_regime` at module load; they depend only on
import-clean modules (`meta`, `monitoring`, `lifecycle`, `stability`, `execution`,
`portfolio`, `rl`, `prediction_provenance`, `schemas`) and lazy-import heavy
model classes only when actually invoked. Tests import clean modules only.

## Plan

12 tasks: audit → canonical schema+state → provenance+replay → validation/
compatibility/staleness → orchestrator pipeline → events+kill-switches → shadow
engine+ledger+reconciliation → health orchestration → api router → tests →
full suite+evidence → docs+CHANGES+commit.

**Expected honest posture:** research/shadow/paper only; LIVE forbidden; no
auto-retrain/recalibrate/promote; INSUFFICIENT_EVIDENCE is a valid outcome
throughout.
