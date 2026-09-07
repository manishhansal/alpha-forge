# Phase 3G — Execution Backtest Audit

**Phase:** 3G  
**Auditor:** Automated (Kiro / AlphaForge ML audit pipeline)  
**Date:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Verdict:** PASS — no lookahead, no fabricated fills, no same-bar execution

---

## 1. What Was Audited

The `src/execution/` package added in Phase 3G:

```
src/execution/
├── __init__.py
├── schemas.py           — canonical types
├── cost_model.py        — India cost model (equity + F&O)
├── slippage.py          — 4 slippage models
├── market_calendar.py   — NSE calendar 2020–2026
├── fill_engine.py       — order simulation
├── position_accounting.py — P&L and portfolio state
└── backtest_engine.py   — event-driven backtester
```

---

## 2. Lookahead / Future-Data Audit

### 2.1 Same-bar execution

**Finding:** CLEAN  
`ExecutionPolicy.SAME_CLOSE` exists but is **gated** behind `FillEngineConfig.allow_same_close = False`.
Any attempt to use it without setting the override raises a `ValueError` with message:
`"SAME_CLOSE_EXECUTION_DISABLED: set allow_same_close=True to enable same-bar fills"`.

The default execution policy is `NEXT_OPEN` — signals from `close(T)` execute at `open(T+1)`.

### 2.2 Forward-looking price references

**Finding:** CLEAN  
`grep -rn "shift(-[0-9]" src/execution/` — **0 matches**.

Fill prices are sourced exclusively from `next_bars[0]` (the first bar after the signal bar).
Signal bar prices are used only as a reference (`signal_price` field in `SimulatedFill`) and
are never used as the fill price.

### 2.3 Rolling windows with `center=True`

**Finding:** CLEAN  
`grep -rn "center=True" src/execution/` — **0 matches**.  
No pandas rolling operations in `src/execution/`.

### 2.4 `fillna(0)` on financial series

**Finding:** CLEAN  
`grep -rn "fillna(0)" src/execution/` — **0 matches**.

---

## 3. Cost Model Audit

### 3.1 Hardcoded magic numbers

**Finding:** CLEAN  
All numeric constants in `cost_model.py` are:
- Named regulatory rates (e.g., `stt_futures_sell_pct`, `stamp_duty_buy_pct`)
- Documented with the regulatory basis in comments
- Version-tagged and immutable once a schedule is created

No anonymous magic numbers (e.g., bare `0.15` or `0.0125` without context).

### 3.2 GST base

**Finding:** CORRECT  
GST (18%) is applied to `brokerage + exchange_charges` only.  
It is **not** applied to STT, SEBI charges, or stamp duty, which is the correct treatment
under GST law.

### 3.3 Brokerage cap

**Finding:** CORRECT  
Brokerage is capped at ₹20/order for equity and ₹20/order/lot for F&O,
consistent with the Zerodha-style discount broker model.

### 3.4 Historical schedule immutability

**Finding:** ENFORCED  
`CostScheduleRegistry` returns schedules by effective date.  Adding a new schedule
version does not modify historical schedules.  Verified by `TestCostModel::test_historical_schedule_not_future_schedule`.

---

## 4. Fill Engine Audit

### 4.1 Infinite liquidity

**Finding:** CLEAN  
`fill_engine.py:356` enforces: `max_notional = bar.adv_inr × max_participation_pct`.  
Orders exceeding capacity return `FillStatus.PARTIAL` or `FillStatus.UNAVAILABLE`.  
`PARTIAL` is never silently upgraded to `FULL`.

### 4.2 UNAVAILABLE is a valid outcome

**Finding:** ENFORCED  
Six scenarios produce `FillStatus.UNAVAILABLE`:
1. No next bars after signal
2. Execution policy requires ADV but `bar.adv_inr == 0`
3. F&O ban prevents new positions
4. Contract expired
5. Circuit limit hit
6. Order fills 0 lots under participation cap

None of these are silently filled. The engine returns the fill object with `status=UNAVAILABLE`
and the backtest engine skips the trade.

### 4.3 F&O ban enforcement

**Finding:** CORRECT  
New positions on banned instruments are rejected. Closing positions are allowed.
Verified by `TestFillEngine::test_fno_ban_rejects_new_position` and
`TestFillEngine::test_fno_ban_allows_closing_position`.

### 4.4 Stop/target ambiguity

**Finding:** CONSERVATIVE DEFAULT  
When both stop and target are touched in the same bar (gap scenario), the default
`AmbiguityPolicy.CONSERVATIVE` assumes the stop hit first (worst case for the strategy).
`BEST_CASE` is available but not the default.  Verified by:
- `TestFillEngine::test_conservative_ambiguity_policy_chooses_stop`
- `TestFillEngine::test_ambiguity_best_case_chooses_target`

---

## 5. Position Accounting Audit

### 5.1 P&L reconciliation

**Finding:** ENFORCED  
`TradeRecord.validate_pnl()` checks: `|net_pnl - (gross_pnl - total_cost)| < tolerance`.  
`ExecutionLedger.append_trade()` raises `ValueError` if reconciliation fails.  
Verified by `TestPositionAccounting::test_append_trade_raises_on_bad_reconciliation`.

### 5.2 Double-counting

**Finding:** CLEAN  
`open_position()` calls `portfolio.add_position(pos)` exactly once.  
The duplicate `portfolio.open_positions[pos.position_id] = pos` line that existed
(and was the source of BUG-3G-01) was removed.

---

## 6. Reproducibility Audit

### 6.1 Config hash

**Finding:** CORRECT  
`BacktestConfig.config_hash` is a SHA-256 of all 11 configuration parameters.
Any parameter change produces a different hash.  
Verified by:
- `TestBacktestEngine::test_config_hash_changes_with_different_params`
- `TestBacktestEngine::test_config_hash_identical_for_same_params`

### 6.2 Determinism

**Finding:** CORRECT  
Same inputs + same `BacktestConfig` → identical `BacktestResult`.  
Verified by `TestBacktestEngine::test_reproducibility_same_config_same_result`.

---

## 7. Audit Summary

| Area | Finding | Severity |
|------|---------|----------|
| Same-bar fill | CLEAN — gated | — |
| Forward-looking shift(-N) | CLEAN | — |
| fillna(0) | CLEAN | — |
| center=True rolling | CLEAN | — |
| Infinite liquidity | CLEAN — participation cap enforced | — |
| Fake/fabricated fills | CLEAN — UNAVAILABLE is valid | — |
| Hardcoded magic costs | CLEAN — all named regulatory rates | — |
| GST base | CORRECT | — |
| Brokerage cap | CORRECT | — |
| Historical schedule immutability | ENFORCED | — |
| P&L reconciliation | ENFORCED | — |
| Reproducibility | CORRECT | — |

**Overall verdict: PASS**
