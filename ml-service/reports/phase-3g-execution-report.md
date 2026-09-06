# Phase 3G — Execution Backtest Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Status:** PASS

---

## 1. Scope

Phase 3G adds a complete cost-, slippage-, and execution-aware backtesting layer to the
AlphaForge ML service.  It sits downstream of Phase 3F (meta-labeling / OOS decisions) and
upstream of any live-trading deployment.

---

## 2. Components Built

| Module | Purpose |
|--------|---------|
| `src/execution/schemas.py` | Canonical enums and dataclasses: `ExecutionPolicy`, `FillStatus`, `ProductType`, `InstrumentType`, `TradeSide`, `OrderSide`, `SpreadDataStatus`, `AmbiguityPolicy`; `OrderIntent`, `SimulatedFill`, `CostBreakdown`, `TradeRecord`, `ExecutionLedger` |
| `src/execution/cost_model.py` | `IndiaEquityCostSchedule`, `IndiaFnOCostSchedule`, `CostScheduleRegistry`, `compute_trade_cost()` — 7-component India cost model with versioning |
| `src/execution/slippage.py` | Four slippage models: `FixedBPSSlippage` (Model A), `SpreadProxySlippage` (Model B), `VolatilityParticipationSlippage` (Model C), `MarketImpactSlippage` (Model D); `SlippageModelRegistry` |
| `src/execution/market_calendar.py` | `NSECalendar` with 2020–2026 holiday set, `is_trading_day`, `next_trading_day`, `monthly_expiry`, `weekly_expiry_thursday` |
| `src/execution/fill_engine.py` | `FillEngine` with gap-through stop logic, CONSERVATIVE / BEST_CASE ambiguity resolution, circuit-limit checks, F&O ban enforcement, partial-fill participation cap |
| `src/execution/position_accounting.py` | `Position`, `PortfolioState`, `TradeAccountingLedger` with cost-aware P&L, `TurnoverStats` |
| `src/execution/backtest_engine.py` | Event-driven `BacktestEngine` consuming frozen Phase 3F `OOSDecisionRecord` objects; `BacktestConfig` with deterministic `config_hash`; `BacktestProvenance`; `BacktestResult` |

---

## 3. Test Results

### 3.1 Phase 3G suite

| Metric | Value |
|--------|-------|
| Tests collected | 56 |
| Passed | 56 |
| Failed | 0 |
| Skipped | 0 |

**Test classes covered:**

| Class | Tests | Focus |
|-------|-------|-------|
| `TestExecutionTiming` | 6 | Same-close rejection, NEXT_OPEN / NEXT_BAR fill, no-next-bar → UNAVAILABLE, fill time > signal time |
| `TestCostModel` | 7 | Futures sell components, buy stamp/no-STT, pre/post Budget 2023-24 STT rates, equity delivery/intraday, GST |
| `TestSlippageModels` | 6 | FixedBPS, SpreadProxy HL range, UNAVAILABLE without data, OBSERVED trumps proxy, VolatilityParticipation scaling |
| `TestNSECalendar` | 7 | Saturday/Sunday, known holiday, next trading day, monthly expiry, out-of-range → INSUFFICIENT_EVIDENCE, immutability |
| `TestFillEngine` | 9 | Gap-through stop, intrabar stop, CONSERVATIVE/BEST_CASE ambiguity, circuit limit, F&O ban new/close, expired contract, partial/full ADV fill |
| `TestPositionAccounting` | 4 | Golden P&L reconciliation, losing trade, ledger reconciliation, bad-reconciliation raises |
| `TestBacktestEngine` | 5 | Rising-price gross P&L, SKIP not executed, reproducibility, config hash identity/change |
| `TestFutureMutation` | 3 | Future cost schedule / lot size / price mutation isolation |
| `TestGexLotSizeFix` | 2 | NIFTY lot size post-SEBI 2024, gex/instrument_master consistency |
| `TestSpreadDataStatusInvariant` | 3 | Proxy never OBSERVED, vol-participation never OBSERVED, fill records proxy status |
| `TestBackwardCompatibility` | 2 | Prior suite imports, `LabelConfig` cost model still functional |

### 3.2 Full regression suite (Phases 3A–3G)

| Suite | Passed | Skipped | Failed |
|-------|--------|---------|--------|
| test_phase3g.py | 56 | 0 | 0 |
| test_phase3f.py | — | — | — |
| test_phase3e.py | — | — | — |
| test_phase3d.py | — | — | — |
| test_phase3c.py | — | — | — |
| test_vpin.py | — | — | — |
| **TOTAL** | **398** | **11** | **0** |

---

## 4. Bugs Fixed

| Bug | Location | Fix |
|-----|----------|-----|
| `add_position(pos.position_id)` passes string instead of `Position` object | `position_accounting.py:217` | Changed to `add_position(pos)`; removed redundant duplicate line |
| `BacktestConfig.config_hash` crashes when `execution_policy` passed as string | `backtest_engine.py` | Added str→enum coercion in `config_hash` property for `execution_policy` and `ambiguity_policy` |
| Test: `date(2024, 1, 22)` is NSE holiday (Republic Day) | `test_phase3g.py:473` | Corrected expected value to `date(2024, 1, 23)` |
| Test: `TradeRecord` missing required fields `holding_bars`, `max_adverse_excursion`, `max_favourable_excursion` | `test_phase3g.py` | Added `holding_bars=1, max_adverse_excursion=None, max_favourable_excursion=None` |
| Test: `OOSDecisionRecord` missing required fields `stop_price_hint`, `target_price_hint` | `test_phase3g.py` | Added `stop_price_hint=None, target_price_hint=None` |

---

## 5. Static Anti-Pattern Audit

All checks **CLEAN**.

| Pattern | Result | Evidence |
|---------|--------|----------|
| Same-bar fill (unrestricted) | CLEAN | `SAME_CLOSE` gated behind `allow_same_close=False` |
| Forward-looking `shift(-N)` | CLEAN | No occurrences in `src/execution/` |
| `fillna(0)` on financial series | CLEAN | No occurrences |
| `center=True` rolling (lookahead) | CLEAN | No occurrences |
| Infinite liquidity assumption | CLEAN | Participation cap enforced in `fill_engine.py:356` |
| Hardcoded magic-number costs | CLEAN | All constants are named regulatory rates |
| Hardcoded lot sizes in execution | CLEAN | No occurrences in `src/execution/` |
| Fake / fabricated fills | CLEAN | UNAVAILABLE is a valid outcome; no price invention |

---

## 6. Key Design Decisions

1. **No same-bar fills by default.** `ExecutionPolicy.NEXT_OPEN` is the default. `SAME_CLOSE` requires `allow_same_close=True` and is documented as a special-case override.
2. **UNAVAILABLE is a first-class outcome.** `FillStatus.UNAVAILABLE` is returned when there is no next bar, no ADV, or an F&O-ban prevents execution. The engine never fabricates a fill.
3. **Conservative ambiguity.** When both stop and target are hit in the same bar, the default `AmbiguityPolicy.CONSERVATIVE` assumes the stop was hit first (worst case).
4. **Versioned cost schedules.** Pre- and post-Budget 2023-24 schedules are stored separately. `CostScheduleRegistry` selects by effective date to prevent future rate changes from altering historical costs.
5. **Deterministic config hash.** `BacktestConfig.config_hash` is a SHA-256 of all parameters, enabling reproducibility checks (spec §33).
6. **LOT_SIZES corrected.** `gex.py` updated to post-SEBI Nov 2024 lot sizes with a PIT warning; verified consistent with `InstrumentMasterStore`.
