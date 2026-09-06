# Phase 3J — Current Model Lifecycle Audit

**Date:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Auditor:** Automated (pre-implementation audit)

---

## 1. Summary

`src/lifecycle/` does **not exist**. There is **no champion/challenger, no promotion
workflow, and no versioned model-artifact registry** anywhere in the codebase.

However, a rich set of provenance, versioning, hashing, acceptance-gate, and
immutable-persistence primitives already exists and MUST be reused rather than
duplicated.

---

## 2. What Already Exists

### 2.1 `ModelAcceptanceGate` (`src/validation/metrics.py`) — REUSE AS-IS

- `ModelAcceptanceGate(thresholds).evaluate(fold_results, stability, aggregate_clf, aggregate_trd) -> AcceptanceDecision`
- `AcceptanceDecision(accepted, score, reasons, warnings, thresholds_checked)`
- `AcceptanceThresholds` (min_accuracy, min_sharpe, max_drawdown, min_stability_score, etc.)
- `FinancialMetricsEvaluator`, `compute_stability()`, `aggregate_fold_results()`
- `ValidationResult` + `save_validation_result()` / `load_validation_history()` —
  already writes **immutable, never-overwritten, timestamped** JSON audit files.

**Phase 3J MUST integrate this gate. Acceptance ≠ Promotion.** Phase 3J adds a
separate PromotionGate on top.

### 2.2 `ModelRegistry` (`src/monitoring/model_registry.py`) — EXTEND / ADJACENT

- In-memory **health-state** registry: `ModelState` = HEALTHY/WARNING/DEGRADED/DISABLED
- Per-model runtime health + weight multipliers + retraining recommendations
- JSON persistence via `persist_path`; thread-safe (`threading.Lock`)
- **Has NO champion/challenger, NO artifact storage, NO promotion, NO evidence gating.**

This is a DIFFERENT concern (runtime health). Phase 3J's versioned model registry
is separate. Reuse the `ModelState` enum and JSON-persistence pattern — do NOT
recreate the health-state machine.

### 2.3 Provenance / versioning / hashing primitives — REUSE

| Primitive | Location | Reuse for |
|-----------|----------|-----------|
| `DatasetSnapshot` (dataset_id, source_fingerprint SHA-256, never-overwrite save) | `data/dataset_version.py` | Dataset identity in provenance |
| `_compute_fingerprint()`, `_get_git_commit()` | `data/dataset_version.py` | Reproducibility hash, git commit |
| `DatasetLineage`, `MLObservationLineage` | `data/lineage.py` | Lineage patterns |
| `CalibratorArtifact.is_compatible(model_id, model_version)` | `meta/calibration_engine.py` | Calibrator compatibility check |
| `CalibrationQualityV2` (model_id, calibrator_id, calibration_version) | `meta/schemas.py` | Calibrator lineage |
| `BacktestConfig.config_hash`, `BacktestProvenance` | `execution/backtest_engine.py` | Execution lineage |
| `PortfolioProvenance` (portfolio/risk/constraint/sizing versions) | `portfolio/schemas.py` | Portfolio lineage |
| `ExperimentManifest` | `ranking/schemas.py` | Reproducibility manifest fields |
| `PredictionProvenance` / `DeploymentMode` (RESEARCH/PAPER/SHADOW/VALIDATED) | `prediction_provenance.py` | Shadow/paper gating |
| Phase 3I `SignalHealth`, `ICDecayResult`, `DataCoverageReport` | `stability/schemas.py` | Stability evidence |
| `PointInTimeValidator` | `data/point_in_time.py` | PIT enforcement |

### 2.4 SHA-256 hashing status

- Dataset/config-level SHA-256 exists (`source_fingerprint`, `config_hash`).
- **Model artifact-file hashing does NOT exist.** No `src/models/*.py` save method
  computes a SHA-256 over the saved artifact file.
- **Phase 3J must build artifact-content hashing.**

---

## 3. Anti-Patterns Found

### 3.1 Fixed-filename model loading (`server.py::_load_models()`)

```python
regime_path = artifacts / "market_regime.json"
ranker_path = artifacts / "stock_ranker.txt"
strategy_path = artifacts / "strategy_selector.cbm"
```

No version, no hash, no manifest, no champion-pointer indirection — startup loads
whatever file sits at the fixed name. This is the moral equivalent of `latest.pkl`.

**Phase 3J provides the champion-pointer + integrity-verified loading contract to
replace this. (server.py is not rewired in this phase — that is a deployment step —
but the registry API exists so a future change can use it.)**

There is NO literal `latest.pkl` / `current_model` symlink anywhere.

---

## 4. Dependencies

| Need | Available? | Decision |
|------|-----------|----------|
| SHA-256 | stdlib `hashlib` | Use it |
| JSON persistence | stdlib `json` | Use it (matches existing pattern) |
| Cross-process lock | `filelock` NOT installed | Use stdlib `os.O_CREAT|O_EXCL` atomic lock file |
| Atomic write | — | temp-file + `os.replace` (atomic on POSIX) |
| sqlite | stdlib `sqlite3` (unused) | Not needed; JSON files match existing convention |

**No new dependencies required.**

---

## 5. Gap Register — What Phase 3J Must Build

| Component | Status |
|-----------|--------|
| `src/lifecycle/` package | MISSING |
| Immutable `ModelIdentity` (model_id + version + artifact_hash + all versions) | MISSING |
| Model artifact SHA-256 hashing + integrity verification (fail-closed) | MISSING |
| `ModelSchemaContract` (input/output schema, prediction semantics) | MISSING |
| Compatibility checks (model/feature/label/calibrator/meta/execution/portfolio) | PARTIAL (calibrator only) |
| Persistent versioned `ModelRegistry` (register/get/list/promote/demote/rollback/retire) | MISSING |
| Immutable model versions | MISSING |
| Scoped `ChampionIndex` + champion history + historical lookup | MISSING |
| Challenger registry + shadow/paper mode + soak periods | MISSING |
| `ModelEvidencePackage` (frozen, hashed, A/B/C/D hierarchy) | MISSING |
| `PromotionGate` (PREDICTIVE/CALIBRATION/EXECUTION/RISK/STABILITY/DATA gates) | MISSING |
| Min-improvement config (configurable, versioned) | MISSING |
| Final-OOS contamination protection | MISSING |
| Apples-to-apples comparison + frozen eval dataset | MISSING |
| Multiple-testing / selection-bias tracking | MISSING |
| `PromotionManifest` (hashed) | MISSING |
| Atomic promotion + rollback + crash-safety | MISSING |
| Lifecycle state machine + invalid-transition rejection | MISSING |
| Audit log (all lifecycle events) | MISSING |
| Lineage (calibrator/meta/portfolio/execution/model DAG) | MISSING |
| Model cards + champion card | MISSING |
| Human-review policy (AUTO_APPROVED / HUMAN_APPROVAL_REQUIRED / AUTO_REJECTED) | MISSING |

---

## 6. Build Plan — `src/lifecycle/`

```
src/lifecycle/
├── __init__.py
├── schemas.py            — ModelIdentity, ModelProvenance, ModelSchemaContract,
│                           LifecycleState/ChallengerStatus/EvidenceLevel enums,
│                           PromotionDecision, GateResult, ModelCard, ChampionCard
├── artifact_integrity.py — SHA-256 artifact hashing, verify_integrity (fail-closed)
├── evidence.py           — ModelEvidencePackage (frozen + hashed), A/B/C/D hierarchy
├── compatibility.py      — all compatibility checks
├── registry.py           — persistent versioned registry, atomic writes, file lock,
│                           audit log, idempotency, immutability, state machine
├── champion.py           — scoped ChampionIndex, history, historical lookup
├── challenger.py         — challenger registry, shadow/paper, soak, selection bias
├── gates.py              — AcceptanceGate integration + PromotionGate (6 gates),
│                           min-improvement config, final-OOS protection
├── comparison.py         — apples-to-apples comparison, frozen eval snapshot
└── promotion.py          — PromotionManifest, rollback, crash-safety, lineage,
                            model cards, human-review policy
```

Persistence: JSON files under a configurable registry root, atomic temp+rename
writes, `os.O_CREAT|O_EXCL` lock file for cross-process safety. No new deps.
