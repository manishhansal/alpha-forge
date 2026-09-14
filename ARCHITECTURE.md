# AlphaForge Architecture

## Core Principle

AlphaForge is a **data consumer**, not a data collector.

All market data comes exclusively from **data-service2.0**. AlphaForge does not connect to any market-data provider directly.

## Architecture Diagram

```
                         USER
                           |
                           v
                    ALPHAFORGE (Next.js)
                           |
        +------------------+------------------+
        |                  |                  |
        v                  v                  v
     Signals            Charts            Analytics
     Engine             (OHLCV)           (Options)
        |                  |                  |
        +------------------+------------------+
                           |
                           v
              ┌─────────────────────────────┐
              │  src/lib/data-service/       │
              │  client.ts                   │
              │  (canonical HTTP client)     │
              └─────────────┬───────────────┘
                            │
                            │ REST + WebSocket
                            │ DATA_SERVICE_2_URL
                            v
              ┌─────────────────────────────┐
              │      DATA-SERVICE 2.0        │
              │      (port 8200)             │
              │                             │
              │  - Indian market data       │
              │  - Crypto market data       │
              │  - Historical OHLCV         │
              │  - Live tick streaming      │
              │  - Option chain analytics   │
              │  - F&O universe             │
              │  - Data quality gate        │
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

## What AlphaForge Does NOT Do

- Connect directly to NSE, BSE, Angel One, Upstox, Yahoo Finance
- Connect directly to Binance, Deribit, Delta Exchange
- Scrape market data
- Store OHLCV candles, ticks, option chains, or instrument masters
- Maintain a fallback provider chain
- Run market-data workers or ingestion jobs

## Data Flow

```
AlphaForge signal engine needs NIFTY candles:

  1. Calls: getHistorical({ symbol: "NIFTY", interval: "5m" })
  2. → src/lib/data-service/client.ts
  3. → GET http://data-service:8200/v1/india/historical?symbol=NIFTY&interval=5m
  4. ← data-service2.0 responds with canonical OHLCVCandle[]
  5. Signal engine processes candles

AlphaForge does NOT know which provider supplied the data.
```

## Environment Configuration

| Variable | Purpose | Required |
|---|---|---|
| `DATA_SERVICE_2_URL` | data-service2.0 base URL | Yes |
| `DATA_SERVICE_API_KEY` | data-service2.0 API key | Production |
| `DATABASE_URL` | AlphaForge PostgreSQL | Yes |
| `REDIS_URL` | AlphaForge Redis cache | Yes |
| `AUTH_SECRET` | NextAuth.js secret | Yes |

No market-data provider credentials are required in AlphaForge.

## Error Handling

If data-service2.0 is unavailable:

```
AlphaForge → DataServiceUnavailableError
```

AlphaForge returns `DATA_SERVICE_UNAVAILABLE` to callers.
It does **not** fall back to any provider.
This is intentional — if data-service2.0 is down, AlphaForge waits.
