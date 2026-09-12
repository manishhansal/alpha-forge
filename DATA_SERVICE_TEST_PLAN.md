# DATA SERVICE TEST PLAN
**AlphaForge — Data-Service Centralization Refactor**  
**Date:** 2026-09-12  
**Branch:** refactor/signals  
**Status:** DEFINED PRE-IMPLEMENTATION (as required by Section 3 of the refactor spec)

---

## 0. TESTING PHILOSOPHY

1. Tests are defined **before** implementation. This document is the contract.
2. Every test must produce a **PASS / FAIL / SKIP** result — no ambiguous outcomes.
3. No test fabricates data. Provider mock responses use real observed shapes.
4. Market-closed state is tested separately from provider-failure state.
5. No test asserts "100% reliable" — tests measure actual behavior under defined conditions.

---

## A. PROVIDER TESTS

### A.1 Scrapling / Data-Service (Python)

Tests live in `data-service/tests/` and run with `pytest`.

#### A.1.1 Data-Service Health
| Test ID | Description | Expected Outcome |
|---|---|---|
| DS-001 | `GET /health` returns 200 | `{"status": "healthy"}` or `"degraded"` with component detail |
| DS-002 | `GET /scraping/status` returns 200 with capability flags | All boolean fields present |
| DS-003 | Service starts in degraded mode when Redis unavailable | `status: "degraded"`, `components.redis != "ok"` |
| DS-004 | Service starts in degraded mode when Chromium unavailable | `status: "degraded"`, `components.chromium != "ok"` |
| DS-005 | Service starts in degraded mode when anti-ban layer fails | `status: "degraded"`, `components.anti_ban != "ok"` |

#### A.1.2 Scrapling NSE Endpoint Access
| Test ID | Description | Expected Outcome |
|---|---|---|
| DS-010 | `GET /scraping/historical` with valid symbol returns candles | 200, array of OHLCV candles |
| DS-011 | `GET /scraping/quotes` with valid NSE symbol returns quote | 200, valid quote object |
| DS-012 | `GET /scraping/option-chain` with valid underlying returns chain | 200, rows array non-empty during market hours |
| DS-013 | Malformed response from upstream NSE → HTTP 502 (not 500) | Structured error, no traceback leaked |
| DS-014 | NSE returns HTTP 403 → circuit breaker increments | `ban_detector` records 403; exponential backoff triggered |
| DS-015 | NSE returns HTTP 429 → separate from 403 handling | `Retry-After` header respected if present |
| DS-016 | NSE returns HTTP 500 → provider failure, not application error | `status: "degraded"` in response metadata |
| DS-017 | NSE returns HTTP 503 → graceful degradation | Empty data with provenance `NSE_PUBLIC_UNAVAILABLE` |
| DS-018 | Connection timeout (simulate with mock) → typed timeout error | `PROVIDER_TIMEOUT` error, not silent empty |
| DS-019 | Connection reset (ECONNRESET simulation) → retry with backoff | Max 3 retries, exponential backoff, jitter |
| DS-020 | HTML structure change (NSE DOM update) → parser versioning | Raises `PARSER_VERSION_MISMATCH`, not silent null |
| DS-021 | Empty response body → `EMPTY_RESPONSE` error, not silent `[]` | Typed `EMPTY_DATA` error |
| DS-022 | Partial response (truncated JSON) → `PARTIAL_DATA` error | Structured error with partial data metadata |

#### A.1.3 Scrapling Off-Hours Behavior
| Test ID | Description | Expected Outcome |
|---|---|---|
| DS-030 | Option chain request on Saturday → `MARKET_CLOSED` status | NOT classified as provider failure |
| DS-031 | Live quote request outside 09:15–15:30 IST → stale/last-close data | Response carries `isLive: false`, `dataAsOf` timestamp |
| DS-032 | `MARKET_CLOSED` does not trigger failover to next provider | Status propagates, no unnecessary Angel One call |

### A.2 Angel One SmartAPI

#### A.2.1 Authentication
| Test ID | Description | Expected Outcome |
|---|---|---|
| AO-001 | Valid credentials → JWT returned | Login succeeds, token cached until midnight IST |
| AO-002 | Invalid client code → `AUTH_FAILED` error | Typed error, no credential leak in logs |
| AO-003 | Wrong password → `AUTH_FAILED` error | Typed error |
| AO-004 | Invalid TOTP secret → TOTP generation fails, `AUTH_FAILED` | Typed error before any network call |
| AO-005 | SMARTAPI_* env vars missing → `PROVIDER_NOT_CONFIGURED` | Not `AUTH_FAILED`, not silent |
| AO-006 | Token refresh before midnight IST → new JWT obtained | No request failure during token boundary |
| AO-007 | Stale JWT (expired) → automatic re-login | Re-login triggered transparently |
| AO-008 | Concurrent login attempts → only ONE login call made | Singleton login pattern, no duplicate auth |

#### A.2.2 Rate Limiting
| Test ID | Description | Expected Outcome |
|---|---|---|
| AO-010 | >3 historical requests/sec → token bucket throttles | 4th request waits, not rejected |
| AO-011 | HTTP 429 from SmartAPI → `PROVIDER_RATE_LIMITED` error | Retry-After honoured |
| AO-012 | Rate-limit storm (100 simultaneous historical requests) → bounded concurrency | Max 3 concurrent, queue drains without 429 |

#### A.2.3 Historical Candles
| Test ID | Description | Expected Outcome |
|---|---|---|
| AO-020 | `getHistoricalCandles` 1m, 5m, 10m, 15m, 30m, 1h, 1d — one equity | Candles returned for each supported interval |
| AO-021 | `getHistoricalCandles` 1w, 1M — SmartAPI does not support these | `UNSUPPORTED_CAPABILITY` error (not empty array) |
| AO-022 | Index symbol (NIFTY) sent to Angel historical → correctly blocked | Returns empty with provenance `INDEX_UNSUPPORTED_BY_ANGEL` |
| AO-023 | Angel returns 0 bars for interval (e.g. holiday window) | `EMPTY_DATA` with `marketClosed` context, NOT `PROVIDER_FAILURE` |
| AO-024 | Angel candles contain NaN price → validation rejects row | Offending row logged and dropped, remainder returned |
| AO-025 | Angel candles contain negative volume → validation rejects row | Same as above |
| AO-026 | high < low in a candle → validation rejects row | Same as above |
| AO-027 | 3m interval requested → `UNSUPPORTED_CAPABILITY` immediately | No network call made, error thrown at routing layer |

#### A.2.4 Live Quotes
| Test ID | Description | Expected Outcome |
|---|---|---|
| AO-030 | `getQuotes` batch ≤50 tokens → single API call | Returns quote per symbol |
| AO-031 | `getQuotes` batch >50 tokens → chunked calls | All results returned, no loss |
| AO-032 | Symbol not in ScripMaster → `UNRESOLVED_SYMBOL` for that symbol | Other symbols succeed |
| AO-033 | Malformed quote payload (missing `ltp`) → null quote, not crash | Quote with `ltp: null`, provenance notes missing field |
| AO-034 | Empty payload `{}` → handled gracefully | No crash, empty result with error context |

#### A.2.5 Option Chain
| Test ID | Description | Expected Outcome |
|---|---|---|
| AO-040 | `getOptionChain` for NIFTY → rows returned during market hours | Non-empty rows, expiry populated |
| AO-041 | `getOptionChain` for equity (RELIANCE) → rows returned | Same |
| AO-042 | `getOptionChain` for SENSEX/BANKEX (BFO exchange) → rows returned | `exchange: "BFO"` in token resolution |
| AO-043 | Off-hours option chain → empty legs or null IV | `MARKET_CLOSED` status, not `PROVIDER_FAILURE` |
| AO-044 | SmartAPI returns `AB9019` ("No Data Available") → mapped to `EMPTY_DATA` | Not crash |
| AO-045 | Greeks/IV via `optionGreek` API → IV populated in rows | `iv` field non-null for liquid strikes |
| AO-046 | `optionGreek` API fails → chain returned without IV, `ivUnavailable: true` | Partial data, clearly flagged |

#### A.2.6 WebSocket
| Test ID | Description | Expected Outcome |
|---|---|---|
| AO-050 | WebSocket connects and receives ticks within 10s | Ticks arrive, parsed correctly |
| AO-051 | WebSocket disconnect → auto-reconnect within 5s | Subscription recovered after reconnect |
| AO-052 | Duplicate subscription for same token → deduplicated | Only one upstream subscription |
| AO-053 | Heartbeat timeout detection → reconnect triggered | Connection not left stale |
| AO-054 | Malformed binary tick → logged and skipped | No crash, stream continues |
| AO-055 | 100 simultaneous consumers subscribe to 10 symbols → 10 upstream subs | Fanout, not 100 provider subs |

### A.3 Upstox

#### A.3.1 Authentication
| Test ID | Description | Expected Outcome |
|---|---|---|
| UP-001 | `UPSTOX_ANALYTICS_TOKEN` present → requests authorized | Candles returned |
| UP-002 | No token → `PROVIDER_NOT_CONFIGURED` | Not silent empty |
| UP-003 | Expired token (401) → `AUTH_FAILED` with context | No retry loop on 401 |
| UP-004 | Per-user DB token flow → token retrieved from DB | User-specific token used |

#### A.3.2 Historical Candles
| Test ID | Description | Expected Outcome |
|---|---|---|
| UP-010 | Upstox v2 interval map: 1m, 30m, 1d, 1w, 1M → supported | Candles returned |
| UP-011 | Upstox v2: 5m, 10m, 15m, 1h → NOT natively supported in v2 | Capability matrix returns `supported: false` for v2 on these |
| UP-012 | Upstox v3: 1m, 5m, 15m, 30m, 1h, 1d, 1w, 1M → supported | Candles returned via v3 |
| UP-013 | Index symbol (NIFTY, BANKNIFTY) → Upstox handles correctly | Candles returned (Upstox supports index) |
| UP-014 | Rate limit (HTTP 429) → `PROVIDER_RATE_LIMITED`, not crash | Retry-After honoured |

#### A.3.3 Live Quotes and WebSocket
| Test ID | Description | Expected Outcome |
|---|---|---|
| UP-020 | `getQuotes` via Upstox v2 → quotes returned | Non-null ltp values |
| UP-021 | WebSocket v3 Protobuf → ticks parsed and normalized | Correct field mapping |
| UP-022 | WebSocket disconnect → reconnect with subscription recovery | Same as Angel AO-051 |

### A.4 Jugaad-data (Python, inside data-service)

| Test ID | Description | Expected Outcome |
|---|---|---|
| JG-001 | Historical equity EOD (1d) for a valid NSE symbol | OHLCV DataFrame returned, converted to candle format |
| JG-002 | Historical F&O: futures for a valid symbol+expiry | OI/volume included |
| JG-003 | Historical options: CE/PE for valid strike+expiry | IV not available from jugaad (mark `ivUnavailable: true`) |
| JG-004 | Expiry date parsing: jugaad expiry format → canonical ISO | Correct date mapping |
| JG-005 | Date range with no data (holiday) → empty DataFrame | `EMPTY_DATA`, not crash |
| JG-006 | Invalid/delisted symbol → jugaad raises → `INVALID_SYMBOL` error | Typed error |
| JG-007 | API structure change in jugaad-data → `PARSER_VERSION_MISMATCH` | Not silent null |
| JG-008 | 3m interval requested → `UNSUPPORTED_CAPABILITY` immediately | No jugaad call made |
| JG-009 | Bulk NSE bhavcopy download → parsed and normalized correctly | Date, symbol, OHLCV fields correct |

### A.5 OpenChart (Python, inside data-service)

| Test ID | Description | Expected Outcome |
|---|---|---|
| OC-001 | Historical OHLCV: 1m for NSE equity → candles returned | Correct OHLCV fields |
| OC-002 | Historical OHLCV: 5m, 10m, 15m, 30m, 1h, 1d, 1w, 1M → all supported | Candles for each |
| OC-003 | 3m interval → `UNSUPPORTED_CAPABILITY` | Hard-blocked at acquisition planner |
| OC-004 | Symbol not found in openchart → `INVALID_SYMBOL` | Typed error |
| OC-005 | NSE session cookie required and present → requests succeed | curl_cffi impersonation works |
| OC-006 | NSE blocks request (TLS/WAF) → anti-ban rotation triggered | Alternative session or proxy tried |
| OC-007 | Malformed OHLCV response → parser raises `PARSER_VERSION_MISMATCH` | Not silent empty |
| OC-008 | Rate limiting (NSE charting endpoint) → token bucket throttles | No request storm |
| OC-009 | Openchart as cross-provider reconciliation source → discrepancy computed | Discrepancy metric returned |

### A.6 Yahoo Finance

| Test ID | Description | Expected Outcome |
|---|---|---|
| YF-001 | Historical equity (1d) for NSE symbol with .NS suffix → correct data | Candles returned, timezone normalized to IST |
| YF-002 | NSE symbol without .NS suffix → adapter adds it automatically | Same result as YF-001 |
| YF-003 | `getQuotes` for batch of symbols → one call per batch | Rate-efficient |
| YF-004 | Yahoo returns stale data (> 15 min old during market hours) | `freshness: STALE` flagged in response metadata |
| YF-005 | Yahoo returns data for a delisted symbol → marked as `STALE` | Not `INVALID` |
| YF-006 | Yahoo fallback for F&O data → `UNSUPPORTED_CAPABILITY` | Yahoo does not provide OI, IV, Greeks |
| YF-007 | Yahoo-derived data always carries `provenance: SECONDARY_FALLBACK` | Provenance field correctly set |
| YF-008 | Yahoo provider failure → error propagates up the failover chain | Does not silently return `[]` |
| YF-009 | Yahoo used when explicitly allowed in capability policy only | Not used as primary source |
| YF-010 | Weekly/Monthly candles from Yahoo → timezone and close-time correct | NSE trading timezone = Asia/Kolkata |

---

## B. PROVIDER ROUTING TESTS

### B.1 Capability-Aware Routing

| Test ID | Description | Expected Outcome |
|---|---|---|
| RT-001 | Live equity quote → tries scrapling → angel → upstox → yahoo | Failover in correct order |
| RT-002 | Live index quote (NIFTY) → Angel skipped (index unsupported) | Upstox or scrapling handles index |
| RT-003 | Historical 5m equity → scrapling → angel → upstox (not yahoo) | Yahoo is NOT tried for intraday F&O history |
| RT-004 | Historical 1d equity → all providers tried in order | Any of scrapling/jugaad/angel/upstox/yahoo |
| RT-005 | Historical 1w/1M → capability matrix returns only yahoo and data-service | Angel/Upstox correctly skipped |
| RT-006 | Option chain → scrapling → angel → upstox (yahoo has NO option chain capability) | Yahoo never attempted for options |
| RT-007 | Historical F&O (OI/volume) → jugaad (via scrapling) | Yahoo and non-F&O providers excluded |
| RT-008 | UNSUPPORTED_CAPABILITY is NOT treated as PROVIDER_FAILURE | No spurious failover |
| RT-009 | Provider unavailable → correct provider tried next | Exactly one extra provider call |
| RT-010 | All providers fail → structured error with full failure chain | Not silent `[]` |
| RT-011 | Provider unauthenticated → `AUTH_FAILED` error for that provider, try next | Not a hard block for next provider |
| RT-012 | Provider rate limited → honour Retry-After, try next if timeout exceeds budget | Not stuck waiting |
| RT-013 | Provider timeout → `PROVIDER_TIMEOUT`, try next | Timeout per provider configurable |
| RT-014 | Empty data from provider → `EMPTY_DATA`, try next | Not treated as success |
| RT-015 | Partial data from provider → returned with `quality: DEGRADED` | Not treated as success OR failure |
| RT-016 | Corrupted/NaN data from provider → validation rejects, try next | Validation is pre-failover |
| RT-017 | Stale data (>15 min during market hours) → `freshness: STALE` in response | Not treated as failure |
| RT-018 | Market closed → `MARKET_CLOSED` returned, no failover triggered | Critical routing distinction |
| RT-019 | Two providers return data for same request → reconciliation runs | Discrepancy computed |
| RT-020 | 3m requested at any layer → blocked before routing | `UNSUPPORTED_CAPABILITY` at gate level |

---

## C. NORMALIZATION TESTS

Tests live in `tests/lib/market-data/normalizer.test.ts`.

### C.1 Timestamp Normalization

| Test ID | Description | Expected Outcome |
|---|---|---|
| NR-001 | Angel One IST datetime string → UTC epoch ms | `fromSmartApiDateTime("2026-09-12 10:30:00") === expectedUtcMs` |
| NR-002 | Upstox RFC-3339 string → UTC epoch ms | Correct UTC conversion |
| NR-003 | Yahoo epoch seconds → UTC epoch ms | Multiplied by 1000, correct |
| NR-004 | jugaad pandas Timestamp → UTC epoch ms | Correct timezone-aware conversion |
| NR-005 | openchart timestamp → UTC epoch ms | Correct |
| NR-006 | Mixed timezone in batch → all normalized to UTC | No mixed timezone in output |
| NR-007 | NSE trading session boundary: 09:15 IST = 03:45 UTC | Verified |
| NR-008 | NSE session close: 15:30 IST = 10:00 UTC | Verified |
| NR-009 | Daylight saving (IST has no DST — offset always +5:30) | Static offset, no DST handling needed |

### C.2 OHLCV Validation

| Test ID | Description | Expected Outcome |
|---|---|---|
| NR-020 | `high >= max(open, close)` | Passes for valid candle |
| NR-021 | `low <= min(open, close)` | Passes for valid candle |
| NR-022 | `high >= low` | Passes for valid candle |
| NR-023 | `high < max(open, close)` → validation rejects | Row dropped, logged |
| NR-024 | `low > min(open, close)` → validation rejects | Row dropped, logged |
| NR-025 | `high < low` → validation rejects | Row dropped, logged |
| NR-026 | Negative volume → validation rejects | Row dropped, logged |
| NR-027 | Zero volume (valid, e.g. circuit limit) → kept | Not rejected — zero volume is valid |
| NR-028 | NaN in mandatory price field → validation rejects | Row dropped |
| NR-029 | Infinity in any field → validation rejects | Row dropped |
| NR-030 | Negative price → validation rejects | Row dropped |
| NR-031 | Missing mandatory field → validation rejects | Row dropped |

### C.3 Symbol Normalization

| Test ID | Description | Expected Outcome |
|---|---|---|
| NR-040 | `stripYahooSuffix("RELIANCE.NS")` → `"RELIANCE"` | Correct |
| NR-041 | `stripYahooSuffix("NIFTY.BO")` → `"NIFTY"` | Correct |
| NR-042 | `stripYahooSuffix("RELIANCE")` → `"RELIANCE"` (no change) | Idempotent |
| NR-043 | Angel One symbol → canonical NSE symbol | Mapping correct |
| NR-044 | Upstox instrument key (ISIN-based) → canonical NSE symbol | Mapping correct |

### C.4 Duplicate Detection

| Test ID | Description | Expected Outcome |
|---|---|---|
| NR-050 | Two candles with same `(symbol, exchange, interval, time)` → deduplicated | One candle returned |
| NR-051 | Same candle from two providers → first-priority provider wins | Provenance recorded |
| NR-052 | Deduplication in DB upsert → no duplicate key error | Idempotent upsert |

---

## D. RECONCILIATION TESTS

Tests live in `data-service/tests/core/test_reconciliation.py` and `tests/lib/market-data/reconciliation.test.ts`.

| Test ID | Description | Expected Outcome |
|---|---|---|
| RC-001 | Same OHLCV from two providers, exact match → `discrepancy: 0.0` | `reconciliationStatus: EXACT_MATCH` |
| RC-002 | Close prices differ by 0.01% → `discrepancy: 0.01%` | `reconciliationStatus: ACCEPTABLE_VARIANCE` |
| RC-003 | Close prices differ by 0.5% → `discrepancy: 0.5%` | `reconciliationStatus: SUSPICIOUS_VARIANCE` |
| RC-004 | Close prices differ by >2% → `discrepancy: >2%` | `reconciliationStatus: SEVERE_MISMATCH` |
| RC-005 | OI disagrees between providers | OI discrepancy computed separately from price |
| RC-006 | Volume disagrees by 30% → flagged | `volumeDiscrepancyPct` in metadata |
| RC-007 | Timestamp mismatch (different candle boundary) → not reconciled | `reconciliationStatus: TIMESTAMP_MISMATCH` |
| RC-008 | Provenance preserved through reconciliation | Original provider retained, reconciliation result added |
| RC-009 | SEVERE_MISMATCH → `dataConfidence` downgraded | `confidenceGrade: C` or below |
| RC-010 | Reconciliation result does NOT blindly overwrite data | Both provider values retained in audit trail |

---

## E. DATA QUALITY TESTS

Tests live in `data-service/tests/core/test_data_quality.py`.

| Test ID | Description | Expected Outcome |
|---|---|---|
| DQ-001 | Complete, fresh, reconciled data → `grade: A` | Score ≥ 90 |
| DQ-002 | Complete data, stale by 5 min during market hours → `grade: B` | Freshness penalty |
| DQ-003 | 10% missing candles in range → `grade: C` | Completeness penalty |
| DQ-004 | Provider failed, cache returned → `grade: B` (cache is valid but not live) | Freshness penalty, provenance: CACHE |
| DQ-005 | Severe reconciliation mismatch → `grade: D` | Accuracy penalty |
| DQ-006 | Cross-provider agreement <50% → `grade: BLOCKED` | Signal cannot proceed |
| DQ-007 | Market closed, no live data → `MARKET_CLOSED` state, NOT penalized | Market closed ≠ poor quality |
| DQ-008 | Quality score is deterministic for same input | Idempotent computation |
| DQ-009 | Quality grade is explainable (individual dimension scores available) | Not a black box |
| DQ-010 | `DATA_QUALITY_GRADE: BLOCKED` propagates to signal gate | Signal generation blocked |
| DQ-011 | Yahoo-derived data → maximum grade capped at `B` | Never `A` for Yahoo-only data |

---

## F. HISTORICAL DATA TESTS

### F.1 Supported Timeframes

| Test ID | Description | Expected Outcome |
|---|---|---|
| HD-001 | 1m historical request → data returned | Candles with 1m intervals |
| HD-002 | 5m historical request → data returned | Candles with 5m intervals |
| HD-003 | 10m historical request → data returned | Candles with 10m intervals |
| HD-004 | 15m historical request → data returned | Candles with 15m intervals |
| HD-005 | 30m historical request → data returned | Candles with 30m intervals |
| HD-006 | 1h historical request → data returned | Candles with 1h intervals |
| HD-007 | 1d historical request → data returned | Candles with 1d intervals |
| HD-008 | 1w historical request → data returned | Candles with 1w intervals |
| HD-009 | 1M historical request → data returned | Candles with 1M intervals |

### F.2 3m Rejection (everywhere)

| Test ID | Description | Expected Outcome |
|---|---|---|
| HD-020 | 3m request at TypeScript registry layer | `UNSUPPORTED_CAPABILITY` — no provider called |
| HD-021 | 3m request at data-service Python API | HTTP 400 with `"3m is not a supported interval"` |
| HD-022 | 3m request at Python acquisition planner | `ValueError: 3m permanently removed` |
| HD-023 | 3m request at Python normalizer | `interval_3m_not_supported` error |
| HD-024 | 3m in DB `intervalStr` field query → returns zero rows | No 3m data in DB |
| HD-025 | 3m in cache key → cache returns miss | No 3m cache entries |
| HD-026 | 3m at signal gate (`v8-signal-data-gate.service.ts`) | `BLOCKED` immediately |
| HD-027 | 3m in Prisma `schema.prisma` comment is documentation-only | Not a schema constraint — verified by reading schema |

### F.3 Derived Timeframes

| Test ID | Description | Expected Outcome |
|---|---|---|
| HD-030 | Derive 1w from 1d candles → Monday open, Friday close | Correct weekly candle |
| HD-031 | Derive 1M from 1d candles → first trading day open, last close | Correct monthly candle |
| HD-032 | Derived candle carries `derivedFrom: "1d"`, `derivationMethod: "aggregation"` | Provenance field set |
| HD-033 | Derive 10m from 5m (if 10m unavailable from provider) | Two 5m bars aggregated correctly |
| HD-034 | Derived candle uses session-aware boundaries (09:15 IST open) | Not arbitrary calendar boundaries |

---

## G. LIVE DATA TESTS

| Test ID | Description | Expected Outcome |
|---|---|---|
| LD-001 | LTP for NIFTY during market hours | Non-null, reasonable value |
| LD-002 | Quote for NSE equity (RELIANCE) | `ltp`, `change`, `changePct` populated |
| LD-003 | Batch quote (50 symbols) → 50 results | One result per symbol |
| LD-004 | OHLC (intraday) for equity | `open`, `high`, `low`, `close` populated |
| LD-005 | Volume for equity | `volume` populated (or `volumeUnavailable: true`) |
| LD-006 | OI for index option (NIFTY) | `oi` populated or `oiUnavailable: true` |
| LD-007 | Option chain NIFTY → rows with CE/PE per strike | At least 20 strikes either side of ATM |
| LD-008 | IV in option chain → populated for ATM strike | Not null during market hours |
| LD-009 | IV missing off-hours → `ivUnavailable: true`, not fabricated | Correct off-hours behavior |
| LD-010 | WebSocket tick arrives within 5s of subscription | `latencyMs < 5000` |
| LD-011 | Snapshot (last tick) available immediately after subscribe | Snapshot before live ticks start |
| LD-012 | Streaming tick contains `timestamp`, `ltp`, `exchange`, `symbol` | Canonical tick shape |
| LD-013 | Reconnect after 5s disconnect → subscription recovered | Ticks resume within 10s |
| LD-014 | Stale tick detection: same LTP for >30s during market hours | `isStale: true` flagged |
| LD-015 | Backpressure: consumer slow → oldest ticks dropped (bounded buffer) | Not OOM |

---

## H. CACHE TESTS

Tests live in `tests/lib/market-data/` and use in-memory mocks for Redis.

| Test ID | Description | Expected Outcome |
|---|---|---|
| CA-001 | Cache miss → provider called | Provider request observed |
| CA-002 | Cache hit (within TTL) → provider NOT called | No provider request |
| CA-003 | Stale cache (expired TTL) → provider called, cache refreshed | Stale data returned with `freshness: STALE` until refresh completes |
| CA-004 | LTP TTL = 3s → cache expires after 3s | Correct TTL |
| CA-005 | Quote TTL = 5s | Correct TTL |
| CA-006 | 1m candle TTL = 30s | Correct TTL |
| CA-007 | Daily candle TTL = 4h | Correct TTL |
| CA-008 | Instrument master TTL = 12h | Correct TTL |
| CA-009 | 500 simultaneous requests for same symbol → only 1 provider call (request coalescing) | `coalesced: true` in metadata |
| CA-010 | Request coalescing: all 500 consumers receive the same result | Correct fanout |
| CA-011 | Provider outage while cache exists → serve from cache with `provenance: CACHE` | `dataAsOf` reflects cache time |
| CA-012 | Cache invalidation on explicit signal | Cache cleared, next request goes to provider |
| CA-013 | L1 (in-memory) hit → < 1ms latency | Sub-millisecond |
| CA-014 | L2 (Redis) hit → < 5ms latency | Sub-5ms |
| CA-015 | L3 (DB) hit → < 50ms latency | Sub-50ms |
| CA-016 | Cache stampede: Redis unavailable, 1000 requests → bounded DB load | Max N concurrent DB queries via semaphore |
| CA-017 | Cache key collision between providers → isolated namespaces | `market:quote:angel_one:*` vs `market:quote:upstox:*` |

---

## I. DATABASE TESTS

| Test ID | Description | Expected Outcome |
|---|---|---|
| DB-001 | Bulk insert 1000 candles → single batch, not 1000 individual INSERTs | `pg_stat_activity` shows 1 query |
| DB-002 | Upsert: same candle inserted twice → one row in DB | No duplicate |
| DB-003 | Deduplication on `(instrumentId, exchange, intervalStr, time)` unique constraint | Constraint enforced |
| DB-004 | Partial failure in bulk batch → transaction rollback, no partial insert | DB state consistent |
| DB-005 | Latest candle query: `SELECT ... ORDER BY time DESC LIMIT 1` → uses index | Query plan shows index scan, not seq scan |
| DB-006 | Range query: `WHERE instrumentId=X AND intervalStr='5m' AND time BETWEEN a AND b` → uses composite index | Index scan confirmed |
| DB-007 | ML window query (last 200 5m bars) → `p95 < 100ms` | Measured, not asserted |
| DB-008 | Signal query (last N bars for strategy evaluation) → `p95 < 50ms` | Measured |
| DB-009 | 228 symbols × 5m (daily writes ~60 bars each) → insert throughput ≥ 500 rows/s | Measured with pg INSERT benchmark |
| DB-010 | `sessionDate` partial unique index (daily, non-null) prevents duplicate daily bars | Constraint tested |
| DB-011 | `OptionChainStrike` upsert with `captureTimestamp` key → no duplicates | Constraint enforced |
| DB-012 | DB connection pool exhaustion (>100 connections) → queued, not crashed | PgBouncer or pool handles gracefully |

---

## J. CONCURRENCY TESTS

| Test ID | Description | Expected Outcome |
|---|---|---|
| CN-001 | 100 concurrent quote requests (same symbol) → 1 provider call (coalescing) | Measured |
| CN-002 | 100 concurrent quote requests (different symbols) → ≤10 provider calls (batching) | Measured |
| CN-003 | 500 concurrent quote requests → no race conditions | All 500 return correct results |
| CN-004 | 1000 concurrent historical requests → bounded concurrency (max 10 provider calls) | Measured provider request count |
| CN-005 | No duplicate DB writes under concurrency | Row count matches expected |
| CN-006 | No Redis overload: 500 concurrent cache requests → Redis p99 < 10ms | Measured |
| CN-007 | No provider rate-limit storm: 500 requests to one provider → token bucket holds | Provider never sees >N req/s |
| CN-008 | WebSocket: 100 consumers subscribed to NIFTY → 1 upstream WebSocket | Fanout verified |

---

## K. FAILURE TESTS

Tests simulate provider failures using mocks/interceptors.

| Test ID | Description | Expected Outcome |
|---|---|---|
| FL-001 | NSE 403 → `PROVIDER_HARD_BLOCKED`, circuit breaker opens | No retry on 403 |
| FL-002 | NSE 503 → `PROVIDER_UNAVAILABLE`, try next, exponential backoff | Backoff applied |
| FL-003 | Angel 403 → `PROVIDER_HARD_BLOCKED` | Circuit breaker: no retry |
| FL-004 | Angel 429 → `PROVIDER_RATE_LIMITED`, Retry-After honoured | Wait respected |
| FL-005 | Angel timeout (>5s) → `PROVIDER_TIMEOUT`, try next | Timeout configurable |
| FL-006 | Upstox 401 → `AUTH_FAILED`, NOT retried | No retry loop |
| FL-007 | Upstox 429 → `PROVIDER_RATE_LIMITED` | Same as FL-004 |
| FL-008 | Upstox timeout → `PROVIDER_TIMEOUT` | Same as FL-005 |
| FL-009 | jugaad raises exception → `PROVIDER_FAILURE`, try next | Error classified correctly |
| FL-010 | openchart raises exception → `PROVIDER_FAILURE`, try next | Same |
| FL-011 | Yahoo network failure → `PROVIDER_UNAVAILABLE`, fail-closed | No silent empty `[]` |
| FL-012 | DNS failure → `PROVIDER_UNAVAILABLE` | Not crash |
| FL-013 | Connection reset (ECONNRESET) → retry up to 3× with backoff | Jitter applied |
| FL-014 | Malformed JSON from provider → `INVALID_DATA`, not crash | Logged, next provider tried |
| FL-015 | Partial JSON (truncated) → `PARTIAL_DATA` | Partial data flagged |
| FL-016 | Empty dataset (200 OK, empty array) → `EMPTY_DATA` | Not treated as success |
| FL-017 | Database unavailable → serve from cache, degrade gracefully | `provenance: CACHE`, `degraded: true` |
| FL-018 | Redis unavailable → fall through to L3 DB cache | DB used as fallback |
| FL-019 | All providers fail → structured error with full failure chain returned | Not silent empty |
| FL-020 | Circuit breaker opens → subsequent requests fail fast (no wait) | `circuit_open` error immediately |
| FL-021 | Circuit breaker cooldown → after 30s, next request tries provider again | Provider retried after cooldown |

---

## L. SECURITY TESTS

| Test ID | Description | Expected Outcome |
|---|---|---|
| SC-001 | Angel One credentials NOT in API responses | Response contains no `clientCode`, `password`, `totpSecret` |
| SC-002 | Angel One credentials NOT in logs | Grep logs for credential patterns — zero matches |
| SC-003 | Upstox access token NOT in API responses | Response contains no `accessToken` |
| SC-004 | Provider credentials NOT exposed via error messages | Error messages contain no secrets |
| SC-005 | `UserSetting.apiKeysEncrypted` — encrypted at rest | Field value is not plaintext in DB |
| SC-006 | Credential retrieval is async, typed, and fails closed | `readAngelCredentials()` returns null when missing, not undefined |
| SC-007 | Frontend receives `CONNECTED`/`DISCONNECTED` status only | No credential fields in `/v1/providers/status` response |
| SC-008 | Redis `KEYS *` does not return credential data | No secret values in Redis |
| SC-009 | Authorization: API routes require session or internal token | Unauthenticated requests to `/api/data/*` → 401 |
| SC-010 | Rate limiting on API routes: >100 req/min from same IP → 429 | Applies at API gateway level |
| SC-011 | CORS: data-service only allows `localhost:3000` | Other origins → 403 |
| SC-012 | Broker token isolation: user A's token cannot be used for user B | Token scoped to userId |

---

## M. ARCHITECTURE ENFORCEMENT TESTS

These are static analysis / import-boundary tests that run as part of the unit test suite.
Tests live in `tests/lib/market-data/canonical-import-guard.test.ts`.

| Test ID | Description | Expected Outcome |
|---|---|---|
| AE-001 | `src/services/india/scanner/engine.ts` does NOT import `yahoo-finance2` directly | PASS after fix |
| AE-002 | `src/services/india/signals/snapshotter.ts` does NOT import `@/services/india/yahoo` | PASS after fix |
| AE-003 | `src/features/india/scalping/backtest.ts` does NOT import `@/services/india/yahoo` | PASS after fix |
| AE-004 | `src/features/india/scalping/strategies/positioning.ts` — same | PASS after fix |
| AE-005 | `src/features/india/scalping/strategies/opening-breakout.ts` — same | PASS after fix |
| AE-006 | `src/features/india/fno-trend-history/service.ts` — same | PASS after fix |
| AE-007 | `src/features/india/paper-trading/auto-trader.ts` — same | PASS after fix |
| AE-008 | `src/app/api/in/scalper/close-all/route.ts` — same | PASS after fix |
| AE-009 | `src/lib/market-data/services/option-strike-capture.service.ts` does NOT import `@/services/india/angelone` | PASS after fix |
| AE-010 | `src/lib/market-data/services/fno-backfill-runner.service.ts` — same | PASS after fix |
| AE-011 | `src/features/india/expiry-trades/builder.ts` does NOT import `@/services/india/angelone` for market data | PASS after fix |
| AE-012 | ML service (`ml-service/`) does NOT import Angel One, Upstox, or Yahoo | PASS — already clean |
| AE-013 | Worker (`worker/src/`) does NOT import market-data providers except through registry | PASS after fix |
| AE-014 | No file outside `data-service/` imports `jugaad_data`, `openchart` | PASS — Python only |
| AE-015 | `src/services/india/angelone/index.ts` internal Yahoo fallback removed | PASS after fix |

---

## N. PERFORMANCE TARGETS

These are internal SLOs — not fabricated. Measurements taken with benchmark tooling.

| Metric | Target | Measurement Method |
|---|---|---|
| Cached quote (L1) | < 5ms internal processing | `performance.now()` around cache.get() |
| Cached quote (L2 Redis) | < 20ms | Same |
| Provider quote (Angel One) | < 200ms p95 | Rolling 100-sample window |
| Historical cache hit | < 50ms | Same |
| Historical DB query (index scan) | < 100ms p95 | `pg_stat_statements` |
| ML window query (200 bars, 5m) | < 100ms p95 | Direct DB benchmark |
| WebSocket tick delivery (internally) | < 10ms | Timestamp delta |
| Backfill throughput | ≥ 500 candle rows/s write | Timed bulk insert |

---

## O. END-TO-END TEST FLOW

Tests live in `tests/integration/` and `e2e/`.

| Test ID | Description | Expected Outcome |
|---|---|---|
| E2E-001 | Full flow: data-service → registry → candles → signal gate → signal generated | Signal produced with correct provenance |
| E2E-002 | Full flow: data-service → registry → option chain → option capture → DB | Strikes written with provider metadata |
| E2E-003 | Live data: WebSocket tick → candle builder → confirmed candle → Redis pub/sub → worker | Candle confirmed within 1m window |
| E2E-004 | Historical flow: backfill job → provider → normalize → validate → bulk upsert → DB | Rows in `candle_bar` with correct `intervalStr` |
| E2E-005 | Data quality gate: BLOCKED quality → signal engine blocked | No signal produced |
| E2E-006 | Data quality gate: DEGRADED quality → signal proceeds with flag | Signal produced, `degraded: true` |
| E2E-007 | Consumer receives same canonical data regardless of which provider served it | Schema-level assertion |

---

## P. TEST EXECUTION PLAN

### TypeScript Tests (Vitest)
```bash
# Run all market-data tests
npm run test:lib -- tests/lib/market-data/

# Run architecture enforcement tests
npx vitest run tests/lib/market-data/canonical-import-guard.test.ts

# Run integration tests
npx vitest run tests/integration/

# Run full suite
npm test
```

### Python Tests (pytest)
```bash
cd data-service
python -m pytest tests/ -v

cd ml-service  
python -m pytest tests/ -v
```

### Performance Tests
```bash
# DB benchmark
npx tsx --conditions=react-server --env-file=.env.local scripts/data-cli.ts backfill

# Provider latency
npx tsx --conditions=react-server --env-file=.env.local scripts/data-v7-live-verify.ts
```

---

## Q. TEST COVERAGE REQUIREMENTS

| Area | Minimum Coverage |
|---|---|
| `src/lib/market-data/` | 80% line coverage |
| `src/lib/market-data/providers/` | 70% line coverage |
| `data-service/src/providers/` | 70% line coverage |
| `data-service/src/core/` | 80% line coverage |
| Architecture enforcement | 100% (all 15 AE tests must pass) |
| 3m rejection | 100% (all 8 HD-02x tests must pass) |

---

*Test plan defined pre-implementation as required. All test IDs are traceable to the refactor specification sections.*
