# AlphaForge Data Service — Live Session Data Quality Report

**Report Date:** 2026-09-03T16:35:23Z  
**Certification Commit:** `dff450327c443ee4a76eb218e0c67d3a15ddcdce`  
**Environment:** macOS development — `www.nseindia.com` geo-blocked; `nsearchives.nseindia.com` (CDN) accessible  
**Test Label:** REAL_NETWORK (NSE Bhavcopy CDN) + REAL_REDIS (localhost:6399)

---

## Network Connectivity Assessment

| Endpoint | Status | Notes |
|---|---|---|
| `www.nseindia.com` (NextApi) | CONNECTION_BLOCKED | DNS resolves but TCP connect times out — geo/IP filtered from this environment |
| `charting.nseindia.com` | CONNECTION_BLOCKED | Same geo-block |
| `nsearchives.nseindia.com` (Bhavcopy CDN) | ✅ ACCESSIBLE | HTTP 200 in 462ms, 396KB CSV |
| `redis://localhost:6399` | ✅ ACCESSIBLE | Installed via Homebrew, 8/8 real Redis tests pass |

**Root cause of NSE NextApi block:** The development machine's IP (49.42.7.201) is geo-filtered by NSE's CDN/WAF for the interactive API endpoints. The CDN-served Bhavcopy archive files are served without geo-restriction.

**Impact:** Live tick quotes (NIFTY, BANKNIFTY, equity) cannot be validated from this environment. Historical daily Bhavcopy data (daily OHLCV) is accessible and validated.

---

## Section 1: Real NSE Bhavcopy Data (2026-09-01)

**URL:** `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_01092026.csv`  
**Fetch latency:** 462ms (P50 across 2 runs: ~480ms)  
**Data SHA-256:** `1e47f1836c1ba6b94acc80d82483f50832f1ea7df6dcee7ac902fff3b03fe80d`  
**Evidence label:** REAL_NETWORK

### Row Counts

| Category | Count |
|---|---|
| Total CSV rows | 3,495 |
| EQ series rows | 2,646 |
| Other series (GS, BE, BL, etc.) | 849 |

### Semantic Validation Results

| Check | Result | Evidence |
|---|---|---|
| Valid OHLC invariants (H≥max(O,C), L≤min(O,C)) | ✅ 2,646/2,646 (100%) | REAL_NETWORK |
| Zero-price rows | ✅ 0 | REAL_NETWORK |
| Negative volume rows | ✅ 0 | REAL_NETWORK |
| OI = null for EQ series | ✅ All null | REAL_NETWORK — confirmed semantic fix |
| Validity rate | **100%** | REAL_NETWORK |

### Sample Quotes (2026-09-01, EQ Series)

| Symbol | prevClose | Open | High | Low | Close | Volume | OI |
|---|---|---|---|---|---|---|---|
| RELIANCE | 1,277.0 | 1,285.0 | 1,311.8 | 1,280.0 | **1,309.0** | 12,617,528 | null ✅ |
| HDFCBANK | 709.0 | 705.05 | 715.45 | 698.5 | **711.9** | 44,417,092 | null ✅ |
| ICICIBANK | 1,454.0 | 1,442.9 | 1,446.7 | 1,422.8 | **1,438.0** | 10,627,608 | null ✅ |
| TCS | 2,399.3 | 2,355.0 | 2,372.0 | 2,325.0 | **2,369.0** | 2,678,034 | null ✅ |
| INFY | 1,133.8 | 1,128.0 | 1,156.0 | 1,125.6 | **1,156.0** | 13,516,123 | null ✅ |
| SBIN | 1,060.0 | 1,051.3 | 1,051.3 | 1,027.1 | **1,034.5** | 7,605,132 | null ✅ |
| WIPRO | 184.5 | 181.0 | 182.1 | 178.5 | **181.7** | 6,813,425 | null ✅ |
| AXISBANK | 1,300.0 | 1,274.9 | 1,275.1 | 1,255.0 | **1,258.0** | 5,588,158 | null ✅ |
| KOTAKBANK | 419.4 | 420.8 | 429.1 | 420.75 | **425.0** | 7,669,677 | null ✅ |
| BAJFINANCE | 1,057.0 | 1,065.0 | 1,067.0 | 1,047.0 | **1,053.9** | 4,813,301 | null ✅ |

**Key semantic observation:** `oi = null` for all EQ series rows — confirming the V2.0 semantic fix is correct. NSE Bhavcopy equity data does not provide open interest. The 2646 valid rows all pass OHLC invariants with zero violations.

### Holiday Detection

| Date | Expected | Actual HTTP Status | Correct |
|---|---|---|---|
| 2026-08-29 (Saturday) | 404 (no market) | 404 | ✅ YES |
| 2026-09-01 (Tuesday) | 200 (trading day) | 200 | ✅ YES |

The historical scraper correctly handles 404 responses by skipping the date (holiday/weekend detection works as designed).

---

## Section 2: Timestamp Ordering Validation

From the real Bhavcopy fetch (2026-09-03T16:35:23Z):

| Timestamp | Value (UTC ms) |
|---|---|
| receivedAtMs | 1,788,453,323,254 |
| availableAtMs | 1,788,453,323,716 |
| nowMs | 1,788,453,323,725 |

**Ordering verified:** `receivedAtMs (254) ≤ availableAtMs (716) ≤ nowMs (725)` ✅

**Note on eventTimeMs:** Bhavcopy is end-of-day historical data. Per V2 schema contract, `eventTimeMs = None` for daily Bhavcopy (correct — cannot derive per-tick event time from a daily summary file). The lineage record correctly records `event_time_ms = None` for this data type.

---

## Section 3: Real Redis Streams (localhost:6399)

All 8 real Redis tests passed in 0.79s:

| Test | Result | Evidence |
|---|---|---|
| XADD → XRANGE round trip | ✅ PASS | REAL_REDIS |
| Publish 10 events, replay 20 missed (exclusive range) | ✅ PASS | REAL_REDIS |
| Stream bounded at MAX_STREAM_LEN (MAXLEN ~= ) | ✅ PASS | REAL_REDIS |
| Per-symbol stream populated (NIFTY/BANKNIFTY/RELIANCE) | ✅ PASS | REAL_REDIS |
| tickId present in every stream entry (dedup support) | ✅ PASS | REAL_REDIS |
| Consumer lag metrics reflect real stream state | ✅ PASS | REAL_REDIS |
| Both pub/sub AND stream receive same tick | ✅ PASS | REAL_REDIS |
| No silent corruption in replayed payloads (ltp preserved) | ✅ PASS | REAL_REDIS |

**Delivery semantics confirmed:** AT_LEAST_ONCE — consumer processes all events after reconnect with no duplicates when using exclusive range `(last_id`.

**Fix applied:** `stream_publisher.get_ticks_since()` now uses exclusive range `(last_id` (not `last_id`) to prevent re-delivering the last-seen event on reconnect. This is the correct Redis XRANGE semantic.

**Recovery scenario verified:**
```
Published: 30 events (10 before "outage", 20 after)
Consumer saw: 10 events (last_id recorded)
Missed: 20 events (consumer "offline")
Replayed: 20 events (strict after last_id)
Duplicates: 0
```

---

## Section 4: Coverage Assessment

### Historical Daily Data (NSE Bhavcopy CDN)

| Metric | Value | Label |
|---|---|---|
| EQ series instruments | 2,646 | REAL_NETWORK |
| Valid observations | 2,646 (100%) | REAL_NETWORK |
| Coverage rate (EQ) | 100% | REAL_NETWORK |
| F&O coverage (daily OI) | NOT AVAILABLE | Bhavcopy EQ has no OI |

**F&O coverage for live trading:** Cannot be measured from this environment because `www.nseindia.com` (NextApi) is geo-blocked. Daily Bhavcopy confirms 2,646 EQ instruments with valid OHLCV data on any given trading day. The F&O subset (option chains, live OI) requires the interactive NextApi endpoints which are inaccessible from this machine's IP.

---

## Section 5: Data Quality Score Calibration

Score monotonicity verified in integration tests (26 gate tests):

| Score Range | Data Condition | signalEngineAllowed |
|---|---|---|
| 90–95 | Fresh (1–2s), complete, provider healthy | True |
| 70–89 | Aging (5–15s), mostly complete | True if ≥80% complete |
| 50–69 | Degraded (15–30s) or incomplete | False (below threshold) |
| 0–49 | Stale (>30s), provider down, or timestamps invalid | False |

**Score cap verified:** Maximum score is 95 (never 100) — inherent uncertainty in market data. Confirmed by unit tests.

---

## Section 6: Live Tick Data Quality (NOT_TESTED)

The following metrics require a live NSE session and accessible `www.nseindia.com`:

| Metric | Status |
|---|---|
| P50 quote freshness (live NIFTY ticks) | NOT_TESTED |
| P95 quote freshness | NOT_TESTED |
| P99 quote freshness | NOT_TESTED |
| Max quote age during session | NOT_TESTED |
| Quote stale rate | NOT_TESTED |
| Gap rate (ticks/minute) | NOT_TESTED |
| Duplicate tick rate | NOT_TESTED |
| F&O usable coverage % | NOT_TESTED |
| Signal-capable coverage % | NOT_TESTED |
| TTFD (time-to-first-valid-data) | NOT_TESTED |
| Market-open (09:15 IST) behavior | NOT_TESTED |

---

## Summary

| Category | Status | Evidence Level |
|---|---|---|
| Historical daily data semantics (OI=null for EQ) | ✅ VERIFIED | REAL_NETWORK |
| OHLC invariants on live NSE data (2,646 rows) | ✅ VERIFIED (100%) | REAL_NETWORK |
| Holiday detection (weekend 404) | ✅ VERIFIED | REAL_NETWORK |
| Timestamp ordering (receivedAt ≤ availableAt ≤ now) | ✅ VERIFIED | REAL_NETWORK |
| Redis Streams recovery (10 → outage → replay 20) | ✅ VERIFIED | REAL_REDIS |
| AT_LEAST_ONCE exclusive range semantics | ✅ VERIFIED | REAL_REDIS |
| Live tick freshness measurements | ❌ NOT_TESTED | requires accessible www.nseindia.com |
| F&O coverage % | ❌ NOT_TESTED | requires live NSE session |
| TTFD | ❌ NOT_TESTED | requires live market open |
