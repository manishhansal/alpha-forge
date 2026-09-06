# Backtest Audit: Transaction Costs, Execution Assumptions, and Market Realism

**Verification Date:** 2026-09-06  
**Method:** Grepping entire `ml-service/src/` for cost-related terms + reading all label generation and portfolio logic.

---

## 1. Transaction Cost Model

### 1.1 What Is Currently Modelled

**Result of exhaustive search:**

```bash
grep -rn "transaction_cost|brokerage|stt|STT|round_trip|slippage|exchange_charge|stamp_duty|gst|GST" src/
→ 0 results
```

**Finding: No transaction cost model exists anywhere in the ml-service.**

Every label, metric, and portfolio construction output is computed on gross returns before any costs.

### 1.2 What Should Be Modelled

For NSE F&O trading as of 2026, the realistic per-round-trip cost structure:

| Cost Component | Equity Delivery | Equity Intraday | F&O Futures | F&O Options (buy) |
|---|---|---|---|---|
| Brokerage | 0.05% or ₹20 flat | 0.05% or ₹20 flat | ₹20 flat/leg | ₹20 flat/leg |
| STT | 0.1% (sell) | 0.025% (sell) | 0.01% (sell side) | 0.1% on exercise/expiry ITM |
| Exchange charge (NSE) | 0.00345% | 0.00345% | 0.00345% | 0.00345% |
| SEBI charge | 0.0001% | 0.0001% | 0.0001% | 0.0001% |
| Stamp duty | 0.015% (buy) | 0.003% (buy) | 0.002% | 0.003% |
| GST on brokerage | 18% of brokerage | 18% of brokerage | 18% of brokerage | 18% of brokerage |
| **Typical round-trip** | **~0.35-0.45%** | **~0.15-0.25%** | **~0.10-0.20%** | **~0.25-0.45%** |
| Bid-ask slippage | 0.05-0.15% | 0.05-0.15% | 0.03-0.10% | 0.10-0.30% |
| **Total with slippage** | **~0.40-0.60%** | **~0.20-0.40%** | **~0.13-0.30%** | **~0.35-0.75%** |

### 1.3 Impact on Alpha Claims

Given the typical NSE F&O round-trip cost of 0.15-0.30%:

- Stock ranker labels are 5-day gross returns vs NIFTY
- A 5-day alpha of 0.2% gross = approximately 0% net after costs
- Any model showing gross alpha < 0.30% per 5-day trade has no net alpha

Since the system makes no claim about predicted alpha magnitude (only ranking), this is a structural issue: the ranking metric optimises gross ranking, not net-of-cost ranking.

**Impact: ALL model training is optimising for the wrong objective.**

---

## 2. Brokerage / Slippage in Execution

### 2.1 Risk Predictor Heuristic

In `_predict_heuristic()` in `risk_predictor.py`:

```python
base_stop_rate = 0.40  # ~40% of intraday trades hit their stop (empirical NSE)
```

This empirical base rate is documented but not sourced. There is no reference to actual NSE historical trade data. The base rate affects ALL risk predictions.

### 2.2 Stop Loss Simulation

In `generate_risk_labels()`:
```python
stop_price = entry - stop_atr_mult * atr_val
stop_hit = 1.0 if (fwd_low <= stop_price).any() else 0.0
```

**Issue:** Stop orders in practice fill below `stop_price` by the bid-ask spread. For a stop-market order on an F&O stock, slippage of 0.05-0.20% below the stop level is typical. The label assumes perfect fill at exactly `stop_price`, understating actual stop loss.

### 2.3 Kelly Position Sizing

In `_compute_position_size()`:
```python
kelly = (p * b - q) / b  # p=target_prob, b=RR, q=1-p
```

The Kelly formula requires accurate estimates of `p` (win probability) and `b` (win/loss ratio). Both are estimated from the uncalibrated heuristic risk model. Applying Kelly to uncalibrated probabilities produces positions that may be wildly over-sized or under-sized.

---

## 3. Market Impact

**Finding: No market impact model anywhere.**

For the TRAINING_UNIVERSE stocks (mostly large-cap NSE F&O), participation rates would be very small (1-5 lots out of 50,000-100,000 lots ADV), making market impact negligible. This is acceptable at small scale but should be documented.

---

## 4. Partial Fills

**Finding: No partial fill modelling.**

Labels assume all orders are fully filled at the stated price. In practice, limit orders may be partially filled or expire unfilled. For market orders, all fills are assumed immediate and complete.

**This is acceptable at the current scale** (small capital, liquid F&O stocks) but would need modelling for larger deployments.

---

## 5. Execution Latency

### 5.1 Signal-to-Order Latency

**Finding: No latency modelling.**

The RiskPredictor heuristic acknowledges time-of-session risk (`session_progress` feature) but there is no model of the delay between signal generation and order submission. For a system where signals are generated daily at end-of-day, this latency is typically small (minutes), but for intraday signals it could be material.

### 5.2 Same-Bar Execution

**Finding: Labels assume close-to-close execution.** The ranking label at bar `i` uses `close[i]` as the entry price. In practice:
- Daily signals generated at close of bar `i`
- Orders submitted at market open of bar `i+1`
- Execution at the opening price of bar `i+1`, not `close[i]`

The gap between `close[i]` and `open[i+1]` is the overnight gap, which can be 0.2-1.0% for typical F&O stocks. This is a systematic cost that is not modelled.

**Severity:** MEDIUM for daily signals. HIGH for event-driven signals near corporate announcements.

---

## 6. Can the System Execute at Information Available Only After the Signal?

### 6.1 Feature Generation Timing

In `server.py`, the inference server calls `compute_stock_features()` with the most recent N bars. For a daily signal generated at market close (15:30 IST):
- OHLCV data for the day is available immediately ✅
- OI data (NSE publishes after 16:00 IST) — small risk of using end-of-day OI for same-day signal ⚠️
- Breadth data — requires aggregation; timing varies ⚠️
- VIX data — real-time during trading hours ✅

**Finding:** For end-of-day signals, all required data should be available. For intraday signals, the timing of OI and breadth data publication creates a risk of using T+0 data that isn't actually available until after market close.

### 6.2 Inference Server Architecture

The `server.py` receives feature data as API request parameters — it trusts the caller to provide valid, point-in-time data. There is no timestamp validation that checks whether the features could actually be computed at the claimed timestamp.

**Risk:** A caller could pass end-of-day features to the inference server and claim they were computed at 10:00 AM, leading to apparent intraday signals that actually use end-of-day information.

---

## 7. Summary

| Backtest Component | Modelled? | Severity of Gap |
|---|---|---|
| Transaction costs (STT, brokerage, exchange) | ❌ No | 🔴 HIGH |
| Bid-ask slippage | ❌ No | 🔴 HIGH |
| Stop order slippage | ❌ No | 🟡 MEDIUM |
| Market impact | ❌ No (negligible at current scale) | 🟢 LOW |
| Partial fills | ❌ No | 🟢 LOW |
| Execution latency | ❌ No | 🟡 MEDIUM |
| Overnight gap cost | ❌ No | 🟡 MEDIUM |
| Same-bar execution assumption | ❌ No | 🟡 MEDIUM |
| F&O ban list | ❌ No | 🔴 HIGH (regulatory) |
| Corporate actions | ❓ Not verified | 🔴 HIGH |

**Conclusion:** The backtest infrastructure has a systematic positive bias because it models zero costs. Any model that appears profitable before Phase 3 must be treated as gross-only and discounted by the realistic round-trip cost of the trading strategy.

**All performance claims must carry the qualifier: "gross of NSE transaction costs, assuming perfect fills at signal price."**
