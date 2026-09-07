# Alpha Decay Methodology

**Document type:** ML Research — Methodology  
**Phase:** 3I  
**Last updated:** 2026-09-06  
**Scope:** Alpha decay, stability, and persistence analysis for AlphaForge

---

## 1. Overview

This document describes how AlphaForge measures whether its predictive alpha,
ranking ability, calibrated probability, expected value, and portfolio edge are
persistent, stable, and transferable through time.

The objective is not to maximise historical performance. It is to discover
**where, when, and why the alpha works or stops working.**

---

## 2. Quantities Distinguished

The framework keeps these distinct (they are different things):

| Quantity | Measured by |
|----------|-------------|
| Signal strength | mean IC / mean Rank IC |
| Signal persistence | lag-1 autocorrelation of IC |
| Signal decay | IC trend slope (linregress) |
| Feature stability | PSI / KS / Wasserstein per feature |
| Model stability | fold-to-fold prediction correlation |
| Calibration stability | Brier / ECE trend across folds |
| Regime dependency | regime-conditional IC |
| Portfolio stability | rolling Sharpe / CVaR / turnover |
| Execution/capacity decay | cost/edge ratio, ADV participation |

---

## 3. Information Coefficient (IC)

### 3.1 Definition

IC is computed **cross-sectionally per timestamp**:
- Pearson IC = correlation(scores, realized returns) within U_t
- Rank IC = Spearman correlation(scores, realized returns) within U_t

Never computed globally across time. This is inherited from Phase 3E
(`ranking.evaluation.compute_ic` / `compute_rank_ic`).

### 3.2 ICIR

ICIR = mean(IC) / std(IC) over the IC time series. Annualisation
(ICIR × √252) is applied only when documented.

### 3.3 Rolling ICIR

Over configurable windows (default 20/60/120 observations). Each window reports
mean IC, ICIR, positive IC %, and an evidence level. This exposes IC trend,
deterioration, and recovery.

---

## 4. IC Decay

### 4.1 Trend

`scipy.stats.linregress` fits a line to the IC series. A negative slope with
p < 0.05 indicates statistically significant decay.

### 4.2 Temporal split

The IC series is split into early / middle / recent thirds. Comparing recent to
early IC identifies temporal concentration (alpha that only worked in one era).

### 4.3 Half-life

An AR(1) model `IC[t] = α + β·IC[t-1] + ε` is fit. Half-life = `−log(2)/log(β)`,
valid only when 0 < β < 1 (stationary, persistent). Otherwise
`HALF_LIFE_INSUFFICIENT_EVIDENCE` is returned. Half-life is never fabricated.

### 4.4 Change-point

CUSUM (cumulative sum of deviations from the mean) detects level shifts in the
IC series. Deterministic, numpy-only. A change point is reported only when the
CUSUM range exceeds `sensitivity × std`.

---

## 5. Forward-Horizon Decay

The same signal is evaluated at multiple forward horizons (1D/3D/5D/10D/20D).
For each horizon: IC, Rank IC, hit rate, mean/median return, net return. This
reveals whether the signal peaks quickly, decays gradually, persists, reverses,
or has a delayed payoff. Different horizons are always analysed separately.

---

## 6. Quantile / Monotonicity Decay

Cross-sectional quantile buckets (default quintiles) are formed per timestamp.
The framework tracks:
- Per-quantile forward return
- Top-bottom spread (gross AND net of cost)
- Monotonicity score = Spearman(quantile rank, mean return)

Monotonicity state: MONOTONIC / WEAKENING / NON_MONOTONIC / REVERSED. A signal
can have positive IC while losing monotonicity — both are tracked.

---

## 7. Regime-Conditional Decay

Alpha IC / EV / return are stratified by the 6 market regimes
(STRONG_BULL / BULL / SIDEWAYS / VOLATILE / BEAR / CRASH). Regime transitions
(e.g. BULL → BEAR) are analysed to determine whether alpha survives, weakens, or
reverses through the transition. Sample adequacy is enforced — every regime
report includes observation count and unique-date count (spec §57).

---

## 8. Uncertainty (spec §42)

Where sample size supports it, confidence intervals should use block bootstrap
or appropriate time-series resampling — NOT naive iid bootstrap on autocorrelated
financial series. In this phase, trend p-values (linregress) provide the primary
uncertainty measure; block-bootstrap CIs are a documented future enhancement.

---

## 9. Multiple Testing (spec §43)

Many diagnostics are produced. Findings are classified exploratory vs
confirmatory. Where hypothesis testing is used, Benjamini-Hochberg FDR control
is the recommended method before treating any single significant p-value as
genuine alpha.

---

## 10. Small-Sample Protection (spec §58)

Every diagnostic has a minimum-sample policy. Below the minimum, the result is
`INSUFFICIENT_SAMPLE` / `INSUFFICIENT_EVIDENCE`, never a fabricated 0.0.

| Diagnostic | Minimum sample |
|-----------|---------------|
| IC statistic | 10 |
| Trend slope | 15 |
| Half-life | 20 |
| Change-point | 20 |

---

## 11. Limitations

- No real Indian equity/F&O dataset is loaded — all OOS numbers are
  INSUFFICIENT_EVIDENCE.
- Half-life uses AR(1) only; alternative decay models are not fitted.
- Change-point uses CUSUM only; PELT/BOCPD (`ruptures`) is not installed.
- Block-bootstrap CIs are recommended but not yet implemented.

---

## 12. References

- Grinold, R. & Kahn, R. (2000). *Active Portfolio Management* — IC, ICIR.
- Page, E.S. (1954). "Continuous Inspection Schemes." *Biometrika* — CUSUM.
- Benjamini, Y. & Hochberg, Y. (1995). "Controlling the False Discovery Rate."
  *JRSS B*.
- Lopez de Prado, M. (2018). *Advances in Financial Machine Learning* —
  backtest overfitting, purged CV.
