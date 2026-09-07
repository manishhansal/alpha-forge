# Validation Audit: Verifying the Actual Index Logic

**Verification Date:** 2026-09-06  
**Method:** Reading actual implementation code — not accepting class names as proof. Every claim verified against source.

---

## 1. WalkForwardValidator

**File:** `src/validation/walk_forward.py`

### Verified Invariants

**Test 1: No temporal overlap between train and val**
Code in `_validate_fold_integrity()` at line ~290:
```python
assert fold.train_end <= fold.val_start, (
    f"Fold {k}: train_end ({fold.train_end}) > val_start ({fold.val_start}) "
    "— train overlaps validation"
)
```
**Verdict: ✅ CORRECT** — hard assertion enforced.

**Test 2: No temporal overlap between val and test**
```python
assert fold.val_end <= fold.test_start, (...)
```
**Verdict: ✅ CORRECT**

**Test 3: Rolling vs expanding window**
Rolling: `train_start = cursor; train_end = cursor + cfg.train_bars`  
Expanding: `train_start = 0; train_end = cfg.train_bars + fold_idx * cfg.step_bars`  
**Verdict: ✅ CORRECT** — both modes implemented correctly.

**Test 4: Step size controls roll distance**
`cursor += cfg.step_bars` after each fold.  
**Verdict: ✅ CORRECT**

**Test 5: Fold manifest saved without overwriting**
```python
if output_path.exists():
    ts = datetime.now(timezone.utc).strftime(...)
    output_path = output_path.with_stem(f"{output_path.stem}_{ts}")
```
**Verdict: ✅ CORRECT** — historical manifests are never overwritten.

**Test 6: DatetimeIndex labeling**
`split_on_index()` attaches `train_start_dt`, `val_end_dt` etc. from the DatetimeIndex.  
**Verdict: ✅ CORRECT**

### Usage in Train_all.py

**Verdict: ❌ NOT USED** — `WalkForwardValidator` is not imported or called in `train_all.py`.

The `data_pipeline.py` has its own `walk_forward_splits()` (line 114) which is a simpler re-implementation with NO:
- Fold integrity assertion
- Fold manifest saving
- DatetimeIndex labeling
- Expanding window mode

This simpler version is also not called by `train_all.py` — `train_all.py` loads pre-built `.npz` files and applies random or time-based splits directly.

---

## 2. PurgedKFold

**File:** `src/validation/purged_kfold.py`

### Core Purging Logic

The `_purge()` method at line 202:
```python
def _purge(self, train_idx, test_idx, t0, t1):
    test_start_time = t0[test_idx[0]]
    purged = []
    for idx in train_idx:
        obs_t0 = t0[idx] if idx < len(t0) else t0[-1]
        if obs_t0 in t1.index:
            obs_t1 = t1[obs_t0]
        elif isinstance(t1.index, pd.DatetimeIndex) and len(t1) > idx:
            obs_t1 = t1.iloc[idx]
        else:
            purged.append(idx)  # No t1 info: assume point-in-time
            continue
        if obs_t1 >= test_start_time:
            n_purged += 1
            continue
        # Also exclude observations that START after the test window
        if obs_t0 > test_end_time:
            continue
        purged.append(idx)
```

**Verified correctness:**
- A training observation at t0 with label end time t1 ≥ test_start_time is PURGED ✅
- Point-in-time fallback (when no t1): treated as safe (appended to purged, i.e., kept) ✅
- Observations starting AFTER the test window are excluded ✅

**One subtle issue:** The `n_purged` variable is incremented but used in a separate `_purge_count_only()` call in the `split()` method for logging. The count in the main loop appears to not be returned. This is a logging minor issue, not a correctness issue.

### Embargo Logic

```python
train_idx = np.concatenate([
    np.arange(0, test_start),
    np.arange(test_end + embargo_bars, n_samples),
])
```

**Verified:** The embargo is applied as a gap after the TEST fold, preventing the post-test data from entering training as well. This is correct — it prevents serial correlation from training→test boundary.

**One concern:** The embargo in `PurgedKFold` is applied after the TEST fold, not at the train/test boundary. This is the López de Prado formulation and is correct for K-Fold CV (where folds are scattered). For walk-forward (where test is always after train), the embargo should be applied at the end of the training set — handled by `EmbargoApplier` separately.

### sklearn Compatibility

Inherits from `BaseCrossValidator`, implements `get_n_splits()` and `_iter_test_masks()`.  
**Verdict: ✅ CORRECT — sklearn compatible.**

### Usage

**Verdict: ❌ NOT USED IN TRAINING** — `PurgedKFold` is only used in tests.

---

## 3. EmbargoApplier

**File:** `src/validation/embargo.py`

### Core Logic

```python
def apply_to_indices(self, train_indices, candidate_indices):
    if self._embargo_bars == 0:
        return np.array(list(candidate_indices), dtype=np.intp)
    last_train_idx = max(train_indices)
    embargo_cutoff = last_train_idx + self._embargo_bars
    filtered = np.array(
        [i for i in candidate_indices if i > embargo_cutoff],
        dtype=np.intp,
    )
```

**Verified:** Correctly removes the first `embargo_bars` candidate observations after the last training observation. ✅

**Unit conversion verified:**
- `EmbargoConfig.bars(10).to_bars()` → 10 ✅
- `EmbargoConfig.minutes(15, bars_per_minute=0.2).to_bars()` → `max(1, int(15 * 0.2))` = 3 ✅  
- `EmbargoConfig.days(2, bars_per_day=75).to_bars()` → `max(1, 2 * 75)` = 150 ✅

### Usage

**Verdict: ❌ NOT USED IN TRAINING** — only in tests.

---

## 4. CombinatorialPurgedCV (CPCV)

**File:** `src/validation/combinatorial_cv.py`

### Structure Verification

`CPCVConfig` at line 84: configures `n_splits` (N), `n_test_splits` (k), purge flag, embargo config.

`CombinatorialPurgedCV.split()` at line 165:
```python
def split(self, X, y=None, t1=None, t0=None):
    n = len(X)
    group_size = n // self.config.n_splits
    groups = [range(i * group_size, ...) for i in range(N)]
    
    for test_group_combo in combinations(range(N), k):
        test_idx = np.concatenate([groups[g] for g in test_group_combo])
        train_idx = np.concatenate([groups[g] for g in range(N) if g not in test_group_combo])
        
        if self.config.purge and t1 is not None and t0 is not None:
            train_idx = purge_train_indices_by_t1(train_idx, test_idx, t0, t1)
        
        if self.config.embargo_config:
            train_idx = applier.apply_to_indices(train_idx, train_idx)  # ← POTENTIAL BUG
```

**Potential bug identified:** The embargo line `applier.apply_to_indices(train_idx, train_idx)` applies embargo TO the training indices FROM the training indices — this doesn't look right. The typical embargo application is `applier.apply_to_indices(train_indices_before_test, test_indices)` to remove contaminated observations from the test set. This needs inspection.

Actually reading more carefully at lines 224-240:
```python
if self.config.embargo_config:
    applier = EmbargoApplier(self.config.embargo_config)
    _, train_idx, _ = applier.apply_to_fold(
        train_idx_before_test,
        train_idx,
        test_idx,
    )
```

The actual implementation uses `apply_to_fold` which correctly handles the train/test boundary. The code I saw was not the final implementation.

**Verdict: ✅ CPCV structure appears correct.** The C(N,k) combinations are generated; purging and embargo are applied.

### Usage

**Verdict: ❌ NOT USED IN TRAINING** — only in tests.

---

## 5. FinancialMetricsEvaluator and ModelAcceptanceGate

**File:** `src/validation/metrics.py`

### Verified Metrics

`TradingMetrics` computed correctly:
- Sharpe: `(mean_return - rf) / std × sqrt(252)` ✅
- Sortino: uses only negative returns in denominator ✅
- Max drawdown: peak-to-trough on cumulative returns ✅
- Win rate: fraction of positive return periods ✅
- RISK_FREE_RATE_ANNUAL = 0.065 (6.5% — correct for Indian RBI repo rate)

### ModelAcceptanceGate Logic

At line 714, gate checks:
1. OOS Sharpe > threshold (default 0.0)
2. Max drawdown within limit
3. Performance stable across folds (no single fold dominates)
4. Accuracy above floor

**Verdict: ✅ Gate logic is correctly implemented.**  
**Verdict: ❌ NEVER CALLED from `train_all.py`.**

---

## 6. Summary: Validation Framework Correctness

| Component | Implementation | Correctness | Used in Training |
|---|---|---|---|
| WalkForwardValidator | Rolling + expanding; hard assertions | ✅ CORRECT | ❌ NO |
| PurgedKFold | Label-time purging + embargo; sklearn-compat | ✅ CORRECT | ❌ NO |
| EmbargoApplier | Bars/minutes/days; correct cutoff | ✅ CORRECT | ❌ NO |
| CPCV | C(N,k) splits; purging + embargo | ✅ CORRECT | ❌ NO |
| FinancialMetrics | Sharpe, Sortino, drawdown, win rate | ✅ CORRECT | ❌ NO |
| ModelAcceptanceGate | Dual-pass evidence gate | ✅ CORRECT | ❌ NO |

**Critical finding: The entire validation framework is correct in isolation but entirely disconnected from training.**

The test suite that tests this framework is also failing in the CI environment (missing `sklearn` module). This means even the tests that WOULD verify the framework are not running.
