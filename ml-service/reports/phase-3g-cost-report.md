# Phase 3G — Cost Model Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Overview

This report documents the India-specific transaction cost model implemented in
`src/execution/cost_model.py`.  All rates reflect the regulatory regime applicable to
retail/institutional trading on NSE as of the implementation date.

---

## 2. India Equity Cost Schedule (`IndiaEquityCostSchedule`)

### 2.1 Components

| Component | Rate | Notes |
|-----------|------|-------|
| Brokerage | 0.03% of turnover, capped at ₹20/order | Zerodha-style flat-fee model |
| STT — Delivery buy | 0.1% of turnover | Both buy and sell legs |
| STT — Delivery sell | 0.1% of turnover | |
| STT — Intraday sell | 0.025% of turnover | Sell side only |
| Exchange charges | 0.00325% of turnover | NSE CM segment |
| SEBI charges | 0.0001% of turnover | |
| Stamp duty | 0.015% of buy turnover | Maharashtra stamp; buy only |
| GST | 18% on (brokerage + exchange charges) | |

### 2.2 Round-trip cost estimate (delivery, ₹1,00,000 notional)

| Component | INR |
|-----------|-----|
| Brokerage (buy + sell) | ₹40.00 |
| STT (buy + sell) | ₹200.00 |
| Exchange charges | ₹6.50 |
| SEBI charges | ₹0.20 |
| Stamp duty (buy only) | ₹15.00 |
| GST | ₹8.37 |
| **Total** | **≈ ₹270 (0.27%)** |

---

## 3. India F&O Cost Schedule (`IndiaFnOCostSchedule`)

### 3.1 Futures components

| Component | Rate | Notes |
|-----------|------|-------|
| Brokerage | 0.03% capped at ₹20/order/lot | NRML/MIS both same |
| STT (post Budget 2023-24) | 0.0125% on sell turnover | Changed from 0.01% in Oct 2023 |
| STT (pre Budget 2023-24) | 0.01% on sell turnover | Historical schedule |
| Exchange charges | 0.002% of turnover | NSE F&O segment |
| SEBI charges | 0.0001% of turnover | |
| Stamp duty | 0.003% of buy turnover | |
| GST | 18% on (brokerage + exchange charges) | |

### 3.2 Options components

| Component | Rate | Notes |
|-----------|------|-------|
| Brokerage | ₹20 flat per order | Options brokerage is flat |
| STT (post Budget 2023-24) | 0.0625% on sell premium | Changed from 0.05% |
| STT on exercise | 0.125% of intrinsic value | |
| Exchange charges | 0.053% of premium turnover | |
| SEBI charges | 0.0001% | |
| Stamp duty | 0.003% of buy premium | |
| GST | 18% on (brokerage + exchange) | |

### 3.3 Round-trip futures cost estimate (1 lot NIFTY @ ₹21,000, lot=75)

| Component | INR |
|-----------|-----|
| Notional | ₹15,75,000 |
| Brokerage (buy + sell, capped) | ₹40.00 |
| STT (sell only) | ₹196.88 |
| Exchange charges | ₹63.00 |
| SEBI charges | ₹3.15 |
| Stamp duty (buy) | ₹47.25 |
| GST | ₹18.54 |
| **Total round-trip** | **≈ ₹369 (0.023%)** |

---

## 4. Versioning

| Version Key | Effective From | Effective To | STT Futures | STT Options |
|-------------|---------------|-------------|-------------|-------------|
| `india-equity-2020` | 2020-01-01 | 2023-09-30 | N/A | N/A |
| `india-equity-2023` | 2023-10-01 | ∞ | N/A | N/A |
| `india-fno-2020` | 2020-01-01 | 2023-09-30 | 0.01% | 0.05% |
| `india-fno-2023` | 2023-10-01 | ∞ | 0.0125% | 0.0625% |

`CostScheduleRegistry.get_for_date(dt)` returns the correct schedule for any trade date.
Future rate changes do **not** retroactively alter historical trade costs.

---

## 5. Validation

- `TestCostModel` (7 tests) — all PASS
- Futures sell STT `0.0125%` verified: `0.000125 × 1_575_000 = 196.875` ✓
- Pre-budget STT `0.01%` verified: `0.0001 × 1_575_000 = 157.5` ✓
- Equity delivery round-trip cost verified against SEBI Schedule of Charges ✓
- GST computed on `brokerage + exchange_charges` only (not on STT or stamp) ✓
- Brokerage cap of ₹20/order enforced for large-notional trades ✓
