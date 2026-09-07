# AlphaForge ML — Model Selection Methodology

**Date:** 2026-09-06  
**Scope:** Principled algorithm selection, hyperparameter methodology, and OOS evidence standards for the AlphaForge ml-service.

---

## 1. The Model Selection Problem in Finance

Model selection in financial ML is fundamentally different from standard ML:
- **Labels are noisy:** The signal-to-noise ratio in financial returns is typically 0.02-0.10 IC — compared to 0.90+ accuracy in computer vision
- **Non-stationarity:** The generating process changes over time; a model optimal for 2020 may be suboptimal in 2024
- **Small effective sample size:** After purging and embargo, a 5-year daily dataset may have fewer than 300 truly independent observations
- **Multiple comparisons inflation:** Every model configuration tested inflates the probability of a false discovery
- **Cost of overfitting:** An overfit model deployed in live trading loses real capital; the cost is asymmetric

### The Evidence Hierarchy

Ordered from least to most reliable:

```
1. In-sample performance (unreliable — always overstates)
2. Single walk-forward OOS fold (one realization)
3. Multi-fold walk-forward OOS (better, still path-dependent)
4. CPCV distribution of OOS Sharpe (best for robustness)
5. Paper trading (real-time, no look-ahead possible)
6. Live trading with risk controls (ground truth)
```

No model should be promoted to live trading without evidence from at least level 3.

---

## 2. Algorithm Selection by Task

### 2.1 Market Regime Classification (6 classes)

**Current:** XGBoost `multi:softprob`

**Assessment:** XGBoost is a reasonable choice for this task. Gradient boosting handles non-linear threshold interactions (e.g., low VIX AND positive breadth → bull) naturally. The 6-class structure is manageable.

**Why NOT alternatives:**
- **Logistic regression:** Too linear for regime interactions
- **Random forest:** Marginally worse than GBM on tabular data; slower inference
- **Neural networks:** Requires much more data; poor performance with <5,000 samples
- **LightGBM:** Marginally better speed, similar accuracy; acceptable alternative

**Best practice from Qlib:** Use LightGBM for all tabular financial ML — faster than XGBoost with comparable accuracy on financial data, native handling of categorical features (regime encoding), built-in early stopping.

**Hyperparameter priority for regime classifier:**
1. `max_depth` (3-6): Controls overfitting; regime classification benefits from shallow trees
2. `min_child_samples` (20-50): Financial data has class imbalance; higher value = more conservative
3. `learning_rate` (0.01-0.05): Lower is better; use early stopping to find optimal n_estimators

### 2.2 Stock Ranking (continuous excess return)

**Current:** LightGBM regression / LambdaRank

**Assessment:** LightGBM LambdaRank is theoretically optimal for ranking tasks. It directly optimises NDCG (how well the top-k ranked stocks correspond to actual top-k performers). The regression fallback is weaker but practical when group information (stocks per day) is unavailable.

**Key consideration:** For Indian F&O universe (~50 stocks), the per-day group size is ~50. LambdaRank requires `n_query_groups × group_size >> n_estimators` for reliable training. With 5-year history, ~1,250 days × 50 stocks = 62,500 observations — sufficient for LambdaRank.

**Alternative worth testing:**
- **CatBoost YetiRank:** CatBoost's ranking objective optimises a query-level NDCG directly; comparable performance to LightGBM LambdaRank with less hyperparameter sensitivity
- **Gradient Boosted Trees with IC as objective:** Instead of RMSE on forward return, optimise Spearman rank correlation between predictions and realised returns (custom objective)

**Primary evaluation metric:** OOS Spearman IC (rank correlation between predicted and actual forward relative return), measured monthly. Target: IC > 0.03 consistently across 3+ years of OOS data.

### 2.3 Strategy Selection (8-class classification)

**Current:** CatBoost multiclass

**Assessment:** 8 classes on 17 features is a small problem. CatBoost is strong for categorical-heavy data, but all 17 `STRATEGY_FEATURES` are continuous — the CatBoost-specific categorical advantage is unused.

**Recommendation:**
- Reduce to 3-4 strategy classes (momentum-trend, mean-reversion-range, breakout, defensive/wait). The 8-class granularity is unlikely to provide enough training examples per class for reliable classification.
- Alternatively, model strategy selection as a function of regime (rule-based) and use ML only for within-regime parameter selection.
- If ML is retained, LightGBM is more appropriate than CatBoost for fully continuous features.

### 2.4 Risk Prediction (stop-hit, target-hit, drawdown)

**Current:** XGBoost × 3

**Assessment:** Binary classification for stop/target hit probabilities is appropriate. Three separate models (stop-hit, target-hit, drawdown) is the right decomposition — they have different base rates and different feature importances.

**Key risk:** Stop-hit and target-hit are **simultaneously constrained** (they can't both be 100% over the same window). Training them independently without a shared representation may produce inconsistent probability estimates that sum to > 1.

**Alternative:** Train a single multi-output model or use an ordinal regression framework:
- Output 1: P(stop hit before target) ∈ [0,1]
- Output 2: P(target hit before stop) = 1 - P(stop hit before target)  [if simultaneous case is rare]
- Output 3: Expected drawdown

**Better risk model architecture:** Use the triple-barrier method as the label generation framework — the label is which barrier was hit first (stop, target, or time), making this a 3-class classification rather than two independent binaries. This resolves the simultaneous-hit inconsistency structurally.

### 2.5 Price Forecasting

**Current:** Heuristic / commented-out (darts/tsai planned)

**From research:**
- **LSTM / GRU:** Strong for long-range dependencies but require large datasets; tend to overfit on small financial datasets
- **Transformer (Temporal Fusion Transformer):** Handles multiple time scales and exogenous variables; strong performance on multi-variate financial forecasting in academic studies. Qlib's TFT implementation is a reference.
- **N-BEATS / N-HiTS:** Pure neural forecasters without recurrence; strong on univariate series; fast training
- **LightGBM on lagged features:** Often matches neural approaches on short-horizon forecasting tasks; much simpler to validate

**Recommendation:** For AlphaForge's Indian equity context, a LightGBM model on lagged return + VIX + OI features is more likely to succeed than an LSTM/Transformer because:
1. Available training data (5 years daily = ~1,250 obs) is insufficient for deep learning
2. Tree models are more interpretable and easier to validate
3. The signal-to-noise ratio in daily equity returns is too low for sequence models to find exploitable patterns

---

## 3. Hyperparameter Optimisation Methodology

### 3.1 The Current Problem

`train_all.py::_hpo_xgboost()` uses Optuna with 30 trials, optimising `accuracy_score(y_val, ...)` on the same validation set used for final evaluation. This constitutes data snooping — the reported val_accuracy is the maximum over 30 trials on the same data, not a true OOS estimate.

### 3.2 Correct Procedure: Nested Cross-Validation

The gold standard for unbiased model evaluation with HPO:

```
Outer loop (walk-forward folds — generates OOS performance):
  For each fold [train_outer, val_outer, test_outer]:
  
    Inner loop (HPO on train_outer/val_outer only):
      For each trial t in Optuna:
        Split train_outer into [train_inner, val_inner]
        Fit model on train_inner with hyperparams_t
        Score on val_inner
      Best hyperparams → best_t
    
    Fit final model on train_outer with best_t
    Evaluate on test_outer → OOS score
    
Aggregate OOS scores across all outer folds → unbiased estimate
```

The outer test fold is **never** used during HPO. The final reported OOS score comes only from the outer test folds.

### 3.3 Practical HPO Settings for Indian F&O

Given the small effective sample size (~1,000-2,000 OOS observations after purging):

| Model | n_trials | Search space | Metric |
|---|---|---|---|
| Regime (XGBoost) | 20-30 | max_depth [3,6], lr [0.01,0.10], min_child [10,50], subsample [0.6,1.0] | val_logloss on inner CV |
| Ranker (LightGBM) | 20-30 | num_leaves [31,127], lr [0.01,0.10], min_child_samples [10,50] | val_IC (Spearman) on inner CV |
| Risk (XGBoost) | 15-20 | max_depth [3,6], lr [0.01,0.10], min_child [15,50] | val_AUC on inner CV |

**Important:** For regime classification with rare CRASH events, use `class_weight='balanced'` or `scale_pos_weight` inversely proportional to class frequency. Optimising accuracy on imbalanced classes will produce a model that never predicts CRASH.

### 3.4 Bayesian vs Grid vs Random Search

- **Grid search:** Exhaustive, computationally expensive, finds global optimum in the grid. Not suitable for >3 parameters.
- **Random search:** Often finds near-optimal solutions in 20-50 trials. Good baseline.
- **Bayesian (Optuna TPE):** Most sample-efficient for continuous hyperparameter spaces. Recommended when n_trials < 100.

**AlphaForge current approach:** Optuna TPE — correct tool. The problem is the validation protocol, not the search method.

### 3.5 Hyperparameter Stability Testing

Before deploying a model, test hyperparameter sensitivity:
- Vary each hyperparameter ±20% from optimal
- If OOS performance degrades sharply, the model is brittle
- Prefer a slightly suboptimal but robust configuration over the theoretical optimum

This is the financial equivalent of VectorBT's parameter sensitivity sweep. A model whose performance is sensitive to exact hyperparameter values has overfit to the validation set even with Bayesian search.

---

## 4. OOS Evidence Standards

### 4.1 Minimum Requirements for Research-Grade Evidence

Before claiming a signal has predictive power:

| Metric | Minimum threshold | Preferred threshold |
|---|---|---|
| OOS Spearman IC (ranking) | > 0.02 | > 0.04 |
| OOS Directional accuracy | > 52% | > 55% |
| OOS Information Ratio (IR) | > 0.5 | > 1.0 |
| OOS Sharpe (net of costs) | > 0.0 | > 0.5 |
| Statistical significance | p < 0.05 | p < 0.01 |
| OOS period | ≥ 252 trading days | ≥ 504 trading days |
| Number of independent OOS observations | ≥ 100 | ≥ 300 |
| CPCV paths with positive IR | > 50% | > 75% |
| DSR (Deflated Sharpe Ratio) | > 0.0 | > 0.5 |

### 4.2 The IC Decomposition

For the stock ranker, decompose IC into components:
```
IC_total = IC_factor × TC × (1 - decay)
```
- **IC_factor:** Raw predictive power of the factor before portfolio construction
- **TC (transfer coefficient):** How much of the raw IC survives after portfolio constraints
- **Decay:** How quickly IC decays with holding period

Measure IC at multiple forward horizons (1-day, 5-day, 20-day). A genuine alpha factor should show decaying but positive IC at all horizons. A factor that shows positive IC at 1-day but negative IC at 5-day is likely driven by microstructure (bid-ask bounce, momentum reversal) rather than fundamental information.

### 4.3 Statistical Testing

For a single walk-forward OOS test with N independent observations:
```
SE(IC) = √(1 - IC²) / √N
t-statistic = IC / SE(IC)
```

With N=252 independent observations and IC=0.03:
```
SE = √(1 - 0.0009) / √252 ≈ 0.063
t = 0.03 / 0.063 ≈ 0.48  →  p ≈ 0.63  →  NOT SIGNIFICANT
```

This means: to achieve p < 0.05 with IC=0.03, you need approximately N > 1,700 independent observations (roughly 7 years of daily data). This is why the AlphaForge 3-year training window may be insufficient to distinguish genuine alpha from noise.

### 4.4 The False Discovery Problem

With 65+ features and 7 models, the probability of finding at least one spuriously significant result is high. The Bonferroni correction (α/n_tests) is conservative. The more appropriate correction for financial ML is the Deflated Sharpe Ratio, which accounts for the number of independent strategy configurations tested.

**Recommendation:** Implement DSR as a required component of `ModelAcceptanceGate`. Any model with DSR < 0 should be automatically rejected regardless of reported Sharpe.

---

## 5. Model Complexity vs Simplicity Trade-off

### López de Prado's Principle

Prefer simple models that outperform complex models out-of-sample. The more parameters a model has, the more data it requires to avoid overfitting. With financial data's low signal-to-noise ratio and limited effective sample size, simpler models almost always win OOS.

### Complexity Budget for AlphaForge

| Component | Current complexity | Recommended starting complexity |
|---|---|---|
| Regime classifier | XGBoost, 6 classes, 300 trees | XGBoost/LightGBM, 3-4 classes, 100 trees |
| Stock ranker | LightGBM, 65+ features, 500 trees | LightGBM, 20-25 clustered features, 200 trees |
| Strategy selector | CatBoost, 8 classes, 17 features | Rule-table conditioned on regime (no ML) |
| Risk predictor | XGBoost × 3, 18 features | XGBoost × 2 (merge stop/target into TBL), 10 features |
| Price forecaster | Heuristic | LightGBM on 10-15 lagged features |
| Meta-engine | 7-model ensemble | 2-3 model ensemble until each shows OOS IC |

### The Occam's Razor Rule for Financial ML

A model with half the parameters that achieves 90% of the in-sample performance will almost always achieve a **higher** OOS performance because the remaining 10% in-sample performance came from overfitting the training noise.

AlphaForge should start with the simplest possible model that shows OOS IC > 0.02, and add complexity only when additional complexity demonstrably improves OOS performance (measured via CPCV).
