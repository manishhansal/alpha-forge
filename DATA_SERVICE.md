# AlphaForge Data Service

**Version: 3.1.0** — LEVEL 2 — INTEGRATION CERTIFIED · RELIABILITY & FAILOVER CERTIFIED (2026-09-07) · API CONFORMANCE VALIDATED (2026-09-08)  
**Role: Tier-0 market data provider** for the TypeScript layer (V3.0.0, 2026-09-04)  
**Last updated:** 2026-09-08, branch `refactor/data-service` (PR #29) — reliability hardening + Angel/Upstox live-WS + API conformance

Standalone reference for the `data-service` Python microservice — the canonical, validated, low-latency NSE market-data foundation for AlphaForge.

> **V3.1 Summary (`refactor/data-service`, PR #29):** V3.1 is a production-grade reliability & failover upgrade applied to **both** layers of the acquisition chain `data-service → Angel One → Upstox → Yahoo`. In the Python service it adds a typed provider-error core (`core/provider_http.py`) with HTTP-status classification, an exponential-backoff ladder that honours `Retry-After`, and pooled keep-alive clients; wires the previously **dead** Upstox client into `brokers/router.py` (`/brokers/upstox/*`); adds a capability-aware `GET /health/providers`; adds cache-first historical fetch with validated gap repair (`scrapers/historical_repair.py`); wires duplicate-tick suppression + gap detection into the publish loop; and widens the canonical `ProviderId` so Upstox/Angel/Yahoo data no longer fails schema validation. On the TypeScript side it adds capability-aware circuit breakers, status-driven error classification, cross-provider reconciliation, a signal-engine data gate, never-silent provider switches, the Upstox **v3** Protobuf WebSocket feed, and an `resolveAngelWsSession()` fix that lets the Angel SmartStream WS actually start. See [`DATA_SERVICE_RELIABILITY_CERTIFICATION.md`](./DATA_SERVICE_RELIABILITY_CERTIFICATION.md) and [`DATA_SERVICE_API_CONFORMANCE.md`](./DATA_SERVICE_API_CONFORMANCE.md) for full evidence. New sections: [§21](#21-reliability--failover-core-v31), [§22](#22-v31-bug-fix-log).

> **V3.0 context:** All direct NSE data acquisition was removed from the TypeScript layer in V3.0.0 (commit `1c8235f`). The `data-service` is now the **tier-0 provider** in the `ProviderRegistry` via `ScraplingProvider`. The TypeScript `ProviderId` union no longer includes `"nse"` — all NSE scraping runs here. 12 automated guard tests in `tests/lib/market-data/nse-elimination.test.ts` prevent any regression.

> **V2.1 Summary:** V2.1 closes the wiring gaps identified in V2.0's `PASS_WITH_WARNINGS` audit. Circuit breakers are now wired to all 5 upstream HTTP paths. Lineage is recorded on every successful fetch. The DataQualityGate is exposed as an HTTP API. Redis Streams are integrated into the TickPublisher. Paper trades now persist full data provenance. A trade forensics endpoint reconstructs the data→signal→trade chain. 448 tests pass (335 V2.0 baseline + 113 new integration tests). Certification level: **LEVEL 2 — INTEGRATION CERTIFIED**. See `data-service/reports/V2_1_CERTIFICATION_MATRIX.md` and `PRODUCTION_READINESS_V2_1.md` for full status.
>
> **V2.0 Summary:** The V2 upgrade fixed a critical silent semantic corruption (OI was being mapped from INR traded value), added institutional-grade data quality infrastructure (timestamp engine, freshness engine, market session engine, deduplication, gap detection, circuit breakers, data lineage, candle builder), and increased test coverage from 112 to 335 tests. See `data-service/reports/DATA_SERVICE_V2_CERTIFICATION.md` for full status.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [TypeScript Integration (ScraplingProvider)](#3-typescript-integration-scraplingprovider)
4. [Configuration](#4-configuration)
5. [Docker & Networking](#5-docker--networking)
6. [API Endpoints](#6-api-endpoints)
7. [Session Management (Scrapling)](#7-session-management-scrapling)
8. [Live Quotes — NSE NextApi](#8-live-quotes--nse-nextapi)
9. [Historical OHLCV](#9-historical-ohlcv)
10. [Option Chain Scraper](#10-option-chain-scraper)
11. [Tick Publisher](#11-tick-publisher)
12. [Anti-Ban Layer](#12-anti-ban-layer)
13. [Redis Schema](#13-redis-schema)
14. [Bug-Fix Log (V1 Deployment Sprint)](#14-bug-fix-log)
15. [Known Limitations (V1)](#15-known-limitations-v1--deployment-sprint)
16. [Development Guide (Quick Reference)](#16-development-guide-quick-reference)
17. [Data Quality Infrastructure (V2)](#17-data-quality-infrastructure-v2)
18. [V2 Bug-Fix Log](#18-v2-bug-fix-log)
19. [Known Limitations (Updated V2)](#19-known-limitations-updated-v2)
20. [Development Guide (Full)](#20-development-guide-full)
21. [Reliability & Failover Core (V3.1)](#21-reliability--failover-core-v31)
22. [V3.1 Bug-Fix Log](#22-v31-bug-fix-log)

---

## 1. Overview

The data service provides NSE market data without requiring any broker credentials. It runs as a sidecar alongside the main Next.js application and the ML microservice. **As of V3.0.0 (2026-09-04) it is the tier-0 provider in the TypeScript `ProviderRegistry`** — the `ScraplingProvider` adapter routes all NSE data through this service before attempting Angel One, Upstox, or Yahoo.

| Property | Value |
|---|---|
| Language | Python 3.11 |
| Framework | FastAPI + Uvicorn |
| Port | **8200** |
| Base image | `python:3.11-slim` |
| Browser engine | Playwright / Chromium via **Scrapling 0.4.x** |
| Redis client | `redis[hiredis]==5.0.8` |
| Certification | LEVEL 2 — INTEGRATION CERTIFIED (V2.1, 448 tests) |
| Role in TS stack | **Tier-0 `ScraplingProvider`** (`PROVIDER_PRIORITY[0]`) |

### What it provides

| Capability | Implementation | V2.1 Status |
|---|---|---|
| Live quotes (equities + indices) | `httpx` → NSE `api/NextApi` endpoints (no browser) | Circuit breaker + lineage wired |
| Live tick publishing | 5s poll → Redis pub/sub `af:ticks:{SYMBOL}` + Redis Streams | AT_LEAST_ONCE delivery |
| Option chain | Playwright / Scrapling `AsyncDynamicSession` → XHR capture | Circuit breaker + lineage wired |
| Daily OHLCV | `httpx` → NSE Bhavcopy CDN (`nsearchives.nseindia.com`) | Lineage wired |
| Intraday OHLCV | `httpx` → NSE charting API (`charting.nseindia.com`) | Circuit breaker + lineage wired |
| Instrument master | `httpx` → NSE instrument CSV | — |
| **DataQualityGate** | `POST /data/gate` — evaluates freshness, completeness, provider health | **V2.1 NEW** |
| **Lineage API** | `GET /data/lineage/*` — records and retrieves observation provenance | **V2.1 NEW** |
| **Upstox broker client** | `src/brokers/upstox_client.py` — quotes + historical candles via Upstox API, **wired via `brokers/router.py`** | **V3.1 wired** |
| **Provider fallback API** | `GET /brokers/upstox/{status,quotes,historical}` — authorized Upstox as a classified, non-crashing fallback source | **V3.1 NEW** |
| **Capability-aware provider health** | `GET /health/providers` — per-provider, per-capability health from circuit-breaker state | **V3.1 NEW** |
| **Resilient HTTP core** | `src/core/provider_http.py` — typed errors, status classification, backoff + `Retry-After`, pooled clients | **V3.1 NEW** |
| **Cache-first historical + gap repair** | `src/scrapers/historical_repair.py` — fingerprinted cache, gap detection, validated repair | **V3.1 NEW** |
| **Duplicate-tick protection** | `tick_publisher` dedup + gap detection wired into the publish loop | **V3.1 NEW** |

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     data-service (port 8200)             │
│                                                          │
│  FastAPI lifespan                                        │
│  ├── 1. Redis connect         (redis[hiredis] 5.0.x)    │
│  ├── 2. Chromium smoke-test   (AsyncDynamicSession)      │
│  ├── 3. AntibanLayer start    (ProxyManager + Warmer)    │
│  └── 4. TickPublisher start   (5 s poll → Redis pub/sub) │
│                                                          │
│  Scrapers                                                │
│  ├── live_quotes.py    → NSE NextApi (httpx)             │
│  ├── option_chain.py   → NSE page (Playwright/Scrapling) │
│  ├── historical.py     → NSE/BSE archive CDN (httpx)     │
│  └── instrument_master.py → NSE instrument CSV (httpx)   │
│                                                          │
│  Brokers (V3.1 — wired)                                  │
│  ├── router.py         → /brokers/upstox/{status,...}    │
│  ├── upstox_client.py  → Upstox v2 API (httpx, pooled)   │
│  └── upstox_instruments.py → symbol→ISIN resolver (12h)  │
│                                                          │
│  Reliability core (V3.1)                                 │
│  └── core/provider_http.py → typed errors + backoff +    │
│         Retry-After + pooled keep-alive clients          │
│                                                          │
│  Anti-ban                                                │
│  ├── proxy_manager.py  (optional proxy pool)             │
│  ├── ban_detector.py   (response body heuristics)        │
│  └── session_warmer.py (30-min homepage warm loop)       │
└──────────────────────────────────────────────────────────┘
         │                            │
    Redis pub/sub              Chromium (headless)
    af:ticks:{SYMBOL}          via Playwright
         │
    ┌────▼───────────────────────────────────────┐
    │  Next.js / TypeScript layer                │
    │  ScraplingProvider (ProviderRegistry[0])   │
    │  ↓ withFailover() to AngelOne/Upstox/Yahoo │
    │  ↓ useLiveQuotes() → af:ticks:{SYMBOL}     │
    └────────────────────────────────────────────┘
```

### Component responsibilities

| File | Responsibility |
|---|---|
| `src/server.py` | FastAPI app + lifespan (startup/shutdown orchestration) |
| `src/config.py` | `Settings` dataclass — reads env vars |
| `src/scrapers/live_quotes.py` | `AsyncDynamicSession` singleton + NSE NextApi quote fetchers |
| `src/scrapers/option_chain.py` | `AsyncDynamicSession` singleton + NSE/BSE option chain scrapers |
| `src/scrapers/historical.py` | Bhavcopy (daily) + charting API (intraday) fetchers + route handler |
| `src/scrapers/instrument_master.py` | NSE/BSE instrument master download and parsing |
| `src/publisher/tick_publisher.py` | 5s poll loop + Redis `PUBLISH` + Redis Streams (V2.1) |
| `src/publisher/router.py` | `GET /publisher/*` monitoring endpoints |
| `src/brokers/router.py` | **NEW V3.1** — `/brokers/upstox/{status,quotes,historical}`; maps typed provider errors to 401/403/429/503/502 (never a 500) |
| `src/brokers/upstox_client.py` | Upstox v2 API client (quotes, historical candles); pooled + typed errors; **wired via `router.py` in V3.1** (was dead code) |
| `src/brokers/upstox_instruments.py` | **NEW V3.1** — symbol→ISIN instrument-key resolver (raw-gzip instrument master, 12h cache) |
| `src/core/provider_http.py` | **NEW V3.1** — typed `ProviderError` hierarchy, `classify_status`, `parse_retry_after_ms`, backoff ladder, `resilient_get`, pooled clients |
| `src/scrapers/historical_repair.py` | **NEW V3.1** — provider-independent cache key + data fingerprint + gap detection + validated gap-repair coordinator |
| `src/monitoring/health_router.py` | `/health/{live,ready,data}` + **`/health/providers`** (capability-aware, V3.1) |
| `src/core/gate_router.py` | **NEW V2.1** — `POST /data/gate` + lineage endpoints |
| `src/anti_ban/proxy_manager.py` | Optional proxy pool with rotation |
| `src/anti_ban/ban_detector.py` | Body-content ban heuristics |
| `src/anti_ban/session_warmer.py` | Background 30-min warm loop (market hours only) |
| `src/anti_ban/rate_limiter.py` | Per-domain token-bucket rate limiters |
| `src/monitoring/router.py` | `/monitoring/*` health and status endpoints |

---

## 3. TypeScript Integration (ScraplingProvider)

**This section is new in V3.0.** All NSE data acquisition was removed from the TypeScript layer. The `data-service` is now registered as priority-0 in the `ProviderRegistry`.

### How the TypeScript layer uses this service

```typescript
// src/lib/market-data/providers/scrapling.ts
// ScraplingProvider wraps all data-service HTTP endpoints

const provider: MarketDataProvider = {
  id: "scrapling",
  priority: 0,
  getQuotes: (symbols) =>
    fetch(`${DATA_SERVICE_URL}/scraping/quotes?symbols=${symbols.join(",")}`),
  getOptionChain: (underlying) =>
    fetch(`${DATA_SERVICE_URL}/scraping/option-chain?underlying=${underlying}`),
  getHistoricalCandles: (symbol, interval, from, to) =>
    fetch(`${DATA_SERVICE_URL}/scraping/historical?symbol=${symbol}&interval=${interval}&from=${from}&to=${to}`),
};
```

### DataQualityGate — required before signal generation

Every TypeScript signal generation path **must** check `signalEngineAllowed` before proceeding:

```typescript
// Required pattern — not yet wired (GATE-001 open)
const gate = await fetch(`${DATA_SERVICE_URL}/data/gate`, {
  method: "POST",
  body: JSON.stringify({ symbol, quoteAgeMs, strategyId, requiresOI }),
});
const { signalEngineAllowed, confidenceScore, blockReason } = await gate.json();
if (!signalEngineAllowed) return;  // HARD BLOCK — no exceptions
```

**GATE-001 status:** The `POST /data/gate` endpoint is implemented and tested in the data-service. The TypeScript signal engine does **not yet call it**. This is the primary blocker for LEVEL 3 (Production Ready) certification.

### NSE elimination enforcement

```typescript
// tests/lib/market-data/nse-elimination.test.ts — 12 tests
// These fail immediately if TypeScript code re-introduces direct NSE acquisition:
expect(PROVIDER_PRIORITY).not.toContain("nse");
expect(() => getBrokerById("nse")).toReturn(null);
expect(() => bootstrapRegistry()).not.toRegister("NseProvider");
```

---

## 4. Configuration

All configuration is read from environment variables. The `Settings` dataclass in `src/config.py` applies defaults.

| Variable | Default | Purpose |
|---|---|---|
| `DATA_SERVICE_PORT` | `8200` | Uvicorn listen port |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection string |
| `DATA_DIR` | `/app/data` | Disk cache root (Bhavcopy CSVs) |
| `SCRAPLING_HEADLESS` | `true` | Run Chromium headless |
| `SCRAPLING_PROXY_URL` | _(empty)_ | Single proxy URL (optional) |
| `SCRAPLING_PROXY_LIST` | `[]` | JSON list of proxy URLs for rotation |
| `NSE_RATE_LIMIT` | `3` | Requests/second to `nseindia.com` |
| `BSE_RATE_LIMIT` | `2` | Requests/second to `bseindia.com` |
| `BAN_BACKOFF_SECONDS` | `60` | Cooldown after ban detection |
| `SYMBOLS` | 20 NSE symbols | Comma-separated symbols for tick publisher |
| `UPSTOX_ANALYTICS_TOKEN` | _(empty)_ | **Preferred** — long-lived read-only Upstox bearer (broker client). Server-side only, never exposed to the browser. |
| `UPSTOX_ACCESS_TOKEN` | _(empty)_ | Legacy Upstox bearer token (backward-compat fallback if the analytics token is unset) |
| `UPSTOX_CLIENT_ID` | _(empty)_ | Upstox client ID (broker client) |

In `docker-compose.yml` these are passed via the `environment:` block on the `data-service` service.

---

## 5. Docker & Networking

### docker-compose.yml additions

```yaml
data-service:
  build:
    context: ./data-service
    dockerfile: Dockerfile
  container_name: alpha-forge-data
  dns:
    - 8.8.8.8    # ← required: Chromium cannot use Docker's 127.0.0.11 resolver
    - 8.8.4.4
  environment:
    REDIS_URL: redis://redis:6379/0
    ...
  networks:
    - alphaforge
  depends_on:
    redis:
      condition: service_healthy
```

### Why `dns: [8.8.8.8, 8.8.4.4]` is required

Docker's embedded DNS resolver runs on the loopback address `127.0.0.11`. Python's `socket` / `libc` can use it without issue, but **Chromium's built-in async DNS resolver explicitly refuses loopback nameserver addresses** (RFC 5735 compliance). Without the `dns:` override, Playwright's `page.goto()` fails with `net::ERR_NAME_NOT_RESOLVED` for every external hostname even though `socket.getaddrinfo()` works correctly in the same container.

### Dockerfile summary

```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN apt-get install -y curl ca-certificates   # healthcheck + TLS
COPY requirements.txt .
RUN pip install -r requirements.txt           # FastAPI, httpx, redis, structlog …
RUN pip install "scrapling[fetchers]==0.4.*" && scrapling install   # Playwright + Chromium
COPY src/ ./src/
EXPOSE 8200
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8200"]
```

Chromium is downloaded at **image build time** (`scrapling install` runs during `docker build`), not at container startup, so the service meets its 90-second startup SLA.

---

## 6. API Endpoints

### Health

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Always HTTP 200. `status: "healthy"` or `"degraded"` with component map. |
| `GET` | `/health/live` | Liveness probe — always 200 if process running. |
| `GET` | `/health/ready` | Readiness probe — checks Redis + publisher. |
| `GET` | `/health/data` | Data quality health — freshness, gaps, circuit breaker states, duplicate rate, clock skew. |
| `GET` | `/health/providers` | **V3.1** — capability-aware provider health (per provider × capability, derived from circuit-breaker state). Overall is `HEALTHY`/`DEGRADED` — a single degraded capability never makes the service `DOWN`. |
| `GET` | `/scraping/status` | Capability flags (chromium, redis, proxy, each scraper path). |

### DataQualityGate (V2.1)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/data/gate` | Evaluate DataQualityGate for an instrument. Body: `GateRequest`. Returns `signalEngineAllowed`, `confidenceScore`, all gate conditions, circuit breaker states. |
| `GET` | `/data/gate/:symbol` | Quick gate check for a symbol. Query: `quote_age_ms`, `strategy_id`. |
| `GET` | `/data/health/strategy/:strategyId` | Strategy-specific data health (OI, chain, candle requirements). |

**The signal engine MUST call `POST /data/gate` before generating any signal. `signalEngineAllowed=false` must hard-block signal generation.**

### Lineage (V2.1)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/data/lineage/summary` | Lineage store statistics (size, utilization). |
| `GET` | `/data/lineage/:observationId` | Retrieve a single lineage record by observation ID. |
| `GET` | `/data/lineage/instrument/:instrumentId` | Recent lineage records for an instrument. Query: `limit` (1–100). |

### Quotes

| Method | Path | Query params |
|---|---|---|
| `GET` | `/scraping/quotes` | `symbols` (comma-separated, 1–200), `exchange` (NSE\|BSE) |

Response:
```json
{
  "quotes": [{ "symbol": "NIFTY", "ltp": 23873.45, "change": -41.0, "changePct": -0.17, ... }],
  "count": 1,
  "source": "nextapi"
}
```

### Historical

| Method | Path | Query params |
|---|---|---|
| `GET` | `/scraping/historical` | `symbol`, `exchange`, `interval` (`1d`\|`5m`\|`15m`\|`30m`\|`1h`), `from`, `to` |

`from` and `to` accept both `YYYY-MM-DD` and full ISO 8601 datetime strings (`2025-09-03T13:20:52.952Z`); the time component is stripped automatically.

### Option Chain

| Method | Path | Query params |
|---|---|---|
| `GET` | `/scraping/option-chain` | `underlying`, `expiry` (optional ISO date), `exchange` (NSE\|BSE) |

### Instruments

| Method | Path | Query params |
|---|---|---|
| `GET` | `/scraping/instruments` | `exchange` (NSE\|BSE) |

### Broker fallback — Upstox (V3.1)

The data-service's own authorized Upstox integration, surfaced as a classified
fallback source. Every provider-level failure is mapped to a clean HTTP status
(`401`/`403`/`429`/`503`, else `502`) with `retryable` + `retryAfterMs` — never
an unhandled `500` — so the TypeScript failover layer can classify identically.

| Method | Path | Query params |
|---|---|---|
| `GET` | `/brokers/upstox/status` | — · reports `configured` + per-capability circuit-breaker state |
| `GET` | `/brokers/upstox/quotes` | `symbols` (comma-separated), `exchange` (NSE\|BSE) |
| `GET` | `/brokers/upstox/historical` | `symbol`, `interval`, `from`, `to` (YYYY-MM-DD), `exchange` |

### Publisher / Monitoring

| Method | Path | Notes |
|---|---|---|
| `GET` | `/publisher/status` | Tick publisher stats (publish count, last tick time, symbols) |
| `GET` | `/publisher/symbols` | List of tracked symbols |
| `POST` | `/publisher/symbols` | Add symbols to the tick publisher |
| `DELETE` | `/publisher/symbols/{symbol}` | Remove a symbol |
| `GET` | `/monitoring/status` | Full component health map |
| `GET` | `/monitoring/session-warmer` | Session warmer schedule (last warm, next warm) |

### Forensics (Next.js — V2.1)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/in/data/forensics/:tradeId` | Full forensics chain for a paper trade: data provenance → lineage → signal decision |

---

## 7. Session Management (Scrapling)

### Why `AsyncDynamicSession` needs `__aenter__`

Scrapling's `AsyncDynamicSession` wraps a Playwright browser context. It **must** be entered as an async context manager before any `fetch()` call:

```python
# ✗ WRONG — browser is never initialized; every fetch() raises
#   "Context manager has been closed"
session = AsyncDynamicSession(headless=True)
page = await session.fetch(url)   # ERROR

# ✓ CORRECT
raw = AsyncDynamicSession(headless=True)
entered = await raw.__aenter__()  # initializes Playwright browser
page = await entered.fetch(url)   # works
```

### Singleton pattern

Both `live_quotes.py` and `option_chain.py` maintain a process-lifetime singleton session:

```
_quote_session_raw   ← the raw AsyncDynamicSession instance (for __aexit__ on reset)
_quote_session       ← the entered session (return of __aenter__; what fetch() is called on)
_quote_session_lock  ← asyncio.Lock — prevents concurrent creation (double-checked locking)
_quote_session_sem   ← asyncio.Semaphore(1) — serializes fetch() calls (single-page session)
```

`reset_quote_session()` calls `_quote_session_raw.__aexit__(None, None, None)` to cleanly close the browser, then clears both globals. The next `get_quote_session()` call creates a fresh session.

### `capture_xhr` is session-level, not per-fetch

A subtle Scrapling 0.4.x API detail: **`capture_xhr` must be passed to the `AsyncDynamicSession` constructor**, not to individual `fetch()` calls. Passing it to `session.fetch(capture_xhr=...)` is silently ignored — it is not in `PlaywrightFetchParams` and is discarded by `validate_fetch`.

```python
# ✗ WRONG — capture_xhr kwarg is silently dropped
session = AsyncDynamicSession(headless=True)
page = await session.fetch(url, capture_xhr="api/option-chain")  # always 0 XHRs

# ✓ CORRECT — set it at session creation
session = AsyncDynamicSession(headless=True, capture_xhr="api/option-chain")
page = await session.fetch(url)  # XHR captured correctly
```

### NSE homepage pre-warm

NSE's option-chain page requires a prior visit to `https://www.nseindia.com` to set session cookies (`nsit`, `nseappid`, `AKA_A2`, etc.) before the SPA fires data API XHRs. Without this visit the page loads with HTTP 200 but `page.captured_xhr` is empty.

The `get_chain_session()` function performs a homepage fetch immediately after `__aenter__`, before returning the session to any caller:

```python
raw = AsyncDynamicSession(headless=True, capture_xhr="api/option-chain|GetOptionChain")
entered = await raw.__aenter__()
# Homepage pre-warm — establishes NSE session cookies
await entered.fetch("https://www.nseindia.com", network_idle=False, wait=2000)
_chain_session = entered
```

### `network_idle=False` + `wait=N` instead of `network_idle=True`

NSE's Angular/Next.js SPA never reaches Playwright's `networkidle` state because it background-polls continuously. Using `network_idle=True` on any NSE page causes `fetch()` to hang until the Playwright timeout fires.

The correct pattern for NSE pages is `network_idle=False, wait=N` where `N` is a dwell in milliseconds after DOM load — enough time for the SPA to fire its data XHRs:

```python
page = await session.fetch(
    "https://www.nseindia.com/option-chain",
    network_idle=False,
    wait=4000,   # 4 s dwell — gives the Angular SPA time to fire XHRs
)
```

---

## 8. Live Quotes — NSE NextApi

### Why the old XHR approach was abandoned

The previous implementation navigated to `nseindia.com/market-data/live-equity-market` with Playwright and intercepted the `equity-stockIndices` XHR. This broke in mid-2026 when NSE migrated their frontend to Next.js, retiring the old `equity-stockIndices` and `api/quote/equity` endpoints entirely.

### New approach — direct HTTP via `httpx`

The NSE `NextApi` endpoints introduced with the Next.js frontend return JSON directly with standard HTTP headers. No browser session or cookies are required — plain `httpx` requests with a `Referer` header work reliably.

### Endpoint mapping

| Symbol type | Endpoint | Notes |
|---|---|---|
| Index (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) | `GET /api/NextApi/apiClient?functionName=getIndexData&&type=All` | Returns all 15 tradeable indices |
| NIFTY 200 constituents | `GET /api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20200` | Returns 201 constituent rows |
| Other NSE equities | `GET /api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20500` | 500 rows; broadest coverage |

### Field mapping

| `MDQuote` field | Source field (equity constituent) | Source field (index) |
|---|---|---|
| `ltp` | `lastPrice` | `last` |
| `change` | `change` | `last − previousClose` |
| `changePct` | `pChange` | `percChange` |
| `open` | `open` | `open` |
| `high` | `dayHigh` | `high` |
| `low` | `dayLow` | `low` |
| `prevClose` | `previousClose` | `previousClose` |
| `volume` | `totalTradedVolume` | _(not available)_ |
| `oi` | `totalTradedValue` | _(not available)_ |

### Headers required

```python
_NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ...",
    "Referer": "https://www.nseindia.com/",
    "Accept": "application/json, text/plain, */*",
}
```

NSE's CDN returns a 404 HTML page without the `Referer` header.

### Routing logic (in `get_quotes` route + `tick_publisher._fetch_quotes`)

```
symbols
  ├── in _NSE_INDEX_SYMBOLS (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY)
  │     └── _fetch_index_quotes()   → getIndexData endpoint
  ├── in NIFTY_200_SYMBOLS
  │     └── _fetch_batch_quotes()   → getIndicesData?symbol=NIFTY%20200
  └── other
        └── _fetch_single_quote()   → getIndicesData?symbol=NIFTY%20500
```

---

## 9. Historical OHLCV

### Daily interval (1d)

Source: `nsearchives.nseindia.com` Bhavcopy CDN (CloudFront, no anti-bot).

URL pattern per trading day:
```
https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{DDMMYYYY}.csv
```

- Pipe-delimited CSV; columns include `SYMBOL`, `SERIES`, `OPEN`, `HIGH`, `LOW`, `CLOSE`, `TOTTRDQTY`
- 404 = market holiday → silently skipped
- 403 = NSE archive restriction for certain dates → logged as `nse_daily_http_error`, skipped
- Parsed candles are written to disk cache (`{DATA_DIR}/bhavcopy/NSE/{symbol}/{from_date}.csv.gz`) and served from cache on repeat requests within 24 hours

### Intraday intervals (5m, 15m, 30m, 1h)

Source: `charting.nseindia.com` charting API.

```
GET https://charting.nseindia.com/charts/getData
    ?appid=chartiq&symbol={SYMBOL}&period={5|15|30|60}
    &startDate={DD-MM-YYYY}&endDate={DD-MM-YYYY}
```

Response:
```json
{ "grapthData": [[timestamp_ms_ist, open, high, low, close, volume], ...] }
```

Note: `grapthData` is a typo in the NSE API — preserved intentionally.

Timestamps are IST milliseconds; converted to UTC epoch seconds via:
```
utc_epoch_s = int(ts_ms_ist / 1000) - 19800
```

Intraday candles are cached in Redis (`scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}`) with a 3600 s TTL.

### Date parsing

Both `YYYY-MM-DD` bare dates and full ISO 8601 datetime strings (`2025-09-03T13:20:52.952Z`) are accepted. The `_parse_iso_date()` function strips the `T...` suffix before parsing:

```python
date_part = value.split("T")[0]   # "2025-09-03T13:20:52.952Z" → "2025-09-03"
return date.fromisoformat(date_part)
```

---

## 10. Option Chain Scraper

The NSE option chain page requires a headless browser because the chain data is loaded by a client-side XHR after the Angular SPA boots. Direct HTTP requests return the HTML shell without data.

### NSE fetch flow

1. Session is created with `capture_xhr="api/option-chain|GetOptionChain"` at the constructor level.
2. Homepage pre-warm (`https://www.nseindia.com`, `wait=2000`) establishes session cookies.
3. Option chain page is fetched (`https://www.nseindia.com/option-chain`, `wait=4000`).
4. `page.captured_xhr` is searched for a response whose URL contains `"option-chain"`.
5. The JSON payload is parsed: `records.data` → rows, `records.expiryDates`, `records.underlyingValue`.
6. Analytics are computed: PCR (OI + volume), max pain, ATM IV, OI walls.

### Analytics

| Metric | Computation |
|---|---|
| `pcrOi` | `total_PE_OI / total_CE_OI` |
| `pcrVolume` | `total_PE_volume / total_CE_volume` |
| `maxPain` | Strike `S*` minimizing `Σ[max(0, S*−k)×CE_OI_k + max(0, k−S*)×PE_OI_k]` |
| `atmIv` | Mean IV of up to 5 nearest strikes where `OI > 0` and `iv` is not null |
| `maxCeOiStrike` | Strike with highest CE open interest |
| `maxPeOiStrike` | Strike with highest PE open interest |

### BSE fallback

For BSE, the `GetOptionChain` XHR is captured from `bseindia.com/markets/Derivatives/DerivativeHome.aspx`. BSE column names differ from NSE; the parser handles both.

---

## 11. Tick Publisher

`src/publisher/tick_publisher.py` — polls live quotes every 5 seconds and publishes to Redis.

### Poll loop

```python
_POLL_INTERVAL = 5.0  # seconds

async def _tick_loop(self):
    while not self._stop_event.is_set():
        poll_start = loop.time()
        await self._poll_and_publish()
        # Sleep remainder of 5s window in 100ms slices (responsive to stop)
        ...
```

### Publish format

Channel: `af:ticks:{SYMBOL}` (e.g. `af:ticks:NIFTY`)

Payload: JSON-serialized `LiveTick`:
```json
{
  "symbol": "NIFTY",
  "ltp": 23873.45,
  "change": -41.0,
  "changePct": -0.17,
  "receivedAtMs": 1788434580000
}
```

### Symbol management

The tracked symbol set is runtime-configurable via the publisher API:
```
POST /publisher/symbols  { "symbols": ["NIFTY", "RELIANCE"] }
DELETE /publisher/symbols/RELIANCE
```

---

## 12. Anti-Ban Layer

### ProxyManager

Maintains an optional pool of HTTPS proxy URLs. On ban detection or rotation trigger, `rotate()` advances the pool and returns the next proxy. `active_proxy_masked()` returns the host only (password redacted) for safe logging.

### BanDetector

`is_banned(html: str) → bool` — checks the response body for NSE ban signatures (CAPTCHA challenges, "access denied" text, Akamai bot detection pages). Increments `ban_count` on each detection.

### SessionWarmer

Background task that warms the Playwright session every 30 minutes during IST market hours (09:15–15:30). Outside market hours the loop sleeps and checks again.

Each warm attempt:
1. Creates a **fresh, ephemeral** `AsyncDynamicSession` (does not share cookies with scraper singletons — the warm verifies that a cold session can reach NSE).
2. Visits the NSE homepage to establish session cookies.
3. Navigates to the option-chain page and verifies the `api/option-chain` XHR is captured.
4. If the XHR is missing → `session_warmer_no_xhr_captured` warning, retry with backoff.
5. If body matches ban signatures → `BanError`, rotates proxy, retries up to `MAX_BAN_RETRIES=5`.

### Rate Limiters

`src/anti_ban/rate_limiter.py` — per-domain token-bucket limiters. All `httpx` requests to NSE/BSE must call `await limiter.acquire()` before sending. Configured via `NSE_RATE_LIMIT` and `BSE_RATE_LIMIT` env vars.

---

## 13. Redis Schema

| Key pattern | Type | TTL | Written by | Read by |
|---|---|---|---|---|
| `af:ticks:{SYMBOL}` | Pub/Sub channel | — | `tick_publisher` | Next.js `useLiveQuotes` hook |
| `scraping:quote:{exchange}:{symbol}` | String (JSON) | 5 s | `live_quotes` route | `live_quotes` route (cache check) |
| `scraping:chain:{underlying}:{expiry}:{exchange}` | String (JSON) | 20 s | `option_chain` route | `option_chain` route (cache check) |
| `scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}` | String (JSON) | 3600 s | `historical` route | `historical` route (cache check) |

---

## 14. Bug-Fix Log

This section documents every defect found and fixed. V1 bugs were fixed during the initial deployment hardening sprint (2026-09-03). V2 bugs are semantic/infrastructure fixes from the V2 certification sprint. All are resolved.

---

### BUG-01 — `duplicate base class TimeoutError` (Redis startup failure)

**Symptom:** Service started in degraded mode every time; `redis_connect_failed error=duplicate base class TimeoutError` in logs.

**Root cause:** `aioredis==2.0.1` defines an exception class inheriting from both `asyncio.TimeoutError` and the built-in `TimeoutError`. In Python 3.11, `asyncio.TimeoutError` was aliased to the built-in `TimeoutError`, making them the same class. Inheriting from both raises a `TypeError` on import.

**Fix:**
- `requirements.txt`: `aioredis==2.0.1` → `redis[hiredis]==5.0.8`
- `server.py`: `import aioredis` → `import redis.asyncio as aioredis` (identical API)
- `server.py` shutdown: `await _redis_client.close()` → `await _redis_client.aclose()` (`redis` 5.x naming)

**Files changed:** `data-service/requirements.txt`, `data-service/src/server.py`

---

### BUG-02 — `Context manager has been closed` (all fetches fail immediately)

**Symptom:** Every `batch_fetch_error` and `single_fetch_error` log line showed `error=Context manager has been closed` starting from the first tick publisher poll cycle.

**Root cause:** `get_quote_session()` and `get_chain_session()` called `AsyncDynamicSession(**kwargs)` to create the singleton but never called `__aenter__()`. Scrapling marks the session as closed until `__aenter__` is called, so every subsequent `fetch()` raised `RuntimeError: Context manager has been closed`.

**Fix:** After constructing the raw instance, call `await raw.__aenter__()` and store both objects:
```python
raw = AsyncDynamicSession(**session_kwargs)
entered = await raw.__aenter__()   # ← initialises the Playwright browser
_quote_session_raw = raw            # ← kept for __aexit__ during reset
_quote_session = entered            # ← what fetch() is called on
```
`reset_quote_session()` updated to call `await _quote_session_raw.__aexit__(None, None, None)` instead of `.close()`.

Same fix applied to `get_chain_session()` / `reset_chain_session()` in `option_chain.py`.

`session_warmer._warm_session()` was also affected — it created a bare `DynamicSession` and called `fetch()` directly. Fixed by converting to `async with DynamicSession(...) as session:`.

**Files changed:** `data-service/src/scrapers/live_quotes.py`, `data-service/src/scrapers/option_chain.py`, `data-service/src/anti_ban/session_warmer.py`

---

### BUG-03 — `ERR_NAME_NOT_RESOLVED` (Playwright cannot resolve external DNS)

**Symptom:** After BUG-01 and BUG-02 were fixed, Playwright fetch calls failed with `Page.goto: net::ERR_NAME_NOT_RESOLVED` for every hostname. Python `socket.getaddrinfo()` on the same hostname worked correctly.

**Root cause:** Docker's embedded DNS resolver listens on `127.0.0.11` (a loopback address). Python's `libc`-based resolver uses it without issue. Chromium's built-in async DNS resolver **explicitly rejects loopback nameserver addresses** as a security measure. Without a valid external nameserver, Chromium cannot resolve any hostname.

**Fix:** Added explicit DNS servers to the `data-service` in `docker-compose.yml`:
```yaml
data-service:
  dns:
    - 8.8.8.8
    - 8.8.4.4
```

**Files changed:** `docker-compose.yml`

---

### BUG-04 — `batch_xhr_not_captured` / `single_xhr_not_captured` (NSE API redesign)

**Symptom:** After DNS was fixed, the service reached NSE successfully (HTTP 200 on page loads) but `page.captured_xhr` was always empty. Both `batch_xhr_not_captured` and `single_xhr_not_captured` warnings fired on every tick publisher cycle.

**Root cause (part A — `capture_xhr` misuse):** `capture_xhr` is a session-level constructor argument in Scrapling 0.4.x. It was being passed to `session.fetch(capture_xhr=...)` instead. `validate_fetch()` only processes fields in `PlaywrightFetchParams`; `capture_xhr` is not in that TypedDict and is silently discarded. The response handler always looked for `self._config.capture_xhr` which was `None`.

**Root cause (part B — NSE API migration):** NSE completely migrated their frontend from Angular to Next.js in mid-2026. The old `equity-stockIndices` and `api/quote/equity` XHR endpoints no longer exist. The new endpoints are under `api/NextApi/`:
- `api/NextApi/apiClient?functionName=getIndexData&&type=All` — index quotes
- `api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20200` — equity constituents

These endpoints return JSON directly via standard HTTP — no browser needed.

**Root cause (part C — `network_idle=True` hangs):** NSE's SPA polls continuously. `network_idle=True` waits for Playwright's `networkidle` state (no requests for 500ms) which never arrives. All `session.fetch()` calls with `network_idle=True` hung until the Playwright timeout.

**Fix:**
1. Moved `capture_xhr` to the `AsyncDynamicSession(...)` constructor for option chain scraping.
2. Replaced the entire browser-based live-quote scraper with `httpx` calls to the new `NextApi` endpoints — faster, more reliable, no browser required for quotes.
3. Added `_fetch_index_quotes()` for index symbols (`getIndexData&&type=All`).
4. Changed all NSE page fetches from `network_idle=True` to `network_idle=False, wait=N`.
5. Added NSE homepage pre-warm after session `__aenter__` to establish cookies before any data fetch.

**Files changed:** `data-service/src/scrapers/live_quotes.py`, `data-service/src/scrapers/option_chain.py`, `data-service/src/anti_ban/session_warmer.py`, `data-service/src/publisher/tick_publisher.py`

---

### BUG-05 — `GET /scraping/historical` → 400 for all frontend requests

**Symptom:** The Next.js app was receiving HTTP 400 for every `/scraping/historical` request. Log showed `'from' must be a valid ISO 8601 date (YYYY-MM-DD), got '2025-09-03T13:20:52.952Z'`.

**Root cause:** The frontend sends full ISO 8601 datetime strings (with `T` and timezone suffix). The `_parse_iso_date()` helper called `date.fromisoformat(value)` directly, which rejects anything beyond `YYYY-MM-DD` in Python 3.10's implementation.

**Fix:** Strip the time component before parsing:
```python
date_part = value.split("T")[0]
return date.fromisoformat(date_part)
```

Both `YYYY-MM-DD` and `YYYY-MM-DDThh:mm:ssZ` formats now work correctly.

**Files changed:** `data-service/src/scrapers/historical.py`

---

### BUG-06 — `single_xhr_not_captured symbol=^NSEI` flooding logs (spurious warning)

**Symptom:** `[warning] single_xhr_not_captured symbol=^NSEI` appeared every few seconds in logs, triggered by the Next.js app querying a Yahoo Finance-style ticker.

**Root cause:** `^NSEI` is a Yahoo Finance convention for the NSE Nifty 50 index. It is not a valid NSE trading symbol. It was falling through all routing checks, reaching the NIFTY 500 endpoint, failing to match any constituent, and logging a `warning`.

**Fix:** Added an early guard in `_fetch_single_quote()` that rejects symbols starting with `^` or containing `.` (Yahoo Finance format) at `debug` level instead of `warning`. Also downgraded the "symbol not found in NIFTY 500" log from `warning` to `debug`.

**Files changed:** `data-service/src/scrapers/live_quotes.py`

---

## 15. Known Limitations (V1 — Deployment Sprint)

| Limitation | Detail |
|---|---|
| `nse_daily_http_error 403` | NSE archives returns HTTP 403 for some recent and holiday-adjacent dates. The scraper logs a warning, skips the day, and continues. This is an NSE server-side restriction, not a code bug. |
| Option chain — NIFTY 500 coverage | `_fetch_single_quote()` falls back to the NIFTY 500 constituent list. Symbols outside NIFTY 500 (e.g. small-cap equities) return `null`. |
| Index volume | The `getIndexData&&type=All` endpoint does not expose traded volume for index symbols. `volume` and `oi` are `null` for NIFTY, BANKNIFTY, etc. |
| Session warmer isolated | The session warmer creates its own ephemeral browser session. Cookies it establishes do not carry over to the scraper singletons. The 30-min warm is a health/anti-ban check, not a cookie seed. |
| BSE daily Bhavcopy | BSE's ZIP archive format occasionally changes the inner CSV filename casing. The scraper does a case-insensitive name match but may miss edge cases. |
| Intraday `grapthData` typo | The NSE charting API's `grapthData` key is a known NSE-side typo. If NSE fixes the typo, the intraday scraper will silently return 0 candles until `src/scrapers/historical.py` is updated. |

---

## 16. Development Guide (Quick Reference)

### Running locally (without Docker)

```bash
cd data-service
pip install -r requirements.txt
pip install "scrapling[fetchers]==0.4.*" && scrapling install
REDIS_URL=redis://localhost:6379/0 uvicorn src.server:app --port 8200 --reload
```

### Running with Docker Compose

```bash
# Start Redis + data-service
docker compose up data-service --build

# Tail logs
docker logs alpha-forge-data -f

# Health check
curl http://localhost:8200/health

# Test a quote
curl "http://localhost:8200/scraping/quotes?symbols=NIFTY,BANKNIFTY,RELIANCE"

# Test historical (datetime string format accepted)
curl "http://localhost:8200/scraping/historical?symbol=RELIANCE&exchange=NSE&interval=1d&from=2026-08-01T00:00:00Z&to=2026-09-03T00:00:00Z"
```

### Testing the NSE NextApi endpoints directly

```bash
# Index data
curl -H "Referer: https://www.nseindia.com/" \
  "https://www.nseindia.com/api/NextApi/apiClient?functionName=getIndexData&&type=All"

# NIFTY 200 constituents
curl -H "Referer: https://www.nseindia.com/" \
  "https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20200"
```

### Adding a new symbol to the tick publisher

```bash
curl -X POST http://localhost:8200/publisher/symbols \
  -H "Content-Type: application/json" \
  -d '{"symbols": ["HDFCAMC", "PIDILITIND"]}'
```

### Checking Redis tick data

```bash
# Subscribe to a tick channel
redis-cli SUBSCRIBE af:ticks:NIFTY

# List all tick channels
redis-cli KEYS "af:ticks:*"
```

---

## 17. Data Quality Infrastructure (V2)

### Semantic Integrity (Phase 3 — CRITICAL FIX)

**The most important V2 fix:** `oi` was previously mapped from `totalTradedValue` (INR amount), not from actual open interest. This is now fixed.

| Field | Meaning | NSE Source |
|-------|---------|-----------|
| `oi` | Open interest (contracts) | `openInterest` — F&O only; `null` for equity |
| `tradedValue` | INR traded value | `totalTradedValue` — NEVER mapped to OI |
| `volume` | Share/contract count | `totalTradedVolume` |

### V2 New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health/live` | Process liveness — always 200 |
| `GET` | `/health/ready` | Dependency readiness (Redis, publisher) |
| `GET` | `/health/data` | Data quality status (freshness, gaps) |

### Data Quality Gate

The signal engine should check `DataQualityGate.signalEngineAllowed` before using any data:

```python
from src.core.data_quality import build_quality_gate

gate = build_quality_gate(
    quote_age_ms=quote_age,
    symbol="NIFTY",
    provider_healthy=True,
)
if gate.signalEngineAllowed:
    # proceed with signal generation
```

### Data Confidence Score

Every observation carries a confidence score (0–95). Never 100.

```
FRESH data + COMPLETE + HEALTHY provider + VALID timestamp ≈ 92
STALE data (45s) + COMPLETE + HEALTHY provider ≈ 57
HTTP 200 alone: NOT reported as 100
```

### Freshness Tiers

| Tier | Symbols | FRESH threshold |
|------|---------|----------------|
| INDEX | NIFTY, BANKNIFTY, etc. | <10s |
| FNO_LIQUID | RELIANCE, HDFCBANK, etc. | <10s |
| FNO_NORMAL | Other F&O | <15s |
| EQUITY | Non-F&O | <30s |
| OFFMARKET | Outside session | <300s |

### Candle Builder V2

Intraday candles are anchored to NSE session open (09:15 IST):

```python
from src.engines.candle_builder import CandleBuilderV2

builder = CandleBuilderV2("NSE:NIFTY", "5m", symbol="NIFTY")
closed_candle, partial_candle = builder.update(ltp=24850.0, event_time_ms=ts_ms)
# closed_candle is None until slot advances
# partial_candle.isComplete = False (signal engine must not use as confirmed)
```

### Symbol Normalization

```python
from src.core.symbol_normalizer import symbol_normalizer

symbol_normalizer.normalize("NSE:RELIANCE")  # → "RELIANCE"
symbol_normalizer.normalize("^NSEI")          # → "NIFTY"
symbol_normalizer.normalize("RELIANCE.NS")    # → "RELIANCE"
symbol_normalizer.normalize("NIFTY 50")       # → "NIFTY"
```

### Upstox Broker Client (wired in V3.1)

`src/brokers/upstox_client.py` — the Python broker API client for fallback data
when NSE scraping is unavailable. It exposes **module-level async functions**
(not a `UpstoxClient` class) and reads its bearer token from
`UPSTOX_ANALYTICS_TOKEN` (preferred) or `UPSTOX_ACCESS_TOKEN`. Callers pass plain
symbols — equity symbols are resolved to Upstox ISIN instrument keys internally
by `upstox_instruments.py`, so you never build `NSE_EQ|...` keys by hand:

```python
from src.brokers import upstox_client

# Plain symbols in — ISIN resolution + interval mapping happen internally.
quotes = await upstox_client.get_quotes(["NIFTY", "RELIANCE"])   # {sym: MDQuote}
candles = await upstox_client.get_historical_candles(
    "RELIANCE", "1d", from_date, to_date, exchange="NSE",
)
```

**V3.1 changes:** this client was previously **dead code** (nothing imported it).
It is now wired via `brokers/router.py` and hardened with pooled keep-alive
clients and the typed `ProviderError` hierarchy (`core/provider_http.py`). When no
token is configured every method returns empty results (no crash). See §21 for
the reliability core and the API-conformance report for the Upstox v2/v3
deviations that were fixed.

---

## 18. V2 Bug-Fix Log

### BUG-SEMANTIC-01 — `oi` mapped to `totalTradedValue` [P0, FIXED in V2]

`oi=_int(item.get("totalTradedValue"))` → produces OI = 4,275,000,000 for RELIANCE (INR amount, not contracts). **Fixed to `oi=None` for all equity quotes.**

### BUG-SESSION-WARMER-01 — Warmer didn't refresh production sessions [HIGH, FIXED in V2]

Session warmer created an ephemeral browser; production singletons were never refreshed. **Fixed: warmer now calls `reset_quote_session()` and `reset_chain_session()` after successful warm.**

### BUG-HTTP-POOL-01 — New TCP connection per request [MEDIUM, FIXED in V2]

`async with httpx.AsyncClient() as client:` inside every fetch created a new TLS connection per call. **Fixed: persistent `AsyncClient` singleton with keep-alive.**

### BUG-MAXPAIN-01 — O(N²) max pain computation [MEDIUM, FIXED in V2]

`compute_max_pain()` called `pain_at(s)` twice per candidate strike, each iterating all N rows. **Fixed to O(N log N) using prefix/suffix sums. 200 strikes: <2ms measured.**

### BUG-DOUBLE-PUBLISH-01 — Double pub/sub publish on every tick [MEDIUM, FIXED post-V2.1]

**Commit:** `c8d80a1`  
**Files:** `data-service/src/publisher/tick_publisher.py`, `data-service/src/publisher/stream_publisher.py`

`_publish_to_stream()` in `TickPublisher` called `stream_publisher.publish_tick(tick_v2)`. `publish_tick` does two things: (1) publishes to the Redis pub/sub channel **and** (2) appends to the Redis Stream. Since `tick_publisher` had already published to the pub/sub channel directly above, every tick was appearing twice on the pub/sub channel and the stream was being written twice.

**Fix:** Changed `_publish_to_stream()` to call `stream_publisher._stream_append(tick_v2, payload, "NORMAL")` directly — this appends to the durable Stream only, without re-publishing to pub/sub. The pub/sub publish path remains solely in `TickPublisher._publish_tick()`. A code comment was added to `stream_publisher.publish_tick()` clarifying that callers who have already published to pub/sub should use `_stream_append` directly.

*(For V1 deployment sprint bugs BUG-01 through BUG-06, see §14 Bug-Fix Log above.)*

### BUG-RECONNECT-01 — `tick_publisher.py` reconnect uses stale `aioredis` import [HIGH, FIXED 2026-09-04]

`TickPublisher._try_create_redis()` called `import aioredis`. The `aioredis` package was replaced by `redis[hiredis]` in BUG-01 and is no longer installed. After any Redis blip, every reconnect attempt raised `ModuleNotFoundError: No module named 'aioredis'`, parking the publisher in `running="reconnecting"` indefinitely. Tick delivery stopped until the container was restarted.

**Fix:** Changed `import aioredis` → `import redis.asyncio as aioredis` in `_try_create_redis`. Consistent with the rest of the module.

**Files changed:** `data-service/src/publisher/tick_publisher.py`

### BUG-DUPLICATE-CONST-01 — `live_quotes.py` duplicate `_SESSION_TIMEOUT` constant [LOW, FIXED 2026-09-04]

`_SESSION_TIMEOUT: float = 12.0` was declared twice at module scope (lines 80 and 124). The duplicate was dead code introduced by a merge conflict resolution. No runtime impact but flagged by static analysis.

**Fix:** Removed the duplicate declaration at line 124.

**Files changed:** `data-service/src/scrapers/live_quotes.py`

---

## 19. Known Limitations (Updated V2)

| Limitation | Detail | V2 Status |
|-----------|--------|-----------|
| Equity OI unavailable | NSE NextApi does not expose equity OI | `oi=null` (correct behavior) |
| No Greeks from NSE | NSE public option chain has no delta/gamma/theta/vega | `null` fields — not zero |
| Index volume unavailable | `getIndexData&&type=All` doesn't expose volume | `volume=null` |
| NIFTY 500+ symbols slower | Single-symbol path, one HTTP request each | Known limitation |
| `grapthData` typo in NSE charting API | NSE-side typo preserved intentionally | Monitored |
| No adjusted historical prices | NSE Bhavcopy is raw exchange prices | Use Yahoo for adjusted |
| 5s polling = near-real-time | Not exchange tick-by-tick | Documented |
| BSE daily is slow (per-day downloads) | ~260s for 5 years on one symbol | Use Yahoo for BSE history |
| GATE-001 — TS signal engine not wired to the Python `POST /data/gate` | The Python HTTP gate is still not called by the TS signal engine. V3.1 added an **in-process** TS gate (`evaluateSignalGate` in `reconciliation.service.ts`) that blocks STALE/INVALID data from SIGNAL/ML/EXECUTION, which mitigates but does not replace the server-side gate. | **Partially mitigated (V3.1); still open for LEVEL 3 cert** |
| Live provider scenarios not exercised (V3.1) | Real 403/429/503 over the wire, live dual-WS hot-failover latency, and production cache-hit % are verified deterministically with mocks, not against live providers. | **NOT EXECUTED — credentials/market-hours required** (see §21.7) |

---

## 20. Development Guide (Full)

### Running Tests

```bash
cd data-service
# Fast suite (no live network)
python3 -m pytest tests/ --ignore=tests/scrapers/test_historical.py \
  --ignore=tests/scrapers/test_instrument_master.py \
  --ignore=tests/scrapers/test_option_chain.py \
  --ignore=tests/publisher/ --ignore=tests/pbt/ -q

# Full suite (some tests may need live network)
python3 -m pytest tests/ -q
```

### Key V2 Modules

```bash
# Test semantic integrity (critical — must always pass)
python3 -m pytest tests/core/test_semantic_integrity.py -v

# Test max pain performance
python3 -m pytest tests/scrapers/test_max_pain_performance.py -v

# Test timestamp engine
python3 -m pytest tests/engines/test_timestamp_engine.py -v
```

### V2 Data Flow Verification

```bash
# Check health
curl http://localhost:8200/health/live
curl http://localhost:8200/health/ready
curl http://localhost:8200/health/data

# Verify OI is null for equity (semantic fix)
curl "http://localhost:8200/scraping/quotes?symbols=RELIANCE" | python3 -m json.tool | grep '"oi"'
# Expected: "oi": null
# If "oi": <large_number> — semantic regression has occurred
```

### Checking Data Quality

```python
from src.engines.freshness_engine import freshness_engine
from src.core.data_quality import build_quality_gate

# Check if a quote is fresh enough for signals
quote_age_ms = 5000  # 5 seconds
gate = build_quality_gate(quote_age_ms, symbol="NIFTY")
print(gate.signalEngineAllowed)  # True if all gates pass
print(gate.confidenceScore)      # 0–95
print(gate.blockReason)          # None or explanation
```

---

## 21. Reliability & Failover Core (V3.1)

V3.1 hardens the acquisition chain `data-service → Angel One → Upstox → Yahoo`
against provider-level failures. The upgrade was applied to **both** layers: the
Python `data-service` (this microservice) and the TypeScript `src/lib/market-data/`
provider chain that consumes it. Full deterministic evidence lives in
[`DATA_SERVICE_RELIABILITY_CERTIFICATION.md`](./DATA_SERVICE_RELIABILITY_CERTIFICATION.md).

> **Where the provider chain actually lives.** The failover / circuit-breaker /
> registry logic runs in the **TypeScript** layer (`Scrapling(data-service, prio 0)
> → Angel One → Upstox → Yahoo`). The Python `data-service` is the credential-free
> NSE/BSE scraper surfaced as the `scrapling` tier-0 provider, plus an authorized
> Upstox REST client used as a classified fallback source.

### 21.1 Python — `core/provider_http.py`

A typed HTTP core shared by the broker + historical-repair paths:

| Piece | Behaviour |
|---|---|
| `ProviderError` hierarchy | `ProviderAuthenticationError` (401), `ProviderAuthorizationError` (403), `InstrumentNotFoundError` (404), `ProviderRateLimitError` (429), `ProviderUnavailableError` (503), `ProviderTimeoutError`, `ProviderNetworkError`, `ProviderMalformedResponseError` — each carries `retryable` + `retry_after_ms` |
| `classify_status(code)` | Status-code-driven classification (not fragile string matching) |
| `parse_retry_after_ms(...)` | Honours a provider `Retry-After` header (seconds or HTTP-date), capped at 60s |
| Backoff ladder | `1s → 2s → 4s → 8s → 16s → 30s → 60s` with jitter; provider `Retry-After` wins |
| `resilient_get(...)` | **Never retries** 403/401/404; retries 503/timeout/network with backoff; `sleep` is injectable so tests are deterministic (no real time) |
| Pooled clients | Keep-alive `httpx.AsyncClient` pools instead of a new TLS connection per call |

### 21.2 Python — capability-aware `GET /health/providers`

Reports each provider's health per capability (`live` / `historical` /
`option_chain`) derived from circuit-breaker state, so a `503` on NSE/Angel
*historical* marks only that capability `DEGRADED` while `live` stays `HEALTHY`.
The overall status is `HEALTHY`/`DEGRADED` — **never `DOWN` just because one
provider capability is down**. Untouched capabilities appear as `UNKNOWN` rather
than silently missing.

### 21.3 Python — cache-first historical + validated gap repair

`scrapers/historical_repair.py`:

- **Provider-independent cache key** (same key regardless of provider/case) + a
  **data fingerprint** so identical validated data is never re-downloaded.
- **Gap detection** flags missing intervals (none for contiguous series).
- A **gap-repair coordinator** validates every repaired candle before use;
  invalid repairs are rejected and the next provider is tried. When there are no
  gaps, **zero provider requests** are made.

### 21.4 Python — duplicate-tick protection

The tick publisher computes a deterministic event id per observation and skips
duplicates (`event_dedup.is_duplicate`) before publishing, so a provider failover
or a repeated poll returning an unchanged quote never double-counts a tick. A
continuity gap detector (`tick_gap_detector`) records gaps without blocking the
tick that *is* available. Duplicate rate + recent gaps are surfaced on
`/health/data`.

### 21.5 Schema — `ProviderId` widened

`data-service/src/schemas.py` previously declared `provider: Literal["scrapling"]`,
which rejected **every** `MDQuote(provider="upstox", …)` with a `ValidationError`
— silently breaking the Upstox path. `ProviderId` is now
`Literal["scrapling", "angel_one", "upstox", "yahoo"]` (mirroring the TypeScript
`ProviderId`) on `MDQuote`, `LiveTick`, and `OptionChain`; the default stays
`"scrapling"` for the NSE/BSE scraper paths.

### 21.6 TypeScript side (`src/lib/market-data/`) — summary

The consuming layer gained: status-driven error classification with `httpStatus`
+ `retryAfterMs`, a `Retry-After`-honouring backoff ladder, **capability-aware
circuit breakers** (keyed by `providerId` *and* `providerId::capability`), a
shared single-flight cache + token-bucket rate limiter on the Scrapling provider,
never-silent `PROVIDER_SWITCH` records, a signal-engine data gate
(`evaluateSignalGate` blocks STALE/INVALID data from SIGNAL/ML/EXECUTION while the
UI may show a flagged last-known value), and tiered cross-provider reconciliation
(`reconcileQuotes` → MATCH / WITHIN_TOLERANCE / MINOR_MISMATCH / MAJOR_MISMATCH /
INVALID).

**Live WebSocket fixes (see [`DATA_SERVICE_API_CONFORMANCE.md`](./DATA_SERVICE_API_CONFORMANCE.md)):**

- **Upstox** migrated to the **v3** feed — the v2 authorize endpoint now returns
  HTTP 410 (`UDAPI1153`). The v3 feed streams binary **Protobuf** frames, decoded
  in-process by a dependency-free wire-format decoder
  (`src/lib/market-data/providers/upstox-proto.ts`), and the `sub` control frame
  must be sent as **binary**. Live-validated at 158 ticks/20s.
- **Angel One** SmartStream WS never started because the provider imported the
  module-private `resolveConfig`/`sessions` bindings (always `undefined`) and so
  never obtained the feed token. Fixed by exporting `resolveAngelWsSession()`.
  Live-validated at 143 ticks/20s with a measured Angel→Upstox failover.

### 21.7 What was NOT executed

Live, credential-gated end-to-end scenarios (real 403/429/503 over the wire, live
dual-WS hot-failover latency, live cross-provider reconciliation, production
cache-hit %) are exercised **deterministically** via mocked transports and fault
injection, but were **NOT EXECUTED** against real providers in the certification.
They are reported honestly as pending access, not as passing. See §5 of the
reliability certification report.

---

## 22. V3.1 Bug-Fix Log

Defects found and fixed on `refactor/data-service` (PR #29). Every fix carries a
regression test. See the two certification reports for the full evidence matrices.

### BUG-UPSTOX-DEADCODE-01 — `brokers/upstox_client.py` was never wired [HIGH, FIXED V3.1]

`DATA_SERVICE.md` (V3.0) claimed the Upstox client was "wired in" as a secondary
quote source. It was in fact **dead code** — nothing imported it. **Fixed:** wired
via `brokers/router.py` (`/brokers/upstox/{status,quotes,historical}`) and
hardened with pooled clients + the typed `ProviderError` hierarchy.

**Files:** `data-service/src/brokers/router.py` (new), `data-service/src/brokers/upstox_client.py`, `data-service/src/server.py`

### BUG-PROVIDER-LITERAL-01 — Upstox quotes silently rejected by schema [HIGH, FIXED V3.1]

`schemas.py` declared `provider: Literal["scrapling"]`, so the Upstox client
constructing `MDQuote(provider="upstox", …)` raised a `ValidationError` for
**every** quote — the Upstox quote path silently returned nothing. **Fixed:**
widened `ProviderId` to `["scrapling","angel_one","upstox","yahoo"]` on
`MDQuote`/`LiveTick`/`OptionChain` (default stays `"scrapling"`).

**Files:** `data-service/src/schemas.py`

### BUG-UPSTOX-CHANGEPCT-01 — Python client read a non-existent field [MEDIUM, FIXED V3.1]

The Python Upstox client read `net_change_percentage` (absent from the live API)
→ always null. **Fixed:** compute `changePct = net_change / ohlc.close × 100`
(matching the TS provider), correct `prevClose`, and populate
`totalBuyQty/totalSellQty` from `total_buy_quantity/total_sell_quantity`.

**Files:** `data-service/src/brokers/upstox_client.py`

### BUG-UPSTOX-KEYS-01 — Wrong equity keys + unsupported intervals [MEDIUM, FIXED V3.1]

The Python client built symbol-based equity keys (`NSE_EQ|RELIANCE`, which Upstox
rejects) and its interval map contained values Upstox v2 rejects (`3m/5m/10m/15m/1h/60minute`
→ HTTP 400 `UDAPI1020`). **Fixed:** added `upstox_instruments.py` (symbol→ISIN
resolver, 12h cache); restricted the interval map to the verified set
(`1minute/30minute/day/week/month`); unsupported intervals now return `[]` so the
chain fails over instead of 400-ing.

**Files:** `data-service/src/brokers/upstox_instruments.py` (new), `data-service/src/brokers/upstox_client.py`

### BUG-DEDUP-01 — Ticks could be double-counted across failover [MEDIUM, FIXED V3.1]

A failover between providers (or a repeated poll returning the same unchanged
quote) produced duplicate observations for the same event. **Fixed:** a
deterministic event id + `event_dedup.is_duplicate` guard in the publish loop
suppresses duplicates; a gap detector records continuity gaps without blocking
the available tick.

**Files:** `data-service/src/publisher/tick_publisher.py`

*(TypeScript-side reliability and live-WebSocket fixes — capability-aware
breakers, Retry-After backoff, reconciliation, the Upstox v3 Protobuf feed, and
the Angel `resolveAngelWsSession()` fix — are documented in
[`DATA_SERVICE_API_CONFORMANCE.md`](./DATA_SERVICE_API_CONFORMANCE.md) and
[`DATA_SERVICE_RELIABILITY_CERTIFICATION.md`](./DATA_SERVICE_RELIABILITY_CERTIFICATION.md).)*
