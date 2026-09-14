# ALPHAFORGE PROVIDER USAGE MATRIX

**Date:** 2026  
**Branch:** `refactor/data-service-centralization`  
**Purpose:** Complete inventory of every provider file, its function, whether it is market data or execution, and the required action for data-service2.0 centralization.

---

## Classification Legend

- **Market Data** — Fetches price quotes, candles, option chains, ticks, OI, funding rates, or any live/historical market information. **Must be removed and replaced with data-service2.0 calls.**
- **Execution** — Handles OAuth, order placement, portfolio reads, account management. **Must be kept.**
- **Both** — File contains both market-data and execution logic. **Market-data parts removed, execution parts kept.**
- **Unrelated** — Neither market data nor execution (e.g. sentiment, analytics). **Keep as-is unless otherwise noted.**

---

## Full Provider Usage Matrix

| Provider | File | Function / Usage | Purpose | Market Data? | Execution? | Action |
|----------|------|-----------------|---------|:---:|:---:|--------|
| **Angel One SmartAPI** | `src/services/india/angelone/index.ts` | SmartAPI adapter: option chain synthesis (ScripMaster + Quote API + Greeks), historical candles, live quotes, WebSocket auth; TOTP auth plumbing | Market data (option chain, quotes, candles) + auth | ✅ | ✅ | **Remove market-data methods**; keep TOTP auth only if used by execution broker |
| **Angel One SmartAPI** | `src/services/india/angelone/derivatives.ts` | Pure parsers: gainers/losers, PCR, OI buildup from SmartAPI `marketData` endpoints | Market data (derivatives analytics) | ✅ | ❌ | **Remove** — data-service2.0 handles this internally |
| **Angel One SmartAPI** | `src/services/india/angelone/portfolio.ts` | Account parsers: funds/margin (getRMS), holdings, positions — pure I/O-free normalizers | Execution (portfolio/account data) | ❌ | ✅ | **Keep** |
| **Angel One SmartAPI** | `src/services/india/angelone/smartstream.ts` | SmartStream v2 binary frame parser + `SmartStreamClient`; WebSocket live tick feed | Market data (live tick WebSocket) | ✅ | ❌ | **Remove** — replace with `WS /v1/stream/ticks` |
| **Angel One SmartAPI** | `src/lib/market-data/providers/angel-one.ts` | `AngelOneProvider` implementing `MarketDataProvider`; priority 1 in registry; quotes, candles, option chain, instrument master, WebSocket subscribe | Market data provider adapter | ✅ | ❌ | **Remove** — entire provider adapter replaced by data-service2.0 |
| **Upstox** | `src/lib/market-data/providers/upstox.ts` | `UpstoxProvider` implementing `MarketDataProvider`; priority 2; historical candles, live quotes, option chain with full Greeks, WebSocket v3 feed | Market data provider adapter | ✅ | ❌ | **Remove** — entire provider adapter replaced by data-service2.0 |
| **Upstox** | `src/lib/market-data/providers/upstox-instruments.ts` | NSE symbol → Upstox instrument key resolution; cached instrument table | Market data (instrument resolution) | ✅ | ❌ | **Remove** — instrument resolution handled by data-service2.0 |
| **Upstox** | `src/lib/market-data/providers/upstox-proto.ts` | Dependency-free Protobuf v3 frame decoder for Upstox WebSocket feed | Market data (WS frame parsing) | ✅ | ❌ | **Remove** — WS replaced by data-service2.0 |
| **Upstox** | `src/lib/market-data/providers/upstox-token-state.ts` | In-memory OAuth2 access-token state (server-only); shared between provider and OAuth callback | Shared auth state | ✅ partial | ✅ partial | **Keep for OAuth/execution**; market-data usage removed |
| **Upstox** | `src/app/api/in/providers/upstox/connect/route.ts` | `GET` — generates Upstox OAuth2 authorization URL; redirects user to broker login | Execution (broker OAuth initiation) | ❌ | ✅ | **Keep** |
| **Upstox** | `src/app/api/in/providers/upstox/callback/route.ts` | `GET` — Upstox OAuth2 callback; server-side token exchange; stores token in memory | Execution (broker token exchange) | ❌ | ✅ | **Keep** |
| **Upstox** | `src/app/api/in/providers/upstox/status/route.ts` | `GET` — returns current Upstox OAuth connection status | Execution (broker status) | ❌ | ✅ | **Keep** |
| **Upstox** | `src/app/api/in/providers/upstox/disconnect/route.ts` | `POST` — invalidates in-memory Upstox token | Execution (broker disconnect) | ❌ | ✅ | **Keep** |
| **NSE** | `src/services/india/nse/index.ts` | **STUB** — Direct NSE adapter removed 2026-09-03; all methods throw | N/A (stub) | N/A | N/A | **Keep stub** (prevents accidental re-introduction via git revert) |
| **NSE** | `src/lib/market-data/providers/nse.ts` | **STUB** — Not registered, not exported; tombstone file explaining removal reason | N/A (stub) | N/A | N/A | **Keep stub** |
| **Yahoo Finance** | `src/services/india/yahoo/index.ts` | Yahoo Finance v2 adapter: historical equity candles, delayed quotes; implements `BrokerAdapter` | Market data (equity history, delayed quotes) | ✅ | ❌ | **Remove** |
| **Yahoo Finance** | `src/lib/market-data/providers/yahoo.ts` | `YahooProvider` — priority 3 (last resort); 15-min delayed quotes, equity historical only | Market data provider adapter | ✅ | ❌ | **Remove** |
| **Scrapling / Old Data Service** | `src/lib/market-data/providers/scrapling.ts` | `ScraplingProvider` — HTTP client wrapping OLD Python `data-service/` on `DATA_SERVICE_URL`; priority 0; quotes, candles, option chain, instrument master | Market data via old Python scraper | ✅ | ❌ | **Replace** — rewrite as data-service2.0 HTTP client |
| **Binance** | `src/services/binance/rest.ts` | Binance Spot REST: `fetch24hrTickers()` — 24-hour ticker snapshots for multiple symbols | Market data (spot tickers) | ✅ | ❌ | **Remove** — replace with `GET /v1/crypto/{symbol}/stats` |
| **Binance** | `src/services/binance/klines.ts` | Binance Spot REST: `fetchKlines()`, `fetchAllKlines()` — OHLCV candlestick data | Market data (spot OHLCV) | ✅ | ❌ | **Remove** — replace with `GET /v1/crypto/{symbol}/ohlcv` |
| **Binance** | `src/services/binance/futures.ts` | Binance USDM Futures REST: funding rate, mark price, OI, long/short ratio via `https://fapi.binance.com` | Market data (perpetual futures) | ✅ | ❌ | **Remove** — replace with `GET /v1/crypto/futures/overview` |
| **Binance** | `src/services/binance/ws.ts` | Binance Spot WebSocket mini-ticker stream; client-side `"use client"` | Market data (live tickers, client-side) | ✅ | ❌ | **Remove** — replace with `WS /v1/stream/ticks` |
| **Binance** | `src/services/binance/liquidation-ws.ts` | Binance Futures liquidation WebSocket; client-side `"use client"`; connects to `wss://fstream.binance.com` | Market data (liquidations, client-side) | ✅ | ❌ | **Remove** — replace with `WS /v1/stream/ticks` |
| **Binance (Broker)** | `src/services/brokers/binance/adapter.ts` | Binance `ServerBrokerAdapter` — implements server-side broker interface; uses klines for scalper indicators | Both (broker execution + candle fetch) | ✅ | ✅ | **Remove candle-fetch parts** — replace with data-service2.0; keep order-placement methods |
| **Binance (Broker)** | `src/services/brokers/binance/client.ts` | Binance broker HTTP client — REST wrapper for order management | Execution (orders, account) | ❌ | ✅ | **Keep** |
| **Deribit** | `src/services/deribit/rest.ts` | Deribit REST via `https://www.deribit.com/api/v2`: book summary → options overview with OI, Greeks, IV | Market data (crypto options) | ✅ | ❌ | **Remove** — replace with `GET /v1/deribit/options/overview` |
| **Delta Exchange** | `src/services/brokers/delta/rest.ts` | Delta India REST: tickers, klines, products; `fetchAllTickers()`, `fetchCandleRange()`, `fetchLatestCandles()` | Market data (Delta perpetuals) | ✅ | ❌ | **Remove market-data methods** — replace with `GET /v1/crypto/futures/overview` |
| **Delta Exchange** | `src/services/brokers/delta/ws.ts` | Delta India public WebSocket: real-time ticker stream; `"use client"`; handles compact and legacy ticker payloads | Market data (live tickers, client-side) | ✅ | ❌ | **Remove** — replace with `WS /v1/stream/ticks` |
| **Delta Exchange** | `src/services/brokers/delta/adapter.ts` | Delta `ServerBrokerAdapter` — implements `BrokerPairs`, tickers, candles, OI, funding rate, long/short; uses rest.ts | Market data (server-side) | ✅ | ✅ | **Remove market-data fetch methods** — replace with data-service2.0; keep execution methods |
| **CoinGecko** | `src/services/coingecko/rest.ts` | CoinGecko REST: global market cap, coin market cap per symbol; uses `COINGECKO_API_KEY` | Market data (macro/supplementary) | ✅ | ❌ | **Evaluate** — check if data-service2.0 covers this; keep if not covered |
| **Altme / Alternative.me** | `src/services/altme/fearGreed.ts` | Fear & Greed Index from `api.alternative.me/fng/`; crypto sentiment indicator | Sentiment / meta-indicator | ❌ | ❌ | **Keep as-is** — NOT market data; no action required |
| **Old Python Data Service** | `data-service/` (entire directory) | Python FastAPI scraping microservice — NSE/BSE scraper using jugaad and openchart providers; owns OHLCV + instrument data in its own PostgreSQL schema | Market data (scraping) | ✅ | ❌ | **Remove entire directory** |

---

## Action Summary by Category

### Remove (Market Data — Replaced by data-service2.0)

| File | Replacement API |
|------|----------------|
| `src/lib/market-data/providers/scrapling.ts` | Rewrite as data-service2.0 HTTP client |
| `src/lib/market-data/providers/angel-one.ts` | data-service2.0 India endpoints |
| `src/lib/market-data/providers/upstox.ts` | data-service2.0 India endpoints |
| `src/lib/market-data/providers/upstox-instruments.ts` | `GET /v1/instruments` |
| `src/lib/market-data/providers/upstox-proto.ts` | No longer needed |
| `src/lib/market-data/providers/yahoo.ts` | data-service2.0 India endpoints |
| `src/services/india/angelone/index.ts` (market-data methods) | data-service2.0 India endpoints |
| `src/services/india/angelone/derivatives.ts` | data-service2.0 India endpoints |
| `src/services/india/angelone/smartstream.ts` | `WS /v1/stream/ticks` |
| `src/services/india/yahoo/index.ts` | data-service2.0 India endpoints |
| `src/services/binance/rest.ts` | `GET /v1/crypto/{symbol}/stats` |
| `src/services/binance/klines.ts` | `GET /v1/crypto/{symbol}/ohlcv` |
| `src/services/binance/futures.ts` | `GET /v1/crypto/futures/overview` |
| `src/services/binance/ws.ts` | `WS /v1/stream/ticks` |
| `src/services/binance/liquidation-ws.ts` | `WS /v1/stream/ticks` |
| `src/services/deribit/rest.ts` | `GET /v1/deribit/options/overview` |
| `src/services/brokers/delta/ws.ts` | `WS /v1/stream/ticks` |
| `src/services/brokers/delta/rest.ts` (market-data methods) | `GET /v1/crypto/futures/overview` |
| `data-service/` (entire directory) | Replaced by data-service2.0 entirely |

### Keep (Execution — Not Affected)

- `src/services/india/angelone/portfolio.ts`
- `src/app/api/in/providers/upstox/connect/route.ts`
- `src/app/api/in/providers/upstox/callback/route.ts`
- `src/app/api/in/providers/upstox/status/route.ts`
- `src/app/api/in/providers/upstox/disconnect/route.ts`
- `src/services/brokers/binance/client.ts`
- `src/services/brokers/delta/adapter.ts` (execution methods only)

### Keep (Stubs — Prevent Re-introduction)

- `src/services/india/nse/index.ts`
- `src/lib/market-data/providers/nse.ts`

### Keep (Unrelated / Not Market Data)

- `src/services/altme/fearGreed.ts` — sentiment index, no change needed

### Evaluate

- `src/services/coingecko/rest.ts` — global market cap; check data-service2.0 coverage before removing
