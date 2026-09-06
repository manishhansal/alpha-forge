# Feature Methodology — AlphaForge ML Service (fv5)

**Version:** fv5 (Phase 3D)
**Last updated:** 2026-09-06
**Scope:** Indian equity and F&O daily bars (NSE/BSE)

This document covers the economic reasoning, mathematical definitions, and design decisions behind the AlphaForge feature engine. It is the companion to `docs/ml-audit/phase-3d-feature-engine.md` (correctness and audit) and `reports/phase-3d-feature-quality.md` (statistics and evidence).

---

## 1. Feature Philosophy

AlphaForge features must each have a defensible answer to:

> Why should this feature contain predictive information at the prediction timestamp, given only data available at that timestamp?

This rules out:
- Features that require future price confirmation (BOS with centered pivot)
- Features whose values are fabricated when source data is absent (silent defaults)
- Features computed from today's F&O universe applied to historical dates (survivorship bias)
- Features normalised over the full dataset rather than a rolling causal window

The quality hierarchy is:

```
Correct Data
    ↓
Causal Features
    ↓
Economically Meaningful Features
    ↓
Cross-Sectional Information
    ↓
Robust Labels (Phase 3C)
    ↓
OOS Validation
```

Feature count is not a quality metric. 80 high-quality features outperform 500 weak or redundant ones.

---

## 2. Explicit Missingness

### 2.1 The fundamental rule

```
unknown ≠ neutral
unknown ≠ zero
unknown ≠ one
```

When source data is absent or insufficient, the feature engine returns:
- `value = None` (or `NaN`)
- `status = DATA_UNAVAILABLE` (or `INSUFFICIENT_HISTORY`)

The model preprocessing layer may later apply imputation, but must do so explicitly and with documentation. The feature engine never silently substitutes a plausible-looking number.

### 2.2 Why this matters

Consider a model trained with `vix_regime = 1.0` (moderate) wherever India VIX data was absent. The model sees `vix_regime = 1.0` on every training date without VIX data. It learns that `vix_regime = 1.0` co-occurs with whatever market behaviour existed on those dates — not that those dates had moderate VIX. The model's learned weight for `vix_regime` is corrupted.

By returning `NaN`, the row is excluded from training (via `valid_mask`) or imputed via a documented policy. Either way, the model never trains on fabricated market state.

### 2.3 AvailabilityStatus taxonomy

| Status | Meaning |
|--------|---------|
| `OK` | Value is valid and PIT-safe |
| `DATA_UNAVAILABLE` | Source data does not exist |
| `INSUFFICIENT_HISTORY` | Lookback window not yet filled |
| `PROVIDER_MISSING` | Data provider returned nothing |
| `STALE` | Source older than expected cadence |
| `PIT_UNVERIFIED` | Cannot confirm source_available_time ≤ feature_time |
| `PROXY` | Value is a best-available proxy, not the true measure |

---

## 3. Point-in-Time (PIT) Contract

Every feature must satisfy:

```
source_available_time ≤ feature_timestamp
```

This is enforced by:
1. `FeatureAvailabilityChecker.check()` — validates each computed value
2. PIT mutation tests — appending future data to OHLCV must not alter historical features
3. Feature family implementations — all use trailing rolling windows, never centered

### 3.1 What constitutes a PIT violation

- `rolling(window=N, center=True)` — future N/2 bars are used
- `.shift(-N)` in a feature (not label) path
- Cross-sectional normalisation using future universe members
- Sector features using a company's 2025 sector for 2020 data
- Market structure features using future-confirmed pivots

### 3.2 PIT mutation test procedure

```
1. Build OHLCV with N bars
2. Compute features on the full dataset
3. Append extreme future bars (close = 9999, volume = 1e12)
4. Recompute features on extended dataset
5. Assert: feature values at bars ≤ N are unchanged
```

This is verified for: `return_20d`, `rsi_14`, `realized_vol_20`, `relative_volume`, `trend_strength`, `bos_net`, `fvg_score` (price + volume mutations).

---

## 4. Feature Families

### 4.1 Momentum / Relative Strength

**Economic rationale:** Stocks that have been rising tend to continue rising (momentum anomaly). This is one of the most robust documented factors in academic finance, including in Indian markets.

Key features: `return_{1,2,3,5,10,20,60}d`, `relative_strength_vs_nifty`, `trend_strength`, `momentum_t_stat`, `return_consistency`

**Momentum quality**: Raw return alone does not distinguish a +15% gain from one explosive day versus 15 days of persistent 1% gains. `momentum_t_stat` captures statistical persistence; `return_consistency` (fraction of up-days) captures breadth of the move.

### 4.2 Trend

**Economic rationale:** Trend-following has a long history of profitability in equity markets. ADX measures trend strength; EMA stack measures alignment of multiple time horizons.

Key features: `ema_stack_score`, `adx_14`, `macd_histogram`, `supertrend`

### 4.3 Mean Reversion

**Economic rationale:** Short-term mean reversion coexists with medium-term momentum. RSI, Bollinger Bands, and Williams %R identify overextended moves likely to pull back.

Key features: `rsi_14`, `bollinger_position`, `cci`, `zscore_price`

### 4.4 Volatility

**Realised volatility estimators:**

| Estimator | Formula | Properties |
|-----------|---------|------------|
| Close-to-close | σ = std(log(close_t/close_{t-1})) × √252 | Simple; misses intraday range |
| Parkinson | σ² = (1/4ln2) × (ln H/L)² | 5× more efficient; ignores gaps |
| ATR (Wilder) | EWM of true range | Captures gaps; default for barrier sizing |

**Volatility regime** uses rolling percentile (not fixed thresholds) so the regime classification is self-calibrating as markets change. Fixed threshold classifiers (e.g. VIX < 13 = low) are economically motivated for India VIX specifically.

### 4.5 Volume / Liquidity

**VWAP semantics:** For daily bars, `compute_vwap_distance_pct` uses a rolling N-bar window. This is the correct approach because there is no single intraday session to anchor to. The old cumsum()-based implementation accumulated from bar 0 of the window, producing a 200-day average masquerading as "intraday VWAP" — that was corrected in Phase 3D.

**Amihud illiquidity:** `|return| / dollar_volume` averaged over 20 bars. This is a PROXY for true price impact (which requires bid/ask spread data). Labelled explicitly as PROXY in the registry.

### 4.6 Market Structure (BOS / CHOCH / FVG)

**Causality requirement:** Structure features are the most prone to future-data leakage because pivot confirmation naturally requires future bars.

**FVG:** Detected at bar i using bars [i-2, i-1, i] only. No future bars needed.

**Order blocks:** Detected at bar i as the last opposing candle before an impulse at bar i. All data is past.

**BOS/CHOCH:** Uses trailing swing levels:
```
swing_high[t] = max(high[t - 2*lookback .. t])   (trailing)
prev_swing_high[t] = swing_high[t - lookback]     (reference lookback bars ago)
```
No centered rolling window. The feature value at bar t cannot change if any bar > t is modified — verified by PIT mutation test.

### 4.7 Cross-Sectional Features

**Survivorship bias:** Cross-sectional ranking must use `historical_universe(t)`, never the current F&O universe. Adding a stock that was not eligible at t to the universe retroactively would change ranks at t.

**Timestamp-local normalisation:**
```python
rank(stock_return_20d, t) = percentile_rank within eligible_stocks(t)
```
This normalisation is computed per-timestamp. Rolling normalisation over time is time-series normalisation, not cross-sectional.

**Minimum universe size:** If fewer than `min_stocks=5` stocks are eligible at t, the cross-sectional rank returns `None` (not a meaningless single-stock percentile).

### 4.8 Derivatives / F&O

**India-specific differentiator:** Indian equity markets have one of the highest retail F&O participation rates globally. PCR, OI buildup, and IV rank carry information about institutional positioning that may not be fully reflected in price.

**OI buildup methodology (derivatives-v1):**
- Long buildup: price↑ + OI↑ → new long positions being added
- Short buildup: price↓ + OI↑ → new short positions
- Short covering: price↑ + OI↓ → shorts being closed
- Long unwinding: price↓ + OI↓ → longs being closed

Versioned as `derivatives-v1`. Changing this classification changes the version.

**IV Rank vs IV Percentile:**
- IV Rank: `(current - min) / (max - min)` — sensitive to extremes
- IV Percentile: `fraction of days with lower IV` — more robust

Both return `None` when `iv_history < min_history = 5`. Never substitute 50 (neutral) for missing history.

### 4.9 Expiry / Contract State

Indian options have weekly Thursday expiry (pre-Sep 2025) and monthly last-Thursday expiry. Theta decay accelerates near expiry. `weekly_theta_pressure = 1/max(days, 0.5)` captures this non-linearly.

Calendar must be historical — the India change to Tuesday expiry in Sep 2025 must not be applied to pre-Sep-2025 historical data.

---

## 5. Missing Data Policy Decision Table

| Feature | Absent data means | Correct return | Wrong return |
|---------|------------------|----------------|--------------|
| `relative_strength_vs_nifty` | NIFTY not in data feed | `NaN` | `1.0` (stock = index, which is not what absence means) |
| `vix_regime` | VIX provider down | `NaN` | `1.0` (moderate — fabricates a calm market signal) |
| `pcr_score` | Options OI unavailable | `NaN` | `0.0` (neutral PCR — fabricates OI parity) |
| `atm_iv` | Options chain absent | `NaN` | `0.0` (zero IV is physically impossible) |
| `delivery_pct` | NSE bhavcopy missing | `NaN` | `0.0` (0% delivery is a real market state) |
| `pct_above_sma20` | Universe absent | `NaN` | `50.0` (fabricates balanced breadth) |
| `iv_rank` | < 5 history bars | `None` | `50.0` (fabricates median rank) |

---

## 6. Feature Versioning Contract

| Change | Action required |
|--------|----------------|
| Formula change | New `feature_version` (e.g. `momentum-v2`) |
| Lookback change | New version |
| Source change | New version |
| Normalization change | New version |
| Missing-data semantics change | New version |
| Description/documentation only | Version unchanged |

The old version must be added to the registry as `DEPRECATED` with a `deprecation_note`. It must never be silently overwritten.

---

## 7. Feature Promotion States

| State | Meaning |
|-------|---------|
| `EXPERIMENTAL` | New; no review |
| `RESEARCH` | Reviewed; no OOS evidence yet |
| `VALIDATED` | OOS IC computed and stable (Phase 3E) |
| `PRODUCTION_CANDIDATE` | All gates passed; approved for training |
| `DEPRECATED` | No longer used; replacement documented |
| `BLOCKED` | Failed leakage or data test; cannot be trained on |

**Phase 3D start state:** All 109 active features are `RESEARCH`. Promotion to `VALIDATED` requires OOS IC evidence from Phase 3E. Promotion to `PRODUCTION_CANDIDATE` requires OOS stability, economic rationale, low leakage risk, and data reliability confirmation.

---

## 8. Design Decisions and Rejected Alternatives

| Decision | Chosen | Rejected | Reason |
|----------|--------|----------|--------|
| Missing data representation | `NaN` / `None` with `AvailabilityStatus` | Silent neutral substitution | Fabricated neutral values corrupt model weights silently |
| VWAP for daily bars | Rolling N-bar window | Cumulative from bar 0 | Cumulative VWAP over a multi-month window is not a session VWAP |
| BOS/CHOCH swing levels | Trailing rolling max/min | Centered rolling window | Centered window uses future bars — leakage |
| FVG detection | 3-bar vectorised formula | Requiring confirmation bars | Confirmation uses future data; formation is causal |
| ATR barrier sizing | vol-relative (% of close) | Fixed percentage | Fixed % is too wide for low-vol stocks, too narrow for high-vol F&O |
| IV rank insufficient history | Return `None` | Return 50 (neutral) | 50 is a real rank value; absent history must not be fabricated as neutral |
| Cross-sectional universe | `historical_universe(t)` via parameter | Global current universe | Global current universe introduces survivorship bias |
| Model feature vectors | `feats.get(f, float('nan'))` | `feats.get(f, 0.0)` | 0.0 is a real feature value for many features; NaN triggers the existing `valid_mask` filter |
| Amihud as proxy | Labelled PROXY explicitly | Called TRUE_LIQUIDITY | True liquidity requires bid/ask spread data; honest labelling prevents misuse |
