# Phase 3H — Portfolio Exposure Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Overview

This report documents the portfolio exposure diagnostics produced by the
Phase 3H portfolio optimizer and analytics layer.

---

## 2. Exposure Metrics Computed

Every `PortfolioTarget` carries an `ExposureSummary` with the following metrics:

### 2.1 Gross / Net / Cash

| Metric | Formula | Notes |
|--------|---------|-------|
| `gross_exposure` | `sum(|w_i|)` | Long-only: equals net exposure |
| `net_exposure` | `sum(w_i)` | Long-short: can be < gross |
| `long_exposure` | `sum(w_i for w_i > 0)` | |
| `short_exposure` | `sum(|w_i| for w_i < 0)` | |
| `cash_pct` | `max(0, 1 - gross_exposure)` | Uninvested fraction |

### 2.2 Risk

| Metric | Source | Notes |
|--------|--------|-------|
| `portfolio_volatility_daily` | `sqrt(w^T Σ w)` | Daily σ |
| `portfolio_volatility_annual` | daily × √252 | Annualized |
| `portfolio_cvar_95` | Historical simulation | Only if returns supplied |
| `portfolio_beta` | `sum(w_i × β_i)` | Only if beta data present |

### 2.3 Sector / Industry

| Metric | Source |
|--------|--------|
| `sector_weights` | `{sector: sum(|w_i|) for sector}` |
| `industry_weights` | `{industry: sum(|w_i|) for industry}` |
| `factor_exposures` | `{factor: sum(w_i × B_ij) for factor j}` |

### 2.4 Concentration

| Metric | Formula |
|--------|---------|
| `hhi` | `sum((|w_i| / gross)²)` — Herfindahl-Hirschman Index |
| `effective_n` | `1 / HHI` — effective number of uncorrelated bets |
| `top_1_weight` | `max(|w_i|)` |
| `top_5_weight` | `sum of top 5 |w_i|` |
| `top_10_weight` | `sum of top 10 |w_i|` |

### 2.5 Options Greeks (portfolio-level)

Only populated when portfolio contains options (`OPT_*` instrument types).

| Metric | Formula |
|--------|---------|
| `portfolio_delta` | `sum(w_i × δ_i)` |
| `portfolio_gamma` | `sum(w_i × Γ_i)` |
| `portfolio_vega` | `sum(w_i × ν_i)` |
| `portfolio_theta` | `sum(w_i × θ_i)` |

Greeks are set to `None` if the portfolio contains no options — never fabricated.

---

## 3. Concentration Diagnostics

The `PortfolioAnalytics.concentration()` method computes:

- **HHI** ∈ (0, 1]: 1/N for equal-weight → 1.0 for single-stock
- **Effective N**: `1/HHI` — equal-weight portfolio achieves `effective_N = N`
- **Sector HHI**: concentration across sectors

Verified: `TestAnalytics::test_effective_n_between_1_and_n` — equal-weight portfolio
of N stocks achieves effective_N ≈ N.

---

## 4. Benchmark-Relative Metrics

| Metric | Formula | Notes |
|--------|---------|-------|
| `active_return` | `mean(r_p - r_b) × 252` | Annualized |
| `active_volatility` | `std(r_p - r_b) × √252` | Tracking error |
| `information_ratio` | `active_return / tracking_error` | |
| `active_beta` | `Cov(r_p, r_b) / Var(r_b)` | |

All metrics report `INSUFFICIENT_EVIDENCE` when benchmark returns are not supplied.

Default benchmark: NIFTY 50 (configurable via `benchmark_version`).

---

## 5. Exposure Data Availability

| Data | Status | Source |
|------|--------|--------|
| Gross / net / long / short exposure | AVAILABLE | Computed from weights |
| Portfolio volatility (daily/annual) | AVAILABLE | Requires covariance matrix |
| CVaR 95% | AVAILABLE | Requires returns matrix |
| Portfolio beta | AVAILABLE | Requires per-candidate beta field |
| Sector weights | AVAILABLE | From `PortfolioCandidate.sector` |
| Industry weights | AVAILABLE | From `PortfolioCandidate.industry` |
| Factor exposures | DATA_UNAVAILABLE | Factor loadings not computed |
| Options Greeks | AVAILABLE for OPT_* instruments | Requires candidate delta/gamma/vega/theta |
| Benchmark-relative | DATA_UNAVAILABLE | Benchmark returns not in service |

---

## 6. F&O Exposure

For F&O portfolios, exposure is measurable in both:

- **Capital terms**: `weight × capital_inr`
- **Notional terms**: `lots × lot_size × price`

The `TargetOrder` carries:
- `quantity_lots` — integer lots
- `estimated_notional_inr` — `lots × lot_size × price`
- `liquidity_requirement_pct_adv` — estimated notional / ADV

A target weight that would require >10% ADV participation is flagged in the order.
