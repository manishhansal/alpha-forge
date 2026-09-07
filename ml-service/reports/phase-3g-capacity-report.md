# Phase 3G — Capacity & Liquidity Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Purpose

This report documents how the Phase 3G execution engine models market capacity and
liquidity constraints.  It captures the assumptions, parameters, and limitations of
the participation-rate model used in the backtester.

---

## 2. Participation Rate Model

The fill engine enforces a maximum participation cap to prevent unrealistic fills
in thinly-traded instruments.

### 2.1 Parameters

| Parameter | Default | Configurable via |
|-----------|---------|-----------------|
| `max_participation_pct` | 10% of ADV | `BacktestConfig.max_participation_pct` |
| ADV unit | `OHLCBar.adv_inr` (₹ average daily value) | Per bar |

### 2.2 Fill logic (`fill_engine.py:356`)

```
max_notional = bar.adv_inr × max_participation_pct
if order_notional > max_notional:
    filled_lots = floor(max_notional / (lot_size × fill_price))
    if filled_lots == 0:
        return FillStatus.UNAVAILABLE
    else:
        return SimulatedFill(status=PARTIAL, quantity_lots=filled_lots)
```

- A partial fill returns `FillStatus.PARTIAL` with actual filled lots — it is never
  silently upgraded to FULL.
- If the entire order cannot fill even 1 lot, `FillStatus.UNAVAILABLE` is returned.
  The backtest does not force an execution.

---

## 3. Capacity Constraints by Instrument Tier

The following is a reference table based on typical NSE ADV figures (not live data).
The backtest uses whatever `adv_inr` is supplied in the price bars.

| Instrument | Typical ADV (₹ Cr) | Max 10% participation (₹ Cr) | Max NIFTY lots (75 × ₹21k) |
|------------|-------------------|-----------------------------|-----------------------------|
| NIFTY Futures | 15,000+ | 1,500 | ~952 lots |
| BANKNIFTY Futures | 8,000+ | 800 | ~185 lots (₹48k) |
| Nifty 50 large cap stock | 500–3,000 | 50–300 | N/A (equity) |
| Mid-cap stock | 10–100 | 1–10 | N/A |
| Small-cap stock | <10 | <1 | N/A |

**Note:** These are illustrative figures. For accurate backtesting, supply real ADV
from market data. Do not hardcode ADV.

---

## 4. F&O Position Limits

The fill engine checks two additional F&O capacity constraints:

### 4.1 F&O Ban (SEBI Position Limit Breach)

- Instruments in the ban period: new positions are **rejected** (`FillStatus.REJECTED`)
- Closing existing positions: **allowed**
- Ban dates are supplied as `fno_ban_dates: dict[str, set[date]]` to `BacktestEngine.run()`

### 4.2 Contract Expiry

- Orders on expired contracts are rejected (`FillStatus.REJECTED`)
- Expiry date supplied via `OOSDecisionRecord.expiry_date`

---

## 5. Slippage as a Capacity Proxy

When real ADV data is unavailable, slippage models serve as an indirect capacity signal:

| Model | Capacity sensitivity |
|-------|---------------------|
| `FixedBPSSlippage` (Model A) | None — flat cost regardless of size |
| `SpreadProxySlippage` (Model B) | Volume-adjusted: larger orders widen spread proxy |
| `VolatilityParticipationSlippage` (Model C) | Explicit: `sigma × sqrt(participation_rate)` — cost rises with order size |
| `MarketImpactSlippage` (Model D) | Explicit: `eta × sigma × sqrt(Q/ADV)` — classic square-root market impact |

For capacity-sensitive strategies, Model C or D should be used alongside the
participation-rate cap.

---

## 6. Limitations & Known Gaps

| Gap | Severity | Mitigation |
|-----|----------|-----------|
| ADV in price bars is not verified against live data | MEDIUM | Supply real NSE bhav-copy ADV; do not use synthetic values |
| No intraday volume profile (VWAP timing) | LOW | NEXT_VWAP policy uses OHLC mid as approximation |
| No market depth (Level 2 / order book) | LOW | Acceptable for daily bar backtesting |
| F&O ban list must be supplied by caller | MEDIUM | `FnOStateStore` framework exists; connect to live data feed |
| Corporate actions (splits, bonuses) not yet auto-adjusted | MEDIUM | `CorporateActionStore` framework exists; data currently empty |
| No intraday capacity model | LOW | Out of scope for daily bar strategy |

---

## 7. Recommendations

1. Source real NSE bhav-copy ADV for all instruments before running production backtests.
2. Use `VolatilityParticipationSlippage` (Model C) for strategies with position sizes
   exceeding 1% of ADV.
3. Set `max_participation_pct` conservatively (5–10%) for mid/small-cap backtests.
4. Populate `FnOStateStore` and `CorporateActionStore` with real data before Phase 3H.
