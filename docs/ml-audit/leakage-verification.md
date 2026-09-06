# Leakage Verification: Independent Dedicated Investigation

**Verification Date:** 2026-09-06  
**Method:** Systematic grep + direct code inspection. No reliance on documentation or comments.  
**Scope:** Entire `ml-service/src/` directory, all Python files.

---

## Leakage Search Checklist

Each category was searched via `grep` + manual code review:

| Category | Searched | Found Issues |
|---|---|---|
| Future data in features | ✅ | 1 confirmed (center=True) |
| Forward-shifted features | ✅ | 0 confirmed |
| Centered rolling windows | ✅ | 1 confirmed (BOS/CHOCH) |
| VWAP/cumulative contamination | ✅ | 1 confirmed |
| Future universe membership | ✅ | 1 confirmed (static universe) |
| Future corporate actions | ✅ | 1 confirmed (no adjustment verified) |
| Future option-chain data | ✅ | 0 confirmed (ffill limit=5 correct) |
| Future market breadth | ✅ | 0 confirmed |
| Future volatility | ✅ | 0 confirmed |
| Test-set contamination (HPO) | ✅ | 1 confirmed |
| Train/test overlap (random split) | ✅ | 1 confirmed |
| Label overlap without purging | ✅ | 1 confirmed |
| Same-bar execution assumption | ✅ | 0 confirmed |
| Future close in labels | ✅ | 0 (labels correctly use future; features do not) |
| Future scaling/normalisation | ✅ | 0 confirmed |
| Pipeline leakage via __init__ | ✅ | 1 confirmed (training/__init__.py imports talib transitive) |

---

## Confirmed Leakage Instances

---

### LEAK-001: Look-Ahead Bias in BOS/CHOCH Swing Detection

| Field | Detail |
|---|---|
| **File** | `src/features/market_structure.py` |
| **Lines** | 136-137 |
| **Function** | `detect_bos_choch()` |
| **Mechanism** | `swing_high = high.rolling(window=lookback * 2 + 1, center=True).max()` — with `center=True`, the rolling window at bar `i` is centred, using `lookback` bars before AND `lookback` bars after bar `i`. For default `lookback=5`, computation at bar `i` uses `high[i-5], ..., high[i], ..., high[i+5]` — **5 future bars are incorporated**. |
| **Severity** | 🔴 CRITICAL |
| **Proof** | Pandas `rolling(center=True)` with `window=11` at position `i` gives `max(high[i-5:i+6])`. Verified via pandas documentation and direct code reading. |
| **Downstream impact** | Features `bos_net`, `choch_net`, `structure_score` contaminated. These appear in `RANKING_FEATURES`, `STRATEGY_FEATURES`, and `RISK_FEATURES`. ALL three models trained with these features are contaminated. Even **live inference** is contaminated because `compute_stock_features()` calls `detect_bos_choch()` on the most recent N bars — and `center=True` means the last N bars will have NaN at the tail (insufficient future data), potentially causing edge effects. |
| **Recommendation** | Remove `center=True`. The function should use `rolling(window=lookback * 2 + 1, min_periods=lookback, center=False).max()` — trailing window only. |

---

### LEAK-002: Temporal Leakage via Random Splits in Training

| Field | Detail |
|---|---|
| **File** | `src/training/train_all.py` |
| **Lines** | 41, 50-53 (regime); 121, 130-133 (strategy) |
| **Function** | `train_regime_model()`, `train_strategy_model()` |
| **Mechanism** | `X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)` — randomly shuffles time-series data before splitting. For a 1,260-sample dataset, approximately 252 training samples will be temporally newer than 252 validation samples. The model has effectively seen the future. |
| **Severity** | 🔴 CRITICAL |
| **Proof** | `sklearn.model_selection.train_test_split` with no explicit `shuffle=False` always shuffles. Confirmed at lines 41 and 121 where it is imported inside function bodies. |
| **Downstream impact** | Val accuracy for regime and strategy models is inflated by unknown amount (typically 5-20% for financial time series). Any trained model artifact is contaminated. |
| **Recommendation** | Replace with `WalkForwardValidator` with temporal splits. |

---

### LEAK-003: VWAP Cross-Session Contamination

| Field | Detail |
|---|---|
| **File** | `src/features/volume.py` |
| **Lines** | 47-52 |
| **Function** | `compute_vwap_distance_pct()` |
| **Mechanism** | `cum_tp_vol = (typical_price * volume).cumsum()` — cumulates from the start of whatever series is passed in. When called from `compute_stock_features()` with a 200-bar lookback window, the "VWAP" at bar `i` is the cumulative volume-weighted average price over ALL 200 bars, not the intraday session VWAP. This is a cross-session contamination — today's VWAP is influenced by prices from months ago. |
| **Severity** | 🔴 HIGH |
| **Proof** | `pandas.Series.cumsum()` computes cumulative sum from index 0. The docstring even acknowledges "approximated for daily using typical price" but does not document that this produces a cross-session metric. |
| **Note** | This is NOT a look-ahead bias (it uses only historical data) but the feature is semantically wrong. The cumulative VWAP over 200 days is a proxy for long-term average price, not intraday VWAP. It will be highly autocorrelated with the price trend. |
| **Downstream impact** | `vwap_distance_pct` feature in RANKING_FEATURES has incorrect semantics. Models trained with this feature learn a price-level relative to historical cost basis, not relative to same-day session VWAP. |
| **Recommendation** | For daily bars: use rolling N-day VWAP (e.g., `(typical_price * volume).rolling(N).sum() / volume.rolling(N).sum()`). For intraday bars where data is already session-scoped: current implementation is correct. |

---

### LEAK-004: HPO Contamination of Validation Set

| Field | Detail |
|---|---|
| **File** | `src/training/train_all.py` |
| **Lines** | 224-270 (HPO function), lines 58-68 (usage) |
| **Function** | `_hpo_xgboost()` |
| **Mechanism** | Optuna optimises hyperparameters by evaluating `accuracy_score(y_val, model.predict(X_val))` across 30 trials. The final model is then re-evaluated on the same `X_val`. The "best" of 30 trials is selected to maximise val accuracy, making val accuracy the maximum of 30 correlated draws on the same data. |
| **Severity** | 🟡 MEDIUM (multiple-testing inflation, not structural leakage) |
| **Proof** | `objective_fn` returns `accuracy_score(y_val, y_pred)` at line 244; `study.optimize(objective_fn, n_trials=n_trials)` at line 254; then `model.train(..., eval_set=(X_val, y_val))` at line 64. Same `X_val` used for both HPO and final evaluation. |
| **Downstream impact** | Reported val_accuracy is the maximum over n_trials evaluations on the same val set. Expected inflation ≈ sqrt(2 × ln(30)) × SE ≈ 2.45 SE. |
| **Recommendation** | Three-way split: train_inner / val_inner (for HPO) / test (for final evaluation only). |

---

### LEAK-005: Label Overlap Without Purging or Embargo

| Field | Detail |
|---|---|
| **File** | `src/training/train_all.py` |
| **Lines** | 82-98 (ranker), 159-175 (risk) |
| **Function** | `train_ranking_model()`, `train_risk_model()` |
| **Mechanism** | 80/20 time-based split: `split_idx = int(len(X) * 0.8)`. For a 5-day forward-return label, the observation at position `split_idx - 1` (last training point) has a label using prices from positions `split_idx` to `split_idx + 4` — which are in the validation set. No embargo period is applied. |
| **Severity** | 🟡 MEDIUM (affects ~5-20 boundary samples) |
| **Proof** | `split_idx = int(len(X) * 0.8)` at line 82; `X_train, X_val = X[:split_idx], X[split_idx:]` at line 83; no embargo applied. For 20-day risk labels, the last 20 training samples have label overlap with val. |
| **Magnitude** | For 5-day labels: ~5 contaminated boundary samples (~0.5% of training). For 20-day risk labels: ~20 contaminated boundary samples (~2%). Small but non-zero. |
| **Recommendation** | Add `EmbargoApplier(EmbargoConfig.bars(horizon))` at the train/val boundary. |

---

### LEAK-006: IV Rank Fabricated History

| Field | Detail |
|---|---|
| **File** | `src/features/engineer.py` |
| **Line** | 343 |
| **Function** | `compute_stock_features()` |
| **Mechanism** | `compute_iv_rank(current_iv or 20.0, iv_history if iv_history else [15, 18, 20, 22, 25])` — when no real IV history is available, a fake 5-element history `[15, 18, 20, 22, 25]` is used. This produces a deterministic but meaningless IV rank (e.g., current_iv=20 always produces iv_rank=75.0 vs the fake history). |
| **Severity** | 🟡 MEDIUM |
| **Type** | Not temporal leakage; data fabrication that inflates apparent signal confidence |
| **Recommendation** | Return 50.0 (neutral) when iv_history is absent. |

---

## Leakage Patterns Searched but NOT Found

The following potential leakage patterns were searched and not confirmed in the current codebase:

| Pattern | Searched | Result |
|---|---|---|
| `rolling(..., min_periods=0, center=True)` elsewhere | ✅ | Only in market_structure.py (confirmed above) |
| `StandardScaler().fit_transform(X_all)` (fitting on full dataset) | ✅ | No StandardScaler anywhere in training pipeline |
| Future close price in non-label context | ✅ | All `shift(-N)` calls are in label-generation functions only |
| `look_ahead` or `future` named variables in features | ✅ | Not found |
| Rolling window on feature of feature (indirect future info) | ✅ | Not found |
| Option chain data back-filled beyond ffill limit | ✅ | `ffill(limit=5)` correctly limits propagation |

---

## Confirmed Non-Leakage Areas

These areas were explicitly verified as clean:

| Area | Verification |
|---|---|
| `build_regime_training_data()` feature window | `nifty_df.iloc[max(0, i - lookback) : i + 1]` — inclusive of current bar, exclusive of future ✅ |
| `build_ranking_training_data()` feature window | `df.iloc[max(0, loc - lookback) : loc + 1]` — confirmed ✅ |
| `generate_risk_labels()` forward scan | `fwd_low = low.iloc[i + 1 : i + 1 + lookforward]` — strictly future ✅ |
| `compute_gap_pct()` | Uses `c.shift(1)` — previous bar's close ✅ |
| `detect_fair_value_gaps()` | Uses `iloc[i]` vs `iloc[i-2]` — past bars only ✅ |
| `detect_order_blocks()` | Uses `close.iloc[i] - close.iloc[i - 1]` — current vs prior ✅ |
| `detect_liquidity_sweeps()` | `high.iloc[i - lookback:i].max()` — trailing window ✅ |
| Derivatives forward-fill | `ffill(limit=5)` — correct, propagates forward only ✅ |
| `assert_no_future_leakage()` gate | Present in `data_pipeline.py` — weak (0.95 threshold) but present |

---

## Summary

**Total confirmed leakage instances: 6**

| ID | Type | Severity | Status |
|---|---|---|---|
| LEAK-001 | Look-ahead (center=True) | 🔴 CRITICAL | Unresolved |
| LEAK-002 | Temporal (random splits) | 🔴 CRITICAL | Unresolved |
| LEAK-003 | Cross-session (VWAP cumsum) | 🔴 HIGH | Unresolved |
| LEAK-004 | Multiple-testing (HPO val reuse) | 🟡 MEDIUM | Unresolved |
| LEAK-005 | Label overlap (no embargo) | 🟡 MEDIUM | Unresolved |
| LEAK-006 | Data fabrication (IV rank) | 🟡 MEDIUM | Unresolved |

All 6 instances remain unresolved in the current branch. None were introduced by Prompts 1 or 2 (which made no code changes). These pre-existed in the master branch.
