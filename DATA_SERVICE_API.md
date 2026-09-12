# DATA SERVICE API
**AlphaForge — Canonical Data-Service API Contract**  
**Version:** v1  
**Date:** 2026-09-12

---

## BASE URLS

| Service | URL |
|---|---|
| TypeScript Next.js API | `http://localhost:3000/api/` |
| Python data-service | `http://localhost:8200/` (or `DATA_SERVICE_URL`) |

All responses use JSON. Timestamps are ISO-8601 UTC strings. Prices are INR.

---

## 1. PYTHON DATA-SERVICE ENDPOINTS (port 8200)

These are internal service-to-service endpoints. The TypeScript `ScraplingProvider`
wraps them — consumers never call these directly.

### Health

```
GET /health
→ { status: "healthy" | "degraded", service, version, timestamp, components? }

GET /scraping/status
→ { available, version, capabilities: { chromium_available, redis_connected, ... }, config }
```

### Historical Data

```
GET /scraping/historical
  ?symbol=RELIANCE&interval=5m&from=2026-09-01&to=2026-09-12
→ {
    data: OHLCVCandle[],
    metadata: {
      symbol, exchange, interval, from, to,
      provider: "openchart" | "jugaad" | "upstox_py",
      provenance: "OPEN_SOURCE_HISTORICAL" | "BROKER_AUTHENTICATED",
      quality: { score, grade, completeness, gaps },
      dataAsOf, requestedAt
    }
  }

Supported intervals: 1m, 5m, 10m, 15m, 30m, 1h, 1d, 1w, 1M
REJECTED: 3m → HTTP 400 "interval 3m is not supported"
```

### Live Quotes

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
    metadata: { provider, provenance, dataAsOf, marketStatus: "OPEN" | "CLOSED" }
  }
```

### Option Chains

```
GET /scraping/option-chain
  ?underlying=NIFTY&expiry=2026-09-26
→ {
    symbol, spot, expiry, expiries: string[],
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

### Instrument Master

```
GET /scraping/instruments
  ?exchange=NSE&instrumentType=EQ
→ {
    data: Instrument[],
    metadata: { provider, count, asOf }
  }

GET /scraping/instruments/fno-universe
→ {
    universe: string[],   // canonical NSE F&O equity symbols
    effectiveFrom, effectiveTo, source, version, checksum
  }
```

### Data Quality Gate

```
POST /data/gate
  Body: { symbols: string[], interval: string, requiredFields: string[] }
→ {
    verdict: "READY" | "DEGRADED" | "BLOCKED",
    symbols: Record<string, {
      verdict, score, grade,
      issues: string[],
      provenance, dataAsOf
    }>
  }
```

### Broker Endpoints (Python side)

```
GET /brokers/upstox/candles
  ?symbol=NIFTY&interval=5m&from=2026-09-01&to=2026-09-12
→ Same schema as /scraping/historical
```

### Publisher

```
GET /publisher/status
→ { running, subscribedSymbols, ticksPublished, lastPublishedAt }

POST /publisher/subscribe
  Body: { symbols: string[] }
→ { subscribed: string[], alreadySubscribed: string[] }
```

### Provider Health (Python)

```
GET /monitoring/health
→ {
    providers: {
      [providerId]: {
        status: "healthy" | "degraded" | "unavailable",
        lastSuccess?, lastFailure?,
        requestCount, successCount, failureCount,
        latencyP50, latencyP95, latencyP99
      }
    }
  }
```

---

## 2. TYPESCRIPT API ROUTES (Next.js, port 3000)

These are the consumer-facing API endpoints. All market data passes through
the `ProviderRegistry` internally.

### Provider Status

```
GET /api/data/providers/health
→ {
    providers: Array<{
      id: ProviderId,
      status: "CONNECTED" | "DISCONNECTED" | "AUTH_FAILED" | "DEGRADED" | "RATE_LIMITED",
      lastSuccessAt?: string,
      latencyMs?: { p50, p95, p99 },
      successRate?: number,
      requestCount?: number,
      errorCount?: number
    }>
  }

No credentials or tokens in response.
```

### Data Readiness

```
GET /api/data/readiness
  ?symbols=RELIANCE,NIFTY&interval=5m
→ {
    ready: boolean,
    verdict: "READY" | "DEGRADED" | "BLOCKED",
    symbols: Record<string, {
      verdict, grade, score, lastCandle?, gapCount?
    }>
  }
```

### Market Overview

```
GET /api/market/overview
→ {
    indices: Array<{ symbol, ltp, change, changePct }>,
    metadata: { provider, dataAsOf, marketStatus }
  }
```

### Signals

```
GET /api/signals
  ?type=BUY|SELL&limit=20
→ SignalHistory[] (from database, not live provider)
```

---

## 3. TYPESCRIPT DataServiceClient (SDK)

Internal SDK for TypeScript consumers. Do not duplicate HTTP implementation.

```typescript
// src/lib/market-data/registry.ts — the canonical client

import { registry, bootstrapRegistry } from '@/lib/market-data/registry';

// Quote
const quotes: MDQuote[] = await registry.getQuotes(['RELIANCE', 'INFY']);

// Historical candles
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
// later:
unsub();

// Provider health
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
      "reconciliationStatus": "ACCEPTABLE_VARIANCE"
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

---

## 6. WEBSOCKET CONTRACT

### Live Quotes Stream

```
WS /v1/stream/quotes
  (via Next.js API route or data-service Redis pub/sub)

Message shape (incoming from server):
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
{ "type": "subscribe", "symbols": ["NIFTY", "RELIANCE"] }
{ "type": "unsubscribe", "symbols": ["RELIANCE"] }
{ "type": "heartbeat" }     → server sends every 10s
{ "type": "reconnect" }     → client should reconnect
```

---

## 7. VERSIONING POLICY

- Current version: `v1`
- URL prefix: `/v1/` (Python data-service) or `/api/` (TypeScript)
- Breaking changes require a new version prefix
- Additive changes (new fields) are backward compatible within v1
- Deprecated fields are marked `@deprecated` in schema before removal
- Old versions supported for 30 days after new version release

---

## 8. RATE LIMITS (internal)

These are not enforced on consumers within the application. They are the upstream
provider limits that the routing engine respects.

| Provider | Limit | Our budget |
|---|---|---|
| Angel One historical | ~3 req/s | 3 req/s token bucket |
| Angel One quotes | ~10 req/s | 8 req/s token bucket |
| NSE (scrapling) | sensitive | 8 req/s, 500ms jitter |
| Upstox v2 | 250 req/min | 4 req/s token bucket |
| Yahoo Finance | ~10 req/s | 5 req/s token bucket |
| jugaad-data (NSE bhavcopy) | HTTP pull | 1 concurrent download |
| openchart (NSE charting) | NSE-gated | 2 req/s per session |
