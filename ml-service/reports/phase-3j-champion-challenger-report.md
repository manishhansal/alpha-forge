# Phase 3J — Champion / Challenger Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Current champions:** NONE (no real models evaluated)

---

## 1. Scope

Documents the champion/challenger architecture and the current champion state.

---

## 2. Champion Architecture

### 2.1 Scoped champions (spec §10, §11)

There is NO single universal champion. Champions are SCOPED:

```
scope = asset_class / market / horizon / strategy_family / regime
```

Example: one model may be champion for `equity/5D` while another is champion
for `futures/1D`. Incompatible models are never compared.

### 2.2 Champion pointer

Each scope has an explicit `ChampionEntry`:
`scope, champion_full_key, promoted_at, previous_champion, promotion_reason,
evidence_package_id, promotion_id`.

"latest" is never a valid reference — the champion is an explicit
`(model_id, model_version)` pointer with integrity verification.

### 2.3 Champion history & historical lookup (spec §34, §53)

`ChampionIndex.history(scope)` returns the full append-only history.
`ChampionIndex.champion_at(scope, timestamp)` answers "which model was champion
at time T?".

---

## 3. Challenger Architecture

### 3.1 Challenger registry (spec §12)

Each challenger: `challenger_id, model_full_key, scope, status, created_at,
evidence_package_id, comparison_id`.

Statuses: REGISTERED / VALIDATING / SHADOW / PAPER / PROMOTION_ELIGIBLE /
PROMOTED / REJECTED / RETIRED.

### 3.2 Shadow mode (spec §38)

A challenger in shadow generates predictions/decisions/targets but does NOT
influence the champion portfolio. `ShadowOutput.influenced_champion` must be
False — enforced with a raised error if a caller tries True.

### 3.3 Paper mode (spec §39)

The challenger is evaluated through simulated execution (Phase 3G), isolated
from live execution.

### 3.4 Soak periods (spec §40)

Configurable via `SoakConfig`: `min_shadow_days`, `min_shadow_observations`,
`min_paper_days`, `min_paper_trades`. No hardcoded numbers.

### 3.5 Selection-bias tracking (spec §61)

`selection_bias_summary()` returns `number_tested / number_rejected /
number_promoted` per scope. Unsuccessful challengers are never hidden.

---

## 4. Apples-to-Apples Comparison (spec §25, §26, §64)

`ChampionChallengerComparator.compare()` requires a `FrozenEvalSnapshot`
(evaluation_dataset_id, dataset_hash, observation_count, date_range,
universe_hash). Both champion and challenger consume the SAME frozen snapshot.

Same-* invariants asserted: `same_universe, same_period, same_execution,
same_cost_model, same_portfolio_constraints, same_evaluation_horizon`.

Prediction correlation is surfaced — two models with > 0.99 correlated
predictions are flagged `predictions_near_identical` (spec §27).

---

## 5. Current Champion State

| Scope | Champion | Status |
|-------|----------|--------|
| (none) | — | NO_PROMOTION |

No real models have been evaluated, so no champion exists. Per spec §81, a
system with no champion is preferred over one with an inadequately evidenced
champion.

---

## 6. Readiness Questions (spec §75)

| Question | Answer |
|----------|--------|
| Who is the current champion? | None (no real models evaluated) |
| Why is it champion? | N/A |
| What evidence supports it? | N/A |
| What challengers were tested? | 0 real challengers (framework verified on synthetic) |
| Which challengers failed? | N/A |
| Why did they fail? | N/A |
| What would cause rollback? | Configurable rollback triggers (see promotion-gate report) |

These questions are answerable from persisted artifacts once real models are
registered.

---

## 7. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real dataset. The champion/challenger workflow is
verified end-to-end on synthetic evidence packages (promotion, rejection,
rollback all tested).
