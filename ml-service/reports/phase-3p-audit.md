# Phase 3P — Independent Architectural Audit (Task 1)

**Branch:** `refactor/improve-ml-service` · **HEAD:** `ff31a69`
**Mindset:** adversarial — assume the reported edge is wrong until the system survives
validation. Behavior is verified from code + executable probes, NOT from docstrings,
comments, phase names, test names, or generated reports (spec §5).

---

## 1. Scope inventored

`ml-service/src/`: data, deep, decision, execution, explainability, features, labels,
lifecycle, meta, models, monitoring, paper, paper3o, portfolio, ranking, rl, shadow,
stability, training, validation + `server.py`, `config.py`, `schemas.py`,
`prediction_provenance.py`, `gex.py`, `greeks.py`, `iv_regime_classifier.py`,
`price_forecaster.py`, `vol_surface.py`. Tests: 29 `test_*` files including
`test_phase3j`…`test_phase3o`.

Deep-audited the lifecycle layer (the primary red-team target this task):
`registry.py`, `champion.py`, `challenger.py`, `comparison.py`, `compatibility.py`,
`evidence.py`, `gates.py`, `promotion.py`, `artifact_integrity.py`, `_storage.py`,
`schemas.py` — reading actual enforced behavior, not documented intent.

## 2. Test baseline (executable, this environment)

- `tests/test_phase3j.py` (lifecycle): **81 passed / 1 skipped** (the skip is an
  sklearn-gated `test_reuses_acceptance_gate`).
- Pre-existing unrelated failures (dependency absence — carried from prior phases, NOT
  introduced here): `test_validation` (sklearn), `test_talib_perf` + `test_technical`
  (talib), `test_portfolio_optimizer` (riskfolio), `test_gex` (stale LOT_SIZES fixture),
  `test_data_pipeline` (_scrapling). Full-suite reconciliation is performed in Task 10.

## 3. Lifecycle behavioral map (verified) + strong invariants

Confirmed genuinely enforced (executable):

- **Registry immutability** — re-registering the same `(model_id, model_version)` with a
  different `artifact_hash` raises `ImmutabilityViolation`; identical re-register is an
  idempotent no-op. `ModelIdentity` is a frozen dataclass. (registry.py `register`.)
- **State machine** — `transition()` validates against `VALID_TRANSITIONS`; illegal
  transitions raise `InvalidTransition`; terminal states (REJECTED/RETIRED/ROLLED_BACK)
  are dead ends; audit log is append-only.
- **Artifact integrity** — `verify_artifact_integrity()` fails closed: forbidden
  `latest`/`current` alias → INTEGRITY_FAILURE (checked before existence); missing →
  ARTIFACT_MISSING; hash mismatch → INTEGRITY_FAILURE; `safe_load_guard()` raises. Tamper
  changes the hash (A≠B).
- **Evidence integrity** — `ModelEvidencePackage.freeze()` hashes content (excluding the
  hash field + generation time); `verify_integrity()` detects any content mutation;
  `final_oos_used_for_selection` forces LEVEL_D and BLOCKS promotion.
- **Promotion gate** — six structured gates (DATA/PREDICTIVE/CALIBRATION/EXECUTION/RISK/
  STABILITY), no black-box score; contamination → BLOCKED; insufficient n →
  INSUFFICIENT_EVIDENCE; unregistered challenger or tampered evidence → BLOCKED.
- **Champion pointer** is an immutable `model_id@model_version` identity, NOT a mutable
  `latest.pkl` alias. Rollback restores identity + evidence_package_id + promotion_id
  from history and never touches artifacts.
- **Crash-safety** — intent marker + `recover_pending()` prevents two-champions after a
  simulated mid-promotion crash (for the committed/uncommitted-pointer cases).

## 4. CONFIRMED DEFECTS (independent probes, reproduced from behavior)

Two HIGH-severity promotion-integrity defects were found AND FIXED this task (spec §79:
fix the defect, do not tune away evidence; §80: correctness/integrity defect is a valid
reason to change code). Both are affirmatively covered by new regression tests in Task 8.

### P3P-001 (HIGH · promotion/provenance) — compatibility not enforced in promote path
`CompatibilityChecker` existed but was **never wired into**
`PromotionOrchestrator.promote()` or `PromotionGate.evaluate()`. Probe: a challenger
trained on `feature_version=feat-v99` was PROMOTED over a champion on `feat-v3` purely
because its IC was higher. A model on a different feature/label contract could become
champion — a like-for-like-replacement / provenance violation.

**Fix:** `promote()` now computes feature_version + label_version compatibility
(via the existing `CompatibilityChecker`) against the current champion and returns a
BLOCKED decision on INCOMPATIBLE — before any state mutation. Compatible challengers
still promote (no false positive), verified by probe.

### P3P-002 (HIGH · promotion atomicity) — partial promote leaves divergent state
`_atomic_promote()` flipped the champion pointer (step 3) BEFORE advancing the registry
state (step 4). If the challenger was not `PROMOTION_ELIGIBLE`, `_advance_to_champion`
raised `PromotionError` **after** the pointer was flipped — leaving `champion=x@v1` while
the registry record stayed `REGISTERED`. `recover_pending()` then saw the pointer match
the intent target and mis-classified it as "committed", permanently retaining a champion
whose registry record was never advanced. Promotion was not truly atomic despite the
module docstring claiming it was.

**Fix:** eligibility is now validated UP FRONT — both in `promote()` (returns BLOCKED)
and defensively at the top of `_atomic_promote()` (raises before any write). An
ineligible challenger now causes ZERO state change: no champion pointer, registry
unchanged, no dangling recovery intent (verified by probe). `test_phase3j.py` still
passes 81/1-skip after the fix.

## 5. Other attack surfaces flagged for deeper tasks (not yet concluded)

- Registry has **no expired/revoked** concept; unknown `get()` returns `None` (no raise) —
  callers must fail closed on `None` (verify in Task 4).
- `read_jsonl()` silently drops corrupt/tampered audit lines — audit-tamper concealment
  risk (Task 4).
- `identity_hash` excludes `created_at`/`dataset_version`/`universe_version` — potential
  identity collision (Task 4).
- `comparison.py` `same_*` flags are caller-asserted booleans, not verified against the
  snapshot; comparison is not wired into promote (Task 4 — INFO/MEDIUM).
- Challenger `_set_status` performs no transition validation (Task 4).

## 6. Preliminary security signal (full audit in Task 9)

Grep for broker-order tokens (`place_order`/`submit_order`/`placeOrder`/`SmartConnect`/
`generateSession`) across `ml-service/**/*.py` returns hits ONLY inside test guard lists
(`test_phase3l/m/n/o`), NONE in production `src/`. Probability-semantics discipline looks
strong (`meta/calibration.py` explicitly removed a `clip(raw_score,0,1)` bug and returns
UNCALIBRATED/0.5-neutral; `meta_ranker.py` clips a SCORE range with an explicit comment).
Both are re-verified independently in Tasks 6 and 9 rather than trusted from comments.

## 7. Claim → code → test → artifact map (seed; extended by the evidence ledger, Task 2)

| Claim | Code path | Test | Evidence level (independent) |
|---|---|---|---|
| Registry rejects mutated artifact identity | `registry.register` | `test_immutable_artifact_rejected` + P3P new | E1 (synthetic/unit) |
| Artifact tamper detected | `artifact_integrity.verify_artifact_integrity` | `test_tamper_detected` | E1 |
| Contaminated OOS never promotes | `gates._data_gate` / `PromotionGate.evaluate` | `test_final_oos_contamination_blocks` | E1 |
| Promotion atomic / no half-state | `promotion._atomic_promote` + recovery | P3P `test_promotion_fail_closed` / `test_rollback_atomicity` | E1 (after P3P-002 fix) |
| Incompatible challenger cannot promote | `promotion.promote` compat gate | P3P `test_model_registry_red_team` | E1 (after P3P-001 fix) |
| Live-order path unreachable from ml-service | (absence) | P3P `test_live_order_path_unreachable` | E1 |

## 8. Task 1 disposition

Architecture inventoried; lifecycle behavior mapped from code; baseline recorded; two HIGH
promotion-integrity defects found, reproduced, and fixed with the existing 3J suite still
green. Remaining attack surfaces enumerated for Tasks 3–9. No live path, no promotion, no
retrain/recalibrate performed.
