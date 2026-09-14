# ALPHAFORGE OLD DATA SERVICE INVENTORY

**Date:** 2026  
**Branch:** `refactor/data-service-centralization`  
**Purpose:** Complete inventory of the old embedded Python data service and the AlphaForge internal market-data layer, documenting what must be removed.

---

## Part 1 — Old Python Data Service (`data-service/`)

### 1.1 Overview

The `data-service/` directory at the repository root is an **embedded Python FastAPI microservice** that serves as AlphaForge's historical market-data scraping layer. It was built to acquire NSE/BSE data via the `jugaad` and `openchart` Python libraries (which wrap the NSE charting API and BSE bhavcopy respectively) without requiring broker credentials.

It is **not** data-service2.0. It predates data-service2.0 and is the service currently referenced by `DATA_SERVICE_URL`.

**Entry point:** `data-service/src/server.py`  
**Default port:** `8200` (via `DATA_SERVICE_PORT` env var)  
**Technology:** Python, FastAPI, Redis, PostgreSQL (own schema)

### 1.2 Complete File Listing

```
data-service/
├── Dockerfile
├── RELIABILITY_ASSESSMENT.md
├── pyproject.toml
├── requirements.txt
├── docs/
├── reports/
├── scripts/
├── tests/
└── src/
    ├── __init__.py
    ├── config.py
    ├── schemas.py                     ← Canonical Pydantic models (mirrors TS types)
    ├── server.py                      ← FastAPI app factory + lifespan
    │
    ├── anti_ban/                      ← Anti-ban / anti-scraping layer
    │   ├── __init__.py
    │   ├── ban_detector.py            ← HTTP 403/429 ban detection
    │   ├── proxy_manager.py           ← Proxy rotation
    │   ├── rate_limiter.py            ← Token bucket rate limiting
    │   └── session_warmer.py          ← Chromium/browser session warm-up (NSE requires cookies)
    │
    ├── brokers/                       ← Broker integrations (Upstox data path in old service)
    │   ├── __init__.py
    │   ├── router.py                  ← Broker data routing
    │   ├── upstox_client.py           ← Upstox API client (data use, not execution)
    │   └── upstox_instruments.py      ← Upstox instrument key resolution
    │
    ├── core/                          ← Infrastructure / cross-cutting concerns
    │   ├── __init__.py
    │   ├── circuit_breaker.py         ← Provider circuit breaker
    │   ├── data_quality.py            ← Data quality validation
    │   ├── deduplication.py           ← Candle/tick deduplication
    │   ├── gate_router.py             ← `/data/gate` endpoint logic (quality gate)
    │   ├── lineage.py                 ← Data provenance tracking
    │   ├── nse_session.py             ← NSE session management (cookie/browser state)
    │   ├── provider_http.py           ← Shared HTTP client with retry/timeout
    │   ├── request_context.py         ← Request context propagation
    │   ├── schemas_v2.py              ← V2 schema updates
    │   ├── security.py                ← API key / auth middleware
    │   └── symbol_normalizer.py       ← Symbol normalization (NSE → canonical)
    │
    ├── engines/                       ← Data processing engines
    │   ├── __init__.py
    │   ├── candle_builder.py          ← OHLCV candle construction from ticks
    │   ├── freshness_engine.py        ← Data freshness tracking and staleness detection
    │   ├── market_session.py          ← NSE market session state (open/closed/pre/post)
    │   └── timestamp_engine.py        ← Timestamp normalization and validation
    │
    ├── monitoring/                    ← Health and monitoring endpoints
    │
    ├── providers/                     ← Data source adapters
    │   ├── __init__.py
    │   ├── common/                    ← Shared provider infrastructure
    │   │   ├── __init__.py
    │   │   ├── acquisition_planner.py ← Decides which provider to use for a given request
    │   │   ├── normalizer.py          ← Response normalization
    │   │   ├── provenance.py          ← Provenance metadata
    │   │   ├── quality.py             ← Quality scoring
    │   │   ├── reconciliation.py      ← Cross-provider reconciliation
    │   │   ├── registry.py            ← Provider registry
    │   │   └── universe.py            ← F&O universe management
    │   ├── jugaad/                    ← jugaad Python library adapter (NSE bhavcopy/OHLCV)
    │   │   ├── __init__.py
    │   │   └── adapter.py
    │   └── openchart/                 ← openchart Python library adapter (NSE charting API)
    │       ├── __init__.py
    │       └── adapter.py
    │
    ├── publisher/                     ← Tick/stream publishing
    │   ├── __init__.py
    │   ├── broker_ws_manager.py       ← Broker WebSocket management
    │   ├── router.py                  ← Publish routing
    │   ├── stream_publisher.py        ← Stream publishing
    │   └── tick_publisher.py          ← Redis tick publishing
    │
    └── scrapers/                      ← HTTP scraper endpoints
        ├── __init__.py
        ├── historical.py              ← `/historical` — multi-day OHLCV
        ├── historical_repair.py       ← Gap detection and repair
        ├── instrument_master.py       ← `/instruments` — ScripMaster dump
        ├── live_quotes.py             ← `/quotes` — live NSE quotes
        └── option_chain.py            ← `/option-chain` — NSE option chain
```

### 1.3 Exposed API Surface (Old Data Service)

The old data-service exposes these HTTP endpoints (all on port 8200):

| Endpoint | Purpose |
|----------|---------|
| `POST /data/gate` | Data quality gate evaluation |
| `GET /historical` | Historical OHLCV candles |
| `GET /quotes` | Live NSE quotes |
| `GET /option-chain` | NSE option chain |
| `GET /instruments` | Instrument master |
| `GET /health` | Health check |
| `GET /status` | Service status |
| `GET /monitoring/*` | Monitoring endpoints |

### 1.4 Consumers of the Old Data Service

The only AlphaForge consumer that calls the old data-service by HTTP is `ScraplingProvider`:

| Consumer | File | How It Consumes |
|----------|------|----------------|
| `ScraplingProvider` | `src/lib/market-data/providers/scrapling.ts` | HTTP REST calls to `DATA_SERVICE_URL`; uses `/quotes`, `/historical`, `/option-chain`, `/instruments` endpoints |
| `gate-client.ts` | `src/lib/data-service/gate-client.ts` | HTTP POST to `DATA_SERVICE_URL/data/gate` for signal quality gate evaluation |
| `worker/src/jobs/scraping-tick-listener.ts` | Worker job | Consumes tick stream from the old data-service publisher |

All other provider calls go through the TypeScript `ProviderRegistry` and reach Angel One / Upstox / Yahoo directly — they do not touch the old Python service.

### 1.5 Database Tables Owned by the Old Data Service

The old Python data-service maintains its **own PostgreSQL schema**, separate from AlphaForge's Prisma schema. Tables owned (based on schema analysis):

| Table | Content | Notes |
|-------|---------|-------|
| `ohlcv_candles` | Historical OHLCV bars for NSE equities and F&O | Primary data store; populated by jugaad/openchart scrapers |
| `instrument_master` | NSE instrument records (symbol, token, ISIN, segment) | Refreshed from ScripMaster daily |
| `data_gaps` | Detected gaps in candle history with recovery status | Managed by `historical_repair.py` |
| `data_provenance` | Per-candle source tracking (which provider served which bar) | Lineage tracking |
| `provider_health` | Circuit breaker state, success/failure counts per provider | Runtime observability |

**These tables are owned by the old data-service and will cease to exist when the service is removed.** Data-service2.0 manages its own equivalent schema independently.

### 1.6 Why It Must Be Removed

1. **Superseded by data-service2.0** — Data-service2.0 implements the same functionality with better reliability, proper versioning, and a stable HTTP API contract.
2. **Fragile scraping layer** — The old service scrapes NSE using the `jugaad` and `openchart` Python libraries, which rely on NSE's charting API. NSE's anti-ban layer (shadow bans, IP blocks, cookie invalidation) causes silent data failures. A Chromium session warmer (`session_warmer.py`) was added as a workaround, adding significant overhead.
3. **Port conflict** — Both the old data-service and data-service2.0 default to port 8200. They cannot coexist.
4. **Database schema conflict** — Two separate PostgreSQL schemas for market data creates reconciliation complexity and dual maintenance burden.
5. **Operational cost** — Running an extra Python service, Chromium browser instances, and proxy rotation for scraping adds significant infrastructure cost vs. using legitimate broker APIs (Angel One, Upstox) inside data-service2.0.
6. **`DATA_SERVICE_URL` repurposing** — Currently `DATA_SERVICE_URL` points to the old service. After removal, `DATA_SERVICE_URL` (or the new `DATA_SERVICE_2_URL`) will point to data-service2.0.

---

## Part 2 — AlphaForge Internal Market Data Layer (`src/lib/market-data/`)

### 2.1 Overview

The `src/lib/market-data/` directory is AlphaForge's in-process market-data abstraction layer. It provides a `MarketDataProvider` interface, a `ProviderRegistry`, a failover engine, per-provider health tracking, caching, and normalization. All TypeScript consumers access market data through `DataServiceClient` which routes through this layer.

After migration, this entire layer becomes a thin HTTP client wrapping data-service2.0. The `ProviderRegistry` with its multi-provider failover, per-provider credential management, and health tracking becomes unnecessary — data-service2.0 handles all of that internally.

### 2.2 Complete File Listing (`src/lib/market-data/`)

```
src/lib/market-data/
├── canonical-import-guard.ts         ← Ensures no direct provider imports outside this dir
├── data-availability.ts              ← Checks data freshness / availability
├── data-gate.ts                      ← In-process data gate integration
├── dataset-version.ts                ← Dataset versioning utilities
├── failover.ts                       ← withFailover() — multi-provider retry/fallback engine
├── health.ts                         ← recordSuccess/recordFailure, circuit breaker, health snapshots
├── index.ts                          ← Public exports
├── normalizer.ts                     ← Price/symbol normalization utilities
├── provenance.ts                     ← Data provenance persistence to DB
├── provider-capability-matrix.ts     ← Maps provider × capability × interval
├── provider-selection.ts             ← Runtime capability-aware provider selection
├── provider.ts                       ← MarketDataProvider interface definition
├── registry.ts                       ← ProviderRegistry — ordered list, bootstrapRegistry()
├── types.ts                          ← All canonical types (MDQuote, OHLCVCandle, OptionChain…)
├── worker-credentials.ts             ← Worker-specific credential access helpers
│
├── cache/
│   └── market-cache.ts               ← Redis-backed memoization (memoQuote, memoCandles…)
│
├── providers/
│   ├── angel-one.ts                  ← AngelOneProvider (MARKET DATA — REMOVE)
│   ├── nse.ts                        ← NSEProvider stub (KEEP — tombstone)
│   ├── scrapling.ts                  ← ScraplingProvider wrapping old data-service (REPLACE)
│   ├── upstox.ts                     ← UpstoxProvider (MARKET DATA — REMOVE)
│   ├── upstox-instruments.ts         ← Upstox instrument resolution (REMOVE)
│   ├── upstox-proto.ts               ← Upstox Protobuf decoder (REMOVE)
│   ├── upstox-token-state.ts         ← Upstox OAuth token state (KEEP for execution)
│   └── yahoo.ts                      ← YahooProvider (REMOVE)
│
├── services/
│   ├── candle-builder.service.ts     ← MultiInstrumentCandleBuilder — builds OHLCV from live ticks
│   ├── config-health.service.ts      ← Provider credential/config health checks
│   ├── historical.service.ts         ← Historical candle acquisition orchestration
│   └── live-feed.service.ts          ← Live tick feed subscription management
│
└── validation/
    └── candle-validator.ts           ← Candle integrity validation (OHLC ordering, volume, gaps)
```

### 2.3 Files to Retain After Migration

| File | Reason to Keep |
|------|---------------|
| `types.ts` | Canonical type definitions used across the entire codebase — keep as the shared type layer |
| `normalizer.ts` | Price/symbol normalization utilities used by other parts of the codebase |
| `cache/market-cache.ts` | Redis caching layer — keep for response caching in the new data-service2.0 client |
| `providers/nse.ts` | Tombstone stub — keep to prevent re-introduction |
| `providers/upstox-token-state.ts` | OAuth token state — keep for Upstox execution broker |
| `validation/candle-validator.ts` | Validation may still be needed for candles returned from data-service2.0 |

### 2.4 Files to Remove After Migration

| File | Reason |
|------|--------|
| `providers/scrapling.ts` | Wraps old data-service; replaced by data-service2.0 client |
| `providers/angel-one.ts` | AngelOneProvider; data sourced from data-service2.0 |
| `providers/upstox.ts` | UpstoxProvider; data sourced from data-service2.0 |
| `providers/upstox-instruments.ts` | Upstox-specific instrument resolution; replaced by `/v1/instruments` |
| `providers/upstox-proto.ts` | Upstox Protobuf decoder; no longer needed |
| `providers/yahoo.ts` | YahooProvider; data sourced from data-service2.0 |
| `failover.ts` | Multi-provider failover engine; data-service2.0 handles failover internally |
| `health.ts` | Per-provider health tracking; data-service2.0 exposes `GET /v1/analytics/providers` |
| `provider-capability-matrix.ts` | Maps provider × capability; not needed with single source |
| `provider-selection.ts` | Runtime provider selection logic; not needed with single source |
| `provider.ts` | `MarketDataProvider` interface; not needed — replaced by HTTP client interface |
| `registry.ts` | `ProviderRegistry` + `bootstrapRegistry()`; not needed |
| `worker-credentials.ts` | Credential access for worker providers; providers removed |

---

## Part 3 — Services Layer Inventory (`src/services/`)

### 3.1 `src/services/binance/`

| File | Purpose | Action |
|------|---------|--------|
| `rest.ts` | Binance Spot 24hr tickers (server-only) | **Remove** — `GET /v1/crypto/{symbol}/stats` |
| `klines.ts` | Binance Spot OHLCV klines (server-only) | **Remove** — `GET /v1/crypto/{symbol}/ohlcv` |
| `futures.ts` | Binance USDM Futures: funding, OI, L/S ratio (server-only) | **Remove** — `GET /v1/crypto/futures/overview` |
| `ws.ts` | Binance Spot mini-ticker WebSocket (client-side) | **Remove** — `WS /v1/stream/ticks` |
| `liquidation-ws.ts` | Binance Futures liquidation WebSocket (client-side) | **Remove** — `WS /v1/stream/ticks` |

### 3.2 `src/services/deribit/`

| File | Purpose | Action |
|------|---------|--------|
| `rest.ts` | Deribit REST: options overview, book summary for BTC/ETH/SOL | **Remove** — `GET /v1/deribit/options/overview` |

### 3.3 `src/services/india/`

| Directory / File | Purpose | Action |
|----------|---------|--------|
| `angelone/index.ts` | SmartAPI adapter: option chain, quotes, candles, auth | **Remove market-data methods** |
| `angelone/derivatives.ts` | SmartAPI derivatives analytics parsers (PCR, OI buildup, gainers/losers) | **Remove** |
| `angelone/portfolio.ts` | SmartAPI account data (funds, holdings, positions) | **Keep** |
| `angelone/smartstream.ts` | SmartStream v2 WebSocket live feed | **Remove** |
| `nse/index.ts` | NSE stub (all methods throw) | **Keep stub** |
| `yahoo/index.ts` | Yahoo Finance adapter (historical, quotes) | **Remove** |
| `broker/` | India broker abstraction | **Evaluate** — keep execution parts |
| `cache/` | India-specific caching | **Retain** |
| `groww/` | Groww adapter | **Evaluate** |
| `news/` | News feed | **Keep** — not market data |
| `scanner/` | India equity scanner | **Migrate** — update to call data-service2.0 |
| `signals/` | Signal generation | **Migrate** — update to call data-service2.0 |
| `websocket/` | India WebSocket management | **Migrate** or remove if replaced by data-service2.0 WS |

### 3.4 `src/services/brokers/`

| File | Purpose | Action |
|------|---------|--------|
| `delta/rest.ts` | Delta REST: tickers, klines (market data methods) | **Remove market-data methods** |
| `delta/ws.ts` | Delta WebSocket: real-time tickers (client-side) | **Remove** |
| `delta/adapter.ts` | Delta `ServerBrokerAdapter` | **Remove market-data fetch; keep execution** |
| `binance/adapter.ts` | Binance `ServerBrokerAdapter` (uses klines for scalper) | **Remove market-data fetch; keep execution** |
| `binance/client.ts` | Binance broker HTTP client | **Keep** |
| `client.ts` | Broker client abstraction | **Keep** |
| `registry.ts` | Broker registry | **Keep** |
| `types.ts` | Broker types | **Keep** |
| `server-types.ts` | Server-side broker types | **Keep** |
| `shared.ts` | Shared broker utilities | **Keep** |

---

## Part 4 — Removal Checklist

### Old Data Service (`data-service/`)

- [ ] Confirm no other consumers reference `DATA_SERVICE_URL` besides `ScraplingProvider` and `gate-client.ts`
- [ ] Export any needed historical candle data from old PostgreSQL schema before removal
- [ ] Update `docker-compose.yml` to remove the `data-service` container definition
- [ ] Remove `data-service/` directory
- [ ] Remove `Dockerfile.app`/`docker-compose.yml` references to the old service
- [ ] Rename `DATA_SERVICE_URL` → `DATA_SERVICE_2_URL` (or keep `DATA_SERVICE_URL` pointing at data-service2.0)

### Internal Market Data Layer

- [ ] Remove provider files listed in §2.4
- [ ] Remove `ProviderRegistry` and `bootstrapRegistry()`
- [ ] Remove `withFailover()` engine
- [ ] Remove per-provider health tracking
- [ ] Remove `worker-credentials.ts`
- [ ] Update `DataServiceClient` in `src/lib/data-service/client.ts` to call data-service2.0 directly
- [ ] Update all consumers of `DataServiceClient` to work with new response shapes (if any change)

### Service Adapters

- [ ] Remove `src/services/binance/rest.ts`, `klines.ts`, `futures.ts`, `ws.ts`, `liquidation-ws.ts`
- [ ] Remove `src/services/deribit/rest.ts`
- [ ] Remove market-data methods from `src/services/india/angelone/index.ts` and `derivatives.ts`
- [ ] Remove `src/services/india/angelone/smartstream.ts`
- [ ] Remove `src/services/india/yahoo/index.ts`
- [ ] Remove market-data methods from `src/services/brokers/delta/rest.ts` and `ws.ts`
