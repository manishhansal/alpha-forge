# Phase 3H — Portfolio Stability Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Overview

This report documents the portfolio weight stability analysis implemented in
`PortfolioAnalytics.stability()`. Stability is a diagnostic — it is not used to
tune optimizer parameters, and it is not used to select the portfolio objective
based on final OOS performance.

---

## 2. Stability Analysis Method

Stability is measured via deterministic grid perturbation — **no randomness**.

### 2.1 EV perturbation

Each candidate's `expected_value` is scaled by `(1 + δ)` for `δ ∈ {-10%, +10%}`.
The optimizer is re-run on the perturbed inputs.
Weight change = `mean(|w_perturbed - w_base|)`.

### 2.2 Volatility perturbation

The covariance matrix is scaled by `(1 + δ)²` for `δ ∈ {-10%, +10%}`.
Same metric.

### 2.3 Rank stability

Spearman rank correlation between base and perturbed weight ranks.
Values close to 1.0 indicate rank-stable portfolios.

---

## 3. Stability Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| `mean_weight_change_ev` | Avg weight change per 10% EV perturbation | < 5% |
| `mean_weight_change_vol` | Avg weight change per 10% vol perturbation | < 5% |
| `mean_weight_change_corr` | Avg weight change per 5% correlation perturbation | < 5% |
| `rank_stability` | Spearman corr of weight ranks | > 0.7 |
| `turnover_sensitivity` | d(turnover) / d(EV shock) | Lower is better |

---

## 4. Stability by Objective (Expected Properties)

| Objective | EV stability | Vol stability | Notes |
|-----------|-------------|--------------|-------|
| EQUAL_WEIGHT | Perfect (trivially stable) | Perfect | Not signal-sensitive |
| HRP | High | High | Hierarchical structure dampens small changes |
| MIN_VARIANCE | Low–Medium | High | Sensitive to EV inputs if MAX_SHARPE used |
| CVaR | Medium | Medium | Sensitive to tail observations |
| EV_RISK | Low | Medium | Directly uses EV — expected to react to EV changes |
| RISK_BUDGETING | Medium | Medium | Driven by covariance structure |

**Note:** High EV sensitivity for EV_RISK is a feature, not a bug — the portfolio
is supposed to respond to better-quality signals.

---

## 5. OOS Stability

**INSUFFICIENT_EVIDENCE** — No real OOS time series available for rolling stability analysis.
The following stability metrics would be computed on real data:

- Rolling 63-day weight stability
- Regime-conditional stability (bull vs bear)
- Drawdown-triggered stability degradation

These are deferred to Phase 3I when real NSE data is available.

---

## 6. Sensitivity to Small Input Changes — Design Principle

Per spec §48:

> Measure sensitivity to small input changes.
> This is a diagnostic, not a tuning exercise.

The stability analysis produces a research report, not a parameter optimization.
The optimizer objective must not be selected because it maximizes final OOS return
after stability tuning.

---

## 7. Known Limitations

| Limitation | Notes |
|------------|-------|
| Grid perturbation only (no Monte Carlo) | Deterministic requirement (spec §39); no randomness |
| EV perturbation limited to ±10% | Configurable via `perturbation_grid` parameter |
| No cross-asset correlation perturbation | Correlation matrix perturbation deferred |
| Stability metrics not yet computed on real data | INSUFFICIENT_EVIDENCE |
