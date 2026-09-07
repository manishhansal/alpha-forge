# Phase 3K — Classical vs Deep Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Verdict:** classical baseline PRESERVED; deep models show NO credible standalone superiority (INSUFFICIENT_EVIDENCE — no real dataset)

---

## 1. Fair-Comparison Apparatus (spec §19, §74)

`WalkForwardComparator` runs every ranker — classical and deep — on the SAME:

- walk-forward folds (Phase 3A `WalkForwardValidator`, no random splits)
- features (canonical `<FEATURE_SET>.feature_names` order)
- labels / target
- universe
- PIT scaler (fit on train window only, applied to val/OOS)
- IC metric (Phase 3E `compute_rank_ic` / `compute_ic`)

A fresh model instance is built per fold (no cross-fold state leakage). This
guarantees any "deep beats classical" comparison is apples-to-apples.

---

## 2. Baselines Preserved (spec §19)

The classical baseline is intact and is the reference every deep model is
measured against:

| Baseline | Status |
|----------|--------|
| Linear (OLS) | implemented (`LinearRanker`) |
| Ridge | implemented (`RidgeRanker`) |
| ElasticNet | implemented (`ElasticNetRanker`) |
| Existing StockRanker / Meta | reused via `BaseRanker` interface (available where sklearn/lightgbm import) |

LightGBM / XGBoost rankers ship in `src.ranking.ranker`; they require the
sklearn/lightgbm stack which is currently broken in this environment. The
comparison harness accepts any `BaseRanker`, so they slot in unchanged where the
stack imports — documented as a limitation.

---

## 3. Comparison Result (synthetic verification)

On a deterministic linear synthetic signal across 5 walk-forward folds:

| Model | pooled OOS rank IC |
|-------|--------------------|
| Ridge | ~0.975 |
| Linear | ~0.975 |
| MLP | ~0.954 |

The classical linear/ridge baseline correctly matched or slightly beat the MLP.
This is the intended behaviour: the phase does not assume deep learning is
superior, and on a signal classical models capture fully, they win.

**No real-dataset comparison exists** — there is no production claim that any
deep model beats or loses to the classical champion.

---

## 4. Error / Prediction Correlation (spec §56)

The `incremental_alpha_report` surfaces champion-vs-challenger prediction
correlation, error correlation, absolute-error correlation, and tail-error
overlap. A challenger that makes the same errors as the champion is flagged as
offering little incremental value even if its standalone IC is comparable.

---

## 5. Verdict

**Classical baseline preserved. Deep models show no credible standalone
superiority. INSUFFICIENT_EVIDENCE** — the verdict is framework-level only; a
governed real dataset is required for any production comparison.
