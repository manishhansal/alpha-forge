# India Execution Methodology

**Document type:** ML Research — Methodology  
**Phase:** 3G  
**Last updated:** 2026-09-06  
**Scope:** NSE equity and F&O execution simulation for backtesting

---

## 1. Overview

This document describes the execution methodology used in the AlphaForge backtesting engine
for Indian equity and F&O markets.  It covers:

- Transaction cost structure (regulatory)
- Slippage model selection rationale
- Execution timing conventions
- NSE-specific constraints (expiry, F&O ban, circuit limits, lot sizes)
- Market calendar handling

---

## 2. Transaction Cost Structure

### 2.1 Regulatory framework

NSE trades are subject to the following charges, all governed by SEBI and the exchange:

| Charge | Governing body | Applicable to |
|--------|---------------|--------------|
| STT (Securities Transaction Tax) | Income Tax Act / Union Budget | Equity delivery, intraday, F&O sell |
| Exchange transaction charges | NSE | All segments |
| SEBI regulatory fee | SEBI | All segments |
| Stamp duty | State governments (Maharashtra) | Buy side only |
| GST | GST Act | On brokerage + exchange charges |
| Brokerage | Broker policy | All trades |

### 2.2 Budget 2023-24 STT changes (effective Oct 2023)

The Union Budget 2023-24 revised STT on F&O:

| Instrument | Pre-Oct 2023 | Post-Oct 2023 |
|------------|-------------|--------------|
| Futures (sell) | 0.01% | 0.0125% |
| Options (sell premium) | 0.05% | 0.0625% |

The cost model maintains two versioned schedules (`india-fno-2020`, `india-fno-2023`) and
selects the correct one by trade date via `CostScheduleRegistry.get_for_date()`.

### 2.3 GST applicability

GST (18%) applies **only** to:
- Brokerage
- Exchange transaction charges

It does **not** apply to STT, SEBI charges, or stamp duty.  This is consistent with
CBIC GST circular No. 180/12/2022-GST.

### 2.4 Stamp duty

Stamp duty is charged **on the buy side only** (Maharashtra Electronic Stamp Act).
Rate: 0.015% for equity, 0.003% for F&O.

---

## 3. Slippage Model Rationale

Four slippage models are available, ordered by increasing sophistication and data requirement.

### 3.1 Model A — FixedBPS

```
slippage_cost = fill_price × (fixed_bps / 10_000) × quantity
```

**When to use:** When no HL/volume/volatility data is available. Provides a flat cost floor.  
**Default parameter:** 5 bps one-way (10 bps round-trip).  
**Limitation:** Ignores order size and market conditions entirely.  
**Evidence quality:** `SpreadDataStatus.PROXY` (D-evidence, not observed).

### 3.2 Model B — SpreadProxy (HL range)

```
hl_spread_pct = (high - low) / close
half_spread_bps = hl_spread_pct / 2 × 10_000 × volume_adjustment
```

**When to use:** When daily OHLCV data is available but no tick-level spread data.  
**Rationale:** The HL range is a well-established proxy for intraday spread width.
Volume adjustment narrows the proxy for high-ADV instruments.  
**Limitation:** HL range includes directional price movement, so it overstates
the bid-ask spread. This is intentional — it errs on the conservative side.  
**Evidence quality:** `SpreadDataStatus.PROXY` (C-evidence).

### 3.3 Model C — VolatilityParticipation

```
sigma = ATR / close   (ATR as proxy for daily volatility)
slippage_bps = coefficient × sigma_bps × sqrt(participation_rate)
```

**When to use:** When order size relative to ADV is non-trivial (>1%).  
**Rationale:** Based on the Almgren-Chriss market impact framework. Slippage grows
as the square root of participation rate, reflecting the increasing urgency and
market footprint of larger orders.  
**Default coefficient:** 0.5 (conservative).  
**Evidence quality:** `SpreadDataStatus.PROXY` (B-evidence, model-based).

### 3.4 Model D — MarketImpact (square-root)

```
impact_bps = eta × sigma_bps × sqrt(Q / ADV)
```

**When to use:** For strategies with >5% ADV participation. Provides a cleaner
quantitative model than Model C.  
**Rationale:** Square-root market impact is the industry standard for institutional
execution cost modeling (Almgren 2005, Grinold-Kahn).  
**Default eta:** 0.1.  
**Evidence quality:** `SpreadDataStatus.PROXY` (B-evidence).

### 3.5 Model selection guide

| Scenario | Recommended model |
|----------|-----------------|
| No market data at all | Model A (FixedBPS, 5 bps) |
| Daily OHLCV only, small orders | Model B (SpreadProxy) |
| Daily OHLCV, orders >1% ADV | Model C (VolatilityParticipation) |
| Large institutional orders >5% ADV | Model D (MarketImpact) |
| Real tick data available | Use observed spread directly |

---

## 4. Execution Timing Conventions

### 4.1 Default: NEXT_OPEN

A signal generated from `close(T)` executes at `open(T+1)`.  
This is the **only lookahead-free** execution policy and is the default.

**Rationale:** In practice, daily bar strategies generate signals after the close.
The earliest possible execution is the next session's open.

### 4.2 NEXT_BAR (close)

Execution at `close(T+1)`.  Used to model strategies where the full bar is needed
before deciding, and execution is via a closing auction.

### 4.3 NEXT_VWAP

Execution at the VWAP approximation: `(open + high + low + close) / 4`.  
This models participation throughout the bar rather than a single aggressive entry.

### 4.4 STOP / LIMIT

For stop-loss and limit orders within the next bar.  Gap-through logic applies:
if the next bar opens beyond the stop/limit, the fill is at the open (gap fill), not
at the stop/limit price.  This is the correct treatment for overnight gaps and
F&O opening auctions.

### 4.5 SAME_CLOSE (restricted)

Execution at `close(T)` — the same bar as the signal.  **Disabled by default.**
This can only be enabled by explicitly setting `FillEngineConfig.allow_same_close = True`.
It is provided for intrabar strategies only and must not be used for end-of-day signals.

---

## 5. NSE-Specific Constraints

### 5.1 Lot sizes

Post-SEBI circular Nov 2024 lot sizes are used by default:

| Index | Old lot | New lot |
|-------|---------|---------|
| NIFTY 50 | 50 | 75 |
| BANKNIFTY | 15 | 30 |
| FINNIFTY | 40 | 65 |
| MIDCPNIFTY | 75 | 120 |

**Point-in-time (PIT) warning:** Backtests using post-2024 lot sizes for trades
executed before Nov 2024 will have incorrect notional calculations.
Historical lot sizes should be supplied via `InstrumentMasterStore` for accurate PIT backtesting.

### 5.2 Contract expiry

NSE F&O contracts expire on:
- **Monthly expiry:** Last Thursday of the month
- **Weekly expiry (NIFTY/BANKNIFTY):** Every Thursday

The `NSECalendar` handles holiday collisions (if the last Thursday is a holiday,
expiry moves to Wednesday).

Orders on expired contracts are rejected with `FillStatus.REJECTED`.

### 5.3 F&O position limits / ban periods

When an instrument's aggregate OI exceeds SEBI position limits, NSE places it in
a ban period.  During the ban:
- New positions: **REJECTED**
- Closing positions: **ALLOWED**

The fill engine checks `fno_ban_dates: dict[str, set[date]]` supplied by the caller.

### 5.4 Circuit limits

NSE applies daily price bands (circuit limits) of 2%, 5%, 10%, or 20% depending
on the instrument.  The fill engine rejects orders where the fill price would be
outside the circuit band.

### 5.5 Market calendar

`NSECalendar` covers 2020–2026 with the full NSE holiday list including:
- Republic Day (26 Jan)
- Independence Day (15 Aug)
- Gandhi Jayanti (2 Oct)
- Diwali Muhurat trading (special session, treated as trading day)
- All gazetted national holidays

`next_trading_day(d)` correctly skips weekends **and** holidays.

**Out-of-range handling:** Dates before 2020 or after 2026 return
`CalendarDataStatus.INSUFFICIENT_EVIDENCE` rather than silently guessing.

---

## 6. Capacity and Participation

The fill engine enforces:

```
max_notional = ADV × max_participation_pct   (default: 10%)
```

If `order_notional > max_notional`:
- Reduce quantity to `floor(max_notional / (lot_size × fill_price))` lots
- Return `FillStatus.PARTIAL` with actual filled quantity
- If 0 lots result: return `FillStatus.UNAVAILABLE`

**Principle:** Never assume infinite liquidity.  Partial fills are real outcomes.

---

## 7. P&L Accounting

### 7.1 Gross P&L

```
gross_pnl = (exit_price - entry_price) × quantity × lot_size   (LONG)
gross_pnl = (entry_price - exit_price) × quantity × lot_size   (SHORT)
```

### 7.2 Net P&L

```
total_cost = entry_cost.total() + exit_cost.total()
net_pnl    = gross_pnl - total_cost
```

### 7.3 Reconciliation check

Every `TradeRecord` is validated on append to `ExecutionLedger`:
```
|net_pnl - (gross_pnl - total_cost)| < tolerance (₹0.01)
```

If validation fails, `ValueError` is raised. The ledger never contains
unreconciled trades.

---

## 8. References

- SEBI F&O position limit framework: [SEBI Circular CIR/MRD/DP/21/2010](https://www.sebi.gov.in)
- NSE Market Charges: [NSE Schedule of Charges](https://www.nseindia.com)
- Budget 2023-24 STT changes: Finance Bill 2023, Schedule II
- Almgren & Chriss (2001): "Optimal Execution of Portfolio Transactions"
- Grinold & Kahn (2000): "Active Portfolio Management"
- CBIC GST Circular 180/12/2022-GST: GST on stock broking services
