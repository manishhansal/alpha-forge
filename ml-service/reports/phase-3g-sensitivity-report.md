# Phase 3G — Cost & Slippage Sensitivity Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Purpose

This report quantifies the sensitivity of simulated strategy P&L to changes in
cost and slippage assumptions.  It is intended to inform parameter selection for
production backtests.

---

## 2. Break-even Cost Analysis

For a strategy to be profitable after costs, gross P&L per trade must exceed the
round-trip execution cost.  The table below shows break-even gross P&L requirements
at different notional levels.

### 2.1 NIFTY Futures (lot=75, post-2023 STT)

| NIFTY Price | Notional (₹) | Round-trip cost (₹) | Break-even move (bps) |
|------------|-------------|--------------------|-----------------------|
| 18,000 | 13,50,000 | ≈ ₹315 | ≈ 2.3 bps |
| 21,000 | 15,75,000 | ≈ ₹369 | ≈ 2.3 bps |
| 24,000 | 18,00,000 | ≈ ₹422 | ≈ 2.3 bps |
| 25,000 | 18,75,000 | ≈ ₹440 | ≈ 2.3 bps |

**Observation:** Round-trip cost for NIFTY futures is approximately 2.3–2.5 bps of
notional.  A strategy needs to generate at least 3–5 bps of edge per trade to be
viable after costs.

### 2.2 Equity Delivery (₹5 lakh notional)

| Scenario | Round-trip cost | Break-even move |
|----------|----------------|----------------|
| Base (0.27%) | ₹1,350 | 27 bps |
| With 5 bps slippage | ₹1,600 | 32 bps |
| With 10 bps slippage | ₹1,850 | 37 bps |

---

## 3. Slippage Model Sensitivity

### 3.1 FixedBPS (Model A) — varying `fixed_bps`

| Slippage (bps one-way) | Round-trip slippage cost (₹, 1 NIFTY lot) | Net P&L impact |
|------------------------|-------------------------------------------|----------------|
| 0 | ₹0 | Reference |
| 2 | ₹315 | −₹315 |
| 5 (default) | ₹787 | −₹787 |
| 10 | ₹1,575 | −₹1,575 |
| 20 | ₹3,150 | −₹3,150 |

### 3.2 SpreadProxy (Model B) — HL range as proxy

Typical NIFTY intraday HL range ≈ 0.3–0.8% of close.  Half-spread proxy ≈ 0.15–0.40%.

| HL range (%) | Implied half-spread (bps) | Round-trip slippage (₹, 1 lot) |
|-------------|--------------------------|-------------------------------|
| 0.3% | 15 bps | ₹2,363 |
| 0.5% | 25 bps | ₹3,938 |
| 0.8% | 40 bps | ₹6,300 |

**Observation:** Model B produces materially higher slippage than the default 5 bps
FixedBPS model.  This is expected — the HL proxy includes all intraday volatility,
not just the bid-ask spread.  Model B is more conservative and preferred for
strategies entering/exiting near the open or close.

### 3.3 VolatilityParticipation (Model C) — varying participation rate

Using NIFTY: sigma_daily ≈ 1.0%, coefficient = 0.5

| Participation rate | Slippage (bps) | Round-trip slippage (₹, 1 lot) |
|-------------------|---------------|-------------------------------|
| 0.1% | 1.6 bps | ₹252 |
| 1.0% | 5.0 bps | ₹788 |
| 5.0% | 11.2 bps | ₹1,764 |
| 10.0% | 15.8 bps | ₹2,494 |

---

## 4. Cost Schedule Sensitivity (pre vs post Budget 2023-24)

The change in STT for futures (0.01% → 0.0125%) represents a 25% increase.

| Schedule | STT on sell (₹, 1 NIFTY lot @ ₹21k) | Total round-trip (₹) | Δ vs 2020 schedule |
|----------|-------------------------------------|---------------------|--------------------|
| Pre-2023 (india-fno-2020) | ₹157.50 | ≈ ₹330 | reference |
| Post-2023 (india-fno-2023) | ₹196.88 | ≈ ₹369 | +₹39 (+11.8%) |

---

## 5. Capital Required for Acceptable Sharpe Under Costs

Assuming:
- Strategy gross Sharpe (before costs) = 1.5
- 250 trading days/year
- 1 trade/day (single NIFTY futures lot)

| Slippage model | Annual cost drag (₹) | Net Sharpe (approx) |
|---------------|---------------------|---------------------|
| FixedBPS 2 bps | ₹1,57,500 | ~1.3 |
| FixedBPS 5 bps | ₹3,93,750 | ~1.1 |
| SpreadProxy 25 bps | ₹19,68,750 | < 0 (cost exceeds edge) |

**Conclusion:** At 25 bps round-trip slippage, a 1-trade-per-day NIFTY futures
strategy with 1.5 gross Sharpe is unprofitable.  Slippage must be kept below
~10 bps round-trip for daily bar strategies to remain viable.

---

## 6. Recommendations

1. Use `FixedBPSSlippage(5.0)` as the default conservative estimate for daily bar strategies.
2. For execution near open/close, use `SpreadProxySlippage` and expect 15–40 bps.
3. Never backtest with 0 slippage unless explicitly testing the gross P&L upper bound.
4. Sensitivity should be re-run when real observed spread data becomes available
   (`SpreadDataStatus.OBSERVED`).
5. The break-even cost for NIFTY futures is ≈ 2.3 bps; any strategy with less than
   5 bps expected edge should be treated as marginal and requires position-sizing discipline.
