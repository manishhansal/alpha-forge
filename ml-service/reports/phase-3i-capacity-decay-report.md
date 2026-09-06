# Phase 3I — Capacity & Liquidity Decay Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**OOS evidence:** INSUFFICIENT_EVIDENCE

---

## 1. Scope

Documents liquidity decay, cost/edge decay, turnover decay, and capacity decay
analysis, primarily in `src/stability/portfolio_decay.py` and via the
`liquidity_bucket` / `adv_inr` fields on `AlphaDecayObservation`.

---

## 2. Liquidity Decay

`AlphaDecayObservation` carries `liquidity_bucket` (HIGH_ADV / MEDIUM_ADV /
LOW_ADV) and `adv_inr`. Alpha can be stratified by liquidity bucket to determine
whether the apparent edge disappears once realistic liquidity constraints are
applied (spec §29).

The intended analysis:
- Gross alpha per bucket
- Net alpha per bucket (after Phase 3G cost model)
- Whether low-ADV buckets carry the alpha (fragility)

---

## 3. Cost Decay (spec §30)

`portfolio_decay.analyse_portfolio_decay()` accepts a `cost_series` and computes
`cost_edge_ratio = mean_cost / |gross_edge|`. Periods where gross edge > 0 but
net edge ≤ 0 are a valid research outcome — surfaced, not hidden.

`AlphaDecayObservation` separates `gross_return` from `net_return` and `cost`,
enabling gross-vs-net comparison through time.

---

## 4. Turnover Decay (spec §31)

`analyse_portfolio_decay()` accepts a `turnover_series` and computes
`turnover_trend_slope` via linregress across early/middle/recent windows.
Positive slope = turnover increasing as alpha decays (a common decay signature).

---

## 5. Capacity Decay (spec §32)

Capacity is measured through the `adv_inr` field and participation ratios.
The framework tracks whether alpha becomes less scalable through time.

**No precise AUM capacity is claimed** — this requires the full Phase 3G
execution model with real ADV data.

---

## 6. Framework Verification (Synthetic Data)

| Scenario | Expected | Result |
|----------|----------|--------|
| Increasing turnover series | turnover_trend_slope > 0 | PASS |
| Rising HHI concentration | HHI tracked in windows | PASS |
| Cost/edge ratio | cost_edge_ratio computed | PASS |
| 3-observation window | INSUFFICIENT_EVIDENCE | PASS |

---

## 7. OOS Evidence

**INSUFFICIENT_EVIDENCE** — no real ADV / liquidity / cost data loaded. Capacity
and liquidity decay require:
- Real NSE ADV per instrument (currently DATA_UNAVAILABLE)
- Real execution cost/slippage from Phase 3G with market data
- A real return series per liquidity bucket

---

## 8. Limitations

| Limitation | Notes |
|------------|-------|
| ADV data not in service | Liquidity buckets cannot be populated with real values |
| No AUM capacity estimate | Requires full execution model + real depth data |
| Cost from proxy only | Real slippage requires tick data (Phase 3G limitation) |
