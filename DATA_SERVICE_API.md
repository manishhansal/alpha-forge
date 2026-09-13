# DATA SERVICE API
**AlphaForge — Canonical Data-Service API Contract**
**Version:** v9.0
**Date:** 2026-09-12

---

## BASE URLS

| Service | URL |
|---|---|
| TypeScript Next.js API | `http://localhost:3000/api/` |
| Python data-service | `http://localhost:8200/` (or `DATA_SERVICE_URL` env var) |

All responses use JSON. Timestamps are ISO-8601 UTC strings. Prices are INR.
`"3m"` is not a valid interval anywhere in the system — any endpoint that accepts
an `interval` or `timeframe` parameter returns HTTP 400 for `interval=3m`.

---

## 1. PYTHON DATA-SERVICE ENDPOINTS (port 8200)

These are internal service-to-service endpoints. The TypeScript `ScraplingProvider`
wraps them — consumers never call these directly.

### 1.1 Core Health

```
GET /health
→ {
    status: "healthy" | "degraded",
    service: "data-service",
    version: "0.1.0",
    timestamp: string,    // ISO-8601 UTC
    components?: {        // only present when degraded
      [componentName]: string   // failure reason
    }
  }
```

Always returns HTTP 200 — Docker healthchecks never block on this endpoint.

```
GET /scraping/status
→ {
    available: true,
    version: "2.0.0",
    capabilities: {
      chromium_available: boolean,
      redis_connected: boolean,
      proxy_available: boolean,
      live_quotes: boolean,
      option_chain_nse: boolean,
      option_chain_bse: boolean,
      historical_daily: boolean,
      historical_intraday: boolean,
      instrument_master: boolean,
      tick_publisher: boolean,
      redis_streams: boolean,
      data_lineage: boolean,
      candle_builder: boolean
    },
    config: {
      active_symbol_count: number,
      nse_rate_limit: number,
      bse_rate_limit: number,
      proxy_enabled: boolean,
      headless: boolean,
      data_dir: string
    },
    dataServiceV2: {
      semanticIntegrityFixed: boolean,
      oiNotMappedToTradedValue: boolean,
      connectionPoolingEnabled: boolean,
      redisStreamsEnabled: boolean,
      deduplicationEnabled: boolean,
      lineageTrackingEnabled: boolean
    }
  }
```

### 1.2 Liveness, Readiness, and Capability Health

```
GET /health/live
→ 200 { status: "alive", service, version, uptimeMs, timestamp }

GET /health/ready
→ 200 (all ready) or 503 (critical dependency down)
→ {
    status: "READY" | "DEGRADED",
    capabilities: {
      redis: "READY" | "UNAVAILABLE",
      tick_publisher: "READY" | "UNAVAILABLE",
      quotes: "READY" | "DEGRADED",
      option_chain: "READY" | "DEGRADED",
      historical: "READY"
    },
    issues: { [componentName]: string },   // only populated when there are issues
    timestamp: string
  }

GET /health/providers
→ 200 {
    status: "HEALTHY" | "DEGRADED",
    providers: {
      scrapling: {
        live: { status, circuitState, errorRate, totalRequests, lastFailureReason, latencyP50Ms?, latencyP99Ms? },
        historical: { ... },
        option_chain: { ... }
      },
      upstox: {
        live: { ... },
        historical: { ... }
      },
      yahoo: {
        historical: { ... }
      }
    },
    timestamp: string
  }

GET /health/data
→ 200 {
    status: "DATA_AVAILABLE",
    session: { ... },      // current market session info
    quoteStats: { p50Ms, p99Ms, successRate },
    gaps: Array<{ instrumentId, gapDurationMs, severity }>,
    duplicateRate: number,
    circuitBreakers: { [name]: { state, failureRate } },
    clockSkewMs: number,
    clockDegraded: boolean,
    timestamp: string
  }
```

### 1.3 Historical Data

```
GET /scraping/historical
  ?symbol=RELIANCE
  &interval=5m           // one of: 1m, 5m, 10m, 15m, 30m, 1h, 1d, 1w, 1M
  &from=2026-09-01       // YYYY-MM-DD
  &to=2026-09-12
→ {
    data: OHLCVCandle[],
    metadata: {
      symbol, exchange, interval, from, to,
      provider: "openchart" | "jugaad" | "upstox_py",
      provenance: "OPEN_SOURCE_HISTORICAL" | "BROKER_AUTHENTICATED",
      quality: { score, grade, completeness, gaps },
      dataAsOf: string,
      requestedAt: string
    }
  }

REJECTED interval values: "3m" → HTTP 400 "interval 3m is not supported"
```

### 1.4 Live Quotes

```
GET /scraping/quotes
  ?symbols=RELIANCE,INFY,NIFTY
→ {
    data: {
      [symbol]: {
        ltp, change, changePct, volume, oi?,
        bid?, ask?, vwap?,
        timestamp, exchange
      }
    },
    metadata: {
      provider, provenance,
      dataAsOf, marketStatus: "OPEN" | "CLOSED"
    }
  }
```

### 1.5 Option Chains

```
GET /scraping/option-chain
  ?underlying=NIFTY&expiry=2026-09-26
→ {
    symbol, spot, expiry,
    expiries: string[],
    rows: Array<{
      strike,
      ce: { ltp, oi, oiChange, volume, iv?, bid?, ask? } | null,
      pe: { ltp, oi, oiChange, volume, iv?, bid?, ask? } | null
    }>,
    analytics: { pcr, maxPain, atmIv?, totalCeOi, totalPeOi },
    metadata: { provider, provenance, quality, dataAsOf, marketStatus }
  }

Off-hours: returns empty rows[], marketStatus: "CLOSED" — NOT an error.
```

### 1.6 Instrument Master

```
GET /scraping/instruments
  ?exchange=NSE&instrumentType=EQ
→ {
    data: Instrument[],
    metadata: { provider, count, asOf }
  }

GET /scraping/instruments/fno-universe
→ {
    universe: string[],        // canonical NSE F&O equity symbols
    effectiveFrom, effectiveTo, source, version, checksum
  }
```

### 1.7 Data Quality Gate

```
POST /data/gate
  Body: {
    symbol: string,
    quoteAgeMs: number,
    completenessPercent?: number,    // 0.0–1.0, default 1.0
    timestampValid?: boolean,        // default true
    crossSourceAgreement?: number,   // 0.0–1.0, default 1.0
    sequenceIntegrity?: boolean,     // default true
    strategyId?: string,
    maxQuoteAgeMs?: number,
    minConfidenceScore?: number,
    requiresOI?: boolean,
    requiresOptionChain?: boolean,
    requiresConfirmedCandle?: boolean,
    oiAvailable?: boolean,
    optionChainAvailable?: boolean,
    candleConfirmed?: boolean
  }
→ {
    signalEngineAllowed: boolean,
    confidenceScore: number,
    quality: string,
    quoteAgeMs: number,
    gates: {
      dataFresh, dataComplete, dataTimestampValid,
      dataProviderHealthy, dataSemanticallyValid
    },
    blockReasons: string[] | null,
    circuitBreakers: { [name]: string },
    evaluatedAt: string
  }

→ HTTP 4xx with blockReasons when gate fails (signalEngineAllowed: false)

GET /data/gate/:symbol
  ?quote_age_ms=5000&strategy_id=oi_scalper
→ {
    symbol, signalEngineAllowed, confidenceScore, quality,
    quoteAgeMs, blockReason,
    recentObservations: Array<{
      observationId, dataType, source, receivedAtMs, isFallback
    }>,
    evaluatedAt
  }

GET /data/health/strategy/:strategyId
  ?quote_age_ms=5000&requires_oi=false&requires_option_chain=false
  &requires_confirmed_candle=false&oi_available=true
  &option_chain_available=true&candle_confirmed=true
→ {
    strategyId, signalAllowed, dataGateAllowed,
    strategyRequirementsMet, confidenceScore, quality,
    blockReasons: string[] | null,
    requirements: { maxQuoteAgeMs, minConfidenceScore, requiresOI,
                    requiresOptionChain, requiresConfirmedCandle },
    evaluatedAt
  }
```

### 1.8 Data Lineage

```
GET /data/lineage/summary
→ {
    storeSize, totalRecorded, maxSize, utilizationPercent, retrievedAt
  }

GET /data/lineage/:observationId
→ 200 { ...lineageRecord }
→ 404 { error: "observation_not_found", observationId, message }

GET /data/lineage/instrument/:instrumentId
  ?limit=10
→ {
    instrumentId, records: LineageRecord[],
    count, storeSize, totalRecorded, retrievedAt
  }
```

### 1.9 Broker Endpoints (Upstox pass-through)

```
GET /brokers/upstox/status
→ {
    provider: "upstox",
    configured: boolean,
    circuitBreakers: {
      quotes: "CLOSED" | "OPEN" | "HALF_OPEN",
      historical: "CLOSED" | "OPEN" | "HALF_OPEN"
    }
  }

GET /brokers/upstox/quotes
  ?symbols=NIFTY,RELIANCE&exchange=NSE
→ {
    quotes: { [symbol]: { ...QuoteFields } },
    count: number,
    provider: "upstox"
  }
→ 401 / 403 / 429 / 503 on provider errors (with retryable, retryAfterMs)

GET /brokers/upstox/historical
  ?symbol=NIFTY&interval=5m&from=2026-09-01&to=2026-09-12&exchange=NSE
→ {
    candles: OHLCVCandle[],
    count: number,
    provider: "upstox"
  }
→ 401 / 403 / 429 / 503 on provider errors (with retryable, retryAfterMs)
```

### 1.10 Publisher

```
GET /publisher/status
→ {
    running: true | false | "reconnecting",
    subscribedSymbols: string[],       // capped at 500 entries
    ticksPublished: number,
    validationFailures: {
      negative_ltp: number,
      future_timestamp: number,
      duplicate: number,
      missing_token: number,
      missing_exchange: number
    },
    lastPublishedAt: number | null,    // Unix epoch ms
    brokerConnections: {
      angel_one_smartstream: { connected: boolean, ... },
      upstox_v3_protobuf: { connected: boolean, ... }
    }
  }

POST /publisher/symbols
  Body: {
    add?: string[],     // max 100 entries; each symbol max 50 chars
    remove?: string[]
  }
→ {
    symbols: string[],
    count: number,
    added: number,
    removed: number
  }
→ 400 on validation error (array too large, symbol too long)
```

### 1.11 Monitoring

```
GET /monitoring/health
  → 503 { available: false, reason: "service not yet ready" } before init
  → 200 {
      request_count: number,
      ban_count: number,
      cache_hit_rate: number,      // 0.0–1.0
      uptime_seconds: number,
      providers: {
        [providerId]: {
          status: "healthy" | "degraded" | "unavailable",
          lastSuccess: string | null,    // ISO-8601 UTC
          lastFailure: string | null,
          requestCount: number,
          successCount: number,
          failureCount: number,
          latencyP50: number | null,
          latencyP99: number | null
        }
      }
    }

  Status thresholds (Req 15.7):
    healthy   — score >= 60
    degraded  — score 20-59
    unavailable — score < 20 OR circuit open

GET /monitoring/scraping-stats
  → 503 before init
  → {
      endpoints: {
        "/scraping/historical": { p50_ms, p99_ms, success_rate } | null,
        "/scraping/quotes": { ... } | null,
        "/scraping/option-chain": { ... } | null,
        "/scraping/instruments": { ... } | null,
        "/publisher/status": { ... } | null,
        "/monitoring/health": { ... } | null,
        ...
      }
    }
  null values indicate no requests in the rolling 3600-second window.

GET /monitoring/proxy-status
  → 503 before init
  → {
      pool_size: number,
      rotation_count: number,
      active_proxy: string | null    // credentials masked
    }

GET /monitoring/session-status
  → 503 before init
  → {
      last_warm_at: string | null,
      session_age_seconds: number | null,
      next_warm_at: string | null
    }
```

---

## 2. TYPESCRIPT API ROUTES (Next.js, port 3000)

All market data passes through the `ProviderRegistry` internally.

### 2.1 Provider Health

```
GET /api/data/providers/health
→ {
    generatedAt: string,
    workerCredentials: { ... },   // key names and presence flags only — no values
    providers: {
      [providerId]: {
        id: ProviderId,
        status: string,
        lastSuccessAt: string | null,
        lastFailureAt: string | null,
        latencyMs: { p50, p95, p99 },
        requestCount: number,
        successCount: number,
        errorCount: number,
        successRate: number | null,
        circuitOpen: boolean,
        circuitRetryAt: string | null,
        currentHealthScore: number,
        configured: boolean,
        credentialsComplete: boolean,
        runtimeAvailable: boolean,
        authenticated: boolean,
        authenticationCheckedAt: string | null,
        capabilities: string[],
        reliability: {
          sampleCount: number,
          successRate: number | null,
          status: string,
          latencyMsP50: number | null,
          latencyMsP95: number | null
        }
      }
    }
  }

SECURITY: stripCredentialFields() applied before serialisation.
Response will NEVER contain secrets, API keys, tokens, or credential values
regardless of what upstream services return (defence-in-depth).
```

### 2.2 Data Forensics

```
GET /api/in/data/forensics/:tradeId
→ 200 {
    tradeId: string,
    paperTrade: {
      id, symbol, direction, status, source,
      notional, entry, stopLoss, target, riskReward, atr,
      exitPrice, pnlPct, pnlUsd, currency, note, rationale, meta,
      openedAt, closedAt,
      // V2.1 provenance fields:
      dataObservationId, quoteAgeAtEntryMs, dataConfidenceAtEntry,
      dataQualityAtEntry, dataProviderAtEntry, dataIsFallback,
      observationEventTime, signalId, featureVersion
    },
    signalRecord: {
      id, signalId, strategyId, sourceType,
      instrument, exchange, sessionDate, timeframe,
      direction, entry, stopLoss, target, riskReward, atr,
      confidence, qualityVector, expectedValue, grade, score,
      regime, regimeFit, dataQuality, riskDecision, paperDecision,
      abstentionReason, lifecycleState, correlationId, featureVersion,
      rationale, detectedAt
    } | null,
    dataProvenanceRecord: {
      id, datasetKey, instrumentId, exchange, intervalStr, sessionDate,
      provider, sourceType, authenticated,
      fetchedAt, sourceTimestamp, dataAsOf,
      responseHash, responseTruncated,
      fromTs, toTs, datasetVersion, dataTrustStatus, rowCount, createdAt
    },
    lineageEntry: {
      lookupStatus: string,
      record: { ... } | null
    },
    qualityAtSignalTime: { score: number | null, grade: string | null },
    chain: Array<{
      step: number,
      layer: string,
      description: string,
      evidence: string
    }>,
    retrievedAt: string
  }

→ 404 {
    error: "trade_not_found" | "provenance_not_found",
    tradeId, symbol?, sessionDate?,
    message, missingProvenanceLink?
  }
  (Req 16.6: 404 returned when no DataProvenanceRecord exists for the trade)

→ 400 { error: "tradeId is required and must be a string" }
```

Join strategy:
- `PaperTrade → SignalIntelligenceRecord` via `trade.signalId`
- `PaperTrade → DataProvenance` via `symbol + sessionDate + dataProviderAtEntry`
  (falls back to any provenance record for that symbol+session when provider absent)

### 2.3 Market Overview

```
GET /api/market/overview
→ {
    indices: Array<{ symbol, ltp, change, changePct }>,
    metadata: { provider, dataAsOf, marketStatus }
  }
→ 502 { error: true, code: "OVERVIEW_FAILED", message }
```

### 2.4 Quote and Historical (legacy broker-chain routes)

```
GET /api/in/quote
  ?symbols=RELIANCE,TCS,NIFTY
→ {
    quotes: Quote[],
    source: string,
    sources: string[],
    fetchedAt: string
  }

Cache-Control: public, s-maxage=5, stale-while-revalidate=10

GET /api/in/historical
  ?symbol=RELIANCE&interval=1d&range=6mo
  interval: one of 1m, 5m, 15m, 30m, 1h, 1d, 1w
  range: e.g. "6mo", "1y"
→ {
    symbol, interval, range,
    candles: OHLCVCandle[],
    source: string
  }
→ 400 { error: "symbol is required" }
→ 400 { error: "Invalid interval \"..\"", valid: [...] }

Cache-Control: s-maxage=30 (intraday) or s-maxage=300 (1h/1d/1w)
```

### 2.5 Option Chain

```
GET /api/in/option-chain
  ?symbol=NIFTY&expiry=2026-09-26
→ {
    ...chain,
    strikes: Strike[],      // ML-enriched greeks when available
    source: string,
    fromCache?: boolean,
    partial?: boolean,
    iv_regime: "CRUSH" | "STABLE" | "SPIKE" | null
  }
→ 502 { error, symbol, attempts: Array<{ id, error }> }

Cache-Control: public, s-maxage=20, stale-while-revalidate=30
```

### 2.6 Historical Data Infrastructure

```
GET /api/in/historical-data/status
→ {
    generatedAt, datasetVersion,
    fnoUniverse: { universeVersion, generatedAt, constituentCount, ... } | null,
    timeframeCoverage: {
      [interval]: { rows: number, lastUpdated: string | null }
    },
    supportedTimeframes: ["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"],
    threeMRemoval: {
      legacyRowsInDb: number,
      newAcquisitionsBlocked: true,
      note: string
    },
    qualityDistribution, gapSummary, reconciliation,
    backfillJobs, providerActivity, healthSummary
  }

GET /api/in/historical-data/providers
→ {
    generatedAt, totalProviders,
    authenticatedProviders, openSourceProviders, fallbackProviders,
    capabilityMatrixMarkdown: string,
    providers: Array<{
      provider, sourceType, authenticated, note,
      requestsPerSecond, supportedIntervals,
      sampleCount, successRate, reliabilityStatus,
      latencyMsP50, latencyMsP95,
      candleRowsInDb, provenanceRows, verifiedRows,
      authenticationLabel
    }>
  }

GET /api/in/historical-data/universe
  ?version=<snapshotVersion>&status=ACTIVE|ADDED|REMOVED
→ {
    generatedAt,
    universe: {
      version, generatedAt, effectiveFrom, effectiveTo,
      sourceProvider, checksum, constituentCount,
      fnoEquityCount, fnoIndexCount,
      addedCount, removedCount, suspendedCount, unresolvedCount
    },
    constituents: Array<{
      symbol, exchange, isin, instrumentType,
      angelToken, angelSymbol, upstoxKey, upstoxSymbol,
      lifecycleStatus, fnoEligible, firstSeen, lastSeen
    }>,
    totalReturned, filters, recentSnapshots
  }
→ 404 { error: "No F&O universe snapshot found...", hint }

GET /api/in/historical-data/gaps
  ?symbol=RELIANCE&timeframe=5m&status=PENDING&limit=100
→ {
    generatedAt, totalReturned,
    summary: { [recoveryStatus]: count },
    filters, note3m,
    gaps: Array<{
      id, instrumentId, exchange, intervalStr,
      gapStart, gapEnd, durationSec,
      gapStartIso, gapEndIso,
      recoveryStatus, recoveryAttempts,
      expectedProvider, recoveryProvider,
      detectedAt, recoveredAt, reason,
      classification
    }>
  }
→ 400 for interval=3m

GET /api/in/historical-data/reconciliation
  ?symbol=RELIANCE&timeframe=5m&limit=100
→ {
    generatedAt, totalRecords,
    statistics: {
      totalCompared, matched, matchRatePct,
      distribution, byProviderPair
    },
    records: Array<{ ...ReconciliationRecord, timeIso }>
  }
→ 400 for timeframe=3m
```

### 2.7 Signals

```
GET /api/signals
  ?type=BUY|SELL&limit=20
→ SignalHistory[]    (from database — not a live provider call)
```

---

## 3. TYPESCRIPT DataServiceClient (SDK)

Internal SDK for TypeScript consumers. Do not duplicate HTTP implementation.

```typescript
// src/lib/market-data/registry.ts — the canonical client

import { registry, bootstrapRegistry } from '@/lib/market-data/registry';

// Bootstrap once before any calls (idempotent)
await bootstrapRegistry();

// Live quotes
const quotes: MDQuote[] = await registry.getQuotes(['RELIANCE', 'INFY']);

// Historical candles (interval must be one of: 1m,5m,10m,15m,30m,1h,1d,1w,1M)
const candles: OHLCVCandle[] = await registry.getHistoricalCandles({
  symbol: 'RELIANCE',
  exchange: 'NSE',
  interval: '5m',
  from: '2026-09-01T00:00:00Z',
  to: '2026-09-12T00:00:00Z',
});

// Option chain
const chain: OptionChain = await registry.getOptionChain('NIFTY', '2026-09-26');

// Instruments
const instruments: Instrument[] = await registry.getInstrumentMaster({
  exchange: 'NSE',
  instrumentType: 'EQ',
});

// Live subscription
const unsub = registry.subscribe(
  { symbols: ['RELIANCE'], exchange: 'NSE' },
  (tick: LiveTick) => { /* handle tick */ },
  (err) => { /* handle error */ }
);
unsub(); // call to unsubscribe

// Provider health (no provider call — reads in-memory circuit state)
const health: ProviderHealth[] = registry.getHealth();
```

---

## 4. CANONICAL RESPONSE ENVELOPE

All API responses (both Python and TypeScript) include metadata alongside data.

```json
{
  "data": [...],
  "metadata": {
    "symbol": "RELIANCE",
    "exchange": "NSE",
    "interval": "5m",
    "requestedAt": "2026-09-12T09:30:00.000Z",
    "dataAsOf": "2026-09-12T09:29:00.000Z",
    "timezone": "Asia/Kolkata",
    "isLive": true,
    "isHistorical": false,
    "provider": "angel_one",
    "providerType": "BROKER",
    "authenticated": true,
    "provenance": "BROKER_AUTHENTICATED",
    "marketStatus": "OPEN",
    "quality": {
      "score": 92,
      "grade": "A",
      "completeness": 1.0,
      "freshness": 0.95,
      "validationStatus": "PASSED",
      "reconciliationStatus": "CONFIRMED"
    },
    "sourceChain": ["angel_one"]
  }
}
```

---

## 5. ERROR RESPONSE FORMAT

All errors use a consistent JSON structure:

```json
{
  "error": {
    "code": "PROVIDER_RATE_LIMITED",
    "message": "Angel One rate limit exceeded (HTTP 429)",
    "provider": "angel_one",
    "retryAfterMs": 1000,
    "requestId": "req-abc123"
  }
}
```

No stack traces, no credentials, no internal paths in error responses.

### MarketDataError Codes

| Code | HTTP | Retry | Circuit Penalty |
|---|---|---|---|
| `AUTH_FAILURE` | 401/403 | No | −40 (hard block) |
| `RATE_LIMIT` | 429 | Yes (backoff) | −15 |
| `UNAVAILABLE` | 503 | Yes (backoff) | −40 |
| `PROVIDER_TIMEOUT` | — | Yes (1×) | −40 |
| `MARKET_CLOSED` | — | No failover | 0 |
| `UNSUPPORTED_CAPABILITY` | — | No failover | 0 |
| `EMPTY_DATA` | — | No retry | 0 |
| `INVALID_DATA` | — | No retry | −15 |
| `DATA_GAP` | — | Schedule recovery | 0 |

`MARKET_CLOSED` and `UNSUPPORTED_CAPABILITY` never increment circuit-breaker failure counts.

---

## 6. WEBSOCKET CONTRACT

### Live Quotes Stream

```
WS /v1/stream/quotes
  (Next.js API route backed by Redis pub/sub af:ticks:{symbol})

Server → Client messages:
{
  "type": "tick",
  "data": {
    "symbol": "NIFTY",
    "exchange": "NSE",
    "ltp": 25312.50,
    "change": 125.30,
    "changePct": 0.50,
    "volume": 1234567,
    "oi": null,
    "timestamp": "2026-09-12T09:30:15.234Z",
    "provider": "angel_one",
    "isStale": false
  }
}

Control messages:
{ "type": "subscribe",   "symbols": ["NIFTY", "RELIANCE"] }
{ "type": "unsubscribe", "symbols": ["RELIANCE"] }
{ "type": "heartbeat" }          // server sends every 10s
{ "type": "reconnect" }          // server signals client should reconnect
{ "type": "connection_failed" }  // broker WS exhausted all reconnect attempts
```

### Redis Pub/Sub Channels (internal)

| Channel | Publisher | Consumer |
|---|---|---|
| `af:ticks:{SYMBOL}` | data-service | scraping-tick-listener worker |
| `af:stream:ticks` | data-service | Redis Streams durability |

---

## 7. SUPPORTED INTERVALS

```
Valid:   "1m" | "5m" | "10m" | "15m" | "30m" | "1h" | "1d" | "1w" | "1M"
BLOCKED: "3m"  — permanently removed in V8; any endpoint returns HTTP 400
```

The `isSupportedInterval("3m")` function returns `false`.
`SUPPORTED_TIMEFRAMES` equals exactly `["1m","5m","10m","15m","30m","1h","1d","1w","1M"]`.

---

## 8. PROVIDER IDs

```
Valid ProviderId values: "scrapling" | "angel_one" | "upstox" | "jugaad" | "openchart" | "yahoo"

Removed: "nse" (removed V3.0)
```

---

## 9. VERSIONING POLICY

- Current version: `v9.0`
- URL prefix: none (Python data-service) or `/api/` (TypeScript)
- Breaking changes require a new major version
- Additive changes (new fields) are backward compatible
- Deprecated fields are marked `@deprecated` in schema before removal
- Old versions supported for 30 days after new version release

---

## 10. RATE LIMITS (internal — upstream provider budgets)

These limits are not enforced on internal consumers. They are upstream provider
limits that the routing engine respects via token bucket and circuit breaker.

| Provider | Upstream Limit | AlphaForge Budget |
|---|---|---|
| Angel One historical | ~3 req/s | 3 req/s token bucket |
| Angel One quotes | ~10 req/s | 8 req/s token bucket |
| NSE (scrapling) | rate-sensitive | 8 req/s, 500ms jitter |
| Upstox v2 | 250 req/min | 4 req/s token bucket |
| Yahoo Finance | ~10 req/s | 5 req/s token bucket |
| jugaad-data (NSE bhavcopy) | HTTP pull | 1 concurrent download |
| openchart (NSE charting) | NSE-gated | 2 req/s per session |

---

## 11. CACHE KEY SCHEMA

All L2 Redis keys are namespaced under the `md:` prefix.

| Operation | Redis Key Pattern | TTL |
|---|---|---|
| Single quote | `md:quote:{provider}:{SYMBOL}` | 3s |
| Batch quotes | `md:quotes-batch:{provider}:{SYM1,SYM2,...}` | 3s |
| Intraday candles | `md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}` | 30s |
| Daily+ candles | `md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}` | 4h |
| Option chain | `md:oc:{provider}:{underlying}:{expiry}` | 15s |
| Instrument master | `md:instruments:{provider}:{filterKey}` | 12h |
| Provider health | `md:health:{providerId}` | 5s |
| BackfillCheckpoint | `md:backfill:checkpoint:{symbol}:{exchange}:{interval}` | persistent (no TTL) |
