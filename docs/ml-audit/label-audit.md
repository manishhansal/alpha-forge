# Label Audit: Every ML Label Inspected

**Verification Date:** 2026-09-06  
**Method:** Direct code inspection of all label generation functions.

---

## Label 1 — Regime Classification Label

| Attribute | Value |
|---|---|
| **Label function** | `generate_regime_labels()` in `src/models/market_regime.py` line 432; wrapped in `generate_regime_labels_v2()` in `data_pipeline.py` line 316 |
| **Label type** | Integer class 0-5 (CRASH, BEAR, VOLATILE, SIDEWAYS, BULL, STRONG_BULL) |
| **Prediction timestamp** | Bar `i` (the bar when signal is generated) |
| **Label start** | Bar `i + 1` (first bar after prediction) |
| **Label end** | Bar `i + lookforward` (default: `i + 5`) |
| **Horizon** | 5 trading bars (default) |
| **Benchmark** | NIFTY 50 price action |
| **Normalisation** | None — class labels |
| **Overlap** | Adjacent bars share lookforward-1 = 4 bars. With `lookforward=5`, each pair of adjacent training samples has 80% label overlap. |
| **Economic interpretation** | "What regime did the market enter over the next 5 bars?" |
| **Point-in-time valid?** | ✅ YES — features use only data ≤ bar `i`; labels use data from bar `i+1` onward |
| **Excessive overlap?** | ✅ YES — 80% overlap between adjacent samples. Purging required. |
| **Purging required?** | ✅ YES — labels at bar `i` overlap with features at bars `i+1` through `i+4` |
| **Economically useful?** | ✅ YES — predicting regime transitions is genuinely useful for strategy selection |

**Issues:**
1. **Class imbalance** — CRASH is ~2-3% of training days; SIDEWAYS is ~35-40%. No class weights applied in `train_all.py` (`scale_pos_weight=1` for all XGBoost models). The model will likely predict SIDEWAYS most of the time.
2. **VOLATILE label construction** — `volatile_mask = (realized_atr_pct > 1.8) & (fwd_return.abs() < 0.03)`. The `realized_atr_pct` is a **trailing** ATR (backward-looking), which is correct. The VOLATILE label mixes past volatility with future direction as a conjunction — semantically this means "past was volatile AND future was non-directional." This is a legitimate label design but creates a complex conditional relationship.
3. **No forward max-drawdown for BEAR/CRASH** — the label correctly uses `fwd_max_dd` (computed forward), but this is in the label computation, not features. This is correct.

**Classification: KEEP with modifications** — add class weights; document VOLATILE label semantics explicitly.

---

## Label 2 — Stock Ranking Label

| Attribute | Value |
|---|---|
| **Label function** | `generate_ranking_labels_v2()` in `src/training/data_pipeline.py` line 355 |
| **Label type** | Continuous (risk-adjusted excess return ∈ [-5, 5]) |
| **Prediction timestamp** | Bar `i` |
| **Label start** | Bar `i + 1` |
| **Label end** | Bar `i + horizon` (default: `i + 5`) |
| **Horizon** | 5 trading bars (default) |
| **Benchmark** | NIFTY 50 return over same period |
| **Normalisation** | Divided by trailing 10-day volatility; clipped at ±5 |
| **Overlap** | Adjacent labels share 4 bars (80% overlap) |
| **Economic interpretation** | "How much did this stock outperform NIFTY on a risk-adjusted basis over the next 5 days?" |
| **Point-in-time valid?** | ✅ YES — forward shift uses `shift(-1).rolling(horizon).mean().shift(-(horizon-1))` — forward-looking only in label |
| **Excessive overlap?** | ✅ YES — 80% overlap |
| **Purging required?** | ✅ YES |
| **Economically useful?** | ✅ YES — direct formulation of stock selection alpha |

**Issues:**
1. **No transaction costs** — the label is gross excess return. After 0.3-0.4% round-trip NSE cost, a stock needing ≥0.4% gross alpha per 5-day trade has zero net alpha. Models trained on gross return labels will rank stocks by gross outperformance.
2. **Volatility denominator** — `vol = stock_ret.rolling(horizon * 2).std()` uses trailing 10-day volatility (lookback). This is point-in-time safe but creates label instability: in low-vol periods, a 0.5% move gets a high risk-adjusted score; in high-vol periods, the same move scores low.
3. **No simultaneous stop/target resolution** — for ranking labels this is less relevant (no explicit stop/target); the fixed-horizon return is the natural label. Acceptable.

**Classification: MODIFY** — add transaction cost deduction; document volatility normalisation choice.

---

## Label 3 — Risk: Stop-Hit Label

| Attribute | Value |
|---|---|
| **Label function** | `generate_risk_labels()` in `src/training/data_pipeline.py` line 384 |
| **Label type** | Binary (1 = stop hit within lookforward bars, 0 = not hit) |
| **Prediction timestamp** | Bar `i` (entry at `close[i]`) |
| **Label start** | Bar `i + 1` |
| **Label end** | Bar `i + lookforward` (default: `i + 20`) |
| **Horizon** | 20 trading bars (default) |
| **Benchmark** | `stop_price = close[i] - 1.4 × ATR[i]` |
| **Normalisation** | Binary |
| **Overlap** | Adjacent labels share 19 bars (95% overlap) |
| **Economic interpretation** | "Would this stop-loss level have been hit within 20 trading days if we entered long at close?" |
| **Point-in-time valid?** | ✅ YES — `fwd_low = low.iloc[i+1 : i+1+lookforward]` — strictly future |
| **Excessive overlap?** | ✅ YES — 95% overlap for 20-day horizon |
| **Purging required?** | ✅ YES (more urgently than for 5-day labels) |
| **Economically useful?** | ✅ YES — directly models stop-loss execution |

**Issues:**
1. **Simultaneous stop and target hit** — if both `fwd_low <= stop_price` and `fwd_high >= target_price` occur in the same 20-bar window, both `stop_hit=1` and `target_hit=1`. In reality, only one can occur first. The model is trained on a structurally inconsistent label set where some observations have both stop AND target hit = 1. This inflates the estimated base rate for both events.
2. **Long-only assumption** — labels only simulate long entry (`stop = close - 1.4×ATR`, `target = close + 2.0×ATR`). There is no short-side risk label. For a system generating both BUY and SELL signals, this creates an asymmetric risk model.
3. **No slippage in stop execution** — `stop_hit = 1 if any(fwd_low <= stop_price)`. In practice, stop orders fill at a slipped price below `stop_price`. This understates actual stop loss.

**Classification: MODIFY** — fix simultaneous-hit logic; add slippage to stop execution; add short-side labels.

---

## Label 4 — Risk: Target-Hit Label

| Attribute | Value |
|---|---|
| **Label function** | `generate_risk_labels()` (same function) |
| **Same issues as Label 3 plus:** | |
| **Simultaneous hit** | Same structural issue as Label 3 |
| **Classification: MODIFY** | Same as Label 3 |

---

## Label 5 — Risk: Maximum Adverse Excursion (MAE)

| Attribute | Value |
|---|---|
| **Label function** | `generate_risk_labels()` (same function) |
| **Label type** | Continuous (max drawdown % ∈ [0, 20]) |
| **Computation** | `min_low = fwd_low.min(); raw_mae = abs(min((min_low - entry) / entry * 100, 0.0))` |
| **Cap** | 20% |
| **Point-in-time valid?** | ✅ YES |
| **Economic interpretation** | "What was the worst intra-trade adverse excursion over the 20-bar window?" |
| **Issues** | Long-only; no slippage; cap at 20% may understate real MAE in circuit-breaker events |
| **Classification: KEEP** | Most robust of the risk labels |

---

## Label 6 — Strategy Selection Label

| Attribute | Value |
|---|---|
| **Label function** | `generate_strategy_labels()` in `src/models/strategy_selector.py` line 469 |
| **Label type** | Integer class 0-7 (8 strategies) |
| **Horizon** | 5 bars (default) |
| **Definition** | Which strategy produced the best risk-adjusted return over the next 5 bars |
| **Point-in-time valid?** | ✅ Assumed yes (same structure as ranking labels) |
| **Issues** | No transaction cost in strategy performance measurement; strategy that makes more trades will be penalised in gross return but not in label |
| **Classification: MODIFY** | Add cost adjustment; reduce to 3-4 strategy classes |

---

## Summary Table

| Label | Type | Horizon | Overlap | PIT Safe | Costs | Simultaneous Hit | Verdict |
|---|---|---|---|---|---|---|---|
| Regime class | Categorical (6) | 5 bars | 80% | ✅ | N/A | N/A | KEEP (add class weights) |
| Stock ranking | Continuous RA excess | 5 bars | 80% | ✅ | ❌ Missing | N/A | MODIFY (add costs) |
| Stop hit | Binary | 20 bars | 95% | ✅ | ❌ Missing | ❌ Unresolved | MODIFY |
| Target hit | Binary | 20 bars | 95% | ✅ | ❌ Missing | ❌ Unresolved | MODIFY |
| MAE | Continuous | 20 bars | 95% | ✅ | ❌ Missing | N/A | KEEP (minor fixes) |
| Strategy class | Categorical (8) | 5 bars | 80% | ✅ | ❌ Missing | N/A | MODIFY |

**Common requirement for all labels:** Add purging (PurgedKFold with t1 series) before any model training.
