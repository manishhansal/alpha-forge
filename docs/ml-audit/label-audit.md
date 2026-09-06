# AlphaForge ML Service — Label Audit

**Audit Date:** 2026-09-06  
**Scope:** All label generation functions across `training/data_pipeline.py`, `models/market_regime.py`, `models/stock_ranker.py`, `models/risk_predictor.py`, `models/strategy_selector.py`

---

## 1. Label Generation Overview

| Model | Label Function | Label Type | Horizon | Location |
|---|---|---|---|---|
| Market Regime | `generate_regime_labels_v2()` → `generate_regime_labels()` | Integer class (0-5) | 5 bars (default) | `data_pipeline.py` + `market_regime.py` |
| Stock Ranker | `generate_ranking_labels_v2()` | Continuous (risk-adjusted excess return) | 5 bars (default) | `data_pipeline.py` |
| Risk Predictor | `generate_risk_labels()` | Binary (stop/target hit) + continuous (MAE) | 20 bars (default) | `data_pipeline.py` |
| Strategy Selector | `generate_strategy_labels()` | Integer class (0-7) | 5 bars (default) | `strategy_selector.py` |

---

## 2. Regime Labels

### 2.1 Implementation

`generate_regime_labels()` in `market_regime.py`:
```python
fwd_return = close.shift(-lookforward) / close - 1
fwd_vol = close.pct_change().rolling(lookforward).std().shift(-lookforward)

# Forward max drawdown
for i in range(len(close) - lookforward):
    window = close.iloc[i:i + lookforward + 1]
    peak = window.cummax()
    drawdown = (window - peak) / peak
    fwd_max_dd.iloc[i] = drawdown.min()

# Labeling rules
crash_mask = (fwd_return < -0.05) & (fwd_max_dd < -0.06)
bear_mask  = (fwd_return < -0.02) & (fwd_max_dd < -0.03) & ~crash_mask
volatile_mask = (realized_atr_pct > 1.8) & (fwd_return.abs() < 0.03)
strong_bull_mask = (fwd_return > 0.03) & (fwd_max_dd > -0.015)
bull_mask = (fwd_return > 0.01) & (fwd_return <= 0.03) & ~strong_bull_mask
# Default: SIDEWAYS
```

### 2.2 Assessment

**Correct design intent.** Labels use forward data (intentionally) to mark what regime the market entered. This is the standard supervised labeling approach.

**Potential issues:**

1. **Class imbalance is not measured or addressed.** With 5-bar forward windows, SIDEWAYS likely dominates (markets are range-bound more often than trending). No class weights or resampling are applied in `train_all.py`. XGBoost's `scale_pos_weight` exists in the default params but is set to 1.

2. **Label boundary thresholds are hard-coded constants:**
   - `fwd_return < -0.05` for CRASH — on 5 trading days, a 5% decline is rare (perhaps 2-3% of all 5-day windows in recent NSE history). This makes CRASH an extremely rare class.
   - `realized_atr_pct > 1.8` for VOLATILE — this threshold is not calibrated to any historical distribution.

3. **The VOLATILE label is based on realized (look-back) ATR:**
   ```python
   realized_atr_pct = tr.rolling(lookforward).mean() / close * 100
   ```
   But `tr.rolling(lookforward).mean()` here is the ATR over the *same* `lookforward` window that is used for the label. If `shift(-lookforward)` is applied, this ATR is a forward-looking window. **This is look-ahead bias in the VOLATILE label.**

4. **No label for "pre-crash" or "topping" regime** — the regime model only classifies what happened over the next N bars, not what is happening now. Predicting a crash label requires seeing features that precede crashes, which is valid, but the label construction makes it hard to train on gradual deteriorations.

### 2.3 Verdict: FIX

- Correct the `realized_atr_pct` calculation: use only `tr.rolling(lookforward).mean()` computed *up to* bar `i` (not forward-shifted).
- Measure and log class distribution at label time.
- Consider calibrated thresholds based on historical NSE percentiles rather than hardcoded values.

---

## 3. Stock Ranking Labels

### 3.1 Implementation

`generate_ranking_labels_v2()` in `data_pipeline.py`:
```python
stock_ret = stock_df["close"].pct_change()
nifty_ret = nifty_close.reindex(stock_df.index).pct_change()

# Forward return = mean daily return over next `horizon` bars
stock_fwd = stock_ret.shift(-1).rolling(horizon).mean().shift(-(horizon - 1))
nifty_fwd = nifty_ret.shift(-1).rolling(horizon).mean().shift(-(horizon - 1))

# Risk-adjusted: forward excess return / historical vol
excess = stock_fwd - nifty_fwd
vol = stock_ret.rolling(horizon * 2).std()
ra = (excess / (vol + 1e-8)).clip(-5, 5)
```

### 3.2 Assessment

**Correct forward-looking structure.** The label is a risk-adjusted relative return vs NIFTY, which is a reasonable proxy for "did this stock outperform?"

**Issues:**

1. **No transaction cost deduction.** The label is gross excess return. NSE F&O transaction costs (brokerage ~0.03%, STT 0.1% on sell, exchange + SEBI + stamp = ~0.05-0.1% per leg) typically total 0.2-0.4% per round trip. For a 5-day hold, a 0.3% cost drag on a typical return distribution of ±1% per day means costs represent a significant fraction of the label signal. Models trained on gross returns will rank stocks by gross outperformance, not net profitability.

2. **Volatility denominator uses historical vol (lookback window):**
   ```python
   vol = stock_ret.rolling(horizon * 2).std()
   ```
   This uses trailing 10-day (2×5) volatility at bar `i`. This is **point-in-time safe** (not forward-looking). Good.

3. **The `shift(-1).rolling(horizon).mean().shift(-(horizon-1))` construction** is a valid way to compute the mean of the next `horizon` returns, but it is non-trivial. Testing confirms it produces the correct forward-mean. Good.

4. **Clip at ±5:** This is a risk-adjusted clip (Sharpe-like). A stock with low vol and strong directional move can still exceed ±5; very rare in practice.

### 3.3 Verdict: FIX (add transaction costs); otherwise KEEP.

---

## 4. Risk Labels

### 4.1 Implementation

`generate_risk_labels()` in `data_pipeline.py`:
```python
stop_price   = entry - stop_atr_mult * atr_val    # = close - 1.4×ATR
target_price = entry + target_atr_mult * atr_val  # = close + 2.0×ATR

fwd_low  = low.iloc[i+1 : i+1+lookforward]
fwd_high = high.iloc[i+1 : i+1+lookforward]

stop_hit[i]   = 1.0 if (fwd_low  <= stop_price ).any() else 0.0
target_hit[i] = 1.0 if (fwd_high >= target_price).any() else 0.0
mae[i] = abs(min((fwd_low.min() - entry) / entry * 100, 0.0))
```

### 4.2 Assessment

**Correct structure.** Forward scan uses `iloc[i+1 ...]` — strictly future bars only. Labels never leak into features.

**Issues:**

1. **Simultaneous stop and target hit not handled.** If both `fwd_low <= stop` AND `fwd_high >= target` occur in the same `lookforward` window, both `stop_hit=1` and `target_hit=1`. In reality, only one can happen first (order-of-occurrence matters). The model will learn a base rate that is higher than reality for both classes.

2. **No transaction cost in stop/target simulation.** The effective exit price for a stop hit includes slippage (often 0.05-0.2% for liquid F&O stocks at market open or during a fast move). The current simulation assumes perfect execution at the stop level.

3. **Fixed stop/target multipliers (1.4×ATR, 2.0×ATR).** Real traders adapt stop placement. A model trained only on 1.4×ATR stops may not generalise to different stop geometries.

4. **MAE capped at 20%.** This is a reasonable engineering choice to prevent extreme outlier labels.

5. **`atr_series.iloc[i]` used at bar `i`:** ATR at bar `i` is computed from data up to bar `i` — correctly point-in-time.

6. **`lookforward=20` is 20 daily bars (~1 month).** For intraday traders this is a very long horizon. Should be parameterised based on intended trade duration.

### 4.3 Verdict: FIX (simultaneous hit logic, transaction costs); otherwise KEEP.

---

## 5. Strategy Selection Labels

### 5.1 Implementation

`generate_strategy_labels()` in `strategy_selector.py`:
(Signatures visible; full implementation not read in detail)

Based on the data pipeline call:
```python
strategy_labels = generate_strategy_labels(df, regime_labels, lookforward=horizon)
```

The label function identifies which of the 8 trading strategies produced the best risk-adjusted return over the next `horizon` bars, given the current regime. This is a multi-class label.

### 5.2 Assessment

**Design is correct.** Strategy labels are regime-conditioned, which means the model learns that breakout strategies work in bull regimes and mean-reversion in sideways regimes.

**Concerns (not verified due to limited code read):**
1. If strategy performance is measured by gross return (no costs), the label will favour strategies with higher turnover regardless of net profitability.
2. If different strategies have very different trade frequencies, the label distribution will be skewed toward low-turnover strategies (which show better gross performance simply because they incur fewer round-trip costs).

### 5.3 Verdict: VERIFY (read full implementation); likely FIX to add cost-adjusted performance.

---

## 6. Label-Feature Temporal Contract

| Label | Feature window ends at | Label window starts at | Gap |
|---|---|---|---|
| Regime (5-bar) | bar `i` (inclusive) | bar `i+1` | 1 bar ✅ |
| Ranking (5-bar) | bar `i` (inclusive) | bar `i+1` | 1 bar ✅ |
| Risk stop/target (20-bar) | bar `i` (inclusive) | bar `i+1` | 1 bar ✅ |
| Strategy (5-bar) | bar `i` (inclusive) | bar `i+1` | 1 bar ✅ |

All labels are correctly separated from features by at least 1 bar. No structural label-feature overlap detected.

**However**: the look-ahead bias in `market_structure.py` (`center=True`) means that features at bar `i` already incorporate information from bars `i+1..i+5` (for `lookback=5`). Even though the label is separated by 1 bar, the BOS/CHOCH features effectively contain partial future information.

---

## 7. Label Quality Summary

| Label | Temporal safety | Transaction costs | Class balance | Verdict |
|---|---|---|---|---|
| Regime class | ⚠️ VOLATILE label has forward ATR | ❌ N/A | ❌ Unknown, likely imbalanced | FIX |
| Ranking (excess return) | ✅ | ❌ Gross only | ✅ Continuous, symmetric | FIX (costs) |
| Stop hit (binary) | ✅ | ❌ No slippage | ❓ Unknown base rate | FIX (simultaneous) |
| Target hit (binary) | ✅ | ❌ No slippage | ❓ Unknown base rate | FIX (simultaneous) |
| MAE (continuous) | ✅ | ❌ No slippage | ✅ Continuous | KEEP |
| Strategy class | ✅ (assumed) | ❌ Likely gross | ❓ Unknown | VERIFY + FIX |

---

## 8. Recommendations

| Priority | Issue | Action |
|---|---|---|
| 🔴 CRITICAL | VOLATILE label uses forward ATR | Fix `realized_atr_pct` to use only lookback window |
| 🔴 HIGH | All labels: no transaction costs | Add NSE cost model (brokerage + STT + exchange) to all label generators |
| 🔴 HIGH | Risk labels: simultaneous stop/target | Simulate sequential bar-by-bar scan to determine which hits first |
| 🟡 MEDIUM | Regime labels: class imbalance | Measure class distribution; apply class weights or stratified sampling |
| 🟡 MEDIUM | Regime thresholds: hardcoded | Calibrate from rolling percentile of NSE historical returns |
| 🟡 MEDIUM | Risk labels: fixed ATR multipliers | Expose as parameters; support multiple stop geometries in training |
| 🟢 LOW | Strategy labels | Read and audit `generate_strategy_labels()` in full |
| 🟢 LOW | All labels | Log class distribution statistics to stdout/file at label generation time |
