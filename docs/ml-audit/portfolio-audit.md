# AlphaForge ML Service — Portfolio Audit

**Audit Date:** 2026-09-06  
**Scope:** `models/portfolio_optimizer.py`

---

## 1. Component Overview

`PortfolioOptimizer` wraps Riskfolio-Lib to provide:

| Method | Algorithm | Endpoint | Status |
|---|---|---|---|
| `hrp_allocation()` | Hierarchical Risk Parity | `/predict/portfolio-v2` | FUNCTIONAL |
| `cvar_allocation()` | CVaR-minimised MVO | `/predict/portfolio-v2` | FUNCTIONAL |
| `max_diversification_allocation()` | Maximum Diversification | `/predict/portfolio-v2` | FUNCTIONAL |
| `factor_allocation()` | Beta-neutral factor model | `/predict/portfolio-v2` | FUNCTIONAL |
| `optimize()` (legacy) | Rule-based heuristic | `/predict/portfolio` | KEEP (backward-compat) |

---

## 2. HRP Allocation

### 2.1 Implementation
```python
port = rp.HCPortfolio(returns=returns)
w_df = port.optimization(
    model="HRP",
    codependence="pearson",
    rm="MV",
    rf=DAILY_RF,
)
```

**Riskfolio-Lib 6.x API:** `HCPortfolio` with `model="HRP"` is the correct 6.x interface. Uses Pearson correlation for codependence and minimum variance risk measure.

**Assessment:** HRP is a robust, estimation-error-tolerant allocation method. Unlike MVO, HRP does not require inverting the covariance matrix — it is numerically stable even with limited history or correlated assets (common in Indian F&O).

### 2.2 Statistical Assumptions
- Pearson correlation is appropriate for roughly linear, symmetric return distributions
- F&O stocks exhibit fat tails and non-normal returns — Pearson may underestimate tail correlation
- Consider `codependence="tail"` (lower tail dependence) for F&O portfolios

### 2.3 Risk-Free Rate
`DAILY_RF = 0.071 / 252`

Comment says "Indian 10-yr G-Sec ~7.1% p.a." Current 10-yr G-Sec yield is closer to 7.0-7.2%, so this is approximately correct. However, the RBI repo rate (currently ~6.5%) is a more appropriate risk-free rate for short-term equity trades.

---

## 3. CVaR Allocation

### 3.1 Design
CVaR minimisation at `alpha=0.05` — minimises the expected loss in the worst 5% of scenarios. More tail-risk-sensitive than standard variance minimisation.

**Appropriateness:** CVaR is theoretically superior to variance for fat-tailed return distributions. For Indian F&O portfolios with significant tail risk (expiry squeezes, circuit breakers), this is a better objective than MVO.

**Implementation note:** CVaR MVO requires a sufficiently long returns history to accurately estimate tail quantiles. With fewer than ~252 observations per asset, CVaR estimates will be noisy.

---

## 4. Legacy `optimize()` Method

The legacy method in `PortfolioOptimizer.optimize()` is a heuristic allocation:
- Filters assets by expected_return > 0 and risk_score < threshold
- Groups by sector to enforce sector weight cap
- Assigns weights proportional to `rank_score / risk_score`
- Applies `max_sector_weight` constraint

**This is not a portfolio optimisation** in the mathematical sense — it has no covariance structure, no diversification objective, and no risk budget constraint. It is a simple scoring-based allocation.

It is preserved for backward compatibility with the existing `/predict/portfolio` endpoint. This is acceptable as long as:
1. The new endpoint (`/predict/portfolio-v2`) uses the proper Riskfolio-Lib methods
2. The legacy endpoint is clearly documented as heuristic-based

---

## 5. Data Inputs and Requirements

### 5.1 Returns DataFrame
Both HRP and CVaR require a `returns: pd.DataFrame` (rows = dates, cols = symbols). The returns must be:
- **Sufficient length:** HRP needs at least ~60 observations (3 months daily). CVaR needs ~252+ for reliable tail estimates.
- **Point-in-time:** Returns must not include future data. Since the portfolio optimizer is called at inference time with historical data, this is inherently satisfied.
- **Adjusted:** Returns from unadjusted prices will show artificial gaps at split/bonus dates. Corporate action adjustment is not verified (see Data Audit).

### 5.2 What Is NOT Passed
- Transaction costs: The portfolio optimizer receives a returns matrix but no cost estimates. Portfolio turnover is not penalised. The optimiser may recommend high-turnover allocations that are suboptimal net of costs.
- Liquidity constraints: No position sizing relative to average daily volume (ADV). In Indian F&O, a MIDCAP stock may have insufficient liquidity to absorb a 10% portfolio weight.
- Lot size constraints: NSE F&O trades in fixed lot sizes. Continuous portfolio weights cannot be translated directly to tradeable quantities without rounding to lot boundaries.

---

## 6. Integration with ML Pipeline

The portfolio optimizer sits downstream of the stock ranker:
1. StockRanker produces `score (0-100)` per stock
2. Top-N stocks by score are selected as portfolio candidates
3. PortfolioOptimizer allocates weights among those candidates

**Gap:** There is no documented integration code connecting step 2 to step 3. The `/predict/portfolio-v2` endpoint presumably receives a pre-filtered list of symbols + their returns, but the selection criterion (how many stocks, score threshold) is not standardised.

---

## 7. Risk Metrics Computation

After allocation, `hrp_allocation()` computes:
```python
portfolio_returns = (returns * weights_series).sum(axis=1)
risk_metrics = {
    "volatility": float(portfolio_returns.std() * np.sqrt(252)),
    "cvar": ...,  # at alpha=0.05
    "sharpe": ...,
    "max_dd": ...,
}
```

**Assessment:** Standard computations. The annualisation uses `√252` (trading days) — correct for daily returns.

**Sharpe ratio numerator:** `mean_return - DAILY_RF` — the risk-free rate is correctly subtracted before dividing by volatility.

---

## 8. Survivorship Bias in Portfolio Backtests

If this portfolio optimizer is ever used in backtesting mode (rebalancing historically over a long period), the same survivorship bias affecting the training universe applies here: today's F&O universe does not represent the universe available at each historical rebalancing date.

---

## 9. Assessment

| Aspect | Status | Notes |
|---|---|---|
| HRP algorithm | ✅ Correct | Riskfolio-Lib 6.x API |
| CVaR algorithm | ✅ Correct | Appropriate for fat-tailed returns |
| Risk-free rate | ⚠️ Minor | 7.1% vs 6.5% RBI repo; small Sharpe bias |
| Transaction costs | ❌ Missing | High-turnover allocations not penalised |
| Liquidity constraints | ❌ Missing | No ADV-based position size caps |
| Lot size constraints | ❌ Missing | Continuous weights not reconciled to lots |
| Corporate action adjustment | ❌ Unknown | Inherits data layer risk |
| Legacy optimize() | ⚠️ Heuristic | Preserved for backward compat; not quantitative |

---

## 10. Recommendations

| Priority | Action |
|---|---|
| 🟡 MEDIUM | Add transaction cost penalty to portfolio optimisation (turnover multiplied by round-trip cost) |
| 🟡 MEDIUM | Add ADV-based liquidity constraints: `weight ≤ k × ADV / portfolio_value` |
| 🟡 MEDIUM | Add lot-size reconciliation layer: round continuous weights to nearest NSE F&O lot |
| 🟡 MEDIUM | Use `codependence="tail"` or `"spearman"` for HRP on F&O portfolios |
| 🟡 MEDIUM | Enforce minimum returns history (252 bars) before allowing CVaR optimisation |
| 🟢 LOW | Update `DAILY_RF` to RBI repo rate (6.5%) or make configurable |
| 🟢 LOW | Document the heuristic nature of the legacy `optimize()` method at the API level |
