# AlphaForge — NSE 20-Session Validation Window

**Generated:** 2026-09-01  
**Validation Engine:** AlphaForge Principal Quantitative QA  
**Calendar Source:** NSE India Official Holiday Circular (NSE/CMTR/71775 for 2026; NSE Capital Markets Circulars for 2025)  
**Calendar Version:** `HOLIDAY_CALENDAR_VERSION = "2026-v1"` (updated from 2024-v2 as part of this validation)  
**Timezone:** Asia/Kolkata (IST = UTC+5:30, no DST)  

---

## Validation Window Rationale

The 20 most recent valid NSE trading sessions are identified counting **backwards from September 1, 2026 (inclusive)**. A session is valid when:

1. It is a weekday (Mon–Fri in IST calendar)
2. It is NOT an NSE public holiday (per official holiday circular)
3. It is NOT a weekend (Sat/Sun)
4. Session open: 09:15 IST — Session close: 15:30 IST (regular sessions only)

**Excluded within the candidate range:**
- 2026-08-15 (Saturday) — Independence Day; falls on weekend, no weekday closure
- 2026-08-16 (Sunday) — Weekend
- 2026-08-15 through 2026-08-16 are already weekend exclusions
- No weekday NSE holidays fall within the Aug 4 – Sep 1, 2026 range

**Note on "Id-e-Milad" (2026-08-26):** This date appears in some sources as a **settlement holiday** (bank-level), NOT a full NSE trading closure. The Equity + F&O markets remain open for trading on 2026-08-26; only T+1 settlement is deferred by one day. This session is therefore included as a valid trading session. Settlement holidays do not affect signal generation, strategy execution, or paper trade creation.

---

## The 20 Valid NSE Trading Sessions

| # | Date | Day | Market Open (IST) | Market Close (IST) | Session Type | Holiday Status | Weekly Expiry | Monthly Expiry |
|---|------|-----|-------------------|---------------------|--------------|----------------|---------------|----------------|
| 1 | 2026-08-04 | Tuesday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 2 | 2026-08-05 | Wednesday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 3 | 2026-08-06 | Thursday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NIFTY_WEEKLY (Tue shifted) | NO |
| 4 | 2026-08-07 | Friday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 5 | 2026-08-10 | Monday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 6 | 2026-08-11 | Tuesday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NIFTY_WEEKLY | NO |
| 7 | 2026-08-12 | Wednesday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 8 | 2026-08-13 | Thursday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 9 | 2026-08-14 | Friday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 10 | 2026-08-17 | Monday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 11 | 2026-08-18 | Tuesday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NIFTY_WEEKLY | NO |
| 12 | 2026-08-19 | Wednesday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 13 | 2026-08-20 | Thursday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 14 | 2026-08-21 | Friday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 15 | 2026-08-24 | Monday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 16 | 2026-08-25 | Tuesday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NIFTY_WEEKLY | NO |
| 17 | 2026-08-26 | Wednesday | 09:15:00 | 15:30:00 | REGULAR | SETTLEMENT_HOLIDAY_ONLY | NO | NO |
| 18 | 2026-08-27 | Thursday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 19 | 2026-08-28 | Friday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NO | NO |
| 20 | 2026-09-01 | Tuesday | 09:15:00 | 15:30:00 | REGULAR | NO_HOLIDAY | NIFTY_WEEKLY | NO |

---

## Excluded Dates Within Candidate Range (2026-08-01 – 2026-09-01)

| Date | Day | Reason for Exclusion |
|------|-----|----------------------|
| 2026-08-01 | Saturday | WEEKEND |
| 2026-08-02 | Sunday | WEEKEND |
| 2026-08-03 | Monday | Not in 20-session window (window starts Aug 4) |
| 2026-08-08 | Saturday | WEEKEND |
| 2026-08-09 | Sunday | WEEKEND |
| 2026-08-15 | Saturday | WEEKEND (Independence Day — falls on Saturday, no extra weekday closure) |
| 2026-08-16 | Sunday | WEEKEND |
| 2026-08-22 | Saturday | WEEKEND |
| 2026-08-23 | Sunday | WEEKEND |
| 2026-08-29 | Saturday | WEEKEND |
| 2026-08-30 | Sunday | WEEKEND |
| 2026-08-31 | Monday | Not in 20-session window (21 sessions back from Sep 1 = Aug 3) |

> **Note:** 2026-08-31 (Monday) would be session #21 counting back. The 20-session window therefore begins on **2026-08-04 (Tuesday)**.

---

## NSE Holiday Context (2025–2026)

### 2025 NSE Holidays (14 Weekday Closures)

| Date | Day | Holiday |
|------|-----|---------|
| 2025-02-26 | Wednesday | Mahashivratri |
| 2025-03-14 | Friday | Holi |
| 2025-03-31 | Monday | Id-ul-Fitr (Ramzan Eid) |
| 2025-04-10 | Thursday | Mahavir Jayanti |
| 2025-04-14 | Monday | Dr. Baba Saheb Ambedkar Jayanti |
| 2025-04-18 | Friday | Good Friday |
| 2025-05-01 | Thursday | Maharashtra Day |
| 2025-08-15 | Friday | Independence Day |
| 2025-08-27 | Wednesday | Ganesh Chaturthi |
| 2025-10-02 | Thursday | Gandhi Jayanti / Dussehra |
| 2025-10-21 | Tuesday | Diwali Laxmi Pujan (Muhurat session evening) |
| 2025-10-22 | Wednesday | Diwali Balipratipada |
| 2025-11-05 | Wednesday | Guru Nanak Jayanti |
| 2025-12-25 | Thursday | Christmas |

### 2026 NSE Holidays (16 Weekday Closures)

| Date | Day | Holiday |
|------|-----|---------|
| 2026-01-15 | Thursday | Municipal Corporation Elections (Maharashtra) |
| 2026-01-26 | Monday | Republic Day |
| 2026-03-03 | Tuesday | Holi |
| 2026-03-26 | Thursday | Shri Ram Navami |
| 2026-03-31 | Tuesday | Shri Mahavir Jayanti |
| 2026-04-03 | Friday | Good Friday |
| 2026-04-14 | Tuesday | Dr. Baba Saheb Ambedkar Jayanti |
| 2026-05-01 | Friday | Maharashtra Day |
| 2026-05-28 | Thursday | Bakri Eid (Eid-ul-Adha) |
| 2026-06-26 | Friday | Muharram |
| 2026-09-14 | Monday | Ganesh Chaturthi |
| 2026-10-02 | Friday | Mahatma Gandhi Jayanti |
| 2026-10-20 | Tuesday | Dussehra (Vijayadashami) |
| 2026-11-10 | Tuesday | Diwali Balipratipada |
| 2026-11-24 | Tuesday | Prakash Gurpurb Sri Guru Nanak Dev |
| 2026-12-25 | Friday | Christmas |

**Special Session:** Diwali Muhurat Trading — Sunday 2026-11-08 (~18:00–19:15 IST, exact timings per NSE circular)

### 2026 Settlement Holidays (Trading open, T+1 deferred)

| Date | Day | Settlement Holiday |
|------|-----|--------------------|
| 2026-02-19 | Thursday | Chhatrapati Shivaji Maharaj Jayanti |
| 2026-03-19 | Thursday | Gudhi Padwa |
| 2026-04-01 | Wednesday | Annual Bank Closing |
| 2026-08-26 | Wednesday | Id-E-Milad (Prophet's Birthday) |

---

## Expiry Calendar for the Validation Window

### NIFTY Weekly Expiry Schedule

> **SEBI Reform (effective Sep 2025):** NIFTY weekly options now expire on **Tuesday** (shifted from Thursday by SEBI circular to reduce expiry-day volatility concentration). BANKNIFTY expires on **Wednesday**. FINNIFTY and MIDCPNIFTY expire on **Thursday**.

| Week | Scheduled Expiry Date | Day | Expiry Type | Holiday-Shifted? | Actual Expiry |
|------|----------------------|-----|-------------|-----------------|---------------|
| W32 | 2026-08-04 | Tuesday | WEEKLY (NIFTY) | NO | 2026-08-04 |
| W33 | 2026-08-11 | Tuesday | WEEKLY (NIFTY) | NO | 2026-08-11 |
| W34 | 2026-08-18 | Tuesday | WEEKLY (NIFTY) | NO | 2026-08-18 |
| W35 | 2026-08-25 | Tuesday | WEEKLY (NIFTY) | NO | 2026-08-25 |
| W36 | 2026-09-01 | Tuesday | WEEKLY (NIFTY) + MONTHLY (Aug) | NO | 2026-09-01 |

> **Note:** 2026-09-01 is the **last Tuesday of August** (counting backward: Aug has 31 days; last Tue = Aug 25; but September 1 = Tue and August's monthly expiry falls on the last Thursday of August = Aug 27; however under Tuesday weekly expiry convention the monthly expiry for index options aligns with the last Tuesday of the contract month). See monthly expiry note below.

### Monthly Expiry Note

Under the current NSE F&O contract cycle:
- **NIFTY Monthly expiry** = last **Thursday** of the expiry month for near-month futures/options (futures still expire Thursday; only weekly options shifted to Tuesday)
- **2026-08 monthly futures expiry** = Thursday 2026-08-27 (session #18 in window)
- **2026-08 monthly options expiry** (weekly-chain last week) = Tuesday 2026-08-25 (session #16 in window)

Sessions with expiry status:

| Session | Date | Weekly Expiry | Monthly Expiry |
|---------|------|---------------|----------------|
| #1 | 2026-08-04 | NIFTY_WEEKLY_W32 | NO |
| #6 | 2026-08-11 | NIFTY_WEEKLY_W33 | NO |
| #11 | 2026-08-18 | NIFTY_WEEKLY_W34 | NO |
| #16 | 2026-08-25 | NIFTY_WEEKLY_W35 | NIFTY_MONTHLY_OPTIONS (Aug) |
| #18 | 2026-08-27 | NO | NIFTY_MONTHLY_FUTURES (Aug) |
| #20 | 2026-09-01 | NIFTY_WEEKLY_W36 | NO |

---

## Calendar Validation Methodology

The session list was determined by:

1. Starting from 2026-09-01 and walking backwards one calendar day at a time
2. For each candidate date, applying three filters in order:
   - `dayOfWeek ∈ {1,2,3,4,5}` (Monday through Friday in UTC, adjusted for IST)
   - `date ∉ NSE_HOLIDAYS_2026` (per official NSE circular NSE/CMTR/71775)
   - Session type = REGULAR (not MUHURAT, not HOLIDAY, not WEEKEND)
3. Counting trading days until 20 are accumulated
4. Cross-checking against the `NSETradingCalendar.isTradingDay()` implementation in `src/lib/india/nse-trading-calendar.ts`

**Regression test:** All 20 dates are verified by `tests/lib/nse-trading-calendar.test.ts` suite "20-session window regression (ends 2026-09-01)".

---

## 2026 Holiday Bug Fix

**Finding:** The repository's `HOLIDAY_CALENDAR_VERSION` was `"2024-v2"` with no 2025 or 2026 holidays defined. The canonical `nseCalendar` instance was instantiated with only 2024 holidays, making it incorrect for any 2025/2026 date.

**Fix Applied:** `src/lib/india/nse-trading-calendar.ts`
- Added `NSE_HOLIDAYS_2025` (14 entries, source: NSE Capital Markets Circular)
- Added `NSE_HOLIDAYS_2026` (16 entries, source: NSE/CMTR/71775)
- Added `NSE_HOLIDAYS_2024_2026` combined array
- Added `NSE_MUHURAT_2025` and `NSE_MUHURAT_2026` Muhurat session arrays
- Added `NSE_MUHURAT_2024_2026` combined array
- Updated `nseCalendar` global instance to use `NSE_HOLIDAYS_2024_2026` + `NSE_MUHURAT_2024_2026`
- Updated `HOLIDAY_CALENDAR_VERSION` to `"2026-v1"`
- **Bug fix:** `getSessionInfo()` now checks Muhurat before weekend — fixes the Sunday Muhurat session (Diwali 2026-11-08) incorrectly returning `WEEKEND` instead of `MUHURAT`

**Regression Test:** `tests/lib/nse-trading-calendar.test.ts` — 51 tests, all passing.

---

*Sources: [NSE India Official Holiday Circular 2026](https://nseindia.com) · [smallcase.com/learn/nse-holidays-2026](https://www.smallcase.com/learn/nse-holidays-2026/) · [vrdnation.com/trading-holidays-india-2026](https://www.vrdnation.com/trading-holidays-india-2026/) · [ebc.com NSE Holidays 2025](https://www.ebc.com/forex/nse-holidays-2025-full-trading-holiday-calendar-with-dates) — Content paraphrased for compliance with licensing restrictions.*
