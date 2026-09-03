# AlphaForge Data Service — Chaos Test Report V2

**Date:** September 2026  
**Version:** 2.0.0

---

## Disclaimer

Chaos tests below are categorized as:
- **UNIT-TESTED** — covered by existing unit tests with mocks
- **DESIGNED** — system is architected to handle; not yet run against live infra
- **NOT_TESTED** — requires live environment

---

## Scenario Table

| # | Failure | Expected Behavior | System Design | Status |
|---|---------|------------------|---------------|--------|
| 1 | NSE timeout on quotes | Return HTTP 503 with retryable=true | asyncio.wait_for + timeout | UNIT-TESTED |
| 2 | NSE 403 on bhavcopy | Log warning, skip day, continue range | HTTP status dispatch | UNIT-TESTED |
| 3 | NSE 429 on charting API | Back off, log warning, return partial | Rate limiter + retry logic | DESIGNED |
| 4 | NSE 500 on NextApi | Return 503, circuit breaker records failure | Error propagation | UNIT-TESTED |
| 5 | DNS failure for NSE | httpx raises ConnectionError, return 503 | Exception handling | DESIGNED |
| 6 | Chromium crash | RuntimeError from Scrapling, return 503 | Exception handling in get_chain_session | DESIGNED |
| 7 | Chromium timeout on option chain | asyncio.TimeoutError → fallback to FetcherSession | 15s timeout + fallback | UNIT-TESTED |
| 8 | Redis outage during publish | Switches to reconnecting mode, exponential backoff | TickPublisher reconnect loop | UNIT-TESTED |
| 9 | Redis reconnect after outage | Resumes publishing, logs recovery | Exponential backoff 1s→30s | UNIT-TESTED |
| 10 | Network disconnect mid-request | httpx raises, return cached or 503 | Redis cache fallback | DESIGNED |
| 11 | Proxy failure | Rotate to next proxy, retry | ProxyManager.rotate() | UNIT-TESTED |
| 12 | Bad JSON from NSE | JSON parse error, return empty dict | Exception wrapping | UNIT-TESTED |
| 13 | Malformed option chain JSON | RuntimeError, fallback to FetcherSession | Try/except in XHR parse | UNIT-TESTED |
| 14 | Partial option chain (missing strikes) | PARTIAL quality, not VALID | OptionChainCompletenessV2 | DESIGNED |
| 15 | Missing CE contracts | completenessPercent < 100, quality=PARTIAL | Completeness check | DESIGNED |
| 16 | Missing PE contracts | Same as above | Completeness check | DESIGNED |
| 17 | Duplicate strike in option chain | Detected, logged, last wins | strike_map dedup | UNIT-TESTED |
| 18 | Invalid OI (negative) | int() will convert, validator catches | V2 schema validation | DESIGNED |
| 19 | Null IV for options | iv=None preserved, not substituted with 0 | Optional[float] in schema | UNIT-TESTED |
| 20 | Stale option chain | fromCache=True, snapshotAgeMs exposed | Last-good cache with age | DESIGNED |
| 21 | Missing historical day (404) | Skip day, continue range | 404 dispatch | UNIT-TESTED |
| 22 | Holiday 404 | Same as missing — skip | 404 dispatch | UNIT-TESTED |
| 23 | Corrupt Bhavcopy CSV | Row parse error, skip row, continue | CSV parse exception | UNIT-TESTED |
| 24 | Duplicate rows in Bhavcopy | First match used, break | Break after first match | DESIGNED |
| 25 | Zero volume in Bhavcopy | volume=0 accepted | No lower bound on volume | UNIT-TESTED |
| 26 | Invalid OHLC in candle (high < open) | Candle rejected | `_validate_candle_row()` | UNIT-TESTED |
| 27 | Clock jump (NTP adjustment) | Skew detected, DATA_QUALITY=DEGRADED | TimestampEngine.is_clock_degraded | DESIGNED |
| 28 | Akamai challenge page | BanDetector detects, proxy rotated | AkamaiChallengePattern | UNIT-TESTED |
| 29 | Shadow ban (empty records) | BanDetector detects during market hours | ShadowBanPattern + market hours check | UNIT-TESTED |
| 30 | Rate limit response | BanDetector detects, backoff applied | RateLimitPattern | UNIT-TESTED |
| 31 | Session warmer ban | Retries up to 5 times, rotates proxy | MAX_BAN_RETRIES loop | UNIT-TESTED |
| 32 | Session warmer timeout | Backs off, logs, retries | asyncio.wait_for wrapping | UNIT-TESTED |
| 33 | Redis queue full (backpressure) | LOW priority ticks dropped, HIGH preserved | StreamPublisher backpressure | DESIGNED |
| 34 | Sequence gap in tick stream | Gap detected, DataGapEvent created | SequenceTracker | UNIT-TESTED |
| 35 | Out-of-order tick arrival | Logged, not used for candle open | SequenceTracker | UNIT-TESTED |
| 36 | Duplicate tick (same event ID) | EventDeduplicator blocks downstream | EventDeduplicator | UNIT-TESTED |
| 37 | Yahoo symbol in NSE API call | Rejected before API call | SymbolNormalizer + filter | UNIT-TESTED |
| 38 | Symbol with 31+ chars | Rejected by validation | _SAFE_SYMBOL_RE | UNIT-TESTED |
| 39 | 201 symbols in one request | HTTP 400 with clear error | 200-symbol limit | UNIT-TESTED |
| 40 | Date range > 5 years (daily) | HTTP 400 with clear error | MAX_DAILY_DAYS limit | UNIT-TESTED |

---

## Critical Path Chaos Analysis

### Option Chain Chaos (Phase 76)

```
SCENARIO: NSE returns option chain with wrong underlying price
  Input:    chain.spot = 23,000 (stale), actual NIFTY = 24,850
  Expected: CHAIN_QUALITY = DEGRADED, snapshotAgeMs reported
  Status:   DESIGNED (spotAgeMs field in OptionChainSnapshotV2)

SCENARIO: Option chain expiry doesn't match request
  Input:    caller requests 2026-09-25, chain returns 2026-09-18
  Expected: Warning logged, nearest expiry used
  Status:   UNIT-TESTED (expiry fallback logic in option_chain.py)

SCENARIO: Option chain entirely empty (all strikes removed)
  Input:    records.data = []
  Expected: RuntimeError, fallback to FetcherSession
  Status:   UNIT-TESTED
```

### Redis Outage Chaos (Phase 74)

```
SCENARIO: Redis dies during market hours
  Input:    Redis connection drops at 10:30 IST
  Expected:
    1. tick_publisher detects failure (publish_error logged)
    2. Switches to reconnecting mode
    3. Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap
    4. On reconnect: resumes publishing
    5. Missed ticks: consumers can replay from Redis Streams
       (if stream was written before outage)
  Status: UNIT-TESTED (reconnect logic), Redis Streams: DESIGNED

Recovery window: 10,000 entries × 5s intervals ÷ 20 symbols = ~41 minutes
```

### Historical Data Chaos (Phase 77)

```
SCENARIO: NSE bhavcopy returns corrupt CSV
  Input:    Response with NaN prices, empty lines, wrong columns
  Expected: Row skipped, valid rows returned, partial result
  Status:   UNIT-TESTED (_validate_candle_row rejects NaN)

SCENARIO: All bhavcopy files 404 for a date range
  Input:    NSE returns 404 for every day in the range
  Expected: Empty candles list, HTTP 200 with count=0
  Status:   UNIT-TESTED
```

---

## Chaos Test Gaps

| Scenario | Gap | Priority |
|----------|-----|----------|
| Redis Streams replay after outage | NOT_TESTED vs live Redis | HIGH |
| Circuit breaker trip under load | NOT_TESTED | HIGH |
| 500 concurrent quote requests | NOT_TESTED | MEDIUM |
| Memory leak under 24h soak | NOT_TESTED | MEDIUM |
| NSE API redesign (new field names) | NOT_TESTED | MEDIUM |
| Time zone DST edge case | NOT_TESTED (India has no DST) | LOW |

India does not observe Daylight Saving Time, eliminating the DST class of timestamp bugs entirely.
