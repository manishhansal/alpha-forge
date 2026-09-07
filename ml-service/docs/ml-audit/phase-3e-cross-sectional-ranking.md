# ML Audit: Phase 3E — Cross-Sectional Alpha & Ranking Engine

**Phase:** 3E — Cross-Sectional Alpha & Ranking Engine
**Audit scope:** Existing `StockRanker`, new `ranking/` package, migration path
**Branch:** `refactor/improve-ml-service`
**Date:** 2026-09-06
**Status:** PASS — 72/76 tests pass; 4 skipped (sklearn/lgbm/xgb/scipy absent); leakage CLEAN

---

## 1. Existing Ranker — What Was There

### 1.1 Architecture before Phase 3E

```
build_ranking_training_data()
    ↓ (stock_data dict, no eligibility filter)
compute_stock_features()   ← per-stock, no CS normalisation
    ↓
label = clip((stock_fwd - nifty_fwd) / rolling_vol, -5, 5)
    ↓
StockRanker.train(X, y)    ← LightGBM regression, DEFAULT_PARAMS
    ↓
spearmanr(y, preds) > 0.02 → acceptance gate
```

**What was missing:**
- No PIT universe filter at the ML layer
- No cross-sectional feature normalisation (each stock computed independently)
- No group structure in training (LambdaRank never activated)
- No decile/Rank IC/NDCG evaluation — only raw Spearman IC > 0.02
- Label V2 events disconnected from training
- Sample uniqueness weights never passed to `lgb.Dataset`

### 1.2 Fourteen documented problems

| # | Severity | Summary |
|---|----------|---------|
| 1 | HIGH | LambdaRank dead code — never activated in `train_all.py` |
| 2 | HIGH | XGBoost HPO params silently injected into LightGBM |
| 3 | MED | HPO runs on fold 0 only; params may be stale |
| 4 | HIGH | Acceptance gate IC > 0.02 — no decile/NDCG/Rank IC |
| 5 | MED | No `ModelAcceptanceGate` (full financial metrics) for ranker |
| 6 | MED | Pseudo-SHAP — hard-coded magnitude map, not TreeExplainer |
| 7 | HIGH | No cross-sectional feature z-scoring |
| 8 | HIGH | Label V2 disconnected from training |
| 9 | MED | Sample uniqueness weights never used |
| 10 | HIGH | Silent fallback to heuristic on any ML exception |
| 11 | MED | Quintile assignment bug for < 5-stock daily universes |
| 12 | LOW | No fold manifest persisted for ranker |
| 13 | LOW | CPCV not wired into ranker evaluation |
| 14 | MED | Universe survivorship risk — no F&O eligibility filter |

---

## 2. New Architecture — Phase 3E

### 2.1 Package layout

```
ml-service/src/
├── labels/
│   └── cross_sectional.py      ← CS targets A–F
└── ranking/
    ├── __init__.py
    ├── schemas.py               ← canonical data structures + enums
    ├── universe.py              ← PIT universe resolver
    ├── normalization.py         ← CS-local z-score, rank, winsorize
    ├── neutralization.py        ← sector, beta, OLS factor neutralization
    ├── ranker.py                ← 6 ranker models (2 baselines + 4 ML)
    ├── evaluation.py            ← IC, Rank IC, ICIR, deciles, turnover
    └── walk_forward.py          ← CS-aware walk-forward splitter
```

### 2.2 Data flow

```
PIT Data (Phase 3B)
    ↓
UniverseResolver.resolve(t)  ← historical_eligible_universe(t), NOT current
    ↓
compute_cross_sectional_targets(
    eligible_symbols=U_t,    ← only stocks eligible at t
    horizon=5,
    benchmark=NIFTY,
)  → targets A–F
    ↓
features X_i,t               ← compute_stock_features() per stock
    ↓
normalize_panel(X, method="zscore")   ← within-timestamp only
    ↓
[optional] sector_neutralize(Y)       ← PIT sector membership
    ↓
CrossSectionalWalkForward            ← temporal groups, embargo
    ↓
RankerModel.fit(X_train, y_train, groups=groups_per_timestamp)
    ↓
alpha_score = model.predict(X_test)  ← higher = more attractive
    ↓
rank_descending(alpha_score)          ← rank 1 = highest score
    ↓
compute_rank_ic() per timestamp       ← cross-sectional Spearman
    ↓
compare_rankers()                     ← ML vs baselines
```

---

## 3. Critical Invariants Verified by Tests

### 3.1 Universe PIT invariants

| Invariant | Test | Result |
|-----------|------|--------|
| IPO stock absent before admission | `test_ipo_stock_absent_before_admission` | PASS |
| IPO stock present after admission | `test_ipo_stock_present_after_admission` | PASS |
| Delisted stock present before delist | `test_delisted_stock_present_before_delist` | PASS |
| Delisted stock absent after delist | `test_delisted_stock_absent_after_delist` | PASS |
| F&O banned stock excluded | `test_fno_banned_stock_excluded` | PASS |
| Insufficient history excluded | `test_insufficient_history_excluded` | PASS |
| Adding future stock does not change U_t | `test_adding_future_stock_does_not_change_historical_eligible` | PASS |

### 3.2 Normalisation PIT invariants

| Invariant | Test | Result |
|-----------|------|--------|
| Each timestamp independent | `test_normalize_panel_each_timestamp_independent` | PASS |
| Future rows do not change past normalised values | `test_normalize_panel_future_timestamps_do_not_affect_past` | PASS |

### 3.3 Neutralisation

| Invariant | Test | Result |
|-----------|------|--------|
| Sector residuals correct | `test_residuals_correct` | PASS |
| Sector sum-to-zero within group | `test_sector_mean_is_zero_after_neutralization` | PASS |
| Singleton sector unchanged | `test_singleton_sector_unneutralized` | PASS |
| Synthetic alpha (spec §57) | `test_sector_neutralization_synthetic_alpha` | PASS |
| Beta neutralization (spec §58) | `test_high_beta_vs_low_beta_equal_stock_alpha` | PASS |
| Sector mutation does not alter historical | `test_sector_mutation_does_not_change_historical_neutralization` | PASS |

### 3.4 Ranking golden tests

| Invariant | Test | Result |
|-----------|------|--------|
| spec §94: A→rank1, B→rank2, …, E→rank5 | `test_golden_score_to_rank` | PASS |
| Higher score = rank 1 (invariant) | `test_score_direction_invariant` | PASS |
| Tie → average rank | `test_tie_handling_deterministic` | PASS |
| Reproducibility | `test_ranking_is_reproducible` | PASS |

### 3.5 IC golden tests (spec §96)

| Invariant | Test | Result |
|-----------|------|--------|
| Perfect alignment → IC = +1 | `test_perfect_alignment_rank_ic_is_one` | PASS |
| Perfect inverse → IC = -1 | `test_perfect_inverse_rank_ic_is_minus_one` | PASS |
| < 5 valid pairs → None | `test_insufficient_data_returns_none` | PASS |
| ICIR = mean/std | `test_icir_formula` | PASS |
| Zero-std → ICIR = None | `test_icir_zero_std` | PASS |
| IC computed per-timestamp | `test_ic_series_per_timestamp` | PASS |

### 3.6 Decile golden tests (spec §97)

| Invariant | Test | Result |
|-----------|------|--------|
| 100 stocks → each decile = 10 | `test_each_decile_has_correct_count` | PASS |
| Q10 mean > Q1 mean (aligned) | `test_q10_higher_than_q1` | PASS |
| Monotonicity ≈ +1 (aligned) | `test_monotonicity_score_near_one_for_perfect_alignment` | PASS |
| Monotonicity ≈ -1 (inverse) | `test_monotonicity_near_minus_one_for_inverse` | PASS |
| min_cs_size gate | `test_min_cs_size_gate_skips_timestamp` | PASS |

### 3.7 PIT mutation tests

| Mutation | Test | Result |
|----------|------|--------|
| Price mutation → historical normalisation unchanged | `test_price_mutation_does_not_change_historical_normalization` | PASS |
| Universe mutation → historical eligible unchanged | `test_universe_mutation_does_not_change_historical_eligible` | PASS |
| Sector mutation → historical neutralisation unchanged | `test_sector_mutation_does_not_change_historical_neutralization` | PASS |
| CS target future mutation → historical targets unchanged | `test_cs_target_future_mutation_does_not_alter_historical` | PASS |

---

## 4. Leakage Certification

| Check | Result |
|-------|--------|
| `shift(-N)` in `ranking/` | **0** |
| `center=True` in `ranking/` | **0** |
| `fillna(0)` INVALID in `ranking/` | **0** |
| `shift(-N)` in `labels/cross_sectional.py` | **0** |
| All mutation tests | **4/4 PASS** |
| Verdict | **CLEAN** |

---

## 5. Backward Compatibility

| Consumer | Impact | Status |
|----------|--------|--------|
| `StockRanker` in `stock_ranker.py` | Not modified | ✅ Unaffected |
| `RANKING_FEATURES` in `engineer.py` | Not modified | ✅ Unaffected |
| `build_ranking_training_data()` | Not modified | ✅ Unaffected |
| `train_all.py::train_ranking_model()` | Not modified | ✅ Unaffected |
| All Phase 3A/3B/3C/3D tests | All pass | ✅ |

Phase 3E is purely additive. The new `ranking/` package co-exists with the existing `StockRanker`. Migration of `train_all.py` to use the Phase 3E CS infrastructure is a Phase 3F task.

---

## 6. Schema Design Decisions

### 6.1 `AlphaScoreSemantics` enum

Every `CrossSectionalAlphaSignal` must declare what its `alpha_score` represents. This prevents the most common research mistake: treating a raw LightGBM score, a regression prediction, and a percentile rank as interchangeable. The `UNKNOWN` value exists in the enum but must never appear in a production signal.

### 6.2 `PredictionProvenance` enum

`TRAINED_MODEL` may not be assigned to baselines or heuristics. This is the enforcement mechanism for the spec §85 requirement: a heuristic fallback must never masquerade as a trained model. The meta-decision layer's abstention policy uses this field to detect when the ML path failed.

### 6.3 `EligibilityState` vs membership

Eligibility is a property of the (instrument, timestamp) pair, not of the instrument alone. The `UniverseResolver` stores `effective_from` dates and resolves per-call — it never caches a "current" state. This is the primary mechanism preventing survivorship bias.

---

## 7. Gaps for Phase 3F

The following items are explicitly deferred and must be addressed before OOS evidence can be gathered:

1. Wire `CrossSectionalWalkForward` into `train_all.py::train_ranking_model()` replacing the current `_build_temporal_splits()` for the ranker.
2. Connect Label V2 (`labels/relative.py`, `labels/sample_weights.py`) to `build_ranking_training_data()` for event-based provenance and uniqueness weights.
3. Add cross-sectional feature normalisation (`normalize_panel`) to the ranking training data builder.
4. Fix the LambdaRank activation: pass `use_lambdarank=True` and `groups` through the walk-forward pipeline.
5. Replace XGBoost HPO with a LightGBM-native HPO path.
6. Add fold manifest persistence for the ranker.
7. Wire `ModelAcceptanceGate` (full financial metrics) into the ranker acceptance.
8. Replace pseudo-SHAP with `shap.TreeExplainer`.
9. Run actual OOS evaluation on real NSE/BSE data.
