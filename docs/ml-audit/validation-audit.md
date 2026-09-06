# AlphaForge ML Service — Validation Audit

**Audit Date:** 2026-09-06  
**Scope:** `validation/` — all 5 files; `training/train_all.py` (how validation is used in practice)

---

## 1. Validation Framework Overview

The ml-service ships a research-grade validation library:

| Component | File | Purpose | Quality |
|---|---|---|---|
| WalkForwardValidator | `walk_forward.py` | Rolling/expanding train-val-test splits | ✅ Excellent |
| PurgedKFold | `purged_kfold.py` | sklearn-compatible CV with label purging | ✅ Excellent |
| EmbargoApplier | `embargo.py` | Embargo gap after train/val boundary | ✅ Excellent |
| CPCVSplitter | `combinatorial_cv.py` | Combinatorial Purged CV (C(N,k) splits) | ✅ (not fully audited) |
| FinancialMetricsEvaluator | `metrics.py` | Classification + trading metrics | ✅ (not fully audited) |
| ModelAcceptanceGate | `metrics.py` | Dual-pass (accuracy + trading) gate | ✅ Exists — **never used** |

**The critical finding: this entire validation framework is tested but not used in training.**

---

## 2. WalkForwardValidator

### 2.1 What It Does
Generates strictly time-ordered walk-forward folds with train / validate / test windows:

```
Fold 0: [─── train ───][─ val ─][─ test ─]
Fold 1:      [─── train ───][─ val ─][─ test ─]
Fold 2:           [─── train ───][─ val ─][─ test ─]
```

Supports:
- Rolling window (fixed train size advances)
- Expanding window (train always starts at index 0, grows over time)
- DatetimeIndex labeling for pandas DataFrames
- Fold manifest persistence (JSON) — prevents overwriting historical results

### 2.2 Integrity Guarantees
`_validate_fold_integrity()` asserts:
- `train_end <= val_start` (no train-val overlap)
- `val_end <= test_start` (no val-test overlap)
- All windows non-empty
- Folds are chronologically ordered

Raises `AssertionError` (hard stop) if violated — correct behavior; a contaminated fold must never proceed.

### 2.3 Code Quality
Well-implemented. Dataclasses for `WalkForwardFold` and `WalkForwardConfig` with proper `__post_init__` validation. Convenience factory functions for common usage patterns. JSON manifest for reproducibility.

**Assessment: PRODUCTION_READY — this should be the primary CV framework.**

---

## 3. PurgedKFold

### 3.1 What It Does
sklearn-compatible `BaseCrossValidator` that purges training observations whose label end-time (`t1`) overlaps with the test window:

```
An observation at t0 with label spanning [t0, t1]:
  If t1 >= test_start_time → PURGE from training
```

Also supports embargo: the first `embargo_bars` observations after the last training bar are excluded from validation.

### 3.2 Implementation Quality

**Correct purging logic:** For each training index `i`, looks up `t1[t0[i]]` and removes it if the label extends into the test window. The fallback (no `t1` provided) uses integer proxy times — appropriate for point-in-time labels.

**sklearn compatibility:** Extends `BaseCrossValidator`, implements `get_n_splits()` and `_iter_test_masks()`, works with `GridSearchCV` and `cross_val_score`.

**One gap:** The `split()` method's embargo is applied by skipping `embargo_bars` after the test fold end:
```python
train_idx = np.concatenate([
    np.arange(0, test_start),
    np.arange(test_end + embargo_bars, n_samples),
])
```
This is correct for non-overlapping folds but may not correctly account for overlapping label horizons in all cases.

**`build_t1_series()` helper:** Correctly builds a fixed-horizon t1 Series for standard forward-label cases.

**`detect_label_overlap()` utility:** Quantifies the fraction of adjacent observation pairs with overlapping labels — useful diagnostic.

**Assessment: PRODUCTION_READY — use in place of random CV for all models.**

---

## 4. EmbargoApplier

### 4.1 What It Does
Removes observations from the validation set that fall within `embargo_bars` of the last training observation. Supports bars, minutes, and days as embargo units.

### 4.2 Implementation Quality
Clean dataclass-based configuration with conversion methods:
- `EmbargoConfig.bars(10)` → 10-bar embargo
- `EmbargoConfig.minutes(15, bars_per_minute=0.2)` → 3 bars (for 5-min NSE bars)
- `EmbargoConfig.days(2, bars_per_day=75)` → 150 bars (5-min bars, 375-min session)

**López de Prado formulation** (`purge_train_indices_by_t1()`) is also implemented — removes training obs whose label spans into the val window, distinct from the bar-count embargo.

**Assessment: PRODUCTION_READY.**

---

## 5. FinancialMetricsEvaluator + ModelAcceptanceGate

### 5.1 Financial Metrics
From the module docstring and schema:
- Classification: accuracy, precision, recall, F1, ROC-AUC
- Trading: Sharpe, Sortino, max drawdown, profit factor, expectancy, turnover

The dual requirement is explicit: **a model with high classification accuracy but poor trading performance must NOT be accepted.**

### 5.2 ModelAcceptanceGate
The gate enforces:
- OOS performance must be positive
- Drawdown within threshold
- Performance stable across multiple windows
- No single time period dominating returns

**Critical gap: Never called.** `train_all.py` saves every model after training regardless of gate result. Models are not rejected. The gate exists only in tests.

**Assessment: FIX — wire gate into train_all.py before `model.save()`.**

---

## 6. The Central Problem: Framework Exists But Is Unused

### 6.1 What train_all.py Does (Regime & Strategy)
```python
# train_regime_model()
X_train, X_val, y_train, y_val = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y   # ← RANDOM SHUFFLE
)
model.train(X_train, y_train, eval_set=(X_val, y_val))
```

### 6.2 What It Should Do
```python
cfg = WalkForwardConfig(
    train_bars=504, val_bars=63, test_bars=63,  # ~2yr train, 3mo val, 3mo test
    expanding=False
)
wfv = WalkForwardValidator(cfg)
folds = wfv.split(len(X))

oos_predictions = []
for fold in folds:
    X_tr = X[fold.train_slice]
    y_tr = y[fold.train_slice]
    X_val = X[fold.val_slice]
    y_val = y[fold.val_slice]
    X_te = X[fold.test_slice]
    y_te = y[fold.test_slice]
    
    model = MarketRegimeClassifier()
    model.train(X_tr, y_tr, eval_set=(X_val, y_val))
    
    # Collect OOS predictions on test set (never seen during training OR HPO)
    preds = model.predict_proba(X_te)
    oos_predictions.extend(zip(preds, y_te))

# Evaluate on all OOS predictions combined
result = evaluator.evaluate(oos_predictions)
gate = ModelAcceptanceGate()
decision = gate.evaluate(result)
if not decision.accepted:
    raise ValueError(f"Model rejected: {decision.reasons}")
```

---

## 7. Test Coverage of Validation Framework

| Test | File | Coverage |
|---|---|---|
| WalkForwardValidator (11 tests) | `test_validation.py` | ✅ Comprehensive |
| Expanding window (3 tests) | `test_validation.py` | ✅ |
| Embargo (7 tests) | `test_validation.py` | ✅ |
| Leakage detection (4 tests) | `test_validation.py` | ✅ |
| PurgedKFold (5 tests) | `test_validation.py` | ✅ |
| Purging correctness (3 tests) | `test_validation.py` | ✅ |
| CPCV structure (5 tests) | `test_validation.py` | ✅ |
| Classification metrics | `test_validation.py` | ✅ |
| Trading metrics | `test_validation.py` | ✅ |
| ModelAcceptanceGate | `test_validation.py` | ✅ |
| **train_all.py validation** | **None** | ❌ **Not covered** |

The test suite proves the framework works correctly. It does not prove that training uses the framework.

---

## 8. Assessment Summary

| Component | Status | Notes |
|---|---|---|
| WalkForwardValidator | PRODUCTION_READY | Not used in training — critical gap |
| PurgedKFold | PRODUCTION_READY | Not used in training — critical gap |
| EmbargoApplier | PRODUCTION_READY | Not used in training — critical gap |
| CPCV | PRODUCTION_READY | Not fully audited |
| FinancialMetricsEvaluator | KEEP | Dual-pass criteria are correct |
| ModelAcceptanceGate | FIX | Must be wired to train_all.py |
| train_all.py (regime, strategy) | REWRITE | Replace random split with WalkForwardValidator |
| train_all.py (ranker, risk) | FIX | Add PurgedKFold + embargo to boundary |

---

## 9. Recommendations

| Priority | Action |
|---|---|
| 🔴 CRITICAL | Replace `train_test_split` in `train_regime_model()` and `train_strategy_model()` with `WalkForwardValidator` |
| 🔴 CRITICAL | Add `PurgedKFold` or embargo to ranking and risk model train/val boundary |
| 🔴 HIGH | Wire `ModelAcceptanceGate` into `train_all.py` — models that fail the gate must not be saved |
| 🔴 HIGH | Add test for `train_all.py` temporal split behaviour (extend the existing `test_no_random_split_in_pipeline` to cover `train_all.py`) |
| 🟡 MEDIUM | Run `detect_label_overlap()` diagnostics for all label horizons at pipeline time |
| 🟡 MEDIUM | Save fold manifests from all training runs for reproducibility |
| 🟢 LOW | Consider CPCV for the regime classifier (fewer samples, combinatorial coverage more valuable) |
