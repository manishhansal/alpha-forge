# Phase 3G — Current Execution Infrastructure Audit

**Date:** 2026-09-06
**Scope:** Complete survey of existing code relevant to execution, cost, backtesting, and portfolio management

---

## Executive Summary

**`src/execution/` does not exist.** There is no backtesting engine, no order management system, no fill simulator, and no position accounting in this codebase. Phase 3G builds these from scratch on a solid pre-existing foundation.

**What does exist and can be reused:**
- A correct, comprehensive NSE cost model (`CostModelConfig` in `labels/config.py`)
- Historical point-in-time lot-size lookup (`InstrumentMasterStore`)
- Corporate action framework (correctly designed; data empty)
- F&O ban framework (correctly designed; data empty)
- An EV computation engine with leakage protection (`ev_engine.py`)
- RL-based execution timing agent (`rl_executor.py`) — not a backtester
- Portfolio weight optimizer (`portfolio_optimizer.py`) — fractional weights only
- Validation metrics (`TradingMetrics`) — Sharpe, Sortino, drawdown, etc.

---

## 1. Existing Execution Infrastructure

### 1.1 `src/models/rl_executor.py` — PPO Execution Timing Agent

**NOT a backtester.** This is an intraday execution optimizer:
- 7 discrete actions: WAIT, ENTER_NOW, SCALE_IN, PARTIAL_EXIT, FULL_EXIT, TIGHTEN_STOP, TRAIL_STOP
- 14-state observation (5 are placeholders: spread, VWAP deviation, position heat, max drawdown, time-since-action)
- PPO via stable-baselines3; rule-based fallback
- `TradingExecutionEnv.set_trajectory(prices, volumes)` — real-data replay ready
- **No cost model in reward function** — trains on cost-free P&L
- **No lot sizes** — ExecutionState has no quantity/notional fields

### 1.2 `src/meta/decision_policy.py` — TradeAction + execution_quality

- `TradeAction(BUY/SELL/WAIT/NO_TRADE)` — direction only, no size
- `_execution_quality()` — session timing + IV regime + stop probability → [0,1] score
- `DecisionOutput` — no position sizing, no cost, no lot count

### 1.3 `src/schemas.py` — ExecutionState / ExecutionDecision

- `ExecutionState` — 13 fields; no lot_size, no quantity, no capital, no cost
- `ExecutionDecision(action, confidence, new_stop_loss, exit_pct, rationale)`
- No Order, Fill, Trade, Position, or PortfolioState schemas

---

## 2. Existing Cost Logic

### 2.1 `src/labels/config.py` — `CostModelConfig` ← PRIMARY REUSE CANDIDATE

```python
CostModelConfig:
    brokerage:        float = 0.0003      # 0.03%
    stt_sell:         float = 0.0001      # 0.01% futures sell
    exchange_charge:  float = 0.0000345  # NSE
    sebi_charge:      float = 0.0000001
    stamp_duty:       float = 0.000020   # buy side
    gst_on_brokerage: float = 0.18       # 18%
    slippage_pct:     float = 0.0005     # 0.05%

round_trip_cost_pct ≈ 0.15% for NSE futures
```

Factory: `CostModelConfig.futures_nse()` — ready to use.

**Currently disabled:** `LabelConfig.include_costs=False` by default. Net return in labels is not yet cost-adjusted.

**Inconsistency:** Parallel `CostModel` in `meta/ev_engine.py` duplicates the same fields but is not connected to `CostModelConfig`. Must be unified in Phase 3G.

### 2.2 `src/meta/ev_engine.py` — EV + Cost

- `EVConfig.cost_model = CostModel.unavailable()` by default → all OOS EVs show `COST_DATA_UNAVAILABLE`
- `ExpectedValueCalculator.compute()` — correctly propagates cost unavailability
- Ready to consume real costs once wired

---

## 3. Existing Order Schemas

| Schema | Location | Fields | Gap |
|--------|----------|--------|-----|
| `TradeAction(BUY/SELL/WAIT/NO_TRADE)` | decision_policy.py | direction only | No size |
| `ExecutionAction(ENTER_NOW/WAIT/...)` | schemas.py | 7 actions | Disconnected from TradeAction |
| `ExecutionDecision` | schemas.py | action, confidence, exit_pct | No fill price |
| `ExecutionState` | schemas.py | 13 fields | No quantity, no capital |
| **MISSING** | — | Order, Fill, Trade, Position | Need to create |

---

## 4. Existing Portfolio Logic

| Component | Location | Capability | Gap |
|-----------|----------|-----------|-----|
| `PortfolioOptimizer.hrp_allocation()` | portfolio_optimizer.py | Fractional weights via Riskfolio-Lib | No lot rounding |
| `PortfolioOptimizer.cvar_allocation()` | portfolio_optimizer.py | CVaR-minimising weights | No capital amount input |
| `PortfolioRequest.risk_budget_pct` | schemas.py | Field exists | Never used in optimizer |
| `RiskResponse.suggested_position_size_pct` | schemas.py | Risk-derived size | Silently dropped before MetaOutput |
| `TradingMetrics` | validation/metrics.py | Sharpe, Sortino, Calmar, etc. | Post-hoc only, not live |
| **MISSING** | — | PortfolioState, Position, TradeAccountingLedger | Need to create |

---

## 5. Existing Instrument Metadata

| Data | Location | Status |
|------|----------|--------|
| Historical lot sizes (4 indices) | instrument_master.py | OK + APPROXIMATE |
| Current lot sizes (~50 stocks) | instrument_master.py | APPROXIMATE |
| Pre/post SEBI Nov 2024 changes | KNOWN_LOT_SIZE_CHANGES | BEST_KNOWN |
| Tick size | HistoricalInstrumentRecord | Fixed 0.05 |
| Expiry dates | **MISSING** | — |
| Option strikes / CE/PE | **MISSING** | — |
| Contract multiplier | **MISSING** | — |
| Margin rates | **MISSING** | — |

**Inconsistency:** `gex.py` has `LOT_SIZES = {NIFTY:50, BANKNIFTY:15}` (pre-SEBI revision). `instrument_master.py` has post-revision NIFTY=75. Phase 3G must fix `gex.py` to use `InstrumentMasterStore`.

---

## 6. Existing Corporate Action Handling

`CorporateActionStore` — **correctly designed, data empty:**
- Framework: SPLIT, BONUS, DIVIDEND, RIGHTS, MERGER, DEMERGER, SYMBOL_CHANGE, DELISTING
- `get_adjusted_price()` — point-in-time adjustment with leakage protection
- `CorporateActionStore.empty()` is the only constructor
- ALL queries return `AdjustmentStatus.DATA_UNAVAILABLE`
- `LabelConfig.corporate_action_version = "DATA_UNAVAILABLE"`

---

## 7. Existing Market Calendar

**Nothing.** No calendar, no NSE holiday list, no trading session definition anywhere. The only reference is `max_steps=375` (NSE session minutes) hardcoded in `TradingExecutionEnv`. Phase 3G must implement this.

---

## 8. Existing F&O Ban Handling

`FnOStateStore` — **correctly designed, data empty:**
- `BanStatus(NOT_BANNED/BANNED/DATA_UNAVAILABLE)`
- `MWPLState(NORMAL/WARNING/BANNED/DATA_UNAVAILABLE)`
- `FnOStateStore.empty()` is the only constructor
- ALL queries return DATA_UNAVAILABLE

---

## 9. Reuse Candidates (Priority Order)

1. **`CostModelConfig.futures_nse()`** — extend for options and CNC/MIS
2. **`InstrumentMasterStore.get_lot_size()`** — consume directly in position sizing
3. **`TripleBarrierLabel.net_return`** — activate with `include_costs=True`
4. **`ExpectedValueCalculator.compute()`** — wire to real NSE costs
5. **`TradingMetrics`** — extend with cost-adjusted versions
6. **`CorporateActionStore`** — needs data, not redesign
7. **`FnOStateStore`** — needs data, not redesign
8. **`TradingExecutionEnv.set_trajectory()`** — extend RL reward with cost terms
9. **`PortfolioOptimizer`** — extend with lot-aware rounding + rebalancing cost

---

## 10. What Must Be Built in Phase 3G

| # | Module | Status |
|---|--------|--------|
| 1 | `execution/schemas.py` — TradeRecord, OrderIntent, SimulatedFill, ExecutionLedger, FillStatus | **CREATE** |
| 2 | `execution/cost_model.py` — IndiaEquityCostSchedule, IndiaFnOCostSchedule, CostScheduleRegistry | **CREATE** |
| 3 | `execution/slippage.py` — FixedBPS, SpreadProxy, VolatilityParticipation models | **CREATE** |
| 4 | `execution/fill_engine.py` — FillEngine: gap handling, partial fills, circuit locks, F&O bans | **CREATE** |
| 5 | `execution/position_accounting.py` — Position, PortfolioState, TradeAccountingLedger | **CREATE** |
| 6 | `execution/market_calendar.py` — NSECalendar: holidays, session hours, expiry dates | **CREATE** |
| 7 | `execution/backtest_engine.py` — event-driven BacktestEngine + BacktestProvenance | **CREATE** |
| 8 | `tests/test_phase3g.py` — 100+ tests: timing, costs, slippage, F&O, accounting, leakage | **CREATE** |
| 9 | Fix `gex.py` LOT_SIZES inconsistency | **FIX** |
| 10 | Wire `CostModelConfig.futures_nse()` into `EVConfig` | **FIX** |
| 11 | Enable `LabelConfig.include_costs=True` with versioning | **FIX** |

---

## 11. Anti-Patterns Found in Existing Code

| Anti-pattern | Location | Severity |
|-------------|----------|----------|
| `LOT_SIZES = {NIFTY:50}` hardcoded (pre-SEBI) | gex.py | HIGH |
| `risk_budget_pct=2.0` unused in optimizer | portfolio_optimizer.py | MEDIUM |
| `suggested_position_size_pct` silently dropped | meta_model.py | HIGH |
| No cost in RL reward function | rl_executor.py | HIGH |
| Two parallel cost models (config.py vs ev_engine.py) | labels/ + meta/ | MEDIUM |
| `max_steps=375` hardcoded session length | rl_executor.py | LOW |
| No real calendar — assumes every day is a trading day | (everywhere) | HIGH |
| Spread hardcoded to 0.0 in observation state | rl_executor.py | MEDIUM |
