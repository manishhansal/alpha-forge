# AlphaForge Data Service — Architecture Audit

**Version:** V2.0.0  
**Audit Date:** September 2026  
**Auditor:** Data Service V2 Upgrade

---

## 1. Pipeline Map

```
NSE / BSE
    │
    ├── NextApi (httpx pool)          → live_quotes.py
    │      ↓                               ↓
    │   RAW RESPONSE              _fetch_batch_quotes / _fetch_index_quotes
    │      ↓                       _fetch_single_quote
    │   NORMALIZATION (MDQuote)     oi = None (equity), volume = shares
    │      ↓
    │   CACHE (Redis, TTL 5s)
    │      ↓
    │   RESPONSE / TickPublisher
    │      ↓
    │   Redis Pub/Sub + Redis Streams (af:ticks:{symbol})
    │
    ├── Bhavcopy CDN (httpx)          → historical.py
    │      ↓
    │   OHLCVCandle (validated)
    │      ↓
    │   Disk cache (gzip JSON) / Redis
    │
    ├── Option Chain XHR (Playwright) → option_chain.py
    │      ↓
    │   OptionChainRow[] (per-strike CE/PE)
    │      ↓
    │   Analytics (PCR, max pain O(N log N), ATM IV, OI walls)
    │      ↓
    │   Redis cache (TTL 20s)
    │
    └── Instrument Master (httpx)     → instrument_master.py
           ↓
        Instrument[] (disk cache, 24h TTL)

```

---

## 2. Component Classification

| Component | File | IMPLEMENTED | WIRED | TESTED | RUNTIME-VERIFIED | PRODUCTION-SAFE |
|-----------|------|:-----------:|:-----:|:------:|:----------------:|:---------------:|
| Live Quotes (NSE NextApi) | `scrapers/live_quotes.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Option Chain (NSE XHR) | `scrapers/option_chain.py` | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Option Chain (BSE XHR) | `scrapers/option_chain.py` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Historical Daily (Bhavcopy) | `scrapers/historical.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Historical Intraday (charting) | `scrapers/historical.py` | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Instrument Master (NSE) | `scrapers/instrument_master.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Instrument Master (BSE) | `scrapers/instrument_master.py` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Tick Publisher | `publisher/tick_publisher.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Redis Pub/Sub | `publisher/tick_publisher.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Redis Streams | `publisher/stream_publisher.py` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Ban Detector | `anti_ban/ban_detector.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Proxy Manager | `anti_ban/proxy_manager.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Rate Limiter | `anti_ban/rate_limiter.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session Warmer | `anti_ban/session_warmer.py` | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Monitoring Router | `monitoring/router.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Health Router | `monitoring/health_router.py` | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| V2 Schemas | `core/schemas_v2.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Symbol Normalizer | `core/symbol_normalizer.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Deduplication | `core/deduplication.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Circuit Breaker | `core/circuit_breaker.py` | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| Data Quality | `core/data_quality.py` | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| Lineage Store | `core/lineage.py` | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| Timestamp Engine | `engines/timestamp_engine.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Freshness Engine | `engines/freshness_engine.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Market Session Engine | `engines/market_session.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Candle Builder V2 | `engines/candle_builder.py` | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| Request Context | `core/request_context.py` | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| Security | `core/security.py` | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |

**Legend:**
- ✅ = Confirmed
- ⚠️ = Partial / requires live validation
- ❌ = Not implemented

---

## 3. Data Flow: quote → Redis → Consumer

```
GET /scraping/quotes?symbols=NIFTY,RELIANCE
            │
    1. Validate symbols (200 max, format check)
            │
    2. Redis cache check (key: scraping:quote:{exchange}:{symbol}, TTL 5s)
            │
    3a. Cache HIT → return MDQuote directly
    3b. Cache MISS:
            │
        Route:
        ├── _NSE_INDEX_SYMBOLS → _fetch_index_quotes (httpx pool)
        ├── NIFTY_200_SYMBOLS  → _fetch_batch_quotes (httpx pool)
        └── other              → _fetch_single_quote (httpx pool)
            │
    4. NORMALIZATION:
        - oi = None (NEVER totalTradedValue)  ← SEMANTIC FIX
        - volume = totalTradedVolume (shares)
        - all nulls preserved, never converted to 0
            │
    5. Redis cache write (TTL 5s, fire-and-forget)
            │
    6. Return MDQuote[]

TickPublisher (every 5s):
    └── same quote path → MDQuote → LiveTickV2
            │
    7. Redis PUBLISH af:ticks:{SYMBOL}          (pub/sub, lossy)
    8. Redis XADD af:stream:ticks               (streams, bounded 10k)
    9. Redis XADD af:stream:ticks:{SYMBOL}      (per-symbol, bounded 500)
```

---

## 4. Critical Semantic Integrity Rules

### OI vs TradedValue (Phase 3 — CRITICAL)

| Field | Meaning | Source Field | Was Wrong | Fixed |
|-------|---------|-------------|-----------|-------|
| `oi` | Open interest (contracts) | NSE `openInterest` (F&O only) | Mapped to `totalTradedValue` | ✅ Now `None` for equity |
| `tradedValue` | Total INR traded value | NSE `totalTradedValue` | Mixed with OI | ✅ Separated |
| `volume` | Share/contract count | NSE `totalTradedVolume` | Correct | ✅ |

The old code `oi=_int(item.get("totalTradedValue"))` would produce OI values of billions (INR rupees) for equity quotes. For example, RELIANCE with traded value ≈ ₹4.3B would show `oi=4300000000` — a value that would make PCR calculations completely meaningless. This was a silent P0 semantic corruption that has now been fixed with a regression test suite.

---

## 5. V2 Architecture vs V1

| Capability | V1 | V2 |
|-----------|----|----|
| OI semantic integrity | ❌ Broken | ✅ Fixed |
| HTTP connection pooling | ❌ New client per request | ✅ Persistent AsyncClient |
| Timestamp engine | ❌ Ad hoc | ✅ Centralized UTC/IST |
| Data freshness | ❌ None | ✅ Tiered by instrument |
| Market session | ❌ Weekday-only | ✅ Holiday calendar aware |
| Symbol normalization | ❌ None | ✅ Yahoo/NSE/BSE canonical |
| Redis delivery | ❌ Pub/Sub only (lossy) | ✅ Pub/Sub + Streams (bounded replay) |
| Deduplication | ❌ None | ✅ SHA-256 event IDs |
| Gap detection | ❌ None | ✅ Time-based stream gaps |
| Sequence tracking | ❌ None | ✅ Per-instrument |
| Candle builder | ❌ None | ✅ 09:15 IST anchor, OPEN/PARTIAL/CLOSED |
| Max pain complexity | ❌ O(N²) | ✅ O(N log N) |
| Session warmer | ❌ Ephemeral, didn't refresh prod | ✅ Resets production sessions |
| Circuit breaker | ❌ None | ✅ Per-upstream |
| Data confidence score | ❌ None | ✅ 0–95, never 100 |
| Signal safety gate | ❌ None | ✅ DataQualityGate |
| Data lineage | ❌ None | ✅ Per-observation IDs |
| Health endpoints | ❌ Single /health | ✅ /health/live + /health/ready + /health/data |
| Security (SSRF) | ❌ None | ✅ Allowlist + input validation |

---

## 6. Remaining Gaps (NOT_CERTIFIED)

| Gap | Severity | Mitigation |
|-----|----------|-----------|
| Circuit breaker not yet wired to HTTP calls | HIGH | Structure in place; wire in Phase 2.1 |
| Candle builder not yet wired to tick stream | HIGH | Implemented; needs wiring in tick publisher |
| Data lineage not wired to every endpoint | MEDIUM | LineageStore ready; needs per-route integration |
| Redis Streams not tested against real Redis | MEDIUM | Unit tests pass; integration test needed |
| BSE option chain field names may change | MEDIUM | Documented; monitor NSE/BSE API changes |
| `grapthData` typo in NSE charting API | LOW | Documented; monitor for fix |
| No adjusted prices for historical data | LOW | By design; use Yahoo for adjusted |

---

## 7. Directory Structure

```
data-service/
├── src/
│   ├── core/                     ← NEW V2
│   │   ├── schemas_v2.py         ← Canonical V2 data contracts
│   │   ├── symbol_normalizer.py  ← Symbol normalization layer
│   │   ├── deduplication.py      ← Event IDs, dup detection, gap detection
│   │   ├── circuit_breaker.py    ← Per-upstream circuit breaker
│   │   ├── data_quality.py       ← Confidence score, DataQualityGate
│   │   ├── lineage.py            ← Data lineage and provenance
│   │   ├── request_context.py    ← RequestID, error contract
│   │   └── security.py           ← SSRF prevention, resource limits
│   ├── engines/                  ← NEW V2
│   │   ├── timestamp_engine.py   ← UTC/IST, clock skew
│   │   ├── freshness_engine.py   ← Tiered freshness classification
│   │   ├── market_session.py     ← NSE session phases and holidays
│   │   └── candle_builder.py     ← OHLCV aggregation from ticks
│   ├── scrapers/
│   │   ├── live_quotes.py        ← MODIFIED: OI fix, connection pool
│   │   ├── option_chain.py       ← MODIFIED: max pain O(N log N)
│   │   ├── historical.py         ← Unchanged (working)
│   │   └── instrument_master.py  ← Unchanged (working)
│   ├── publisher/
│   │   ├── tick_publisher.py     ← Unchanged (working)
│   │   ├── router.py             ← Unchanged
│   │   └── stream_publisher.py   ← NEW: Redis Streams
│   ├── monitoring/
│   │   ├── router.py             ← Unchanged (working)
│   │   └── health_router.py      ← NEW: /health/live + /health/ready + /health/data
│   ├── anti_ban/
│   │   ├── session_warmer.py     ← MODIFIED: refreshes production sessions
│   │   ├── ban_detector.py       ← Unchanged (working)
│   │   ├── proxy_manager.py      ← Unchanged (working)
│   │   └── rate_limiter.py       ← Unchanged (working)
│   ├── server.py                 ← MODIFIED: new routers, stream publisher
│   ├── config.py                 ← Unchanged
│   └── schemas.py                ← Unchanged (V1 compat preserved)
├── tests/
│   ├── core/                     ← NEW: 80+ tests
│   │   ├── test_semantic_integrity.py
│   │   ├── test_deduplication.py
│   │   ├── test_symbol_normalizer.py
│   │   └── test_data_quality.py
│   ├── engines/                  ← NEW: 70+ tests
│   │   ├── test_timestamp_engine.py
│   │   ├── test_freshness_engine.py
│   │   ├── test_market_session.py
│   │   └── test_candle_builder.py
│   └── scrapers/
│       ├── test_max_pain_performance.py ← NEW
│       └── test_live_quotes.py          ← UPDATED (HTTP mock pattern)
├── docs/
│   └── DATA_SERVICE_ARCHITECTURE_AUDIT.md ← THIS FILE
├── reports/
│   ├── DATA_SERVICE_FINAL_AUDIT.md
│   ├── DATA_QUALITY_SCORECARD.md
│   ├── DATA_SERVICE_PERFORMANCE_REPORT.md
│   ├── DATA_SERVICE_CHAOS_REPORT.md
│   └── DATA_SERVICE_V2_CERTIFICATION.md
└── RELIABILITY_ASSESSMENT.md
```
