# AlphaForge ML Service — Feature Audit

**Audit Date:** 2026-09-06  
**Scope:** `features/` — all 7 modules + `features/engineer.py`

---

## 1. Feature Inventory

### 1.1 Feature Sets by Model

| Feature Set | Count | File | Models Using |
|---|---|---|---|
| `REGIME_FEATURES` | 28 | `engineer.py` | MarketRegimeClassifier |
| `RANKING_FEATURES` | 65+ | `engineer.py` | StockRanker |
| `STRATEGY_FEATURES` | 17 | `engineer.py` | StrategySelector |
| `RISK_FEATURES` | 18 | `engineer.py` | RiskPredictor |

All feature lists are defined centrally in `engineer.py` and imported by each model — this is correct architecture.

### 1.2 Feature Categories

| Category | Module | Count (approx) | Quality |
|---|---|---|---|
| Technical indicators | `technical.py` | 18 | ✅ Good |
| Volume / flow | `volume.py` | 10 + VPIN | ✅ Good |
| Momentum / trend | `momentum.py` | 12 | ✅ Good |
| Derivatives (F&O) | `derivatives.py` | 10 | ⚠️ IV rank fallback issue |
| Market structure (SMC) | `market_structure.py` | 8 | ❌ Look-ahead bug |
| Macro / time / expiry | `macro.py` | 20 | ✅ Good |
| **Total** | | **~78 base** (150+ after engineering) | |

---

## 2. Module-by-Module Analysis

### 2.1 `technical.py`

**What it does:** RSI, MACD, ADX, ATR, Bollinger Bands, EMA stack, Stochastic RSI, Williams %R, CCI, MFI, CMF, OBV, VWAP, Supertrend, candlestick patterns (engulfing, hammer, doji), HT_TRENDLINE deviation.

**Implementation quality:** Uses TA-Lib and the `ta` library for standard indicators. Wrapper functions `_to_f64()`, `_last_finite()`, `_wrap()` are correct. All indicators are standard and well-known.

**Leakage risk:** None detected. All indicators are computed from historical data only.

**Issues:**
- `compute_vwap()` computes an intraday VWAP using `cumsum()` over the entire series passed in. For daily bars, this is not an intraday VWAP — it is a multi-day cumulative VWAP from the beginning of the data window. This produces a number that is unlikely to match what traders use as VWAP (same issue in `volume.py`).

**Verdict: FIX** (VWAP); rest KEEP.

---

### 2.2 `volume.py`

**What it does:** Relative volume, volume breakout flag, volume trend ratio, volume-price confirmation, VWAP distance %, volume profile score, A/D line, Force Index, Volume Oscillator, VPIN.

**VWAP issue (Critical for daily data):**
```python
def compute_vwap_distance_pct(close, high, low, volume):
    typical_price = (high + low + close) / 3
    cum_tp_vol = (typical_price * volume).cumsum()   # ← cumsum from start of series
    cum_vol = volume.cumsum()
    vwap = cum_tp_vol / cum_vol
```

For **intraday bars** reset to session start, this is correct. For **daily bars** (which is how the training pipeline uses it), `cumsum()` runs from the start of the lookback window (e.g., 200 bars back), not from the start of today. The resulting "VWAP" is a rolling cumulative price over months, not a meaningful same-day VWAP. This feature will have positive autocorrelation over long windows and will co-move with a long-term price trend — not a volatility/microstructure signal.

**VPIN implementation:** The VPIN bucket computation (tick rule: 85% buy if close > prev_close, 15% otherwise) is standard and correctly implemented. The use of the bar's own open as the reference for the first bar (`prev_close = bar.get("open", bar["close"])`) is a reasonable approximation.

**Volume profile score:** Uses an O(n²) loop — `for i in range(lookback, len(close)):` — inside `compute_stock_features()`. For a 200-bar window and 50 F&O stocks this is ~200×50 = 10,000 iterations on every inference call. This is a performance concern in production.

**Verdict: FIX** (VWAP cumsum for daily bars); KEEP rest; OPTIMIZE volume profile.

---

### 2.3 `momentum.py`

**What it does:** Multi-period returns (1, 2, 3, 5, 10, 20, 60 days), ROC, raw momentum, relative strength vs index (Mansfield RS), sector momentum, trend strength via linear regression, ATR expansion, breakout score with volume confirmation, gap %, distance from 52w high/low, higher-highs/higher-lows structure.

**Implementation quality:** All functions are point-in-time safe. Linear regression slope for trend strength uses only historical bars. Breakout score correctly uses `rolling_high.shift(1)` (prior bar's high, not current).

**One functional issue:** `compute_sector_momentum()` returns a `pd.Series` of constant value (the mean sector return repeated `len(close)` times). The function does not compute a rolling per-bar sector momentum — it computes a single scalar for "today" and repeats it. This is used in `engineer.py` as `features["sector_momentum"]` which takes `_last()` of the series, so the scalar is correct, but the function name and signature are misleading.

**Verdict: KEEP** (core functions correct); FIX sector_momentum signature documentation.

---

### 2.4 `derivatives.py`

**What it does:** PCR normalization to [-1,1], OI buildup quadrant classification, IV rank (0-100), IV percentile, max-pain distance %, OI wall proximity, options flow composite features, PCR change.

**IV rank fallback issue:**
```python
def compute_iv_rank(current_iv, iv_history, period=252):
    if not iv_history or len(iv_history) < 5:
        return 50.0  # Default to middle when insufficient data
```

In `engineer.py`, the fallback when no derivatives data is provided:
```python
features["iv_rank"] = compute_iv_rank(
    current_iv or 20.0, iv_history if iv_history else [15, 18, 20, 22, 25]
)
```

The hardcoded `[15, 18, 20, 22, 25]` is a 5-element fake history with IV ranging from 15 to 25. With these values, an `atm_iv` of 20 produces `iv_rank = 75.0` (current=20 is at the 75th percentile of [15,18,20,22,25]). This is a made-up value, not a meaningful signal.

**IV percentile vs IV rank:** Both are implemented correctly and are distinct (percentile is more robust for tail events). The choice between them is left to the caller.

**OI wall score:** The formula `(ce_dist - pe_dist) / (ce_dist + pe_dist)` correctly gives +1 when CE wall is far above and PE wall is close (bullish support), -1 when reversed. This is a reasonable approximation.

**Verdict: FIX** (IV rank fallback); KEEP rest.

---

### 2.5 `market_structure.py` ← CRITICAL BUG

**What it does:** Fair Value Gaps (FVG), Order Blocks (OB), Break of Structure (BOS) / Change of Character (CHOCH), liquidity sweeps.

**LOOK-AHEAD BUG in `detect_bos_choch()`:**
```python
swing_high = high.rolling(window=lookback * 2 + 1, center=True).max()
swing_low  = low.rolling(window=lookback * 2 + 1, center=True).min()
```

`center=True` means the rolling window is **centred** on each bar. For a window of 11 (`lookback=5`), computing the swing high at bar `i` uses bars `i-5` to `i+5` — it looks **5 bars into the future**. This is a straightforward look-ahead bias that inflates the apparent predictive power of BOS/CHOCH features.

**Fix:** Change to `center=False` (or equivalently remove the `center=True` argument since `False` is the default). The swing high at bar `i` should use only bars `i-lookback*2` to `i`.

**FVG and Order Block detection:** Both use only current and prior bars (`iloc[i]`, `iloc[i-1]`, `iloc[i-2]`) — correctly point-in-time.

**Liquidity sweep detection:** Uses `high.iloc[i-lookback:i].max()` (prior bars only) — correctly point-in-time.

**Verdict: FIX** `detect_bos_choch()` `center=True` immediately; KEEP rest.

---

### 2.6 `macro.py`

**What it does:** Market breadth (% above SMA20/50/200), advance/decline ratio, sector rotation Z-scores and rotation score, India VIX regime classification, inter-market features (Nifty, BankNifty, US futures, crude, USD/INR), time-of-day features (NSE session zones), F&O expiry proximity features.

**Implementation quality:** All functions are point-in-time safe. VIX percentile uses historical VIX series correctly. Time-of-day features use cyclical encoding (sin/cos) which is appropriate for neural models.

**Expiry features:** `weekly_theta_pressure = 1.0 / max(weekly, 0.5)` creates a hyperbolic function that spikes sharply when `weekly=1` (day before expiry). This is a reasonable approximation of theta decay acceleration. The `0.5` floor prevents division by zero.

**`breadth_thrust`:** Always returns `0.0` — "Requires historical breadth data" comment. This feature is in `REGIME_FEATURES` but is always zero. A zero-variance feature wastes a slot and may cause issues in tree models if they encounter it in training.

**Verdict: FIX** breadth_thrust (implement or remove from feature list); KEEP rest.

---

### 2.7 `engineer.py` — Feature Orchestrator

**What it does:** Calls all 6 feature modules and assembles a flat dict of 150+ features. Provides canonical feature lists for all 4 models.

**Assessment:**

1. `compute_stock_features()` is correct in structure: features are computed from `ohlcv` (historical window ending at current bar) and `macro_context` (market-wide features already computed).

2. `_last(series)` helper safely extracts the final value with NaN/Inf guard. Used consistently.

3. NaN/Inf cleanup at the end of `compute_stock_features()` ensures no NaN propagates to models.

4. **Minor issue:** `features["obv_trend"]` is set twice — once from `compute_obv_trend()` and once overwritten two lines later. The second write is identical to the first. No functional impact but indicates copy-paste error.

5. **Feature naming inconsistency:** `RANKING_FEATURES` includes `"atr_expansion"` but the feature is stored in the dict as `"atr_expansion"` — consistent. However `"breakout_score"` in `RANKING_FEATURES` but `features["breakout_score"]` is correct.

**Verdict: FIX** obv_trend double-write; FIX breadth_thrust placeholder; KEEP overall structure.

---

## 3. Feature Leakage Summary

| Feature | Module | Leakage Type | Severity |
|---|---|---|---|
| `bos_net`, `choch_net`, `structure_score` | `market_structure.py` | Direct look-ahead (center=True) | 🔴 CRITICAL |
| `vwap_distance_pct` | `volume.py` | Cross-session contamination | 🟡 MEDIUM |
| `iv_rank` (when no history) | `derivatives.py` | Fabricated value | 🟡 MEDIUM |
| `breadth_thrust` | `macro.py` | Always zero — not a leak, but dead feature | 🟢 LOW |
| All others | Various | None detected | ✅ |

---

## 4. Feature Stability and Regime Sensitivity

- Technical indicators (RSI, MACD, ADX) are standard and regime-agnostic by construction — appropriate.
- OI/derivatives features are highly India-specific and capture genuine institutional flow signals.
- Market structure features (FVG, OB, BOS) encode Smart Money Concepts (SMC) — popular in retail trading communities but their statistical predictive validity in quantitative backtests is unproven. After fixing the look-ahead bias, their marginal contribution should be measured on OOS data before assigning high weights.
- VPIN is theoretically grounded (PIN model) and is the strongest flow-toxicity measure in the codebase.

---

## 5. Recommendations

| Priority | Feature / Module | Action |
|---|---|---|
| 🔴 CRITICAL | `market_structure.py:detect_bos_choch()` | Change `center=True` → `center=False` |
| 🔴 HIGH | `volume.py:compute_vwap_distance_pct()` | Reset cumsum per trading session for daily data |
| 🔴 HIGH | `derivatives.py:compute_iv_rank()` fallback | Remove hardcoded `[15,18,20,22,25]`; return 50.0 when no history |
| 🟡 MEDIUM | `macro.py:compute_market_breadth()` | Implement `breadth_thrust` or remove from `REGIME_FEATURES` |
| 🟡 MEDIUM | `engineer.py` | Remove duplicate `features["obv_trend"]` write |
| 🟡 MEDIUM | `volume.py:compute_volume_profile_score()` | Replace O(n²) Python loop with vectorized computation |
| 🟢 LOW | `momentum.py:compute_sector_momentum()` | Clarify return type; make rolling per-bar if intended |
| 🟢 LOW | All SMC features | After fixing look-ahead, measure OOS IC before weighting heavily |
