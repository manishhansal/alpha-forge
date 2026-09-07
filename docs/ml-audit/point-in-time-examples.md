# Point-in-Time Correctness: Concrete Examples

**Date:** 2026-09-06  
**Purpose:** Demonstrate why each PIT invariant is correct with real NSE market scenarios.

The fundamental invariant: `available_time <= prediction_time`

---

## Example 1 — Daily Bhavcopy (Most Common Case)

**Scenario:** Training a model to predict stock performance on 2023-06-02 (Friday) using data from 2023-06-01 (Thursday).

```
Market event:    RELIANCE closes at ₹2,456 on 2023-06-01 at 15:30 IST (10:00 UTC)
Bhavcopy published: 2023-06-01 at ~16:00 IST (10:30 UTC)
Model prediction: 2023-06-02 at market open, 09:15 IST (03:45 UTC)
```

**Correct PIT setup:**
```python
event_time    = datetime(2023, 6, 1, 10, 0, tzinfo=UTC)   # 15:30 IST close
available_time = datetime(2023, 6, 1, 10, 30, tzinfo=UTC)  # 16:00 IST Bhavcopy

# Prediction at market open next day (09:15 IST = 03:45 UTC on June 2)
prediction_time = datetime(2023, 6, 2, 3, 45, tzinfo=UTC)

# Invariant: available_time (10:30 UTC Jun 1) <= prediction_time (03:45 UTC Jun 2) ✅
assert available_time < prediction_time  # True
```

**What would be WRONG:** Using prediction_time = 2023-06-01 10:15 UTC (before Bhavcopy published)

```python
prediction_time_wrong = datetime(2023, 6, 1, 10, 15, tzinfo=UTC)
# available_time (10:30) > prediction_time_wrong (10:15) ← VIOLATION ❌
# A model predicting at 10:15 cannot use the 16:00 Bhavcopy data.
```

---

## Example 2 — NSE Expiry Day (Tuesday since Sep 2025)

**Scenario:** Options expiry effects on Tuesday 2025-09-02 (first NSE Tuesday expiry).

```
Weekly expiry: Tuesday 2025-09-02
Expiry data published: ~16:30 IST (11:00 UTC) — final settlement prices
A model running at 09:15 IST (03:45 UTC) on Sep 2 can use:
  - Monday Sep 1 closing data (available_time: Sep 1 10:30 UTC) ✅
  - Sep 2 pre-open data (if available) ✅
A model cannot use:
  - Sep 2 settlement data (available_time: Sep 2 11:00 UTC) ❌ — not yet published at 03:45 UTC
```

**Why this matters:** Expiry settlement prices and final OI data are published AFTER market close. Any feature derived from same-day expiry settlement is a look-ahead bug.

---

## Example 3 — Revision Selection (Corporate Data Correction)

**Scenario:** NSE corrects a Bhavcopy error for HDFCBANK on 2023-03-15.

```
Revision 0 (original):
  available_time = 2023-03-15 10:30 UTC
  close = 1,620.45  (original value)

Revision 1 (correction):
  available_time = 2023-03-15 15:30 UTC  (correction published 6 hours later)
  close = 1,623.10  (corrected value)
```

**Correct revision selection:**

```python
# Model prediction at 11:00 UTC (before correction published):
pred_time_1 = datetime(2023, 3, 15, 11, 0, tzinfo=UTC)
best = select_best_revision([rev0, rev1], pred_time_1)
# → Rev 0 (available_time 10:30 <= 11:00)
# → close = 1,620.45  ← This is what a trader actually saw at 11:00

# Model prediction at 16:00 UTC (after correction published):
pred_time_2 = datetime(2023, 3, 15, 16, 0, tzinfo=UTC)
best = select_best_revision([rev0, rev1], pred_time_2)
# → Rev 1 (available_time 15:30 <= 16:00, higher revision_id)
# → close = 1,623.10  ← Correction was available by 16:00
```

**Why this is correct:** A model trained to predict Thursday's performance using Wednesday's data will always use the version of Wednesday's data that was available at the prediction time — not a "hindsight" corrected version published days later.

---

## Example 4 — Corporate Action (2:1 Split)

**Scenario:** RELIANCE announces a 2:1 bonus on 2024-05-10 (announced), effective 2024-05-24.

```
announcement_date  = 2024-05-10  (publicly known from this date)
availability_date  = 2024-05-10  (AlphaForge has it the same day)
effective_date     = 2024-05-24  (exchange adjusts prices on this date)
adjustment_factor  = 0.5         (pre-split price × 0.5 = adjusted price)
```

**Query 1:** "What was the adjusted RELIANCE price on 2024-05-07 as of 2024-05-07?"
```
prediction_date = 2024-05-07
# Corporate action not yet announced on May 7 → NOT applicable
status = NOT_REQUIRED (or DATA_UNAVAILABLE if no store)
price = raw_price (2024-05-07 close, unadjusted)
```

**Query 2:** "What was the adjusted RELIANCE price on 2024-05-07 as of 2024-06-01?"
```
prediction_date = 2024-06-01
# Corporate action announced May 10, effective May 24
# query_date (May 7) < effective_date (May 24) → applies to historical data
# announcement_date (May 10) < prediction_date (June 1) → was known by prediction_date
status = ADJUSTED
adjusted_price = raw_price × 0.5
```

**Why the distinction matters:** A model trained in June 2024 should see the split-adjusted RELIANCE price for May 7 (because by June, the split is known). But a model prediction running on May 7 itself must NOT see the split adjustment (not yet announced).

---

## Example 5 — F&O Ban (OI Signal Distortion)

**Scenario:** TESTSTOCK was in the NSE F&O ban list on 2023-09-15 (OI exceeded 95% of MWPL).

```
During ban: Only closing trades allowed → OI can only decrease
PCR on ban day = 0.4 (put heavy) — but this is DISTORTED because:
  - New put writers cannot open positions
  - Existing put holders are closing, inflating put OI decline
  - Normal PCR signal is unreliable
```

**Without ban awareness:** The ML model sees PCR = 0.4 and might interpret it as extreme bearishness (a signal). But the true interpretation is "ban-distorted data with no predictive content."

**With ban awareness:**
```python
state = store.get_fno_state("TESTSTOCK", date(2023, 9, 15))
if state.ban_status == BanStatus.BANNED:
    # PCR and OI signals are unreliable
    # Option 1: exclude this observation from training
    # Option 2: add is_banned=True feature and let model learn
    pass
elif state.ban_status == BanStatus.DATA_UNAVAILABLE:
    # Cannot confirm — log WARNING; include with caveat in DatasetSnapshot
    pass
```

---

## Example 6 — Historical Lot Size (SEBI Nov 2024 Change)

**Scenario:** Computing GEX (Gamma Exposure) for NIFTY on 2023-01-15 and 2025-01-15.

```
GEX = gamma × OI × lot_size × spot²

For 2023-01-15:
  NIFTY lot_size = 50  (pre-SEBI Nov 2024 revision)
  OI = 1,200,000 contracts

For 2025-01-15:
  NIFTY lot_size = 75  (post-SEBI Nov 2024 revision)
  OI = 1,200,000 contracts
```

**Using today's lot size (WRONG for 2023 data):**
```python
# Static dict: LOT_SIZES["NIFTY"] = 75 (today's value)
gex_wrong = gamma × 1_200_000 × 75 × spot²  # Wrong for Jan 2023
```

**Using historical lot size (CORRECT):**
```python
lot, status, _ = store.get_lot_size("NIFTY", date(2023, 1, 15))
# lot = 50, status = "OK"
gex_correct = gamma × 1_200_000 × 50 × spot²
```

**Impact:** Using today's lot size for 2023 data inflates GEX by 50% (75/50). This creates a systematic bias in any model feature derived from OI in notional terms.

---

## Example 7 — Naive Timestamp (Silent Timezone Bug)

**Scenario:** OHLCV data fetched from a provider returns timestamps without timezone info.

```python
# Raw data from provider
df = pd.DataFrame({
    "close": [2456.0, 2462.0],
    "volume": [1_000_000, 1_200_000],
}, index=pd.DatetimeIndex(["2023-06-01 10:00:00", "2023-06-02 10:00:00"]))  # no tz!

# The string "10:00:00" is ambiguous — is this IST? UTC? US Eastern?
# In India: 10:00 IST is during pre-market (market opens at 09:15 IST)
# As UTC: 10:00 UTC is the NSE close (15:30 IST)
# These are completely different instants
```

**The PIT invariant check:**
```python
gate = MLDataQualityGate()
report = gate.check_ohlcv(df, symbol="RELIANCE")
# → CRITICAL: "DataFrame DatetimeIndex has no timezone. Use tz_localize('UTC')."
# → report.is_blocked == True
```

**Correct fix:**
```python
df.index = df.index.tz_localize("UTC")   # or "Asia/Kolkata" if IST
```

---

## Example 8 — Survivorship Bias (Universe Selection)

**Scenario:** Training a ranking model on 2020-2024 data.

The current `TRAINING_UNIVERSE` contains JIOFIN — but JIOFIN was only listed on NSE in July 2023. Including it in the 2020-2022 training data creates a selection bias: the model learns characteristics of "stocks that will eventually be large and liquid" rather than "stocks that were available to trade."

**Correct approach (when historical eligibility data is available):**
```python
universe_at_2021 = store.get_model_eligible_symbols(date(2021, 1, 15))
# Would NOT contain JIOFIN (not yet listed)
# Would NOT contain stocks delisted during 2020-2024
# Would CONTAIN stocks removed from F&O in 2023 (like some mid-caps)
```

**Current status:** DATA_UNAVAILABLE for historical eligibility. The fallback is the current list with a WARNING. Every `DatasetSnapshot` explicitly documents this limitation:

```json
"limitations": [
  "UNIVERSE_SURVIVORSHIP_BIAS: TRAINING_UNIVERSE is today's F&O list; historical eligibility data is DATA_UNAVAILABLE."
]
```

---

## Summary: Why Each Invariant Is Critical

| Invariant | Risk if violated | Test that proves it |
|---|---|---|
| `available_time <= prediction_time` | Model sees future price data | `test_record_with_available_after_prediction_fails` |
| No naive timestamps | UTC/IST confusion; 5.5-hour offset errors | `test_naive_event_time_rejected_in_create` |
| Historical lot sizes | GEX / OI notional computations are wrong for historical dates | `test_future_lot_change_does_not_alter_past_query` |
| Revision selection: latest available ≤ query_time | Wrong data used; future corrections distort historical training | `test_earlier_revision_used_at_earlier_time` |
| Corporate action: announcement_date < prediction_date | Adjusted prices used before adjustment was public knowledge | `test_future_split_does_not_adjust_pre_announcement_prices` |
| F&O ban DATA_UNAVAILABLE (no fabrication) | False "not banned" signals for dates where ban history is unknown | `test_empty_store_returns_data_unavailable` |
| Dataset snapshot records limitations | False impression of clean data; undocumented survivorship bias | `test_default_limitations_are_present` |
| Same fingerprint for same inputs | Model artifacts cannot be reproduced without matching inputs | `test_same_inputs_produce_same_fingerprint` |
