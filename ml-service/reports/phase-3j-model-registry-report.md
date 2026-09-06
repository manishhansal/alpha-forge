# Phase 3J — Model Registry Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Status:** PASS (framework)  
**Champion state:** NO_PROMOTION — INSUFFICIENT_EVIDENCE (no real dataset loaded)

---

## 1. Scope

Phase 3J builds the model lifecycle, champion/challenger, evidence registry, and
evidence-gated promotion system (`src/lifecycle/`). This report documents the
registry architecture. Because no real prediction/outcome dataset is loaded, no
model is promoted — the registry contains no champion, which is the correct and
preferred state (spec §81).

---

## 2. Components Built

| Module | Purpose |
|--------|---------|
| `src/lifecycle/schemas.py` | `ModelIdentity` (frozen), `ModelProvenance`, `ModelSchemaContract`, `LifecycleState` machine, `PromotionDecision`, `GateResult`, `ModelCard`, `ChampionCard`; 10 enums |
| `src/lifecycle/artifact_integrity.py` | SHA-256 artifact hashing (file + directory), fail-closed `verify_artifact_integrity`, `safe_load_guard`, forbidden-reference blocking |
| `src/lifecycle/evidence.py` | `ModelEvidencePackage` (frozen + hashed), evidence hierarchy A/B/C/D |
| `src/lifecycle/compatibility.py` | model/feature/label/calibrator/meta/execution/portfolio compatibility checks |
| `src/lifecycle/_storage.py` | atomic JSON writes (temp + `os.replace`), JSONL audit, cross-process `FileLock` |
| `src/lifecycle/registry.py` | persistent versioned `ModelRegistry`, immutability, state machine, audit log, idempotency |
| `src/lifecycle/champion.py` | scoped `ChampionIndex`, history, historical lookup, atomic promotion, rollback |
| `src/lifecycle/challenger.py` | `ChallengerRegistry`, shadow/paper mode, soak periods, selection-bias tracking |
| `src/lifecycle/gates.py` | `PromotionGate` (6 structured gates) + configurable `PromotionPolicy` |
| `src/lifecycle/comparison.py` | apples-to-apples comparison on a frozen eval snapshot |
| `src/lifecycle/promotion.py` | `PromotionOrchestrator`, `PromotionManifest`, atomic promotion, rollback, crash-safety, model cards |

---

## 3. Registry Architecture

### 3.1 Layout

```
registry_root/
├── models/<model_id__at__version>.json   — one immutable record per model version
├── champions/<scope>.json                — current champion pointer per scope
├── challengers/<challenger_id>.json      — challenger records
├── manifests/<promotion_id>.json         — hashed promotion manifests
├── promotion_intents/<scope>.json        — crash-safety intent markers
├── cards/<full_key>.json                 — model cards
├── audit_log.jsonl                       — append-only lifecycle audit log
├── champion_history.jsonl                — append-only champion history
├── rollback_history.jsonl                — rollback events
├── recovery_log.jsonl                    — crash-recovery events
├── selection_bias.jsonl                  — tested/rejected/promoted counters
├── shadow_log.jsonl                      — shadow-mode outputs
└── .*.lock                               — cross-process lock files
```

### 3.2 Immutability

`(model_id, model_version)` is the immutable registry key. Re-registering the
same version with a DIFFERENT `artifact_hash` raises `ImmutabilityViolation`.
Re-registering with the identical hash is an idempotent no-op.

### 3.3 Atomicity & concurrency

- All writes use temp-file + `os.replace` (atomic on POSIX).
- Cross-process safety via `os.O_CREAT | os.O_EXCL` lock files with stale-lock
  recovery. No `filelock`/`portalocker` dependency required.

### 3.4 Audit log

Every lifecycle event (REGISTER, VALIDATE, EVIDENCE_READY, CANDIDATE,
SHADOW_START, PAPER_START, PROMOTION_ELIGIBLE, PROMOTED, REJECTED, ROLLBACK,
RETIRED) is appended to `audit_log.jsonl` with timestamp, actor, object,
previous_state, new_state, reason, and evidence.

---

## 4. Model Identity (spec §3)

Immutable `ModelIdentity` (Python `frozen=True`) includes:
`model_id, model_family, model_type, model_version, artifact_hash, created_at,
training_start, training_end, code_version, dataset_version, dataset_snapshot_id,
universe_version, feature_version, label_version, label_config_hash,
training_config_hash, hyperparameter_hash, random_seed`.

A model is never identified only by "LightGBM" or "v2".

---

## 5. Lifecycle State Machine (spec §58)

```
REGISTERED → VALIDATING → EVIDENCE_READY → CANDIDATE
→ SHADOW → PAPER → PROMOTION_ELIGIBLE → CHAMPION
```

Alternative exits: REJECTED / BLOCKED / RETIRED / ROLLED_BACK / ABSTAINED.

Invalid transitions (e.g. REGISTERED → CHAMPION, RETIRED → CHAMPION) raise
`InvalidTransition`. Terminal states (REJECTED/RETIRED/ROLLED_BACK) cannot
become champion without a fresh lifecycle.

---

## 6. Current Registry State

| Item | Value |
|------|-------|
| Registered models | 0 (no real models loaded) |
| Champions | 0 |
| Challengers | 0 |
| Promotions | 0 |
| **Overall** | **NO_PROMOTION — INSUFFICIENT_EVIDENCE** |

A system with no champion is preferred over one that promotes an inadequately
evidenced model (spec §81).

---

## 7. Test Results

| Metric | Value |
|--------|-------|
| Phase 3J tests | 82 |
| Passed | 81 |
| Skipped | 1 (sklearn transitive dep unavailable in env) |
| Failed | 0 |
| Full suite (3C–3J) | 534 passed / 0 failed |

---

## 8. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real Indian equity/F&O dataset is loaded. The
registry, promotion gates, and rollback are verified end-to-end on synthetic
evidence packages. No production model is promoted.
