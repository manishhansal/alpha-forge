# Cross-Sectional Alpha Methodology — AlphaForge Phase 3E

**Version:** Phase 3E
**Last updated:** 2026-09-06
**Scope:** Indian equity and F&O, daily bars (NSE/BSE)

This document covers the economic reasoning, mathematical definitions, and design decisions for the cross-sectional alpha and ranking engine. It is the companion to `docs/ml-audit/phase-3e-cross-sectional-ranking.md` (correctness and architecture) and `reports/phase-3e-ranking-report.md` (evidence and statistics).

---

## 1. Why Cross-Sectional, Not Absolute

### 1.1 The absolute prediction problem

Predicting `E[R_i,t+5]` in absolute terms faces a fundamental difficulty: the bulk of any stock's 5-day return is driven by common factors (market regime, sector rotation, macro shocks) that are shared across the entire universe. A model that correctly predicts the market's direction will appear to "predict" most individual stocks well, without identifying any stock-specific information.

The relevant research question is not:

> "Will this stock go up?"

but:

> "Among the stocks that were actually investable at this exact point in history, which ones are likely to **outperform their peers**?"

### 1.2 The relative prediction advantage

Cross-sectional prediction explicitly removes common exposures:

```
alpha_i,t = E[R_i,t+h - R_benchmark,t+h]
```

or more precisely, after sector/beta neutralisation:

```
alpha_i,t = E[residual_i,t+h]
```

where `residual` = stock-specific return not explained by common factors.

This gives the model a cleaner signal to learn from and a more actionable output: it tells you which stocks to overweight relative to the universe, not whether to be long or short the market.

---

## 2. Universe Construction

### 2.1 The survivorship rule

At timestamp t, the eligible universe must be:

```
U_t = historical_eligible_universe(t)
```

**Never** `current_universe()` applied to historical dates.

Adding a stock that was not eligible at t to the universe retroactively would:
- Change cross-sectional ranks at t (tested in `TestUniverseMutation`)
- Inflate breadth statistics (Phase 3D)
- Create a selection bias toward stocks that "survived to today"

### 2.2 Eligibility states

| State | Meaning |
|-------|---------|
| `MODEL_ELIGIBLE` | Passes all filters; may appear in rankings |
| `MODEL_INELIGIBLE` | Fails hard filter (delisted, expired) |
| `DATA_UNAVAILABLE` | Price data absent at t |
| `INSUFFICIENT_HISTORY` | Fewer than `min_history_bars` clean price bars |
| `FNO_BANNED` | NSE MWPL ban active at t |
| `CONTRACT_EXPIRED` | Derivative contract expired |
| `INSUFFICIENT_LIQUIDITY` | Below ADV threshold |

### 2.3 Minimum cross-section gate

A ranking across fewer than `min_cross_section_size` stocks is not statistically meaningful. When `|U_t| < min_cross_section_size`:

```
signal_status = INSUFFICIENT_CROSS_SECTION
```

No ranks are produced. This prevents the model from being used as a decision input when the eligible universe is too thin for reliable cross-sectional statistics.

---

## 3. Cross-Sectional Targets

### 3.1 The six canonical targets

At timestamp t, for each eligible stock i over horizon h:

| ID | Name | Formula |
|----|------|---------|
| A | Raw return | `(p_i[t+h] − p_i[t]) / p_i[t] × 100` |
| B | Excess return | `A_i − A_benchmark` (NIFTY 50) |
| C | Sector relative | `A_i − mean(A_peers)` within sector at t |
| D | CS percentile | `percentile_rank(A_i)` within `U_t` |
| E | CS z-score | `(A_i − μ_{U_t}) / σ_{U_t}` |
| F | CS rank | `ordinal_rank(A_i)` within `U_t`, 1=lowest |

**Missing data policy:** If `p_i[t+h]` is absent, `value = None`. Never substitute 0 or mean.

**Min CS size gate:** Targets D, E, F require `|U_t| ≥ min_cs_size`. Below this threshold, all CS statistics are `None`.

### 3.2 Timing invariant

Features at t use only data available at t. Targets use future data strictly after t. Target values **never** affect:
- Universe construction at t
- Feature normalisation at t
- Feature selection or model fitting

This is the fundamental PIT contract.

### 3.3 Recommended primary target

For ranking models, **Target B (excess return)** is the preferred primary target. It:
- Removes the market return component that affects all stocks simultaneously
- Is directly comparable across all instruments in `U_t`
- Has a clear economic interpretation (alpha vs benchmark)
- Is consistent with the existing `build_ranking_training_data()` label

---

## 4. Cross-Sectional Normalisation

### 4.1 Why normalise cross-sectionally

If features are computed per-stock independently (as in the pre-Phase-3E pipeline), then the same feature value means different things for different stocks. A `return_20d = 5.0` might be top-decile momentum for one stock type and median for another.

Cross-sectional normalisation ensures that `z-scored_feature_i,t` expresses where stock i stands **relative to its peers at t**, not relative to its own history.

### 4.2 Available methods

| Method | Formula | When to use |
|--------|---------|-------------|
| `cs_zscore` | `(x − μ_t) / σ_t` | Default; stable; assumes approximate normality |
| `cs_robust_zscore` | `(x − median_t) / IQR_t` | When features have heavy tails |
| `cs_rank_pct` | `rank(x) / (n-1)` in [0,1] | When distribution is highly skewed; ranks are robust |
| `cs_rank_normal` | Blom normal-score transform | For tree models; maps rank quantiles to normal |

### 4.3 Timestamp-local constraint

**Every normalisation must be computed within a single timestamp's cross-section.** This is verified by `test_normalize_panel_each_timestamp_independent` which confirms that statistics from timestamp t₁ never enter the computation at timestamp t₂.

### 4.4 Winsorisation

Before normalisation, extreme outliers are capped at configurable percentiles (default 1% each tail). Winsorisation:
- Prevents a single outlier from distorting z-scores for all other stocks
- Must occur **before** CS normalisation in the pipeline
- The winsorisation config is versioned (`normalization_version`)

### 4.5 Pre-training normalisation vs inference

**Critical:** normalisation statistics (mean, std, IQR) fitted on the training fold must be stored and applied unchanged to the validation and test folds. Never refit normalisation on val or test data.

---

## 5. Neutralisation

### 5.1 Why neutralise

A cross-sectional ranker that correctly identifies sector rotation will appear to have skill — but it is predicting sector-level moves, not stock-specific alpha. Similarly, a ranker that identifies high-beta stocks will appear skilled in bull markets but has no genuine stock-selection ability.

Neutralisation separates stock-specific residual alpha from common factor exposures.

### 5.2 Sector neutralisation

```
Y_residual_i = Y_i − mean(Y_sector(i),t)
```

where `sector(i)` is the PIT sector membership at t.

**Leakage rule:** `sector_map` must represent membership at t, not current classification. A company reclassified in 2025 must use its 2020 sector for 2020 data. This is enforced by passing `sector_map` as a call-time parameter — the neutraliser stores no state.

**Verified by spec §57 test:** Sector A has a common +5% move. After neutralisation, all Sector A stocks should show zero common return; only stock-specific deviations survive.

### 5.3 Market beta neutralisation

```
beta_i,t = cov(R_i[t-L..t], R_m[t-L..t]) / var(R_m[t-L..t])
Y_residual_i = Y_i − beta_i,t × R_m
```

where `beta_i,t` is estimated using only data at or before t (rolling lookback L).

**Leakage rule:** Beta must be estimated from returns ending at t-1, not t+h. Never estimate beta using the same horizon as the target return.

**Verified by spec §58 test:** High-beta stock (β=2) and low-beta stock (β=0.5) with equal stock alpha of +5%. After beta neutralisation, both should have residual = +5%.

### 5.4 General factor neutralisation

For more factors (size, liquidity, momentum), OLS ridge-penalised neutralisation:

```
Y_residual = Y − F(F'F + αI)⁻¹F'Y
```

where F is the factor exposure matrix. Ridge penalty `α` provides numerical stability when factors are correlated.

**Fold contract:** Factor exposures (F matrix) must be computed from PIT data at or before the training period boundary. The OLS coefficients must be fitted on the training fold only, not refitted on val or test.

---

## 6. Ranking Models

### 6.1 Score semantics invariant

Every model must document what its `alpha_score` represents via `AlphaScoreSemantics`. The convention is:

```
higher alpha_score = more attractive
```

This is enforced across all six models. Models that natively produce lower-is-better scores (e.g. residual distance from mean) must invert before storing in `CrossSectionalAlphaSignal`.

### 6.2 Baseline-first requirement

Before trusting ML, establish non-ML baselines:

**Baseline A — 20-day momentum rank:**
Uses only `return_20d` from the feature matrix. Ranks stocks by their trailing 20-day return. This is an approximate cross-sectional momentum factor.

**Baseline B — Equal-weight composite:**
Z-scores all features within the cross-section, averages them equally. This is the "kitchen sink" equal-weight factor model.

If LightGBM does not materially outperform these baselines, the verdict is `ML_ADDS_NO_CLEAR_VALUE`. This is a valid and important research result, not a failure.

### 6.3 Linear models

**Ridge:** L2 regularisation; stable; interpretable feature weights; assumes linear relationships.

**ElasticNet:** L1 + L2; performs implicit feature selection via sparsity; useful when RANKING_FEATURES contains correlated groups.

### 6.4 Nonlinear models

**LightGBM (primary):** Gradient boosted trees. Supports:
- Point-wise regression (`objective="regression"`) — fits individual stock predictions; inference is cross-sectional via percentile rank
- Listwise LambdaRank (`objective="lambdarank"`) — explicitly optimises NDCG within each timestamp's group; requires `groups` parameter

**XGBoost (secondary):** Gradient boosted trees with pairwise ranking option. Useful for comparison and ensemble.

### 6.5 Group structure for LambdaRank

The `groups` list defines which rows belong to the same CS group (one timestamp). For LambdaRank:

```python
groups = [n_stocks_at_t1, n_stocks_at_t2, ..., n_stocks_at_tN]
```

This list must be reconstructed within each walk-forward fold after row filtering (NaN removal can break group sizes). A critical Phase 3F task is to wire this correctly through the walk-forward pipeline.

---

## 7. Evaluation Metrics

### 7.1 Rank IC

```
Rank_IC_t = Spearman(rank(alpha_score_i,t), rank(realized_return_i,t))
```

Computed **within timestamp t** — cross-sectionally across all eligible stocks at that timestamp. Never computed globally across stocks and timestamps.

Range: [-1, +1]. +1 = perfect ranking. -1 = perfect anti-ranking.

### 7.2 ICIR

```
ICIR = mean(Rank_IC) / std(Rank_IC)
```

Not annualised by default. To annualise: `ICIR_ann = ICIR × √252` for daily.

- `ICIR > 0.5`: reasonable signal persistence
- `ICIR < 0.3`: signal may be noisy or unstable
- `ICIR = None`: constant IC series (std = 0) — do not fabricate as zero

### 7.3 Decile analysis

Stocks are sorted by alpha score within each timestamp and divided into 10 equal buckets:
- Decile 1 = lowest score (short candidates)
- Decile 10 = highest score (long candidates)

A well-calibrated ranker shows **monotonic increase** from D1 to D10 for the target metric.

The `monotonicity_score` is the Spearman correlation between decile rank (1–10) and mean decile return. A score near +1 indicates the ranker preserves relative order across deciles; a score near 0 indicates the ranker only identifies extremes.

### 7.4 Top-bottom spread

```
spread = mean(D10 returns) - mean(D1 returns)
```

This is a research diagnostic, **not** a strategy P&L. Actual trading costs, capacity, and execution timing will reduce the net spread substantially.

### 7.5 Turnover proxy

```
turnover_t = 1 - |top_K_t ∩ top_K_{t-1}| / |top_K_t|
```

High turnover increases transaction costs and reduces net alpha. A ranker with `turnover > 0.5` on daily data would be extremely expensive to implement.

### 7.6 IC distribution

Report all IC distribution statistics, not just the mean. An IC series with mean 0.05 and std 0.20 is much less reliable than one with mean 0.05 and std 0.03. The 5th percentile IC is particularly important — it shows what the ranker does in its worst periods.

---

## 8. Walk-Forward Validation

### 8.1 The group invariant

The fundamental validation unit is a **timestamp** — not an individual stock-day row. All stock observations at the same timestamp belong to the same cross-section and must stay in the same fold.

**Never split stock rows randomly.** A random split would mix 2023-Jan and 2025-Jun stock data in the same training fold, creating temporal leakage.

### 8.2 CrossSectionalWalkForward

```
train timestamps: T[0] .. T[train_bars]
(embargo gap:      T[train_bars+1] .. T[train_bars+embargo_bars])
val   timestamps: T[train_bars+embargo_bars+1] .. T[+val_bars]
test  timestamps: T[+val_bars+1] .. T[+test_bars]
```

Hard assertions at construction time:
- `max(train_timestamps) < min(val_timestamps)` — no overlap
- `max(val_timestamps) < min(test_timestamps)` — no overlap
- Test windows from different folds never overlap

### 8.3 Inner HPO

Hyperparameter optimisation must use only the training fold data:

```
outer fold: train → val → TEST (never seen during HPO)
inner fold: train[:80%] → train[80%:]   ← HPO target
```

The outer test fold must never influence hyperparameter selection.

---

## 9. Missing Data Policy

### 9.1 The fundamental rule

```
DATA_UNAVAILABLE ≠ 0
DATA_UNAVAILABLE ≠ mean
DATA_UNAVAILABLE ≠ neutral
```

When a feature or target value cannot be computed, it must be:
```
value = None (or NaN)
status = DATA_UNAVAILABLE (or INSUFFICIENT_HISTORY)
```

### 9.2 Required vs optional features

Define which features are required for ranking. A stock with a missing **required** feature must be excluded from that timestamp's cross-section (`MODEL_INELIGIBLE`). A stock with a missing **optional** feature retains the row but gets NaN for that feature — the model preprocessor may impute, with documented policy.

### 9.3 Minimum cross-section size

When the eligible universe at t has fewer than `min_cross_section_size` stocks:
```
signal_status = INSUFFICIENT_CROSS_SECTION
```
No ranks are assigned. This prevents spurious rankings from thin-universe periods (e.g., F&O expiry weeks with many stocks banned).

---

## 10. Multiple Testing Awareness

### 10.1 The problem

Searching over models, feature sets, horizons, normalisation variants, and neutralisation variants inflates the probability of finding a spurious "winning" configuration. A model that maximises backtest IC over 6 models × 5 feature sets × 3 horizons = 90 trials will almost certainly produce a false positive.

### 10.2 Phase 3E tracking

| Item | Count |
|------|-------|
| Models tested | 6 |
| Feature sets | 1 |
| Target horizons | 1 |
| HPO trials | 0 (no real data) |
| **Total experiments** | **1** |

When real-data experiments are run in Phase 3F, the experiment manifest must record all counts for future multiple-testing correction.

### 10.3 Recommended approach for Phase 3F

Use the Deflated Sharpe Ratio or Haircut Sharpe Ratio methodology (Bailey & de Prado, 2014) to adjust for multiple testing before reporting any alpha claim.

---

## 11. Economic Interpretation Framework

Before trusting any ranking result, answer:

1. **What information is being ranked?** What does the model's input feature set contain?
2. **Why should it predict relative returns?** Is there an economic mechanism, or is it a statistical artefact?
3. **What common exposures could explain it?** Sector rotation, beta, size, momentum — all need to be tested before claiming stock-specific alpha.
4. **What costs could destroy it?** Turnover × transaction cost per unit of spread.
5. **What market regimes could break it?** Bull/bear, high-vol/low-vol, expiry/non-expiry.
6. **Is it stable across time periods?** A model that works in 2021 but fails in 2022–2023 is regime-dependent, not genuinely alpha-generating.

Rank IC > 0 is **not** proof of tradable alpha. It is a necessary but far from sufficient condition.

---

## 12. Design Decisions

| Decision | Chosen | Rejected | Reason |
|----------|--------|----------|--------|
| Primary target | Excess return (B) | Raw return (A) | Removes market component; cleaner stock-specific signal |
| Score direction | higher = better | lower = better | Invariant makes ensembling and comparison unambiguous |
| Tie handling | Average rank | First occurrence | Deterministic regardless of input ordering |
| Normalisation default | CS z-score | Global z-score | Global z-score uses future timestamps → leakage |
| Beta estimation | Rolling (L bars, trailing only) | Full-history OLS | Full-history uses future returns → leakage |
| LambdaRank groups | Per-timestamp | All-data single group | Single group means LightGBM ranks stocks from different timestamps against each other |
| ICIR | Not annualised by default | Auto-annualise | Annualisation convention must be documented, not assumed |
| ML dominance check | IC improvement > 0.01 | Hard threshold | 0.01 IC improvement is the documented materiality threshold |
| Heuristic fallback | `HEURISTIC` provenance | `TRAINED_MODEL` | A heuristic must never masquerade as a trained model |
