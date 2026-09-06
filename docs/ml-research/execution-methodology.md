# AlphaForge ML — Execution Methodology

**Date:** 2026-09-06  
**Scope:** Execution quality, transaction cost modelling, RL vs rule-based execution, and the research-to-live gap.

---

## 1. The Execution Problem

For an F&O signal system at AlphaForge's scale, execution is not the primary alpha source — but poor execution can destroy all alpha. A system with IC = 0.04 (hypothetical) generating 0.8% annual gross alpha can see that alpha eliminated by 0.4% round-trip costs if the execution is naive.

The execution problem decomposes into:
1. **When to enter:** Time of day, market conditions, proximity to expiry
2. **How to enter:** Market order vs limit order, price improvement strategies
3. **How to size:** Position size relative to ADV and available margin
4. **When to exit:** Profit-taking, stop-loss, regime change, time exit
5. **How to manage:** Trailing stops, scaling in/out, partial exits

---

## 2. Transaction Cost Architecture

### 2.1 The Three-Component Cost Model

```
Total execution cost = Commissions + Market impact + Opportunity cost

Commissions: Known in advance — STT, brokerage, exchange, SEBI, stamp
Market impact: Depends on order size and market depth
Opportunity cost: Cost of NOT executing (price moved against you while waiting)
```

### 2.2 Commission Model for Indian F&O

Fixed components (known at order time):
```python
class NSECommissionModel:
    """NSE F&O transaction cost model (2026)."""
    
    def compute_round_trip(
        self,
        instrument: str,    # "futures" | "options"
        trade_value: float, # total notional value
        premium: float,     # options premium (for STT)
    ) -> float:
        """Returns total round-trip cost as fraction of trade value."""
        
        brokerage = min(20.0 / trade_value, 0.0005)  # ₹20 flat or 0.05%
        
        if instrument == "futures":
            stt = 0.0001 * 2  # 0.01% each side
        else:  # options
            stt = 0.001  # 0.1% on sell side (premium basis, not notional)
        
        exchange_charges = 0.0000345 * 2  # NSE transaction charge × 2
        sebi_charges     = 0.0000001 * 2
        stamp_duty       = 0.00002 * 2    # varies by state
        gst              = (brokerage + exchange_charges + sebi_charges) * 0.18
        
        total = brokerage + stt + exchange_charges + sebi_charges + stamp_duty + gst
        return total
```

For a ₹50,000 NIFTY futures trade (1 lot at ~₹50,000 notional):
- Brokerage: ₹20 × 2 = ₹40
- STT: ₹5 × 2 = ₹10
- Exchange + SEBI + stamp: ~₹5
- GST: ~₹9
- **Total commission round-trip: ~₹64 (~0.13%)**

Add 0.05-0.15% slippage → 0.18-0.28% total round-trip.

### 2.3 Market Impact Model

For Indian F&O, market impact is the primary variable cost for larger positions:

```python
def estimate_market_impact(
    order_size_lots: int,
    adv_lots: float,         # average daily volume in lots
    volatility_daily: float, # instrument daily volatility
    urgency: float = 0.5,   # 0=passive, 1=aggressive
) -> float:
    """
    Simplified Almgren-Chriss-inspired impact model.
    Returns impact as fraction of price.
    """
    participation_rate = order_size_lots / adv_lots
    
    # Linear permanent impact
    permanent_impact = 0.1 * volatility_daily * participation_rate
    
    # Temporary impact (depends on urgency)
    temporary_impact = 0.5 * volatility_daily * (participation_rate ** 0.5) * urgency
    
    return permanent_impact + temporary_impact
```

For AlphaForge's typical position (1-3 NIFTY lots out of ~50,000-100,000 lots/day ADV), participation rate ≈ 0.002%, making market impact negligible. The dominant cost is commissions + bid-ask spread.

---

## 3. Order Execution Strategies

### 3.1 Benchmark Algorithms

**VWAP (Volume-Weighted Average Price):**
- Execute proportionally to historical volume distribution across the session
- Minimises tracking error against the VWAP benchmark
- Appropriate for: end-of-day rebalancing, non-urgent entries

**TWAP (Time-Weighted Average Price):**
- Execute equal-sized child orders at fixed intervals
- Simple; does not adapt to volume patterns
- Appropriate for: very small orders, illiquid instruments

**IS (Implementation Shortfall):**
- Minimises the gap between decision price and average execution price
- Trades off urgency cost (market impact if fast) against opportunity cost (price drift if slow)
- Appropriate for: time-sensitive signals

### 3.2 NSE F&O Specific Execution Windows

NSE session has well-documented intraday volume and liquidity patterns:

| Time Window | Volume Share | Spread | Recommendation |
|---|---|---|---|
| 09:15–09:30 | ~8-12% | Wide (price discovery) | Avoid entry; use for observation |
| 09:30–10:30 | ~20-25% | Moderate | Acceptable for non-urgent entries |
| 10:30–14:00 | ~35-40% | Tight (best liquidity) | Optimal execution window |
| 14:00–15:00 | ~15-20% | Moderate-tight | Acceptable |
| 15:00–15:30 | ~10-15% | Wide (expiry day: very wide) | Avoid entry; use for exits |

**AlphaForge's `is_opening_zone`, `is_power_hour` features correctly identify these windows.** The RL executor should prioritise the 10:30-14:00 window for entries.

### 3.3 Expiry Day Execution

On weekly expiry day (Tuesday since September 2025), Indian F&O exhibits:
- **Pin risk:** Nifty options near-ATM show extreme gamma near expiry; small price moves cause large IV changes
- **Liquidity evaporation:** OTM option spreads widen dramatically in the final hour
- **Rollover activity:** Large OI shifts from current to next expiry
- **Recommendation:** Do not enter new positions after 13:00 on expiry day; exit existing positions before 14:00

The `is_expiry_day` feature correctly flags these days. The execution policy should apply a `no_new_entries_after_1300_on_expiry` rule.

---

## 4. RL vs Rule-Based Execution

### 4.1 The Case for Rule-Based Execution

Rule-based execution algorithms have three advantages over RL in AlphaForge's context:

1. **Explainability:** "We used a VWAP algorithm over the first hour after signal generation" is auditable. "The RL agent decided to enter now" is not.

2. **No environment training needed:** A rule-based TWAP does not require a validated simulation environment. The RL agent requires a faithful simulation of NSE microstructure that is extremely difficult to validate.

3. **Robustness:** Rule-based algorithms have known failure modes (VWAP fails during volume surges; TWAP fails for time-sensitive signals). RL agents have unknown failure modes that only emerge in deployment.

**For AlphaForge at current maturity level, rule-based execution is strongly recommended over the RL executor.**

### 4.2 The Case for RL Execution (When Ready)

RL becomes valuable when:
1. The base ML signal has validated OOS alpha (IC > 0.02, net Sharpe > 0.5)
2. A validated simulation environment with realistic microstructure exists
3. The execution alpha (improvement over VWAP) is measurable and exceeds development cost
4. Paper trading has validated that the RL agent does not over-trade

NautilusTrader's approach is the gold standard: the same event-driven engine processes historical tick data in backtesting and live venue data in production. This guarantees the RL environment faithfully represents live microstructure.

### 4.3 Recommended RL Architecture (When Appropriate)

If RL is pursued, adopt the structure from QlibRL:

**State space (minimal):**
```
[time_remaining, unrealized_pnl, position_pct_filled,
 market_vol_5min, bid_ask_spread, vwap_deviation,
 india_vix, session_phase]
```

**Action space (simplified from current 7 to 3):**
```
0: HOLD    — wait; do not trade
1: EXECUTE — execute 25% of remaining order at market
2: CANCEL  — cancel remaining order (signal expired)
```

**Reward function:**
```
reward = IS_improvement - execution_cost - (holding_penalty × time_remaining)

IS_improvement = (VWAP_benchmark - actual_execution_price) × direction × position_size
```

**Critical:** The RL environment must be backtested on at least 2 years of tick data with realistic bid-ask spreads, partial fills, and circuit-breaker events before any live deployment.

---

## 5. Research-to-Live Parity

### 5.1 The Core Problem

Most ML signal systems suffer from a "deployment gap": the backtest assumes orders are filled at the signal-generation price, while live trading experiences:
- 1-5 minute delay from signal to order submission
- 0.05-0.30% bid-ask spread vs theoretical mid-price
- Partial fills on limit orders
- Market impact from larger orders

For a system with 0.5% daily gross return target, a 0.25% execution drag cuts the signal in half.

### 5.2 Measuring the Deployment Gap

The deployment gap can only be measured empirically through paper trading:

```
Deployment gap = Mean(Live execution price - Backtest assumed price) / Backtest assumed price
```

Components:
- **Signal-to-order latency drag:** Price movement from signal time to order submission
- **Market impact drag:** Price movement from order submission to fill
- **Adverse selection:** Tendency for limit orders to be filled when market has already moved against the order

### 5.3 NautilusTrader's Approach (Best Practice)

NautilusTrader eliminates the deployment gap by architectural design: the same Rust event-processing kernel handles both historical tick data (backtesting) and live venue data (production). Strategy code is identical; only the data source changes.

**For AlphaForge (Python/FastAPI), the achievable equivalent:**
1. **Signal timestamp logging:** Record the exact timestamp when each signal is generated
2. **Order submission timestamp logging:** Record when the order is submitted to Angel One/Upstox
3. **Fill timestamp and price logging:** Record actual execution details
4. **Slippage tracking:** Compute `actual_fill_price - signal_price` for every trade
5. **Monthly slippage reporting:** Track slippage distribution; alert if mean slippage > 0.15%

### 5.4 The Promotion Protocol

**Research → Paper → Shadow → Live**

| Stage | Description | Duration | Pass Criteria |
|---|---|---|---|
| Research | CPCV + walk-forward, no capital | — | IC > 0.02 OOS, DSR > 0 |
| Paper | Real-time signals, virtual capital | ≥ 30 days | Deployment gap < 0.20%, net IR > 0 |
| Shadow | Real signals, real orders, risk-limited | ≥ 60 days | Live IC ≈ backtest IC, drift stable |
| Pilot | Full system, reduced risk budget (50%) | ≥ 60 days | Live IR > 0.5, no circuit breakers |
| Full | Full risk budget | Ongoing | — |

**AlphaForge does not currently have this protocol documented or enforced.** The ml-service can return BUY/SELL without any safeguard against deploying an unvalidated model in production.

---

## 6. Execution Risk Management

### 6.1 Pre-Trade Checks (Essential for NSE F&O)

Before submitting any order:

```python
class PreTradeChecker:
    """Pre-trade validation for NSE F&O orders."""
    
    def check(self, signal, portfolio_state) -> bool:
        # 1. F&O ban list
        if signal.symbol in self.fno_ban_list:
            return False, "Symbol in F&O ban"
        
        # 2. Circuit limit proximity (within 2% of circuit)
        if abs(signal.current_price - signal.circuit_limit) / signal.circuit_limit < 0.02:
            return False, "Near circuit limit"
        
        # 3. Expiry day time check
        if portfolio_state.is_expiry_day and portfolio_state.minutes_remaining < 90:
            return False, "Too late on expiry day"
        
        # 4. Margin availability
        required_margin = signal.lots * signal.lot_size * signal.price * 0.15
        if required_margin > portfolio_state.available_margin * 0.85:
            return False, "Insufficient margin"
        
        # 5. Position concentration
        new_weight = required_margin / portfolio_state.total_capital
        if new_weight > 0.15:
            return False, "Exceeds position limit"
        
        # 6. Daily loss limit
        if portfolio_state.daily_pnl_pct < -0.02:  # -2% daily loss limit
            return False, "Daily loss limit reached"
        
        return True, "OK"
```

### 6.2 Post-Trade Attribution

After every trade, record:
- Signal timestamp and value
- Entry price vs VWAP at entry time
- Holding period return (1-day, 5-day, 20-day)
- Attribution: was the return driven by regime call, stock selection, or sector movement?

This data feeds the `PerformanceMonitor` to track live IC vs backtest IC and detect model decay.

---

## 7. Execution Methodology Summary for AlphaForge

### Immediate Actions (Before Any Live Trading)

1. **Implement the pre-trade checker** — F&O ban list, circuit proximity, margin, daily loss limit
2. **Replace RL executor with rule-based TWAP/IS** — simpler, auditable, deployable today
3. **Add signal-to-fill latency tracking** — measure the deployment gap
4. **Implement the promotion protocol** — no live capital without paper trading first

### Short-Term (Before Production Deployment)

5. **Paper trading for 30+ days** — measure deployment gap; validate signals are real-time deliverable
6. **Shadow trading** — real orders, real fills, limited capital; validate execution model assumptions
7. **Slippage model calibration** — update the backtest cost model based on measured live slippage

### Medium-Term (After First Validated Model)

8. **Adaptive execution algorithm** — choose VWAP vs IS based on signal urgency (from risk predictor)
9. **Expiry day execution specialisation** — different order routing on Tuesday expiry days
10. **RL executor development** — only after base signal is validated and environment is verified against live data

The RL executor in its current form (untested environment, no validated reward function, no comparison to rule-based baseline) should be classified as **RESEARCH_ONLY** until the above conditions are met.
