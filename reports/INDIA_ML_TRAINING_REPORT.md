# INDIA ML TRAINING REPORT

**Scope:** Retrain + validate the AlphaForge Indian-Market ML stack (7 models) on a
proper time-series dataset using the existing walk-forward / purged-CV pipeline.
**Run date:** 2026-09-09 · **Git commit:** `1c2941b`
**Training engine:** `ml-service/src/training/train_all.py`
(`WalkForwardValidator` + `PurgedKFold` + `EmbargoApplier` + `ModelAcceptanceGate`)
**Artifacts written to:** `ml-service/artifacts_retrain/` (scratch — **production
artifacts in `ml-service/artifacts/` were NOT overwritten**).
**Production logic changed:** **NONE.**
**Machine-readable results:** `ml-service/artifacts_retrain/RETRAIN_RESULTS_2026-09-09.json`.

**Method:** Evidence-based. Models are trained with strictly chronological splits and
an acceptance gate that **blocks saving** unless out-of-sample metrics pass. Where a
model cannot be trained on real data (missing dependency, missing dataset, or no
persisted outcomes), it is reported as **BLOCKED / INSUFFICIENT EVIDENCE** — never
faked, never trained on synthetic data.

---

## EXECUTIVE VERDICT

> # ❌ NO MODEL CERTIFIED — 0 / 7 produced a gate-passing, OOS-validated artifact on real data

The retraining pipeline is real and rigorous, and it ran on **real daily-OHLCV-derived
tensors**. The honest outcome is that **the improved signal definitions do not yet
yield out-of-sample predictive edge** on the data available, and several models cannot
be trained at all in the current environment. The acceptance gates did exactly what
they should: they **refused to save unfit models**.

| Model | Status | Headline OOS result |
|-------|--------|---------------------|
| 1. Market Regime Classifier | ❌ INSUFFICIENT EVIDENCE | OOS accuracy **0.474** < 0.52 gate; negative Sharpe; path-dependent |
| 2. Stock Ranker | ❌ INSUFFICIENT EVIDENCE | OOS Spearman IC **0.0041** (p=0.54) < 0.02 gate |
| 3. Strategy Selector | ⛔ BLOCKED | CatBoost import fails (numpy 2.2.6 binary incompatibility) |
| 4. Risk Predictor | ⛔ TRAINING FAILED | single-class validation fold → `roc_auc` undefined |
| 5. Price Regime Forecaster | ⚪ NOT RUN | deep-learning deps (darts/TFT) not installed; no tensor |
| 6. IV Regime Classifier | ⚪ NOT RUN | deep deps (PatchTST/tsai) not installed; no tensor |
| 7. Meta Decision Model | ⚪ NOT TRAINABLE | needs persisted OOS outcomes; store is in-memory only |

**Bottom line:** Keep the existing (unwired, heuristic-fallback) runtime. Do **not**
promote any freshly trained artifact — none earned it. The path forward is data and
environment fixes, not more training runs.

---

## 1. DATASET & TIME-SERIES SPLIT (no blind training)

Training does **not** use all history shuffled. It uses `WalkForwardValidator` with
strictly chronological folds, `PurgedKFold` at each train/val boundary, and an
`EmbargoApplier` (5-bar embargo = the label horizon) so no label leaks across the
purge gap. HPO (when enabled) runs on **inner** folds only; the final OOS test window
is never seen during tuning. This realises the requested structure:

```
TRAIN  (earlier)  ──►  VALIDATION (later)  ──►  TEST (untouched recent)
        + rolling walk-forward across the whole window
```

Concrete fold geometry used (regime example): 4 folds, `train_bars=504`,
`val_bars=63`, `test_bars=63`, `step=63`, embargo=5. OOS predictions are collected
**only** from each fold's held-out test block, then concatenated for scoring.

**Real datasets trained on** (daily-OHLCV-derived tensors; yfinance/Bhavcopy origin):

| Tensor | Shape | Labels |
|--------|-------|--------|
| `regime_train.npz` | X (826, 28), y (826) | regime class |
| `ranking_train.npz` | X (25 104, 64), y, groups (523) | forward risk-adjusted return rank |
| `risk_train.npz` | X (38 962, 18) | y_stop, y_target, y_drawdown |
| `strategy_train.npz` | X (39 682, 17), y | best-strategy class |

> ⚠️ **Data boundary:** these tensors are built from **daily** bars. The app's own
> **intraday / executed-trade** history is **not** usable for training — intraday
> candles were never persisted (RCA-001) and the signal-learning-loop store is
> in-memory only. So the models learn from daily market structure, **not** from the
> improved signals' realized intraday outcomes.

---

## 2. TARGETS & LABELS (policy-based, not "price went up")

Labels come from the triple-barrier first-touch labeler
(`ml-service/src/labels/triple_barrier.py`), which encodes the actual trading policy
(entry, ATR-scaled stop, ATR-scaled target, vertical/time barrier, costs, expiry):

| Labeler outcome (`FirstTouch`) | Maps to requested label |
|-------------------------------|-------------------------|
| `TAKE_PROFIT` | **TARGET_FIRST** |
| `STOP_LOSS` | **STOP_FIRST** |
| `TIME_LIMIT` (exit > entry) | **TIME_EXIT_PROFIT** |
| `TIME_LIMIT` (exit ≤ entry) | **TIME_EXIT_LOSS** |
| `INTRABAR_AMBIGUOUS` | **AMBIGUOUS** (excluded from training) |
| `DATA_INSUFFICIENT` | excluded (never relabeled as TIME_LIMIT) |

Key anti-inflation properties (verified in code): **sequential** forward scan for the
first touch (not `.any()` over the window); intrabar both-touched resolves to
**STOP_LOSS** under `CONSERVATIVE_SL` (worst case for the trader); incomplete horizons
are excluded, not silently called time-exits; event windows are capped at contract
expiry. Classification models use the class target; the risk model uses
`y_stop`/`y_target`/`y_drawdown`; the ranker optimises forward risk-adjusted return.

---

## 3. PER-MODEL RESULTS

### 1) Market Regime Classifier — ❌ INSUFFICIENT EVIDENCE
XGBoost multiclass, 826×28, 4 walk-forward folds, 232 OOS samples.

- **OOS accuracy 0.4741** (gate threshold 0.52).
- Acceptance gate **rejected** with 6 reasons: accuracy below threshold; **Sharpe
  −0.83**; OOS return −1.0 (not positive); **max drawdown 1.0** > 0.25; **profit factor
  0.90** < 1.05; **one fold contributed 100% of return** (path-dependent, limit 60%).
- Fold val-accuracy swung **0.29 → 1.00** while train-accuracy stayed ~0.99 — a clear
  **overfit** signature on a small daily dataset.
- **Not saved.** `INSUFFICIENT_EVIDENCE` recorded.

### 2) Stock Ranker — ❌ INSUFFICIENT EVIDENCE
LightGBM ranker, 25 104×64, 523 groups, 22 330 OOS samples.

- **OOS Spearman IC 0.0041** (p = 0.54) — statistically indistinguishable from zero;
  gate threshold IC > 0.02.
- In-fold Spearman was 0.70 (train) / 0.65 (val) but **OOS IC ≈ 0** → the ranker fits
  the training folds yet carries **no genuine out-of-sample ranking edge**.
- Requested **top-5 / top-10 / top-20 precision & return**: **NOT MEASURABLE** — with
  IC ≈ 0 (p = 0.54) there is no reliable ordering to slice, and the daily ranking
  tensor has no attached net-of-cost forward P&L per name to compute realized top-K
  return. Reporting top-K numbers here would be noise dressed as signal.
- **Not saved.** `INSUFFICIENT_EVIDENCE` recorded.

### 3) Strategy Selector — ⛔ BLOCKED (environment)
CatBoost multiclass, 39 682×17. **`import catboost` fails**: `numpy.dtype size changed`
(installed CatBoost built against an older numpy ABI than the venv's numpy 2.2.6).
Cannot train until the dependency is realigned. **Not a data finding** — an environment
blocker.

### 4) Risk Predictor — ⛔ TRAINING FAILED (fold data)
XGBoost stop-hit + target-hit + drawdown, 38 962×18. Global class balance is healthy
(y_stop 58.5% / y_target 57.1% positive), but training raised
`roc_auc_score: Only one class present in y_true` inside an **intermediate 63-bar
validation fold**. Root cause: risk rows are grouped by symbol, so a chronological
63-bar slice can fall **entirely within one single-class symbol block**. **Not patched**
— fixing the fold construction would change production logic, which this exercise
forbids. Recorded as a training failure.

### 5) Price Regime Forecaster — ⚪ NOT RUN
Deep-learning backbone (darts / TFT) is commented out in `requirements.txt` and not
installed; no prebuilt tensor exists. Runs only in a lightweight/heuristic form.
No real training performed → **INSUFFICIENT EVIDENCE**.

### 6) IV Regime Classifier — ⚪ NOT RUN
Optional sequence deps (PatchTST / tsai) not installed; no prebuilt tensor, and
option-chain IV history is snapshot-only/sparse (no NSE history endpoint).
No real training performed → **INSUFFICIENT EVIDENCE**.

### 7) Meta Decision Model — ⚪ NOT TRAINABLE ON REAL DATA
The TS ensemble meta-learner (`trainMetaModel`) is real and rigorous (walk-forward
split, hierarchical isotonic/Platt calibrators, OOS ROC-AUC / log-loss contribution,
PSI drift, regime performance, correlation de-weighting, OOS-learned weights). But it
requires **persisted `PredictionRecord`/`ResolutionRecord` OOS outcomes**, and the
store is `InMemorySignalRecordStore` — no Prisma adapter, nothing durable accrues. At
runtime the resolver returns `defaultMetaArtifact()` (untrained: every model
`addsValue=false`, `method:"raw"`, `globalPrior=0.5`) — which by design cannot
masquerade as calibrated. **Cannot be trained until real outcomes are persisted.**

---

## 4. REQUIRED METRIC BATTERY (AUC / PR-AUC / Brier / ECE / log-loss / P / R / F1 / profitability)

The pipeline computes these where a model reaches OOS scoring, but **no model produced
a gate-passing artifact**, so there is no certified metric battery to publish. What was
actually observed OOS:

| Metric | Regime | Ranker | Risk / Strategy / Forecaster / IV / Meta |
|--------|--------|--------|------------------------------------------|
| Accuracy | 0.4741 | — | not reached |
| Spearman IC | — | 0.0041 (p 0.54) | not reached |
| AUC / PR-AUC | not gate-passing | n/a | risk crashed; others not run |
| Brier / ECE / log-loss | not gate-passing | n/a | not reached |
| Precision / Recall / F1 | not gate-passing | n/a | not reached |
| Profitability / expectancy / PF | Sharpe −0.83, PF 0.90, OOS return −1.0 | n/a | not reached |

**Segmented performance** (by regime / time-of-day / instrument / strategy): **NOT
MEASURABLE**. The daily tensors are pre-aggregated feature matrices without persisted
per-row regime/session/instrument/strategy tags and net-of-cost realized P&L, and no
model passed its gate anyway. Producing these tables requires the persisted, tagged
outcome store described in §7.

---

## 5. FEATURE IMPORTANCE, SHAP & FEATURE SELECTION

`shap 0.46` is installed and the pipeline supports SHAP + permutation importance. The
governing policy (enforced by `data_pipeline.py` PIT + structural-leakage checks and
the acceptance gate) is:

Remove a feature if it **(a)** leaks future information (PIT/structural-leakage check),
**(b)** is unstable across folds, **(c)** adds no OOS contribution, **(d)** is redundant
with a stronger feature, or **(e)** materially degrades calibration. **Feature selection
is never done on the test set** — importance and pruning are evaluated on inner
train/validation folds only; the final OOS block is untouched.

A published SHAP summary is deferred: SHAP on a **rejected** model would explain noise.
SHAP summaries should be generated only for a model that first clears its acceptance
gate (§7).

---

## 6. CHAMPION / CHALLENGER & COMPOSITE OBJECTIVE

**Promotion rule:** the champion stays active unless a challenger demonstrates a
**statistically meaningful OOS improvement**. Implemented in
`src/lib/india/signal-learning-loop.ts` (`evaluateChampionChallenger`): compares on
**untouched OOS** across win rate, expectancy (required), profit factor, Sharpe, max
drawdown, calibration gap, Brier (required), ECE, turnover, cost-adjusted return, and
regime robustness; promotes **only** when the expectancy gain ≥ threshold **and** a
two-sample **z ≥ 1.96**, with **no** calibration or drawdown regression and ≥ 100 OOS
samples. Otherwise HOLD (keep champion) or REJECT.

**Composite objective (as specified):** 40% net expectancy · 20% calibration · 15%
profit factor · 10% drawdown · 10% regime robustness · 5% stability — a
profitability-first objective, **not** raw accuracy.

**This run's outcome:** **no promotion is possible.**
1. Every challenger **failed its own acceptance gate** (regime, ranker) or could not
   train (risk, strategy) — so none is even eligible.
2. The deployed **champions carry no recorded OOS metrics**: `ml-service/artifacts/*`
   (dated 2026-08-19) are raw booster dumps (`learner`/`version` only) and there is
   **no `model_registry.json`**. With no champion baseline and no gate-passing
   challenger, the composite objective cannot be scored on either side.

---

## 7. PROVENANCE (what is stored, what is missing)

The `ModelRecord`/`ModelRegistry` schema (`ml-service/src/monitoring/model_registry.py`)
supports every required field — model version, training/validation/OOS periods,
feature/label/dataset versions, hyperparameters, validation + calibration metrics,
git commit, acceptance status — and `prediction_provenance.py` lets every prediction
expose a model version. This run's provenance:

| Field | Value |
|-------|-------|
| Git commit | `1c2941b` |
| CV method / embargo | walk_forward / 5 bars |
| Dataset version (default) | `af-v3.0-fv4` (no `dataset_meta.json` sidecar present) |
| Feature / label version | `fv4` / `lv1` (triple-barrier first-touch) |
| Dataset SHA-256 (prefix) | regime `482f56f4…` · ranking `1979dcf3…` · risk `ab027e93…` · strategy `9c68405b…` |
| Training timestamp | 2026-09-09 |
| Artifacts saved | **none** (all gate-failed / blocked) |

**Gap:** the registry schema exists but **was not being populated for the deployed
champions**, and no dataset-meta sidecar pins the exact training window. Both must be
fixed before any model is promoted.

---

## 8. PATH TO A CERTIFIABLE ML STACK (prerequisites, in order)

1. **Fix the environment** — realign numpy/CatBoost ABI so the Strategy Selector can
   train; install (or explicitly scope out) the forecaster/IV deep-learning deps.
2. **Fix the risk fold construction** — guard against single-class validation folds
   (stratified-by-time or skip-and-log), so the Risk Predictor completes.
3. **Persist real outcomes** — implement the Prisma `SignalRecordStore` adapter so
   `PredictionRecord`/`ResolutionRecord` accrue; only then can the Meta Decision Model
   train and champion/challenger run on real OOS data.
4. **Tag outcomes** with regime / time-of-day / instrument / strategy and net-of-cost
   realized P&L so the segmented tables and ranker top-K return become measurable.
5. **Pin provenance** — write `dataset_meta.json`, register every trained artifact in
   `ModelRegistry`, and stamp `model_version` on every prediction.
6. **Re-run this pipeline**; publish AUC/PR-AUC/Brier/ECE/log-loss/P/R/F1 + SHAP **only
   for models that clear the acceptance gate**, then evaluate champion/challenger on
   the composite objective.

---

## CERTIFICATION STATEMENT

Retraining was performed on **real** daily-market data with a **proper time-series
split, purged/embargoed walk-forward CV, and profitability-aware acceptance gates** —
not blind training and not synthetic data. On this evidence, **no model earned
promotion**: the regime classifier and stock ranker have **no out-of-sample edge**
(accuracy 0.474; IC 0.0041), the strategy selector is **environment-blocked**, the risk
predictor **failed on a single-class fold**, and the forecaster / IV / meta models
**cannot be trained** until deep-learning deps and a durable outcome store exist.

**Verdict: 0 / 7 models certified. Keep the current runtime; publish no new artifact.
Fix the six prerequisites above, then re-certify.** No model was manufactured to appear
successful, and no unfit artifact was saved.

---

*AlphaForge — India ML Training Report — 2026-09-09*
*"Do not optimize pure accuracy. Trading profitability is the objective. Where evidence is absent, report INSUFFICIENT EVIDENCE."*
