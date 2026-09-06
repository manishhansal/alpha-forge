# AlphaForge ML — Financial ML Methodology

**Date:** 2026-09-06  
**Scope:** Core principles from the 7 authoritative texts, applied specifically to AlphaForge's architecture and the Indian F&O market context.

> Content paraphrased and synthesised from published works for compliance with licensing restrictions. Citations provided for each framework section.

---

## 1. López de Prado — Advances in Financial Machine Learning (2018)

*Reference: López de Prado, M. (2018). Advances in Financial Machine Learning. Wiley.*

### 1.1 Core Thesis

Standard ML practices (random CV, accuracy metrics, simple labels) are insufficient and actively harmful when applied to financial time-series. Financial ML requires a distinct methodology at every step: data structures, labeling, sample weighting, validation, and performance evaluation.

### 1.2 Financial Data Structures

Raw tick data should be transformed into "information-driven" bars before feature engineering:
- **Time bars:** Standard OHLCV at fixed intervals — statistically poor (serially correlated returns, heteroskedastic volume)
- **Tick bars:** Fixed number of trades per bar — more stationary
- **Volume bars:** Fixed volume per bar — addresses volume clustering
- **Dollar bars:** Fixed dollar value per bar — most stationary across price regimes

**AlphaForge current state:** Uses time bars (daily OHLCV from Angel One/Upstox) — the simplest and most common bar type. For intraday signals (scalper, best-time features), 5-minute time bars are used. No information-driven bars are implemented.

**Application to AlphaForge:** For high-frequency F&O signals, dollar bars would provide more stationary series than time bars. For daily models, time bars are acceptable given liquidity of NSE F&O. Recommended: implement tick/volume bars for any intraday signal development.

### 1.3 Triple-Barrier Labeling

The fixed-horizon return label (`forward_return_5d > 0 → BUY`) has two defects:
1. It ignores the stop-loss that would have ended the trade before the horizon
2. It treats all observations as equal regardless of their realized profit/loss path

The triple-barrier method defines three barriers:
- **Upper barrier (profit-taking):** Entry + h₁ × σ
- **Lower barrier (stop-loss):** Entry − h₂ × σ
- **Vertical barrier (time limit):** After T bars

The label is determined by which barrier is hit first: +1 (profit), -1 (stop), 0 (expired). This mirrors actual trading mechanics and produces more informative labels.

**AlphaForge current state:** Uses fixed-horizon stop/target simulation:
```python
stop_price   = entry - 1.4 × ATR
target_price = entry + 2.0 × ATR
stop_hit[i]  = 1 if any(fwd_low <= stop_price)
```
This is close to the triple-barrier idea but with two defects: (1) simultaneous stop+target not resolved to the first-hit barrier, and (2) no vertical barrier — the stop/target outcome is checked over the full 20-bar window rather than stopping at the first hit.

**Recommendation:** Implement proper triple-barrier labeling with sequential bar-by-bar scanning to determine which barrier hits first.

### 1.4 Meta-Labeling

Meta-labeling decouples:
- **Side prediction:** Primary model predicts direction (+1 long, -1 short)
- **Size prediction:** Secondary meta-label model predicts whether to act on the primary signal (1 = trade, 0 = abstain) and by how much

This architecture has two advantages:
1. The primary model can be simple (even a rule-based strategy)
2. The meta-label model learns to filter false positives from the primary signal
3. Position sizing becomes a learned function of signal quality, not a rule

**AlphaForge current state:** The `MetaDecisionEngine` performs a conceptually similar function — it combines 7 base models and can output NO_TRADE. However, it is not architecturally a meta-labeling system. The ensemble produces a weighted direction score; there is no separate binary "should I act?" classifier trained on OOS primary model outcomes.

**Recommendation:** Implement a true meta-labeling layer: train the primary direction model (e.g., regime + ranker), collect OOS predictions, train a secondary XGBoost binary classifier on (primary signal, market context features) → (did trade succeed?), use the secondary classifier's probability as the position size multiplier.

### 1.5 Sample Weights for Overlapping Labels

When forward returns overlap (label at t uses returns from t+1..t+5, label at t+1 uses t+2..t+6), adjacent observations are not independent. Training without adjustment treats them as independent, inflating effective sample size and underestimating validation variance.

The uniqueness weight for observation i is:
```
w_i = 1 / mean(c_t for t in label_range[i])
```
where c_t is the number of active labels at time t. Observations in low-overlap periods get higher weight; overlapping observations get lower weight.

**AlphaForge current state:** No sample weights. Training uses equal-weight observations across all time steps.

**Recommendation:** Implement `compute_sample_weights(t0_series, t1_series)` from the MlFinLab approach. Apply weights in `model.fit(X, y, sample_weight=weights)`.

### 1.6 Fractional Differentiation

Standard differencing (`pct_change()`) achieves stationarity but destroys long-range memory. A price series `d=1` is stationary but has no price-level information. A fractionally differentiated series with `d=0.4` achieves approximate stationarity while preserving most of the memory.

**Formula:** `X[d] = Σ_{k=0}^{∞} w_k(d) × X[t-k]` where `w_k(d) = -w_{k-1}(d) × (d-k+1)/k`

**Application to AlphaForge:** The multi-period returns (`return_1d`, `return_5d`, `return_20d`) are fully differenced (d=1). For longer-horizon trend features, fractional differentiation (`d ≈ 0.3-0.5`) would preserve more predictive information while maintaining stationarity.

### 1.7 Combinatorial Purged Cross-Validation (CPCV)

CPCV generates C(N,k) test paths across k groups held out simultaneously, providing a distribution of backtest performance rather than a single walk-forward path. The key insight: a single walk-forward path is ONE realization of the backtest; CPCV maps out the distribution of possible paths and identifies whether the strategy is genuinely robust or path-dependent.

**AlphaForge current state:** `CPCVSplitter` exists and is tested but never used in training. The `WalkForwardValidator` is also unused.

### 1.8 Deflated Sharpe Ratio

When multiple strategy configurations are tested, the probability that the best-observed Sharpe exceeds the true Sharpe inflates with the number of tests. The Deflated Sharpe Ratio (DSR) accounts for this:
```
DSR = SR × (1 - γ_1 × SR + γ_2 × SR²) / √(T/252)
```
where γ₁, γ₂ are correction terms for the number of trials.

**AlphaForge gap:** No DSR computation anywhere. When Optuna tests 30 hyperparameter configurations, the reported val_accuracy is inflated by approximately sqrt(log(30)) × σ. All Optuna-optimized results must be DSR-corrected before claiming statistical significance.

---

## 2. López de Prado — Machine Learning for Asset Managers (2020)

*Reference: López de Prado, M. (2020). Machine Learning for Asset Managers. Cambridge University Press.*

### 2.1 Optimal Number of Clusters

Before running any ML model, understanding the covariance structure of the feature set is essential. Cluster features with similar information content; use one representative from each cluster rather than all correlated features.

**Application to AlphaForge:** With 65+ ranking features, many are highly correlated (RSI, Stochastic RSI, Williams %R, CCI all measure similar overbought/oversold conditions). Applying clustering (hierarchical clustering on the feature correlation matrix) would reduce effective feature count from 65 to perhaps 25-30 independent signals.

### 2.2 Feature Importance via Substitution

Mean Decrease Impurity (MDI, the default LightGBM feature importance) is biased toward high-cardinality features. Mean Decrease Accuracy (MDA) via permutation is less biased but unstable. The recommended approach is Shapley-value-based (SHAP) importance.

**AlphaForge gap:** `shap_explainer.py` exists but is only called on-demand. SHAP should be computed for every training run and stored with the experiment record.

---

## 3. Ernest Chan — Quantitative Trading (2009) and Algorithmic Trading (2013)

*References: Chan, E. (2009). Quantitative Trading. Wiley. Chan, E. (2013). Algorithmic Trading. Wiley.*

### 3.1 Strategy Research Discipline

Chan emphasises that most seemingly profitable strategies are the result of backtest overfitting, not genuine alpha. His framework for honest research:
- Use the minimum number of parameters (prefer 1-parameter models over 5-parameter models)
- Test on out-of-sample data that was never touched during development
- Compute the Sharpe ratio from the OOS period only, never from the in-sample period
- If OOS Sharpe < 0.5 (annualised), the strategy is unlikely to be profitable after costs

**Application to AlphaForge:** The heuristic scoring functions in `StockRanker._compute_heuristic_score()` have ~20 manually-tuned constants. Each constant is an implicit free parameter. With 20 free parameters and no OOS testing, the heuristic is almost certainly overfit to the developer's intuitions.

### 3.2 Mean-Reversion vs Trend-Following

Chan distinguishes between two fundamental market regimes that require different strategies:
- **Mean reversion** (stationary processes): Cointegrated pairs, Bollinger-band strategies, Ornstein-Uhlenbeck mean-reversion
- **Trend-following** (non-stationary processes): Momentum, breakout, cross-sectional momentum

The Augmented Dickey-Fuller (ADF) test determines which regime applies to a given instrument/pair. A strategy should only be applied in the appropriate regime.

**Application to AlphaForge:** The `MarketRegimeClassifier` classifies regimes but the mapping from regime to strategy family is done via a hand-coded rule table in `StrategySelector`. Chan's approach suggests testing for stationarity of the specific traded spread before selecting strategy type.

### 3.3 Transaction Costs as Alpha Decay

Chan's empirical finding: transaction costs (including market impact) typically consume 30-50% of gross alpha for daily-bar strategies. For higher-frequency strategies, costs can consume 100%+ of gross alpha.

**Application to AlphaForge:** All AlphaForge labels are gross return. Chan's work strongly supports adding realistic NSE F&O costs (STT + brokerage + exchange + slippage) to all label generation.

---

## 4. Robert Carver — Systematic Trading (2015)

*Reference: Carver, R. (2015). Systematic Trading. Harriman House.*

### 4.1 Volatility Targeting

Position sizes should be scaled to a target annualised portfolio volatility rather than to a fixed notional. This creates consistent risk exposure across instruments and regimes:

```
Position = (Target_vol / Instrument_vol) × (Capital / Price)
Target_vol = 0.25  # 25% annualised (typical for an active retail trader)
```

**Application to AlphaForge:** The `RiskPredictor` position sizing uses Kelly criterion. Carver's volatility targeting is simpler, more robust, and less sensitive to probability estimates:
```
position_size = (portfolio_capital × target_vol_pct) / (price × instrument_vol_pct × √252)
```

### 4.2 Forecast Diversification Multiplier (FDM)

When combining multiple forecasting rules, the combined signal should be scaled by a diversification multiplier to maintain target volatility. If signals are correlated, the combined signal has lower variance than the sum of components, so the position must be scaled up:

```
FDM = target_vol / stdev(weighted_combined_signal)
```

**Application to AlphaForge:** The `EnsembleWeighter` produces a weighted score in [-1, 1] but does not adjust for the variance of the combined signal. In strong-consensus regimes (all models agree), the variance is lower than in mixed regimes, but position size is not adjusted accordingly.

### 4.3 Speed of Trading and Cost Efficiency

Carver defines "speed" as the turnover rate of the strategy. Faster strategies require higher IC per trade to overcome transaction costs. The cost-efficiency relationship:

```
Minimum required IC = transaction_cost / signal_volatility
```

For daily NSE F&O strategies with ~0.3% round-trip cost, the minimum required IC per trade is approximately 0.02-0.04 (depending on holding period). Strategies with lower IC should use longer holding periods.

**Application to AlphaForge:** No holding period analysis is performed. The system generates BUY/SELL signals without specifying intended holding period. The heuristic scoring functions do not account for the cost-efficiency relationship.

### 4.4 Instrument Selection

Carver's framework for instrument selection:
1. Minimum liquidity threshold (e.g., average daily dollar volume > threshold)
2. Cost efficiency: `risk-adjusted return after costs / instrument volatility`
3. Correlation with existing instruments in the portfolio (prefer low correlation)

**Application to AlphaForge:** `TRAINING_UNIVERSE` includes all 50 F&O stocks without a formal liquidity or cost-efficiency screen. Stocks like some mid-caps in the list may have insufficient liquidity for meaningful alpha after costs.

---

## 5. Grinold & Kahn — Active Portfolio Management (2000)

*Reference: Grinold, R. & Kahn, R. (2000). Active Portfolio Management. McGraw-Hill.*

### 5.1 Fundamental Law of Active Management

The central result of Grinold-Kahn:

```
IR = IC × √BR × TC
```

Where:
- **IR** = Information Ratio (annualised active return / active risk)
- **IC** = Information Coefficient (correlation of forecast with realized return)
- **BR** = Breadth (number of independent forecast decisions per year)
- **TC** = Transfer Coefficient (correlation of optimal positions with actual positions; ≤ 1)

**Implications for AlphaForge:**

1. **IC is the foundational metric.** Before building any ensemble, measure the raw IC of each individual signal (Spearman rank correlation between signal and forward return, computed OOS). If IC < 0.02 on OOS data, the signal has no statistically measurable edge.

2. **Breadth amplifies IC.** A strategy with IC=0.05 applied to 50 stocks daily has BR = 50×252 = 12,600 decisions/year. IR = 0.05 × √12,600 ≈ 5.6. The same IC applied to 5 stocks gives IR ≈ 1.8. This motivates expanding the F&O universe.

3. **Transfer coefficient penalises constraints.** The TC for a long-only strategy is approximately 0.7 (vs 1.0 for unconstrained). NSE lot-size constraints, margin requirements, and sector limits all reduce TC. The actual IR is TC × IC × √BR.

4. **The law is a ceiling.** Actual IR < IC × √BR × TC always. The law shows the maximum possible IR given these components.

**AlphaForge gap:** No IC measurement anywhere. Models are trained to minimise prediction error (RMSE/cross-entropy) but the actual OOS IC of each signal is never computed or reported. IC should be the primary evaluation metric for any individual signal before ensemble combination.

### 5.2 Alpha vs Risk Models

Grinold-Kahn distinguish:
- **Alpha model:** Forecast of future excess return (signal direction and magnitude)
- **Risk model:** Forecast of future covariance structure (used for portfolio construction only, never for signal generation)

The key insight: mixing alpha and risk information inflates apparent predictive power. Features that primarily encode risk (high-VIX → high volatility) should not be used in the alpha model — they belong in the risk model.

**Application to AlphaForge:** `RANKING_FEATURES` includes `vix_regime`, `atr_pct`, `bollinger_position` — features that encode current volatility level. These are risk features, not alpha features. Using them in the ranker mixes signal and risk, potentially creating a model that predicts volatility rather than direction.

---

## 6. Antti Ilmanen — Expected Returns (2011)

*Reference: Ilmanen, A. (2011). Expected Returns: An Investor's Guide to Harvesting Market Rewards. Wiley.*

### 6.1 Return Premia Are Compensation for Risk

Ilmanen's central framework: persistent return premia exist because they represent compensation for bearing systematic risk that other investors wish to avoid. The four most robust premia across asset classes and geographies:

1. **Value:** Cheap assets (low P/B, P/E) outperform expensive assets over long horizons
2. **Momentum:** Recent winners continue to outperform over 1-12 months
3. **Carry:** Higher-yield assets outperform lower-yield assets (applicable to options via IV carry)
4. **Quality:** High-quality companies (high ROE, stable earnings) outperform

**Application to AlphaForge:** The current feature set focuses primarily on technical momentum (RSI, MACD, trend strength, breakout) and derivatives flow (OI, PCR, IV rank). The quality and value dimensions are entirely absent:
- No fundamental quality features (ROE, earnings stability, debt levels)
- No valuation features (P/E, P/B relative to sector)
- No carry features (IV carry = implied vol - historical vol, a genuine F&O-specific premium)

### 6.2 Volatility Risk Premium

One of the most robust quantitative premia: implied volatility consistently exceeds subsequent realized volatility (the "volatility risk premium"). Option sellers are consistently compensated for taking on the risk of large moves.

**Application to AlphaForge:** The feature `iv_rank` captures where current IV sits in its historical range, but does not compute the IV-HV spread (implied - historical) which is the actual carry premium. For India VIX: VIX - 30-day_HV is a genuine, empirically robust signal that should be added to the feature set.

### 6.3 Factor Timing is Difficult

Ilmanen's key caution: individual factor performance varies enormously across cycles. Momentum performs well in trending markets, poorly in choppy markets. Value is cyclical. Attempting to time factor exposures (overweight momentum in bull, overweight value in bear) adds noise more than signal.

**Application to AlphaForge:** The regime-conditioned `REGIME_FACTOR_WEIGHTS` in `StockRanker` attempt exactly this kind of factor timing — boosting momentum weights in bull regimes, mean-reversion weights in sideways. Ilmanen's finding suggests this is unlikely to improve OOS performance and may hurt it. The regime-specific weights should be treated as a hypothesis to validate OOS, not a default.

### 6.4 Diversification Across Return Sources

Ilmanen emphasises that the most reliable alpha comes from harvesting multiple independent return premia simultaneously. A strategy that depends on a single premium (pure momentum, pure value) has higher variance than one diversified across premia.

**Application to AlphaForge:** The current feature set is heavily weighted toward technical momentum and F&O flow. Adding independent return sources (quality/value factors, IV carry) would improve signal diversification at the cost of requiring fundamental data sourcing.

---

## 7. Consolidated Methodological Principles for AlphaForge

### Priority 1 — Correct Before Building

| Principle | Source | Current Status | Action |
|---|---|---|---|
| Triple-barrier labeling | AFML | Fixed-horizon only | Implement TBL |
| Sample weights for overlapping labels | AFML | Equal weights | Implement uniqueness weights |
| PurgedKFold in training | AFML | Exists, unused | Wire to train_all.py |
| Transaction costs in labels | Chan | Not implemented | Add NSE cost model |
| IC measurement per signal | Grinold-Kahn | Not implemented | Add IC tracking to recorder |

### Priority 2 — Add Before Claiming Alpha

| Principle | Source | Current Status | Action |
|---|---|---|---|
| Deflated Sharpe Ratio | AFML | Not implemented | Add DSR to ModelAcceptanceGate |
| OOS IC minimum threshold | Grinold-Kahn | Not implemented | IC > 0.02 gate before ensemble |
| Volatility targeting for position sizing | Carver | Kelly-based | Add vol-target as alternative |
| CPCV for path robustness | AFML | Exists, unused | Use for model selection |
| Meta-labeling layer | AFML | Conceptually similar, not structural | Implement true meta-label model |

### Priority 3 — Expand Signal Universe

| Principle | Source | Current Status | Action |
|---|---|---|---|
| IV carry (VIX - HV spread) | Ilmanen | Not implemented | Add to REGIME_FEATURES |
| Quality factors | Ilmanen | Not implemented | Add ROE, earnings stability |
| Fractional differentiation | AFML | Full differencing only | Implement d=0.3-0.5 for trend features |
| Volatility forecasting as alpha | Ilmanen | Not implemented | Add realized vs implied spread |
| Feature clustering to reduce redundancy | ML for Asset Managers | Not implemented | Cluster 65+ features, remove duplicates |
