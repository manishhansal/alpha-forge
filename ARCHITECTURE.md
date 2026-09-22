# AlphaForge Architecture

> Last updated: 2026-09-22 | HEAD: `3fe6281` (Merge PR #39)

## Core Principle

AlphaForge is a **data consumer**, not a data collector.

All market data comes exclusively from **data-service2.0**. AlphaForge does not connect to any market-data provider directly. News intelligence comes exclusively from **SentinelPulse**.

## Architecture Diagram

```
                         USER
                           |
                           v
                    ALPHAFORGE (Next.js)
                           |
        +------------------+------------------+------------------+
        |                  |                  |                  |
        v                  v                  v                  v
     Signals            Charts            Analytics           News / AI
     Engine             (OHLCV)           (Options)           Signals
        |                  |                  |                  |
        +------------------+------------------+                  |
                           |                                     |
                           v                                     v
              ┌─────────────────────────────┐     ┌─────────────────────────┐
              │  src/lib/data-service/       │     │  src/features/india/    │
              │  client.ts                   │     │  news/sentinel-client.ts│
              │  (canonical HTTP client)     │     │  (SentinelPulse client) │
              └─────────────┬───────────────┘     └────────────┬────────────┘
                            │                                   │
                            │ REST + WebSocket                  │ REST
                            │ DATA_SERVICE_2_URL                │ SENTINEL_PULSE_URL
                            v                                   v
              ┌─────────────────────────────┐     ┌─────────────────────────┐
              │      DATA-SERVICE 2.0        │     │      SENTINELPULSE       │
              │      (port 8200)             │     │      (port 3001)         │
              │                             │     │                          │
              │  - Indian market data       │     │  - Latest news articles  │
              │  - Crypto market data       │     │  - India market news     │
              │  - Historical OHLCV         │     │  - Market regime         │
              │  - Live tick streaming      │     │  - AlphaForge context    │
              │  - Option chain analytics   │     │  - High-impact events    │
              │  - F&O universe             │     │  - ML sentiment scores   │
              │  - Data quality gate        │     └─────────────────────────┘
              │  - Provider health          │
              └──────┬──────────────┬───────┘
                     │              │
                     v              v
              INDIAN MARKET      CRYPTO
               PROVIDERS        PROVIDERS
              (NSE, Angel One,  (Binance,
               Upstox, etc.)    Deribit)
```

## What AlphaForge Does

- UI for trading signals, charts, and analytics
- Paper trading (order simulation, no live execution)
- Signal engine (generates buy/sell signals)
- ML predictions (price forecasting)
- Strategy lab (backtest and live paper-trade strategies)
- India F&O scanner and daily picks
- Options analytics and workbench
- Portfolio and trade journal
- News intelligence feed (via SentinelPulse)

## What AlphaForge Does NOT Do

- Connect directly to NSE, BSE, Angel One, Upstox, Yahoo Finance
- Connect directly to Binance, Deribit, Delta Exchange
- Scrape market data or RSS feeds
- Store OHLCV candles, ticks, option chains, or instrument masters
- Maintain a fallback provider chain for market data
- Run market-data workers or ingestion jobs
- Fetch or parse RSS/XML news feeds (removed — replaced by SentinelPulse)

## Data Flow — Market Data

```
AlphaForge signal engine needs NIFTY candles:

  1. Calls: getHistorical({ symbol: "NIFTY", interval: "5m" })
  2. → src/lib/data-service/client.ts
  3. → GET http://data-service:8200/v1/india/historical?symbol=NIFTY&interval=5m
  4. ← data-service2.0 responds with canonical OHLCVCandle[]
  5. Signal engine processes candles

AlphaForge does NOT know which provider supplied the data.
```

## Data Flow — News Intelligence

```
India AI signal builder needs news sentiment for RELIANCE:

  1. Calls: loadNewsScores({ symbol: "RELIANCE" })
  2. → src/features/india/news/index.ts (getIndiaNews)
  3. → SentinelPulse /news/latest + /news/market/india (parallel)
  4. ← SentinelPulse returns NewsItem[] with importanceScore + sentimentScore
  5. Redis cache: sp:news:* (90s TTL), sp:market:india (60s TTL)
  6. AI engine uses importanceScore-weighted sentiment as news factor (weight 0.08)

AlphaForge does NOT parse RSS feeds or scrape news sources.
```

## Data Flow — Simulated Fallback (Dev / Staging)

```
data-service2.0 is running but has no live upstream provider:

  1. India API route calls data-service2.0
  2. data-service2.0 returns empty / unavailable response
  3. API route detects unavailability
  4. Falls back to: src/lib/data-service/simulated-india.ts
  5. Returns realistic synthetic data with DataSourceBadge = "SIMULATED"

No configuration required — fallback is automatic.
When live data is available, it takes priority.
```

## Removed Components

The following were removed and must not be re-introduced:

| Removed | Replaced By |
|---------|-------------|
| `src/features/india/news/feeds.ts` (RSS catalogue) | SentinelPulse `sentinel-client.ts` |
| `src/features/india/news/rss.ts` (XML parser) | SentinelPulse service layer |
| `ProviderRegistry` / `withFailover()` in TypeScript | data-service2.0 internal failover |
| Direct Yahoo Finance calls | data-service2.0 |
| Direct Angel One / Upstox data calls | data-service2.0 |
| NSE direct scraping | data-service2.0 |
| `src/components/india/msb-dashboard/MsbSignalsSection` | Removed (external CSV dependency) |

## Environment Configuration

| Variable | Purpose | Required |
|---|---|---|
| `DATA_SERVICE_2_URL` | data-service2.0 base URL | Yes |
| `DATA_SERVICE_API_KEY` | data-service2.0 API key | Production |
| `SENTINEL_PULSE_URL` | SentinelPulse news service URL | For news/AI signals |
| `SENTINEL_PULSE_API_KEY` | SentinelPulse API key | For news/AI signals |
| `DATABASE_URL` | AlphaForge PostgreSQL | Yes |
| `REDIS_URL` | AlphaForge Redis cache | Yes |
| `AUTH_SECRET` | NextAuth.js secret | Yes |

No market-data provider credentials (Angel One, Upstox, NSE) are required in AlphaForge.

## Error Handling

### Market data unavailable

```
AlphaForge → DataServiceUnavailableError
```

AlphaForge returns `DATA_SERVICE_UNAVAILABLE` to callers.
It does **not** fall back to any provider.
India API routes additionally fall back to `simulated-india.ts` for non-critical surfaces (market snapshot, sector stocks, scanner) — real trading decisions are gated on live data only.

### News unavailable

```
getIndiaNews() → returns empty articles array + synthesised sentiment from cached scores
```

The AI signal builder degrades gracefully: news factor defaults to neutral (0) when SentinelPulse is unreachable.

## Key Source Files

| File | Role |
|------|------|
| `src/lib/data-service/client.ts` | Canonical market data entry point (server-only) |
| `src/lib/data-service/simulated-india.ts` | Synthetic fallback for dev/staging |
| `src/features/india/news/sentinel-client.ts` | Typed SentinelPulse HTTP client |
| `src/features/india/news/index.ts` | News service (getIndiaNews, Redis caching) |
| `src/app/api/in/news/route.ts` | News API routes (latest, market-india, regime, context) |
| `src/services/brokers/client.ts` | Browser WebSocket factory (appends ?api_key= for WS auth) |
| `eslint.config.mjs` | `no-restricted-imports` boundary — enforces data-service2.0 and SentinelPulse separation |
