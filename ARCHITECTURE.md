# AlphaForge Architecture

> Last updated: 2026-10-09 | HEAD: `ffcaaab` (Merge PR #44)

## Core Principle

AlphaForge is a **data consumer**, not a data collector.

All market data comes exclusively from **data-service2.0**. AlphaForge does not connect to any market-data provider directly. News intelligence comes exclusively from **SentinelPulse**. ML predictions and LightGBM signals come exclusively from **ml-service2.0**.

## Architecture Diagram

```
                         USER
                           |
                           v
                    ALPHAFORGE (Next.js)
                           |
        +------------------+------------------+------------------+------------------+
        |                  |                  |                  |                  |
        v                  v                  v                  v                  v
     Signals            Charts            Analytics           News / AI          ML Signals
     Engine             (OHLCV)           (Options)           Signals             (LightGBM)
        |                  |                  |                  |                  |
        +------------------+------------------+                  |                  |
                           |                                     |                  |
                           v                                     v                  v
              ┌─────────────────────────────┐     ┌─────────────────────────┐  ┌──────────────────┐
              │  src/lib/data-service/       │     │  src/features/india/    │  │  src/lib/india/  │
              │  client.ts                   │     │  news/sentinel-client.ts│  │  ml-client.ts    │
              │  (canonical HTTP client)     │     │  (SentinelPulse client) │  │  (951 lines)     │
              └─────────────┬───────────────┘     └────────────┬────────────┘  └────────┬─────────┘
                            │                                   │                        │
                            │ REST + WebSocket                  │ REST                   │ REST
                            │ DATA_SERVICE_2_URL                │ SENTINEL_PULSE_URL     │ ML_SERVICE_URL
                            v                                   v                        v
              ┌─────────────────────────────┐     ┌─────────────────────────┐  ┌──────────────────────┐
              │      DATA-SERVICE 2.0        │     │      SENTINELPULSE       │  │    ML-SERVICE 2.0    │
              │      (port 8200)             │     │      (port 3001)         │  │    (port 8100)       │
              │                             │     │                          │  │                      │
              │  - Indian market data       │     │  - Latest news articles  │  │  - /v2/predict/*     │
              │  - Crypto market data       │     │  - India market news     │  │  - /v2/meta/decide   │
              │  - Historical OHLCV         │     │  - Market regime         │  │  - /v2/signals/*     │
              │  - Live tick streaming      │     │  - AlphaForge context    │  │  - /v2/analytics/*   │
              │  - Option chain analytics   │     │  - High-impact events    │  │  X-API-KEY on all    │
              │  - F&O universe             │     │  - ML sentiment scores   │  └──────────────────────┘
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
- ML predictions (price forecasting via ml-service2.0)
- ML Signals page (`/in/ml-signals`) — live LightGBM scores, history, sector context
- Opportunity Engine pipeline (12 stages, Stage 12 = MetaDecisionEngine gate)
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

## Data Flow — ML Signals (LightGBM scores from ml-service2.0)

```
India ML Signals page (/in/ml-signals) needs latest LightGBM scores:

  1. Calls: GET /api/in/ml-signals (or ?view=history&date=... / ?view=context)
  2. → src/app/api/in/ml-signals/route.ts
  3. → fetchMLLatestSignals() in src/lib/india/ml-client.ts
  4. → GET http://ml-service:8100/v2/signals/latest  (X-API-KEY header)
  5. ← ml-service2.0 returns MLLatestSignalsResponse (scores, conviction, sector)
  6. Redis cache: ml:signals:latest:v2 (30s TTL)
  7. Context view: parallel fetch of scanner hits + NIFTY quote

AlphaForge does NOT run any ML models internally.
```

## Data Flow — MetaDecisionEngine (Stage 12 Opportunity Gate)

```
Every signal entering the Opportunity Engine:

  1. Stages 1–11: signal evaluation, EV, risk check, sizing
  2. Stage 12: buildMLContext() + buildModelOutputs()
  3. → predictMetaDecision() in src/lib/india/ml-client.ts
  4. → POST http://ml-service:8100/v2/meta/decide  (X-API-KEY header)
  5.   Payload includes: model outputs + SentinelPulse news context
  6.   (sentinelToNewsContext() in ml-service2-integration.ts)
  7. ← MetaDecisionEngine returns: action, abstention flag, SHAP rationale
  8. applyMetaDecision(): if abstention=true → override pipeline to ABSTAIN
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
| `ML_SERVICE_URL` | ml-service2.0 base URL (`http://localhost:8100` local, `http://host.docker.internal:8100` Docker) | For ML predictions |
| `ML_SERVICE_API_KEY` | ml-service2.0 API key | For ML predictions |
| `ML_MODE` | `fallback` (default) — silently degrades when ML is down; `required` — throws on failure | Optional |
| `DATABASE_URL` | AlphaForge PostgreSQL | Yes |
| `REDIS_URL` | AlphaForge Redis cache | Yes |
| `AUTH_SECRET` | NextAuth.js secret | Yes |

No market-data provider credentials (Angel One, Upstox, NSE) are required in AlphaForge.

> **ml-service2.0** runs as a standalone Docker Compose stack in its own repository. It is not defined in `alpha-forge/docker-compose.yml`. To start it: `cd ../ml-service2.0 && make up`. AlphaForge's `ML_MODE=fallback` means all features degrade gracefully if ml-service2.0 is unavailable.

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
| `src/lib/india/ml-client.ts` | ML service v2 client — all /v2/* endpoints, X-API-KEY auth (951 lines) |
| `src/lib/india/ml-service2-integration.ts` | MetaDecisionEngine Stage 12 wiring — buildMLContext, buildModelOutputs, sentinelToNewsContext, applyMetaDecision (519 lines) |
| `src/app/api/in/ml-signals/route.ts` | ML Signals API — 4 views: default, history, log, context |
| `src/components/india/ml-signals/ml-signals-board.tsx` | ML Signals UI component (849 lines) |
| `src/features/india/news/sentinel-client.ts` | Typed SentinelPulse HTTP client |
| `src/features/india/news/index.ts` | News service (getIndiaNews, Redis caching) |
| `src/app/api/in/news/route.ts` | News API routes (latest, market-india, regime, context) |
| `src/services/brokers/client.ts` | Browser WebSocket factory (appends ?api_key= for WS auth) |
| `eslint.config.mjs` | `no-restricted-imports` boundary — enforces service separation |

## Opportunity Engine — 12-Stage Pipeline

Every signal passes through `src/lib/opportunity-engine/pipeline.ts` before a paper trade is opened:

1. Universe coverage validation
2. Market context snapshot
3. Multi-layer signal evaluation (12 layers; VETO from any = rejection)
4. Derivatives intelligence (OI freshness, chain quality, flow labels)
5. Signal quality vector (14 components)
6. Expected value calculation (Platt-calibrated EV)
7. Opportunity clustering (correlated signals → one cluster)
8. Conflict resolution (BUY/SELL/WAIT/NO_TRADE)
9. Abstention evaluation (15 explicit reasons)
10. Risk check (PortfolioRiskEngine v2)
11. Position sizing (dynamic: base × confidence × vol × correlation × drawdown)
12. **MetaDecisionEngine gate (PR #41)** — calls `/v2/meta/decide`; if `meta.abstention=true` or `meta.action=NO_TRADE`, overrides decision to ABSTAIN

Stage 12 is wired via `src/lib/india/ml-service2-integration.ts` (519 lines).

## ML Signals Page (`/in/ml-signals`)

Added in PR #43/44. Live LightGBM scoring dashboard from ml-service2.0:

**API route:** `GET /api/in/ml-signals`

| View | Query | Cache TTL | Description |
|------|-------|-----------|-------------|
| Default | (none) | 30s | Latest LightGBM scores for all symbols — score, conviction, direction, sector |
| History | `?view=history&date=YYYY-MM-DD` | 60s | ForecastLedger records for a session date with resolved outcomes |
| Log | `?view=log&n=10` | 15s | Last N autorun tick samples (mini time-series) |
| Context | `?view=context` | 45s | NIFTY LTP + sector movers + F&O gainers/losers |

**UI features (ml-signals-board.tsx):**
- Live score table with sector column and sector filter dropdown
- NIFTY bias indicator (live LTP + changePct)
- Sector movers panel (average changePct per sector from scanner)
- F&O gainers/losers panels (top momentum scanner hits)
- History tab with date picker and outcome resolution (won/lost/open, Brier score delta)
- Market-closed banner with auto-fallback to last known session

**Key types** (`src/lib/india/ml-client.ts`):
- `MLSignalScore` — symbol, score, conviction, direction, sector
- `MLConviction` — STRONG_LONG | LONG | HOLD | SHORT | STRONG_SHORT
- `MLLatestSignalsResponse` — signals[], sessionDate, nSignals, modelVersion
- `MLForecastRecord` — symbol, score, direction, resolvedReturn, directionCorrect
- `MLSignalHistoryResponse` — records[], stats (winRate, meanReturn, nResolved)
- `MLSignalsContext` — niftyLtp, niftyChangePct, sectorMovers, gainers, losers

**Redis cache keys:** `ml:signals:latest:v2` (30s), `ml:signals:history:{date}` (60s), `ml:signals:log` (15s), `ml:signals:context` (45s)

> **ml-service2.0** runs as a standalone Docker Compose stack (`cd ../ml-service2.0 && make up`). AlphaForge's `ML_MODE=fallback` means all ML features degrade gracefully if ml-service2.0 is unavailable.
