# ALPHAFORGE DATA CENTRALIZATION — FORENSIC AUDIT

**Date:** 2026  
**Branch:** `refactor/data-service-centralization`  
**Purpose:** Complete pre-refactor audit of every market-data touch-point in the AlphaForge codebase, establishing the factual baseline for data-service2.0 centralization.

---

## 1. Repository Overview

### 1.1 Top-level Structure

```
alpha-forge-refactor/
├── src/
│   ├── app/            # Next.js App Router — pages + API routes
│   ├── components/     # React UI components
│   ├── features/       # Business-logic slices (settings, scalping, signals…)
│   ├── hooks/          # React hooks
│   ├── lib/            # Server-side library code
│   │   ├── data-service/          ← Current canonical TypeScript SDK
│   │   ├── market-data/           ← Provider registry, failover, normalizer
│   │   ├── india/                 ← India-specific helpers (market hours, etc.)
│   │   └── ...
│   ├── services/       # Raw third-party service adapters
│   │   ├── altme/                 ← Fear/Greed (NOT market data)
│   │   ├── binance/               ← Binance REST + WebSocket + klines + futures + liquidation-ws
│   │   ├── brokers/               ← Broker adapters (Delta, Binance broker, registry)
│   │   ├── coingecko/             ← CoinGecko REST
│   │   ├── deribit/               ← Deribit REST
│   │   └── india/                 ← Indian broker adapters (Angel One, NSE stub, Yahoo, Groww, NSE)
│   ├── store/          # Zustand / Redux state
│   └── types/          # TypeScript type definitions
├── worker/
│   └── src/
│       ├── jobs/       # Background worker jobs (cron-style)
│       └── ...
├── data-service/       # OLD Python data service — MUST BE REMOVED
├── prisma/             # Database schema (PostgreSQL)
├── ml-service/         # Python ML inference service
└── docker-compose.yml
```

### 1.2 Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/lib/data-service/` | TypeScript SDK used by all consumers — wraps `ProviderRegistry` |
| `src/lib/market-data/` | Provider registry, failover engine, normalizer, health tracking |
| `src/lib/market-data/providers/` | Individual provider adapters (ScraplingProvider, AngelOneProvider, UpstoxProvider, YahooProvider, NSEProvider-stub) |
| `src/services/binance/` | Direct Binance REST + WebSocket clients |
| `src/services/brokers/delta/` | Delta Exchange broker adapter (REST + WebSocket) |
| `src/services/deribit/` | Deribit REST client |
| `src/services/india/angelone/` | Angel One SmartAPI adapter (market data + portfolio) |
| `src/services/india/yahoo/` | Yahoo Finance adapter |
| `data-service/` | **OLD** embedded Python scraping microservice — scheduled for removal |

---

## 2. Provider Integrations Found

### 2.1 Angel One SmartAPI

| File | Role |
|------|------|
| `src/services/india/angelone/index.ts` | Primary SmartAPI adapter — option chain synthesis, quotes, historical candles, TOTP auth |
| `src/services/india/angelone/derivatives.ts` | Derivatives market-data parsers (gainers/losers, PCR, OI buildup) — MARKET DATA |
| `src/services/india/angelone/portfolio.ts` | Account data parsers (funds, holdings, positions) — EXECUTION |
| `src/services/india/angelone/smartstream.ts` | WebSocket 2.0 binary frame parser + `SmartStreamClient` — MARKET DATA (live feed) |
| `src/lib/market-data/providers/angel-one.ts` | `AngelOneProvider` — implements `MarketDataProvider` interface; priority 1 in registry |

### 2.2 Upstox

| File | Role |
|------|------|
| `src/lib/market-data/providers/upstox.ts` | `UpstoxProvider` — implements `MarketDataProvider`; priority 2; historical, quotes, option chain, WS |
| `src/lib/market-data/providers/upstox-instruments.ts` | Symbol → Upstox instrument key resolution |
| `src/lib/market-data/providers/upstox-proto.ts` | Binary Protobuf frame decoder for Upstox v3 WebSocket feed |
| `src/lib/market-data/providers/upstox-token-state.ts` | In-memory OAuth2 access token state (server-only) |
| `src/app/api/in/providers/upstox/connect/route.ts` | OAuth2 connect initiation — **EXECUTION (keep)** |
| `src/app/api/in/providers/upstox/callback/route.ts` | OAuth2 callback + token exchange — **EXECUTION (keep)** |
| `src/app/api/in/providers/upstox/status/route.ts` | OAuth connection status — **EXECUTION (keep)** |
| `src/app/api/in/providers/upstox/disconnect/route.ts` | OAuth disconnect — **EXECUTION (keep)** |

### 2.3 NSE

| File | Role |
|------|------|
| `src/services/india/nse/index.ts` | **STUB ONLY** — Direct NSE adapter removed 2026-09-03; stub throws on all calls |
| `src/lib/market-data/providers/nse.ts` | **STUB ONLY** — Not exported, not registered; tombstone file with removal reason |

NSE direct data acquisition is **prohibited**. These stubs exist to prevent accidental re-introduction.

### 2.4 Yahoo Finance

| File | Role |
|------|------|
| `src/services/india/yahoo/index.ts` | Yahoo Finance adapter — historical equity candles, delayed quotes; implements `BrokerAdapter` |
| `src/lib/market-data/providers/yahoo.ts` | `YahooProvider` — wraps the above; priority 3 (last resort); 15-min delayed quotes |

### 2.5 Scrapling (Old Data Service)

| File | Role |
|------|------|
| `src/lib/market-data/providers/scrapling.ts` | `ScraplingProvider` — HTTP client wrapping the OLD Python data-service on `DATA_SERVICE_URL`; priority 0 (first tried) |

The ScraplingProvider is a thin HTTP adapter calling the **old** `data-service/` Python microservice. It is not a scraper itself — the scraping happens inside `data-service/`.

### 2.6 Binance

| File | Role |
|------|------|
| `src/services/binance/rest.ts` | Binance Spot REST: 24hr tickers — MARKET DATA |
| `src/services/binance/klines.ts` | Binance Spot REST: klines/OHLCV — MARKET DATA |
| `src/services/binance/futures.ts` | Binance USDM Futures REST: funding, OI, long/short — MARKET DATA |
| `src/services/binance/ws.ts` | Binance Spot WebSocket mini-ticker stream — MARKET DATA (client-side) |
| `src/services/binance/liquidation-ws.ts` | Binance Futures WebSocket liquidation feed — MARKET DATA (client-side) |
| `src/services/brokers/binance/adapter.ts` | Binance broker adapter implementing `ServerBrokerAdapter` |
| `src/services/brokers/binance/client.ts` | Binance broker client |

### 2.7 Deribit

| File | Role |
|------|------|
| `src/services/deribit/rest.ts` | Deribit REST: options overview, book summary — MARKET DATA |

### 2.8 Delta Exchange

| File | Role |
|------|------|
| `src/services/brokers/delta/rest.ts` | Delta India REST: tickers, klines, products — MARKET DATA |
| `src/services/brokers/delta/ws.ts` | Delta India WebSocket: real-time ticker stream — MARKET DATA (client-side) |
| `src/services/brokers/delta/adapter.ts` | Delta `ServerBrokerAdapter` implementation |

### 2.9 CoinGecko

| File | Role |
|------|------|
| `src/services/coingecko/rest.ts` | CoinGecko REST: global market cap, coin data — MARKET DATA (supplementary) |

### 2.10 Altme (Alternative.me)

| File | Role |
|------|------|
| `src/services/altme/fearGreed.ts` | Crypto Fear & Greed Index from `api.alternative.me/fng/` — **NOT market data; sentiment/meta indicator only** |

---

## 3. Market-Data-Specific Code Identified

### 3.1 Core Provider Chain (to be replaced)

The canonical provider chain currently resolves via `src/lib/market-data/registry.ts` + `src/lib/market-data/failover.ts`:

```
Priority 0: ScraplingProvider  → OLD data-service Python HTTP (DATA_SERVICE_URL)
Priority 1: AngelOneProvider   → Angel One SmartAPI credentials
Priority 2: UpstoxProvider     → Upstox credentials / analytics token
Priority 3: YahooProvider      → yahoo-finance2 npm package (delayed)
```

This entire chain is the **target of replacement** with direct data-service2.0 calls.

### 3.2 Market Data Files to Remove/Rewrite

| File | Reason |
|------|--------|
| `src/lib/market-data/providers/scrapling.ts` | Wraps old Python data-service — replace with data-service2.0 client |
| `src/lib/market-data/providers/angel-one.ts` | Market data provider adapter — remove after migration |
| `src/lib/market-data/providers/upstox.ts` | Market data provider adapter — remove after migration |
| `src/lib/market-data/providers/upstox-instruments.ts` | Instrument resolution (Upstox-specific) — remove |
| `src/lib/market-data/providers/upstox-proto.ts` | Upstox Protobuf decoder — remove |
| `src/lib/market-data/providers/upstox-token-state.ts` | Upstox OAuth token state — remove (keep for broker execution) |
| `src/lib/market-data/providers/yahoo.ts` | Yahoo market data provider — remove |
| `src/services/india/angelone/index.ts` | Market data parts (option chain, quotes, candles, ScripMaster) — remove market-data parts |
| `src/services/india/angelone/derivatives.ts` | Derivatives analytics (PCR, OI buildup, gainers/losers) — replace with data-service2.0 |
| `src/services/india/angelone/smartstream.ts` | WebSocket live feed — replace with `WS /v1/stream/ticks` |
| `src/services/india/yahoo/index.ts` | Yahoo Finance adapter — remove |
| `src/services/binance/rest.ts` | Binance 24hr tickers — replace with `GET /v1/crypto/{symbol}/stats` |
| `src/services/binance/klines.ts` | Binance klines — replace with `GET /v1/crypto/{symbol}/ohlcv` |
| `src/services/binance/futures.ts` | Binance funding/OI — replace with `GET /v1/crypto/futures/overview` |
| `src/services/binance/ws.ts` | Binance client-side WS — replace with `WS /v1/stream/ticks` |
| `src/services/binance/liquidation-ws.ts` | Binance liquidation WS — replace with `WS /v1/stream/ticks` |
| `src/services/deribit/rest.ts` | Deribit REST — replace with `GET /v1/deribit/options/overview` |
| `src/services/brokers/delta/rest.ts` | Delta REST market data — replace with data-service2.0 crypto endpoints |
| `src/services/brokers/delta/ws.ts` | Delta WebSocket market data — replace with `WS /v1/stream/ticks` |

---

## 4. Execution-Only Broker Code (Keep)

These files handle order placement, portfolio reads, and broker OAuth — they do NOT fetch market data and must be **retained**:

| File | Purpose |
|------|---------|
| `src/services/india/angelone/portfolio.ts` | Reads account funds, holdings, positions from SmartAPI — execution layer |
| `src/app/api/in/providers/upstox/connect/route.ts` | Upstox OAuth2 connect — broker auth for order placement |
| `src/app/api/in/providers/upstox/callback/route.ts` | Upstox OAuth2 callback — broker auth for order placement |
| `src/app/api/in/providers/upstox/status/route.ts` | Upstox connection status |
| `src/app/api/in/providers/upstox/disconnect/route.ts` | Upstox OAuth disconnect |
| `src/services/brokers/client.ts` | Broker client abstraction |
| `src/services/brokers/registry.ts` | Broker registry |
| `src/services/brokers/types.ts` | Broker type definitions |
| `src/services/brokers/binance/adapter.ts` | Binance broker (order placement) |
| `src/services/brokers/delta/adapter.ts` | Delta broker adapter (order placement) |

---

## 5. Database Models Analyzed

Prisma schema at `prisma/schema.prisma`. Market-data-relevant models:

| Model | Fields of Interest | Notes |
|-------|--------------------|-------|
| `UserSetting` | `dataSourcesJson` (JSON) | Stores per-user data-source selections (yahoo/angel/upstox/binance/delta). Must be migrated to reflect data-service2.0 as the sole source. |
| `SignalHistory` | `symbol`, `features` (JSON), `confidence` | Signals generated from market data; no provider reference stored — unaffected. |
| `PaperTrade` | `entryPrice`, `exitPrice`, etc. | Trade execution model — not market data. |
| `StrategyLab` / `Experiment` | Various backtesting fields | No direct provider coupling. |

The old Python `data-service/` managed its **own PostgreSQL schema** (OHLCV candles, instrument master, gap metadata) independent of AlphaForge's Prisma schema. This is a separate database that must also be decommissioned. See §7 below.

---

## 6. Existing Data-Service Client Analyzed

### 6.1 `src/lib/data-service/client.ts` — The Fallback Chain

This is the canonical TypeScript SDK used by all AlphaForge consumers. Architecture comment from the file itself:

```
Architecture: DataServiceClient → ProviderRegistry → withFailover() →
  ScraplingProvider (data-service) → AngelOneProvider → UpstoxProvider → YahooProvider
```

**Namespaces:**
- `DataServiceClient.market` — `quote()`, `quotes()`, `candles()`, `historical()`, `options()`, `instruments()`
- `DataServiceClient.universe` — `fno()` F&O universe
- `DataServiceClient.stream` — `subscribe()` WebSocket subscriptions
- `DataServiceClient.observability` — provider health snapshots

**Key finding:** Every call routes through `getRegistry()` → `bootstrapRegistry()` → the four-provider fallback chain. The `ScraplingProvider` (priority 0) calls the OLD Python `data-service/` on `DATA_SERVICE_URL`. The entire chain must be replaced with a single direct data-service2.0 HTTP client.

### 6.2 `src/lib/data-service/gate-client.ts` — Data Quality Gate

Calls `POST /data/gate` on the data-service for signal quality gating. Already references a `DATA_SERVICE_2_URL` env var as a Phase 5 transition. Uses `http://localhost:8200` as default (same port as data-service2.0). The gate endpoint path must align with data-service2.0's API surface.

---

## 7. Workers / Cron Jobs Analyzed

| File | Market Data Source | Action |
|------|--------------------|--------|
| `worker/src/jobs/india-realtime-candles.ts` | Routes through `registry.getInstrumentMaster()` → `AngelStreamClient` / Upstox WS | Replace with `WS /v1/stream/ticks` from data-service2.0 |
| `worker/src/jobs/scalper.ts` | Imports `KlineInterval` from `@/services/binance/klines` — fetches Binance candles via broker | Replace with `GET /v1/crypto/{symbol}/ohlcv` |
| `worker/src/jobs/liquidations.ts` | Binance liquidation WebSocket | Replace with `WS /v1/stream/ticks` |
| `worker/src/jobs/india-scanner.ts` | Routes through registry (quotes/candles) | Replace with data-service2.0 India endpoints |
| `worker/src/jobs/india-oc-capture.ts` | Option chain via registry | Replace with `GET /v1/india/option-chain` |
| `worker/src/jobs/india-fno-trend-track.ts` | India market data via registry | Replace with data-service2.0 |
| `worker/src/jobs/india-daily-picks.ts` | Historical candles via registry | Replace with `GET /v1/india/historical` |
| `worker/src/jobs/alerts.ts` | Quotes via registry | Replace with data-service2.0 |
| `worker/src/jobs/signal-ingest.ts` | Signal generation (uses DataServiceClient) | Replace market data calls |
| `worker/src/jobs/scraping-tick-listener.ts` | Consumes ticks from old data-service | **Remove** — data-service2.0 provides WS streaming |
| `worker/src/jobs/strategy-lab.ts` | Historical candles via backtesting | Replace with data-service2.0 |

---

## 8. API Routes Analyzed

### 8.1 Routes That Fetch Market Data (Must Be Migrated)

| Route | Current Source | Replace With |
|-------|---------------|--------------|
| `GET /api/in/quote` | `resolveQuotes()` → BrokerChain → Angel/Upstox/Yahoo | `GET /v1/india/quotes/{symbol}` |
| `GET /api/in/option-chain` | Registry → Angel One / Upstox | `GET /v1/india/option-chain` |
| `GET /api/in/market-snapshot` | Registry quotes | `GET /v1/india/quotes/{symbol}` |
| `GET /api/in/historical-data/*` | Registry historical candles | `GET /v1/india/historical` |
| `GET /api/v1/market/quote` | `DataServiceClient.market.quote()` | `GET /v1/india/quotes/{symbol}` |
| `GET /api/v1/market/quotes` | `DataServiceClient.market.quotes()` | `GET /v1/india/quotes/{symbol}` |
| `GET /api/v1/market/candles` | `DataServiceClient.market.candles()` | `GET /v1/india/historical` |
| `GET /api/v1/market/historical` | `DataServiceClient.market.historical()` | `GET /v1/india/historical` |
| `GET /api/v1/market/options` | `DataServiceClient.market.options()` | `GET /v1/india/option-chain` |
| `GET /api/v1/market/instruments` | `DataServiceClient.market.instruments()` | `GET /v1/instruments` |
| `GET /api/v1/market/universe` | `DataServiceClient.universe.fno()` | `GET /v1/instruments/fno-universe` |
| `GET /api/v1/providers/status` | `DataServiceClient.observability.providerHealth()` | `GET /v1/analytics/providers` |
| `GET /api/futures/tickers` | `getFuturesTickers()` → Delta REST + Binance REST | `GET /v1/crypto/futures/overview` |
| `GET /api/futures/overview` | Delta/Binance broker adapters | `GET /v1/crypto/futures/overview` |
| `GET /api/options/overview` | `getOptionsOverview()` → Deribit REST | `GET /v1/deribit/options/overview` |

### 8.2 Routes to Keep (Execution Only)

| Route | Purpose |
|-------|---------|
| `GET /api/in/providers/upstox/connect` | Upstox OAuth initiation |
| `GET /api/in/providers/upstox/callback` | Upstox OAuth callback |
| `GET /api/in/providers/upstox/status` | Upstox connection status |
| `POST /api/in/providers/upstox/disconnect` | Upstox disconnect |
| `GET /api/v1/data/quality` | Data quality gate (POST to data-service2.0 `/data/gate`) |
| `GET /api/v1/data/status` | Data service status |

---

## 9. Frontend Provider UI Analyzed

### 9.1 API Keys Form (`src/components/settings/api-keys-form.tsx`)

Currently renders per-exchange credential forms. Supported exchanges include Angel One (SmartAPI TOTP auth) and Upstox (OAuth token). After refactor:
- Angel One credentials: only needed if Angel One remains an execution broker
- Upstox credentials: keep OAuth flow for order placement
- Angel One market-data credential fields: remove from UI once market data sourced from data-service2.0

### 9.2 Data Sources Form (`src/components/settings/data-sources-form.tsx`)

Renders a data-source picker populated from `DATA_SOURCES` in `data-sources-shared.ts`. The catalog includes Yahoo, Groww, Zerodha, BSE, Angel, Upstox, OpenAlgo, Binance, Delta. After refactor, all market-data sources collapse to "data-service2.0" — the picker should be simplified or repurposed to show provider health from `GET /v1/analytics/providers`.

### 9.3 Data Source Selections (`src/features/settings/data-sources-shared.ts`)

Stores per-user selections in `UserSetting.dataSourcesJson`. Default: `{ india: { selected: ["yahoo"] }, crypto: { selected: ["binance", "delta"] } }`. These settings currently influence `pickBrokerChain()` in API routes. After refactor, all market-data routing goes through data-service2.0 — the user-facing selection either becomes irrelevant for data or maps to data-service2.0 provider preferences.

---

## 10. Environment Variables Analyzed

### 10.1 Market Data Provider Credentials (to be removed)

| Variable | Purpose | Action |
|----------|---------|--------|
| `SMARTAPI_API_KEY` | Angel One market data | **Remove** from market-data paths |
| `SMARTAPI_CLIENT_CODE` | Angel One market data | **Remove** from market-data paths |
| `SMARTAPI_PIN` | Angel One market data | **Remove** from market-data paths |
| `SMARTAPI_TOTP_SECRET` | Angel One market data | **Remove** from market-data paths |
| `SMARTAPI_LOCAL_IP` | Angel One WAF bypass | **Remove** |
| `SMARTAPI_PUBLIC_IP` | Angel One WAF bypass | **Remove** |
| `SMARTAPI_MAC_ADDRESS` | Angel One SmartAPI header | **Remove** |
| `UPSTOX_ANALYTICS_TOKEN` | Upstox market data | **Remove** from market-data paths |
| `UPSTOX_ACCESS_TOKEN` | Upstox market data (legacy) | **Remove** from market-data paths |
| `INDIA_DATA_PROVIDER` | Provider mode (`auto`) | **Remove** — replaced by data-service2.0 |

### 10.2 Execution Broker Credentials (to keep)

| Variable | Purpose | Action |
|----------|---------|--------|
| `UPSTOX_CLIENT_ID` | Upstox OAuth broker | **Keep** |
| `UPSTOX_CLIENT_SECRET` | Upstox OAuth broker | **Keep** |
| `UPSTOX_REDIRECT_URI` | Upstox OAuth callback URL | **Keep** |

### 10.3 Data Service Variables (new and old)

| Variable | Purpose | Action |
|----------|---------|--------|
| `DATA_SERVICE_URL` | Old Python data-service endpoint | **Replace** with `DATA_SERVICE_2_URL` |
| `DATA_SERVICE_2_URL` | data-service2.0 endpoint | **Add** — `http://data-service:8200` (Docker) |
| `DATA_SERVICE_API_KEY` | data-service2.0 `X-API-KEY` header | **Add** — required for all calls |

### 10.4 Other Env Vars (unchanged)

`DATABASE_URL`, `REDIS_URL`, `DERIBIT_CLIENT_ID`, `DERIBIT_SECRET`, `COINGECKO_API_KEY`, `AUTH_SECRET`, `ENCRYPTION_KEY`, `ML_SERVICE_URL`, `SENTRY_DSN`, etc. are unaffected by this refactor.

---

## 11. Key Finding: The Fallback Chain That Must Be Replaced

The file `src/lib/data-service/client.ts` documents its own architecture:

```
DataServiceClient → ProviderRegistry → withFailover() →
  ScraplingProvider (data-service) → AngelOneProvider → UpstoxProvider → YahooProvider
```

This four-tier chain exists because:
1. The old Python `data-service/` (ScraplingProvider) was unreliable — it scrapes NSE with anti-ban overhead
2. Angel One SmartAPI is used as fallback #1
3. Upstox is fallback #2
4. Yahoo Finance (15-min delayed, no F&O) is the last resort

**This entire fallback chain must be replaced with a single call to data-service2.0.** Data-service2.0 owns its own provider chain internally (Angel One → Upstox → jugaad/openchart) and exposes a stable, versioned HTTP API. AlphaForge must call that API directly and trust data-service2.0 to handle provider selection, failover, and data quality.

The new architecture is:
```
DataServiceClient → DataService2Client (HTTP) → data-service2.0 (http://data-service:8200)
```

No per-provider credential management in AlphaForge. No fallback logic in AlphaForge. No provider SDKs in AlphaForge.

---

## 12. Summary of Affected Files

| Category | Count | Action |
|----------|-------|--------|
| Market data provider adapters | 5 | Remove / replace |
| Direct broker market-data clients | 8 | Remove / replace |
| Worker jobs with direct market-data calls | 11 | Migrate to data-service2.0 |
| API routes fetching market data | 15 | Migrate to data-service2.0 |
| Python old data-service files | ~40 | Remove entire `data-service/` directory |
| Frontend provider UI components | 2 | Simplify |
| Environment variables (provider creds) | 10 | Remove |
| Environment variables (new data-service) | 2 | Add |
