# DATA SERVICE ARCHITECTURE
**AlphaForge — Single Central Data Platform**
**Date:** 2026-09-15
**Branch:** refactor/signals
**Version:** v9.0 (post-centralization — all 13 violation sites eliminated)

---

## 1. ARCHITECTURE OVERVIEW

AlphaForge's data layer is built around **one authoritative data platform** — the
`data-service`. Every market-data acquisition, normalization, validation, and
delivery path flows through it. All 13 violation sites that previously bypassed
the registry have been eliminated (v9.0). The canonical import guard in
`src/lib/market-data/canonical-import-guard.ts` and ESLint `no-restricted-imports`
rules enforce the boundary at CI time; no new violation sites can be introduced.

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
             │  9-Step Validation       │  ← OHLC/timestamp/completeness
             │  Reconciliation          │  ← Cross-provider diffing
             │  Quality Engine          │  ← Deterministic grade (A+–BLOCKED)
             │  Provenance Stamping     │  ← Immutable audit trail
             │  Historical Engine       │  ← Resumable, checkpointed
             │  Live Market Engine      │  ← WS fanout via Redis pub/sub
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
- All data normalization and validation (9-step pipeline)
- All historical data storage and retrieval
- All live data distribution (WebSocket → Redis pub/sub fanout)
- Data quality scoring and provenance tracking
- F&O universe management
- Instrument master management
- Backfill, gap detection, and gap recovery
- Angel One SmartStream WS connection (sole owner)
- Upstox v3 Protobuf WS connection (sole owner)

### data-service DOES NOT OWN:
- Signal generation logic
- ML model training or inference
- Trading decisions
- Portfolio management
- Risk calculations
- User interface rendering

### Consumers (signal engine, ML, workers) MUST:
- Call data-service via `registry.*` methods (TypeScript) or REST API (Python)
- Never import provider-specific SDKs (`@/services/india/yahoo`,
  `@/services/india/angelone`, `yahoo-finance2`, `smartapi-javascript`, etc.)
- Never make direct HTTP calls to NSE, Angel One, Upstox, Yahoo, Jugaad, or OpenChart
- Accept canonical data with `DataProvenance` metadata on every response

### Documented Exceptions (broker analytics, no registry equivalent):
These files retain direct Angel One imports for SmartAPI-specific endpoints
(`getPutCallRatio`, `getOiBuildup`, `getTopGainersLosers`) that have no
`MarketDataProvider` equivalent. Each call is annotated with
`// DATA_SERVICE_PRE_REFACTOR_AUDIT.md: Documented_Exception — no MarketDataProvider equivalent`:

- `src/services/india/scanner/engine.ts`
- `src/features/india/expiry-trades/builder.ts`
- `src/features/india/daily-picks/builder.ts`
- `src/features/ai-signals/india-builder.ts`

---

## 3. COMPONENT ARCHITECTURE

### 3.1 TypeScript Layer (Next.js + Worker)

```
src/lib/market-data/
├── registry.ts              ← ProviderRegistry singleton + bootstrapRegistry()
├── provider.ts              ← MarketDataProvider interface
├── provider-capability-matrix.ts  ← Routing matrix (single source of truth)
├── failover.ts              ← withFailover() engine + PROVIDER_SWITCH logging
├── health.ts                ← Circuit breakers, health state, mdLog()
├── normalizer.ts            ← Canonical normalization + NSE→Yahoo symbol mapping
├── provenance.ts            ← stampLiveProvenance(), stampCacheProvenance(),
│                               persistProvenance(), computeFreshness()
├── canonical-import-guard.ts ← Import allowlists + documented exceptions
├── types.ts                 ← Canonical types (ProviderId, Interval,
│                               SUPPORTED_TIMEFRAMES, DataProvenance, MDQuote,
│                               OHLCVCandle, MarketDataError, ProviderHealth, …)
├── data-gate.ts             ← evaluateGlobalDataState(), strategyMayOperate()
├── providers/
│   ├── scrapling.ts         ← HTTP gateway to data-service (priority 0)
│   ├── angel-one.ts         ← SmartAPI adapter (priority 1)
│   ├── upstox.ts            ← Upstox v2/v3 adapter (priority 2)
│   ├── yahoo.ts             ← Yahoo Finance adapter (priority 3)
│   └── nse.ts               ← TOMBSTONE — throws UnsupportedOperation on all calls
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
│   ├── option-strike-capture.service.ts
│   ├── signal-data-snapshot.service.ts
│   ├── v8-signal-data-gate.service.ts
│   └── …
└── cache/
    └── market-cache.ts      ← L1 in-process cache wrappers (memoQuote, etc.)
```

### 3.2 Python Data-Service

```
data-service/src/
├── server.py                ← FastAPI entry point + lifespan
├── config.py                ← Settings (env vars only — no credentials via HTTP)
├── providers/
│   ├── common/
│   │   ├── normalizer.py    ← validate_interval() — raises ValueError for "3m"
│   │   │                       SUPPORTED_INTERVALS frozenset (9 intervals, no "3m")
│   │   ├── quality.py       ← Data quality engine
│   │   ├── reconciliation.py
│   │   ├── provenance.py    ← build_provenance()
│   │   ├── acquisition_planner.py  ← Capability-aware planning (raises ValueError for "3m")
│   │   └── registry.py      ← Provider registry (Python)
│   ├── jugaad/
│   │   └── adapter.py       ← jugaad-data wrapper
│   └── openchart/
│       └── adapter.py       ← openchart wrapper (SUPPORTED_INTERVALS: no "3m")
├── brokers/
│   ├── router.py            ← Broker API routing
│   └── upstox_client.py     ← Upstox analytics token client
├── scrapers/
│   ├── historical.py        ← Historical OHLCV routes
│   ├── historical_repair.py ← Gap repair routes
│   ├── live_quotes.py       ← Live quote routes
│   ├── option_chain.py      ← Option chain routes
│   └── instrument_master.py ← Instrument master routes
├── anti_ban/
│   ├── ban_detector.py
│   ├── proxy_manager.py
│   ├── rate_limiter.py
│   └── session_warmer.py
├── core/
│   ├── circuit_breaker.py   ← all_breakers() for health endpoint
│   ├── data_quality.py
│   ├── deduplication.py
│   ├── schemas_v2.py        ← Pydantic schemas
│   ├── nse_session.py       ← curl_cffi Chrome TLS session
│   └── …
├── engines/
│   ├── candle_builder.py
│   │   └── SUPPORTED_INTERVALS (same 9 canonical intervals)
│   ├── freshness_engine.py
│   └── market_session.py
├── publisher/
│   ├── broker_ws_manager.py ← BrokerWsConnection base class
│   │                           AngelOneSmartStreamWs (sole owner of Angel WS)
│   │                           UpstoxV3ProtobufWs (sole owner of Upstox WS)
│   │                           Reconnection: backoff 1s→2s→4s→…→60s, max 10 attempts
│   │                           Publishes {"type":"reconnect"} before each attempt
│   │                           Publishes {"type":"connection_failed"} after exhaustion
│   ├── tick_publisher.py    ← TickPublisher singleton, /publisher/status endpoint
│   ├── stream_publisher.py  ← Redis Streams durable delivery (XADD af:stream:ticks)
│   └── router.py
└── monitoring/
    ├── health_router.py     ← /health/live, /health/ready, /health/providers
    └── router.py
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
- Authenticated broker quotes
- Historical option Greeks
- Real-time streaming (publishes to Redis pub/sub instead)

**Anti-blocking strategy:**
- Persistent curl_cffi Chrome sessions with NSE cookie warmup
- Per-request jitter (50–500ms)
- Token bucket rate limiter (8 req/s ceiling)
- Circuit breaker (5 failures → 30s cooldown)
- Proxy rotation via ProxyManager when configured
- 403 ≠ 429 ≠ 503 — handled separately

### 4.2 Angel One SmartAPI
**Role:** Primary authenticated broker — live quotes, intraday history, options
**Priority:** 1 (after data-service/scrapling)
**What it provides:**
- Live LTP, quotes, batch quotes
- Historical candles (1m–1h, 1d) for NSE equities
- Option chains (synthesized from ScripMaster + Quote API + optionGreek)
- Option Greeks (IV per strike via optionGreek API; live only)
- WebSocket binary streaming (SmartStream 2.0) — managed by `AngelOneSmartStreamWs` in data-service
- SmartAPI-specific analytics: PCR, OI buildup, gainers/losers (Documented_Exceptions only)

**What it does NOT provide:**
- Historical index candles (returns empty — Upstox is used instead)
- Historical weekly/monthly candles
- Historical option Greeks
- Historical bid/ask

**Limits:**
- Historical API: ~3 req/s sustained
- ScripMaster: ~24h cache refresh
- Token: JWT valid until midnight IST

**Internal Yahoo fallback:** REMOVED in v9.0. Any SmartAPI failure throws a
`MarketDataError`; `withFailover()` is the sole handler for failover to Upstox/Yahoo.

### 4.3 Upstox
**Role:** Secondary authenticated broker — indices, live data, WebSocket
**Priority:** 2
**What it provides:**
- Live quotes (v2 Quote API)
- Historical candles via v3 (1m, 5m, 15m, 30m, 1h, 1d, 1w, 1M)
- Index historical data (NIFTY, BANKNIFTY — Angel One cannot provide this)
- Option chains (v2 option chain API)
- WebSocket v3 Protobuf streaming — managed by `UpstoxV3ProtobufWs` in data-service

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
**SUPPORTED_INTERVALS:** `"1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"` — `"3m"` is explicitly rejected.
**What it provides:**
- Historical OHLCV for all 9 supported timeframes
- Cross-provider reconciliation source (independent of Angel/Upstox)

**What it does NOT provide:**
- OI, IV, bid, ask, Greeks
- Live quotes

### 4.6 Yahoo Finance
**Role:** Last-resort fallback — tightly controlled
**Priority:** 3 (always last)
**What it provides:**
- Historical daily candles for NSE equities (via `.NS` suffix)
- Delayed live quotes (15-min delay — not suitable for production trading)

**What it NEVER provides for production use:**
- Real-time quotes
- Option Greeks
- Historical OI or IV
- F&O-specific data

**Policy:** Yahoo-derived data carries `providerType: "SECONDARY_FALLBACK"` and quality is
capped at grade `B` (score 70–84). It is never used for signal generation of live F&O
positions unless explicitly overridden by strategy config. NSE symbol → Yahoo ticker
mapping is canonicalized in `normalizer.ts` (`toYahooSymbol()`, `stripYahooSuffix()`).

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
  │   coalesced(key, fn)            ← Request coalescing (10s timeout)
  │     ↓
  │   withFailover(providers)       ← Failover engine
  │     ↓
  │   ScraplingProvider.getQuotes() ← HTTP GET data-service:8200/scraping/quotes
  │     ↓
  │   data-service (Python)         ← Scrapling/NSE acquisition
  │     ↓
  │   9-step validation pipeline    ← Python + TypeScript
  │     ↓
  │   stampLiveProvenance()         ← DataProvenance attached to response
  │     ↓
  │   cache (L2 Redis)              ← 3–5s TTL for quotes
  │     ↓
  │   Consumer receives             ← MDQuote[] + DataProvenance
  │
  └── On failure: withFailover tries AngelOneProvider → UpstoxProvider → YahooProvider
        Each switch emits a PROVIDER_SWITCH log at WARN level
```

### 5.2 Historical Data Flow

```
Consumer requests historical candles
  ↓
registry.getHistoricalCandles(req)
  ↓
coalesced(key, fn)         ← Deduplicates concurrent requests for the same range
  ↓
providerCapabilityMatrix.historyProvidersForSymbol(symbol, interval)
  ↓
If interval == "3m" → BLOCKED immediately, no provider called
  ↓
ScraplingProvider (data-service)     ← openchart / jugaad
  ↓ (if empty or failed)
AngelOneProvider (SmartAPI)
  ↓ (if empty or failed, or index symbol — angle_one skipped for index intraday)
UpstoxProvider (v3)
  ↓ (if all above fail and policy allows)
YahooProvider                        ← last resort, daily candles only

All candles pass through:
  → 9-step validation (schema, UTC normalization, OHLC drop-not-coerce,
    future-timestamp guard, dedup, gap detection, reconciliation, spike flag,
    quality scoring + provenance stamping)
  → persistProvenance() ← writes DataProvenanceRecord to data_provenance table
  → persist to CandleBar (idempotent upsert on instrumentId+exchange+intervalStr+time)
  → write L2 Redis (TTL by interval)
  → return to consumer
```

### 5.3 Live Data Flow (WebSocket)

```
Angel One SmartStream WS          Upstox WS v3 Protobuf
        │                                │
     (data-service owns both — sole upstream WS connections)
        │                                │
     AngelOneSmartStreamWs         UpstoxV3ProtobufWs
     (broker_ws_manager.py)        (broker_ws_manager.py)
        │                                │
        └────────────┬───────────────────┘
                     ↓
           BrokerWsConnection._on_tick()
                     ↓
           normalize to LiveTick (UTC timestamp, INR)
                     ↓
           validate (LTP > 0, timestamp ≤ now + 5s)
                     ↓
           dedup check (same symbol+ltp+timestamp within 1s → drop)
                     ↓
           Redis pub/sub: PUBLISH af:ticks:{symbol}   (lossy, real-time)
           Redis Streams: XADD af:stream:ticks         (durable AT_LEAST_ONCE)
                     ↓
        ┌────────────┴──────────────────────┐
        │                                   │
   Worker (scraping-tick-listener)    API WebSocket
   candle builder                     /v1/stream/quotes
```

### 5.4 WebSocket Reconnection Policy

Managed by `BrokerWsConnection._connection_loop()` in `broker_ws_manager.py`:

```
WS connection lost
  │
  ├─ Before each reconnect attempt: publish {"type":"reconnect"}
  │    to affected af:ticks:{symbol} channels
  │
  ├─ Attempt reconnect (exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s → 60s)
  │    max 10 attempts (_WS_MAX_RECONNECT_ATTEMPTS = 10)
  │
  ├─ Reconnect succeeds → resume tick publishing
  │
  └─ 10 consecutive failures → stop retrying
       publish {"type":"connection_failed"} to affected channels
       capability marked UNAVAILABLE in /health/providers
```

### 5.5 Failover Sequence Diagram

```
Consumer          Registry          Scrapling     data-service    AngelOne     Upstox
   │                 │                  │               │             │           │
   │ getQuotes()     │                  │               │             │           │
   │────────────────>│                  │               │             │           │
   │                 │ coalesced()      │               │             │           │
   │                 │ ScraplingProvider│               │             │           │
   │                 │ .getQuotes()     │               │             │           │
   │                 │─────────────────>│               │             │           │
   │                 │                  │ GET /scraping/│             │           │
   │                 │                  │ quotes        │             │           │
   │                 │                  │──────────────>│             │           │
   │                 │                  │     503       │             │           │
   │                 │                  │<──────────────│             │           │
   │                 │           MarketDataError        │             │           │
   │                 │<─────────────────│               │             │           │
   │                 │ recordFailure(scrapling)          │             │           │
   │                 │ emit PROVIDER_SWITCH(scrapling→angel_one)       │           │
   │                 │ AngelOne.getQuotes()              │             │           │
   │                 │─────────────────────────────────────────────→ │           │
   │                 │                  │               │         MDQuote[]       │
   │                 │                  │               │<────────────│           │
   │                 │ stampLiveProvenance() recordSuccess(angel_one) │           │
   │                 │ write L2 Redis                    │             │           │
   │  MDQuote[]      │                  │               │             │           │
   │<────────────────│                  │               │             │           │
```

---

## 6. CANONICAL TYPES

All data flowing out of data-service uses these types from `src/lib/market-data/types.ts`.

### Core Types

```typescript
// Provider identity — "nse" is permanently absent; "3m" never was a ProviderId
type ProviderId = "scrapling" | "angel_one" | "upstox" | "jugaad" | "openchart" | "yahoo";

// Canonical supported timeframes — "3m" is permanently absent
type Interval = "1m" | "5m" | "10m" | "15m" | "30m" | "1h" | "1d" | "1w" | "1M";
const SUPPORTED_TIMEFRAMES: readonly Interval[] = [
  "1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"
];

// isSupportedInterval("3m") returns false
// assertSupportedInterval("3m") throws with a message referencing V8 removal

// Canonical candle
type OHLCVCandle = {
  time: number;         // UTC epoch seconds, candle OPEN time
  open: number; high: number; low: number; close: number;
  volume: number;       // 0 with volumeUnavailable=true if source omitted it
  oi?: number | null;
  volumeUnavailable?: boolean;  // true = placeholder 0, not a genuine zero
};

// Canonical quote
type MDQuote = {
  symbol: string; token: string | null; exchange: Exchange | null;
  ltp: number | null; change: number | null; changePct: number | null;
  volume: number | null; oi: number | null;
  provider: ProviderId; fetchedAt: string; // UTC ISO-8601
  // … additional fields (prevClose, open, high, low, bid, ask, …)
};
```

### DataProvenance (attached to every registry response)

```typescript
type DataProvenance = {
  provider: ProviderId;
  providerType: "BROKER" | "OPEN_SOURCE" | "SECONDARY_FALLBACK" | "CACHE" | "DERIVED";
  authenticated: boolean;
  requestedAt: string;    // ISO-8601 UTC — when the request was initiated
  dataAsOf: string;       // ISO-8601 UTC — when the data is current as-of
  isLive: boolean;
  isHistorical: boolean;
  freshness: "LIVE" | "RECENT" | "STALE" | "HISTORICAL";
  quality: {
    score: number;        // 0–100 composite
    grade: "A+" | "A" | "B" | "C" | "D" | "BLOCKED";
    completeness: number; // % of expected data points present
    freshness: number;    // 0–1 sub-score
    accuracy: number;     // 0–1 sub-score (OHLC validation pass rate)
    validationStatus: "PASSED" | "FAILED" | "PARTIAL" | "PENDING";
    reconciliationStatus: "CONFIRMED" | "MINOR_DISCREPANCY" | "MAJOR_DISCREPANCY" | "UNRECONCILED";
    gapCount?: number;
    invalidCount?: number;
    suspiciousCount?: number;
  };
  sourceChain: ProviderId[];
};
```

**Cache hit provenance:** When data is served from L1/L2 cache, `providerType` is `"CACHE"`
and the original live provider is at `sourceChain[0]`. Stamped by `stampCacheProvenance()`
in `provenance.ts`.

**Freshness thresholds** (from `computeFreshness()` in `provenance.ts`):
- `LIVE`: data age ≤ 5 s
- `RECENT`: 6–60 s
- `STALE`: 61 s–24 h
- `HISTORICAL`: > 24 h

**Quality grade thresholds** (from `scoreToGrade()` in `provenance.ts`):
- A+ 95–100, A 85–94, B 70–84, C 50–69, D 30–49, BLOCKED < 30

---

## 7. CAPABILITY-AWARE PROVIDER ROUTING

The `provider-capability-matrix.ts` is the single source of truth for what each
provider supports. The routing engine consults this before any provider call.

### Routing Matrix (from `historyProvidersForSymbol()` and `liveProvidersFor()`)

| Dataset | Primary | Secondary | Tertiary | Yahoo |
|---|---|---|---|---|
| Live equity quote | scrapling → | angel_one → | upstox → | yahoo (delayed) |
| Live index quote | scrapling → | upstox → | | (no Yahoo for indices) |
| Live option chain | scrapling → | angel_one → | upstox | NEVER |
| Historical 1m (equity) | angel_one → | upstox v3 → | openchart | NEVER for intraday |
| Historical 5m (equity) | angel_one → | upstox v3 → | openchart | NEVER for F&O |
| Historical 1d (equity) | scrapling/jugaad → | angel_one → | upstox → | yahoo (fallback) |
| Historical 1w, 1M | scrapling/jugaad → | upstox → | | yahoo |
| Historical 5m (index) | upstox v3 → | openchart | | NEVER |
| Historical F&O OI | jugaad (via scrapling) → | | | NEVER |
| Historical option IV | NOT AVAILABLE from any provider | | | |
| **3m (any dataset)** | **BLOCKED** — error returned, no provider called | | | |

**Index symbol detection** (`isIndexSymbol()` in `provider-capability-matrix.ts`):
```typescript
["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].includes(symbol.toUpperCase())
```
When `isIndexSymbol(symbol) && interval !== "1d"`, Angel One is removed from the
provider list via `historyProvidersForSymbol()`.

**Critical rule:** `UNSUPPORTED_CAPABILITY` is never treated as `PROVIDER_FAILURE`.
The routing engine skips a provider for a dataset it doesn't support without
recording any health penalty or circuit breaker increment.

---

## 8. REQUEST COALESCING AND MULTI-LEVEL CACHE

### 8.1 Request Coalescing

Implemented in `ProviderRegistry.coalesced()` in `registry.ts`:

```
When N concurrent requests arrive for the same cache key before the upstream call completes:
  First request → stores Promise in pendingCalls Map (keyed by coalescingKey())
  Requests 2…N → await same existing Promise (no new upstream call)
  Upstream resolves or rejects → key removed, all N callers receive the same result

10-second hard timeout: withCoalesceTimeout() wraps the upstream call.
If it does not complete within 10 000 ms:
  → cancel via Promise.race with a timeout Promise
  → all waiters receive MarketDataError({ code: "PROVIDER_TIMEOUT", retryAfterMs: null })
```

### 8.2 Multi-Level Cache

```
L1: In-process Map<key, Promise> (per Next.js/worker process)
    TTL: LTP quotes 3s, full quotes 5s, 1m candles 30s, 5m–1h candles 60s, 1d candles 4h
    Keys: market:quote:{provider}:{SYMBOL}
    Implementation: memoQuote() / candleTtlForInterval() in market-cache.ts

L2: Redis
    TTL: same as L1, shared across all processes
    Keys: md:quote:{provider}:{SYMBOL}
          md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}
    Implementation: ioredis

L3: PostgreSQL CandleBar table
    Permanent historical store; queried on L1+L2 cache miss
    Write-back: after a successful L3 read, write the data back to L2 and L1
                before returning to the consumer

Cache miss through all three levels → provider call via withFailover()
```

### 8.3 Cache Key Schema

| Operation | L2 Redis Key Pattern | TTL |
|---|---|---|
| Single quote | `md:quote:{provider}:{SYMBOL}` | 3s |
| Batch quotes | `md:quotes-batch:{provider}:{SYM1,SYM2,...}` | 3s |
| Intraday candles | `md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}` | 30s |
| Daily+ candles | `md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}` | 4h |
| Option chain | `md:oc:{provider}:{underlying}:{expiry}` | 15s |
| Instrument master | `md:instruments:{provider}:{filterKey}` | 12h |
| BackfillCheckpoint | `md:backfill:checkpoint:{symbol}:{exchange}:{interval}` | no TTL |

---

## 9. CIRCUIT BREAKER AND PROVIDER HEALTH

### 9.1 Health Score State Machine

Implemented in `health.ts`. Constants:

```typescript
const CIRCUIT_OPEN_THRESHOLD    = 20;   // score below this opens the circuit
const CIRCUIT_PROBE_RESTORE_SCORE = 20; // score restored to on a successful half-open probe
const DEGRADED_THRESHOLD        = 60;   // score below this = status "degraded"
const CIRCUIT_RETRY_MS          = 30_000; // half-open window
const FAILURE_PENALTY           = 40;   // flat points per failure (Req 15.2: exactly 40)
const RECOVERY_PER_SUCCESS      = 10;   // points per success (cap 100)
const AUTH_FAILURE_PENALTY      = 25;   // extra for auth failures (applied on top of 40)
const HARD_BLOCK_PENALTY        = 40;   // extra for 403 hard blocks
const RATE_PRESSURE_PENALTY     = 15;   // extra for 429 / 503
const STALE_DATA_PENALTY        = 15;   // flat penalty for stale data events
const LATENCY_WINDOW            = 100;  // rolling window for p50/p95/p99
```

State transitions:

```
Initial: score = 100, circuitOpen = false

recordFailure(kind):
  consecutiveSuccesses = 0
  consecutiveFailures += 1
  score -= 40 [+ 25 if auth_failure, + 40 if hard_block, + 15 if rate_limit/unavailable]
  score = max(0, score)
  requestCount += 1; errorCount += 1
  if score < 20 and circuit was closed → open circuit, circuitRetryAt = now + 30s

recordSuccess(latencyMs):
  consecutiveFailures = 0
  consecutiveSuccesses += 1
  score = min(100, score + 10)
  requestCount += 1; successCount += 1
  latencySamples.push(latencyMs) [rolling window of last 100]
  if circuit was open → close circuit (half-open probe succeeded), score = 20

Circuit opens:  score < 20
Half-open:      circuitRetryAt elapsed → allow ONE probe request
  Probe success → score = 20, circuitOpen = false
  Probe failure → circuitRetryAt pushed out (escalating backoff, cap 5 min)
```

### 9.2 Capability-Aware Circuit Breaking

Each provider has **independent circuits per capability** keyed by `"${id}::${capability}"`.
Capability types: `"liveQuotes" | "historicalCandles" | "optionChain" | "instrumentMaster" | "webSocket"`.

```
angel_one::historicalCandles OPEN  →  historical routes to upstox/scrapling
angel_one::liveQuotes OK           →  live quotes still use angel_one

Checked in withFailover() before each attempt:
  isCapabilityCircuitOpen("angel_one", "historicalCandles")
```

### 9.3 ProviderHealth Snapshot

`getProviderHealth()` returns `ProviderHealth` with:
- `providerId`, `status` (healthy/degraded/unhealthy)
- `score` (0–100)
- `lastSuccessAt`, `lastFailureAt` (ISO-8601 UTC or null)
- `consecutiveFailures`, `consecutiveSuccesses`
- `circuitOpen`, `circuitRetryAt`
- `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms` (rolling last 100 requests)
- `requestCount`, `successCount`, `errorCount`
- `successRate` (null when no requests recorded)

The `GET /api/data/providers/health` TypeScript endpoint and `GET /health/providers`
Python endpoint expose these metrics. Neither endpoint includes any credential value,
JWT token, API key, or secret.

---

## 10. PROVENANCE STAMPING AND PERSISTENCE

### 10.1 Stamping in withFailover()

After every successful provider call, `withFailover()` in `failover.ts` calls
`stampLiveProvenance()` from `provenance.ts`:

```typescript
const provenance = stampLiveProvenance({
  providerId: provider.id,
  dataAsOf,               // extracted from MDQuote.fetchedAt or OHLCVCandle.time
  isLive,                 // true for getQuotes / getLatestQuote
  isHistorical,           // true for getHistoricalCandles
  requestedAtMs,
  sourceChain: attemptedProviders.slice(0, -1),
});
lastProvenanceByOperation.set(operationId, provenance);
```

Cache hit path: `stampCacheProvenance(originalProvider, requestedAtMs, dataAsOf, isLive, isHistorical)`
sets `providerType: "CACHE"` and records the original provider in `sourceChain[0]`.

### 10.2 DataProvenanceRecord Persistence

For every historical candle fetch, `persistProvenance()` in `provenance.ts` writes
an immutable record to the `data_provenance` PostgreSQL table (fire-and-forget —
a DB failure never propagates to the caller):

| Field | Value |
|---|---|
| `provider` | Provider ID |
| `sourceType` | `"BROKER_AUTHENTICATED"` / `"OPEN_SOURCE_NSE_DERIVED"` / `"YAHOO_FALLBACK"` |
| `authenticated` | Whether called with valid credentials |
| `credentialIdentityHash` | `sha256(SMARTAPI_CLIENT_CODE)` for Angel One, `sha256(UPSTOX_CLIENT_SECRET)` for Upstox — **never** the credential value |
| `responseHash` | `sha256(rawResponseBody.slice(0, 50 KB))` |
| `responseTruncated` | `true` when body > 50 KB |
| `dataTrustStatus` | `"VERIFIED"` for broker, `"VERIFIED_SINGLE_SOURCE"` for OSS, `"UNVERIFIED"` for Yahoo |
| `instrumentId`, `exchange`, `intervalStr`, `fromTs`, `toTs` | From the request |

Live quote fetches do **not** trigger `persistProvenance()`.

### 10.3 Forensics Endpoint

`GET /api/in/data/forensics/:tradeId` (`src/app/api/in/data/forensics/[tradeId]/route.ts`)
returns the complete data-to-trade chain:

```json
{
  "tradeId": "...",
  "paperTrade": { … },
  "signalRecord": { … },
  "dataProvenanceRecord": {
    "provider": "angel_one",
    "sourceType": "BROKER_AUTHENTICATED",
    "fetchedAt": "2026-09-12T09:30:15Z",
    "dataTrustStatus": "VERIFIED",
    "responseHash": "sha256:…",
    "instrumentId": "NIFTY", "intervalStr": "5m"
  },
  "lineageEntry": { … },
  "qualityAtSignalTime": { "score": 92, "grade": "A" },
  "chain": [ … ]
}
```

If no `DataProvenanceRecord` exists for the `tradeId`, HTTP 404 is returned with
an error body identifying the missing provenance link and the `tradeId`.

---

## 11. PROVIDER SWITCH LOGGING

`maybeLogFailover()` in `failover.ts` emits a structured `PROVIDER_SWITCH` log
at `WARN` level via `mdLog()` on every provider transition (with cooldown to
suppress flapping logs during sustained outages):

```typescript
mdLog("PROVIDER_SWITCH", {
  from:       ProviderId,      // outgoing provider
  to:         ProviderId,      // incoming provider
  reason:     FailureKind,     // e.g. "unavailable", "auth_failure"
  instrument: string,          // operationId / symbol
  gapMs:      number,          // elapsed ms since last successful response
  timestamp:  string,          // ISO-8601 UTC
});
```

`MARKET_CLOSED` and `UNSUPPORTED_CAPABILITY` errors **never** trigger a
`PROVIDER_SWITCH` log — they do not increment `consecutiveFailures` or open
the circuit.

---

## 12. 9-STEP VALIDATION PIPELINE

Every provider response passes through this pipeline (in TypeScript: normalizer/
validation layer; in Python: `data-service/src/providers/common/normalizer.py`).

```
Step 1: Schema validation (Pydantic Python / Zod TypeScript)
         → reject malformed responses; classify as INVALID_DATA

Step 2: Timestamp normalization
         → all timestamps → UTC epoch ms
         → NSE timestamps (Asia/Kolkata +05:30) converted to UTC
         → candle time = bar OPEN time (not close time)

Step 3: OHLC validation — DROP invalid candles, NEVER coerce
         → high >= max(open, close)   — else DROP; record in invalidCount
         → low <= min(open, close)    — else DROP; record in invalidCount
         → high >= low                — else DROP
         → all prices > 0            — else DROP
         → no NaN, no Infinity       — else DROP

Step 4: Future timestamp guard
         → candle.time > now + 5 000 ms → DROP (classify INVALID_DATA)
         → tick.timestamp > now + 5 s  → DROP; never publish to Redis

Step 5: Duplicate detection
         → key = (instrumentId, exchange, intervalStr, time)
         → duplicate → keep first, drop subsequent

Step 6: Gap detection
         → expectedBars = f(interval, from, to, market calendar)
         → gapCount = expectedBars − receivedBars
         → gapCount / expectedBars > 20% → quality grade = DEGRADED

Step 7: Cross-provider reconciliation (when 2+ providers return same data)
         → per-field deviation = abs((a − b) / ((a+b)/2))
         → deviation > 0.5% on any field → RECONCILIATION_CONFLICT
         → conflict candles excluded from output
         → discrepancy written to data_reconciliation table
         → fewer than 2 providers → reconciliationStatus = UNRECONCILED

Step 8: Spike detection
         → abs(close − prev_close) / prev_close > 20% → suspicious: true
         → candle IS included (circuit-limit moves are legitimate)
         → first candle in series → skip spike check (no prev_close)

Step 9: Quality scoring + provenance stamping
         score = 0.25×completeness + 0.25×freshness + 0.25×accuracy
               + 0.15×consistency + 0.10×provider_reliability
         → grade: A+(95–100), A(85–94), B(70–84), C(50–69), D(30–49), BLOCKED(<30)
         → BLOCKED → validationStatus = "FAILED" → signal engine MUST hard-stop
```

### Tick Validation (before Redis pub/sub publish)

```
ltp <= 0              → DROP; increment validationFailures["negative_ltp"]
timestamp > now + 5s  → DROP; increment validationFailures["future_timestamp"]
duplicate (symbol+ltp+timestamp within 1s) → DROP; increment dedup count
Valid tick → PUBLISH af:ticks:{SYMBOL} + XADD af:stream:ticks
```

---

## 13. ERROR MODEL

```typescript
type MarketDataErrorCode =
  | "AUTH_FAILURE"          // 401 — invalid/expired credentials
  | "AUTHORIZATION_FAILURE" // 403 — forbidden / WAF / gateway block
  | "RATE_LIMIT"            // 429 — too many requests
  | "UNAVAILABLE"           // 503 / 5xx — provider temporarily degraded
  | "TIMEOUT"               // request exceeded deadline (provider-level)
  | "PROVIDER_TIMEOUT"      // coalescing timeout: in-flight call exceeded 10s
  | "NETWORK"               // ECONNRESET / DNS / connection refused
  | "MALFORMED_RESPONSE"    // body present but failed validation/parse
  | "CAPABILITY"            // provider does not support this capability
  | "INSTRUMENT_NOT_FOUND"  // symbol/token unknown to this provider
  | "STALE_DATA"            // data too old to trust
  | "NOT_CONFIGURED"        // provider disabled / no credentials
  | "CIRCUIT_OPEN"          // provider circuit is open; call was skipped
  | "NO_PROVIDER";          // every provider in the chain was exhausted
```

**Critical distinctions:**
- `MARKET_CLOSED` — propagated as-is. Never triggers failover, never increments failure counter.
- `UNSUPPORTED_CAPABILITY` — provider skipped silently. No failure count, no circuit penalty.
- `EMPTY_DATA` — holiday / off-hours. Not a provider failure.
- `PROVIDER_TIMEOUT` — used specifically for the 10-second coalescing timeout.

---

## 14. AUTHENTICATION AND CREDENTIAL LIFECYCLE

```
Frontend (User Settings)
  ↓
POST /api/auth/settings  (HTTPS)
  ↓
UserSetting.apiKeysEncrypted (PostgreSQL, AES-256-GCM via src/lib/crypto.ts)
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

### Security Invariants (all verified in codebase)

1. **`NEXT_PUBLIC_*` build guard** — `next.config.ts` runs at build time. If any env var
   matching `NEXT_PUBLIC_SMARTAPI_*`, `NEXT_PUBLIC_UPSTOX_*`, or `NEXT_PUBLIC_ENCRYPTION_*`
   is detected, `process.exit(1)` terminates the build before any bundle is produced.
2. **No credentials in API responses** — `GET /api/data/providers/health` and
   `GET /health/providers` exclude all fields matching credential/token patterns.
3. **Credential identity hash only** — `DataProvenanceRecord.credentialIdentityHash` is
   `sha256(SMARTAPI_CLIENT_CODE)` for Angel One, `sha256(UPSTOX_CLIENT_SECRET)` for Upstox.
   Never the credential value, prefix, or any other derived form.
4. **data-service Python** — reads credentials from `os.environ` at startup; no HTTP
   endpoint accepts a credential value in a request body or query parameter.
5. **Error logs** — contain only provider ID and error code; never the credential value.
6. **CORS** — data-service Python only allows `localhost:3000`.

---

## 15. NORMALIZATION

`src/lib/market-data/normalizer.ts` is the single source of truth for:
- UTC ↔ IST conversion (`utcToIst`, `istToUtc`)
- SmartAPI / Upstox timestamp parsing (`fromSmartApiDateTime`, `fromUpstoxTimestamp`)
- Interval → provider-specific string mapping (`intervalToSmartApi`, `intervalToUpstox`, `intervalToUpstoxV3`, `intervalToYahoo`)
- Exchange → provider-specific string mapping (`exchangeToSmartApi`, `exchangeToUpstox`)
- NSE symbol → Yahoo ticker mapping (`toYahooSymbol`, `stripYahooSuffix`)
- Candle normalization (`normaliseCandlesFromAngel`, `normaliseCandlesFromUpstox`)

No file outside `normalizer.ts` may define its own NSE→Yahoo symbol mapping table.

---

## 16. DATABASE SCHEMA

### New models (added v9.0)

**`DataProvenance`** — immutable record per historical candle fetch:
Fields: `id`, `datasetKey`, `provider`, `sourceType`, `authenticated`,
`credentialIdentityHash`, `fetchedAt`, `dataAsOf`, `responseHash`,
`responseTruncated`, `dataTrustStatus`, `instrumentId`, `exchange`,
`intervalStr`, `fromTs`, `toTs`, `datasetVersion`, `rowCount`, `createdAt`.

**`DataReconciliation`** — cross-provider discrepancy tracking:
Fields: `id`, `instrumentId`, `intervalStr`, `candleTime`, `providerA`,
`providerB`, `fieldName`, `valueA`, `valueB`, `deviationPct`, `status`,
`resolved`, `createdAt`.

**`HistoricalBackfillJob`** — resumable backfill job state:
Fields: `id`, `instrumentId`, `exchange`, `intervalStr`, `fromTs`, `toTs`,
`status`, `chunksTotal`, `chunksDone`, `chunksFailed`, `lastCheckpointTs`,
`errorMessage`, `startedAt`, `completedAt`, `createdAt`.

### Existing models with new indexes

**`CandleBar`** — new covering index for ML window queries:
`@@index([instrumentId, exchange, intervalStr, time(sort: Desc)], name: "idx_candle_bar_window")`

**`OptionChainSnapshot`** — new index for latest-chain queries:
`@@index([underlying, expiry, captureTimestamp(sort: Desc)], name: "idx_option_chain_latest")`

### 3m in schema comments

`prisma/schema.prisma` contains one permitted reference to `"3m"` in the `CandleBar`
model comment: `"intervalStr — candle width: … (V8: "3m" was removed)"`. This is a
permitted past-tense V8 reference per the eradication policy.

---

## 17. HISTORICAL ENGINE — RESUMABLE BACKFILL

### Design Principles

- **Resumable:** Each `(symbol, exchange, interval)` job has a `BackfillCheckpoint`
  in Redis (key: `md:backfill:checkpoint:{symbol}:{exchange}:{interval}`) with
  PostgreSQL fallback in `HistoricalBackfillJob.lastCheckpointTs`.
- **Idempotent:** Bulk upsert on `(instrumentId, exchange, intervalStr, time)` — safe to re-run.
- **Chunked:** Max chunk size per provider (Angel 1m → 30 days, Angel 5m–1h → 60 days, Upstox v3 → 100 days).
- **Bounded concurrency:** Max 3 concurrent provider calls.
- **Exponential backoff:** Base 500ms, 2×, ±20% jitter, 30s cap. After 5 consecutive chunk failures → chunk marked `FAILED`; advance to next chunk.
- **Gap detection:** After all chunks complete, classifies gaps as `EXPECTED_NO_DATA`, `MARKET_HOLIDAY`, `ACTUAL_DATA_GAP`, or `PENDING_RECOVERY`.
- **Gap recovery:** For `ACTUAL_DATA_GAP` with an alternative capable provider, schedules a recovery attempt and records the outcome in `HistoricalBackfillJob`.

### Empty Data Classification

When `registry.getHistoricalCandles()` returns an empty array for a symbol/interval
that has a checkpoint, `fno-backfill-runner.service.ts` classifies the result as
`EMPTY_DATA` (not `PROVIDER_FAILURE`), advances the checkpoint cursor, and continues
to the next symbol.

---

## 18. F&O UNIVERSE — DYNAMIC AND POINT-IN-TIME AWARE

```
Every 24h (or on manual refresh):
  1. Fetch instrument master from Angel One + Upstox (merged, deduped by ISIN)
  2. Filter F&O-eligible: instrumentType IN (FUTIDX, FUTSTK, OPTIDX, OPTSTK)
  3. Track lifecycle per symbol: ACTIVE | ADDED | REMOVED | SUSPENDED | UNRESOLVED
  4. Sort active symbols alphabetically
  5. checksum = sha256(sorted_active_symbols.join(","))
  6. If checksum differs from last snapshot → create new FnoUniverseSnapshot
     with effectiveFrom = now; set previous effectiveTo = now
  7. Symbol list MUST NOT be hardcoded — always derived from instrument master

Point-in-time queries (backtesting):
  WHERE effective_from <= queried_date
    AND (effective_to IS NULL OR effective_to > queried_date)
  No snapshot covering the date → return error "No universe data for {date}"
```

---

## 19. OBSERVABILITY

### Structured Logging (`mdLog()` in `health.ts`)

Every market-data layer log entry includes:
- `requestId` — per-request UUID
- `provider` — which provider handled the request
- `event` — typed event name (`provider_selected`, `provider_failure`, `PROVIDER_SWITCH`, etc.)
- `latencyMs` — measured duration
- No secrets, no credentials, no personal data

### Key Log Events

| Event | Level | When emitted |
|---|---|---|
| `provider_selected` | INFO | Before each provider attempt |
| `provider_failure` | WARN | Each provider failure (throttled after 5 consecutive) |
| `PROVIDER_SWITCH` | WARN | On every provider transition in `withFailover()` |
| `provider_circuit_open` | WARN | When circuit opens for a provider |
| `capability_circuit_open` | WARN | When circuit opens for a provider+capability pair |
| `SLO_BREACH` | WARN | When measured latency exceeds 2× SLO target |
| `rate_limited` | WARN | When a 429 response is received |
| `stale_data` | WARN | When returned data is past freshness bound |
| `provenance_persist_error` | WARN | When `persistProvenance()` DB write fails |

### Health Endpoints

- `GET /health/live` — liveness probe (data-service Python)
- `GET /health/ready` — readiness probe; checks Redis, tick_publisher, quote capability, chromium
- `GET /health/providers` — per-provider and per-capability circuit breaker state + latency
- `GET /api/data/providers/health` — TypeScript ProviderHealth[] (p50/p95/p99, requestCount, errorCount)
- `GET /publisher/status` — `running`, `subscribedSymbols`, `ticksPublished`, `validationFailures` (per-reason), `lastPublishedAt` (Unix ms)

---

## 20. PERFORMANCE SLOs

| Operation | Cache Level | SLO p95 Target |
|---|---|---|
| Cached quote (L1 in-process) | L1 | < 1ms |
| Cached quote (L2 Redis) | L2 | < 20ms |
| Historical candle (L2 Redis) | L2 | < 50ms |
| Historical range (L3 PostgreSQL) | L3 | < 100ms |
| Live quote (provider call) | Provider | < 2000ms |
| Option chain (provider call) | Provider | < 3000ms |

SLO breach logging emits a structured `SLO_BREACH` event at `WARN` level when measured
latency exceeds 2× the SLO target, including `operation`, `latencyMs`, `sloMs`, and `provider`.

---

## 21. CANONICAL IMPORT BOUNDARY

### Enforcement Points

1. **ESLint** (`eslint.config.mjs`) — `no-restricted-imports` rules block:
   - `**/services/india/yahoo*` outside the allowlist
   - `**/services/india/angelone*` outside the allowlist and documented exceptions
   - `yahoo-finance2` outside the allowlist
   `npm run lint` fails with non-zero exit and names both the offending file and forbidden import.

2. **`canonical-import-guard.ts`** — defines:
   - `FORBIDDEN_IMPORTS`: `["yahoo-finance2", "@/services/india/yahoo"]`
   - `ALLOWLISTED_BYPASS_FILES`: the approved provider wrappers and their backends
   - `YAHOO_IMPORT_ALLOWLIST`: only `providers/yahoo.ts` and `services/india/yahoo/index.ts`
   - `ANGEL_BROKER_ANALYTICS_EXCEPTIONS`: files with documented broker analytics calls

3. **Vitest test suite** (`tests/lib/market-data/canonical-import-guard.test.ts`):
   - One individual assertion per violation site (V-01 through V-13) confirming the file no longer contains a forbidden import
   - Asserts `ProviderId` does not include `"nse"` or `"3m"`
   - Asserts `SUPPORTED_TIMEFRAMES` equals exactly `["1m","5m","10m","15m","30m","1h","1d","1w","1M"]`
   - Asserts `isSupportedInterval("3m")` returns `false`
   - Reports `Documented exceptions: 5 files` (counting the ANGEL_BROKER_ANALYTICS_EXCEPTIONS in consumer code)

---

## 22. 3m TIMEFRAME COMPLETE ERADICATION (v8/v9)

`"3m"` is unrepresentable at every layer. Enforcement is verified at each boundary:

| Layer | Enforcement | Status |
|---|---|---|
| TypeScript `Interval` type | `"3m"` absent from union type | ✅ Verified |
| `SUPPORTED_TIMEFRAMES` constant | Equals exactly the 9 supported values | ✅ Verified |
| `isSupportedInterval("3m")` | Returns `false` | ✅ Verified |
| `assertSupportedInterval("3m")` | Throws with V8 reference | ✅ Verified |
| Python `validate_interval("3m")` | Raises `ValueError` | ✅ Verified |
| Python `SUPPORTED_INTERVALS` frozenset | Does not include `"3m"` | ✅ Verified |
| Python `acquisition_planner.py` | Raises `ValueError` for `"3m"` | ✅ Verified |
| OpenChart adapter `SUPPORTED_INTERVALS` | Does not include `"3m"` | ✅ Verified |
| `provider-capability-matrix.ts` | Routes `"3m"` as BLOCKED | ✅ Verified |
| `v8-signal-data-gate.service.ts` | Returns `BLOCKED` for `interval === "3m"` | ✅ Verified |
| All API endpoints (`interval` param) | Return HTTP 400 via `assertSupportedInterval` | ✅ Verified |
| `prisma/schema.prisma` | No `"3m"` examples (one past-tense V8 comment permitted) | ✅ Verified |

A codebase grep of `src/`, `worker/src/`, `data-service/src/`, `ml-service/src/` for
the string literal `"3m"` must return zero matches outside comments that simultaneously
use past tense **and** reference "V8".

---

## 23. KNOWN LIMITATIONS

1. **Broker-specific analytics** (PCR, OI buildup, gainers/losers via SmartAPI) have no
   generic `MarketDataProvider` equivalent. They remain as documented exceptions in four
   files until a `getBrokerAnalytics()` interface extension is designed.

2. **Historical option Greeks** are not available from any provider. IV is available live
   via Angel One's `optionGreek` API only. Historical IV must be derived from historical
   option prices if needed.

3. **Historical bid/ask** is not available from any provider for Indian options.

4. **1m intraday depth** is limited by Angel One's historical API cap (~3 req/s). Full
   universe 1m backfill takes significantly longer than 5m+ intervals.

5. **Upstox v2 gaps** at 5m/10m/15m/1h — use v3 or Angel One for these intervals.

6. **Performance SLOs** — targets are defined and logged; actual p50/p95/p99 measurements
   under production load are recorded in `DATA_SERVICE_PERFORMANCE_REPORT.md` and must
   be re-measured after any significant infrastructure change.

7. **Quality formula is a baseline** — the quality score computed by `stampLiveProvenance()`
   is a conservative baseline. The full validation pipeline (step 9 above) refines
   `invalidCount`, `gapCount`, and `reconciliationStatus` when per-candle statistics
   are available downstream.
