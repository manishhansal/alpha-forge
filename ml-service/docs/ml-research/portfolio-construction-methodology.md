# Portfolio Construction Methodology

**Document type:** ML Research — Methodology  
**Phase:** 3H  
**Last updated:** 2026-09-06  
**Scope:** AlphaForge portfolio construction for Indian equity and F&O markets

---

## 1. Overview

This document describes the portfolio construction methodology used in AlphaForge
Phase 3H. The portfolio layer sits between the meta-decision engine (Phase 3F) and
the execution simulator (Phase 3G).

### Input

A list of `MetaDecisionOutput` objects from Phase 3F with `decision == Decision.TAKE`.

### Output

A `PortfolioTarget` with:
- Target weights per instrument
- Explicit optimization status
- Exposure diagnostics
- Component risk breakdown
- Provenance hash for reproducibility

---

## 2. Pipeline

```
list[MetaDecisionOutput] (Phase 3F TAKE decisions)
        ↓
EligibilityFilter         → reject stale, uncalibrated, banned, expired
        ↓
RiskModel                 → covariance (Ledoit-Wolf), PSD validation
        ↓
ConstraintSet             → sector/industry/single-name/gross-net/turnover/liquidity
        ↓
SizingEngine              → EV/risk weights, fractional Kelly, vol targeting
        ↓
PortfolioOptimizer        → MIN_VARIANCE / MAX_SHARPE / CVaR / HRP / etc.
        ↓
PortfolioTarget           → weights + provenance hash
        ↓
Rebalancer                → TargetOrder list (→ Phase 3G execution)
        ↓
RiskOverlay               → drawdown / vol / regime response
```

---

## 3. Eligibility Filter

Candidates are rejected before optimization when any of the following apply:

| Reason | Enum | Description |
|--------|------|-------------|
| Stale data | `STALE_DATA` | Signal age > `max_signal_age_hours` (default 24h) |
| Stale model | `STALE_MODEL` | Model artifact stale (future use) |
| Uncalibrated probability | `UNCALIBRATED_PROBABILITY` | `probability_status != "CALIBRATED"` |
| Insufficient evidence | `INSUFFICIENT_EVIDENCE` | `EVStatus != VALID` (configurable) |
| Insufficient liquidity | `INSUFFICIENT_LIQUIDITY` | `adv_inr < min_adv_inr` |
| Invalid instrument | `INVALID_INSTRUMENT` | Price below minimum |
| Expired contract | `EXPIRED_CONTRACT` | `formation_time ≥ expiry_date` |
| F&O ban | `FNO_BANNED` | Instrument in SEBI ban list |
| Negative EV | `NEGATIVE_EV` | `expected_value ≤ min_ev_threshold` |

All checks are deterministic. No candidate is ever upgraded from INELIGIBLE to ELIGIBLE
without explicit reason.

---

## 4. Covariance Estimation

### 4.1 Default: Ledoit-Wolf analytical shrinkage

The Ledoit-Wolf (2004) analytical Oracle estimator is used by default:

```
S_LW = (1 - ρ) × S_sample + ρ × μ × I
μ = Tr(S_sample) / p
```

where ρ ∈ [0, 1] is the optimal shrinkage coefficient, computed analytically without
cross-validation. This is well-conditioned for the typical case of p ≥ 20 assets and
n ≈ 60–252 observations.

### 4.2 Why not the sample covariance?

For small samples (n < 252), the sample covariance is poorly conditioned:
- Rank-deficient when p > n
- Eigenvalues are biased (Marchenko-Pastur law)
- Portfolio optimizer concentrates on spurious low-variance combinations

### 4.3 PIT requirement

Returns must end strictly before the portfolio formation time:
```
returns_end_time ≤ formation_time
```

Violating this returns `CovarianceStatus.UNAVAILABLE` — not silently using future data.

---

## 5. Portfolio Objectives

### 5.1 MIN_VARIANCE

```
min  w^T Σ w
s.t. sum(w) = 1, w ≥ 0
```

Does not require expected returns. Preferred when return estimates are unreliable.

### 5.2 MAX_SHARPE

```
max  (w^T μ - rf) / sqrt(w^T Σ w)
s.t. sum(w) = 1, w ≥ 0
```

Requires `PortfolioCandidate.expected_return` from Phase 3F `ExpectedReturn`.
Falls back to MIN_VARIANCE if no expected returns available.

### 5.3 MAX_DIVERSIFICATION

```
max  w^T σ / sqrt(w^T Σ w)
```

where σ_i = individual asset daily volatility.
Diversification ratio = weighted-average volatility / portfolio volatility.

### 5.4 CVaR Minimization

```
min  CVaR_α(portfolio)
    = -mean(sorted(R @ w)[:floor(α × T)])
s.t. sum(w) = 1, w ≥ 0
```

Requires historical returns matrix (T × n). Falls back to MIN_VARIANCE if unavailable.

### 5.5 RISK_BUDGETING

Equal risk contribution via iterative multiplicative update (Roncalli 2013):
```
w_i ∝ target_budget_i × σ_p / (w_i × MR_i)
```

Converges to: `w_i × MR_i = target_budget_i × σ_p` for all i.

### 5.6 EV_RISK_OPTIMIZATION

```
max  sum(w_i × EV_i^power) / sqrt(w^T Σ w)
s.t. sum(w) = 1, w ≥ 0
```

Uses `PortfolioCandidate.expected_value` from Phase 3F `EVCalculator`.
Does NOT use `alpha_score` or `rank_score` as expected returns.

### 5.7 HRP (Hierarchical Risk Parity)

1. Distance matrix: `d_ij = sqrt(0.5 × (1 - ρ_ij))`
2. Single-linkage hierarchical clustering
3. Quasi-diagonalisation (leaf ordering)
4. Recursive bisection: allocate inversely proportional to cluster variance

Reference: Lopez de Prado (2016).

Does not require a matrix inversion — numerically stable for highly correlated assets.

### 5.8 Baselines

| Objective | Formula | Notes |
|-----------|---------|-------|
| EQUAL_WEIGHT | `1/N` | Reference baseline |
| INVERSE_VOL | `1/σ_i`, normalised | Simple vol scaling |
| RANK_WEIGHTED | `percentile_i / sum(percentile)` | Uses cross-sectional rank signal |

---

## 6. Position Sizing

### 6.1 EV/risk

```
raw_w_i = max(EV_i, 0)^power / max(σ_i, floor)
```

Normalised to sum = 1. Positions with EV ≤ 0 get weight = 0.

### 6.2 Fractional Kelly

```
f_i* = fractional_kelly × (p_i - (1 - p_i) / b_i)
```

where `b_i` is the win-to-stake ratio derived from `expected_value` and `calibrated_probability`.

Default: `fractional_kelly = 0.25` (¼ Kelly). Full Kelly is never the default.

`KELLY_UNAVAILABLE` is returned when probability < `min_prob` (0.52) or when the
Kelly fraction is negative (no edge).

### 6.3 Volatility targeting

```
scale = target_daily_vol / current_daily_vol
```

Scale ∈ [0, 1] — never levers up beyond the gross exposure limit.

### 6.4 Risk budgeting

Each position's risk contribution equals its configured budget:
```
w_i × MR_i = budget_i × σ_p
```

Default: equal risk contribution (risk parity).

---

## 7. Constraints

All constraints are configurable. None are hardcoded.

| Constraint | Default | Notes |
|------------|---------|-------|
| `max_position_weight` | — (unconstrained) | Set to e.g. 0.15 for 15% cap |
| `max_sector_weight` | — | Set to e.g. 0.40 |
| `max_industry_weight` | — | Distinct from sector |
| `max_gross_exposure` | 1.0 | Long-only: sum(w) = 1 |
| `max_rebalance_turnover` | 0.50 | 50% max change per rebalance |
| `max_order_pct_adv` | 0.10 | 10% ADV per order |
| `mode` | LONG_ONLY | LONG_SHORT supported |

Pre-solve feasibility check detects conflicting constraints before calling the solver.
Returns `INFEASIBLE_CONSTRAINT_SET` rather than silently relaxing.

---

## 8. Rebalancing

### 8.1 Target vs executed portfolio

`PortfolioTarget` (target) is always separate from `PortfolioState` (executed).
Phase 3G execution determines what was actually filled.

### 8.2 Rebalance policies

| Policy | Trigger |
|--------|---------|
| DAILY | Every trading session |
| WEEKLY | Every 5 trading days |
| EVENT_DRIVEN | When signal changes beyond threshold |
| SIGNAL_DRIVEN | When new TAKE decisions arrive |

### 8.3 Turnover calculation

```
turnover = sum(|target_w_i - current_w_i|)
```

Reported in `RebalanceResult.total_turnover`.

---

## 9. Failure States

| State | Meaning |
|-------|---------|
| `OPTIMIZED` | Solution found; all constraints satisfied |
| `FEASIBLE_FALLBACK` | Solver failed or data unavailable; fallback used; documented |
| `INFEASIBLE` | Post-solve constraint violation |
| `INFEASIBLE_CONSTRAINT_SET` | Constraints are jointly infeasible before solve |
| `COVARIANCE_UNAVAILABLE` | No usable covariance matrix |
| `NO_ELIGIBLE_CANDIDATES` | All candidates rejected by eligibility filter |
| `INSUFFICIENT_EVIDENCE` | Insufficient data for any decision |
| `SOLVER_ERROR` | Unexpected solver exception |

`FEASIBLE_FALLBACK` always has a non-empty `fallback_reason`. Silent fallback is forbidden.

---

## 10. Semantic Guarantees

Per spec §4:

1. `rank_score` is NEVER used as `expected_return` in the optimizer
2. `rank_score` is NEVER used as `probability`
3. `expected_value` from Phase 3F (post-cost, post-calibration) is the only permitted
   EV input to the optimizer
4. `calibrated_probability` is only used when `status == CALIBRATED`
5. Portfolio weights are derived from the optimizer, not from rank arithmetic

---

## 11. OOS Validation Principle

Per spec §49:

> Portfolio construction must be evaluated using frozen OOS model outputs.
> Do not fit optimizer parameters on final OOS.
> Do not choose portfolio objective using final OOS performance.

No objective, covariance method, or constraint was selected by maximizing OOS return
in this implementation. All defaults are based on established quantitative finance
methodology (minimum variance, Ledoit-Wolf shrinkage, ¼ Kelly).

---

## 12. References

- Ledoit, O. & Wolf, M. (2004). "A well-conditioned estimator for large-dimensional covariance matrices." *Journal of Multivariate Analysis* 88(2): 365–411.
- Chen, Y. et al. (2010). "Shrinkage Algorithms for MMSE Covariance Estimation." *IEEE Transactions on Signal Processing*.
- Lopez de Prado, M. (2016). "Building Diversified Portfolios that Outperform Out-of-Sample." *Journal of Portfolio Management* 42(4).
- Roncalli, T. (2013). *Introduction to Risk Parity and Budgeting*. Chapman & Hall/CRC.
- Kelly, J.L. (1956). "A New Interpretation of Information Rate." *Bell System Technical Journal* 35(4): 917–926.
