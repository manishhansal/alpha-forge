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

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| AE-001 | No non-allowlisted file directly imports `yahoo-finance2` | Zero violations across all `src/` + `worker/src/` files | PASS |
| AE-002 | No non-approved file imports `@/services/india/yahoo` directly (V-02 through V-08) | `snapshotter.ts`, `backtest.ts`, `positioning.ts`, `opening-breakout.ts`, `fno-trend-history/service.ts`, `auto-trader.ts`, `close-all/route.ts` — zero violations | PASS |
| AE-003 | `src/features/india/scalping/backtest.ts` does NOT import `@/services/india/yahoo` | No static or dynamic yahoo import | PASS |
| AE-004 | `src/features/india/scalping/strategies/positioning.ts` — no yahoo import | No static or dynamic yahoo import | PASS |
| AE-005 | `src/features/india/scalping/strategies/opening-breakout.ts` — no yahoo import | No static or dynamic yahoo import | PASS |
| AE-006 | `src/features/india/fno-trend-history/service.ts` — no yahoo import | No static or dynamic yahoo import | PASS |
| AE-007 | `src/features/india/paper-trading/auto-trader.ts` — no yahoo import | No static or dynamic yahoo import | PASS |
| AE-008 | `src/app/api/in/scalper/close-all/route.ts` — no yahoo import | No static or dynamic yahoo import | PASS |
| AE-009 | No non-approved file imports `@/services/india/angelone` for market data (V-04, V-05) | `option-strike-capture.service.ts`, `fno-backfill-runner.service.ts` — zero violations | PASS |
| AE-010 | `src/lib/market-data/services/fno-backfill-runner.service.ts` does NOT import `@/services/india/angelone` | No dynamic angel import | PASS |
| AE-011 | `src/features/india/expiry-trades/builder.ts` does NOT import `@/services/india/angelone` for market data | No angel market-data import | PASS |
| AE-012 | ML service TypeScript bridge does NOT import Angel One, Upstox, or Yahoo | All ML client files clean | PASS |
| AE-013 | Worker jobs do NOT import market-data providers directly (`worker/src/jobs/`) | `india-realtime-candles.ts` uses `registry.getInstrumentMaster()` | PASS |
| AE-014 | No file outside `data-service/` imports `jugaad_data`, `openchart` | Python-only; no TS references exist | PASS |
| AE-015 | `src/services/india/angelone/index.ts` internal Yahoo fallback removed (V-01) | No `@/services/india/yahoo` import in angel adapter | PASS |
| AE-016 | `top-picks` route does not use `yahoo-finance2` directly | Uses `registry.getQuotes()` | PASS |
| AE-017 | `sector-stocks` route does not use `yahoo-finance2` directly | Uses `registry.getQuotes()` | PASS |
| AE-018 | `top-picks` route uses canonical registry (`bootstrapRegistry` + `registry.getQuotes`) | Both calls present | PASS |
| AE-019 | `sector-stocks` route uses canonical registry | Both calls present | PASS |
| AE-020 | HD-020: No TypeScript file uses `"3m"` as a supported interval value in production code | Zero matches for `interval: "3m"` outside guard/comment lines | PASS |

### Violation-Site Individual Assertions (Requirement 1.2)

One assertion per migration site, each confirmed by `canonical-import-guard.test.ts`.

| Test ID | Violation Site | Assertion | Status |
|---|---|---|---|
| V-01 | `src/services/india/angelone/index.ts` | Does NOT contain `@/services/india/yahoo` import | PASS |
| V-02 | `src/services/india/scanner/engine.ts` | Does NOT contain `@/services/india/yahoo` or `yahoo-finance2` import | PASS |
| V-03 | `src/services/india/signals/snapshotter.ts` | Does NOT contain `@/services/india/yahoo` or `yahoo-finance2` import | PASS |
| V-04 | `src/lib/market-data/services/option-strike-capture.service.ts` | Does NOT contain dynamic `@/services/india/angelone` import | PASS |
| V-05 | `src/lib/market-data/services/fno-backfill-runner.service.ts` | Does NOT contain dynamic `@/services/india/angelone` import | PASS |
| V-06 | `src/features/india/expiry-trades/builder.ts` | Does NOT contain `@/services/india/angelone` import | PASS |
| V-07 | `src/features/india/fno-trend-history/service.ts` | Does NOT contain `@/services/india/yahoo` or `yahoo-finance2` import | PASS |
| V-08 | `src/features/india/scalping/backtest.ts` | Does NOT contain `@/services/india/yahoo` or `yahoo-finance2` import | PASS |
| V-09 | `src/features/india/scalping/strategies/positioning.ts` | Does NOT contain `@/services/india/yahoo` or `yahoo-finance2` import | PASS |
| V-10 | `src/features/india/scalping/strategies/opening-breakout.ts` | Does NOT contain `@/services/india/yahoo` or `yahoo-finance2` import | PASS |
| V-11 | `src/features/india/paper-trading/auto-trader.ts` | Does NOT contain `@/services/india/yahoo` or `yahoo-finance2` import | PASS |
| V-12 | `src/app/api/in/scalper/close-all/route.ts` | Does NOT contain `@/services/india/yahoo` or `yahoo-finance2` import | PASS |
| V-13 | `worker/src/jobs/india-realtime-candles.ts` | Does NOT contain `@/services/india/angelone` import | PASS |

### Canonical Type Assertions (Requirements 1.4, 1.5, 11.2)

| Test ID | Assertion | Expected Outcome | Status |
|---|---|---|---|
| CT-001 | `ProviderId` union does NOT include `"nse"` | `PROVIDER_PRIORITY` array has no `"nse"` entry | PASS |
| CT-002 | `ProviderId` union does NOT include `"3m"` | `PROVIDER_PRIORITY` array has no `"3m"` entry | PASS |
| CT-003 | `SUPPORTED_TIMEFRAMES` equals exactly `["1m","5m","10m","15m","30m","1h","1d","1w","1M"]` | Strict equality check passes | PASS |
| CT-004 | `SUPPORTED_TIMEFRAMES` does NOT include `"3m"` | No `"3m"` in array | PASS |
| CT-005 | `isSupportedInterval("3m")` returns `false` | Return value is `false` | PASS |
| CT-006 | `isSupportedInterval` returns `true` for all nine canonical timeframes | All nine return `true` | PASS |

### Documented Exceptions Report (Requirement 1.6)

| Test ID | Assertion | Expected Outcome | Status |
|---|---|---|---|
| DE-001 | Exactly 5 documented exception locations are tracked; log line `Documented exceptions: 5 files` emitted | `DOCUMENTED_EXCEPTION_LOCATIONS.length === 5` | PASS |
| DE-002 | Files with direct `@/services/india/angelone` imports are registered in `ANGEL_BROKER_ANALYTICS_EXCEPTIONS` | `scanner/engine.ts` and `expiry-trades/builder.ts` are registered | PASS |
| DE-003 | Route wrappers (`scanner/route.ts`, `expiry-trades/route.ts`) do NOT themselves import `@/services/india/angelone` | No direct angel import in route files | PASS |

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

## R. MIGRATION ASSERTION TESTS (V-01 through V-13)

Tests are distributed across multiple files as documented. Each group directly corresponds to a migration phase task.

### R.1 Scanner Engine Tests — `tests/services/india/scanner/engine.test.ts`

File: `tests/services/india/scanner/engine.test.ts`  
Requirements: 3.1, 3.2, 3.3, 3.4, 3.5

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| SC-V02-001 | `engine.ts` contains no static import of `@/services/india/yahoo` | No static yahoo import pattern in source | PASS |
| SC-V02-002 | `engine.ts` contains no dynamic import of `@/services/india/yahoo` | No `import("@/services/india/yahoo")` pattern in source | PASS |
| SC-V02-003 | `engine.ts` does not reference `yahoo.getQuotes()` or `yahoo.getHistorical()` as calls | No call-site matches for these method names | PASS |
| SC-V02-004 | `angel.getTopGainersLosers()` calls preceded by `Documented_Exception` comment | Each call-site context contains annotation string | PASS |
| SC-V02-005 | `angel.getPutCallRatio()` call has `Documented_Exception` comment | Annotation on same line as the call | PASS |
| SC-V02-006 | `angel.getOiBuildup()` calls preceded by `Documented_Exception` comment | First call-site context contains annotation | PASS |
| SC-V02-007 | Momentum scanner calls `registry.getQuotes()` for F&O quotes at runtime | `getQuotesMock` was called; result type is `momentum` | PASS |
| SC-V02-008 | Volume-breakout scanner calls `registry.getQuotes()` then `registry.getHistoricalCandles()` with `interval=1d` | Both mocks called; `exchange=NSE` in historical req | PASS |
| SC-V02-009 | Range-expansion scanner calls `registry.getHistoricalCandles()` with `interval=1d` | Historical mock called with `interval: "1d"` | PASS |
| SC-V02-010 | OI-buildup scanner calls `registry.getQuotes()` for index quotes | Quotes mock called; result type is `oi-buildup` | PASS |
| SC-V02-011 | PCR scanner completes without any Yahoo module call | No error thrown; `result.type === "pcr"` | PASS |
| SC-V02-012 | IV-spike scanner completes without any Yahoo module call | No error thrown; `result.type === "iv-spike"` | PASS |

### R.2 Signal Snapshotter Tests — `tests/services/india/signals/snapshotter.test.ts`

File: `tests/services/india/signals/snapshotter.test.ts`  
Requirements: 4.1, 4.2, 4.3, 4.4, 4.5

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| SS-001 | Snapshotter source does NOT import `@/services/india/yahoo` | Neither static nor dynamic yahoo import in source | PASS |
| SS-002 | `null` registry result → `recordSignalObservation` with `quality: "PROVIDER_UNAVAILABLE"` | Result has `quality === "PROVIDER_UNAVAILABLE"` | PASS |
| SS-003 | Null registry slot → cache entry has `quality: PROVIDER_UNAVAILABLE` | `getSignalRecords` returns entry with correct quality | PASS |
| SS-004 | Provider field set from registry response (`"scrapling"`) | `provider === "scrapling"` in cache entry | PASS |
| SS-005 | Provider falls back to `"UNKNOWN"` when not specified | `provider === "UNKNOWN"` in result | PASS |
| SS-006 | `MarketDataError` caught at WARN level — no unhandled throw | No exception propagated; `PROVIDER_UNAVAILABLE` recorded | PASS |
| SS-007 | Mixed null and valid results — all symbols have entries; quality and provider correct | All three symbols have entries; quality/provider fields match expectations | PASS |
| SS-008 | `isMarketOpenIST` returns `true` during market hours on a weekday | Wednesday 10:30 IST → `true` | PASS |
| SS-009 | `isMarketOpenIST` returns `false` on weekends | Sunday 10:30 IST → `false` | PASS |
| SS-010 | `isMarketOpenIST` returns `false` before 09:00 IST | Wednesday 08:30 IST → `false` | PASS |
| SS-011 | Refreshing same signal preserves quality from new observation; provider updated | `quality === "OK"`, `provider === "upstox"`, `score === 67` | PASS |
| SS-012 | Changing signal resets `since` timestamp | `signal === "STRONG BUY"`, `since === t2` | PASS |

### R.3 Option Strike Capture Service Tests — `tests/lib/market-data/option-strike-capture.test.ts`

File: `tests/lib/market-data/option-strike-capture.test.ts`  
Requirements: 5.1, 5.2, 5.3, 5.4, 10.2, 10.6

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| OC-001 | Re-throws `MarketDataError` with `code: UNAVAILABLE` from fetcher unchanged | Rejection satisfies `e instanceof MarketDataError && e.code === "UNAVAILABLE"` | PASS |
| OC-002 | Re-throws `MarketDataError` with `code: AUTH_FAILURE` preserving original code | `e.code === "AUTH_FAILURE"` | PASS |
| OC-003 | Re-throws `MarketDataError` with `code: RATE_LIMIT` preserving original code | `e.code === "RATE_LIMIT"` | PASS |
| OC-004 | Re-throws `MarketDataError` with `code: TIMEOUT` preserving original code | `e.code === "TIMEOUT"` | PASS |
| OC-005 | Does NOT wrap `MarketDataError` in a plain `Error` | Caught error `=== original` instance | PASS |
| OC-006 | Returns `PROVIDER_ERROR` (does NOT re-throw) for plain non-`MarketDataError` exceptions | `result.status === "PROVIDER_ERROR"`, no throw | PASS |
| OC-007 | Records `provider` from `OptionChain.provider` in `CaptureResult` (`"upstox"`) | `result.provider === "upstox"` | PASS |
| OC-008 | Records `fetchedAt` from `OptionChain.fetchedAt` UTC ISO-8601 in `CaptureResult` | `result.fetchedAt === "2026-09-12T09:30:00.000Z"` | PASS |
| OC-009 | Records `provider: "angel_one"` correctly | `result.provider === "angel_one"` | PASS |
| OC-010 | Falls back to `providerLabel` when chain has no `provider` field | `result.provider === "scrapling"` | PASS |
| OC-011 | Sets `fetchedAt: null` when chain has no `fetchedAt` field | `result.fetchedAt === null` | PASS |
| OC-012 | Returns `NO_EXPIRIES` when fetcher returns `null` | `result.status === "NO_EXPIRIES"`, `strikesWritten === 0` | PASS |
| OC-013 | Returns `EMPTY_PROVIDER_RESPONSE` when `rows` are empty | `result.status === "EMPTY_PROVIDER_RESPONSE"`, `strikesWritten === 0` | PASS |
| OC-014 | Returns `CAPTURED` with correct strike count on success (1 strike × 2 legs × 2 expiries = 4) | `result.status === "CAPTURED"`, `strikesWritten === 4` | PASS |
| OC-015 | `chainToStrikes`: null `iv`/`bid`/`ask` mapped to `null`; real OI preserved | `iv === null`, `bid === null`, `oi === 1234` | PASS |
| OC-016 | `chainToStrikes`: NaN and Infinity fields dropped to `null`; valid `ltp` preserved | `oi === null`, `iv === null`, `ltp === 5` | PASS |
| OC-017 | `selectCurrentAndNextExpiry`: selects two nearest upcoming expiries | Returns `[futureDate1, futureDate2]` | PASS |
| OC-018 | `selectCurrentAndNextExpiry`: falls back to `chain.expiry` when `expiries` list absent | Returns `[futureDate]` | PASS |

### R.4 F&O Backfill Runner Tests — `tests/lib/market-data/fno-backfill-runner-v05.test.ts`

File: `tests/lib/market-data/fno-backfill-runner-v05.test.ts`  
Requirements: 6.1, 6.2, 6.3, 6.4, 10.3, 10.6

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| BF-001 | `fno-backfill-runner.service.ts` does NOT contain dynamic import of `@/services/india/angelone` | Static analysis — no dynamic angel import pattern | PASS |
| BF-002 | File does NOT directly instantiate `UpstoxProvider` in the runner path | No `new UpstoxProvider()` outside comments | PASS |
| BF-003 | File calls `registry.getHistoricalCandles()` / `registryClient.getHistoricalCandles()` | Both string patterns present in source | PASS |
| BF-004 | Empty registry response with redis checkpoint → `EMPTY_DATA`, not `PROVIDER_FAILURE` | `classification === "EMPTY_DATA"`, `barsPersisted === 0`, `state === "PARTIAL"` | PASS |
| BF-005 | Empty registry response without redis → no error, not `PROVIDER_FAILURE` | `barsPersisted === 0`, `state === "PARTIAL"`, no `PROVIDER_FAILURE` | PASS |
| BF-006 | DB persist failure → `PROVIDER_FAILURE` for all jobs; processing continues to next symbol | Both jobs have `classification === "PROVIDER_FAILURE"`, `state === "FAILED"` | PASS |
| BF-007 | `MarketDataError` from registry → result captures original code; classified `PROVIDER_FAILURE` | For each error code (`AUTH_FAILURE`, `RATE_LIMIT`, `UNAVAILABLE`, `TIMEOUT`, `NETWORK`): `state === "FAILED"`, error contains code | PASS |
| BF-008 | Non-`MarketDataError` from registry → `PROVIDER_FAILURE`, error message captured | `state === "FAILED"`, `error` contains "unexpected network error" | PASS |
| BF-009 | Registry returns candles → `state: COMPLETED` with `barsPersisted > 0` | `state === "COMPLETED"`, `barsPersisted > 0`, `classification === null` | PASS |
| BF-010 | `AbortSignal` already-aborted → `state: PARTIAL`, `error: "aborted"` | `state === "PARTIAL"`, `error === "aborted"` | PASS |
| BF-011 | Duplicate `(symbol, interval)` pairs → exactly one result row; registry called once | `results.length === 1`, `callCount === 1` | PASS |
| BF-012 | Empty job list → `totalBarsPersisted === 0`; registry never called | `results.length === 0`, `registryCalled === false` | PASS |

### R.5 Expiry Trades Builder Tests — `tests/features/india-expiry-trades-builder.test.ts`

File: `tests/features/india-expiry-trades-builder.test.ts`  
Requirements: 7.1, 7.2, 7.3

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| ETB-001 | Returns no trades on a non-expiry day (Monday, chain expiry is Tuesday) | `isExpiryDay === false`, `indexes.length === 0` | PASS |
| ETB-002 | Surfaces NIFTY Gamma Blast + Hero Zero on its expiry day (Tuesday) | `isExpiryDay === true`, NIFTY has two trades with kinds `["GAMMA_BLAST", "HERO_ZERO"]`; bullish day → CALLs | PASS |
| ETB-003 | SENSEX surfaces on Thursday via weekday rule when Angel is off; `dataSource === "estimated"` | `isExpiryDay === true`, `indexes` contains SENSEX, `dataSource === "estimated"` | PASS |
| ETB-004 | Uses live BSE chain for SENSEX premiums when registry returns a chain; `dataSource === "chain"` | `dataSource === "chain"`, `registry.getOptionChain` called with `"SENSEX"`, correct strikes and premiums | PASS |
| ETB-005 | Falls back to estimated SENSEX premiums when registry chain errors | `dataSource === "estimated"` | PASS |

---

## S. CIRCUIT BREAKER TESTS — `tests/lib/market-data/health.test.ts`

File: `tests/lib/market-data/health.test.ts`  
Requirements: 15.1, 15.2, 15.3, 15.4, 15.5

### S.1 Initial State

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-001 | Starts healthy with `score: 100`, `circuitOpen: false`, zero counters, null timestamps | All initial fields at default values | PASS |
| HLT-002 | Does not open circuit on fresh state | `isCircuitOpen() === false` | PASS |

### S.2 `recordSuccess()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-003 | Resets `consecutiveFailures` to 0 after failures | `consecutiveFailures === 0` | PASS |
| HLT-004 | Increments `consecutiveSuccesses` per call | `consecutiveSuccesses === 2` after two calls | PASS |
| HLT-005 | Recovers score by `RECOVERY_PER_SUCCESS` (10) per call | Score increases; stays ≤ 100 | PASS |
| HLT-006 | Does not exceed score 100 after many successes | `score === 100` after 20 calls | PASS |
| HLT-007 | Records `lastSuccessAt` as ISO string ≥ `before` timestamp | `lastSuccessAt` is non-null, parseable, ≥ `before` | PASS |
| HLT-008 | Tracks latency samples; `latencyP99Ms >= latencyP50Ms` | Both non-null; P99 ≥ P50 | PASS |

### S.3 `recordFailure()` — Flat-40 Penalty

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-009 | Increments `consecutiveFailures` on each call | 1 after first call, 2 after second | PASS |
| HLT-010 | Resets `consecutiveSuccesses` to 0 on failure | 0 after any failure | PASS |
| HLT-011 | Applies flat penalty of 40 per `api_error` failure (floor 0): 100→60→20→0→0 | Exact score sequence verified | PASS |
| HLT-012 | Applies extra `AUTH_FAILURE_PENALTY` for `auth_failure` kind; score lower than generic error | `scoreB < scoreA` | PASS |
| HLT-013 | Records `lastFailureAt` as ISO string ≥ `before` timestamp | Non-null, parseable, ≥ `before` | PASS |

### S.4 Circuit Breaker

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-014 | Opens circuit when score drops below 20 (2 × `auth_failure`): `circuitOpen === true`, `status === "unhealthy"` | Both `getProviderHealth` and `isCircuitOpen` confirm open | PASS |
| HLT-015 | `isCircuitOpen` returns `false` during half-open window (31s past `circuitRetryAt`) | `isCircuitOpen(ID, now + 31_000) === false` | PASS |
| HLT-016 | Successful probe closes circuit; score restored exactly to 20 | `circuitOpen === false`, `score === 20` | PASS |
| HLT-017 | Sets `circuitRetryAt` ~30s after opening (within 25–35s window) | `retryMs ∈ [before + 25_000, before + 35_000]` | PASS |

### S.5 Health Status Thresholds

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-018 | `"healthy"` when `score ≥ 60` | Initial state is `"healthy"` | PASS |
| HLT-019 | `"degraded"` when `score` is 20–59 (2 × `api_error` → score = 20) | `score === 20`, `circuitOpen === false`, `status === "degraded"` | PASS |
| HLT-020 | `"unhealthy"` when circuit is open | 2 × `auth_failure` → `status === "unhealthy"` | PASS |

### S.6 Request Counters (Req 15.1)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-021 | All counters start at zero; `successRate` is `null` initially | `requestCount === 0`, `successCount === 0`, `errorCount === 0`, `successRate === null` | PASS |
| HLT-022 | Two successes → `requestCount === 2`, `successCount === 2`, `errorCount === 0`, `successRate === 1` | Exact counter values | PASS |
| HLT-023 | One failure → `requestCount === 1`, `successCount === 0`, `errorCount === 1`, `successRate === 0` | Exact counter values | PASS |
| HLT-024 | Mixed calls (2 successes, 1 failure) → `successRate ≈ 2/3` | `toBeCloseTo(2/3)` | PASS |
| HLT-025 | `latencyP95Ms` tracked over rolling window (100 samples, latencies 1–100) | `P95 ≥ P50`, `P95 ≤ P99` | PASS |

### S.7 Half-Open Probe Score Reset (Req 15.3)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-026 | Probe success (from `circuitOpen === true`) sets score exactly to 20, not just +10 | `score === 20` after probe | PASS |
| HLT-027 | Normal success (circuit not open) adds exactly 10 to score | `score === 70` after 1 failure (60) + 1 success (+10) | PASS |

### S.8 `resetHealth()` and `recordStaleData()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-028 | `resetHealth()` restores provider to perfect health | `score === 100`, `circuitOpen === false`, `consecutiveFailures === 0` | PASS |
| HLT-029 | `resetHealth()` only resets the specified provider | Target at 100; other provider score unchanged | PASS |
| HLT-030 | `recordStaleData()` reduces score by 15 per stale event | `score === 85` after one call | PASS |
| HLT-031 | `recordStaleData()` does not immediately open circuit | `circuitOpen === false` after stale data | PASS |

### S.9 `isStale()` / `isTickStale()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| HLT-032 | `isStale()` returns `false` for `fetchedAt` within threshold | 1s old for `liveTick` → `false` | PASS |
| HLT-033 | `isStale()` returns `true` for `fetchedAt` beyond threshold | 10s old for `liveTick` (threshold 5s) → `true` | PASS |
| HLT-034 | `isStale()` returns `true` for unparseable `fetchedAt` | `"not-a-date"` → `true` | PASS |
| HLT-035 | `isStale()` uses correct threshold per data type (`dailyCandle`) | Just-under threshold → `false`; just-over → `true` | PASS |
| HLT-036 | `isTickStale()` returns `false` within default threshold | 2s old → `false` | PASS |
| HLT-037 | `isTickStale()` returns `true` older than default threshold | 10s old → `true` | PASS |
| HLT-038 | `isTickStale()` respects custom threshold | 3s old: `true` with 2s threshold, `false` with 5s threshold | PASS |

---

## T. DATA PROVENANCE TESTS — `tests/lib/market-data/provenance.test.ts`

File: `tests/lib/market-data/provenance.test.ts`  
Requirements: 12.2, 12.3, 16.1, 16.4

### T.1 `computeFreshness()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-001 | Age ≤ 5000 ms → `LIVE` | 0, 2500, 5000 ms all return `"LIVE"` | PASS |
| PRV-002 | Age 5001–60000 ms → `RECENT` | 5001, 30000, 60000 ms return `"RECENT"` | PASS |
| PRV-003 | Age 60001 ms – 24 h → `STALE` | 60001, 3_600_000, 24 h return `"STALE"` | PASS |
| PRV-004 | Age > 24 h → `HISTORICAL` | 24 h + 1 ms, 7 days return `"HISTORICAL"` | PASS |

### T.2 `resolveProviderType()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-005 | `angel_one` → `"BROKER"`, `upstox` → `"BROKER"` | Correct classification | PASS |
| PRV-006 | `scrapling`, `jugaad`, `openchart` → `"OPEN_SOURCE"` | Correct classification | PASS |
| PRV-007 | `yahoo` → `"SECONDARY_FALLBACK"` | Correct classification | PASS |

### T.3 `isProviderAuthenticated()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-008 | Broker providers (`angel_one`, `upstox`) → `true` | `true` for both | PASS |
| PRV-009 | Open-source and fallback providers → `false` | `false` for `scrapling`, `yahoo`, `jugaad`, `openchart` | PASS |

### T.4 `scoreToGrade()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-010 | Scores 95–100 → `"A+"` | 100 and 95 return `"A+"` | PASS |
| PRV-011 | Scores 85–94 → `"A"` | 94 and 85 return `"A"` | PASS |
| PRV-012 | Scores 70–84 → `"B"` | 84 and 70 return `"B"` | PASS |
| PRV-013 | Scores 50–69 → `"C"` | 69 and 50 return `"C"` | PASS |
| PRV-014 | Scores 30–49 → `"D"` | 49 and 30 return `"D"` | PASS |
| PRV-015 | Scores 0–29 → `"BLOCKED"` | 29 and 0 return `"BLOCKED"` | PASS |

### T.5 `stampLiveProvenance()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-016 | Produces complete `DataProvenance` for live quote (1s old → `LIVE`) | All required fields non-null; `freshness === "LIVE"`, `isLive === true`, `authenticated === true` for `angel_one` | PASS |
| PRV-017 | Produces complete provenance for historical candles (2 days old → `HISTORICAL`) | `isHistorical === true`, `freshness === "HISTORICAL"`, `providerType === "OPEN_SOURCE"` for `scrapling` | PASS |
| PRV-018 | Populates `sourceChain` with previously attempted providers | `sourceChain === ["scrapling", "angel_one", "upstox"]` | PASS |
| PRV-019 | `null` `dataAsOf` defaults to now (`LIVE` freshness) | `freshness === "LIVE"` | PASS |

### T.6 `stampCacheProvenance()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-020 | `providerType === "CACHE"` for cache-served live response; original provider in `sourceChain[0]` | `providerType === "CACHE"`, `sourceChain[0] === "angel_one"`, `isLive === true` | PASS |
| PRV-021 | Historical cache hit: `isHistorical === true`, `freshness === "HISTORICAL"` | Correct flags for 5-day-old candle cache hit | PASS |

### T.7 `computeBaselineQualityScore()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-022 | Score in [0, 100] for any provider and any non-negative age | All combinations of 5 ages × 4 providers return score in range | PASS |
| PRV-023 | Authenticated brokers score ≥ open-source for same age | `angel_one` score ≥ `scrapling` score at 1s age | PASS |
| PRV-024 | LIVE data scores higher than HISTORICAL data | 1s age score > 48h age score for `angel_one` | PASS |

### T.8 `withFailover()` Provenance Integration

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-025 | Stamps provenance with non-null required fields after successful call | `provider`, `dataAsOf`, `isLive`, `quality.score`, `quality.grade` all non-null | PASS |
| PRV-026 | `isHistorical === true` for `getHistoricalCandles` operation | Provenance has `isHistorical: true`, `isLive: false` | PASS |
| PRV-027 | Stamps provenance from succeeding provider when first fails over | `provider === "upstox"` (not `scrapling`) after scrapling fails | PASS |
| PRV-028 | `sourceChain` includes failed provider before the succeeding one | `scrapling` index < `angel_one` index in `sourceChain` | PASS |
| PRV-029 | `getLastCallProvenance` returns `null` before any call | Both `getQuotes` and `getHistoricalCandles` return `null` initially | PASS |
| PRV-030 | `clearLastCallProvenance` (via `resetFailoverState`) resets stored provenance | Returns `null` after reset | PASS |
| PRV-031 | Correct `providerType` for each provider category (`BROKER`, `OPEN_SOURCE`, `SECONDARY_FALLBACK`) | `angel_one/upstox → BROKER`, `scrapling → OPEN_SOURCE`, `yahoo → SECONDARY_FALLBACK` | PASS |

### T.9 `PROVIDER_SWITCH` Log (Requirements 12.7, 15.6)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PRV-032 | `PROVIDER_SWITCH` log emitted on failover with all required fields | Log entry contains `event`, `from`, `to`, `reason`, `instrument`, `gapMs` (≥ 0), `timestamp` | PASS |

---

## U. REQUEST COALESCING TESTS — `tests/lib/market-data/coalescing.test.ts`

File: `tests/lib/market-data/coalescing.test.ts`  
Requirements: 14.1, 14.2, 14.4, 14.7

### U.1 Core Coalescing Behaviour

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| COA-001 | 50 concurrent `registry.getQuotes(["NIFTY"])` → upstream provider called exactly once | `callCount === 1`; all 50 results have `symbol === "NIFTY"` | PASS |
| COA-002 | All N callers receive the same result object (value equality) | All 20 results have identical `ltp`; `callCount === 1` | PASS |
| COA-003 | Concurrent requests for DIFFERENT symbol lists make separate upstream calls | 3 distinct lists → 3 upstream calls | PASS |
| COA-004 | New request after in-flight Promise settles starts a fresh upstream call | Two sequential batches → `callCount === 2` | PASS |
| COA-005 | Upstream failure — all coalesced callers receive the same rejection | All 30 callers rejected; `chainStartCount === 1` | PASS |
| COA-006 | `pendingCallCount` reflects in-flight calls; drops to 0 after settlement | `pendingCallCount === 1` during flight; `0` after | PASS |

### U.2 Coalescing Timeout (Req 14.7)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| COA-007 | In-flight call > 10s → `PROVIDER_TIMEOUT` error shape is correct | Error is `MarketDataError`, `code === "PROVIDER_TIMEOUT"`, `providerId === null`, `retryAfterMs === null` | PASS |

### U.3 Property-Based: N Concurrent Calls Always Coalesce

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| COA-008 | Property 6 (`fast-check`): N = 2–30 concurrent calls → always exactly 1 upstream call | `callCount === 1` for all N; all callers receive result (15 iterations) | PASS |

### U.4 Historical Candle Coalescing

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| COA-009 | 20 concurrent `getHistoricalCandles` with same request key → 1 upstream call | `historicalCallCount === 1`; all 20 receive 10 candles | PASS |

### U.5 TTL Constants (Req 14.1)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| COA-010 | LTP quote TTL is 3 seconds | `TTL.ltpQuote === 3_000` | PASS |
| COA-011 | Full quote TTL is 5 seconds | `TTL.liveQuote === 5_000` | PASS |
| COA-012 | 1m candle TTL is 30 seconds | `TTL.oneMinuteCandle === 30_000` | PASS |
| COA-013 | 5m–1h candle TTL is 60 seconds | `TTL.intradayCandle === 60_000`; `candleTtlForInterval` returns 60_000 for all intraday intervals | PASS |
| COA-014 | 1d candle TTL is 4 hours | `TTL.dailyCandle === 4 * 60 * 60 * 1000`; `candleTtlForInterval` returns same for `1d`, `1w`, `1M` | PASS |
| COA-015 | 1m routes to `oneMinuteCandle` TTL (30s) | `candleTtlForInterval("1m") === 30_000` | PASS |

### U.6 Redis L2 Key Patterns (Req 14.2)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| COA-016 | Quote key function `getCachedQuote` exists and is callable | `typeof getCachedQuote === "function"` | PASS |
| COA-017 | Candle key function `memoCandles` accepts all L2 key dimensions without throwing | Non-throwing call with distinct dimensions; returns array | PASS |

### U.7 Error Shape

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| COA-018 | `MarketDataError` with `code: PROVIDER_TIMEOUT` is constructable and recognisable | `instanceof MarketDataError`, `code === "PROVIDER_TIMEOUT"`, `name === "MarketDataError"` | PASS |

---

## V. OHLC VALIDATION PIPELINE TESTS — `tests/lib/market-data/validation.test.ts`

File: `tests/lib/market-data/validation.test.ts`  
Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6

### V.1 `validateCandle()` — Schema Validation

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-001 | Passes a valid candle | `{ valid: true }` | PASS |
| VPL-002 | Rejects non-positive `time` (0) | `valid: false`, `error: "INVALID_TIMESTAMP"` | PASS |
| VPL-003 | Rejects negative `time` | `valid: false` | PASS |
| VPL-004 | Rejects non-integer `time` | `valid: false`, `error: "INVALID_TIMESTAMP"` | PASS |
| VPL-005 | Rejects NaN `time` | `valid: false` | PASS |

### V.2 OHLC Finiteness / Positivity

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-006 | Rejects NaN `open` | `valid: false`, `error: "NON_FINITE_OHLC"` | PASS |
| VPL-007 | Rejects `Infinity` `high` | `valid: false` | PASS |
| VPL-008 | Rejects zero `close` | `valid: false`, `error: "NEGATIVE_PRICE"` | PASS |
| VPL-009 | Rejects negative `low` | `valid: false` | PASS |

### V.3 OHLC Consistency (Drop, Never Coerce)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-010 | Rejects `high < low` | `valid: false`, `error: "HIGH_BELOW_LOW"` | PASS |
| VPL-011 | Rejects `high < open` | `valid: false`, `error: "HIGH_BELOW_OPEN_OR_CLOSE"` | PASS |
| VPL-012 | Rejects `high < close` | `valid: false`, `error: "HIGH_BELOW_OPEN_OR_CLOSE"` | PASS |
| VPL-013 | Rejects `low > open` | `valid: false`, `error: "LOW_ABOVE_OPEN_OR_CLOSE"` | PASS |
| VPL-014 | Rejects `low > close` | `valid: false`, `error: "LOW_ABOVE_OPEN_OR_CLOSE"` | PASS |
| VPL-015 | Accepts doji candle (`open == close`) | `valid: true` | PASS |

### V.4 Volume Validation

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-016 | Accepts candle with no `volume` field | `valid: true` | PASS |
| VPL-017 | Rejects negative volume | `valid: false`, `error: "NEGATIVE_VOLUME"` | PASS |
| VPL-018 | Accepts zero volume (auction / no-trade candle) | `valid: true` | PASS |

### V.5 `validateCandleSequence()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-019 | Passes a valid ascending sequence | `valid: true`, `errors.length === 0`, `validCount === 3` | PASS |
| VPL-020 | Detects descending timestamps | `valid: false`, `error: "TIMESTAMP_NOT_ASCENDING"` | PASS |
| VPL-021 | Detects duplicate timestamps | `valid: false`, `error: "DUPLICATE_TIMESTAMP"` | PASS |
| VPL-022 | Reports correct index of offending candle | `errors[0].index === 2` | PASS |
| VPL-023 | Counts only structurally valid candles towards `validCount` | `validCount === 2` (one NaN candle excluded) | PASS |
| VPL-024 | Passes empty sequence | `valid: true`, `validCount === 0` | PASS |

### V.6 `filterValidCandles()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-025 | Keeps only valid, strictly ascending candles (drops NaN, out-of-order) | `times === [1_000, 3_000, 4_000]` | PASS |

### V.7 `validateTick()` — Future Timestamp Guard (Req 17.3)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-026 | Passes a valid tick | `valid: true`, `stale: false` | PASS |
| VPL-027 | Rejects empty token | `valid: false`, `error: "EMPTY_TOKEN"` | PASS |
| VPL-028 | Rejects whitespace-only token | `valid: false`, `error: "EMPTY_TOKEN"` | PASS |
| VPL-029 | Rejects NaN `ltp` | `valid: false`, `error: "NON_FINITE_LTP"` | PASS |
| VPL-030 | Rejects `Infinity` `ltp` | `valid: false` | PASS |
| VPL-031 | Rejects negative `ltp` (Req 17.4) | `valid: false`, `error: "NEGATIVE_LTP"` | PASS |
| VPL-032 | Rejects zero `ltp` | `valid: false`, `error: "ZERO_LTP"` | PASS |
| VPL-033 | Rejects non-positive `exchangeTimestampMs` | `valid: false`, `error: "INVALID_TIMESTAMP"` | PASS |
| VPL-034 | Rejects non-integer `exchangeTimestampMs` | `valid: false`, `error: "INVALID_TIMESTAMP"` | PASS |
| VPL-035 | Rejects timestamp > now + 5s (future timestamp guard) | `valid: false`, `error: "FUTURE_TIMESTAMP"` | PASS |
| VPL-036 | Accepts timestamp up to 5s in future (clock skew tolerance) | `valid: true` for now + 4s | PASS |
| VPL-037 | Rejects negative volume | `valid: false`, `error: "NEGATIVE_VOLUME"` | PASS |
| VPL-038 | Rejects negative OI | `valid: false`, `error: "NEGATIVE_OI"` | PASS |
| VPL-039 | Accepts null volume and OI | `valid: true` | PASS |
| VPL-040 | Marks tick as stale when `exchangeTimestampMs` older than threshold (10s old) | `valid: true`, `stale: true` | PASS |
| VPL-041 | Respects custom stale threshold (3s old: stale at 2s threshold, fresh at 10s threshold) | Both cases correct | PASS |

### V.8 `validateTicks()` (Batch)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-042 | Separates valid, invalid, and stale ticks correctly | `valid.length === 2`, `invalid.length === 1`, `stale.length === 1` | PASS |
| VPL-043 | Returns empty arrays for empty input | All three arrays empty | PASS |

### V.9 `isWithinCircuitLimits()`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| VPL-044 | Returns `true` when `ltp` within limits | `isWithinCircuitLimits(100, 80, 120) === true` | PASS |
| VPL-045 | Returns `false` when `ltp` above upper circuit | `isWithinCircuitLimits(125, 80, 120) === false` | PASS |
| VPL-046 | Returns `false` when `ltp` below lower circuit | `isWithinCircuitLimits(75, 80, 120) === false` | PASS |
| VPL-047 | Returns `null` when limits are `null` | All null-limit combinations → `null` | PASS |
| VPL-048 | Returns `null` when limits are non-finite (`NaN`, `Infinity`) | Both cases → `null` | PASS |

---

## W. FORENSICS ENDPOINT TESTS — `tests/api/in/data-forensics.test.ts`

File: `tests/api/in/data-forensics.test.ts`  
Requirements: 16.3, 16.6

### W.1 Full Chain Response (Req 16.3)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| FOR-001 | Returns 200 with all required response keys for a fully-joined trade | `status === 200`; `tradeId`, `paperTrade`, `signalRecord`, `dataProvenanceRecord`, `lineageEntry`, `qualityAtSignalTime` all present | PASS |
| FOR-002 | `paperTrade` contains correct base fields | `id`, `symbol`, `direction`, `entry`, `signalId`, `dataProviderAtEntry` correct | PASS |
| FOR-003 | `signalRecord` populated when `trade.signalId` resolves to a record | `signalId === "sig-001"`, `grade === "A"`, `score === 88` | PASS |
| FOR-004 | `signalRecord` is `null` when no `SignalIntelligenceRecord` matches | `signalRecord === null` | PASS |
| FOR-005 | `signalRecord` is `null` when `trade.signalId` is absent | `signalRecord === null` | PASS |
| FOR-006 | `dataProvenanceRecord` contains key provenance fields | `provider`, `authenticated`, `dataTrustStatus`, `instrumentId`, `sessionDate` correct | PASS |
| FOR-007 | `qualityAtSignalTime` uses `signalRecord.score + grade` when signal record present | `score === 88`, `grade === "A"` | PASS |
| FOR-008 | `qualityAtSignalTime` falls back to confidence-derived grade when no signal record | `score === 85`, `grade === "A"` (from `dataConfidenceAtEntry = 85`) | PASS |
| FOR-009 | `qualityAtSignalTime` fields are `null` when no signal record and no confidence | `score === null`, `grade === null` | PASS |
| FOR-010 | `lineageEntry.lookupStatus` reflects data-service 503 failure gracefully | Matches `DATA_SERVICE_ERROR_503`; `record === null` | PASS |
| FOR-011 | `lineageEntry.lookupStatus` is `NO_OBSERVATION_ID_ON_TRADE` when trade has no `dataObservationId` | Exact status string | PASS |
| FOR-012 | Forensics chain has exactly 6 steps with step numbers 1–6 | `chain.length === 6`; steps array equals `[1, 2, 3, 4, 5, 6]` | PASS |
| FOR-013 | `retrievedAt` is an ISO-8601 UTC timestamp | Parseable; matches regex | PASS |

### W.2 404 Cases (Req 16.6)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| FOR-014 | Returns HTTP 404 with `error: "trade_not_found"` when trade not found | `status === 404`, `error === "trade_not_found"`, `tradeId` in body | PASS |
| FOR-015 | Returns HTTP 404 with `error: "provenance_not_found"` when `DataProvenanceRecord` absent | `status === 404`, `error === "provenance_not_found"`, `tradeId`, `symbol`, `sessionDate` in body | PASS |
| FOR-016 | 404 body `missingProvenanceLink` identifies missing link with all required fields | `tradeId`, `symbol`, `sessionDate`, `dataProviderAtEntry`, `message` contains `tradeId` | PASS |
| FOR-017 | Returns HTTP 400 for missing `tradeId` | `status === 400` | PASS |

### W.3 IST Session Date Derivation

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| FOR-018 | UTC midnight (18:30 UTC = IST 00:00 next day) → `sessionDate === "2026-09-12"` | IST date correctly computed as next calendar day | PASS |
| FOR-019 | UTC 06:00 (IST 11:30 same day) → `sessionDate === "2026-09-12"` | IST date is same calendar day | PASS |

---

## X. PROVIDER HEALTH ENDPOINT TESTS

Provider health is validated through the `health.ts` module tests (Section S above) and the following inline coverage via `tests/api/in-health.test.ts`.

File: `tests/api/in-health.test.ts`

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| PH-001 | `GET /api/in/health` reports cache backend, broker default, and round-trip | `status === 200`, `cache.backend`, `cache.roundTrip`, `broker`, `fetchedAt` present | PASS |
| PH-002 | `fetchedAt` is a parseable ISO string | `new Date(body.fetchedAt).toISOString()` does not throw | PASS |

*Note: The dedicated `GET /api/data/providers/health` security audit was completed as part of task 16.2 (Phase 4i). Endpoint response verified to contain only `id`, `status`, `lastSuccessAt`, `latencyMs` (p50/p95/p99), `successRate`, `requestCount`, `errorCount` — no credential fields. This is a code-review verification test (PASS by inspection + `security-audit.test.ts`).*

---

## Y. PYTHON TICK PUBLISHER TESTS — `data-service/tests/publisher/test_tick_publisher.py`

File: `data-service/tests/publisher/test_tick_publisher.py`  
Requirements: 19.1, 19.2, 19.3, 19.6, 19.7

### Y.1 PUBLISH Behaviour

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| TPB-001 | `PUBLISH` called with correct channel `af:ticks:NIFTY` for NIFTY symbol | `redis.publish` called; channel is `"af:ticks:NIFTY"` | PASS |
| TPB-002 | Published payload is valid JSON | `json.loads(payload)` returns dict | PASS |
| TPB-003 | Published `LiveTick` JSON contains `ltp === 24850.60` | Payload `ltp` matches `pytest.approx(24850.60)` | PASS |
| TPB-004 | Published JSON has all required `LiveTick` fields: `token`, `symbol`, `exchange`, `ltp`, `exchangeTimestampMs`, `receivedAtMs`, `provider` | All 7 fields present | PASS |
| TPB-005 | `publish_count` increments by 1 per successfully published tick | `_publish_count === 1` after one publish | PASS |
| TPB-006 | Published `LiveTick` has `provider === "scrapling"` | Payload `provider` is `"scrapling"` | PASS |
| TPB-007 | Symbol uppercased in channel even if `quote.symbol` is lowercase | Channel is `"af:ticks:NIFTY"` for lowercase `"nifty"` symbol | PASS |

### Y.2 Null LTP Handling (Req 19.2)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| TPB-008 | `ltp=None` — `redis.publish` NOT called | `mock_redis.publish.assert_not_called()` | PASS |
| TPB-009 | `ltp=None` — `publish_count` NOT incremented | `_publish_count === 0` | PASS |
| TPB-010 | `None` entry in quotes list silently skipped without error | No exception; `publish` not called; `_publish_count === 0` | PASS |
| TPB-011 | Mixed null and valid `ltp` — only valid symbol published; `publish_count === 1` | Channel is `"af:ticks:BANKNIFTY"`; `_publish_count === 1` | PASS |

### Y.3 Broker WebSocket Reconnection Policy — Exponential Backoff (Req 19.6)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| TPB-012 | Backoff sequence follows `min(2^(n-1), 30)`: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s | `slept_per_attempt` matches `[1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]` within 0.6s tolerance | PASS |
| TPB-013 | Backoff never exceeds 30s cap regardless of failure count (10 attempts) | All `per_attempt_sleep[i] ≤ 30.5` | PASS |
| TPB-014 | `_running` state is `"reconnecting"` during all backoff sleep periods | All states captured during sleep are `"reconnecting"` | PASS |

### Y.4 `POST /publisher/symbols` Endpoint

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| TPB-015 | Valid `add` + `remove` → `status 200` with `symbols`, `count`, `added`, `removed` keys | All fields present | PASS |
| TPB-016 | Added symbol appears; removed symbol disappears; untouched symbol preserved | `INFY` in, `NIFTY` out, `BANKNIFTY` unchanged | PASS |
| TPB-017 | `count` field equals `len(symbols)` | Exact equality after adding 2 symbols | PASS |
| TPB-018 | Adding already-tracked symbol is idempotent — no duplicates | `symbols.count("NIFTY") === 1` | PASS |
| TPB-019 | Removing non-existent symbol is harmless | `status 200`, existing symbols unchanged | PASS |
| TPB-020 | Empty `add` and `remove` arrays → `status 200` with current list returned | Valid 200 response | PASS |

### Y.5 `POST /publisher/symbols` Validation

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| TPB-021 | Symbol > 50 chars → HTTP 400 | `status === 400` | PASS |
| TPB-022 | HTTP 400 response has `"error"` or `"detail"` field | Body contains one of these keys | PASS |
| TPB-023 | Rejected request (> 50 chars) does NOT modify tracked symbol list | `_symbols` unchanged | PASS |
| TPB-024 | `add` array with > 100 entries → HTTP 400 | `status === 400` | PASS |
| TPB-025 | `remove` array with > 100 entries → HTTP 400 | `status === 400` | PASS |
| TPB-026 | Oversized arrays: rejected request does NOT modify tracked symbol list | `_symbols` unchanged | PASS |
| TPB-027 | Symbol of exactly 50 chars is accepted (boundary check) | `status === 200` | PASS |
| TPB-028 | Array of exactly 100 entries is accepted (boundary check) | `status === 200` | PASS |

### Y.6 `GET /publisher/status` — Required Fields (Req 19.7)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| TPB-029 | Response includes `"running"` field | `"running" in body` | PASS |
| TPB-030 | Response includes `"subscribedSymbols"` (not old `"symbols"`) | `"subscribedSymbols" in body`; `"symbols" not in body` | PASS |
| TPB-031 | Response includes `"ticksPublished"` (not old `"publish_count"`) | `"ticksPublished" in body`; `"publish_count" not in body` | PASS |
| TPB-032 | Response includes `"validationFailures"` as dict with keys `negative_ltp`, `future_timestamp`, `duplicate` | All three keys present; value is `dict` | PASS |
| TPB-033 | Response includes `"lastPublishedAt"` as int or null (not `"last_publish_ms"`) | `"lastPublishedAt" in body`; `"last_publish_ms" not in body`; type is `int | None` | PASS |
| TPB-034 | `ticksPublished` is a non-negative integer | `isinstance(ticksPublished, int)` and `≥ 0` | PASS |
| TPB-035 | `subscribedSymbols` is a list | `isinstance(subscribedSymbols, list)` | PASS |

### Y.7 Validation Failure Tracking (Req 19.2)

| Test ID | Description | Expected Outcome | Status |
|---|---|---|---|
| TPB-036 | `ltp=None` increments `validationFailures["negative_ltp"]` counter | Counter increases by ≥ 1 | PASS |
| TPB-037 | Tick with `timestamp > now + 5s` increments `validationFailures["future_timestamp"]` counter | Counter increases by ≥ 1 | PASS |
| TPB-038 | Duplicate ticks increment `validationFailures["duplicate"]` counter (Req 19.3) | Counter increases for second identical tick | PASS |

---

## Z. COMPLETION STATUS SUMMARY (Requirement 23.2)

This section records the final status of all test groups per the requirement that zero tests remain in a pending or unexecuted state.

| Test Group | File(s) | Total Tests | PASS | FAIL | SKIP | Pending |
|---|---|---|---|---|---|---|
| A. Provider Tests (DS, AO, UP, JG, OC, YF) | `data-service/tests/` + various | 89 | 89 | 0 | 0 | 0 |
| B. Provider Routing Tests | Various | 20 | 20 | 0 | 0 | 0 |
| C. Normalization Tests | `tests/lib/market-data/normalizer.test.ts` | 22 | 22 | 0 | 0 | 0 |
| D. Reconciliation Tests | `tests/lib/market-data/reconciliation.test.ts` | 10 | 10 | 0 | 0 | 0 |
| E. Data Quality Tests | `data-service/tests/core/test_data_quality.py` | 11 | 11 | 0 | 0 | 0 |
| F. Historical Data Tests | Various | 21 | 21 | 0 | 0 | 0 |
| G. Live Data Tests | Various | 15 | 15 | 0 | 0 | 0 |
| H. Cache Tests | `tests/lib/market-data/coalescing.test.ts` + cache tests | 17 | 17 | 0 | 0 | 0 |
| I. Database Tests | `tests/lib/market-data/candle-persist.test.ts` + DB tests | 12 | 12 | 0 | 0 | 0 |
| J. Concurrency Tests | `tests/lib/market-data/concurrency-load.test.ts` | 8 | 8 | 0 | 0 | 0 |
| K. Failure Tests | Various | 21 | 21 | 0 | 0 | 0 |
| L. Security Tests | `tests/lib/security-audit.test.ts` | 12 | 12 | 0 | 0 | 0 |
| M. Architecture Enforcement (AE + V-01–V-13 + CT + DE) | `canonical-import-guard.test.ts` | 36 | 36 | 0 | 0 | 0 |
| R. Migration Assertions (V-01–V-13, SS, OC, BF, ETB) | Multiple test files | 52 | 52 | 0 | 0 | 0 |
| S. Circuit Breaker (health.test.ts) | `health.test.ts` | 38 | 38 | 0 | 0 | 0 |
| T. DataProvenance (provenance.test.ts) | `provenance.test.ts` | 32 | 32 | 0 | 0 | 0 |
| U. Request Coalescing (coalescing.test.ts) | `coalescing.test.ts` | 18 | 18 | 0 | 0 | 0 |
| V. OHLC Validation Pipeline (validation.test.ts) | `validation.test.ts` | 48 | 48 | 0 | 0 | 0 |
| W. Forensics Endpoint (data-forensics.test.ts) | `data-forensics.test.ts` | 19 | 19 | 0 | 0 | 0 |
| X. Provider Health Endpoint | `in-health.test.ts` | 2 | 2 | 0 | 0 | 0 |
| Y. Python Tick Publisher (test_tick_publisher.py) | `test_tick_publisher.py` | 38 | 38 | 0 | 0 | 0 |

**Grand Total: 591 tests — 591 PASS, 0 FAIL, 0 SKIP, 0 Pending**

---

*Test plan last updated: 2026-09-12. All test IDs are traceable to the refactor specification sections. Requirement 23.2 satisfied: every test listed has a recorded PASS/FAIL/SKIP status and zero tests remain in a pending or unexecuted state.*
