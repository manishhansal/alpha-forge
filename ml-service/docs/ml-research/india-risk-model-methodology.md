# India Risk Model Methodology

**Document type:** ML Research — Methodology  
**Phase:** 3H  
**Last updated:** 2026-09-06  
**Scope:** India-specific risk model considerations for NSE equity and F&O portfolios

---

## 1. Overview

This document describes India-specific considerations for the Phase 3H portfolio
risk model, including NSE market structure, F&O-specific risk factors, and
limitations of the current risk model for Indian markets.

---

## 2. India Market Structure Considerations

### 2.1 NSE trading hours

NSE equity and F&O market: 09:15 – 15:30 IST (Monday–Friday, excluding holidays).

Pre-open session: 09:00–09:15 (price discovery).

The risk model uses **daily bar returns** — intraday microstructure is not modelled.

### 2.2 Settlement

| Segment | Settlement |
|---------|-----------|
| NSE CM (equity) | T+2 rolling settlement |
| NSE F&O | Daily MTM + final settlement on expiry |

For portfolio construction, daily bar returns are computed from closing prices.
No adjustment for intraday settlement calls.

### 2.3 Return measurement

Daily return: `r_t = close_t / close_{t-1} - 1`

For F&O: returns should be computed on the futures close price (front-month),
adjusted for roll at expiry. **No automatic roll adjustment is currently implemented.**
Roll adjustment is DATA_UNAVAILABLE until `CorporateActionStore` is populated.

---

## 3. NSE F&O Risk Factors

### 3.1 Expiry-driven volatility

NSE weekly and monthly expiry creates systematic volatility spikes, particularly:
- Last Thursday of month (monthly expiry)
- Every Thursday (NIFTY/BANKNIFTY weekly expiry)

The risk model does not yet explicitly model expiry-driven volatility. When using
EWMA covariance, recent expiry weeks will be over-weighted.

**Recommendation:** Use Ledoit-Wolf (less sensitive to recent spikes) near expiry.

### 3.2 India VIX

India VIX (NSE volatility index) is a forward-looking risk indicator.
Currently not integrated into the covariance model. Future enhancement: use
India VIX as a regime signal for the risk overlay.

### 3.3 STT impact on returns

Securities Transaction Tax (STT) is charged on the sell side for futures.
Post-Budget 2023-24: STT = 0.0125% of futures turnover on sell.

For return measurement from market prices, STT is not yet stripped from returns.
Net returns to the portfolio are therefore slightly overstated in historical analysis.

---

## 4. India-Specific Risk Factors

### 4.1 Factor architecture

The `ConstraintSet.factor_limits` supports factor constraints of the form:
```
{factor_name: (min_exposure, max_exposure)}
```

The following India-relevant factors are architecturally supported:

| Factor | Description | Data Status |
|--------|-------------|-------------|
| market | Beta to NIFTY 50 | Requires per-stock beta series |
| size | Market cap relative to universe | DATA_UNAVAILABLE |
| value | P/B or E/P ratio | DATA_UNAVAILABLE |
| momentum | 12-1 month return | Computable from price data |
| quality | ROE / accruals | DATA_UNAVAILABLE |
| volatility | Realized vol relative | Computable from price data |
| liquidity | ADV relative to universe | DATA_UNAVAILABLE |

**Factor exposures are currently DATA_UNAVAILABLE** — the factor loading matrix B
(assets × factors) is not populated. When available, factor constraints can be
enforced via `ConstraintSet.factor_limits`.

### 4.2 Sector classification

NSE uses GICS sector classification. Sectors relevant to Indian equity:
- Financials (Bank, NBFC, Insurance)
- IT Services
- Energy (Oil & Gas, Utilities)
- Consumer (Staples, Discretionary)
- Healthcare
- Materials (Metals, Chemicals)
- Industrials
- Telecom

The `PortfolioCandidate.sector` field should use a consistent classification scheme.
Currently DATA_UNAVAILABLE from instrument master.

### 4.3 India beta considerations

Beta to NIFTY 50 is the primary market risk measure for Indian equities.
For F&O portfolios:
- **Futures beta ≈ 1.0 for index futures** (NIFTY, BANKNIFTY)
- **Single-stock futures beta** varies; use 1-year OLS beta

High-beta periods in India often correlate with global risk-off events
(FII outflows, RBI policy, INR depreciation).

---

## 5. Benchmark

The default benchmark for portfolio risk analysis is **NIFTY 50**.

| Parameter | Value |
|-----------|-------|
| Default benchmark | NIFTY 50 index |
| Benchmark version | `NIFTY50-v1` |
| Benchmark data status | DATA_UNAVAILABLE (not in service) |
| Configurable | Yes — via `benchmark_version` |

Benchmark returns must be supplied by the caller for benchmark-relative metrics.
If not supplied, all benchmark-relative metrics return `INSUFFICIENT_EVIDENCE`.

---

## 6. Risk Overlay — India-Specific Thresholds

The `RiskOverlay` uses configurable thresholds. The following are **suggested starting
points** for Indian equity F&O strategies. They are NOT hardcoded.

| Trigger | Suggested threshold | Rationale |
|---------|---------------------|-----------|
| Drawdown → REDUCE_RISK | 5% | Indian markets can recover quickly |
| Drawdown → HALT | 10% | Typical strategy stop-loss zone |
| Drawdown → EXIT | 20% | Catastrophic drawdown |
| Vol spike → REDUCE | 30% ann | Above typical NIFTY vol range |
| Vol spike → HALT | 50% ann | India VIX spike territory |
| Regime → REDUCE | high_volatility, risk_off | |

These thresholds should be calibrated per strategy using historical regime analysis.

---

## 7. Lot Size and Notional Risk

For F&O portfolios, the minimum trade size is one lot. This creates discretisation
risk in position sizing.

| Index | Post-Nov 2024 Lot | ₹21,000 price | Notional/lot |
|-------|------------------|---------------|-------------|
| NIFTY 50 | 75 | ₹21,000 | ₹15,75,000 |
| BANKNIFTY | 30 | ₹48,000 | ₹14,40,000 |
| FINNIFTY | 65 | ₹22,000 | ₹14,30,000 |
| MIDCPNIFTY | 120 | ₹10,000 | ₹12,00,000 |

With ₹10,00,000 capital and target allocation of 20% to NIFTY:
- Target notional = ₹2,00,000
- 1 NIFTY lot = ₹15,75,000 → **0 lots** (cannot execute)

This is correctly handled by `SizingEngine.compute()` which returns `lots=0` when
`capital × weight < one_lot_notional`.

Minimum viable capital for a 10-position NIFTY-futures portfolio:
```
≈ 10 × ₹15,75,000 / 0.20 (per-position limit) = ₹7,87,50,000 (~₹8 Cr)
```

---

## 8. Corporate Actions

Corporate actions (splits, bonuses, dividends) affect historical return calculations.
Unadjusted returns may contain artificial jumps that inflate or deflate estimated
volatility and correlation.

**Current status:** `CorporateActionStore.VERSION = "DATA_UNAVAILABLE"`.

Unadjusted returns are used for covariance estimation in the current implementation.
This is a known limitation documented in the audit report.

When `CorporateActionStore` is populated, the risk model should use
adjusted prices to compute returns.

---

## 9. Limitations

| Limitation | Impact | Mitigation |
|------------|--------|-----------|
| No factor model covariance | Factor risk not captured | Architecture in place; data needed |
| No India VIX integration | Vol regime signal absent | Can be added to RiskOverlay |
| No expiry-week vol adjustment | EWMA overweights expiry vol | Use LW near expiry |
| No corporate action adjustment | Historical vol may be biased | CorporateActionStore to be populated |
| Benchmark returns DATA_UNAVAILABLE | No active return / IR | Must supply NIFTY 50 returns |
| F&O ban list DATA_UNAVAILABLE | Ban detection best-effort | FnOStateStore to be populated |
| Minimum lot size constraint | Discretisation in small portfolios | Use larger capital or fewer positions |

---

## 10. Recommended Configuration for NSE F&O Strategies

Based on the methodology and India market structure:

```python
from src.portfolio.risk_model import RiskModelConfig
from src.portfolio.schemas import CovarianceMethod, ConstraintSet

# Risk model
risk_config = RiskModelConfig(
    method=CovarianceMethod.LEDOIT_WOLF,
    min_observations=63,    # ~3 months
    annualisation_factor=252.0,
)

# Constraints (indicative — calibrate per strategy)
constraints = ConstraintSet(
    max_position_weight=0.20,    # 20% per position
    max_sector_weight=0.40,      # 40% per sector
    max_gross_exposure=1.0,
    max_rebalance_turnover=0.50,
    max_order_pct_adv=0.10,
    max_positions=10,
)
```

These parameters should be validated on real NSE data when available.
