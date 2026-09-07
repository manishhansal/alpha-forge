# Phase 3E — Cross-Sectional Alpha & Ranking Engine: Ranking Report

**Phase:** 3E — Cross-Sectional Alpha & Ranking Engine
**Date:** 2026-09-06
**Branch:** `refactor/improve-ml-service`
**OOS evidence status:** INSUFFICIENT_EVIDENCE

---

## Evidence Status

> **INSUFFICIENT_EVIDENCE** — No real historical Indian equity dataset is available in the test environment. All OOS ranking metrics (Rank IC, decile returns, top-bottom spread, turnover) require NSE/BSE OHLCV data loaded through the Phase 3B data pipeline. This is the correct research posture; fabricating IC from synthetic data and calling it alpha evidence would be scientifically dishonest.
>
> The cross-sectional ranking **infrastructure** is fully implemented and tested with deterministic synthetic data where the correct answer is mathematically known.

---

## Test Results

| Suite | Collected | Passed | Failed | Skipped |
|-------|-----------|--------|--------|---------|
| `test_phase3e.py` | 76 | **72** | **0** | 4 (sklearn/lgbm/xgb/scipy) |
| `test_phase3c.py` | 63 | 61 | 0 | 2 (pre-existing) |
| `test_phase3d.py` | 125 | 125 | 0 | 0 |
| `test_vpin.py` | 13 | 13 | 0 | 0 |
| **Overall** | **277** | **271** | **0** | **6** |

---

## Existing Ranker Audit

### Problems Found (14 total)

| # | Severity | Problem |
|---|----------|---------|
| 1 | HIGH | LambdaRank dead code — `use_lambdarank=True` never set in `train_all.py` |
| 2 | HIGH | XGBoost HPO params silently injected into LightGBM (`gamma`, `min_child_weight` invalid) |
| 3 | MEDIUM | HPO runs only on fold 0; params may be stale for later market regimes |
| 4 | HIGH | Acceptance gate IC > 0.02 — no decile, no NDCG, no Rank IC |
| 5 | MEDIUM | No `ModelAcceptanceGate` (full financial metrics) for ranker |
| 6 | MEDIUM | Pseudo-SHAP: `_extract_top_factors()` is a hard-coded magnitude map, not TreeExplainer |
| 7 | HIGH | No cross-sectional feature z-scoring — each stock's features computed independently |
| 8 | HIGH | Label V2 (`src/labels/relative.py`) disconnected from training |
| 9 | MEDIUM | Sample weights (event uniqueness) not passed to `lgb.Dataset` |
| 10 | HIGH | Silent fallback to heuristic on any ML exception — no alerting |
| 11 | MEDIUM | Quintile assignment bug for daily universes < 5 stocks |
| 12 | LOW | No fold manifest persisted for ranker |
| 13 | LOW | CPCV not wired into ranker evaluation |
| 14 | MEDIUM | Universe survivorship risk — no explicit F&O eligibility filter at ML layer |

---

## New Infrastructure — Phase 3E

### Cross-Sectional Targets (`labels/cross_sectional.py`)

| Target | Formula | PIT-safe |
|--------|---------|----------|
| A — Raw return | `(p[t+h] - p[t]) / p[t] × 100` | ✅ |
| B — Excess return | `A - benchmark_return` | ✅ |
| C — Sector relative | `A - mean(sector_peers_A)` | ✅ |
| D — CS percentile | `percentile_rank(A)` within `U_t` | ✅ |
| E — CS z-score | `(A - mean) / std` within `U_t` | ✅ |
| F — CS rank | `ordinal_rank(A)` within `U_t` | ✅ |

All 6 targets: missing price → `None` (not 0). Min CS size gate: `< min_cs_size` → all `None`.

### Universe Resolver (`ranking/universe.py`)

| Test | Result |
|------|--------|
| IPO admission | PASS — future stock absent from historical universe |
| Delisting | PASS — delisted stock excluded after delist date |
| F&O ban | PASS — banned stock flagged `FNO_BANNED` |
| Universe mutation | PASS — adding D (effective 2025) does not change U(2023) |
| Insufficient history | PASS — `< min_history_bars` → `INSUFFICIENT_HISTORY` |
| Empty universe | PASS — returns empty eligible list |

### Normalization (`ranking/normalization.py`)

All 4 methods (`cs_zscore`, `cs_robust_zscore`, `cs_rank_pct`, `cs_rank_normal`) are:
- Computed **within a single timestamp** only
- Never reference future timestamps
- PIT mutation test: appending extreme future rows **does not change** past normalized values — PASS

### Neutralization (`ranking/neutralization.py`)

| Test | Result |
|------|--------|
| Sector residuals correct | PASS — sector mean removed exactly |
| Sector sum-to-zero | PASS — residuals sum to 0 within each sector |
| Singleton sector unchanged | PASS — single-stock sector not neutralized |
| Synthetic alpha (spec §57) | PASS — Sector A common +5% removed; stock-specific alpha preserved |
| Beta neutralization (spec §58) | PASS — high/low beta with equal stock alpha → equal residual |
| Factor OLS | PASS — `var(resid) << var(Y)` after removing factor component |

### Ranker Models (`ranking/ranker.py`)

| Model | Score semantics | Status |
|-------|----------------|--------|
| `MomentumBaselineRanker` | Cross-sectional rank of 20d return | ✅ No dependencies |
| `CompositeBaselineRanker` | Equal-weight composite of z-scored features | ✅ No dependencies |
| `RidgeRanker` | Predicted excess return (Ridge regression) | ⚠️ Requires sklearn |
| `ElasticNetRanker` | Predicted excess return (ElasticNet) | ⚠️ Requires sklearn |
| `LightGBMRanker` | Regression score or LambdaRank score | ⚠️ Requires lightgbm |
| `XGBoostRanker` | Regression or pairwise ranking score | ⚠️ Requires xgboost |

Score convention: **higher score = more attractive** (invariant across all models).

### Evaluation Engine (`ranking/evaluation.py`)

| Test | Result |
|------|--------|
| Rank IC perfect alignment = +1 | PASS |
| Rank IC perfect inverse = -1 | PASS |
| ICIR formula (`mean/std`) | PASS |
| Zero-std ICIR → None | PASS |
| 100-stock decile: each decile = 10 | PASS |
| Q10 > Q1 for aligned scores | PASS |
| Monotonicity ≈ +1 for aligned | PASS |
| Monotonicity ≈ -1 for inverse | PASS |
| ML_ADDS_NO_CLEAR_VALUE when IC ≤ baseline | PASS |
| INSUFFICIENT_EVIDENCE when IC < 0.02 | PASS |

---

## OOS Ranking Evidence

**Status: INSUFFICIENT_EVIDENCE**

All fields below require real Indian equity data:

| Metric | Value |
|--------|-------|
| Mean Rank IC | INSUFFICIENT_EVIDENCE |
| Median Rank IC | INSUFFICIENT_EVIDENCE |
| ICIR | INSUFFICIENT_EVIDENCE |
| Positive Rank IC % | INSUFFICIENT_EVIDENCE |
| Q1–Q10 decile returns | INSUFFICIENT_EVIDENCE |
| Top-bottom spread | INSUFFICIENT_EVIDENCE |
| Turnover proxy | INSUFFICIENT_EVIDENCE |
| Coverage % | INSUFFICIENT_EVIDENCE |

---

## Leakage Audit

| Check | Result |
|-------|--------|
| `shift(-N)` in ranking code | **0** |
| `center=True` in ranking code | **0** |
| `fillna(0)` INVALID in ranking code | **0** |
| Price mutation (historical normalization unchanged) | **PASS** |
| Universe mutation (future stock unchanged) | **PASS** |
| Sector mutation (historical neutralization unchanged) | **PASS** |
| CS target future mutation | **PASS** |

---

## Regime Analysis

**Status: INSUFFICIENT_EVIDENCE** — requires real data and regime labels.

| Regime | Mean Rank IC | Status |
|--------|-------------|--------|
| Bull | INSUFFICIENT_EVIDENCE | — |
| Bear | INSUFFICIENT_EVIDENCE | — |
| High volatility | INSUFFICIENT_EVIDENCE | — |
| Low volatility | INSUFFICIENT_EVIDENCE | — |
| Expiry | INSUFFICIENT_EVIDENCE | — |
| Non-expiry | INSUFFICIENT_EVIDENCE | — |

---

## Multiple Testing Tracker

| Item | Count |
|------|-------|
| Models tested | 6 (2 baselines + 2 linear + 2 nonlinear) |
| Feature sets tested | 1 (RANKING_FEATURES v1) |
| Target horizons tested | 1 (5 bars) |
| HPO trials | 0 |
| Total experiments | 1 |

Note: With only 1 experiment, multiple-testing correction is not applicable. When real data experiments are run in Phase 3F, this tracker must be updated.

---

## Research Conclusion

**INSUFFICIENT_EVIDENCE**

The cross-sectional ranking infrastructure is architecturally complete and verifiably correct on deterministic synthetic data. No OOS alpha claim can be made without real Indian equity historical data and actual walk-forward evaluation.

The correct sequence before any alpha claim:

```
Rank IC (real data)
    ↓
IC stability (multiple folds)
    ↓
Decile monotonicity (real market)
    ↓
Top-bottom spread (vs benchmark)
    ↓
Cost-adjusted spread
    ↓
Portfolio construction
    ↓
Execution analysis
```

Phase 3E delivers steps 1–3's infrastructure. Steps 4–7 require Phase 3F–3H.

---

## Known Limitations

1. No real Indian equity dataset — all OOS metrics `INSUFFICIENT_EVIDENCE`
2. sklearn/lightgbm/xgboost/scipy not installed in test env — 4 ML tests skipped
3. LambdaRank groups reconstruction across walk-forward splits not yet wired in `train_all.py`
4. CPCV not yet wired into ranker evaluation
5. No fold manifest for ranker in existing `train_all.py`
6. Sample uniqueness weights not yet passed to `lgb.Dataset` in training
7. Label V2 (`src/labels/relative.py`) not yet connected to `build_ranking_training_data()`
