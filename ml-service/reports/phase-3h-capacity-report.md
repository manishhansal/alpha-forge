# Phase 3H — Portfolio Capacity Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Overview

This report documents how Phase 3H models portfolio capacity and liquidity constraints.

---

## 2. Liquidity Constraints

### 2.1 Order-level participation cap

```
max_order_notional = ADV × max_order_pct_adv
```

Default: `max_order_pct_adv = 10%` (configurable via `ConstraintSet`).

If a target weight implies an order notional exceeding this limit:
- `TargetOrder.liquidity_requirement_pct_adv` is populated with the actual requirement
- The execution planner (Phase 3G) may partially fill or reject

### 2.2 Position-level participation cap

```
max_position_notional = ADV × max_position_pct_adv
```

Default: `max_position_pct_adv = 20%`.

### 2.3 Eligibility pre-filter

Before optimization, `EligibilityFilter` checks:
- `candidate.adv_inr ≥ min_adv_inr` (configurable threshold)

Candidates failing the ADV check receive `EligibilityStatus.INSUFFICIENT_LIQUIDITY`.

---

## 3. Capacity Diagnostics in TargetOrder

Each `TargetOrder` produced by the rebalancer carries:

| Field | Description |
|-------|-------------|
| `quantity_lots` | Integer lots — never fractional |
| `estimated_notional_inr` | `lots × lot_size × price` |
| `liquidity_requirement_pct_adv` | `estimated_notional / adv_inr` |
| `estimated_cost_inr` | ~3 bps one-way × notional (proxy) |

---

## 4. Capacity by Instrument Tier (Reference, Not Live Data)

The following illustrates typical NSE capacity constraints for Phase 3H testing.
**These are illustrative figures — supply real ADV from NSE bhav-copy for production.**

| Instrument | Typical ADV (₹ Cr) | 10% participation cap | Max lots (NIFTY@₹21k, lot=75) |
|------------|-------------------|----------------------|-------------------------------|
| NIFTY Futures | 15,000+ | ₹1,500 Cr | ~952 lots |
| BANKNIFTY | 8,000+ | ₹800 Cr | ~185 lots (₹48k) |
| Large-cap equity | 500–3,000 | ₹50–300 Cr | N/A |
| Mid-cap equity | 10–100 | ₹1–10 Cr | N/A |

---

## 5. F&O Position Limits

In addition to liquidity caps, F&O portfolios face SEBI position limits:

| Constraint | Enforcement |
|------------|-------------|
| F&O ban period | `EligibilityFilter.check()` — new positions rejected |
| Contract expiry | `EligibilityFilter.check()` — expired contracts rejected |
| Lot sizing | `SizingEngine.compute()` — `floor(notional / lot_notional)` |

---

## 6. Capacity-Aware Optimization

The portfolio optimizer does NOT directly model liquidity in the objective function.
Capacity constraints are applied at two stages:

1. **Pre-optimization**: `EligibilityFilter` removes illiquid candidates
2. **Post-optimization**: `Rebalancer` computes `liquidity_requirement_pct_adv` per order

A theoretically optimal portfolio that cannot be executed within participation limits
is flagged — the execution contract (TargetOrder list) documents the capacity breach.

---

## 7. Known Gaps

| Gap | Severity | Mitigation |
|-----|----------|-----------|
| ADV data not available in service | HIGH | Must be supplied via `PortfolioCandidate.adv_inr` from market data |
| No intraday volume profile | LOW | Daily bar model; VWAP approximation acceptable |
| No market depth (Level 2) | LOW | Out of scope for daily bar strategies |
| F&O aggregate OI (MWPL) | MEDIUM | `FnOStateStore.VERSION = DATA_UNAVAILABLE`; ban detection deferred |
| Corporate action adjustment | MEDIUM | `CorporateActionStore.VERSION = DATA_UNAVAILABLE` |
