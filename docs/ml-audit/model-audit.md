# AlphaForge ML Service — Model Audit

**Audit Date:** 2026-09-06  
**Scope:** `models/` — all 6 model files

---

## 1. Model Inventory

| Model | File | Algorithm | Task | Status |
|---|---|---|---|---|
| MarketRegimeClassifier | `market_regime.py` | XGBoost multi-class | Classify regime (6 classes) | EXPERIMENTAL |
| StockRanker | `stock_ranker.py` | LightGBM regression / lambdarank | Rank by outperformance | EXPERIMENTAL |
| StrategySelector | `strategy_selector.py` | CatBoost multi-class | Select best strategy (8 classes) | EXPERIMENTAL |
| RiskPredictor | `risk_predictor.py` | XGBoost × 3 | Stop/target/drawdown | EXPERIMENTAL |
| PortfolioOptimizer | `portfolio_optimizer.py` | Riskfolio-Lib (HRP / CVaR) | Allocate portfolio | RESEARCH_ONLY |
| RLExecutor | `rl_executor.py` | PPO (Stable-Baselines3) | Execution timing | RESEARCH_ONLY |

---

## 2. MarketRegimeClassifier

### 2.1 Architecture
- XGBoost `multi:softprob`, 6 classes, 300 estimators
- Trained on 28 `REGIME_FEATURES` (NIFTY technicals + VIX + breadth + macro)
- Heuristic fallback: rule-based scoring on VIX/breadth/change thresholds

### 2.2 Training Bug (Critical)
`train_all.py::train_regime_model()` uses:
```python
X_train, X_val, y_train, y_val = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
```
This **randomly shuffles** the time series, allowing future market conditions to appear in the training set when training on "earlier" data points. Any reported `val_accuracy` is invalid as an OOS performance estimate.

### 2.3 Heuristic Fallback Quality
The heuristic uses additive scoring with hand-tuned thresholds (e.g., VIX < 13 → strong_bull_score += 0.20). The 2nd version adds PCR, OI delta skew, and pct_above_sma20 — more India-specific. But these thresholds are empirical guesses, not data-derived. The heuristic will be systematically wrong at regime transitions.

### 2.4 Model Selection Rationale
XGBoost is appropriate for this task. Tree models handle non-linear threshold interactions (e.g., low VIX AND positive A/D ratio → bull). The 6-class structure is reasonable. Main concern: **severe class imbalance** — CRASH events are rare, making the classifier unreliable for the highest-risk regime exactly when it matters most.

### 2.5 Assessment
- What it is: ML model (when trained), heuristic (always currently)
- Production ready: ❌ No — random split invalidates all metrics
- Verdict: **REWRITE training split** (not the model itself)

---

## 3. StockRanker

### 3.1 Architecture
- LightGBM regression (default) or lambdarank (if group data available)
- 65+ `RANKING_FEATURES` per stock
- Heuristic fallback: multi-factor weighted composite score

### 3.2 Training
`train_all.py::train_ranking_model()` uses a **time-based split** (last 20%):
```python
split_idx = int(len(X) * 0.8)
X_train, X_val = X[:split_idx], X[split_idx:]
```
This is **correct** for a time-series model. 

However, there is no PurgedKFold or embargo applied. For a 5-day forward return label, the feature at bar `i` and the label use data from `i+1..i+5`. If the train/val boundary is at `split_idx`, then bars `split_idx-5..split_idx-1` have labels that extend into the val set — label overlap without purging.

### 3.3 Heuristic Fallback Quality
The heuristic composite score is sophisticated:
- Momentum (0.22 weight, regime-adjusted)
- Volume confirmation (0.16)
- Breakout quality (0.18)
- **Derivatives positioning (0.22 — highest single weight)**
- Mean reversion (0.10)
- Relative strength (0.12)

The elevated derivatives weight (0.22) reflects the insight that OI and PCR are strong leading indicators for Indian F&O stocks. This is domain-appropriate. However, the weights were manually tuned — no cross-validated evidence that these proportions outperform equal-weighting or simpler alternatives.

### 3.4 LambdaRank vs Regression
The code supports both but defaults to regression. LambdaRank (`lambdarank` objective) is theoretically more appropriate for a ranking task (optimises NDCG directly). The dataset builder returns `groups` for LambdaRank — it is ready to use but not the default.

### 3.5 Assessment
- What it is: Genuine ML for ranking when trained; heuristic otherwise
- Production ready: ❌ No — no embargo at train/val boundary; no trained artifact validated
- Verdict: **FIX** (add embargo); otherwise sound design

---

## 4. StrategySelector

### 4.1 Architecture
- CatBoost multi-class (8 strategy classes)
- 17 `STRATEGY_FEATURES`
- Heuristic fallback: condition-based rule table

### 4.2 Training Bug (Critical)
Same as MarketRegimeClassifier — uses `train_test_split` with `stratify=y`:
```python
X_train, X_val, y_train, y_val = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
```
Invalid for time-series. Temporal leakage in validation metrics.

### 4.3 CatBoost Appropriateness
CatBoost is a reasonable choice for multi-class classification on tabular data. It handles class imbalance better than raw XGBoost. No categorical features are used (all features are numeric), so the CatBoost-specific categorical handling is unused.

### 4.4 Strategy Label Distribution
8 strategies, 17 features. If strategy labels are roughly uniform (each strategy is optimal ~12.5% of the time), this is tractable. If momentum dominates (likely in bull regimes), the model will be dominated by the most common label. No class distribution analysis is reported.

### 4.5 Assessment
- What it is: ML model (when trained); heuristic (always currently)
- Production ready: ❌ No — random split
- Verdict: **REWRITE training split**

---

## 5. RiskPredictor

### 5.1 Architecture
Three separate XGBoost models:
- `stop_model`: binary classifier — P(stop loss hit within 20 bars)
- `target_model`: binary classifier — P(target hit within 20 bars)  
- `drawdown_model`: regressor — expected max adverse excursion %

18 `RISK_FEATURES` including trade geometry (`stop_distance_atr`, `target_distance_atr`, `risk_reward_ratio`, `trend_alignment`).

### 5.2 Training
Uses **time-based split** (last 20%):
```python
split_idx = int(len(X) * 0.8)
```
Correct split direction. Same label-overlap concern as StockRanker applies (20-bar lookforward labels without embargo).

### 5.3 Heuristic Fallback
The heuristic is complex and surprisingly well-designed:
- Base stop rate = 40% (empirical NSE intraday estimate)
- Multiplicative factors: stop distance, VIX, trend alignment, ADX, OI support, expiry
- Kelly criterion for position sizing with half-Kelly safety factor
- Risk score decomposition with 5 components

The base 40% stop rate is documented as "empirical NSE" but no reference is provided. If the actual historical stop-hit rate at 1.4×ATR is different, the heuristic will be systematically miscalibrated.

### 5.4 Kelly Position Sizing
```python
kelly = (p * b - q) / b  # p=target_prob, b=RR, q=1-p
half_kelly = max(kelly * 0.5, 0.0)
```
This is correct Kelly formula with half-Kelly safety. Position sizing is then:
```python
position_from_risk = (risk_budget_pct / stop_dist_pct) * 100  # 1% equity risk
position_size = position_from_risk * min(half_kelly * 2, 1.0)
```
The cap `max_size = 10.0 - vix_regime * 1.5` ensures maximum position is reduced in high-VIX environments. This is reasonable but somewhat arbitrary.

### 5.5 Assessment
- What it is: Genuinely probabilistic ML for risk estimation
- Production ready: ❌ No — labels lack slippage/cost; simultaneous stop+target not resolved
- Verdict: **FIX** labels + add embargo; model design is sound

---

## 6. PortfolioOptimizer

### 6.1 Architecture
Wraps Riskfolio-Lib:
- `hrp_allocation()`: Hierarchical Risk Parity via `rp.HCPortfolio`
- `cvar_allocation()`: CVaR-minimised MVO at `alpha=0.05`
- Legacy `optimize()`: preserved for existing `/predict/portfolio` endpoint

### 6.2 Inputs
Takes a DataFrame of asset daily returns. Returns weights that sum to 1, all ≥ 0.

### 6.3 Statistical Assumptions
- HRP assumes the covariance structure is estimable from the returns window
- CVaR minimisation assumes the historical return distribution is representative
- Both methods assume stationarity over the estimation window — violated during regime changes

### 6.4 Risk-Free Rate
`DAILY_RF = 0.071 / 252` — uses 7.1% (10-yr G-Sec proxy). Current RBI repo rate is ~6.5%. Minor difference but introduces a small systematic Sharpe bias.

### 6.5 Assessment
- What it is: Genuine quantitative portfolio optimization
- Production ready: ⚠️ Functional but not validated on OOS Indian equity data
- Verdict: **RESEARCH_ONLY** pending OOS validation

---

## 7. RLExecutor

### 7.1 Architecture
PPO via Stable-Baselines3. 7 discrete actions:
1. WAIT (hold)
2. ENTER_NOW
3. SCALE_IN
4. PARTIAL_EXIT (30%)
5. FULL_EXIT
6. TIGHTEN_STOP
7. TRAIL_STOP

State: 14-dimensional (trade metrics + market microstructure).

### 7.2 Reward Design
Reward includes:
- Risk-adjusted P&L
- Penalty for holding too long
- Penalty for excessive drawdown
- Penalty for over-trading (action frequency penalty)

The multi-penalty design is appropriate and reduces the common failure mode of RL systems that learn to churn positions.

### 7.3 Training Status
`train_rl_executor()` in `train_all.py` calls `model.train(total_timesteps=500_000)`. There is no environment validation, no backtested episode data, and no OOS performance measurement. The RL agent trains on an unspecified simulation environment.

### 7.4 Critical Gap
The `_build_env_class()` function dynamically imports gymnasium — if the environment is not correctly parameterised with realistic market microstructure (spread, slippage, order sizes), the agent will overfit to an idealised simulator and fail in live execution.

### 7.5 Assessment
- What it is: RL-based execution timing
- Production ready: ❌ No — environment not validated; no OOS performance evidence
- Verdict: **RESEARCH_ONLY**

---

## 8. Hyperparameter Optimization

`_hpo_xgboost()` in `train_all.py` uses Optuna to optimise XGBoost hyperparameters. The objective function optimises `accuracy_score(y_val, model.predict(X_val))` where `X_val / y_val` come from the same random split as training.

**This is HPO leakage**: the hyperparameters are selected to maximise performance on the same validation set used to report final metrics. Reported val_accuracy will be optimistically biased.

**Fix**: Hold out a final test set that is never used during HPO. Report final performance only on this test set.

---

## 9. Overall Model Assessment

| Model | Genuinely ML | Production Ready | OOS Evidence | Verdict |
|---|---|---|---|---|
| MarketRegimeClassifier | ✅ (when trained) | ❌ | ❌ | REWRITE train split |
| StockRanker | ✅ (when trained) | ❌ | ❌ | FIX embargo |
| StrategySelector | ✅ (when trained) | ❌ | ❌ | REWRITE train split |
| RiskPredictor | ✅ (when trained) | ❌ | ❌ | FIX labels + embargo |
| PortfolioOptimizer | ✅ | ⚠️ | ❌ | RESEARCH_ONLY |
| RLExecutor | ✅ | ❌ | ❌ | RESEARCH_ONLY |
