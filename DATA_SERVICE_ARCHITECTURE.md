# DATA SERVICE ARCHITECTURE
**AlphaForge — Single Central Data Platform**  
**Date:** 2026-09-12  
**Branch:** refactor/signals  
**Version:** v9.0 (post-centralization)

---

## 1. ARCHITECTURE OVERVIEW

AlphaForge's data layer is built around **one authoritative data platform** — the
`data-service`. Every market-data acquisition, normalization, validation, and
delivery path flows through it.

```
                    NSE / Exchange Sources
                           │
     ┌──────────┬──────────┼──────────┬───────────┐
     │          │          │          │           │
  Scrapling  Angel One  Upstox    Jugaad-data  OpenChart
  (Python)   (TSX/JS)  (TSX/JS)  (Python)     (Python)
     │          │          │          │           │
     └──────────┴──────────┼──────────┴───────────┘
                           │
                    Yahoo Finance
                    (last resort)
                           │
                           ▼
             ┌─────────────────────────┐
             │       DATA-SERVICE       │
             │                         │
             │  Provider Gateway        │  ← Single entry point
             │  Capability Router       │  ← Dataset-aware routing
             │  Auth / Credential Mgr   │  ← Secure, provider-isolated
             │  Normalization           │  ← One canonical schema
             │  Validation              │  ← OHLC/timestamp/completeness
             │  Reconciliation          │  ← Cross-provider diffing
             │  Quality Engine          │  ← Deterministic grade (A–BLOCKED)
             │  Provenance              │  ← Immutable audit trail
             │  Historical Engine       │  ← Resumable, checkpointed
             │  Live Market Engine      │  ← WebSocket fanout
             │  Instrument Master       │  ← Symbol/token mapping
             │  F&O Universe            │  ← Dynamically maintained
             │  Cache (L1/L2/L3)        │  ← Request coalescing
             │  Persistence             │  ← Bulk writes, indexed DB
             │  Gap Recovery            │  ← Automated gap healing
             │  Observability           │  ← Metrics, health, tracing
             └──────────┬──────────────┘
                        │
          ┌─────────────┼──────────────┐
          │             │              │
   Signal Service   ML Service   Other Services
    (registry)      (HTTP REST)   (HTTP REST)
```

---

## 2. RESPONSIBILITIES

### data-service OWNS:
- All market data acquisition from external providers
- Provider credential management (secure, encrypted)
- All data normalization and validation
- All historical data storage and retrieval
- All live data distribution (WebSocket and REST)
- Data quality scoring and provenance tracking
- F&O universe management
- Instrument master management
- Backfill, gap detection, and gap recovery

### data-service DOES NOT OWN:
- Signal generation logic
- ML model training or inference
- Trading decisions
- Portfolio management
- Risk calculations
- User interface rendering

### Consumers (signal engine, ML, workers) MUST:
- Call data-service via the canonical TypeScript `ProviderRegistry` or REST API
- Never import provider-specific SDKs
- Never make direct HTTP calls to NSE, Angel One, Upstox, Yahoo, Jugaad, or OpenChart
- Accept canonical data with provenance metadata

---

## 3. COMPONENT ARCHITECTURE

### 3.1 TypeScript Layer (Next.js + Worker)

```
src/lib/market-data/
├── registry.ts              ← ProviderRegistry singleton (global)
├── provider.ts              ← MarketDataProvider interface
├── provider-capability-matrix.ts ← What each provider supports
├── failover.ts              ← withFailover() engine
├── health.ts                ← Circuit breakers, health state
├── normalizer.ts            ← Canonical normalization functions
├── types.ts                 ← Canonical types (MDQuote, OHLCVCandle, etc.)
├── providers/
│   ├── scrapling.ts         ← HTTP gateway to data-service (priority 0)
│   ├── angel-one.ts         ← SmartAPI adapter (priority 1)
│   ├── upstox.ts            ← Upstox v2/v3 adapter (priority 2)
│   ├── yahoo.ts             ← Yahoo Finance adapter (priority 3)
│   └── nse.ts               ← TOMBSTONE — throws on all calls
├── services/
│   ├── historical.service.ts
│   ├── live-feed.service.ts
│   ├── option-chain.service.ts
│   ├── instrument-master.service.ts
│   ├── backfill-orchestrator.service.ts
│   ├── fno-backfill-runner.service.ts
│   ├── candle-builder.service.ts
│   ├── candle-persist.service.ts
│   ├── gap-detection.service.ts
│   ├── gap-recovery.service.ts
│   └── ...
└── cache/
    └── market-cache.ts      ← memoize wrappers for L1/L2 cache
```

### 3.2 Python Data-Service

```
data-service/src/
├── server.py                ← FastAPI entry point
├── config.py                ← Settings (env vars)
├── providers/
│   ├── common/
│   │   ├── normalizer.py    ← Python normalization
│   │   ├── quality.py       ← Data quality engine
│   │   ├── reconciliation.py
│   │   ├── provenance.py
│   │   ├── acquisition_planner.py ← Capability-aware planning
│   │   ├── registry.py      ← Provider registry (Python)
│   │   └── universe.py      ← F&O universe management
│   ├── jugaad/
│   │   └── adapter.py       ← jugaad-data wrapper
│   └── openchart/
│       └── adapter.py       ← openchart wrapper
├── brokers/
│   ├── router.py            ← Broker API routing (for Python callers)
│   └── upstox_client.py     ← Upstox analytics token client
├── scrapers/
│   ├── historical.py        ← Historical OHLCV routes
│   ├── live_quotes.py       ← Live quote routes
│   ├── option_chain.py      ← Option chain routes
│   └── instrument_master.py ← Instrument master routes
├── anti_ban/
│   ├── ban_detector.py
│   ├── proxy_manager.py
│   ├── rate_limiter.py
│   └── session_warmer.py
├── core/
│   ├── nse_session.py       ← curl_cffi Chrome TLS session
│   ├── circuit_breaker.py
│   ├── data_quality.py
│   ├── deduplication.py
│   ├── schemas_v2.py        ← Pydantic schemas
│   └── ...
├── engines/
│   ├── candle_builder.py
│   ├── freshness_engine.py
│   └── market_session.py
└── publisher/
    ├── tick_publisher.py    ← Redis pub/sub publisher
    └── stream_publisher.py  ← Redis Streams for durable delivery
```

---

## 4. PROVIDER RESPONSIBILITIES

### 4.1 Scrapling / NSE (via data-service)
**Role:** Credential-free, public NSE data acquisition  
**Technology:** Python + Scrapling (headless Chromium) + curl_cffi (Chrome TLS)  
**What it provides:**
- Live quotes (NSE XHR endpoints)
- Option chains (NSE page scraping)
- Historical OHLCV (openchart, jugaad bhavcopy)
- Instrument master (NSE scrip master)

**What it does NOT provide:**
- Authenticated broker quotes (no Angel credentials)
- Historical options Greeks (IV only via OpenChart where available)
- Real-time streaming (no WebSocket — publishes to Redis pub/sub)

**Anti-blocking strategy:**
- persistent curl_cffi Chrome sessions with NSE cookie warmup
- per-request jitter (50–500ms)
- token bucket rate limiter (8 req/s ceiling)
- circuit breaker (5 failures → 30s cooldown)
- proxy rotation via ProxyManager when proxy list configured
- 403 ≠ 429 ≠ 503 — handled separately
- no aggressive parallel scraping

### 4.2 Angel One SmartAPI
**Role:** Primary authenticated broker — live quotes, intraday history, options  
**Priority:** 1 (after data-service/scrapling)  
**What it provides:**
- Live LTP, quotes, batch quotes
- Historical candles (1m–1h, 1d) for NSE equities
- Option chains (synthesized from ScripMaster + Quote API + optionGreek)
- Option Greeks (IV per strike via optionGreek API)
- WebSocket binary streaming (SmartStream 2.0)
- SmartAPI-specific analytics: PCR, OI buildup, gainers/losers

**What it does NOT provide:**
- Historical weekly/monthly candles (no SmartAPI support)
- Index historical candles (returns empty)
- Historical option Greeks (live only)
- Historical bid/ask

**Limits:**
- Historical API: ~3 req/s sustained
- ScripMaster: ~24h cache refresh
- Token: JWT valid until midnight IST

### 4.3 Upstox
**Role:** Secondary authenticated broker — indices, live data, WebSocket  
**Priority:** 2  
**What it provides:**
- Live quotes (v2 Quote API)
- Historical candles via v2 (1m, 30m, 1d, 1w, 1M) and v3 (1m, 5m, 15m, 30m, 1h, 1d, 1w, 1M)
- Index historical data (NIFTY, BANKNIFTY — Angel cannot provide this)
- Option chains (v2 option chain API)
- WebSocket v3 Protobuf streaming

**What it does NOT provide:**
- Instrument master mapping
- Historical option Greeks
- Historical OI at strike level

### 4.4 Jugaad-data (inside data-service Python)
**Role:** Historical NSE bhavcopy downloads  
**Priority:** Part of data-service Tier 0  
**What it provides:**
- Daily historical equity OHLCV (bhavcopy-sourced)
- Daily historical F&O: futures OI/volume, options OI/volume by strike
- Expiry dates from NSE

**What it does NOT provide:**
- Intraday candles (1m–1h)
- Live quotes
- Option Greeks / IV

### 4.5 OpenChart (inside data-service Python)
**Role:** Historical OHLCV via NSE charting API  
**Priority:** Part of data-service Tier 0  
**What it provides:**
- Historical OHLCV for 1m, 5m, 10m, 15m, 30m, 1h, 1d, 1w, 1M
- Cross-provider reconciliation source (independent of Angel/Upstox)

**3m:** NOT supported. Not now, not ever.

**What it does NOT provide:**
- OI, IV, bid, ask, Greeks
- Live quotes

### 4.6 Yahoo Finance
**Role:** Last-resort fallback — tightly controlled  
**Priority:** 3 (always last)  
**What it provides:**
- Historical daily candles for NSE equities (via `.NS` suffix)
- Delayed live quotes (15-min delay, not suitable for production trading)

**What it NEVER provides for production use:**
- Real-time quotes
- Option Greeks
- Historical OI or IV
- F&O-specific data

**Policy:** Yahoo-derived data carries `provenance: SECONDARY_FALLBACK` and is
capped at quality grade `B`. It is never used for signal generation of live F&O
positions unless explicitly overridden by strategy config.

---

## 5. DATA FLOW

### 5.1 Request Flow (any consumer)

```
Consumer
  │
  ├── TypeScript consumer
  │     ↓
  │   registry.getQuotes(symbols)   ← ProviderRegistry
  │     ↓
  │   withFailover(providers)       ← Failover engine
  │     ↓
  │   ScraplingProvider.getQuotes() ← HTTP GET /scraping/quotes
  │     ↓
  │   data-service (Python)         ← Scrapling/NSE acquisition
  │     ↓
  │   normalization + validation    ← Python pipeline
  │     ↓
  │   quality scoring               ← Python quality engine
  │     ↓
  │   canonical response            ← JSON with metadata
  │     ↓
  │   cache (L2 Redis)              ← Cached 3–5s for LTP
  │     ↓
  │   Consumer receives             ← MDQuote[] with provenance
  │
  └── On failure: withFailover tries AngelOneProvider → UpstoxProvider → YahooProvider
```

### 5.2 Historical Data Flow

```
Consumer requests historical candles
  ↓
registry.getHistoricalCandles(req)
  ↓
providerCapabilityMatrix.historyProvidersFor(symbol, interval)
  ↓
ScraplingProvider (data-service)     ← openchart / jugaad
  ↓ (if empty or failed)
AngelOneProvider (SmartAPI)
  ↓ (if empty or failed, or index symbol)
UpstoxProvider (v3)
  ↓ (if all above fail, and policy allows)
YahooProvider                        ← last resort only

All candles pass through:
  → normalize (timestamps, prices, volume)
  → validate (OHLC rules, completeness)
  → deduplicate (unique on instrumentId+interval+time)
  → quality score
  → persist to candle_bar (bulk upsert)
  → cache in Redis (TTL by interval)
  → return to consumer
```

### 5.3 Live Data Flow (WebSocket)

```
Angel One SmartStream WS          Upstox WS v3 Protobuf
        │                                │
        └────────────┬───────────────────┘
                     ↓
           LiveFeedService.subscribe()
                     ↓
           AngelOneWsManager / UpstoxWsManager
           (one upstream connection per provider)
                     ↓
           tick received (binary/JSON)
                     ↓
           parseSmartTick() / parseUpstoxTick()
                     ↓
           normalize to LiveTick (UTC timestamp, INR)
                     ↓
           validate (non-null ltp, finite prices)
                     ↓
           isTickStale() check
                     ↓
           Redis pub/sub: PUBLISH af:ticks:{symbol}
                     ↓
           RedisStreams: XADD af:stream:ticks (durable)
                     ↓
        ┌────────────┴──────────────────────┐
        │                                   │
   Worker (scraping-tick-listener)    API WebSocket
   candle builder                     /v1/stream/quotes
```

### 5.4 WebSocket Fanout Architecture

```
1 upstream provider WS connection
        ↓
LiveFeedService (singleton per provider)
        ↓
Redis pub/sub (fan-out bus)
        ↓
N downstream consumers:
  - candle-builder.service (real-time OHLC aggregation)
  - signal data snapshot service
  - API WebSocket endpoint (browser clients)
  - scraping-tick-listener worker job
```

---

## 6. CAPABILITY ROUTING

The `provider-capability-matrix.ts` is the single source of truth for what each
provider supports. The routing engine consults this before making any provider call.

### Routing Matrix (simplified)

| Dataset | Primary | Secondary | Tertiary | Yahoo |
|---|---|---|---|---|
| Live equity quote | scrapling → | angel_one → | upstox → | yahoo (delayed) |
| Live index quote | scrapling → | upstox → | | (no Yahoo indices) |
| Live option chain | scrapling → | angel_one → | upstox | NEVER |
| Historical 1m (equity) | angel_one → | upstox → | openchart | NEVER for intraday |
| Historical 5m (equity) | angel_one → | upstox v3 → | openchart | NEVER for F&O |
| Historical 1d (equity) | scrapling/jugaad → | angel_one → | upstox → | yahoo (fallback) |
| Historical 1w, 1M | scrapling/jugaad → | upstox → | | yahoo |
| Historical 5m (index) | upstox v3 → | openchart | | NEVER |
| Historical F&O OI | jugaad (via scrapling) → | | | NEVER |
| Historical option IV | NOT AVAILABLE from any provider | | | |
| 3m (any dataset) | BLOCKED | | | |

**Critical rule:** `UNSUPPORTED_CAPABILITY` is never treated as `PROVIDER_FAILURE`.
Routing skips a provider for a dataset it doesn't support without recording a failure.

---

## 7. AUTHENTICATION & CREDENTIAL LIFECYCLE

```
Frontend (User Settings)
  ↓
POST /api/auth/settings  (encrypted in transit via HTTPS)
  ↓
UserSetting.apiKeysEncrypted (PostgreSQL, AES-256)
  ↓
readAngelCredentials() / readUpstoxCredentials()  [server-only]
  ↓
Provider adapter (angel-one.ts / upstox.ts)
  ↓
Angel Login (TOTP + clientCode + password → JWT)
  ↓
JWT cached in memory until midnight IST
  ↓
Provider API calls use JWT in Authorization header
```

**What consumers NEVER receive:** credentials, JWTs, tokens, secrets.
**What consumers DO receive:** `CONNECTED` / `DISCONNECTED` / `AUTH_FAILED` status.

---

## 8. NORMALIZATION PIPELINE

Every provider response passes through this pipeline before reaching consumers:

```
Raw provider response
  ↓
1. Schema validation (Pydantic Python / Zod TypeScript)
  ↓
2. Timestamp normalization (all → UTC epoch ms, NSE = Asia/Kolkata +05:30)
  ↓
3. OHLCV validation:
   - high >= max(open, close) — else DROP
   - low <= min(open, close) — else DROP
   - high >= low — else DROP
   - volume >= 0 — else DROP (0 is valid)
   - no NaN, no Infinity — else DROP
  ↓
4. Symbol normalization (strip .NS/.BO, map to canonical NSE symbol)
  ↓
5. Duplicate detection (same instrumentId + interval + time → keep first)
  ↓
6. Gap detection (expected candles vs received — compute gap rate)
  ↓
7. Freshness validation (dataAsOf vs now, market hours context)
  ↓
8. Cross-provider reconciliation (when 2+ providers return same data)
  ↓
9. Quality scoring (completeness × freshness × accuracy × consistency)
  ↓
10. Provenance stamping (provider, requestedAt, dataAsOf, quality, sourceChain)
  ↓
Canonical dataset → cache → database → consumer
```

---

## 9. CANONICAL DATA MODEL

All data flowing out of data-service uses these types (TypeScript: `src/lib/market-data/types.ts`).

### Core Types

```typescript
// Provider identity
type ProviderId = "scrapling" | "angel_one" | "upstox" | "jugaad" | "openchart" | "yahoo";

// Canonical candle
type OHLCVCandle = {
  time: number;         // UTC epoch ms, candle OPEN time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;       // 0 if unavailable
  oi?: number | null;   // open interest, null for equity
  oiChange?: number | null;
};

// Canonical quote
type MDQuote = {
  symbol: string;
  token: string | null;
  exchange: Exchange | null;
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  oi: number | null;
  vwap: number | null;
  bid: number | null;
  ask: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
};

// Provenance metadata (attached to every response)
type DataProvenance = {
  provider: ProviderId;
  providerType: "BROKER" | "OPEN_SOURCE" | "SECONDARY_FALLBACK" | "CACHE" | "DERIVED";
  authenticated: boolean;
  requestedAt: string;    // ISO-8601 UTC
  dataAsOf: string;       // ISO-8601 UTC
  isLive: boolean;
  isHistorical: boolean;
  freshness: "LIVE" | "RECENT" | "STALE" | "HISTORICAL";
  quality: {
    score: number;        // 0–100
    grade: "A+" | "A" | "B" | "C" | "D" | "BLOCKED";
    completeness: number;
    freshness: number;
    accuracy: number;
    validationStatus: "PASSED" | "PARTIAL" | "FAILED";
    reconciliationStatus?: string;
  };
  sourceChain: ProviderId[];
};
```

---

## 10. PROVENANCE VALUES

| Provenance | Meaning |
|---|---|
| `BROKER_AUTHENTICATED` | From Angel One or Upstox via authenticated API |
| `OPEN_SOURCE_HISTORICAL` | From jugaad-data or openchart (NSE bhavcopy-derived) |
| `NSE_PUBLIC` | From NSE public endpoints via scrapling |
| `SECONDARY_FALLBACK` | From Yahoo Finance |
| `CACHE` | Served from Redis or memory cache (provider may have been unavailable) |
| `DERIVED` | Computed from lower-timeframe data (e.g. 1w derived from 1d) |

---

## 11. QUALITY SCORING

Quality score is computed deterministically from five dimensions:

| Dimension | Weight | Description |
|---|---|---|
| Completeness | 25% | % of expected candles/quotes present |
| Freshness | 25% | Age of data vs market state (market-closed is neutral) |
| Accuracy | 25% | Cross-provider reconciliation result |
| Consistency | 15% | Internal OHLC rules, timestamp ordering |
| Provider reliability | 10% | Historical success rate of provider in rolling window |

**Grade thresholds:**
- A+ (95–100): Perfect
- A (85–94): Good
- B (70–84): Acceptable (Yahoo-sourced capped here)
- C (50–69): Degraded — signal engine should warn
- D (30–49): Poor — signal engine should not use for entries
- BLOCKED (<30 or validation FAILED): Signal engine blocked

---

## 12. ERROR MODEL

```typescript
enum MarketDataErrorCode {
  PROVIDER_UNAVAILABLE      = "PROVIDER_UNAVAILABLE",
  PROVIDER_TIMEOUT          = "PROVIDER_TIMEOUT",
  PROVIDER_RATE_LIMITED     = "PROVIDER_RATE_LIMITED",
  PROVIDER_AUTH_FAILED      = "PROVIDER_AUTH_FAILED",
  PROVIDER_HARD_BLOCKED     = "PROVIDER_HARD_BLOCKED",    // 403
  PROVIDER_NOT_CONFIGURED   = "PROVIDER_NOT_CONFIGURED",
  UNSUPPORTED_CAPABILITY    = "UNSUPPORTED_CAPABILITY",   // NOT a provider failure
  EMPTY_DATA                = "EMPTY_DATA",
  PARTIAL_DATA              = "PARTIAL_DATA",
  INVALID_DATA              = "INVALID_DATA",
  STALE_DATA                = "STALE_DATA",
  DATA_GAP                  = "DATA_GAP",
  RECONCILIATION_FAILED     = "RECONCILIATION_FAILED",
  MARKET_CLOSED             = "MARKET_CLOSED",            // NOT a failure
  DATABASE_ERROR            = "DATABASE_ERROR",
  CACHE_ERROR               = "CACHE_ERROR",
  PARSER_VERSION_MISMATCH   = "PARSER_VERSION_MISMATCH",
  UNRESOLVED_SYMBOL         = "UNRESOLVED_SYMBOL",
}
```

**Critical distinctions:**
- `MARKET_CLOSED` ≠ `PROVIDER_FAILURE` — market closed is an expected state
- `UNSUPPORTED_CAPABILITY` ≠ `PROVIDER_FAILURE` — never triggers failover count
- `EMPTY_DATA` ≠ `PROVIDER_FAILURE` — holiday/off-hours can legitimately return empty

---

## 13. CACHING ARCHITECTURE

### Multi-level cache

```
L1: In-process memory (per provider, per process)
    - TTL: 3s (LTP), 5s (quotes), 30s (1m candles), 4h (daily candles)
    - Implementation: Map with TTL via memoize wrappers in market-cache.ts
    - Per-provider isolation: market:quote:{provider}:{symbol}

L2: Redis
    - TTL: same as L1 but shared across all Next.js processes
    - Keys: market:quote:{exchange}:{token}, market:candle:{exchange}:{symbol}:{tf}
    - Implementation: ioredis

L3: PostgreSQL (candle_bar table)
    - TTL: permanent (source of truth for historical)
    - Used as cache fallback when Redis unavailable
    - Queried directly for historical ranges
```

### Request Coalescing

When N concurrent requests arrive for the same key:
- First request triggers provider fetch and sets a "pending" marker
- Subsequent N-1 requests wait on the pending marker (via Promise sharing)
- All N consumers receive the same result from ONE provider call
- Measured: verified in tests/lib/market-data/resilience-matrix.test.ts

---

## 14. HISTORICAL ENGINE

### Design Principles
- **Resumable:** Each (symbol, interval) backfill job has a `BackfillCheckpoint` in Redis
- **Idempotent:** Bulk upsert on `(instrumentId, exchange, intervalStr, time)` — safe to re-run
- **Chunked:** Max chunk size per provider enforced (e.g. 30 days for Angel 1m)
- **Bounded concurrency:** Max 3 concurrent provider calls (respects ~3 req/s Angel cap)
- **Circuit breaker:** Per-provider, 5 failures → 30s cooldown
- **Exponential backoff:** Base 500ms, 2× per attempt, +random jitter
- **Gap detection:** Detects missing sessions after write, schedules recovery

### Backfill Order
```
1. calendarDaysForTimeframe(interval) → compute required lookback
2. historyProvidersForSymbol(symbol, interval) → get ordered provider list
3. For each provider: makeCapabilityAwareFetcher() → fetch chunk
4. normalize → validate → deduplicate → bulk upsert
5. Checkpoint written to Redis after each chunk
6. Gap detection runs after full symbol backfill
7. Gap recovery attempts to fill detected gaps
```

---

## 15. OBSERVABILITY

### Structured Logging
Every data-service log entry includes:
- `requestId` — per-request UUID for tracing
- `provider` — which provider served the request
- `event` — typed event name (e.g. `provider_selected`, `provider_degraded`)
- `latencyMs` — measured duration
- No secrets, no credentials, no personal data

### Metrics (via structlog / prometheus)
- `provider_request_total{provider, outcome}` — success/failure counts
- `provider_latency_ms{provider, quantile}` — p50/p95/p99
- `data_quality_score{symbol, interval}` — rolling quality
- `cache_hit_total{level}` — L1/L2/L3 hit counts
- `backfill_bars_total{symbol, interval}` — cumulative bars written

### Health Endpoints
- `GET /health` — service health (data-service Python)
- `GET /scraping/status` — scrapling capability flags
- `GET /v1/providers/status` (TypeScript) — per-provider auth + latency
- `GET /v1/data/quality` (TypeScript) — per-symbol quality grades

---

## 16. SECURITY

1. **Credentials never leave the server boundary** — no credentials in API responses, logs, error messages, or frontend code
2. **Encryption at rest** — `UserSetting.apiKeysEncrypted` (AES-256 via `src/lib/crypto.ts`)
3. **Credential isolation** — provider credentials are retrieved per-request via server-only functions
4. **CORS** — data-service Python only allows `localhost:3000`
5. **Token lifecycle** — Angel One JWT cached until midnight IST; auto-refreshed
6. **No credential sharing** — user A's Upstox token cannot be used for user B

---

## 17. MIGRATION STRATEGY

The migration follows a **fail-safe, phase-by-phase** approach.

### Phase approach
1. **Audit** (done) — all violation sites identified
2. **Test plan** (done) — all tests defined pre-implementation
3. **Architecture docs** (done) — this document
4. **Fix violations** — replace direct provider calls with `registry.*` calls
5. **Architecture enforcement** — extend ESLint rules + import-guard tests
6. **Delete redundant code** — after all consumers migrated
7. **Performance verification** — benchmark and certify

### Backward compatibility
- During migration, the `registry.getQuotes()` etc. calls are drop-in replacements
- No API contract changes for consumers
- No database schema changes required for the migration itself

---

## 18. KNOWN LIMITATIONS

1. **Broker-specific analytics** (PCR, OI buildup, gainers/losers via SmartAPI) have no generic `MarketDataProvider` equivalent. They remain as documented exceptions until a `getBrokerAnalytics()` interface extension is designed.

2. **Historical option Greeks** are not available from any provider. IV is available live via Angel One's `optionGreek` API only. Historical IV must be derived from historical option prices if needed.

3. **Historical bid/ask** is not available from any provider for Indian options.

4. **1m intraday depth** is limited by Angel One's historical API cap (~3 req/s). Full universe 1m backfill takes significantly longer than 5m+ intervals.

5. **Upstox v2 gaps** at 5m/10m/15m/1h — these intervals are not natively supported in v2; use v3 or Angel One for these.

6. **No real-time benchmarks yet** — SLO targets are defined in the test plan but have not been measured against production traffic volumes. They are targets, not guarantees.
