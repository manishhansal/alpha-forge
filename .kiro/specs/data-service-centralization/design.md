# Design Document — Data-Service Centralization

## Feature: `data-service-centralization`
**Branch:** `refactor/signals`  
**Version:** v9.0  
**Date:** 2026-09-12  

---

## Overview

AlphaForge's market data layer is **partially centralized**. The `data-service` Python microservice (port 8200) and the TypeScript `ProviderRegistry` (`src/lib/market-data/registry.ts`) together form the intended single data platform, but 13 violation sites across the TypeScript codebase still import Angel One, Upstox, and Yahoo Finance adapters directly, bypassing the registry's failover engine, health tracking, and provenance recording.

This design completes the architectural transformation. After this refactor:

- Every market data access from every TypeScript consumer (signal engine, ML bridge, backtester, workers, API routes) flows through `registry.getQuotes()`, `registry.getHistoricalCandles()`, `registry.getOptionChain()`, and `registry.getInstrumentMaster()`.
- The Python `data-service` at priority 0 is the first provider in the chain, with Angel One, Upstox, and Yahoo as ordered fallbacks.
- A canonical import guard enforces the boundary at CI time; no new violation sites can be introduced.
- Every response carries an immutable `DataProvenance` record (provider, quality, timestamps).
- The `3m` timeframe is completely eradicated at every layer.

**What is NOT changing:** The existing `data-service` Python scaffold, the `ProviderRegistry` singleton, the four approved provider files (`scrapling.ts`, `angel-one.ts`, `upstox.ts`, `yahoo.ts`), the V8 historical fabric, the circuit breaker in `health.ts`, or the failover engine in `failover.ts`. This refactor fixes only the consumer side.

---

## Architecture

### High-Level System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    ALPHFORGE CONSUMERS                                │
│                                                                       │
│  Signal Engine  │  ML Bridge  │  Workers  │  API Routes  │  Backtest │
└────────┬────────┴──────┬──────┴─────┬─────┴──────┬───────┴────┬──────┘
         │               │            │             │            │
         └───────────────┴────────────┴─────────────┴────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │       DataGateway          │
                         │  registry.ts (singleton)   │
                         │                            │
                         │  getQuotes()               │
                         │  getHistoricalCandles()    │
                         │  getOptionChain()          │
                         │  getInstrumentMaster()     │
                         │  subscribe()               │
                         │  getHealth()               │
                         └────────────┬───────────────┘
                                      │
                    ┌────────────┬────┴──────┬──────────────┐
                    │            │           │              │
             ┌──────▼──────┐ ┌──▼───┐ ┌────▼───┐ ┌────────▼──┐
             │  Scrapling   │ │Angel │ │Upstox  │ │  Yahoo    │
             │  Provider    │ │One   │ │Provider│ │ Provider  │
             │  (Priority 0)│ │(P 1) │ │(P 2)   │ │ (P 3)     │
             └──────┬───────┘ └──────┘ └────────┘ └───────────┘
                    │          ↑ Failover via withFailover()
                    │
             ┌──────▼───────────────────────────────────────────┐
             │               DATA-SERVICE (Python, :8200)        │
             │                                                   │
             │  ScraplingProvider  ←─── HTTP REST GET/POST ────→ │
             │                                                   │
             │  Provider Gateway    Normalization Pipeline       │
             │  Capability Router   Validation (9-step)          │
             │  Auth / Cred Mgr     Reconciliation               │
             │  Quality Engine      Provenance Stamping          │
             │  Historical Engine   Gap Detection + Recovery     │
             │  Live Market Engine  WS fanout via Redis pub/sub  │
             │  Instrument Master   F&O Universe Management      │
             │  Cache L2 (Redis)    Cache L3 (PostgreSQL)        │
             └─────────────────────┬─────────────────────────────┘
                                   │
               ┌───────────────────┼───────────────────────┐
               │                   │                       │
        ┌──────▼──────┐   ┌────────▼──────┐   ┌──────────▼──────┐
        │  NSE / Angel │   │  Jugaad-data  │   │  OpenChart      │
        │  One WS feed │   │  (Python)     │   │  (Python)       │
        │  Upstox WS   │   │  bhavcopy EOD │   │  intraday OHLCV │
        └─────────────┘   └───────────────┘   └─────────────────┘
```

### Multi-Level Cache Architecture

```
Consumer request
      │
      ▼
L1: In-process Map<key, {value, expiresAt}>   (per Next.js process, ~3–4s TTL for quotes)
      │ miss
      ▼
L2: Redis                                      (shared across all Next.js + worker processes)
      │ miss
      ▼
L3: PostgreSQL CandleBar table                 (permanent; historical only)
      │ miss
      ▼
Provider call (withFailover: data-service → Angel One → Upstox → Yahoo)
      │
      ▼
Write back to L2 → L1 → return to consumer
```

### Request Coalescing

When N concurrent requests arrive for the same cache key before the upstream call completes, a single in-flight `Promise` is shared across all waiters. The upstream provider is called **exactly once**. All N callers receive the same result.

```
Request 1 ──→ cache miss → start upstream call → store Promise in pendingCalls Map
Request 2 ──→ cache miss → key in pendingCalls → await same Promise
Request 3 ──→ cache miss → key in pendingCalls → await same Promise
...
Request N ──→ await same Promise

Upstream returns → resolve Promise → all N callers receive result simultaneously
```

---

## Components and Interfaces

### 2.1 DataGateway (TypeScript)

The `ProviderRegistry` class in `src/lib/market-data/registry.ts` **is** the DataGateway. Consumers import it as:

```typescript
import { registry, bootstrapRegistry } from '@/lib/market-data/registry';
```

No new classes are created. The registry already exposes the correct interface. The work is in fixing consumers to use it.

**Registry interface (already implemented):**

```typescript
class ProviderRegistry {
  getQuotes(symbols: string[], opts?: ProviderCallOptions): Promise<Array<MDQuote | null>>;
  getLatestQuote(symbol: string, opts?: ProviderCallOptions): Promise<MDQuote | null>;
  getHistoricalCandles(req: HistoricalCandleRequest, opts?: ProviderCallOptions): Promise<OHLCVCandle[]>;
  getOptionChain(underlying: string, expiry?: string, opts?: ProviderCallOptions): Promise<OptionChain>;
  getInstrumentMaster(filter?: InstrumentMasterFilter, opts?: ProviderCallOptions): Promise<Instrument[]>;
  subscribe(req: SubscribeRequest, onTick: (tick: LiveTick) => void, onError?: (err: unknown) => void): () => void;
  getHealth(): ProviderHealth[];
}
```

### 2.2 MarketDataProvider Interface

Each provider in `src/lib/market-data/providers/` implements `MarketDataProvider`. This interface is unchanged:

```typescript
interface MarketDataProvider {
  readonly id: ProviderId;
  getHistoricalCandles(req: HistoricalCandleRequest, opts?: ProviderCallOptions): Promise<OHLCVCandle[]>;
  getLatestQuote(symbol: string, opts?: ProviderCallOptions): Promise<MDQuote | null>;
  getQuotes(symbols: string[], opts?: ProviderCallOptions): Promise<Array<MDQuote | null>>;
  getOptionChain(underlying: string, expiry?: string, opts?: ProviderCallOptions): Promise<OptionChain>;
  getInstrumentMaster(filter?: InstrumentMasterFilter, opts?: ProviderCallOptions): Promise<Instrument[]>;
  subscribe(req: SubscribeRequest, onTick: (tick: LiveTick) => void, onError?: (err: unknown) => void): () => void;
  unsubscribe(tokens: string[]): void;
  getProviderHealth(): ProviderHealth;
}
```

### 2.3 Canonical Types (unchanged, `src/lib/market-data/types.ts`)

```typescript
// 3m is permanently absent — isSupportedInterval("3m") returns false
type Interval = "1m" | "5m" | "10m" | "15m" | "30m" | "1h" | "1d" | "1w" | "1M";
const SUPPORTED_TIMEFRAMES: readonly Interval[] = ["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"];

type ProviderId = "scrapling" | "angel_one" | "upstox" | "jugaad" | "openchart" | "yahoo";
// "nse" is permanently absent from ProviderId.

type MDQuote = {
  symbol: string;
  token: string | null;
  exchange: Exchange | null;
  ltp: number | null;
  change: number | null; changePct: number | null;
  volume: number | null; oi: number | null;
  provider: ProviderId;
  fetchedAt: string; // UTC ISO-8601
  // ... additional fields
};

type OHLCVCandle = {
  time: number;   // UTC epoch ms, candle OPEN time
  open: number; high: number; low: number; close: number;
  volume: number; oi?: number | null;
};
```

**New type — DataProvenance** (to be added to `types.ts`):

```typescript
type DataFreshness = "LIVE" | "RECENT" | "STALE" | "HISTORICAL";
type DataTrustStatus = "TRUSTED" | "UNVERIFIED" | "DEGRADED" | "BLOCKED";
type QualityGrade = "A+" | "A" | "B" | "C" | "D" | "BLOCKED";
type ReconciliationStatus = "CONFIRMED" | "MINOR_DISCREPANCY" | "MAJOR_DISCREPANCY" | "UNRECONCILED";

type DataProvenance = {
  provider: ProviderId;
  providerType: "BROKER" | "OPEN_SOURCE" | "SECONDARY_FALLBACK" | "CACHE" | "DERIVED";
  authenticated: boolean;
  requestedAt: string;    // ISO-8601 UTC
  dataAsOf: string;       // ISO-8601 UTC
  isLive: boolean;
  isHistorical: boolean;
  freshness: DataFreshness;
  quality: {
    score: number;        // 0–100
    grade: QualityGrade;
    completeness: number; // 0–100 percentage
    freshness: number;    // 0–1
    accuracy: number;     // 0–1
    validationStatus: "PASSED" | "FAILED" | "PARTIAL" | "PENDING";
    reconciliationStatus: ReconciliationStatus;
    gapCount?: number;
    invalidCount?: number;
    suspiciousCount?: number;
  };
  sourceChain: ProviderId[];
};
```

### 2.4 MarketDataError (already implemented in `types.ts`)

```typescript
class MarketDataError extends Error {
  code: MarketDataErrorCode;
  httpStatus: number | null;
  retryAfterMs: number | null;
}

// Critical distinctions:
// MARKET_CLOSED — not a failure, never triggers failover
// UNSUPPORTED_CAPABILITY — not a failure, never increments circuit breaker
// EMPTY_DATA — not a failure on holiday/off-hours
```

### 2.5 Canonical Import Guard (`src/lib/market-data/canonical-import-guard.ts`)

Already implemented. The missing enforcement is:
1. ESLint `no-restricted-imports` rule covering `@/services/india/angelone` outside the allowlist (the existing rule only covers `yahoo-finance2` and `@/services/india/yahoo`).
2. The Vitest test suite needs assertion coverage for all 13 known violation sites post-migration (currently only partial).

**ESLint rule to add (`eslint.config.mjs`):**

```js
{
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        {
          group: ["**/services/india/yahoo*"],
          importNames: ["*"],
          message: "Use registry.getQuotes() or registry.getHistoricalCandles() instead. See canonical-import-guard.ts."
        },
        {
          group: ["**/services/india/angelone*"],
          importNames: ["*"],
          message: "Use registry.getQuotes() etc. See canonical-import-guard.ts for documented exceptions."
        },
        {
          group: ["yahoo-finance2"],
          importNames: ["*"],
          message: "Use registry.getHistoricalCandles(). Direct Yahoo Finance access is prohibited outside the allowlist."
        }
      ]
    }]
  }
}
```

Allowlist files use `// eslint-disable-next-line no-restricted-imports` with a comment referencing `DATA_SERVICE_PRE_REFACTOR_AUDIT.md`.

---

## Data Models

### 3.1 New PostgreSQL Tables / Columns

**`data_provenance` table** (new — tracks provenance per historical fetch):

```sql
CREATE TABLE data_provenance (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider        TEXT NOT NULL,
  source_type     TEXT NOT NULL,   -- BROKER | OPEN_SOURCE | SECONDARY_FALLBACK | CACHE | DERIVED
  authenticated   BOOLEAN NOT NULL,
  credential_identity_hash  TEXT,  -- SHA-256 of credential identifier, never raw credential
  fetched_at      TIMESTAMPTZ NOT NULL,
  data_as_of      TIMESTAMPTZ,
  response_hash   TEXT,            -- SHA-256 of first 50KB of raw response body
  response_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  data_trust_status  TEXT NOT NULL,  -- TRUSTED | UNVERIFIED | DEGRADED | BLOCKED
  instrument_id   TEXT,
  interval_str    TEXT,
  from_ts         TIMESTAMPTZ,
  to_ts           TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_data_provenance_instrument ON data_provenance(instrument_id, fetched_at DESC);
CREATE INDEX idx_data_provenance_fetched ON data_provenance(fetched_at DESC);
```

**`data_reconciliation` table** (new — tracks cross-provider discrepancies):

```sql
CREATE TABLE data_reconciliation (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  instrument_id   TEXT NOT NULL,
  interval_str    TEXT,
  candle_time     TIMESTAMPTZ,
  provider_a      TEXT NOT NULL,
  provider_b      TEXT NOT NULL,
  field_name      TEXT NOT NULL,   -- "open" | "high" | "low" | "close" | "volume" | "ltp"
  value_a         NUMERIC,
  value_b         NUMERIC,
  deviation_pct   NUMERIC,         -- abs((a - b) / ((a+b)/2)) * 100
  status          TEXT NOT NULL,   -- CONFIRMED | MINOR_DISCREPANCY | MAJOR_DISCREPANCY
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reconciliation_instrument ON data_reconciliation(instrument_id, candle_time DESC);
```

**`historical_backfill_job` table** (new — tracks resumable backfill jobs):

```sql
CREATE TABLE historical_backfill_job (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  instrument_id   TEXT NOT NULL,
  exchange        TEXT NOT NULL,
  interval_str    TEXT NOT NULL,
  from_ts         TIMESTAMPTZ NOT NULL,
  to_ts           TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL,   -- PENDING | RUNNING | COMPLETED | FAILED | PARTIAL
  chunks_total    INTEGER,
  chunks_done     INTEGER NOT NULL DEFAULT 0,
  chunks_failed   INTEGER NOT NULL DEFAULT 0,
  last_checkpoint_ts TIMESTAMPTZ,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backfill_job_instrument ON historical_backfill_job(instrument_id, interval_str, status);
```

**`CandleBar` indexes to add** (existing table, additional composite index for ML window queries):

```sql
-- Existing unique index: (instrumentId, exchange, intervalStr, time)
-- Add covering index for time-descending window queries (ML feature engineering):
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_candle_bar_window
  ON "CandleBar"("instrumentId", exchange, "intervalStr", time DESC);

-- Existing index: (underlying, expiry, captureTimestamp) on OptionChainSnapshot
-- Add for latest-chain queries:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_option_chain_latest
  ON "OptionChainSnapshot"(underlying, expiry, "captureTimestamp" DESC);
```

### 3.2 Cache Key Schema

All keys are namespaced under the `md:` prefix (see `src/lib/market-data/cache/market-cache.ts`).

| Operation | L2 Redis Key Pattern | TTL |
|---|---|---|
| Single quote | `md:quote:{provider}:{SYMBOL}` | 3s |
| Batch quotes | `md:quotes-batch:{provider}:{SYM1,SYM2,...}` | 3s |
| Intraday candles | `md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}` | 30s |
| Daily+ candles | `md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}` | 4h |
| Option chain | `md:oc:{provider}:{underlying}:{expiry}` | 15s |
| Instrument master | `md:instruments:{provider}:{filterKey}` | 12h |
| Provider health | `md:health:{providerId}` | 5s |
| BackfillCheckpoint | `md:backfill:checkpoint:{symbol}:{exchange}:{interval}` | no TTL (persistent) |

---

## Data Flows

### 4.1 Standard Request Flow (Quotes, Historical, Option Chain)

```
Consumer
  │ await registry.getQuotes(["NIFTY", "RELIANCE"])
  │
  ▼
ProviderRegistry.getQuotes()
  │ providers = withCapability("liveQuotes")  → [ScraplingProvider, AngelOneProvider, UpstoxProvider, YahooProvider]
  │
  ▼
withFailover(providers, fn, "getQuotes", "liveQuotes")
  │
  ├─ Check L1 in-process cache → hit? return immediately
  │
  ├─ Check L2 Redis → hit? populate L1, return
  │
  ├─ Request coalescing: is key in pendingCalls?
  │    yes → await existing Promise
  │    no  → store new Promise in pendingCalls
  │
  ├─ isCapabilityCircuitOpen("scrapling", "liveQuotes")?
  │    yes → skip ScraplingProvider
  │    no  → ScraplingProvider.getQuotes(symbols)
  │           → HTTP GET data-service:8200/scraping/quotes?symbols=NIFTY,RELIANCE
  │           → normalize → validate → quality score → provenance stamp
  │
  ├─ On success:
  │    recordSuccess("scrapling", latencyMs, "liveQuotes")
  │    write L2 Redis (TTL 3s)
  │    write L1 in-process cache (TTL 3s)
  │    resolve pendingCalls Promise
  │    return MDQuote[] + DataProvenance
  │
  └─ On failure (MarketDataError thrown):
       recordFailure("scrapling", error.code, "liveQuotes")
       if MARKET_CLOSED → propagate, no failover
       if UNSUPPORTED_CAPABILITY → skip, no failure count
       if circuit opens → log PROVIDER_SWITCH(from="scrapling", to="angel_one", ...)
       try AngelOneProvider ...
       try UpstoxProvider ...
       try YahooProvider (only if fno: false applies) ...
       all fail → throw MarketDataError({ code: "PROVIDER_UNAVAILABLE" })
```

### 4.2 Historical Data Flow with Gap Recovery

```
registry.getHistoricalCandles({ symbol: "RELIANCE", interval: "5m", from: "2026-09-01", to: "2026-09-12" })
  │
  ▼
provider-capability-matrix.historyProvidersForSymbol("RELIANCE", "5m")
  → [ScraplingProvider, AngelOneProvider, UpstoxProvider]  (Yahoo excluded for intraday)
  │
  ▼
L3 PostgreSQL query: SELECT * FROM CandleBar WHERE instrumentId=... AND intervalStr="5m" AND time BETWEEN ...
  → cache hit: return immediately (no provider call)
  │
  └─ cache miss:
       ScraplingProvider → data-service /scraping/historical?symbol=RELIANCE&interval=5m
         → openchart adapter (Python) → normalize → validate → quality score
         → upsert CandleBar (idempotent on instrumentId+exchange+intervalStr+time)
         → write L2 Redis (TTL 30s)
         → gap detection: expectedBars vs receivedBars
           → if gaps detected: classify (EXPECTED_NO_DATA | MARKET_HOLIDAY | ACTUAL_DATA_GAP)
           → if ACTUAL_DATA_GAP: schedule recovery with Angel One
             → AngelOneProvider.getHistoricalCandles({ symbol, interval, from: gapStart, to: gapEnd })
             → upsert gap candles
             → record recovery in historical_backfill_job table
```

### 4.3 WebSocket Live Tick Flow

```
data-service (Python)
  │
  ├─ Angel One SmartStream WS connection (binary, little-endian frames)
  │     onTick → normalize to LiveTick → validate (LTP > 0, timestamp <= now+5s)
  │           → dedup check (same symbol+ltp+timestamp within 1s → drop)
  │           → PUBLISH af:ticks:{SYMBOL} (Redis pub/sub, lossy, real-time)
  │           → XADD af:stream:ticks (Redis Streams, durable AT_LEAST_ONCE)
  │
  └─ Upstox WS v3 Protobuf connection (binary, FeedResponse frames)
        onTick → decode via upstox-proto.py → normalize → validate → dedup → publish
  
TypeScript consumers:
  worker/src/jobs/scraping-tick-listener.ts
    SUBSCRIBE af:ticks:* → onMessage → candle builder → SignalData snapshot

API WebSocket:
  /v1/stream/quotes (Next.js WS route)
    SUBSCRIBE af:ticks:{symbol} → forward to browser client as JSON tick
```

### 4.4 Failover Sequence Diagram

```
Consumer          Registry          Scrapling     data-service    AngelOne     Upstox
   │                 │                  │               │             │           │
   │ getQuotes()     │                  │               │             │           │
   │────────────────>│                  │               │             │           │
   │                 │ ScraplingProvider│               │             │           │
   │                 │ .getQuotes()     │               │             │           │
   │                 │─────────────────>│               │             │           │
   │                 │                  │ GET /scraping/│             │           │
   │                 │                  │ quotes        │             │           │
   │                 │                  │──────────────>│             │           │
   │                 │                  │               │ NSE XHR     │           │
   │                 │                  │     503       │ failed      │           │
   │                 │                  │<──────────────│             │           │
   │                 │           MarketDataError         │            │           │
   │                 │<─────────────────│               │             │           │
   │                 │ recordFailure(scrapling)          │             │           │
   │                 │ emit PROVIDER_SWITCH(scrapling→angel_one)       │           │
   │                 │ AngelOne.getQuotes()              │             │           │
   │                 │──────────────────────────────────────────────>│           │
   │                 │                  │               │             │ SmartAPI  │
   │                 │                  │               │         MDQuote[]       │
   │                 │                  │               │<────────────│           │
   │                 │ normalize+validate+provenance     │             │           │
   │                 │ recordSuccess(angel_one)          │             │           │
   │                 │ write L2 Redis                    │             │           │
   │  MDQuote[]      │                  │               │             │           │
   │<────────────────│                  │               │             │           │
```

---

## Error Handling

### 5.1 Error Classification

Errors are classified at the boundary where they first occur. The classification drives retry behavior and circuit breaker updates.

| Error Code | HTTP Status | Retry? | Circuit Penalty | Notes |
|---|---|---|---|---|
| `AUTH_FAILURE` | 401/403 | No | -40 (hard block) | Immediate failover |
| `RATE_LIMITED` | 429 | Yes (backoff) | -15 | Honour `Retry-After` header |
| `PROVIDER_UNAVAILABLE` | 503 | Yes (backoff) | -40 | Standard backoff ladder |
| `PROVIDER_TIMEOUT` | — | Yes (1×) | -40 | Single retry then failover |
| `MARKET_CLOSED` | — | No failover | 0 | Propagate as-is |
| `UNSUPPORTED_CAPABILITY` | — | No failover | 0 | Skip provider silently |
| `EMPTY_DATA` | — | No retry | 0 | Holiday / off-hours |
| `INVALID_DATA` | — | No retry | -15 | Data quality failure |
| `DATA_GAP` | — | Schedule recovery | 0 | Not a provider failure |

### 5.2 Error Propagation Rules

1. Every consumer-facing error is a `MarketDataError` — never a plain `Error`.
2. `code`, `httpStatus`, and `retryAfterMs` are always populated (`retryAfterMs` is `null` when retry is not applicable).
3. `MARKET_CLOSED` and `UNSUPPORTED_CAPABILITY` are never treated as failures — they do not increment `consecutiveFailures` or decrement the circuit score.
4. Service-layer errors (e.g., option-strike-capture) re-throw `MarketDataError` preserving the original `code` — they never wrap in a generic `Error`.
5. The `withFailover()` engine emits a structured `PROVIDER_SWITCH` log at `WARN` level on every provider transition, including `from`, `to`, `reason`, `instrument`, `gapMs`, and `timestamp`.

### 5.3 10-Second Coalescing Timeout

If the upstream provider call that was triggered by request coalescing does not complete within 10 seconds, the pending call is cancelled and all waiters receive `MarketDataError({ code: "PROVIDER_TIMEOUT", retryAfterMs: null })`.

---

## Migration Approach

### 6.1 Migration Phases

The migration is **non-breaking and phased**. Each phase is independently deployable and tested before the next begins.

**Phase 1 — P1 Critical Violations (highest risk, must go first):**

| ID | File | Change | Risk |
|---|---|---|---|
| V-01 | `src/services/india/angelone/index.ts` | Remove internal Yahoo fallback in `getQuotes()` and `getHistorical()` | MEDIUM |
| V-02 | `src/services/india/scanner/engine.ts` | Replace `yahoo.getQuotes(FNO_STOCKS)` and `yahoo.getHistorical()` with registry calls | LOW |
| V-03 | `src/services/india/signals/snapshotter.ts` | Replace `yahoo.getQuotes(nseSymbols)` with `registry.getQuotes()` | LOW |

**Phase 2 — P2 Service Layer Violations:**

| ID | File | Change | Risk |
|---|---|---|---|
| V-04 | `src/lib/market-data/services/option-strike-capture.service.ts` | Replace dynamic angel import with `registry.getOptionChain()` | MEDIUM |
| V-05 | `src/lib/market-data/services/fno-backfill-runner.service.ts` | Replace dynamic angel import with `registry.getHistoricalCandles()` | MEDIUM |
| V-06 | `src/features/india/expiry-trades/builder.ts` | Replace `angel.getOptionChain("SENSEX")` with `registry.getOptionChain("SENSEX")` | LOW |

**Phase 3 — P3 Feature + API Route + Worker Violations:**

| ID | File | Change | Risk |
|---|---|---|---|
| V-07 | `src/features/india/fno-trend-history/service.ts` | `yahoo.getQuotes` → `registry.getQuotes` | LOW |
| V-08 | `src/features/india/scalping/backtest.ts` | `yahoo.getHistorical` → `registry.getHistoricalCandles` | LOW |
| V-09 | `src/features/india/scalping/strategies/positioning.ts` | `yahoo.getQuotes` → `registry.getQuotes` | LOW |
| V-10 | `src/features/india/scalping/strategies/opening-breakout.ts` | `yahoo.getHistorical` → `registry.getHistoricalCandles` | LOW |
| V-11 | `src/features/india/paper-trading/auto-trader.ts` | dynamic yahoo → `registry.getQuotes` | LOW |
| V-12 | `src/app/api/in/scalper/close-all/route.ts` | `yahoo.getQuotes` → `registry.getQuotes` | LOW |
| V-13 | `worker/src/jobs/india-realtime-candles.ts` | ScripMaster imports → `registry.getInstrumentMaster()` | LOW |

**Phase 4 — Import Guard and CI Enforcement:**

- Extend ESLint `no-restricted-imports` to cover `@/services/india/angelone` outside the allowlist.
- Complete the Vitest test suite in `canonical-import-guard.test.ts` to individually assert all 13 violation sites post-migration.
- Verify `npm run lint` and `npm test` both enforce the boundary.

### 6.2 Migration Pattern for Each Violation

**Pattern A — Yahoo quote replacement (V-02, V-03, V-07, V-09, V-11, V-12):**

```typescript
// Before:
import { yahoo } from "@/services/india/yahoo";
const quotes = await yahoo.getQuotes(symbols);

// After:
import { registry, bootstrapRegistry } from "@/lib/market-data/registry";
await bootstrapRegistry();
const quotes = await registry.getQuotes(symbols);
```

**Pattern B — Yahoo historical replacement (V-08, V-10):**

```typescript
// Before:
import { yahoo } from "@/services/india/yahoo";
const candles = await yahoo.getHistorical({ symbol, interval, from, to });

// After:
import { registry, bootstrapRegistry } from "@/lib/market-data/registry";
import type { HistoricalCandleRequest } from "@/lib/market-data/types";
await bootstrapRegistry();
const req: HistoricalCandleRequest = { symbol, exchange: "NSE", interval, from, to };
const candles = await registry.getHistoricalCandles(req);
```

**Pattern C — Angel option chain replacement (V-04, V-06):**

```typescript
// Before:
const { angel } = await import("@/services/india/angelone");
const chain = await angel.getOptionChain("SENSEX");

// After:
import { registry } from "@/lib/market-data/registry";
const chain = await registry.getOptionChain("SENSEX");
```

**Pattern D — Angel historical (V-05):**

```typescript
// Before:
const { angel } = await import("@/services/india/angelone");
const candles = await angel.getHistorical({ symbol, interval, from, to });

// After:
const candles = await registry.getHistoricalCandles(req);
```

**Pattern E — Angel ScripMaster → InstrumentMaster (V-13):**

```typescript
// Before:
import { getScripSubsets, buildEqTokenMap, INDEX_TOKENS } from "@/services/india/angelone";

// After:
import { registry } from "@/lib/market-data/registry";
const instruments = await registry.getInstrumentMaster({ exchange: "NSE", instrumentType: "EQ" });
// Filter out blank tokens:
const tokenMap = instruments
  .filter(i => i.token && i.token.trim() !== "")
  .map(i => ({ token: i.token, exchange: i.exchange as "NSE" }));
```

**Pattern F — Angel One adapter Yahoo fallback removal (V-01):**

```typescript
// Before in angelone/index.ts:
async getQuotes(symbols: string[]): Promise<MDQuote[]> {
  try {
    return await this.smartApiGetQuotes(symbols);
  } catch (e) {
    if (this.config.allowFallback) {
      return yahoo.getQuotes(symbols); // ← REMOVE THIS
    }
    throw e;
  }
}

// After:
async getQuotes(symbols: string[]): Promise<MDQuote[]> {
  // No internal fallback. Throw MarketDataError; withFailover() handles the rest.
  const result = await this.smartApiGetQuotes(symbols);
  return result;
  // Any failure throws MarketDataError — withFailover() will route to Upstox → Yahoo.
}
```

---

## Capability-Aware Provider Routing

### 7.1 Routing Matrix

The `provider-capability-matrix.ts` is the single source of truth for what each provider supports per dataset type and timeframe. Key routing rules:

| Dataset | Interval | Index Symbol? | Provider Order |
|---|---|---|---|
| Live equity quote | — | No | scrapling → angel_one → upstox → yahoo (delayed) |
| Live index quote | — | Yes | scrapling → upstox → (no Yahoo for indices) |
| Historical equity candles | 1m | No | angel_one → upstox v3 → openchart (via scrapling) |
| Historical equity candles | 5m–1h | No | angel_one → upstox v3 → openchart (via scrapling) |
| Historical **index** candles | 5m–1h | Yes | upstox v3 → openchart (Angel cannot serve index history) |
| Historical candles | 1d, 1w, 1M | — | scrapling/jugaad → angel_one → upstox → yahoo |
| Historical F&O OI | 1d | — | jugaad (via scrapling) ONLY — others UNSUPPORTED |
| Option chain | — | — | scrapling → angel_one → upstox (Yahoo NEVER) |
| Instrument master | — | — | scrapling → angel_one (Upstox, Yahoo: UNSUPPORTED) |
| Historical candles | **3m** | — | **BLOCKED** — raise error, no provider called |

**CRITICAL RULE:** `UNSUPPORTED_CAPABILITY` is never treated as `PROVIDER_FAILURE`. The routing engine skips a provider for a dataset it doesn't support without recording any health penalty.

### 7.2 Index Symbol Detection

```typescript
// provider-capability-matrix.ts (already implemented)
function isIndexSymbol(symbol: string): boolean {
  return ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].includes(symbol.toUpperCase());
}
```

When `isIndexSymbol(symbol) && interval !== "1d"`:
- Angel One is skipped (UNSUPPORTED_CAPABILITY for index intraday history)
- Upstox v3 is the first live provider attempt

---

## Per-Capability Circuit Breaker

### 8.1 Health Score State Machine

The circuit breaker in `src/lib/market-data/health.ts` is **already implemented** per the required rules. The key invariants:

```
Initial:     score = 100, circuitOpen = false
Per failure: score -= min(40, 40 × (1 + consecutiveFailures * 0.1))  // progressive
             +auth failure: score -= 25 additionally
             floor: score = max(0, score)
Per success: score += 10; score = min(100, score)
             consecutiveFailures = 0

Circuit opens:  score < 20
Circuit closes: after 30s, one probe request succeeds

Capability-aware: "angel_one::historical" circuit is independent of "angel_one::liveQuotes"
```

### 8.2 Half-Open Probe Semantics

```
circuit opens (score < 20)
  │
  ├─ CIRCUIT_RETRY_MS = 30s elapsed?
  │    no  → reject all requests (circuit open)
  │    yes → allow exactly ONE probe request (half-open)
  │
  ├─ probe succeeds → score = 20, circuit closed, HALF_OPEN → CLOSED transition logged
  │
  └─ probe fails → circuit re-opens, circuitRetryAt = now + min(nextRetryMs, 5min cap)
```

### 8.3 Capability-Aware Routing

A capability circuit failure does NOT affect other capabilities of the same provider:

```
angel_one::historical opens  →  historical routes to upstox (or scrapling)
angel_one::liveQuotes OK     →  live quotes still use angel_one

vs.

angel_one provider-wide circuit opens  →  ALL angel_one capabilities blocked
```

---

## Immutable Data Provenance

### 9.1 Provenance Stamping

Every response returned by the registry carries a `DataProvenance` object. The stamping happens in `withFailover()` after a successful provider call:

```typescript
// Added to withFailover() success path:
const provenance: DataProvenance = {
  provider: provider.id,
  providerType: resolveProviderType(provider.id),
  authenticated: isAuthenticated(provider.id),
  requestedAt: new Date().toISOString(),
  dataAsOf: result.fetchedAt ?? new Date().toISOString(),
  isLive: operation === "getQuotes" || operation === "getLatestQuote",
  isHistorical: operation === "getHistoricalCandles",
  freshness: computeFreshness(result.fetchedAt),
  quality: computeQualityScore(result, operation),
  sourceChain: [provider.id],
};
```

**Freshness classification:**
- `LIVE`: data age ≤ 5 seconds
- `RECENT`: 6–60 seconds
- `STALE`: 61 seconds–24 hours
- `HISTORICAL`: > 24 hours

**Cache hit provenance:** When data is served from L1/L2 cache, `providerType` is `"CACHE"` and the original provider is recorded in `sourceChain[0]`.

### 9.2 DataProvenanceRecord Persistence

For every historical candle fetch (not live quotes), a `DataProvenanceRecord` is written to the `data_provenance` table:

```typescript
async function persistProvenance(
  provider: ProviderId,
  req: HistoricalCandleRequest,
  rawResponseBody: string,
  authenticated: boolean,
): Promise<void> {
  const bodySlice = rawResponseBody.slice(0, 50 * 1024); // first 50 KB
  const responseHash = sha256(bodySlice);
  const credHash = sha256(resolveCredentialIdentifier(provider)); // never raw credential

  await db.data_provenance.create({
    data: {
      provider,
      source_type: resolveProviderType(provider),
      authenticated,
      credential_identity_hash: credHash,
      fetched_at: new Date(),
      response_hash: responseHash,
      response_truncated: rawResponseBody.length > 50 * 1024,
      data_trust_status: "TRUSTED",
      instrument_id: req.symbol,
      interval_str: req.interval,
      from_ts: new Date(req.from),
      to_ts: new Date(req.to),
    },
  });
}
```

### 9.3 Forensics Endpoint

`GET /api/in/data/forensics/:tradeId` returns the complete data-to-trade chain:

```json
{
  "tradeId": "...",
  "paperTrade": { ... },
  "signalRecord": { ... },
  "dataProvenanceRecord": {
    "provider": "angel_one",
    "source_type": "BROKER",
    "fetched_at": "2026-09-12T09:30:15Z",
    "data_trust_status": "TRUSTED",
    "response_hash": "sha256:...",
    "instrument_id": "NIFTY",
    "interval_str": "5m"
  },
  "lineageEntry": { ... },
  "qualityAtSignalTime": { "score": 92, "grade": "A" }
}
```

---

## Data Validation Pipeline

### 10.1 9-Step Pipeline (Python data-service, also enforced in TypeScript normalizer)

Every provider response passes through these steps **in order** before reaching consumers:

```
Step 1: Schema validation (Pydantic Python / Zod TypeScript)
         → reject malformed responses early; classify as INVALID_DATA

Step 2: Timestamp normalization
         → all timestamps → UTC epoch ms
         → NSE timestamps (Asia/Kolkata +05:30) converted to UTC
         → candle time = bar OPEN time, not close time

Step 3: OHLC validation
         → high >= max(open, close)     — else DROP; record in invalidCount
         → low  <= min(open, close)     — else DROP; record in invalidCount
         → high >= low                  — else DROP
         → all prices > 0              — else DROP
         → no NaN, no Infinity         — else DROP
         RULE: never coerce; always drop invalid candles

Step 4: Future timestamp guard
         → if candle.time > Date.now() + 5000ms → DROP (classify INVALID_DATA)
         → if tick.timestamp > now + 5000ms → DROP, never publish to Redis

Step 5: Duplicate detection
         → key = (instrumentId, exchange, intervalStr, time)
         → duplicate → keep first, drop subsequent; log dedup count

Step 6: Gap detection
         → compute expectedBars(interval, from, to)
         → gapCount = expectedBars - receivedBars (excluding holidays)
         → if gapCount / expectedBars > 20% → quality grade = DEGRADED

Step 7: Cross-provider reconciliation (when 2+ providers return same data)
         → for each overlapping candle: compute abs deviation per field
         → deviation > 0.5% on any field → flag RECONCILIATION_CONFLICT
         → RECONCILIATION_CONFLICT candles excluded from output
         → discrepancy recorded in data_reconciliation table
         → fewer than 2 providers → skip reconciliation (UNRECONCILED)

Step 8: Spike detection
         → abs(close - prev_close) / prev_close > 0.20 → suspicious: true
         → DO NOT drop suspicious candles (circuit limit moves are legitimate)
         → if no previous bar exists (first candle) → skip spike check

Step 9: Quality scoring + provenance stamping
         → score = 0.25×completeness + 0.25×freshness + 0.25×accuracy + 0.15×consistency + 0.10×provider_reliability
         → grade: A+(95–100), A(85–94), B(70–84), C(50–69), D(30–49), BLOCKED(<30)
         → BLOCKED → DataProvenance.quality.validationStatus = "FAILED"
         → signal engine MUST honor BLOCKED as hard stop
```

### 10.2 Tick Validation (Redis pub/sub)

```
Incoming tick from broker WS:
  → ltp <= 0? → DROP; increment validation_failures["negative_ltp"]
  → timestamp > now + 5000ms? → DROP; increment validation_failures["future_timestamp"]
  → duplicate (symbol+ltp+timestamp within 1s)? → DROP; increment dedup_count
  → publish to af:ticks:{SYMBOL} and af:stream:ticks
```

---

## Historical Engine — Resumable Backfill

### 11.1 BackfillCheckpoint

```typescript
interface BackfillCheckpoint {
  symbol: string;
  exchange: Exchange;
  interval: Interval;
  lastWrittenCandleTime: number; // UTC epoch ms
  updatedAt: string;             // ISO-8601 UTC
}

// Storage: Redis key md:backfill:checkpoint:{symbol}:{exchange}:{interval}
// Fallback: historical_backfill_job table last_checkpoint_ts column
```

### 11.2 Chunk Processing

```
BackfillJob (symbol, exchange, interval, from, to)
  │
  ├─ load checkpoint from Redis (or from PostgreSQL if Redis unavailable)
  │    checkpoint exists → resume from lastWrittenCandleTime
  │    no checkpoint    → start from configured start date for instrument class
  │
  ├─ split range into chunks:
  │    1m   → max 30 days per chunk (Angel One limit)
  │    5m–1h → max 60 days per chunk
  │    Upstox v3 → max 100 days per chunk
  │
  ├─ for each chunk (max 3 concurrent provider calls):
  │    try provider.getHistoricalCandles(chunk)
  │    on success:
  │      normalize → validate → deduplicate → upsert CandleBar (idempotent)
  │      update checkpoint in Redis
  │    on failure:
  │      exponential backoff (500ms base, 2×, ±20% jitter, 30s max)
  │      after 5 consecutive chunk failures → mark chunk FAILED
  │      log in historical_backfill_job, advance to next chunk
  │
  ├─ gap detection after all chunks complete:
  │    query CandleBar for written range
  │    compare with expectedBars(interval, from, to)
  │    classify gaps: EXPECTED_NO_DATA | MARKET_HOLIDAY | ACTUAL_DATA_GAP | PENDING_RECOVERY
  │
  └─ for ACTUAL_DATA_GAP with a capable alternative provider:
       schedule gap-recovery attempt
       if recovery succeeds → upsert gap candles; update job status
       if no capable provider → reclassify as PROVIDER_UNAVAILABLE; record without retry
```

---

## WebSocket Aggregation

### 12.1 data-service Owns All Upstream WS Connections

The Python `data-service` is the **sole** owner of:
- Angel One SmartStream WS connection
- Upstox v3 Protobuf WS connection

No TypeScript service, worker, or Next.js route may establish a direct broker WS connection.

### 12.2 Reconnection Policy

```
WS connection lost
  │
  ├─ attempt reconnect (exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s → 60s, max 10 attempts)
  │    before each attempt: publish {"type": "reconnect"} to affected af:ticks:{symbol} channels
  │
  ├─ reconnect succeeds → resume tick publishing; log WARN with attempt count
  │
  └─ 10 consecutive failures → stop retrying
       publish {"type": "connection_failed"} to affected channels
       data-service marks capability as UNAVAILABLE in /health/providers
```

### 12.3 Publisher Status

`GET /publisher/status`:

```json
{
  "running": true,
  "subscribedSymbols": ["NIFTY", "BANKNIFTY", "RELIANCE"],
  "ticksPublished": 14271,
  "validationFailures": {
    "negative_ltp": 0,
    "future_timestamp": 3,
    "duplicate": 47
  },
  "lastPublishedAt": 1726130415234
}
```

---

## F&O Universe — Dynamic and Point-in-Time Aware

### 13.1 Universe Lifecycle

```
Every 24h (or on manual refresh):
  1. Fetch instrument master from Angel One + Upstox (merged, deduped by ISIN)
  2. Filter F&O-eligible: instrumentType IN ("FUTIDX", "FUTSTK", "OPTIDX", "OPTSTK")
  3. Track lifecycle per symbol: ACTIVE | ADDED | REMOVED | SUSPENDED | UNRESOLVED
  4. Sort active symbols alphabetically
  5. Compute SHA-256 checksum = sha256(sortedActiveSymbols.join(","))
  6. If checksum differs from last snapshot → create new FnoUniverseSnapshot record
     with effectiveFrom = now, set previous snapshot effectiveTo = now
  7. Never hardcode the symbol list
```

### 13.2 Point-in-Time Queries (Backtesting)

```
getUniverseForDate(date: string):
  SELECT * FROM fno_universe_snapshots
  WHERE effective_from <= date
    AND (effective_to IS NULL OR effective_to > date)
  ORDER BY effective_from DESC
  LIMIT 1

→ if no row: return error "No universe data for {date}"
→ removed symbols with removedAt <= date are excluded from the snapshot
```

### 13.3 Checksum Determinism

The checksum is deterministic: the **same set of symbols in any order always produces the same checksum** because symbols are sorted before hashing.

```python
checksum = hashlib.sha256(",".join(sorted(active_symbols)).encode()).hexdigest()
```

---

## Secure Credential Management

### 14.1 Credential Storage Rules

| Credential | Allowed Storage | Forbidden Storage |
|---|---|---|
| `SMARTAPI_CLIENT_CODE` | Environment variable only | Database, Redis, logs, API responses |
| `SMARTAPI_PIN` | Environment variable only | Same |
| `SMARTAPI_TOTP_SECRET` | Environment variable only | Same |
| `UPSTOX_CLIENT_SECRET` | Environment variable only | Same |
| `UPSTOX_ACCESS_TOKEN` | Node.js process memory only | Database, Redis, cookies, browser, logs |
| User API keys (per-user) | `UserSetting.apiKeysEncrypted` (AES-256-GCM) | Plain text DB, Redis |

### 14.2 Security Invariants

1. **No `NEXT_PUBLIC_*` for credentials** — any build-time scan finding a `NEXT_PUBLIC_SMARTAPI_*`, `NEXT_PUBLIC_UPSTOX_*`, or similar credential in environment variables terminates the build with non-zero exit.
2. **Credential identity hash only** — `DataProvenanceRecord.credential_identity_hash` is `sha256(SMARTAPI_CLIENT_CODE)` for Angel One, `sha256(UPSTOX_CLIENT_SECRET)` for Upstox. Never the credential value.
3. **Error logs include only provider ID and error code** — never the credential value, a prefix/suffix of it, a Base64 encoding, or any other derived representation.
4. **data-service Python** — credentials are retrieved from environment variables only; the service never accepts credentials via HTTP request bodies or query parameters.
5. **CORS** — `data-service` Python only accepts requests from `localhost:3000`; it never exposes a public endpoint.

---

## Performance SLOs

### 15.1 Targets

| Operation | Cache Level | SLO p95 |
|---|---|---|
| Cached quote (L1 hit) | L1 in-process | < 1ms |
| Cached quote (L2 hit) | Redis | < 20ms |
| Historical candle (L2 hit) | Redis | < 50ms |
| Historical range (L3 PostgreSQL) | DB | < 100ms |
| Live quote (provider call) | Provider | < 2000ms |
| Option chain (provider call) | Provider | < 3000ms |

### 15.2 SLO Breach Logging

When a measured operation latency exceeds 2× its SLO target:

```typescript
mdLog("SLO_BREACH", {
  operation: "getQuotes",
  latencyMs: 4100,
  sloMs: 2000,
  provider: "angel_one",
});
```

### 15.3 Load Test Requirements

The performance report must be sourced from a load test meeting these criteria:
- 1000 concurrent `registry.getQuotes(["NIFTY"])` calls after a 10-request warm-up
- Minimum 60-second test duration
- Warm cache (L1/L2 populated)
- Measured p50/p95/p99 latency, not estimated
- Environment and tool specified in `DATA_SERVICE_PERFORMANCE_REPORT.md`

---

## 3m Timeframe Complete Eradication

### 16.1 Enforcement Points

| Layer | Mechanism | Current Status |
|---|---|---|
| TypeScript `Interval` type | `"3m"` absent from union type | ✅ Done |
| `SUPPORTED_TIMEFRAMES` constant | Does not include `"3m"` | ✅ Done |
| `isSupportedInterval("3m")` | Returns `false` | ✅ Done |
| Python `SUPPORTED_INTERVALS` | `"3m"` absent from frozenset | ✅ Done |
| Python `validate_interval("3m")` | Raises `ValueError` | ✅ Done |
| Python `acquisition_planner.py` | `"3m"` raises `ValueError` | ✅ Done |
| ML `validate_canonical_data_v8` | Returns `BLOCKED` for 3m | ✅ Done |
| `v8-signal-data-gate.service.ts` | Returns `BLOCKED` for `interval === "3m"` | ✅ Done |
| API endpoints (all `interval` params) | Return HTTP 400 for `interval=3m` | ✅ Done (via `assertSupportedInterval`) |
| `prisma/schema.prisma` | No `"3m"` examples in comments | 🔧 Verify |
| Codebase string scan | No `"3m"` literal except V8 past-tense historical comments | 🔧 Verify post-migration |

### 16.2 Allowed Residual References

A `"3m"` string literal is permitted ONLY in comments that **simultaneously** satisfy:
- Use past tense (`"was removed"`, `"is no longer supported"`)
- Explicitly reference `"V8"`

All other `"3m"` occurrences in `src/`, `worker/src/`, `data-service/src/`, or `ml-service/src/` are violations.

---

## Certification Reports

### 17.1 Reports Required

After migration is complete, these documents must be updated to reflect the post-refactor state:

| Report | Key Updates Required |
|---|---|
| `DATA_SERVICE_PRE_REFACTOR_AUDIT.md` | Mark all 13 violation sites as MIGRATED with passing test references |
| `DATA_SERVICE_TEST_PLAN.md` | All tests listed with PASS/FAIL/SKIP status (no pending) |
| `DATA_SERVICE_ARCHITECTURE.md` | Already updated for v9.0 (this document feeds into it) |
| `DATA_SERVICE_API.md` | Confirm all endpoints match code; no 3m in examples |
| `DATA_SERVICE_MIGRATION_REPORT.md` | Before/after state for each of 13 sites with test evidence |
| `DATA_SERVICE_PERFORMANCE_REPORT.md` | Actual measured p50/p95/p99 from load test (not estimated) |
| `DATA_SERVICE_FINAL_CERTIFICATION.md` | Issue LEVEL 3 only after all 7 certification conditions verified |

### 17.2 LEVEL 3 Certification Conditions

`DATA_SERVICE_FINAL_CERTIFICATION.md` is issued at LEVEL 3 only when ALL of the following are true:

1. Zero violation sites remain — static analysis (ESLint lint + canonical-import-guard.test.ts) produces zero findings.
2. All 13 migration tests pass.
3. The Canonical_Import_Guard reports zero violations.
4. `"3m"` is absent — codebase grep on `src/`, `worker/src/`, `data-service/src/`, `ml-service/src/` returns zero matches outside permitted past-tense V8 comments.
5. All SLOs measured under load meet minimum: p99 ≤ 2000ms and p50 ≤ 500ms.
6. `POST /data/gate` returns a gated response (HTTP 4xx with quality-failure indicator) when invoked with a known-invalid payload from the TypeScript signal engine integration path.
7. The certification document explicitly states git commit hash, test run date, pass/fail counts, load profile (request rate + duration), measurement tool, and environment.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Angel One Adapter Error Propagation

*For any* failure mode from the SmartAPI (network error, HTTP non-2xx, `status === false`, timeout), the Angel One adapter SHALL throw a `MarketDataError` with a non-null `code` field, and SHALL NOT make any call to the Yahoo provider internally — provider failover is exclusively the responsibility of `withFailover()`.

**Validates: Requirements 2.1, 2.2, 2.3, 10.1**

---

### Property 2: Registry Failover Health Tracking

*For any* `MarketDataError` thrown by any provider during `withFailover()` execution, the failing provider's `consecutiveFailures` count SHALL increment by exactly 1, and a `PROVIDER_SWITCH` log record SHALL be emitted before the next provider is attempted.

**Validates: Requirements 2.5, 12.7, 15.6**

---

### Property 3: Signal Snapshotter Fault Tolerance

*For any* list of symbols processed by the signal snapshotter where a subset of registry calls returns `null` or throws a `MarketDataError`, the snapshotter SHALL: (a) produce a `PROVIDER_UNAVAILABLE` entry for every null-returning symbol, (b) produce a valid entry for every symbol that succeeded, and (c) never abort early — all symbols are processed regardless of individual failures.

**Validates: Requirements 4.2, 4.3, 4.4**

---

### Property 4: MarketDataError Preservation Through Service Layers

*For any* `MarketDataError` with any valid `code` thrown by `registry.getOptionChain()` or `registry.getHistoricalCandles()`, every service layer that catches it (option-strike-capture, backfill-runner, expiry-trades-builder) SHALL re-throw a `MarketDataError` whose `code` equals the original `code` — neither wrapped in a plain `Error` nor re-classified.

**Validates: Requirements 5.3, 6.4, 7.3, 10.6**

---

### Property 5: CandleBar Upsert Idempotence

*For any* set of `OHLCVCandle` records, calling the bulk upsert to `CandleBar` once or any number of times with the same data SHALL result in exactly one database row per unique `(instrumentId, exchange, intervalStr, time)` tuple — no duplicates, no data loss from re-runs.

**Validates: Requirements 6.2, 18.8**

---

### Property 6: Request Coalescing

*For any* number N ≥ 2 of concurrent calls to `registry.getQuotes()` with the same symbol list before the upstream provider call for that key completes, the upstream provider SHALL be called exactly once, and all N callers SHALL receive the same result.

**Validates: Requirements 14.4**

---

### Property 7: Circuit Breaker Score Invariants

*For any* sequence of provider failures and successes, the health score SHALL satisfy these invariants simultaneously:
- Score is always in [0, 100]
- After N consecutive failures from score 100: score ≤ max(0, 100 - 40N)
- After any success: score increases by exactly 10 (capped at 100)
- Score < 20 implies `circuitOpen === true`
- `circuitOpen === true` AND 30s elapsed implies one probe request is allowed

**Validates: Requirements 15.1, 15.2, 15.3**

---

### Property 8: OHLC Validation — Invalid Candles Are Dropped, Never Coerced

*For any* batch of candles from any provider, the validation pipeline SHALL pass through only those candles where `high >= max(open, close)` AND `low <= min(open, close)` AND `high >= low` AND all prices > 0 AND timestamp ≤ now + 5s. Candles failing any condition SHALL be counted in `invalidCount` and excluded from the output. No invalid field SHALL be silently corrected.

**Validates: Requirements 17.2, 17.3**

---

### Property 9: Tick Stream Filtering — Only Valid Ticks Published

*For any* stream of raw ticks received from broker WebSockets containing a mix of valid and invalid ticks (negative LTP, future timestamps, duplicates within 1s), only ticks that are valid AND non-duplicate SHALL be published to Redis pub/sub. Invalid or duplicate ticks SHALL be counted per-reason in `validationFailures` and never appear on `af:ticks:{SYMBOL}`.

**Validates: Requirements 19.2, 19.3**

---

### Property 10: F&O Universe Checksum Determinism

*For any* set of active F&O symbols regardless of the order in which they are supplied, the SHA-256 checksum computed by `F&O_Universe_Service` SHALL be identical — same symbols always produce the same checksum.

**Validates: Requirements 20.2**

---

### Property 11: Provenance Completeness

*For any* successful response returned by `registry.getQuotes()`, `registry.getHistoricalCandles()`, or `registry.getOptionChain()`, the response SHALL carry a `DataProvenance` object with non-null `provider`, `dataAsOf`, `isLive`, `quality.score`, and `quality.grade` fields. When the response is served from cache (L1 or L2), `providerType` SHALL equal `"CACHE"`.

**Validates: Requirements 12.2, 12.3, 16.1, 16.4**

---

### Property 12: 3m Interval Universal Rejection

*For any* API endpoint that accepts an `interval` or `timeframe` parameter, supplying `interval=3m` SHALL result in: a rejection (HTTP 400 or thrown `MarketDataError`) WITHOUT calling any provider. No provider's circuit breaker state is affected by a 3m rejection.

**Validates: Requirements 11.5, 13.3**

---

## Testing Strategy

### Unit and Integration Tests

Unit tests focus on specific examples, boundary conditions, and error cases:

- Import guard: one test per violation site (13 tests), each asserting the file no longer contains the forbidden import pattern.
- `SUPPORTED_TIMEFRAMES` equality check.
- `PROVIDER_PRIORITY` membership checks (excludes `"nse"`, `"3m"`).
- `isSupportedInterval("3m")` returns `false`.
- Each service layer (snapshotter, backfill-runner, option-strike-capture, expiry-trades) has a test for the success path and a test for the error propagation path.
- API route tests (route handlers) verify HTTP 400 is returned for `interval=3m`.

### Property-Based Tests

Property-based tests use [fast-check](https://github.com/dubzzz/fast-check) (TypeScript) and [Hypothesis](https://hypothesis.readthedocs.io/) (Python), each property running a minimum of 100 iterations.

Each test is tagged with:

```typescript
// Feature: data-service-centralization, Property N: <property_text>
```

| Property | Test Location | Generator |
|---|---|---|
| P1: Angel adapter error propagation | `tests/services/india/angelone/adapter-errors.test.ts` | Arbitrary HTTP status codes + error shapes |
| P2: Registry failover health tracking | `tests/lib/market-data/failover-health.test.ts` | Arbitrary error sequences |
| P3: Snapshotter fault tolerance | `tests/services/india/signals/snapshotter.test.ts` | Arbitrary symbol lists with random null/throw ratios |
| P4: MarketDataError preservation | `tests/lib/market-data/error-preservation.test.ts` | Arbitrary `MarketDataErrorCode` values |
| P5: CandleBar upsert idempotence | `tests/lib/market-data/candle-upsert.test.ts` | Arbitrary OHLCVCandle arrays with random duplicates |
| P6: Request coalescing | `tests/lib/market-data/coalescing.test.ts` | N = 2–100 concurrent calls |
| P7: Circuit breaker score invariants | `tests/lib/market-data/circuit-breaker.test.ts` | Arbitrary failure/success sequences |
| P8: OHLC validation pipeline | `tests/lib/market-data/validation-pipeline.test.ts` | Arbitrary OHLCV with random invalid fields |
| P9: Tick stream filtering | `data-service/tests/test_tick_validation.py` | Arbitrary tick streams with random invalid entries |
| P10: F&O universe checksum | `data-service/tests/test_universe.py` | Arbitrary symbol sets in arbitrary orders |
| P11: Provenance completeness | `tests/lib/market-data/provenance.test.ts` | Arbitrary provider + response combinations |
| P12: 3m universal rejection | `tests/lib/market-data/interval-rejection.test.ts` | Parameterized over all API entry points |

---

## Security Considerations

1. **Credential never in output** — `GET /api/data/providers/health` returns only lifecycle states and latency metrics. Any field whose name or value matches a credential pattern is excluded at the serialization layer.
2. **AES-256-GCM for per-user keys** — user-provided Upstox analytics tokens and Angel One credentials stored via `src/lib/crypto.ts`. The 32-byte encryption key is from `ENCRYPTION_KEY` env var only.
3. **`NEXT_PUBLIC_*` build guard** — a build-time check (via `next.config.ts` or CI script) asserts that no `NEXT_PUBLIC_SMARTAPI_*`, `NEXT_PUBLIC_UPSTOX_*`, `NEXT_PUBLIC_ENCRYPTION_*` variable is set.
4. **data-service CORS restriction** — `data-service` sets `allow_origins=["http://localhost:3000"]` in its FastAPI CORS middleware. It is never publicly accessible.
5. **No credentials via HTTP** — `data-service` reads all credentials from `os.environ` at startup. No HTTP endpoint accepts a credential value in a request body or query parameter.
6. **Credential identity hash** — `DataProvenanceRecord.credential_identity_hash` is `sha256(identifier)` where `identifier` is the credential key name (e.g., `SMARTAPI_CLIENT_CODE`), never the value.
