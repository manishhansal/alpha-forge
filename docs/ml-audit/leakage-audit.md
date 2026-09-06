# AlphaForge ML Service — Leakage Audit

**Audit Date:** 2026-09-06  
**Scope:** Every code path that could introduce future information into training or inference features

---

## 1. Taxonomy of Leakage Types

| Type | Definition | Example |
|---|---|---|
| **Temporal leakage** | Training set contains future observations | Random CV split on time-series data |
| **Label leakage** | Feature is computed from or correlated with the label | A feature that IS the forward return |
| **Look-ahead bias** | A feature at time t uses data from t+1 or later | `rolling(center=True)` swing detection |
| **Survivorship bias** | Universe only contains survivors | Training only on currently-listed stocks |
| **Selection bias** | Non-random selection of training samples | Filtering out "bad" regimes before training |
| **Data snooping** | Repeated hypothesis testing on the same data | HPO optimised on val set that is then reported as OOS |
| **Cross-sectional leakage** | Information from peer stocks at the same timestamp used as a feature but normalised using the full cross-section including future entries | Rank normalisation using future stock data |
| **Pipeline leakage** | Preprocessing step (e.g. scaling) fit on full data including test set | StandardScaler fit on train+test combined |

---

## 2. Confirmed Leakage Instances

### 2.1 🔴 CRITICAL — Temporal Leakage in Training Split

**Location:** `training/train_all.py` — `train_regime_model()` and `train_strategy_model()`  
**Type:** Temporal leakage  
**Mechanism:**
```python
X_train, X_val, y_train, y_val = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
```
`sklearn.train_test_split` randomly shuffles the dataset before splitting. For a time-series of length N, approximately 20% of training samples will be **temporally newer** than 20% of validation samples. The model can effectively memorise future patterns (because "future" training samples appear adjacent to "past" validation samples during gradient computation).

**Affected models:** MarketRegimeClassifier, StrategySelector  
**Impact:** All reported `val_accuracy` for these models is invalid. OOS performance is overstated.  
**How to verify:** Compare val_accuracy from random split vs time-based split on the same data. The gap is typically 5–20% for financial time-series.

---

### 2.2 🔴 CRITICAL — Look-Ahead Bias in BOS/CHOCH Features

**Location:** `features/market_structure.py::detect_bos_choch()` — lines computing swing highs/lows  
**Type:** Look-ahead bias  
**Mechanism:**
```python
swing_high = high.rolling(window=lookback * 2 + 1, center=True).max()
swing_low  = low.rolling(window=lookback * 2 + 1, center=True).min()
```
With `center=True`, the rolling window at bar `i` is centred: it uses bars `[i - lookback, ..., i, ..., i + lookback]`. For `lookback=5`, each swing high computation uses 5 **future** bars. This means features `bos_net`, `choch_net`, and `structure_score` at time `t` encode information about price movements up to `t+5`.

**Propagation:** These features flow into:
- `RANKING_FEATURES` → StockRanker training
- `STRATEGY_FEATURES` → StrategySelector training  
- `RISK_FEATURES` → RiskPredictor training (via `structure_score`)

**Impact:** Any model trained with these features has access to future bar information during training. Even the heuristic `_compute_heuristic_score()` in `StockRanker` uses `structure_score` — meaning **live inference is also contaminated** with look-ahead features from the input window.

**Fix:** `center=False` (default pandas behaviour) on the rolling max/min.

---

### 2.3 🔴 HIGH — VOLATILE Label Uses Forward ATR

**Location:** `models/market_regime.py::generate_regime_labels()`  
**Type:** Look-ahead bias in label construction  
**Mechanism:**
```python
realized_atr_pct = tr.rolling(lookforward).mean() / close * 100
# ...
volatile_mask = (realized_atr_pct > 1.8) & (fwd_return.abs() < 0.03) & ~crash_mask & ~bear_mask
```
`tr.rolling(lookforward).mean()` is a trailing ATR (looking backward). However, it is **not shifted** relative to `fwd_return.shift(-lookforward)`. The ATR window at bar `i` overlaps with the forward-return window used for labeling. Specifically, `realized_atr_pct` at bar `i` uses true range from bars `[i-lookforward+1, ..., i]` (past), while `fwd_return` at bar `i` uses close from bars `[i, ..., i+lookforward]` (future). The label at bar `i` is determined by both backward volatility and forward return — the backward component is correct, but the combination creates a dependency: if the backward ATR is high, it may correlate with the forward return magnitude independently of whether that volatility was truly predictable.

**Net effect:** The VOLATILE label threshold (ATR > 1.8%) is calibrated on a window that partially overlaps with the forward-return label window. Not a pure look-ahead, but a label construction choice that may overstate predictability of the VOLATILE regime.

---

### 2.4 🟡 MEDIUM — VWAP Cross-Session Contamination

**Location:** `features/volume.py::compute_vwap_distance_pct()`  
**Type:** Cross-session contamination (not strict look-ahead, but semantically wrong)  
**Mechanism:**
```python
cum_tp_vol = (typical_price * volume).cumsum()
cum_vol = volume.cumsum()
vwap = cum_tp_vol / cum_vol
```
This cumulates across all bars in the input window. For **daily bars**, the VWAP at bar `i` incorporates all bars from the start of the lookback window (200 days ago), not from the start of the trading session. The feature is named "VWAP distance %" but it computes a multi-month average price.

**Effect in training:** The "VWAP" value at bar `i` depends on which starting bar is included in the lookback window. This creates a strong autocorrelation with the price trend over the entire lookback period. When features are standardised, this correlation may be absorbed into model weights as a trend indicator — not intrinsically wrong but misleading, and inconsistent with how the feature is interpreted (same-day VWAP).

---

### 2.5 🟡 MEDIUM — In-Sample Calibration Quality as Ensemble Weight

**Location:** `meta/calibration.py::CalibrationStore.fit()`  
**Type:** Data snooping / evaluation leakage  
**Mechanism:** ECE and Brier score are computed on the same data used to fit the calibrator. These quality metrics drive ensemble weighting via `EnsembleWeighter`. A model with poor OOS calibration will appear well-calibrated in-sample, receiving a higher ensemble weight than it deserves.

---

### 2.6 🟡 MEDIUM — HPO Leaks Into Validation Set

**Location:** `training/train_all.py::_hpo_xgboost()`  
**Type:** Data snooping (hyperparameter leakage)  
**Mechanism:**
```python
def objective_fn(trial):
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
    y_pred = model.predict(X_val)
    return accuracy_score(y_val, y_pred)

study = optuna.create_study(direction="maximize")
study.optimize(objective_fn, n_trials=n_trials)
```
Optuna selects hyperparameters to maximise performance on `X_val / y_val`. After HPO, the final model is also evaluated on `X_val / y_val`. The validation set is used for **both** hyperparameter selection and final evaluation, causing the reported validation accuracy to be optimistically biased.

**Correct approach:** Hold out a third partition (test set) that is used only for final evaluation and never seen during HPO.

---

### 2.7 🟡 MEDIUM — Survivorship Bias in Training Universe

**Location:** `training/data_pipeline.py` — `TRAINING_UNIVERSE` constant  
**Type:** Survivorship bias  
**Mechanism:** The 50-symbol training universe is today's F&O-eligible stocks. Stocks that were once eligible but have been removed (delisted, excluded from F&O) are absent from historical training data. The model is trained only on "survivors" — stocks that persisted long enough to still be in the F&O list today.

**Effect:** Any signal that predicted which stocks would eventually be delisted or removed from F&O is absent from training. The model's universe is systematically biased toward large, liquid, persistent companies. Performance on the full historical universe (including non-survivors) would be lower.

---

### 2.8 🟡 MEDIUM — No Embargo at Ranking/Risk Train-Val Boundary

**Location:** `training/train_all.py::train_ranking_model()`, `train_risk_model()`  
**Type:** Label overlap leakage  
**Mechanism:**
```python
split_idx = int(len(X) * 0.8)
X_train, X_val = X[:split_idx], X[split_idx:]
```
For a 5-day forward return label, the feature at bar `split_idx - 1` has a label that uses close prices from bars `split_idx` to `split_idx + 4`. Those bars are in the validation set. Without purging/embargo, the training set contains samples whose labels overlap with the validation window.

**Magnitude:** For 5-day labels, the last 5 training samples have label overlap. For 20-day risk labels, the last 20 training samples are contaminated. At a typical 80/20 split with 1000 bars, this is 5–20 out of 800 training samples (0.6–2.5%).

---

### 2.9 🟢 LOW — IV Rank Fallback Uses Fabricated History

**Location:** `features/engineer.py::compute_stock_features()`  
**Type:** Data quality issue (not strict leakage, but produces misleading signal)  
**Mechanism:**
```python
features["iv_rank"] = compute_iv_rank(
    current_iv or 20.0,
    iv_history if iv_history else [15, 18, 20, 22, 25]
)
```
When no IV history is available, a 5-element fake history `[15, 18, 20, 22, 25]` is used. This produces a deterministic IV rank based on the fake history rather than actual historical IV. Not a temporal leak, but an invented signal.

---

## 3. Leakage-Free Paths Confirmed

The following components were verified to be free of look-ahead leakage:

| Component | Verification |
|---|---|
| `build_regime_training_data()` | Feature window `nifty_df.iloc[...i+1]`, label from `i+1` onward |
| `build_ranking_training_data()` | Feature window `df.iloc[...loc+1]`, label from `loc+1` onward |
| `generate_risk_labels()` | `fwd_low = low.iloc[i+1 : i+1+lookforward]` — strictly future |
| `compute_gap_pct()` | Uses `c.shift(1)` — previous bar's close |
| `compute_rsi()` / `compute_macd()` / etc. | All use trailing windows |
| `detect_fair_value_gaps()` | Uses `low.iloc[i]` vs `high.iloc[i-2]` — past bars only |
| `detect_order_blocks()` | Impulse detection uses `close.iloc[i] - close.iloc[i-1]` — current vs prior |
| `detect_liquidity_sweeps()` | `window_high = high.iloc[i-lookback:i].max()` — past only |
| `WalkForwardValidator` | Verified non-overlap invariants enforced by assert |
| `PurgedKFold` | Label end-time based purging — correct |
| `EmbargoApplier` | Embargo applied after last training bar — correct |

---

## 4. Leakage Risk Matrix

| Location | Leakage Type | Severity | Affects | Status |
|---|---|---|---|---|
| `train_all.py` — regime, strategy splits | Temporal | 🔴 CRITICAL | Training metrics | UNRESOLVED |
| `market_structure.py` — `center=True` | Look-ahead | 🔴 CRITICAL | Features + inference | UNRESOLVED |
| `market_regime.py` — VOLATILE ATR | Label construction | 🔴 HIGH | Regime labels | UNRESOLVED |
| `train_all.py` — HPO on val set | Data snooping | 🟡 MEDIUM | HPO metrics | UNRESOLVED |
| `volume.py` — VWAP cumsum | Cross-session | 🟡 MEDIUM | VWAP feature | UNRESOLVED |
| `calibration.py` — in-sample quality | Evaluation | 🟡 MEDIUM | Ensemble weights | UNRESOLVED |
| `TRAINING_UNIVERSE` — static list | Survivorship | 🟡 MEDIUM | All models | UNRESOLVED |
| `train_all.py` — no embargo at boundary | Label overlap | 🟡 MEDIUM | Ranking, risk models | UNRESOLVED |
| `engineer.py` — IV rank fallback | Fabricated signal | 🟢 LOW | IV rank feature | UNRESOLVED |

---

## 5. Leakage Detection Coverage

The existing `assert_no_future_leakage()` function checks Pearson correlation between features and the forward-shifted label:

```python
if abs(corr_future) > 0.95 and abs(corr_future) > abs(corr_now) + 0.1:
    raise AssertionError("Future leakage detected...")
```

**Gaps in this detection:**

1. **Threshold too high:** A feature that is 0.80 correlated with the future label (but only 0.30 with the present label) is a leakage signal but passes the 0.95 threshold.

2. **Monotone transformations:** A feature that is a monotone transformation of the future label (e.g., log, sign) will have a high Pearson correlation but not necessarily > 0.95. The BOS/CHOCH features, being rolling aggregates over a window that includes future bars, may not hit 0.95 correlation with the raw label.

3. **Indirect leakage:** A feature derived from another feature that is leaked will have reduced but non-zero correlation. For example, `structure_score` (contaminated with look-ahead) will not hit 0.95 correlation with the forward return label — but it still encodes partial future information.

4. **Cross-sectional leakage:** Not checked at all.

5. **Only checks one label column:** The function checks one label column at a time. It does not check whether the feature itself was derived using information from multiple stocks simultaneously.

**Recommended supplement:**

```python
# Stronger check: mutual information or rank correlation at multiple shifts
from sklearn.feature_selection import mutual_info_regression

for lag in range(1, horizon + 1):
    mi = mutual_info_regression(
        X_features,
        labels.shift(-lag).dropna()
    )
    # Flag any feature with MI > threshold at any forward lag
```

---

## 6. Recommended Leakage Prevention Checklist

For any new feature or model, the following must be verified before inclusion:

- [ ] Feature at time `t` only uses data from `t` and earlier
- [ ] No rolling window uses `center=True` or `min_periods` that allows future data
- [ ] No `shift(-n)` operation appears in the feature computation path (only in label generation)
- [ ] If a scaler is applied, it is fit only on the training fold, not the full dataset
- [ ] Walk-forward splits are used; no `train_test_split` with shuffling
- [ ] Embargo gap equals or exceeds the label horizon
- [ ] Training universe is point-in-time (no survivors from future)
- [ ] Calibration quality is measured on held-out OOS predictions
- [ ] HPO uses a held-out test set not seen during hyperparameter search
- [ ] `assert_no_future_leakage()` is run (acknowledging its limitations above)
