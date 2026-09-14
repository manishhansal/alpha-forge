# ALPHAFORGE DATA-SERVICE 2.0 API CONTRACT

**Date:** 2026  
**Branch:** `refactor/data-service-centralization`  
**Purpose:** Complete mapping of every AlphaForge market-data need to the data-service2.0 API. This document is the authoritative reference for implementing the new `DataService2Client` that replaces the entire old provider chain.

---

## 1. Connection Details

| Environment | Base URL |
|-------------|----------|
| Docker Compose (production) | `http://data-service:8200` |
| Local development | `http://localhost:8200` |

### 1.1 Authentication

All requests to data-service2.0 require the `X-API-KEY` header:

```
X-API-KEY: <key>
```

Keys are configured in data-service2.0 via the `CONSUMER_API_KEYS` environment variable (comma-separated list). AlphaForge must set `DATA_SERVICE_API_KEY` in its environment and include it on every request.

Alternatively, exchange an API key for a short-lived JWT:

```
GET /v1/auth/token?api_key=<key>
→ { "accessToken": "<jwt>", "expiresIn": 3600 }
```

Then use `Authorization: Bearer <jwt>` on subsequent requests.

### 1.2 Response Envelope

All successful responses use:
```json
{
  "data": <payload>,
  "metadata": {
    "requestedAt": "2026-01-15T09:30:00.000Z",
    "dataAsOf": "2026-01-15T09:29:58.000Z",
    "dataSourceType": "LIVE" | "CACHED",
    "provider": "angel_one" | "upstox" | ...
  }
}
```

All error responses use:
```json
{
  "error": {
    "code": "SYMBOL_NOT_FOUND",
    "message": "...",
    "requestId": "uuid"
  }
}
```

---

## 2. India Market Data APIs

### 2.1 Live Quote

**Old AlphaForge sources:**
- `ScraplingProvider.getLatestQuote()` → old data-service `/quotes`
- `AngelOneProvider.getLatestQuote()` → SmartAPI Quote API
- `UpstoxProvider.getLatestQuote()` → Upstox Market Quote REST
- `YahooProvider.getLatestQuote()` → yahoo-finance2 (15-min delayed)
- `GET /api/in/quote` → `resolveQuotes()` → BrokerChain

**New data-service2.0 endpoint:**

```
GET /v1/india/quotes/{symbol}?exchange=NSE
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | path string | ✅ | NSE trading symbol, e.g. `RELIANCE`, `NIFTY` |
| `exchange` | query string | ❌ | Exchange identifier. Default: `NSE` |

**Example:**
```
GET http://data-service:8200/v1/india/quotes/RELIANCE?exchange=NSE
X-API-KEY: <key>
```

**Response shape (inside `data`):**
```json
{
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "ltp": 2847.50,
  "open": 2835.00,
  "high": 2860.00,
  "low": 2830.00,
  "close": 2840.00,
  "volume": 4500000,
  "timestamp": "2026-01-15T09:29:58Z"
}
```

**AlphaForge consumer update:**
- `DataServiceClient.market.quote(symbol)` → `GET /v1/india/quotes/{symbol}`
- `DataServiceClient.market.quotes(symbols)` → multiple parallel calls to `GET /v1/india/quotes/{symbol}`
- `GET /api/in/quote` → remove BrokerChain; call data-service2.0 directly

---

### 2.2 Option Chain

**Old AlphaForge sources:**
- `ScraplingProvider.getOptionChain()` → old data-service `/option-chain`
- `AngelOneProvider.getOptionChain()` → ScripMaster + Quote API + Greeks API (3 calls synthesized)
- `UpstoxProvider.getOptionChain()` → Upstox Option Chain REST with full Greeks

**New data-service2.0 endpoint:**

```
GET /v1/india/option-chain?underlying=NIFTY&expiry=2026-01-30&exchange=NSE
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `underlying` | query string | ✅ | Underlying symbol, e.g. `NIFTY`, `BANKNIFTY`, `RELIANCE` |
| `expiry` | query string | ❌ | Expiry date as `YYYY-MM-DD`. Defaults to nearest expiry |
| `exchange` | query string | ❌ | Exchange identifier. Default: `NSE` |

**Example:**
```
GET http://data-service:8200/v1/india/option-chain?underlying=NIFTY&expiry=2026-01-30
X-API-KEY: <key>
```

**Response shape (inside `data`):**
```json
{
  "underlying": "NIFTY",
  "underlyingPrice": 24500.00,
  "expiry": "2026-01-30",
  "rows": [
    {
      "strike": 24500,
      "CE": {
        "token": "...",
        "tradingSymbol": "NIFTY24JAN24500CE",
        "ltp": 145.50,
        "oi": 2500000,
        "iv": 12.5,
        "delta": 0.52,
        "gamma": 0.001,
        "theta": -8.5,
        "vega": 15.2
      },
      "PE": { ... }
    }
  ],
  "pcr": 0.85,
  "maxPain": 24400
}
```

**AlphaForge consumer update:**
- `DataServiceClient.market.options(underlying, expiry)` → `GET /v1/india/option-chain`
- `GET /api/in/option-chain` → remove registry fallback; call data-service2.0 directly

---

### 2.3 Historical OHLCV Candles

**Old AlphaForge sources:**
- `ScraplingProvider.getHistoricalCandles()` → old data-service `/historical`
- `AngelOneProvider.getHistoricalCandles()` → SmartAPI `getCandleData()`
- `UpstoxProvider.getHistoricalCandles()` → Upstox Historical Candle API v3
- `YahooProvider.getHistoricalCandles()` → yahoo-finance2 (1d only)

**New data-service2.0 endpoint:**

```
GET /v1/india/historical?symbol=RELIANCE&exchange=NSE&interval=1d&from=2025-01-01&to=2026-01-15
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | query string | ✅ | Trading symbol, e.g. `RELIANCE`, `NIFTY` |
| `exchange` | query string | ❌ | Exchange. Default: `NSE` |
| `interval` | query string | ✅ | Candle interval: `1m`, `5m`, `15m`, `30m`, `1h`, `1d`. **Note: `3m` is permanently unsupported for India.** |
| `from` | query string | ✅ | Start date as `YYYY-MM-DD` or ISO-8601 datetime |
| `to` | query string | ✅ | End date as `YYYY-MM-DD` or ISO-8601 datetime |

**Example:**
```
GET http://data-service:8200/v1/india/historical?symbol=RELIANCE&interval=1d&from=2025-01-01&to=2026-01-15
X-API-KEY: <key>
```

**Response shape (inside `data`):**
```json
[
  { "time": 1735689600, "open": 2820.0, "high": 2865.0, "low": 2815.0, "close": 2848.0, "volume": 5200000, "oi": null },
  ...
]
```

**AlphaForge consumer update:**
- `DataServiceClient.market.candles(req)` → `GET /v1/india/historical`
- `DataServiceClient.market.historical(req)` → same
- `GET /api/v1/market/candles` and `GET /api/v1/market/historical` → route to data-service2.0
- Worker jobs: `india-realtime-candles.ts`, `india-daily-picks.ts`, `strategy-lab.ts`

---

### 2.4 Market Status

**Old AlphaForge sources:**
- `src/lib/india/market-hours.ts` — local IST timezone logic; no external call
- No direct API equivalent in old provider chain

**New data-service2.0 endpoint:**

```
GET /v1/india/market/status
```

No query parameters.

**Response shape (inside `data`):**
```json
{
  "phase": "REGULAR" | "PRE_OPEN" | "POST_CLOSE" | "CLOSED",
  "nextPhaseChange": "2026-01-15T15:30:00+05:30",
  "isTradingDay": true,
  "nextTradingDay": "2026-01-16",
  "holidays": ["2026-01-26", "2026-03-25"],
  "sessionOpen": "2026-01-15T09:15:00+05:30",
  "sessionClose": "2026-01-15T15:30:00+05:30"
}
```

**AlphaForge consumer update:**
- Replace calls to `isNseMarketOpenIST()` where authoritative server-side market state is needed
- Worker jobs gating on market state should call this endpoint

---

### 2.5 Historical Gap Detection

**Old AlphaForge sources:**
- `data-service/src/scrapers/historical_repair.py` — old Python service
- `GET /api/in/historical-data/gaps` → queried old data-service gaps

**New data-service2.0 endpoint:**

```
GET /v1/india/historical/gaps?symbol=RELIANCE&interval=1d&status=DETECTED&limit=50
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | query string | ❌ | Filter by symbol |
| `interval` | query string | ❌ | Filter by interval |
| `status` | query string | ❌ | `DETECTED`, `RECOVERING`, `RESOLVED`, `EXHAUSTED` |
| `limit` | query integer | ❌ | Max results. Default: 50 |

**AlphaForge consumer update:**
- `GET /api/in/historical-data/gaps` → proxy to `GET /v1/india/historical/gaps`

---

### 2.6 Instrument Master

**Old AlphaForge sources:**
- `ScraplingProvider.getInstrumentMaster()` → old data-service `/instruments`
- `AngelOneProvider.getInstrumentMaster()` → Angel One ScripMaster dump (24h cached)

**New data-service2.0 endpoint:**

```
GET /v1/instruments?exchange=NSE&instrumentType=EQ&underlying=NIFTY
GET /v1/instruments/{instrumentId}
GET /v1/instruments/fno-universe
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `exchange` | query string | ❌ | Filter by exchange (NSE, NFO, BSE) |
| `instrumentType` | query string | ❌ | Filter by type (EQ, FUTIDX, OPTIDX, FUTSTK, OPTSTK) |
| `underlying` | query string | ❌ | Filter by underlying symbol |

**AlphaForge consumer update:**
- `DataServiceClient.market.instruments(filter)` → `GET /v1/instruments`
- `DataServiceClient.universe.fno()` → `GET /v1/instruments/fno-universe`
- Token resolution (previously in `upstox-instruments.ts`, `angel-one.ts`) → `GET /v1/instruments`

---

## 3. Crypto Market Data APIs

### 3.1 Crypto OHLCV (Binance)

**Old AlphaForge sources:**
- `src/services/binance/klines.ts` — `fetchKlines()`, `fetchAllKlines()`; calls `https://api.binance.com/api/v3/klines`
- `src/services/brokers/binance/adapter.ts` — uses klines for scalper indicator warm-up

**New data-service2.0 endpoint:**

```
GET /v1/crypto/{symbol}/ohlcv?interval=1h&limit=500&from=2026-01-01T00:00:00Z&to=2026-01-15T00:00:00Z
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | path string | ✅ | Binance symbol, e.g. `BTCUSDT`, `ETHUSDT`, `SOLUSDT` |
| `interval` | query string | ✅ | Binance interval: `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`. **Note: `3m` IS valid for crypto (unlike India data).** |
| `limit` | query integer | ❌ | Candles to return. Range: 1–1000. Default: 500 |
| `from` | query string | ❌ | Start time (ISO-8601) |
| `to` | query string | ❌ | End time (ISO-8601) |

**Example:**
```
GET http://data-service:8200/v1/crypto/BTCUSDT/ohlcv?interval=1h&limit=200
X-API-KEY: <key>
```

**AlphaForge consumer update:**
- Replace all `fetchKlines()` / `fetchAllKlines()` calls
- Worker `scalper.ts` indicator warm-up: replace `getServerBroker().getKlines()` → `GET /v1/crypto/{symbol}/ohlcv`

---

### 3.2 Crypto Ticker (Binance)

**Old AlphaForge sources:**
- `src/services/binance/rest.ts` — `fetch24hrTickers()`; calls `https://api.binance.com/api/v3/ticker/24hr`

**New data-service2.0 endpoint:**

```
GET /v1/crypto/{symbol}/ticker
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | path string | ✅ | Binance symbol, e.g. `BTCUSDT` |

**Response shape (inside `data`):**
```json
{
  "symbol": "BTCUSDT",
  "price": 97500.0,
  "metadata": { ... }
}
```

**AlphaForge consumer update:**
- Replace `fetch24hrTickers()` calls for single-symbol price lookups

---

### 3.3 Crypto 24h Stats (Binance)

**Old AlphaForge sources:**
- `src/services/binance/rest.ts` — `fetch24hrTickers()`; used for dashboard tickers and price bars

**New data-service2.0 endpoint:**

```
GET /v1/crypto/{symbol}/stats
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | path string | ✅ | Binance symbol, e.g. `BTCUSDT`, `ETHUSDT` |

**Response shape (inside `data`):** Full Binance 24hr stats (price, change, changePct, high, low, volume, quoteVolume).

**AlphaForge consumer update:**
- Replace `fetch24hrTickers()` calls in `GET /api/futures/tickers` handler

---

### 3.4 Crypto Futures Overview (Binance)

**Old AlphaForge sources:**
- `src/services/binance/futures.ts` — `fetchFundingInfo()`, `fetchOpenInterest()`, `fetchLongShortRatio()` via `https://fapi.binance.com`
- `src/services/brokers/delta/adapter.ts` — `getTicker()`, `getOpenInterest()`, `getFundingRate()`; Delta-specific perpetuals data
- `src/services/brokers/delta/rest.ts` — `fetchAllTickers()`, Delta REST calls
- `GET /api/futures/overview` route — aggregates both Binance + Delta broker adapters

**New data-service2.0 endpoint:**

```
GET /v1/crypto/futures/overview
```

No query parameters. Returns all tracked symbols (BTC, ETH, SOL).

**Response shape (inside `data`):**
```json
[
  {
    "symbol": "BTCUSDT",
    "markPrice": 97500.0,
    "fundingRate": 0.0001,
    "fundingRateAnnualized": 10.95,
    "nextFundingTime": "2026-01-15T16:00:00Z",
    "openInterest": 350000.0,
    "openInterestNotionalUsd": 34125000000.0,
    "oiChangePct1h": 0.25,
    "longShortRatio": 1.05,
    "longAccount": 51.2,
    "shortAccount": 48.8
  },
  ...
]
```

**AlphaForge consumer update:**
- `GET /api/futures/overview` → call `GET /v1/crypto/futures/overview`
- `GET /api/futures/tickers` → call `GET /v1/crypto/futures/overview` + `GET /v1/crypto/{symbol}/stats`
- Remove `src/services/binance/futures.ts` and Delta market-data REST methods

---

## 4. Deribit Options Analytics API

**Old AlphaForge sources:**
- `src/services/deribit/rest.ts` — `getOptionsOverview()`, `getBookSummary()`; calls `https://www.deribit.com/api/v2`
- `GET /api/options/overview` route — calls `getOptionsOverview(currency)`

**New data-service2.0 endpoint:**

```
GET /v1/deribit/{currency}/overview
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `currency` | path string | ✅ | `BTC`, `ETH`, or `SOL` |

**Example:**
```
GET http://data-service:8200/v1/deribit/BTC/overview
X-API-KEY: <key>
```

**Response shape (inside `data`):** Aggregated OI totals, put/call OI ratio, and per-contract summaries with mark price, mark IV, OI, volume.

**Additional Deribit endpoints available:**

| Endpoint | Usage |
|----------|-------|
| `GET /v1/deribit/{currency}/instruments` | List all Deribit instruments for a currency |
| `GET /v1/deribit/{currency}/index-price` | Current Deribit index price |
| `GET /v1/deribit/ticker/{instrument_name}` | Full ticker for a single instrument |
| `GET /v1/deribit/ohlcv/{instrument_name}?resolution=60&start_ts=...&end_ts=...` | Deribit OHLCV candles |

**AlphaForge consumer update:**
- `GET /api/options/overview` → `GET /v1/deribit/{currency}/overview`
- Remove `src/services/deribit/rest.ts`

---

## 5. Real-Time Streaming WebSocket

**Old AlphaForge sources:**
- `src/services/india/angelone/smartstream.ts` — SmartStream v2 binary WebSocket; client auth + TOTP required
- `src/lib/market-data/providers/upstox.ts` → Upstox v3 WebSocket feed (Protobuf binary)
- `src/services/binance/ws.ts` — Binance Spot mini-ticker WebSocket (client-side, `wss://stream.binance.com`)
- `src/services/binance/liquidation-ws.ts` — Binance Futures liquidation WebSocket (client-side)
- `src/services/brokers/delta/ws.ts` — Delta Exchange public WebSocket (client-side)
- `worker/src/jobs/scraping-tick-listener.ts` — consumes ticks from old data-service Redis stream

**New data-service2.0 endpoint:**

```
WS /v1/stream/ticks
```

**Protocol:**

1. **Connect:** `ws://data-service:8200/v1/stream/ticks` (include `X-API-KEY` as query param or initial message)
2. **Subscribe:** Send JSON control message:
   ```json
   { "action": "subscribe", "symbols": ["BTCUSDT", "NIFTY", "RELIANCE"], "market": "india" }
   ```
3. **Receive:** Server pushes normalised tick payloads for subscribed symbols:
   ```json
   {
     "symbol": "BTCUSDT",
     "price": 97500.0,
     "volume": 125.5,
     "timestamp": "2026-01-15T09:30:01.123Z",
     "market": "crypto"
   }
   ```
4. **Heartbeat:** Server sends heartbeat every 10 seconds; client must respond to avoid disconnection (3 missed → close)
5. **Unsubscribe:** Send `{ "action": "unsubscribe", "symbols": ["BTCUSDT"] }`
6. **Limits:** Maximum 500 subscribed symbols across all concurrent connections

**AlphaForge consumer update:**
- Replace `stream.subscribe()` in `DataServiceClient` → connect to `WS /v1/stream/ticks`
- Replace `SmartStreamClient` usage in `india-realtime-candles.ts`
- Remove client-side `src/services/binance/ws.ts`, `src/services/binance/liquidation-ws.ts`, `src/services/brokers/delta/ws.ts`
- Remove `worker/src/jobs/scraping-tick-listener.ts`

---

## 6. Health and Observability APIs

### 6.1 Liveness Probe

```
GET /v1/health/live
```

Always returns HTTP 200 within 200ms. Never blocks on external dependencies. Use as a Kubernetes/Docker liveness probe.

### 6.2 Readiness Probe

```
GET /v1/health/ready
```

Returns HTTP 200 when Redis + PostgreSQL respond. Returns HTTP 503 with a `capabilities` map when any dependency is unavailable.

### 6.3 Operational Health

```
GET /v1/health/data
```

Returns session state, freshness stats, gap counts, duplicate rates, circuit breaker states, clock-skew flag.

### 6.4 Provider Health (Replaces `DataServiceClient.observability.providerHealth()`)

**Old AlphaForge source:** `DataServiceClient.observability.providerHealth()` → `registry.getHealth()` → per-provider circuit breaker states

**New endpoint:**
```
GET /v1/analytics/providers
```

Returns list of all registered providers with health status, data freshness, and circuit-breaker state.

```
GET /v1/analytics/providers/{provider_id}
```

Returns detailed metrics for a single provider.

**AlphaForge consumer update:**
- `GET /api/v1/providers/status` → `GET /v1/analytics/providers`
- Remove per-provider health tracking from `src/lib/market-data/health.ts`

---

## 7. Data Quality Gate

**Old AlphaForge source:** `POST DATA_SERVICE_URL/data/gate` (via `src/lib/data-service/gate-client.ts`)

The gate-client already has a Phase 5 comment referencing `DATA_SERVICE_2_URL`. The endpoint path `/data/gate` needs to be confirmed against data-service2.0. The quality gate is exposed via:

```
GET /v1/analytics/quality
```

Returns aggregate quality metrics (averageScore, blockedCount, lowCount, mediumCount, highCount). For per-symbol gate evaluation, check if data-service2.0 exposes a `/data/gate` equivalent — if not, adapt `gate-client.ts` to use `GET /v1/analytics/quality` or implement client-side quality scoring based on quote metadata.

---

## 8. Old Source → New API Mapping (Complete Reference)

| Old AlphaForge Source | Old Mechanism | New data-service2.0 API |
|----------------------|---------------|------------------------|
| `ScraplingProvider.getLatestQuote()` | HTTP `GET DATA_SERVICE_URL/quotes` | `GET /v1/india/quotes/{symbol}?exchange=NSE` |
| `AngelOneProvider.getLatestQuote()` | SmartAPI Quote API (batched) | `GET /v1/india/quotes/{symbol}?exchange=NSE` |
| `UpstoxProvider.getLatestQuote()` | Upstox Market Quote REST | `GET /v1/india/quotes/{symbol}?exchange=NSE` |
| `YahooProvider.getLatestQuote()` | yahoo-finance2 (15-min delayed) | `GET /v1/india/quotes/{symbol}?exchange=NSE` |
| `ScraplingProvider.getHistoricalCandles()` | HTTP `GET DATA_SERVICE_URL/historical` | `GET /v1/india/historical?symbol=...&interval=...` |
| `AngelOneProvider.getHistoricalCandles()` | SmartAPI `getCandleData()` | `GET /v1/india/historical?symbol=...&interval=...` |
| `UpstoxProvider.getHistoricalCandles()` | Upstox Historical Candle v3 | `GET /v1/india/historical?symbol=...&interval=...` |
| `YahooProvider.getHistoricalCandles()` | yahoo-finance2 historical | `GET /v1/india/historical?symbol=...&interval=1d` |
| `AngelOneProvider.getOptionChain()` | ScripMaster + Quote API + Greeks API | `GET /v1/india/option-chain?underlying=NIFTY&expiry=...` |
| `UpstoxProvider.getOptionChain()` | Upstox Option Chain REST (full Greeks) | `GET /v1/india/option-chain?underlying=NIFTY&expiry=...` |
| `ScraplingProvider.getOptionChain()` | HTTP `GET DATA_SERVICE_URL/option-chain` | `GET /v1/india/option-chain?underlying=NIFTY&expiry=...` |
| `AngelOneProvider.getInstrumentMaster()` | ScripMaster dump (24h cache) | `GET /v1/instruments?exchange=NSE` |
| `ScraplingProvider.getInstrumentMaster()` | HTTP `GET DATA_SERVICE_URL/instruments` | `GET /v1/instruments?exchange=NSE` |
| `DataServiceClient.universe.fno()` | SmartAPI ScripMaster filter | `GET /v1/instruments/fno-universe` |
| `SmartStreamClient` (Angel One WS) | SmartStream v2 binary WebSocket | `WS /v1/stream/ticks` |
| `UpstoxProvider.subscribe()` | Upstox v3 Protobuf WebSocket | `WS /v1/stream/ticks` |
| `src/services/binance/ws.ts` | Binance Spot WS mini-ticker | `WS /v1/stream/ticks` |
| `src/services/binance/liquidation-ws.ts` | Binance Futures liquidation WS | `WS /v1/stream/ticks` |
| `src/services/brokers/delta/ws.ts` | Delta India public WS ticker | `WS /v1/stream/ticks` |
| `scraping-tick-listener.ts` (worker) | Old data-service Redis Pub/Sub ticks | `WS /v1/stream/ticks` |
| `src/services/binance/klines.ts` | Binance Spot REST klines | `GET /v1/crypto/{symbol}/ohlcv?interval=1h&limit=500` |
| `src/services/binance/rest.ts` (24hr tickers) | Binance Spot REST 24hr | `GET /v1/crypto/{symbol}/stats` |
| `src/services/binance/futures.ts` (funding/OI/L-S) | Binance USDM Futures REST | `GET /v1/crypto/futures/overview` |
| `src/services/brokers/delta/rest.ts` (tickers/klines) | Delta India REST | `GET /v1/crypto/futures/overview` |
| `src/services/deribit/rest.ts` | Deribit public REST API | `GET /v1/deribit/{currency}/overview` |
| `isNseMarketOpenIST()` | Local timezone logic | `GET /v1/india/market/status` |
| `GET /api/in/historical-data/gaps` | Old data-service gap table | `GET /v1/india/historical/gaps` |
| `DataServiceClient.observability.providerHealth()` | In-process registry health | `GET /v1/analytics/providers` |
| `POST DATA_SERVICE_URL/data/gate` | Old data-service quality gate | `GET /v1/analytics/quality` (or equivalent) |
| `GET /api/futures/tickers` → `getFuturesTickers()` | Delta REST + Binance REST | `GET /v1/crypto/futures/overview` + `GET /v1/crypto/{symbol}/stats` |
| `GET /api/futures/overview` | Delta/Binance broker adapters | `GET /v1/crypto/futures/overview` |
| `GET /api/options/overview` → `getOptionsOverview()` | `src/services/deribit/rest.ts` | `GET /v1/deribit/{currency}/overview` |

---

## 9. New `DataService2Client` Design

The replacement for `src/lib/data-service/client.ts` should be a simple typed HTTP client with no provider logic, no fallover, no credential management:

```typescript
// src/lib/data-service/client.ts (new)
import "server-only";

const BASE_URL = process.env.DATA_SERVICE_URL ?? "http://localhost:8200";
const API_KEY = process.env.DATA_SERVICE_API_KEY ?? "";

async function ds2Fetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      "X-API-KEY": API_KEY,
      "Accept": "application/json",
      ...opts?.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new DataService2Error(res.status, await res.json());
  const envelope = await res.json();
  return envelope.data as T;
}

export const DataServiceClient = {
  market: {
    quote: (symbol: string, exchange = "NSE") =>
      ds2Fetch<MDQuote>(`/v1/india/quotes/${symbol}?exchange=${exchange}`),
    // ... etc
  },
  // ...
};
```

Key differences from the old client:
1. **No `getRegistry()`** — no provider registry, no bootstrap
2. **No `withFailover()`** — single HTTP call, trust data-service2.0 to handle failover internally
3. **No credential management** — only `DATA_SERVICE_API_KEY`
4. **No per-provider health tracking** — use `GET /v1/analytics/providers` via observability namespace
5. **Fail-fast timeouts** — 10s per request, consistent across all calls

---

## 10. Environment Variable Changes Required

### Remove (no longer needed in AlphaForge)

```bash
# Remove after migration:
SMARTAPI_API_KEY=
SMARTAPI_CLIENT_CODE=
SMARTAPI_PIN=
SMARTAPI_TOTP_SECRET=
SMARTAPI_LOCAL_IP=
SMARTAPI_PUBLIC_IP=
SMARTAPI_MAC_ADDRESS=
SMARTAPI_USER_AGENT=
UPSTOX_ANALYTICS_TOKEN=
UPSTOX_ACCESS_TOKEN=
INDIA_DATA_PROVIDER=
```

### Add (required for data-service2.0)

```bash
# New — required for data-service2.0 integration:
DATA_SERVICE_URL=http://data-service:8200        # Docker; http://localhost:8200 for dev
DATA_SERVICE_API_KEY=<key>                        # X-API-KEY header value
```

### Keep (execution brokers + other services)

```bash
# Keep — execution broker OAuth:
UPSTOX_CLIENT_ID=
UPSTOX_CLIENT_SECRET=
UPSTOX_REDIRECT_URI=

# Keep — unchanged:
DATABASE_URL=
REDIS_URL=
ML_SERVICE_URL=
AUTH_SECRET=
ENCRYPTION_KEY=
COINGECKO_API_KEY=          # Evaluate — not covered by data-service2.0
COINGLASS_API_KEY=          # Evaluate
DERIBIT_CLIENT_ID=          # Only if Deribit auth needed beyond public API
DERIBIT_SECRET=             # Only if Deribit auth needed beyond public API
```
