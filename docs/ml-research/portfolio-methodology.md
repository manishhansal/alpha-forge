# AlphaForge ML — Portfolio Construction Methodology

**Date:** 2026-09-06  
**Scope:** Portfolio construction, risk budgeting, factor models, and position sizing for Indian F&O.

---

## 1. Portfolio Construction in the Signal Chain

AlphaForge's signal chain is:
```
Features → Regime → Stock Ranking (IC per stock) → Portfolio Construction → Position Sizes → Execution
```

The portfolio construction step transforms **per-stock IC scores** into **position weights** subject to:
- Capital constraints (total weight = 1)
- Risk constraints (portfolio volatility ≤ target)
- Regulatory constraints (NSE lot sizes, F&O margin requirements)
- Liquidity constraints (weight ≤ k × ADV)
- Sector concentration limits

Currently AlphaForge maps stock ranks directly to weights without a disciplined portfolio construction framework.

---

## 2. The Grinold-Kahn Framework for Indian F&O

### 2.1 The Fundamental Law Applied to Portfolio Construction

```
IR = IC × √BR × TC
```

For AlphaForge with:
- IC = 0.04 (hypothetical, unverified OOS IC of ranker)
- BR = 50 stocks × 252 days = 12,600 independent bets/year
- TC = 0.65 (transfer coefficient under long-only + lot size constraints)

```
IR = 0.04 × √12,600 × 0.65 ≈ 2.9
```

This is an optimistic upper bound. In practice, correlations between stocks reduce effective BR. The cross-sectional momentum factor in India has high within-sector correlation — effective BR for a purely momentum-based ranker may be closer to 500-1,000.

### 2.2 Separating Alpha from Risk

The standard mean-variance framework:
```
max_w: α'w - λ × w'Σw
subject to: Σw_i = 1, w_i ≥ 0 (long-only)
```
Where:
- `α`: per-stock alpha forecasts (IC-scaled expected returns)
- `Σ`: covariance matrix of returns
- `λ`: risk aversion parameter (typically 1/(2 × target_volatility²))

The **critical insight**: using the same model's predictions for both α (the signal) and Σ (the risk model) creates a circular dependency. The covariance structure should be estimated independently from the alpha signal.

**Recommended structure for AlphaForge:**
- Alpha model: StockRanker score → expected relative return per stock
- Risk model: Independent covariance estimation via factor model or historical covariance
- Portfolio optimizer: Combines alpha and risk to produce optimal weights

### 2.3 Factor Risk Models for Indian Equities

A factor risk model decomposes stock return variance into:
```
σ²_stock = Σ_k β²_k σ²_factor_k + σ²_idiosyncratic
```

Standard factors for Indian F&O universe:
1. **Nifty 50 beta** — market exposure (captures systematic risk)
2. **BankNifty beta** — banking sector exposure
3. **Size factor** — large vs mid cap (market cap)
4. **Momentum factor** — 12-month trailing return
5. **Volatility factor** — 1-month realised volatility
6. **Value factor** — P/B ratio (requires fundamental data)

A 5-6 factor model typically explains 40-60% of stock variance in Indian equity markets, leaving 40-60% as idiosyncratic risk — the primary target for stock-selection alpha.

**Implementation:** Use `sklearn.linear_model.Ridge` to estimate factor loadings (betas) from rolling 63-day windows of returns regressed on factor returns. This is significantly simpler to implement than Riskfolio-Lib's full covariance matrix.

---

## 3. Portfolio Optimization Methods

### 3.1 Current Approach: Riskfolio-Lib HRP and CVaR

AlphaForge uses Riskfolio-Lib for HRP and CVaR allocation. These methods are appropriate for Indian F&O portfolios but have the following limitations as currently implemented:
- No transaction cost penalisation in the objective
- No ADV-based liquidity constraint
- No lot-size rounding
- Not sklearn-compatible (cannot be cross-validated with standard tools)

### 3.2 Hierarchical Risk Parity (HRP) — Recommended for Indian F&O

HRP is the recommended default allocation method for Indian F&O for three reasons:
1. It does not require inverting the covariance matrix — numerically stable even with 50 correlated stocks
2. It is more robust to estimation error than MVO — Indian equity returns have heavy tails
3. It naturally diversifies across hierarchical clusters — which aligns with the sector structure of F&O stocks

**Improvement from default HRP:**
```python
# Current: Pearson correlation codependence
port.optimization(model="HRP", codependence="pearson")

# Better for fat-tailed Indian equity returns:
port.optimization(model="HRP", codependence="tail")  # Lower tail dependence
# or
port.optimization(model="HRP", codependence="spearman")  # Rank correlation
```

Spearman correlation is more robust to outliers (circuit-breaker days, expiry squeezes) than Pearson.

### 3.3 Skfolio as a Better Alternative to Riskfolio-Lib

`skfolio` is a sklearn-compatible portfolio optimization library that offers several advantages:

1. **Online walk-forward portfolio CV:** Tune portfolio hyperparameters (risk aversion, constraints) on OOS data
2. **MeanRisk, HRP, CVaR, MaxDiversification** all in one sklearn estimator
3. **Pipeline compatibility:** `Pipeline([('feature', StandardScaler()), ('portfolio', MeanCVaR())])` can be cross-validated with `WalkForwardCV`
4. **Factor risk models:** Built-in factor exposure estimation

**Recommended migration path:**
```python
# Replace Riskfolio-Lib with skfolio for better integration
from skfolio import MeanRisk, HierarchicalRiskParity
from skfolio.optimization import HierarchicalRiskParity

model = HierarchicalRiskParity(
    risk_measure="CVaR",
    covariance_estimator=None,  # will use default shrinkage estimator
)
model.fit(returns_train)
weights = model.weights_
```

### 3.4 Black-Litterman for Expressing Alpha Views

The Black-Litterman model combines:
- A **prior** (market-cap weighted equilibrium returns)
- **Views** from the ML alpha signal

This is more principled than directly using ML predictions as expected returns, because:
- It blends the signal with a prior, preventing extreme positions when signal confidence is low
- The confidence of each view is calibrated to the model's OOS IC

**Formula:**
```
E[R] = [(τΣ)^{-1} + P'Ω^{-1}P]^{-1} × [(τΣ)^{-1}Π + P'Ω^{-1}Q]
```
Where:
- Π: equilibrium returns (CAPM)
- Q: ML model's view on expected returns
- Ω: uncertainty of views (1 / IC² × var(return))
- P: view portfolio (which stocks the model is expressing views on)

**Application to AlphaForge:** The StockRanker score → Black-Litterman view with uncertainty inversely proportional to OOS IC. This naturally reduces position sizes when model confidence is low.

---

## 4. Risk Budgeting

### 4.1 Carver's Volatility Targeting

From Robert Carver's *Systematic Trading*:

```python
def carver_position_size(
    signal,           # [-1, 1] — direction × confidence
    instrument_vol,   # annualised daily vol
    target_vol,       # portfolio target vol (e.g., 0.25 = 25% p.a.)
    capital,          # total portfolio capital
    price,            # current price
    fx_rate=1.0,      # currency conversion
) -> float:
    """Carver's volatility-adjusted position sizing."""
    # Vol-adjusted position
    vol_scalar = target_vol / instrument_vol
    # Capital allocation
    notional = capital * vol_scalar * abs(signal)
    # Contract quantity
    position = notional / (price * fx_rate)
    return position * sign(signal)
```

This formulation ensures:
- Higher-volatility instruments get smaller positions (not larger ones)
- The portfolio's aggregate volatility approximately equals `target_vol`
- Position sizes are comparable across instruments

### 4.2 Forecast Diversification Multiplier (FDM)

When combining multiple signals, the combined signal's variance is less than the sum of individual variances (due to correlation < 1). The FDM scales up positions to compensate:

```python
def forecast_diversification_multiplier(forecasts, weights):
    """
    Compute FDM to maintain target volatility when combining signals.
    forecasts: (n_stocks, n_signals) array of normalised signal values [-1,1]
    weights: (n_signals,) ensemble weights
    """
    # Covariance matrix of forecasts
    forecast_cov = np.cov(forecasts.T)
    # Portfolio variance of weighted forecasts
    weighted_var = weights @ forecast_cov @ weights
    # FDM = target_std / combined_std
    fdm = 1.0 / np.sqrt(weighted_var)
    return np.clip(fdm, 1.0, 2.5)  # cap at 2.5x
```

**AlphaForge gap:** The `EnsembleWeighter` produces a weighted score but does not compute the FDM. In low-disagreement regimes (all models agree), the combined score has lower variance — positions should be scaled up. In high-disagreement regimes, positions should be scaled down. Currently the system uses a fixed mapping from ensemble score to position size.

### 4.3 Risk Parity vs Alpha-Weighted Allocation

Two philosophies for portfolio allocation in Indian F&O:

**Risk parity:** Allocate capital such that each stock contributes equally to portfolio risk. Ignores alpha entirely. Best when you do not believe in stock-selection alpha.

**Alpha-weighted (Carver's approach):** Scale position size by the signal strength (forecast). The signal is the primary driver; risk is managed through volatility targeting.

**Recommendation for AlphaForge:** Use alpha-weighted sizing (Carver's framework) given that the purpose of the system is stock selection. Risk parity is appropriate for strategic asset allocation, not for a tactical F&O signal system.

---

## 5. Constraints for Indian F&O Portfolios

### 5.1 NSE Lot Size Constraints

F&O positions must be in multiples of lot sizes. This creates a discrete allocation problem:

```python
LOT_SIZES = {
    "NIFTY": 50, "BANKNIFTY": 15, "HDFCBANK": 550,
    "RELIANCE": 250, "TCS": 150, "INFY": 300,
    # ...
}

def round_to_lots(continuous_weight, symbol, capital, price):
    notional = continuous_weight * capital
    lots_fractional = notional / (LOT_SIZES[symbol] * price)
    lots = round(lots_fractional)  # nearest lot
    return lots * LOT_SIZES[symbol] * price / capital  # actual weight
```

For small portfolios (< ₹5 lakh), lot-size rounding can cause significant allocation distortions. A position of 1.5% in HDFCBANK (550 lot) at ₹1,600 price requires ₹8.8 lakh per lot — more than 17% of a ₹5L portfolio. This means many F&O positions are effectively binary (0 or 1 lot) for retail-sized portfolios.

**This constraint fundamentally changes the portfolio construction problem** for small capital: the continuous optimizer's output is often infeasible, and the effective portfolio is much more concentrated than the weights suggest.

### 5.2 F&O Margin Requirements

SPAN + Exposure margin requirements change daily based on VIX and position concentration. High-VIX periods require significantly more margin, reducing capital available for positions.

**Implementation:** Add a `margin_utilization` constraint:
```
total_margin / capital ≤ 0.70   # leave 30% as buffer
```

Margin changes with VIX should trigger automatic position reduction via the `vix_regime` feature.

### 5.3 Sector Concentration Limits

The default AlphaForge `max_sector_weight = 0.40` is reasonable. However, the NSE F&O universe is heavily overweight in Financials (~40% of index weight) and IT (~15%). Without explicit sector caps, the portfolio will naturally concentrate in these sectors.

**Recommended sector limits for Indian F&O:**
```python
SECTOR_LIMITS = {
    "Financials":    0.30,   # Cap below natural weight
    "IT":            0.20,
    "Energy":        0.15,
    "Healthcare":    0.20,
    "Consumer":      0.20,
    "Industrials":   0.25,
    "Materials":     0.15,
}
```

### 5.4 Maximum Position Size

In Indian F&O, SEBI's Market-Wide Position Limits (MWPL) cap total OI in any single F&O stock at a % of deliverable supply. Individual trader limits are a fraction of MWPL. A practical position cap:

```
max_single_position_pct = min(
    0.15,                           # 15% of portfolio
    mwpl_remaining_pct × 0.05      # 5% of available MWPL
)
```

---

## 6. Portfolio Performance Attribution

### 6.1 Brinson-Hood-Beebower Attribution

For a stock-selection strategy against the Nifty 50 benchmark:
```
Total active return = Allocation effect + Selection effect + Interaction effect

Allocation effect: w_portfolio_sector - w_benchmark_sector × r_benchmark_sector
Selection effect:  w_benchmark_sector × (r_portfolio_sector - r_benchmark_sector)
```

**AlphaForge should implement:** Monthly attribution of portfolio returns to:
1. Regime call accuracy (did the regime model correctly call bull/bear?)
2. Stock selection within regime (did the ranker pick outperformers?)
3. Strategy selection (did the strategy selector choose the right approach?)
4. Risk management (did the risk predictor correctly size down high-risk trades?)

This attribution separates genuine alpha generation from accidental performance.

### 6.2 IC Consistency Check

Compute rolling 21-day IC for the stock ranker. Plot the IC time series. Key diagnostic signals:
- If IC is consistently positive: the model has genuine predictive power
- If IC is noisy around zero: the model has no edge; it is producing noise
- If IC is positive in one regime and negative in another: the model is a regime indicator, not a stock selector

**Target:** Rolling IC > 0.02 in ≥ 70% of 21-day windows.

---

## 7. Portfolio Construction Roadmap for AlphaForge

| Phase | What to implement | Expected improvement |
|---|---|---|
| Immediate | Add lot-size rounding to PortfolioOptimizer | Feasible positions |
| Immediate | Add ADV-based liquidity constraint | Reduce impact costs |
| Short-term | Add turnover penalty to HRP objective | Reduce unnecessary trading |
| Short-term | Replace Pearson with Spearman/tail codependence | Better handling of fat tails |
| Medium-term | Migrate to skfolio for sklearn-compatible CV | Walk-forward portfolio tuning |
| Medium-term | Implement Carver's volatility targeting | Consistent risk per position |
| Medium-term | Add FDM to ensemble score scaling | Correct signal variance calibration |
| Long-term | Implement Black-Litterman with ML views | Principled alpha/prior blending |
| Long-term | Build factor risk model (5 India factors) | Separate alpha from risk |
| Long-term | Implement Brinson attribution | Performance decomposition |
