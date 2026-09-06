# Phase 3H — Risk Model Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Overview

This report documents the portfolio risk model implemented in `src/portfolio/risk_model.py`.

All covariance estimates are derived from historical return observations.
Synthetic correlation is never used on the production research path.

---

## 2. Covariance Methods

| Method | Enum | Description |
|--------|------|-------------|
| Historical sample | `HISTORICAL` | `np.cov(R, rowvar=False, ddof=1)` — unbiased sample covariance |
| EWMA | `EWMA` | Exponentially weighted; default λ=0.94 (RiskMetrics) |
| Ledoit-Wolf | `LEDOIT_WOLF` | Analytical Oracle shrinkage toward scaled identity; pure numpy |
| OAS | `OAS` | Oracle Approximating Shrinkage (Chen et al. 2010); pure numpy |

**Default:** `LEDOIT_WOLF` — best-in-class covariance shrinkage for small samples.

---

## 3. Ledoit-Wolf Implementation

The analytical Ledoit-Wolf estimator (Ledoit & Wolf 2004) is implemented in pure numpy
without sklearn dependency (which is broken on Python 3.14 due to joblib/cloudpickle chain).

Formula:
```
S_LW = (1 - ρ) × S + ρ × μ × I
μ = Tr(S) / p     (target: scaled identity)
ρ = min(1, max(0, numer / denom))
numer = ((n-2)/n) × Tr(S²) + Tr(S)²
denom = (n+2) × (Tr(S²) - Tr(S)²/p)
```

Shrinkage coefficient ρ ∈ [0, 1] is validated in `TestRiskModel::test_ledoit_wolf_shrinkage_coefficient_in_0_1`.

---

## 4. Covariance Quality Checks

Every `CovarianceResult` records:

| Check | Action |
|-------|--------|
| Symmetry | Enforced: `cov = (cov + cov.T) / 2` |
| PSD | Eigenvalue floor at `1e-8`; repair documented in `psd_repair_applied`, `min_pre_eigenvalue`, `min_post_eigenvalue` |
| Condition number | Computed; `ILL_CONDITIONED` if > `1e6` |
| Missingness | `MISSINGNESS` status if > 10% missing return observations |
| Sample size | `INSUFFICIENT_SAMPLE` if < 60 observations (configurable) |
| PIT violation | `UNAVAILABLE` if `returns_end_time > formation_time` |

---

## 5. PSD Repair Documentation

When the covariance matrix has negative eigenvalues, `_ensure_psd()` applies an eigenvalue floor:

```
eigenvalues_repaired = max(eigenvalues, 1e-8)
cov_repaired = V × diag(eigenvalues_repaired) × V^T
```

The repair is **always documented**:
- `psd_repair_applied = True`
- `min_pre_eigenvalue` = smallest eigenvalue before repair
- `min_post_eigenvalue` = smallest eigenvalue after repair (≥ 1e-8)
- `projection_method = "eigenvalue_floor"`

A silently-repaired matrix that is not documented would violate the covariance quality
contract (spec §10).

---

## 6. Risk Decomposition

### 6.1 Portfolio variance

```
σ²_p = w^T Σ w
```

### 6.2 Marginal risk

```
MR_i = (Σw)_i / σ_p
```

### 6.3 Component risk (Euler decomposition)

```
CR_i = w_i × MR_i
∑ CR_i = σ_p   (exactly, by homogeneity of degree 1)
```

Verified in `TestRiskModel::test_component_risk_sums_to_portfolio_risk`:
`|∑ CR_i - σ_p| < 1e-10`.

### 6.4 Historical CVaR

```
CVaR(α) = -mean(sorted_portfolio_returns[:k])
k = floor(α × T)
```

Returns the **positive** CVaR (loss magnitude). Verified positive in
`TestRiskModel::test_historical_cvar_is_positive`.

---

## 7. EWMA Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ewma_lambda` | 0.94 | RiskMetrics standard λ; older observations decay geometrically |
| Effective sample | ~14 obs (λ=0.94) | Half-life ≈ 11 days |

For longer-term portfolio construction (daily bars, 20-bar horizon), Ledoit-Wolf is
preferred over EWMA since EWMA overweights recent volatility spikes.

---

## 8. Configuration

| Parameter | Default | Notes |
|-----------|---------|-------|
| `method` | `LEDOIT_WOLF` | Best for small-sample conditions |
| `min_observations` | 60 | ~3 months of daily data |
| `max_condition_number` | 1e6 | Warn above this |
| `psd_floor` | 1e-8 | Eigenvalue floor for PSD repair |
| `ewma_lambda` | 0.94 | Only used when `method=EWMA` |
| `annualisation_factor` | 252.0 | Trading days per year |
| `max_missingness_pct` | 10% | Reject if more NaN |

---

## 9. Known Limitations

| Limitation | Severity | Mitigation |
|------------|----------|-----------|
| Historical returns not available in service | HIGH | Returns must be supplied by caller; `COVARIANCE_UNAVAILABLE` returned otherwise |
| No factor model covariance (BARRA-style) | MEDIUM | Factor matrix architecture exists in `ConstraintSet.factor_limits`; full factor covariance deferred |
| No intraday realized volatility | LOW | Daily bar model; acceptable for 20-bar horizon strategies |
| Constant-correlation shrinkage not implemented | LOW | LW and OAS are superior for typical n/p ratios |
