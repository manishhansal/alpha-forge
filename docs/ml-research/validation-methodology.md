# AlphaForge ML — Validation Methodology

**Date:** 2026-09-06  
**Scope:** Walk-forward, purged CV, CPCV, backtest methodology — from research to production-grade evidence.

---

## 1. Why Standard ML Validation Fails in Finance

### 1.1 Three Sources of Invalid Performance Estimates

**1. Temporal leakage** — Random k-fold CV shuffles the time series. A model trained on 2024 data and tested on 2022 data appears to "predict" the past. The CV score is a measure of interpolation, not extrapolation.

**2. Label overlap** — A 5-day forward return label at bar t uses price data from t+1..t+5. The label at t+1 uses t+2..t+6. These two labels share 4 bars of information. Standard CV treats them as independent; they are not.

**3. Multiple testing** — Evaluating 30 hyperparameter configurations on the same validation set means the "best" configuration is the maximum over 30 correlated draws. The expected maximum of 30 standard normals is ~2.3σ above zero — even random strategies appear to have IR ≈ 2.3 × SE.

### 1.2 AlphaForge's Current Validation State

| Model | Split type | Temporal ordering | Embargo | PurgedKFold | Result |
|---|---|---|---|---|---|
| Regime | `train_test_split(stratify=y)` | ❌ RANDOM | ❌ | ❌ | Invalid |
| Strategy | `train_test_split(stratify=y)` | ❌ RANDOM | ❌ | ❌ | Invalid |
| Ranker | 80/20 time-based | ✅ | ❌ | ❌ | Partially valid |
| Risk | 80/20 time-based | ✅ | ❌ | ❌ | Partially valid |
| RL | N/A | — | — | — | Not evaluated |

**Conclusion:** No current model has a valid OOS performance estimate. All reported `val_accuracy` / `val_spearman` values are unreliable.

---

## 2. Walk-Forward Validation — Correct Implementation

### 2.1 Rolling vs Expanding Windows

**Rolling window:**
```
Fold 0: Train [0..251], Val [252..314], Test [315..377]
Fold 1: Train [63..314], Val [315..377], Test [378..440]
```
- Fixed training window size (e.g., 252 trading days = 1 year)
- Window slides forward each fold
- Reflects the assumption that recent data is more predictive than old data (appropriate for regime-shifting markets)

**Expanding window:**
```
Fold 0: Train [0..251], Val [252..314], Test [315..377]
Fold 1: Train [0..314], Val [315..377], Test [378..440]
```
- Training window grows over time
- Reflects the assumption that all historical data is equally valuable
- Appropriate when sample size is limited and the process is stationary

**Recommendation for AlphaForge:** Use rolling window for regime and strategy models (regime-shifting Indian market); use expanding window for risk models (more stable statistical relationships between stop-geometry and outcome).

### 2.2 Recommended Walk-Forward Configuration for Indian F&O

| Model | Train bars | Val bars | Test bars | Step bars | Rationale |
|---|---|---|---|---|---|
| Regime classifier | 504 (~2yr) | 63 (~3mo) | 63 (~3mo) | 63 | Regime patterns in India change ~annually |
| Stock ranker | 756 (~3yr) | 63 (~3mo) | 63 (~3mo) | 63 | Larger window needed for cross-sectional ranking |
| Risk predictor | 504 (~2yr) | 63 (~3mo) | 63 (~3mo) | 63 | Stop/target dynamics relatively stable |
| Strategy selector | 756 (~3yr) | 126 (~6mo) | 63 (~3mo) | 63 | 8-class problem needs more training data |

A 5-year history (1,260 trading days) with the regime config above produces:
```
(1,260 - 504 - 63 - 63) / 63 = ~10 folds
```
Ten OOS test folds × 63 days = 630 OOS trading days of evaluation.

### 2.3 Embargo Configuration

The embargo gap must be ≥ the label horizon to prevent label-overlap leakage:

| Model | Label horizon | Minimum embargo |
|---|---|---|
| Regime labels | 5 bars | 5 bars |
| Ranking labels | 5 bars | 5 bars |
| Risk labels | 20 bars | 20 bars |

The AlphaForge `EmbargoApplier` supports this directly:
```python
cfg = EmbargoConfig.bars(n=label_horizon)
applier = EmbargoApplier(cfg)
train_idx_clean, _, _ = applier.apply_to_fold(train_idx, val_idx, test_idx)
```

---

## 3. Purged Cross-Validation

### 3.1 What Is Purging?

Purging removes training observations whose label **end time** falls within the test window's time span. Even after temporal ordering, adjacent training observations can have labels that extend into the test period.

For a 5-day label horizon:
- Training observation at bar t has a label that depends on prices at t+1..t+5
- If the test window starts at t+3, the training observation at t is contaminated

Purging removes all training observations within the label horizon of the test window boundary.

### 3.2 Implementation in AlphaForge

AlphaForge already has a correct `PurgedKFold` implementation. The `t1` series (label end times) must be built correctly:

```python
from validation.purged_kfold import build_t1_series, PurgedKFold

# For 5-day ranking labels
t1 = build_t1_series(df.index, horizon_bars=5)

# sklearn-compatible usage
splitter = PurgedKFold(n_splits=5, t1=t1, embargo_pct=0.01)
for train_idx, test_idx in splitter.split(X, y, groups=df.index):
    model.fit(X[train_idx], y[train_idx])
    score = evaluate(model, X[test_idx], y[test_idx])
```

### 3.3 Interaction with Walk-Forward

Purged K-Fold is not the same as Walk-Forward. The correct architecture:
- **Walk-forward:** Outer loop that advances the training window and generates OOS test periods
- **Purged K-Fold:** Inner loop used for hyperparameter selection within the training window of each walk-forward fold

```
Walk-forward fold k:
  training_window = data[k:k+train_bars]
  
  HPO (inner loop, purged CV on training_window):
    PurgedKFold(n_splits=3, t1=t1[k:k+train_bars])
    Select best hyperparameters
  
  Retrain on full training_window with best hyperparams
  Evaluate on test fold → OOS score
```

---

## 4. Combinatorial Purged Cross-Validation (CPCV)

### 4.1 Motivation: Beyond Walk-Forward

Walk-forward produces a single backtest path. CPCV generates C(N,k) paths, providing a **distribution** of possible OOS Sharpe ratios. This is critical because:
- A single walk-forward result is one realization — it may be lucky or unlucky
- CPCV reveals whether performance is robust across all possible paths or concentrated in a few lucky periods
- The fraction of CPCV paths with positive Sharpe is a more reliable measure of strategy quality than any single path

### 4.2 CPCV Configuration

AlphaForge has `CPCVSplitter` implemented. Recommended configuration:

```python
# For AlphaForge regime model with 5-year history
N = 10   # number of groups (divide 1,260 bars into 10 groups of ~126)
k = 2    # number of groups in each test set

# C(10, 2) = 45 distinct test combinations
# Each combination provides a test period of 2×126 = 252 bars
# 45 independent OOS Sharpe estimates

folds = cpcv_splits(X, y, n_splits=N, n_test_splits=k, t1=t1, t0=df.index)
```

### 4.3 Interpreting CPCV Results

From C(N,k) paths, compute:
1. **Sharpe distribution:** Histogram of per-path annualised Sharpe ratios
2. **Probability of backtest overfitting (PBO):** Fraction of paths where the "best" in-sample configuration performs below median in OOS
3. **95th percentile Sharpe:** Pessimistic estimate of achievable performance
4. **Fraction of positive paths:** A robust strategy should have > 70% positive paths

**Decision rule:**
- If median CPCV Sharpe (net of costs) > 0.5: strong evidence of robustness
- If ≥ 70% of paths are positive: sufficient path diversification
- If PBO < 0.3: limited overfitting evidence
- If any single path dominates (e.g., one path contributes > 50% of total returns): performance is path-dependent, not robust

---

## 5. Backtest Methodology Best Practices

### 5.1 The Backtest Pyramid

```
                     Live Trading
                    (ground truth)
                   ──────────────────
                 Paper Trading / Shadow
                (real-time, no look-ahead)
               ──────────────────────────────
             CPCV / Walk-Forward Evaluation
           (multiple paths, no data snooping)
          ─────────────────────────────────────────
         Walk-Forward with Purging + Embargo
       (single path, temporally valid)
      ─────────────────────────────────────────────────
    In-Sample Cross-Validation
  (unreliable for financial time series)
```

AlphaForge is currently attempting to build from the bottom (in-sample CV) toward the top. The audit found the bottom two levels are broken. No reliable evidence exists above in-sample evaluation.

### 5.2 Realistic Cost Model for Indian F&O

Every backtest must include realistic transaction costs before any performance claim:

| Cost Type | Equity Delivery | Equity Intraday | F&O (options buy) | F&O (futures) |
|---|---|---|---|---|
| Brokerage | 0.03-0.05% | 0.03-0.05% | ₹20 flat | ₹20 flat |
| STT | 0.1% (sell) | 0.025% (sell) | 0.1% on sell (ITM) | 0.01% (sell) |
| SEBI charge | 0.0001% | 0.0001% | 0.0001% | 0.0001% |
| Exchange + NIF | 0.00345% | 0.00345% | 0.00345% | 0.00345% |
| Stamp duty | 0.015% | 0.003% | 0.003% | 0.002% |
| **Typical round-trip** | **~0.20-0.30%** | **~0.10-0.15%** | **~0.15-0.20%** | **~0.05-0.10%** |
| Slippage (estimate) | 0.05-0.15% | 0.05-0.15% | 0.10-0.25% | 0.03-0.10% |
| **Total round-trip** | **~0.35-0.45%** | **~0.20-0.30%** | **~0.25-0.45%** | **~0.10-0.20%** |

*Note: STT on F&O changed — exercise/expiry of in-the-money options attracts 0.1% on full notional.*

**Implementation for AlphaForge:**
```python
NSE_ROUNDTRIP_COST_PCT = {
    "equity_delivery": 0.40,   # conservative
    "equity_intraday": 0.25,
    "fno_options":     0.35,
    "fno_futures":     0.15,
}

# Deduct from label at generation time
net_label = gross_label - NSE_ROUNDTRIP_COST_PCT["fno_futures"] / 100
```

### 5.3 Realistic Slippage Model

Slippage in Indian F&O depends on:
1. **Market impact:** Proportional to order size / average daily volume (ADV)
2. **Bid-ask spread:** Varies by time of day (high at open, tight at mid-day, wide at close)
3. **Volatility:** Slippage is higher during high-VIX periods

A simple linear impact model:
```python
slippage_pct = 0.1 + (order_size_cr / adv_cr) × 0.5
```

For AlphaForge's assumed 1-5% position sizes on ₹1L portfolio (₹1,000-5,000 per stock vs typical ADV of ₹50-500 crore), market impact is negligible. The primary cost is the bid-ask spread (~0.05-0.2% depending on the instrument).

### 5.4 Structural Breaks and Regime Stationarity

A model trained on 2021-2023 data and tested on 2024-2025 data may fail if there was a structural break in the generating process. India-specific structural breaks to account for:

| Date | Break | Effect on model |
|---|---|---|
| March 2020 | COVID crash | Extreme VIX regime; extreme OI patterns |
| Sep 2023 | BankNifty expiry moved to Wednesday | Breaks historical Thursday expiry features |
| Nov 2024 | SEBI F&O regulations (lot size increase, margin rules) | Changes OI volumes, PCR dynamics |
| Jan 2025 | T+1 settlement fully implemented | Changes delivery % computation |
| April 2025 | NSE expiry moved to Monday | Breaks Wednesday/Thursday expiry features |
| Sep 2025 | NSE expiry moved to Tuesday | Current expiry day — **all hardcoded Thursday assumptions are wrong** |

**AlphaForge must implement structural break detection:**
- CUSUM test on key regime features (VIX percentile, breadth, PCR) — if test statistic > threshold, trigger model retraining
- Regime label consistency check: are pre-break and post-break labels drawn from the same distribution?

### 5.5 Multiple Testing and the DSR Threshold

When evaluating N configurations (Optuna trials, feature subsets, model types), apply the Deflated Sharpe Ratio:

```
SR_deflated = SR × Φ^{-1}[1 - (1-Φ(SR))^N] / SR × corrections
```

Practical rule: if you tested N configurations, require the final model to have:
```
SR_observed ≥ (√(2 × ln(N)) / √(T/252))
```

For T=252 days OOS and N=30 Optuna trials:
```
SR_threshold = √(2 × ln(30)) / 1 ≈ 2.45 annualised
```

This means: a model found by testing 30 configurations over 1 year of OOS data needs a raw Sharpe of 2.45 just to be statistically significant after multiple testing correction. Most strategies will fail this threshold — which is the correct conclusion.

---

## 6. Validation Lifecycle for AlphaForge

### The Complete Validation Sequence

```
Step 1: Fix temporal splits in train_all.py (Critical — must do first)
Step 2: Build t1 series for all label types
Step 3: Apply PurgedKFold within training windows for HPO
Step 4: Run WalkForwardValidator for OOS evaluation (10 folds)
Step 5: Compute IC per fold → IC time series → mean IC, SE(IC), t-stat
Step 6: Run CPCV → distribution of OOS Sharpe paths
Step 7: Apply transaction cost model → net Sharpe
Step 8: Compute DSR → minimum Sharpe threshold given n_trials
Step 9: Pass ModelAcceptanceGate (IC > threshold AND net Sharpe > DSR threshold AND > 50% CPCV paths positive)
Step 10: Paper trading (30 days minimum) → consistency check
Step 11: Shadow trading (live signals, no capital) → 60 days
Step 12: Live trading with reduced risk budget → 90 days
Step 13: Full production deployment
```

**Time estimate for the complete validation lifecycle (assuming data is available):**
- Steps 1-9: ~4-6 weeks of engineering + compute time
- Steps 10-12: ~6 months of paper/shadow trading
- Step 13: ~9 months from start of validation

There is no shortcut that maintains statistical validity. Any claim of production-ready alpha before completing this sequence is unsupported by evidence.
