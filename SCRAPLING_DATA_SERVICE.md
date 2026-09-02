# Scrapling NSE/BSE Data Microservice — Complete Implementation Plan

> **Branch:** `feat/scrapling-data-microservice`
> **Status:** Planning
> **Scope:** Full NSE + BSE data pipeline using [Scrapling](https://github.com/D4Vinci/Scrapling) as the primary market data source for AlphaForge, replacing Angel One SmartAPI at Priority 1 in the provider chain.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Design Decisions](#2-design-decisions)
3. [Architecture Overview](#3-architecture-overview)
4. [Data Coverage](#4-data-coverage)
5. [Why This Matches Broker-Level Quality](#5-why-this-matches-broker-level-quality)
6. [Anti-Bot Strategy](#6-anti-bot-strategy)
7. [Provider Chain Changes](#7-provider-chain-changes)
8. [Directory Structure](#8-directory-structure)
9. [Environment Variables](#9-environment-variables)
10. [Task Breakdown](#10-task-breakdown)
    - [Task 1 — Service Scaffold + Docker](#task-1--service-scaffold--docker-integration)
    - [Task 2 — Historical Data (Bhavcopy + Intraday)](#task-2--historical-data-scraper)
    - [Task 3 — Live Quotes via capture_xhr](#task-3--live-quote-scraper)
    - [Task 4 — Option Chain via capture_xhr](#task-4--option-chain-scraper)
    - [Task 5 — Redis Pub/Sub Tick Publisher](#task-5--live-tick-publisher--redis-pubsub)
    - [Task 6 — TypeScript ScraplingProvider](#task-6--typescript-scraplingprovider)
    - [Task 7 — Instrument Master (NSE + BSE)](#task-7--nse--bse-instrument-master)
    - [Task 8 — Anti-Ban Hardening + Health Monitoring](#task-8--anti-ban-hardening--health-monitoring)
    - [Task 9 — BSE Historical + SENSEX Option Chain](#task-9--bse-historical--sensex-option-chain)
    - [Task 10 — ML Training Pipeline Upgrade](#task-10--ml-training-pipeline-upgrade)
    - [Task 11 — Provider Health Dashboard + Data Badge](#task-11--provider-health-dashboard--data-source-badge)
11. [Implementation Order & Dependencies](#11-implementation-order--dependencies)
12. [NSE/BSE Endpoints Reference](#12-nsebse-endpoints-reference)
13. [Graceful Degradation Contract](#13-graceful-degradation-contract)
14. [Testing Policy](#14-testing-policy)
15. [Operational Runbook](#15-operational-runbook)

---

## 1. Problem Statement

AlphaForge's Indian market data layer has two structural weaknesses:

**Weakness 1 — Credential dependency at Priority 1.**
Angel One SmartAPI is the primary data source. Without valid `SMARTAPI_API_KEY` + `SMARTAPI_CLIENT_CODE` + `SMARTAPI_PIN` + `SMARTAPI_TOTP_SECRET`, the entire live data pipeline degrades immediately to Upstox (tier 2). A single TOTP/session expiry silently breaks the most important data path.

**Weakness 2 — The NSE direct scraper is fragile.**
The existing `src/services/india/nse/index.ts` uses hand-rolled cookie warming with a well-known pattern that NSE's Akamai protection shadow-bans aggressively. The `stock-nse-india` library helps but is not immune. This is why NSE direct sits at priority 3 — it's unreliable enough to be a last resort.

**The fix:** A dedicated Python microservice (`data-service`) using [Scrapling](https://github.com/D4Vinci/Scrapling) — an adaptive web scraping framework with full TLS fingerprint spoofing, headless browser automation, and a `capture_xhr` feature that intercepts the exact same JSON API calls NSE and BSE make from their own website to their own backend. No credentials required. No TOTP. No broker API rate limits.

This service becomes **Priority 0** in the provider chain, demoting Angel One to Priority 1 (first fallback), which is a more appropriate role for a credentialed broker API.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Service exposure** | REST API (FastAPI, port 8200) + Redis pub/sub for live ticks | REST for on-demand queries; pub/sub for zero-latency tick delivery to the worker. Same split that Zerodha Kite uses internally. |
| **Option chain scraping** | `capture_xhr` via `DynamicFetcher`/`DynamicSession` | Intercepts NSE's own XHR calls from inside a real Chromium process. Indistinguishable from a genuine user. Adaptive tracking survives NSE redesigns. |
| **Live quotes scraping** | `capture_xhr` on NSE market data page | Same reason — one page load captures 200 F&O stocks in a single XHR payload (the `NIFTY 200` index constituent payload). |
| **Historical OHLCV** | Scrapling `FetcherSession` + NSE/BSE Bhavcopy CSV archives | Bhavcopy files are unauthenticated archive downloads (CloudFront CDN). No anti-bot protection. Exchange-official data. NSE Bhavcopy goes back to 1994 for equities, 2001 for F&O. |
| **Live tick delivery** | Redis `PUBLISH` from Python → `SUBSCRIBE` in the worker | Zero-polling latency. Follows the same pattern as Angel One SmartStream — the worker receives ticks on a channel and calls `LiveFeedService.onTick()`. |
| **Proxy strategy** | Optional rotating residential proxies via env var | Mandatory only for high-frequency production use. Works without proxies in local dev (NSE rate limits are generous for < 60 req/min). |
| **Deployment** | New `data-service` in `docker-compose.yml` | Isolated service — does not pollute the ML service. Can be scaled or replaced independently. |
| **Historical depth** | 5yr daily (Bhavcopy) + 1yr 5m intraday (NSE charting API) | Matches Zerodha Kite's historical API depth. Sufficient for strategy backtesting and ML model training. |
| **Integration point** | New `ScraplingProvider` at priority `0` in `ProviderRegistry` | Zero changes to existing providers. Existing failover chain (Angel One → Upstox → NSE → Yahoo) stays intact and becomes the graceful degradation path. |

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  data-service  (Python 3.11 · FastAPI · port 8200)                  │
│                                                                      │
│  ┌───────────────┐  ┌───────────────┐  ┌──────────────────────────┐ │
│  │  Option Chain  │  │  Live Quotes  │  │   Historical OHLCV       │ │
│  │  Scraper       │  │  Scraper      │  │   Scraper                │ │
│  │  capture_xhr   │  │  capture_xhr  │  │   FetcherSession         │ │
│  │  NSE + BSE     │  │  NSE F&O 200  │  │   Bhavcopy + ChartAPI   │ │
│  └───────┬───────┘  └──────┬────────┘  └──────────┬───────────────┘ │
│          │                 │                       │                  │
│  ┌───────▼─────────────────▼───────────────────────▼──────────────┐ │
│  │             FastAPI REST  +  Redis Pub/Sub Publisher            │ │
│  │  GET /scraping/quotes          PUBLISH af:ticks:{symbol}        │ │
│  │  GET /scraping/option-chain    PUBLISH af:chain:{underlying}    │ │
│  │  GET /scraping/historical      GET /scraping/instruments        │ │
│  │  GET /monitoring/health        GET /publisher/status            │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
           ┌───────────────────┼─────────────────────┐
           │ REST calls        │ Redis PUBLISH        │
           ▼                   ▼                      │
┌─────────────────┐   ┌──────────────────┐           │
│  ScraplingProv.  │   │  Redis (6379)    │           │
│  (Priority 0)    │   │  af:ticks:*      │           │
│  TypeScript      │   │  af:chain:*      │           │
│  ProviderRegistry│   └────────┬─────────┘           │
└────────┬─────────┘            │                     │
         │                      │ SUBSCRIBE            │
         │ withFailover()       ▼                     │
         │              ┌────────────────────┐        │
         │              │  Worker            │        │
         │              │  scraping-tick-    │        │
         │              │  listener.ts       │        │
         │              │  LiveFeedService   │        │
         │              └────────────────────┘        │
         │                                            │
         ▼  Fallback chain (credentials required)     │
  Angel One (Priority 1) → Upstox (2) → NSE (3) → Yahoo (4)
```

---

## 4. Data Coverage

### NSE

| Data Type | Source Endpoint | Scraping Method | Refresh |
|---|---|---|---|
| Option chain — indices | `api/option-chain-indices?symbol={X}` | `capture_xhr` on `nseindia.com/option-chain` | 20s cache |
| Option chain — equities | `api/option-chain-equities?symbol={X}` | `capture_xhr` on `nseindia.com/option-chain` | 20s cache |
| Live quotes (batch 200 stocks) | `api/equity-stockIndices?index=NIFTY%20200` | `capture_xhr` on `nseindia.com/market-data/live-equity-market` | 5s cache |
| Historical daily OHLCV | `nseindia.com/api/historicalOR?...&csvFlag=1` | `FetcherSession` + CSV parse | Bhavcopy: 24h disk cache |
| Historical intraday (5m, 15m) | `charting.nseindia.com/charts/getData?...` | `FetcherSession` | 1h Redis cache |
| Instrument master (F&O lot sizes) | `nsearchives.nseindia.com/content/fo/fo_mktlots.csv` | `FetcherSession` | 24h disk cache |
| All F&O contracts | `nseindia.com/api/allcontracts` | `FetcherSession` | 24h disk cache |
| Index values (NIFTY, BANKNIFTY, etc.) | `api/allIndices` | `capture_xhr` | 5s cache |

### BSE

| Data Type | Source Endpoint | Scraping Method | Refresh |
|---|---|---|---|
| SENSEX option chain | BSE Derivatives page XHR | `capture_xhr` on `bseindia.com/markets/Derivatives/DerivativeHome.aspx` | 20s cache |
| Live equity quotes | `api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w` | `FetcherSession` | 5s cache |
| Historical daily OHLCV | `bseindia.com/download/BhavCopy/Equity/EQ{ddmmyyyy}_CSV.ZIP` | `FetcherSession` + ZIP/CSV parse | 24h disk cache |
| Historical intraday | `api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w` | `FetcherSession` | 1h Redis cache |
| Scrip master (BSE codes) | `bseindia.com/download/BseIndiaAPI/Equity/EQUITY_{ddmmyyyy}.zip` | `FetcherSession` | 24h disk cache |

---

## 5. Why This Matches Broker-Level Quality

Groww, Zerodha, and Angel One all cross-check their data against the same NSE/BSE endpoints this microservice scrapes. Here is why:

**NSE and BSE are the authoritative source.** Every broker's data ultimately originates from NSE's live feed (TCP binary) and BSE's live feed. The REST/JSON endpoints exposed on nseindia.com and bseindia.com are the same payloads the exchange publishes to its own website — not a derivative or delayed copy.

**`capture_xhr` gives you the raw API payload.** When Scrapling's `DynamicFetcher` loads the NSE option chain page, it captures the XHR response from `https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY` — the same call your browser makes when you visit that page. The broker's research desks use this same endpoint to cross-check their SmartAPI data. You are reading from the same pipe.

**Bhavcopy is exchange-official.** NSE Bhavcopy CSV files are the official End-of-Day settlement data published by NSE at 18:00 IST. They are used by SEBI, clearing corporations, and all brokers as the authoritative daily OHLCV record. yfinance's data is derived from Bhavcopy — so you are going one step closer to the source.

**What brokers have that this microservice does not (and never will):**
- Sub-100ms tick-by-tick (TCP binary feed from NSE co-location) — this requires an NSE co-location membership (~₹15L/year setup + running costs)
- Level 2 order book depth beyond 5 levels (requires exchange DMA membership)
- Authenticated pre-market and post-market data (block deals, bulk deals feed)

For AlphaForge's use case (intraday signals, option chain analytics, ML model training), the data this microservice delivers is functionally equivalent to what Angel One's SmartAPI provides — and in some cases better (Bhavcopy is more reliable than SmartAPI's historical endpoint which has known gaps).

---

## 6. Anti-Bot Strategy

NSE and BSE use Akamai Bot Manager for protection. The layered approach below defeats it reliably:

### Layer 1 — TLS Fingerprint Spoofing (all requests)
`FetcherSession(impersonate='chrome')` and `StealthyFetcher` both use Scrapling's browser fingerprint database to present a valid Chrome TLS fingerprint (JA3/JA4 hash, cipher suites, extensions) — the same checks Akamai runs to distinguish bots from browsers.

### Layer 2 — Full Browser Session for Option Chain and Live Quotes (`capture_xhr`)
`DynamicSession` (headless Chromium) opens a real browser, executes JavaScript, generates real mouse/keyboard entropy, and collects genuine browser cookies (`bm_sz`, `_abck`, `nsit`, `nseappid`). NSE's Akamai challenge is solved at the browser level — no manual cookie handling needed. This is the same approach Scrapling uses to bypass Cloudflare Turnstile.

### Layer 3 — Session Warm-up Schedule
A background task pre-warms a fresh `DynamicSession` every 30 minutes during IST market hours (09:00–16:00). This means option chain requests never hit a cold session — they reuse an already-authenticated, already-warmed browser context.

### Layer 4 — Adaptive Element Tracking
On the first successful scrape, `.css('[data-target]', auto_save=True)` saves element fingerprints. Subsequent scrapes use `adaptive=True` — if NSE redesigns the page and changes CSS class names, Scrapling's similarity algorithm relocates the elements automatically. Zero maintenance on page changes.

### Layer 5 — Rate Limiting (per-domain token bucket)
NSE: max 3 requests/second (configurable via `NSE_RATE_LIMIT` env var).
BSE: max 2 requests/second.
Bhavcopy (nsearchives.nseindia.com): unlimited (CloudFront CDN, no rate limit).

### Layer 6 — Ban Detection + Proxy Rotation
Inspects responses for Akamai challenge pages, empty `records.data` (NSE's shadow-ban signature), and HTTP 403/429. On detection: rotates to the next proxy in the pool, resets session, and backs off for `BAN_BACKOFF_SECONDS=60`.

### Layer 7 — Proxy Pool (optional)
`SCRAPLING_PROXY_LIST` env var accepts a newline-separated list of residential proxy URLs. Scrapling's built-in `ProxyRotator` handles cyclic rotation. Falls back to no-proxy when the list is empty (sufficient for local dev and moderate production use).

---

## 7. Provider Chain Changes

### Before (current state)

| Priority | Provider | Credentials Required | Status |
|---|---|---|---|
| 1 | Angel One SmartAPI | Yes — 4 env vars + TOTP | Fragile (TOTP expiry) |
| 2 | Upstox Analytics v2 | Yes — bearer token | Stable |
| 3 | NSE direct scraper | No | Unreliable (shadow-ban) |
| 4 | Yahoo Finance | No | Historical only |

### After (with this microservice)

| Priority | Provider | Credentials Required | Status |
|---|---|---|---|
| **0** | **Scrapling (data-service)** | **No** | **Primary — no credentials** |
| 1 | Angel One SmartAPI | Yes — 4 env vars + TOTP | First fallback |
| 2 | Upstox Analytics v2 | Yes — bearer token | Second fallback |
| 3 | NSE direct scraper (legacy) | No | Third fallback |
| 4 | Yahoo Finance | No | Historical only |

### TypeScript changes required

**`src/lib/market-data/types.ts`** — extend `ProviderId`:
```typescript
// Before
export type ProviderId = "angel_one" | "upstox" | "nse" | "yahoo";

// After
export type ProviderId = "scrapling" | "angel_one" | "upstox" | "nse" | "yahoo";

export const PROVIDER_PRIORITY: readonly ProviderId[] = [
  "scrapling",   // NEW — priority 0
  "angel_one",
  "upstox",
  "nse",
  "yahoo",
];
```

**`src/lib/market-data/registry.ts`** — register at priority `0`:
```typescript
registry.register({
  provider: new ScraplingProvider(),
  capabilities: {
    historicalCandles: true,
    liveQuotes: true,
    webSocket: false,         // ticks delivered via Redis pub/sub instead
    optionChain: true,
    instrumentMaster: true,   // NSE fo_mktlots.csv + BSE scrip master
    intradayCandles: true,
    fno: true,
  },
  priority: 0,
  enabled: !!process.env.DATA_SERVICE_URL,   // opt-in via env var
});
```

**`src/lib/market-data/providers/scrapling.ts`** — new file (Task 6).

The existing `bootstrapRegistry()` import list gains one entry. Everything else in the failover chain is untouched — `withFailover` picks up the new provider automatically via `withCapability()`.

---

## 8. Directory Structure

```
alpha-forge/
├── data-service/                          ← NEW microservice
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── pyproject.toml
│   ├── tests/
│   │   ├── conftest.py
│   │   ├── test_server.py
│   │   ├── scrapers/
│   │   │   ├── test_historical.py
│   │   │   ├── test_live_quotes.py
│   │   │   ├── test_option_chain.py
│   │   │   ├── test_bse_historical.py
│   │   │   └── test_bse_option_chain.py
│   │   ├── publisher/
│   │   │   └── test_tick_publisher.py
│   │   ├── anti_ban/
│   │   │   ├── test_ban_detector.py
│   │   │   └── test_rate_limiter.py
│   │   └── monitoring/
│   │       └── test_health_route.py
│   └── src/
│       ├── __init__.py
│       ├── server.py                      ← FastAPI app + lifespan
│       ├── config.py                      ← Settings dataclass
│       ├── schemas.py                     ← Pydantic models (MDQuote, OHLCVCandle, OptionChain, etc.)
│       ├── scrapers/
│       │   ├── __init__.py
│       │   ├── historical.py              ← BhavcopyScraper (NSE + BSE)
│       │   ├── live_quotes.py             ← LiveQuoteScraper (capture_xhr)
│       │   ├── option_chain.py            ← OptionChainScraper (capture_xhr NSE + BSE)
│       │   └── instrument_master.py       ← NseInstrumentMaster + BseInstrumentMaster
│       ├── publisher/
│       │   ├── __init__.py
│       │   ├── tick_publisher.py          ← Redis PUBLISH loop
│       │   └── router.py                  ← GET /publisher/status, POST /publisher/symbols
│       ├── anti_ban/
│       │   ├── __init__.py
│       │   ├── proxy_manager.py           ← ProxyRotator wrapper
│       │   ├── rate_limiter.py            ← Per-domain token bucket
│       │   ├── ban_detector.py            ← Shadow-ban + challenge detection
│       │   └── session_warmer.py          ← Scheduled DynamicSession pre-warm
│       └── monitoring/
│           ├── __init__.py
│           └── router.py                  ← GET /monitoring/health, /scraping-stats
│
├── src/
│   └── lib/
│       └── market-data/
│           ├── types.ts                   ← MODIFIED: add "scrapling" to ProviderId
│           ├── registry.ts                ← MODIFIED: bootstrapRegistry() gains ScraplingProvider at priority 0
│           └── providers/
│               └── scrapling.ts           ← NEW: ScraplingProvider class
│
├── worker/
│   └── src/
│       ├── config.ts                      ← MODIFIED: add SCRAPING_DATA_SERVICE_URL, SCRAPING_TICK_LISTEN
│       ├── redis.ts                       ← MODIFIED: add subscribe() method to IoredisAdapter
│       └── jobs/
│           └── scraping-tick-listener.ts  ← NEW: subscribes af:ticks:* → LiveFeedService.onTick()
│
├── tests/
│   └── lib/
│       └── market-data/
│           └── providers/
│               └── scrapling.test.ts      ← NEW: ScraplingProvider unit tests
│
├── docker-compose.yml                     ← MODIFIED: add data-service
├── .env.example                           ← MODIFIED: add DATA_SERVICE_URL, SCRAPLING_* vars
└── SCRAPLING_DATA_SERVICE.md              ← THIS FILE
```

---

## 9. Environment Variables

### data-service (Python)

```bash
# Core
DATA_SERVICE_PORT=8200
REDIS_URL=redis://redis:6379

# Scrapling behaviour
SCRAPLING_HEADLESS=true               # Set false for debugging (shows browser window)
SCRAPLING_PROXY_URL=                  # Single proxy: http://user:pass@host:port
SCRAPLING_PROXY_LIST=                 # Newline-separated list of proxy URLs (overrides single)

# Rate limits (requests per second per domain)
NSE_RATE_LIMIT=3
BSE_RATE_LIMIT=2
BAN_BACKOFF_SECONDS=60

# Live tick publisher
DATA_SERVICE_SYMBOLS=NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,RELIANCE,HDFCBANK,ICICIBANK,TCS,INFY,HINDUNILVR,ITC,SBIN,BAJFINANCE,WIPRO,AXISBANK,MARUTI,ASIANPAINT,NTPC,POWERGRID,ULTRACEMCO

# Storage
DATA_DIR=/app/data                    # Bhavcopy + instrument master disk cache

# Callbacks
NEXTJS_API_BASE_URL=http://host.docker.internal:3000/api/in
```

### AlphaForge app + worker (TypeScript)

```bash
# data-service integration
DATA_SERVICE_URL=http://localhost:8200

# Worker tick subscription
SCRAPING_TICK_LISTEN=true             # Set false to disable Redis pub/sub tick listening

# Proxy (pass-through to data-service, for ops dashboards)
SCRAPLING_PROXY_URL=                  # Optional: shown in provider health dashboard
```

### `.env.example` additions (append to existing file)

```bash
# ── Scrapling Data Service ───────────────────────────────────────────────────
# The standalone NSE/BSE data microservice. When DATA_SERVICE_URL is set,
# ScraplingProvider becomes Priority 0 in the provider chain — no credentials needed.
DATA_SERVICE_URL=http://localhost:8200

# Optional: residential proxy for sustained high-frequency scraping
# Format: http://username:password@proxy-host:port
# Leave blank for local dev — NSE rate limits are generous without a proxy.
SCRAPLING_PROXY_URL=

# Comma-separated list of symbols the tick publisher broadcasts.
# Defaults to the 20 most-liquid F&O names + 4 indices if not set.
DATA_SERVICE_SYMBOLS=
```

---

## 10. Task Breakdown

---

### Task 1 — Service Scaffold + Docker Integration

**Objective:** Bootstrap the `data-service/` Python package and wire it into `docker-compose.yml`. No scraping yet — proves the service starts, passes health checks, and is reachable from the Next.js app at `http://localhost:8200`.

**Files to create:**

`data-service/Dockerfile`
```dockerfile
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Scrapling browser dependencies (Chromium + system libs)
RUN pip install "scrapling[fetchers]" && scrapling install

COPY src/ ./src/

EXPOSE 8200
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8200"]
```

`data-service/requirements.txt`
```
# Core web
fastapi==0.115.6
uvicorn[standard]==0.34.0
pydantic==2.10.3
httpx==0.28.1

# Scrapling — adaptive scraping + browser automation
scrapling[fetchers]==0.4.*

# Redis pub/sub
aioredis==2.0.1

# Utilities
structlog==24.4.0
python-dotenv==1.0.1
pytest==8.3.4
pytest-asyncio==0.24.0
pytest-mock==3.14.0
```

`data-service/src/config.py`
```python
from __future__ import annotations
import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    port: int = int(os.getenv("DATA_SERVICE_PORT", "8200"))
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    scrapling_headless: bool = os.getenv("SCRAPLING_HEADLESS", "true").lower() == "true"
    scrapling_proxy_url: str | None = os.getenv("SCRAPLING_PROXY_URL") or None
    scrapling_proxy_list: list[str] = field(
        default_factory=lambda: [
            p.strip()
            for p in os.getenv("SCRAPLING_PROXY_LIST", "").splitlines()
            if p.strip()
        ]
    )
    nse_rate_limit: int = int(os.getenv("NSE_RATE_LIMIT", "3"))
    bse_rate_limit: int = int(os.getenv("BSE_RATE_LIMIT", "2"))
    ban_backoff_seconds: int = int(os.getenv("BAN_BACKOFF_SECONDS", "60"))
    data_dir: str = os.getenv("DATA_DIR", "/app/data")
    nextjs_api_base_url: str = os.getenv(
        "NEXTJS_API_BASE_URL", "http://localhost:3000/api/in"
    )
    symbols: list[str] = field(
        default_factory=lambda: [
            s.strip()
            for s in os.getenv(
                "DATA_SERVICE_SYMBOLS",
                "NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,RELIANCE,HDFCBANK,"
                "ICICIBANK,TCS,INFY,HINDUNILVR,ITC,SBIN,BAJFINANCE,"
                "WIPRO,AXISBANK,MARUTI,ASIANPAINT,NTPC,POWERGRID,ULTRACEMCO",
            ).split(",")
            if s.strip()
        ]
    )


settings = Settings()
```

`data-service/src/server.py`
```python
"""
AlphaForge Data Service — FastAPI app.

Endpoints:
  GET  /health                → Service health check
  GET  /scraping/status       → Capability flags (what is available)
  GET  /scraping/quotes       → Live NSE/BSE quotes
  GET  /scraping/option-chain → NSE/BSE option chain
  GET  /scraping/historical   → Historical OHLCV (Bhavcopy + intraday)
  GET  /scraping/instruments  → Instrument master (lot sizes, tokens)
  GET  /publisher/status      → Tick publisher status
  POST /publisher/symbols     → Update live broadcast symbol list
  GET  /monitoring/health     → Scraping health metrics
"""
import time
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings

logger = structlog.get_logger()

# ── Global component instances ───────────────────────────────────────────────
# (populated by _load_components() in lifespan)
_tick_publisher = None


def _load_components() -> None:
    global _tick_publisher
    # Components are lazy-imported here so import errors surface at runtime
    # with useful messages, not at module load time (which breaks healthchecks).
    logger.info("data_service_components_loading")
    # Tick publisher wired in Task 5
    logger.info("data_service_components_loaded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_components()
    logger.info("data_service_started", port=settings.port)
    yield
    logger.info("data_service_shutdown")


app = FastAPI(
    title="AlphaForge Data Service",
    description="NSE/BSE market data via Scrapling — no broker credentials required",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "data-service",
        "version": "1.0.0",
        "timestamp": int(time.time() * 1000),
    }


@app.get("/scraping/status")
async def scraping_status():
    return {
        "available": True,
        "capabilities": {
            "live_quotes": True,
            "option_chain_nse": True,
            "option_chain_bse": True,
            "historical_daily": True,
            "historical_intraday": True,
            "instrument_master": True,
            "tick_publisher": False,  # enabled in Task 5
        },
        "config": {
            "symbols_count": len(settings.symbols),
            "proxy_enabled": settings.scrapling_proxy_url is not None
                             or len(settings.scrapling_proxy_list) > 0,
            "headless": settings.scrapling_headless,
        },
    }
```

**`docker-compose.yml` additions** (append alongside ml-service):
```yaml
  # ─── Scrapling Data Service (NSE/BSE scraper, no broker credentials) ─────────
  data-service:
    build:
      context: ./data-service
      dockerfile: Dockerfile
    container_name: alpha-forge-data
    restart: unless-stopped
    environment:
      DATA_SERVICE_PORT: "8200"
      REDIS_URL: redis://redis:6379
      DATA_DIR: /app/data
      SCRAPLING_HEADLESS: "true"
      # Proxy — leave blank for local dev
      SCRAPLING_PROXY_URL: ""
    ports:
      - "8200:8200"
    volumes:
      - data_service_cache:/app/data    # Bhavcopy + instrument master disk cache
    healthcheck:
      test: ["CMD", "python", "-c", "import httpx; r = httpx.get('http://localhost:8200/health'); r.raise_for_status()"]
      interval: 30s
      timeout: 10s
      start_period: 60s    # browser install takes ~30s on first boot
      retries: 3
    deploy:
      resources:
        limits:
          memory: 2G        # headless Chromium needs ~600MB per browser instance
        reservations:
          memory: 512M
    networks:
      - alphaforge
    depends_on:
      redis:
        condition: service_healthy

volumes:
  data_service_cache:    # append to existing volumes block
```

**Tests:**
- `data-service/tests/test_server.py`: `GET /health` → 200 + `{"status":"healthy","service":"data-service"}`. `GET /scraping/status` → 200 + `available: true`.

**Demo:** `docker compose up data-service`. `curl http://localhost:8200/health` → `{"status":"healthy"}`. `docker compose ps` shows `alpha-forge-data` as `healthy`.

---

### Task 2 — Historical Data Scraper

**Objective:** Implement `BhavcopyScraper` using `FetcherSession` to download NSE Bhavcopy daily archives (5yr daily OHLCV) and the NSE charting API for intraday (5m, 15m) up to 1 year. All data is exchange-official.

**Files to create:** `data-service/src/scrapers/historical.py`

**Key implementation notes:**

- **NSE daily Bhavcopy** — The exact URL called by the NSE website's "Historical Data" download button:
  ```
  https://www.nseindia.com/api/historicalOR
    ?series=EQ&symbol={SYMBOL}
    &dateRange=&from={DD-MM-YYYY}&to={DD-MM-YYYY}
    &toDate={DD-MM-YYYY}&csvFlag=1
  ```
  Returns a CSV with columns: `Date, Series, OPEN, HIGH, LOW, CLOSE, LAST, PREVCLOSE, TOTTRDQTY, TOTTRDVAL, TIMESTAMP, TOTALTRADES, ISIN`. Parse `OPEN/HIGH/LOW/CLOSE` as floats, `Date` as `DD-MMM-YYYY` → UTC epoch seconds.

- **NSE F&O Bhavcopy** (for futures OI) — daily ZIP archive:
  ```
  https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{YYYY}/{MMM}/fo{DDMMMYYYY}bhav.csv.zip
  ```

- **NSE intraday charting API** — the same endpoint powering NSE's own chart tab:
  ```
  https://charting.nseindia.com//charts/getData
    ?appid=chartiq&callback=&symbol={SYMBOL}
    &period={5|15|30|60}&type=EQ
    &startDate={DD-MM-YYYY}&endDate={DD-MM-YYYY}
  ```
  Returns JSON: `{grapthData: [[timestamp_ms, open, high, low, close, volume], ...]}`. Timestamp is in IST milliseconds — convert to UTC epoch seconds by subtracting `19800` (5.5hr offset in seconds).

- **Disk cache** — `/app/data/bhavcopy/{NSE|BSE}/{symbol}/{date}.csv.gz`. `stat()` the file before downloading; skip if age < 24h (daily Bhavcopy) or age < 1h (intraday).

- **Redis cache** — `scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}` → JSON. TTL: `86400` for daily, `3600` for intraday.

**REST endpoint:**
```
GET /scraping/historical
  ?symbol=NIFTY
  &exchange=NSE           (NSE | BSE)
  &interval=1d            (1d | 5m | 15m | 30m | 1h)
  &from=2020-01-01        (ISO-8601 date)
  &to=2025-01-01
```

Response:
```json
{
  "symbol": "NIFTY",
  "exchange": "NSE",
  "interval": "1d",
  "count": 1250,
  "source": "bhavcopy",
  "candles": [
    { "time": 1577836800, "open": 12282.2, "high": 12311.6, "low": 12218.7, "close": 12256.8, "volume": 123456789 }
  ]
}
```

**Tests (`tests/scrapers/test_historical.py`):**
- Mock `FetcherSession.get()` with a fixture CSV. Assert correct OHLCV parsing: `open/high/low/close` are floats in INR, `time` is UTC epoch seconds.
- Assert disk cache is used on second call (no HTTP request made).
- Assert `IST → UTC` timestamp conversion for intraday: IST `09:15:00` → UTC `03:45:00` (epoch `1577850900`).
- Assert empty candles returned (not an error) when date range is outside market hours.

**Demo:** `GET http://localhost:8200/scraping/historical?symbol=RELIANCE&exchange=NSE&interval=5m&from=2025-01-01&to=2025-09-01` returns ~15,000 5-minute candles. Second call < 50ms (Redis hit). `GET ?interval=1d&from=2020-01-01&to=2025-01-01` returns 5 years of daily OHLCV, source `bhavcopy`.

---

### Task 3 — Live Quote Scraper

**Objective:** Live quote scraping using `capture_xhr`. One page load captures all 200 F&O stocks in a single NSE XHR payload — the same way the NSE market watch page populates its table.

**Files to create:** `data-service/src/scrapers/live_quotes.py`

**Key implementation notes:**

- **Batch quotes (200 stocks in one call):**
  Load `https://www.nseindia.com/market-data/live-equity-market` with `capture_xhr="equity-stockIndices"`.
  This page fires an XHR to `api/equity-stockIndices?index=NIFTY%20200` which returns all 200 NIFTY 200 constituents — OI, volume, LTP, OHLC, prev close, circuit limits — in one payload.

- **Single/small batch quotes:**
  Load `https://www.nseindia.com/get-quotes/equity?symbol={symbol}` with `capture_xhr="api/quote/equity"`.

- **Session reuse:**
  Use `DynamicSession(headless=True)` as an async context manager. Keep the session alive across the 5s polling loop — do not create a new browser per request.

- **Quote normalisation** — map NSE response fields to `MDQuote`:
  ```python
  {
    "symbol": data["info"]["symbol"],
    "ltp": data["priceInfo"]["lastPrice"],
    "change": data["priceInfo"]["change"],
    "changePct": data["priceInfo"]["pChange"],
    "open": data["priceInfo"]["open"],
    "high": data["priceInfo"]["intraDayHighLow"]["max"],
    "low": data["priceInfo"]["intraDayHighLow"]["min"],
    "prevClose": data["priceInfo"]["previousClose"],
    "volume": data["securityWiseDP"]["quantityTraded"],
    "oi": data["securityWiseDP"]["totalBuyQuantity"],  # proxy for OI on equity page
    "upperCircuit": data["priceInfo"]["upperCP"],
    "lowerCircuit": data["priceInfo"]["lowerCP"],
    "provider": "scrapling",
    "fetchedAt": datetime.utcnow().isoformat()
  }
  ```

- **Redis cache** — `scraping:quote:{exchange}:{symbol}` with TTL `5` seconds.

- **Proxy support** — pass `proxy=settings.scrapling_proxy_url` to `DynamicSession` if set.

**REST endpoint:**
```
GET /scraping/quotes
  ?symbols=NIFTY,BANKNIFTY,RELIANCE
  &exchange=NSE
```

Response:
```json
{
  "quotes": [
    {
      "symbol": "NIFTY",
      "exchange": "NSE",
      "ltp": 24850.60,
      "change": 142.35,
      "changePct": 0.58,
      "open": 24712.00,
      "high": 24891.45,
      "low": 24650.10,
      "prevClose": 24708.25,
      "volume": 23456789,
      "oi": null,
      "upperCircuit": null,
      "lowerCircuit": null,
      "provider": "scrapling",
      "fetchedAt": "2026-09-03T05:30:00.000Z"
    }
  ],
  "count": 3,
  "source": "capture_xhr"
}
```

**Tests (`tests/scrapers/test_live_quotes.py`):**
- Mock `DynamicSession.fetch()` with a fixture of the captured XHR JSON. Assert correct `MDQuote` field mapping.
- Assert Redis cache is written with TTL 5s.
- Assert `null` ltp returns null in the response (not an error).

**Demo:** `GET http://localhost:8200/scraping/quotes?symbols=NIFTY,BANKNIFTY&exchange=NSE` returns live quotes. First call ~2–3s (browser session). Subsequent calls < 100ms (Redis cache). The `provider` field reads `"scrapling"`.

---

### Task 4 — Option Chain Scraper

**Objective:** The most critical endpoint. Use `capture_xhr` to intercept NSE's option chain JSON as delivered from NSE's own backend to NSE's own website. Add BSE SENSEX option chain for expiry-day Gamma Blast/Hero Zero plays.

**Files to create:** `data-service/src/scrapers/option_chain.py`

**Key implementation notes:**

- **NSE option chain (primary path — `capture_xhr`):**
  ```python
  from scrapling.fetchers import DynamicSession

  async with DynamicSession(headless=True, proxy=settings.scrapling_proxy_url) as session:
      page = await session.fetch(
          "https://www.nseindia.com/option-chain",
          capture_xhr="api/option-chain",   # matches both -indices and -equities paths
          network_idle=True,
      )
      # page.captured_xhr is a list of Response objects for every matching XHR
      chain_xhr = next(
          (x for x in page.captured_xhr if "option-chain" in x.url),
          None,
      )
      if chain_xhr:
          payload = chain_xhr.json()     # {'records': {'data': [...], 'expiryDates': [...], 'underlyingValue': ...}}
  ```

- **Adaptive tracking** — on the first successful scrape, save the element fingerprint:
  ```python
  page.css('[data-expiry]', auto_save=True)    # survives NSE redesigns
  ```

- **Fallback to FetcherSession** if browser fails to start (e.g. missing Chromium inside slim Docker base):
  ```python
  from scrapling.fetchers import FetcherSession

  with FetcherSession(impersonate='chrome', stealthy_headers=True) as session:
      res = session.get(
          f"https://www.nseindia.com/api/option-chain-indices?symbol={underlying}",
          headers={"Referer": "https://www.nseindia.com/option-chain"},
      )
      payload = res.json()
  ```

- **Chain normalisation** — same analytics computation as `src/services/india/nse/index.ts` (PCR, max pain, ATM IV). The Python implementation lives in `src/scrapers/option_chain.py` and the TypeScript `translateOptionChain()` in the `NseProvider` is the reference. Both must produce identical output shapes.

- **BSE SENSEX option chain:**
  ```python
  page = await session.fetch(
      "https://www.bseindia.com/markets/Derivatives/DerivativeHome.aspx?flag=03",
      capture_xhr="GetOptionChain",
      network_idle=True,
  )
  ```

- **Redis cache** — `scraping:chain:{underlying}:{expiry}:{exchange}` TTL `20` seconds.

- **Pre-warm endpoint:**
  ```
  POST /scraping/option-chain/warm
  ```
  Loads the NSE option chain page and discards the response — warms the browser session and caches the first chain. Call at 09:00 IST before market open.

**REST endpoint:**
```
GET /scraping/option-chain
  ?underlying=NIFTY
  &expiry=2025-07-24      (optional — defaults to nearest)
  &exchange=NSE           (NSE | BSE)
```

Response shape matches the existing `OptionChain` canonical type exactly — this is critical for the `ScraplingProvider.getOptionChain()` TypeScript method to map it without transformation:
```json
{
  "underlying": "NIFTY",
  "spot": 24850.60,
  "expiry": "24-JUL-2025",
  "expiries": ["24-JUL-2025", "31-JUL-2025", "07-AUG-2025"],
  "rows": [
    {
      "strike": 24800,
      "ce": { "ltp": 120.5, "oi": 1234567, "oiChange": 45678, "volume": 89012, "greeks": { "iv": 12.5, "delta": null, "gamma": null, "theta": null, "vega": null, "rho": null } },
      "pe": { "ltp": 68.3, "oi": 987654, "oiChange": -12345, "volume": 56789, "greeks": { "iv": 11.8, "delta": null, "gamma": null, "theta": null, "vega": null, "rho": null } }
    }
  ],
  "analytics": {
    "pcrOi": 1.12,
    "pcrVolume": 0.98,
    "maxCeOiStrike": 25000,
    "maxPeOiStrike": 24500,
    "totalCeOi": 23456789,
    "totalPeOi": 26234567,
    "totalCeOiChange": 1234567,
    "totalPeOiChange": -456789,
    "atmIv": 12.2,
    "maxPain": 24700
  },
  "provider": "scrapling",
  "fetchedAt": "2026-09-03T05:30:00.000Z"
}
```

**Tests (`tests/scrapers/test_option_chain.py`):**
- Mock `DynamicSession.fetch()` with fixture of captured XHR JSON (real NSE payload, PII-scrubbed). Assert full `OptionChain` shape.
- Assert `pcrOi` = `totalPeOi / totalCeOi` computed correctly.
- Assert `maxPain` is the strike that minimises total options pain.
- Assert `atmIv` is the average of the 5 nearest strikes' CE + PE IVs.
- Assert fallback to `FetcherSession` is invoked when `DynamicSession` raises `BrowserError`.
- Assert `exchange=BSE` routes to `BseOptionChainScraper`.

**Demo:** `GET http://localhost:8200/scraping/option-chain?underlying=NIFTY&exchange=NSE` returns the full NIFTY option chain with all 120+ strikes. The shape is identical to the existing `/api/in/option-chain` response. The existing `india-oc-capture` worker job works without modification.

---

### Task 5 — Live Tick Publisher (Redis Pub/Sub)

**Objective:** Background asyncio loop that polls live quotes every 5 seconds and publishes normalised tick events to Redis channels. The Alphaforge worker subscribes and delivers ticks to the existing `LiveFeedService` — real-time UI updates without any WebSocket dependency or broker credentials.

**Files to create:**
- `data-service/src/publisher/tick_publisher.py`
- `data-service/src/publisher/router.py`
- `worker/src/jobs/scraping-tick-listener.ts` (TypeScript)

**Python tick publisher core:**
```python
# data-service/src/publisher/tick_publisher.py
import asyncio
import json
import time
import aioredis
import structlog
from ..config import settings
from ..scrapers.live_quotes import LiveQuoteScraper

logger = structlog.get_logger()

TICK_INTERVAL_S = 5
CHAIN_INTERVAL_S = 20


class TickPublisher:
    def __init__(self):
        self._redis: aioredis.Redis | None = None
        self._running = False
        self._symbols = list(settings.symbols)
        self._publish_count = 0
        self._last_publish_ms: int | None = None
        self._scraper = LiveQuoteScraper()

    async def start(self):
        self._redis = await aioredis.from_url(
            settings.redis_url, encoding="utf-8", decode_responses=True
        )
        self._running = True
        logger.info("tick_publisher_started", symbols=len(self._symbols))
        await asyncio.gather(
            self._tick_loop(),
        )

    async def stop(self):
        self._running = False
        if self._redis:
            await self._redis.close()

    async def _tick_loop(self):
        while self._running:
            start = time.monotonic()
            try:
                quotes = await self._scraper.fetch_quotes_xhr(self._symbols)
                for quote in quotes:
                    if quote.ltp is None:
                        continue
                    tick = {
                        "token": quote.symbol,
                        "symbol": quote.symbol,
                        "exchange": quote.exchange,
                        "ltp": quote.ltp,
                        "change": quote.change,
                        "changePct": quote.change_pct,
                        "volume": quote.volume,
                        "oi": quote.oi,
                        "exchangeTimestampMs": int(time.time() * 1000),
                        "receivedAtMs": int(time.time() * 1000),
                        "provider": "scrapling",
                    }
                    channel = f"af:ticks:{quote.symbol}"
                    await self._redis.publish(channel, json.dumps(tick))
                    self._publish_count += 1
                self._last_publish_ms = int(time.time() * 1000)
            except Exception as e:
                logger.warning("tick_publish_failed", error=str(e))

            elapsed = time.monotonic() - start
            await asyncio.sleep(max(0, TICK_INTERVAL_S - elapsed))

    def add_symbol(self, symbol: str):
        if symbol not in self._symbols:
            self._symbols.append(symbol)

    def remove_symbol(self, symbol: str):
        self._symbols = [s for s in self._symbols if s != symbol]

    @property
    def status(self) -> dict:
        return {
            "running": self._running,
            "symbols": self._symbols,
            "publish_count": self._publish_count,
            "last_publish_ms": self._last_publish_ms,
        }
```

**TypeScript Redis subscriber (`worker/src/jobs/scraping-tick-listener.ts`):**
```typescript
/**
 * Subscribes to af:ticks:* Redis pub/sub channels published by the
 * data-service Scrapling tick publisher. Normalises each message to a
 * LiveTick and forwards it to LiveFeedService.onTick() — the same pipeline
 * used by Angel One SmartStream.
 *
 * Activation: set SCRAPING_TICK_LISTEN=true (or set DATA_SERVICE_URL — the
 * worker enables this job automatically when the data-service is configured).
 */
import { getRedis } from "../redis";
import type { LiveTick } from "@/lib/market-data/types";

let unsubscribe: (() => void) | null = null;

export async function startScrapingTickListener(
  onTick: (tick: LiveTick) => void,
): Promise<void> {
  const redis = getRedis();
  // ioredis requires a dedicated connection for subscribe mode.
  // Pattern subscribe matches af:ticks:NIFTY, af:ticks:RELIANCE, etc.
  await redis.psubscribe("af:ticks:*", (message: string) => {
    try {
      const tick = JSON.parse(message) as LiveTick;
      onTick(tick);
    } catch (err) {
      console.warn("[scraping-tick-listener] parse error:", err);
    }
  });

  unsubscribe = () => redis.punsubscribe("af:ticks:*");
}

export function stopScrapingTickListener(): void {
  unsubscribe?.();
  unsubscribe = null;
}
```

**Worker `redis.ts` addition** — extend `IoredisAdapter` to expose `psubscribe`/`punsubscribe` using the raw ioredis client in subscribe mode (requires a second dedicated connection, since ioredis cannot multiplex commands and subscribe mode):
```typescript
// worker/src/redis.ts — add alongside existing IoredisAdapter
export function createSubscriberClient(): Redis {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL not set");
  return new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,  // required for subscriber mode
    enableReadyCheck: false,
    lazyConnect: false,
  });
}
```

**`workerConfig` addition:**
```typescript
scrapingTicks: {
  enabled: Boolean(
    process.env.SCRAPING_TICK_LISTEN !== "false" &&
    (process.env.DATA_SERVICE_URL || process.env.SCRAPING_TICK_LISTEN === "true")
  ),
},
```

**Tests:**
- `data-service/tests/publisher/test_tick_publisher.py`: mock `aioredis.from_url`, assert `PUBLISH` called with channel `af:ticks:NIFTY` and valid JSON tick payload.
- `tests/worker/scraping-tick-listener.test.ts`: mock ioredis `psubscribe`, assert `onTick` called with normalised `LiveTick` on message receipt.

**Demo:** Start docker compose. Run `redis-cli monitor`. Open `/in/dashboard`. Redis monitor shows `PUBLISH af:ticks:NIFTY {...}` every 5 seconds. The NIFTY ticker bar on the AlphaForge dashboard updates in real time, driven entirely by Scrapling ticks. No Angel One credentials needed.

---

### Task 6 — TypeScript ScraplingProvider

**Objective:** The TypeScript integration layer. `ScraplingProvider` calls the data-service REST API and is registered at Priority 0 in the `ProviderRegistry`. This is the only task that touches existing TypeScript code in the provider chain.

**Files to create/modify:**
- `src/lib/market-data/providers/scrapling.ts` (new)
- `src/lib/market-data/types.ts` (modify — extend `ProviderId`)
- `src/lib/market-data/registry.ts` (modify — add to `bootstrapRegistry`)

**`src/lib/market-data/providers/scrapling.ts`:**
```typescript
/**
 * ScraplingProvider — wraps the data-service REST API.
 *
 * Priority 0 in the provider chain when DATA_SERVICE_URL is set.
 * No credentials required. Falls back to Angel One (priority 1) on any failure.
 *
 * Live ticks are delivered separately via Redis pub/sub (see worker/src/jobs/
 * scraping-tick-listener.ts). The subscribe() method here implements a polling
 * fallback for code paths that don't use the Redis subscriber.
 */
import type { MarketDataProvider, ProviderCallOptions } from "../provider";
import type {
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  LiveTick,
  MDQuote,
  OHLCVCandle,
  OptionChain,
  ProviderId,
  ProviderHealth,
  SubscribeRequest,
} from "../types";
import { getProviderHealth } from "../health";
import { withRetry } from "../failover";

const PROVIDER_ID: ProviderId = "scrapling";
const BASE_URL = process.env.DATA_SERVICE_URL ?? "";

async function dsGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`data-service ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export class ScraplingProvider implements MarketDataProvider {
  readonly id: ProviderId = PROVIDER_ID;

  private get enabled(): boolean {
    return Boolean(BASE_URL);
  }

  async getHistoricalCandles(
    req: HistoricalCandleRequest,
    opts?: ProviderCallOptions,
  ): Promise<OHLCVCandle[]> {
    if (!this.enabled) return [];
    return withRetry(PROVIDER_ID, async () => {
      const params = new URLSearchParams({
        symbol: req.symbol,
        exchange: req.exchange,
        interval: req.interval,
        from: req.from.slice(0, 10),
        to: req.to.slice(0, 10),
      });
      const data = await dsGet<{ candles: OHLCVCandle[] }>(
        `/scraping/historical?${params}`,
        opts?.signal,
      );
      return data.candles;
    }, "getHistoricalCandles");
  }

  async getLatestQuote(
    symbol: string,
    opts?: ProviderCallOptions,
  ): Promise<MDQuote | null> {
    if (!this.enabled) return null;
    const quotes = await this.getQuotes([symbol], opts);
    return quotes[0] ?? null;
  }

  async getQuotes(
    symbols: string[],
    opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    if (!this.enabled || symbols.length === 0) return symbols.map(() => null);
    return withRetry(PROVIDER_ID, async () => {
      const params = new URLSearchParams({ symbols: symbols.join(","), exchange: "NSE" });
      const data = await dsGet<{ quotes: Array<MDQuote | null> }>(
        `/scraping/quotes?${params}`,
        opts?.signal,
      );
      return data.quotes;
    }, "getQuotes");
  }

  async getOptionChain(
    underlying: string,
    expiry?: string,
    opts?: ProviderCallOptions,
  ): Promise<OptionChain> {
    if (!this.enabled) throw new Error("ScraplingProvider: DATA_SERVICE_URL not set");
    return withRetry(PROVIDER_ID, async () => {
      const params = new URLSearchParams({ underlying, exchange: "NSE" });
      if (expiry) params.set("expiry", expiry);
      return dsGet<OptionChain>(`/scraping/option-chain?${params}`, opts?.signal);
    }, "getOptionChain");
  }

  async getInstrumentMaster(
    filter?: InstrumentMasterFilter,
    opts?: ProviderCallOptions,
  ): Promise<Instrument[]> {
    if (!this.enabled) return [];
    return withRetry(PROVIDER_ID, async () => {
      const params = new URLSearchParams();
      if (filter?.exchange) params.set("exchange", filter.exchange);
      if (filter?.instrumentType) params.set("type", filter.instrumentType);
      const data = await dsGet<{ instruments: Instrument[] }>(
        `/scraping/instruments?${params}`,
        opts?.signal,
      );
      return data.instruments;
    }, "getInstrumentMaster");
  }

  subscribe(
    req: SubscribeRequest,
    onTick: (tick: LiveTick) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    // Primary tick delivery is via Redis pub/sub (scraping-tick-listener.ts).
    // This polling fallback serves code paths that call subscribe() directly.
    if (!this.enabled) return () => {};
    const symbols = req.tokens.map((t) => t.token);
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const quotes = await this.getQuotes(symbols);
        for (const q of quotes) {
          if (!q || q.ltp == null) continue;
          onTick({
            token: q.symbol,
            symbol: q.symbol,
            exchange: q.exchange ?? "NSE",
            ltp: q.ltp,
            change: q.change,
            changePct: q.changePct,
            volume: q.volume,
            oi: q.oi,
            exchangeTimestampMs: Date.now(),
            receivedAtMs: Date.now(),
            provider: PROVIDER_ID,
          });
        }
      } catch (err) {
        onError?.(err);
      }
    };

    void poll();
    const id = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }

  unsubscribe(_tokens: string[]): void {}

  getProviderHealth(): ProviderHealth {
    return getProviderHealth(PROVIDER_ID);
  }
}

export const scraplingProvider = new ScraplingProvider();
```

**`src/lib/market-data/types.ts` change:**
```typescript
// Add "scrapling" as the first entry
export type ProviderId = "scrapling" | "angel_one" | "upstox" | "nse" | "yahoo";

export const PROVIDER_PRIORITY: readonly ProviderId[] = [
  "scrapling",
  "angel_one",
  "upstox",
  "nse",
  "yahoo",
];
```

**`src/lib/market-data/registry.ts` change** — add to `bootstrapRegistry()` before the Angel One registration:
```typescript
const { ScraplingProvider } = await import("./providers/scrapling");
registry.register({
  provider: new ScraplingProvider(),
  capabilities: {
    historicalCandles: true,
    liveQuotes: true,
    webSocket: false,
    optionChain: true,
    instrumentMaster: true,
    intradayCandles: true,
    fno: true,
  },
  priority: 0,
  enabled: !!process.env.DATA_SERVICE_URL,
});
```

**Tests (`tests/lib/market-data/providers/scrapling.test.ts`):**
- Mock `fetch` for each method. Assert correct URL construction including query params.
- Assert correct response mapping to canonical types (`OHLCVCandle`, `MDQuote`, `OptionChain`).
- Assert all methods return empty/null gracefully when `DATA_SERVICE_URL` is not set.
- Assert `withRetry` error propagation on HTTP 500.
- Assert `ScraplingProvider` is registered at priority 0 in `bootstrapRegistry()` when `DATA_SERVICE_URL` is set.
- Assert `enabled: false` when `DATA_SERVICE_URL` is absent — existing tests for Angel One must remain green.

**Demo:** Set `DATA_SERVICE_URL=http://localhost:8200`. Run `npm run dev`. Open `/in/options`. The option chain loads from Scrapling (zero broker credentials). Stop the data-service — the chain loads from Angel One (automatic failover, no user-visible disruption).

---

### Task 7 — NSE + BSE Instrument Master

**Objective:** Scrape the NSE F&O lot sizes master and BSE scrip code master. Provides `symbol → lot_size` and `symbol → bse_scrip_code` mappings needed by the option chain scraper, GEX engine, and backtester.

**Files to create:** `data-service/src/scrapers/instrument_master.py`

**NSE F&O lot sizes** — official CSV from NSE archives, updated after every monthly expiry:
```
https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv
```
Format: symbol, lot size per expiry cycle. NSE publishes this without any authentication or anti-bot protection (it is served from `nsearchives.nseindia.com`, a CloudFront-fronted static archive).

**NSE full contract list:**
```
https://www.nseindia.com/api/allcontracts
```
Returns JSON with all current F&O contracts including tokens, strike prices, expiry dates.

**BSE scrip master** — daily ZIP, unauthenticated:
```
https://www.bseindia.com/download/BseIndiaAPI/Equity/EQUITY_{DDMMYYYY}.zip
```
Contains `Equity.csv` with columns: `Security Code`, `Security Name`, `Series`, `ISIN No.`, `Status`.

**NSE known lot sizes (hardcoded fallback):**
```python
# data-service/src/scrapers/instrument_master.py
NSE_LOT_SIZES: dict[str, int] = {
    "NIFTY": 50,
    "BANKNIFTY": 15,
    "FINNIFTY": 40,
    "MIDCPNIFTY": 75,
    "SENSEX": 10,      # BSE — included here for convenience
    "BANKEX": 15,      # BSE
    # ... 200+ F&O stocks with their current lot sizes
}
```

**REST endpoints:**
```
GET /scraping/instruments?exchange=NSE&type=FO
GET /scraping/instruments/{symbol}
GET /scraping/instruments/refresh          (POST — force re-download, ignores cache)
```

**Tests (`tests/scrapers/test_instrument_master.py`):**
- Fixture of `fo_mktlots.csv` (10-row sample). Assert NIFTY=50, BANKNIFTY=15, FINNIFTY=40, MIDCPNIFTY=75.
- Assert disk cache used on second call (file modified time check).
- Assert hardcoded fallback is used when the CSV download fails.

---

### Task 8 — Anti-Ban Hardening + Health Monitoring

**Objective:** Production hardening — proxy rotation, rate limiting, ban detection, session warm-up scheduling, and a health monitoring router. The difference between a scraper that lasts 1 day and one that runs for 1 year.

**Files to create:**
- `data-service/src/anti_ban/proxy_manager.py`
- `data-service/src/anti_ban/rate_limiter.py`
- `data-service/src/anti_ban/ban_detector.py`
- `data-service/src/anti_ban/session_warmer.py`
- `data-service/src/monitoring/router.py`

**Ban detection signatures:**
```python
# data-service/src/anti_ban/ban_detector.py
BAN_SIGNATURES = [
    # NSE shadow-ban: 200 OK but empty records
    lambda payload: (payload.get("records", {}) or {}).get("data") == [],
    # Akamai challenge page
    lambda payload: isinstance(payload, str) and "window._atsb" in payload,
    # Rate limit
    lambda payload: isinstance(payload, str) and "Too Many Requests" in payload,
    # NSE maintenance page
    lambda payload: isinstance(payload, str) and "Under Maintenance" in payload,
]

def is_banned(response_body) -> bool:
    return any(sig(response_body) for sig in BAN_SIGNATURES)
```

**Session warm-up scheduler:**
```python
# data-service/src/anti_ban/session_warmer.py
# Runs as an asyncio background task.
# Warms a DynamicSession every 30 minutes between 09:00 and 16:00 IST.
# Persists warm session state so option chain requests reuse it immediately.
IST_OFFSET = 5.5 * 3600   # seconds
WARM_INTERVAL_S = 30 * 60
MARKET_OPEN_IST  = 9 * 3600        # 09:00
MARKET_CLOSE_IST = 16 * 3600       # 16:00
```

**Health monitoring router (`data-service/src/monitoring/router.py`):**
```
GET /monitoring/health          → Overall health: request counts, ban events, cache hit rates
GET /monitoring/scraping-stats  → Per-endpoint latency P50/P99, success rate (last 1h)
GET /monitoring/proxy-status    → Proxy pool size, rotation count, active proxy
GET /monitoring/session-status  → Last warm-up time, session age, warm-up schedule
```

**Tests:**
- `tests/anti_ban/test_ban_detector.py`: assert empty `records.data` → `is_banned() == True`. Assert normal payload → `is_banned() == False`.
- `tests/anti_ban/test_rate_limiter.py`: assert > 3 NSE requests/s triggers queue, not drop. Assert queued requests are served in order.
- `tests/monitoring/test_health_route.py`: route returns correct structure; ban count increments on simulated ban.

---

### Task 9 — BSE Historical + SENSEX Option Chain

**Objective:** Full BSE parity. BSE Bhavcopy (5yr daily OHLCV), BSE intraday, and SENSEX option chain. Directly upgrades the existing Gamma Blast/Hero Zero expiry-day plays which currently fall back to Black-Scholes estimation for BSE data.

**Files to modify:** `data-service/src/scrapers/historical.py`, `data-service/src/scrapers/option_chain.py`

**BSE Bhavcopy URL pattern:**
```
https://www.bseindia.com/download/BhavCopy/Equity/EQ{DDMMYYYY}_CSV.ZIP
```
Contains `EQ{DDMMYYYY}_CSV.CSV` with columns: `Code`, `Name`, `Open`, `High`, `Low`, `Close`, `No of Shares`, `No of Trades`, `Total Turnover`. Map `Code` to `symbol` via the BSE scrip master from Task 7.

**BSE intraday charting API:**
```
https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w
  ?scripcode={bse_scrip_code}
  &Resolution={5|15|30|60}
  &Category=EQ
  &FromDate={DD%2FMM%2FYYYY}
  &ToDate={DD%2FMM%2FYYYY}
```
Returns: `{"Data": [[timestamp_ms, open, high, low, close, volume], ...]}`.

**SENSEX option chain impact on existing features:**
- `src/features/india/expiry-trades/` — the Gamma Blast / Hero Zero engine currently has a fallback branch for when BSE chain data is unavailable, using Black-Scholes spot price estimation. With Task 9, this fallback is never reached. The `Gamma Blast` play gets real SENSEX option chain LTPs. The `Hero Zero` OTM lottery strike is picked from real OI data.
- `src/app/(dashboard)/in/options/page.tsx` — add `SENSEX` to the underlying selector.

**Tests:**
- `tests/scrapers/test_bse_historical.py`: fixture of BSE Bhavcopy ZIP. Assert scrip code → symbol mapping. Assert correct OHLCV parsing.
- `tests/scrapers/test_bse_option_chain.py`: fixture of captured BSE XHR JSON. Assert SENSEX chain has expiries, rows, analytics.

---

### Task 10 — ML Training Pipeline Upgrade

**Objective:** Make `data-service` the primary data source for ML model training, eliminating training/serving skew. Models trained on Bhavcopy data are trained on the same source that drives live signals.

**Files to modify:** `ml-service/src/training/market_data_client.py`, `docker-compose.yml`

**Updated tier priority in `market_data_client.py`:**
```python
# Tier 0 (NEW): data-service Scrapling — exchange-official Bhavcopy
# Tier 1: AlphaForge REST API (Angel One + Upstox backed)
# Tier 2: PostgreSQL CandleBar table
# Tier 3: yfinance (last resort, DataQuality.STALE)

DATA_SERVICE_URL = os.getenv("DATA_SERVICE_URL", "")

async def _fetch_via_scrapling(
    symbol: str,
    interval: str,
    from_date: str,
    to_date: str,
) -> list[dict] | None:
    if not DATA_SERVICE_URL:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{DATA_SERVICE_URL}/scraping/historical",
                params={"symbol": symbol, "exchange": "NSE",
                        "interval": interval, "from": from_date, "to": to_date},
            )
            r.raise_for_status()
            data = r.json()
            return data.get("candles", [])
    except Exception as e:
        logger.warning("scrapling_fetch_failed", symbol=symbol, error=str(e))
        return None
```

**`docker-compose.yml` ml-service environment addition:**
```yaml
DATA_SERVICE_URL: "http://data-service:8200"
```

**`docker-compose.yml` ml-service `depends_on` addition:**
```yaml
depends_on:
  postgres:
    condition: service_healthy
  redis:
    condition: service_healthy
  data-service:
    condition: service_started   # soft — ML service does not fail if data-service is down
```

**DataQuality tagging:**
```python
DataQuality.GOOD    # data-service (NSE Bhavcopy — exchange-official)
DataQuality.GOOD    # AlphaForge API (Angel One / Upstox)
DataQuality.STALE   # PostgreSQL (may be stale)
DataQuality.STALE   # yfinance (derived, may differ from exchange official)
```

**Tests (`ml-service/tests/training/test_market_data_client.py`):**
- Mock `httpx.AsyncClient.get` for data-service call. Assert it is tried first. Assert fallthrough on HTTP 500. Assert `DataQuality.GOOD` tagged on Scrapling response.

---

### Task 11 — Provider Health Dashboard + Data Source Badge

**Objective:** Surface the active data source in the UI. Operators see which provider is serving each data type in real time. Users see a small badge confirming their data is live and from a known source.

**Files to create/modify:**
- `src/components/india/DataSourceBadge.tsx` (new)
- `src/app/api/in/provider-health/route.ts` (new)
- `src/app/(dashboard)/in/dashboard/page.tsx` (modify — add DataSourceBadge to option chain header)

**`DataSourceBadge` component:**
```tsx
// src/components/india/DataSourceBadge.tsx
// Small pill showing active provider + latency. Color-coded by provider tier.
// Scrapling/Angel One: green. Upstox/NSE legacy: amber. Yahoo: red.
const PROVIDER_COLORS: Record<string, string> = {
  scrapling:  "var(--color-data-positive)",
  angel_one:  "var(--color-data-positive)",
  upstox:     "var(--color-data-neutral)",
  nse:        "var(--color-data-neutral)",
  yahoo:      "var(--color-data-negative)",
};

const PROVIDER_LABELS: Record<string, string> = {
  scrapling:  "Scrapling",
  angel_one:  "Angel One",
  upstox:     "Upstox",
  nse:        "NSE Direct",
  yahoo:      "Yahoo (degraded)",
};
```

**`/api/in/provider-health` route:**
```typescript
// Aggregates registry.getHealth() + data-service /monitoring/health
// Returns unified ProviderHealthReport for the UI dashboard.
```

**Tests:**
- `tests/components/india/DataSourceBadge.test.tsx`: renders green "Scrapling" when ScraplingProvider is active. Renders amber "Upstox" on Scrapling failure. Renders red "Yahoo (degraded)" when only Yahoo is active.
- `tests/api/provider-health.test.ts`: route aggregates 5 providers; returns `{ available: false }` for data-service section when service is down (no crash).

**Demo:** Open `/in/options`. The option chain header shows a green `Scrapling ● 180ms` badge. Open Profile → Data Sources for the full health table. Stop the data-service container — the badge transitions from green "Scrapling" to green "Angel One" within 30s (next polling cycle). No page reload, no disruption to data.

---

## 11. Implementation Order & Dependencies

```
Task 1  (scaffold + docker)       → no deps — start here
Task 2  (historical OHLCV)        → depends on Task 1
Task 3  (live quotes)             → depends on Task 1
Task 4  (option chain)            → depends on Task 1; uses Task 3 session patterns
Task 5  (tick publisher)          → depends on Tasks 1, 3
Task 6  (TypeScript provider)     → depends on Tasks 2, 3, 4 being live
Task 7  (instrument master)       → depends on Task 1; provides data for Tasks 4, 9
Task 8  (anti-ban hardening)      → depends on Tasks 3, 4; wraps them with protection
Task 9  (BSE data)                → depends on Tasks 2, 4, 7
Task 10 (ML training)             → depends on Task 2
Task 11 (health dashboard)        → depends on Tasks 5, 6, 8
```

**Suggested parallel tracks:**
- **Track A:** Tasks 1 → 2 → 10 (historical data + ML)
- **Track B:** Tasks 1 → 3 → 4 → 5 (live data + pub/sub)
- **Track C:** Task 6 (TypeScript integration — can start after Task 1 with mock responses)
- **Track D:** Tasks 7 → 8 → 9 → 11 (instrument master + hardening + BSE + UI)

Track A and Track B can run in parallel after Task 1 is complete.

---

## 12. NSE/BSE Endpoints Reference

### NSE JSON API (captured via `capture_xhr` or direct HTTP)

| Endpoint | Data | Auth Required |
|---|---|---|
| `api/option-chain-indices?symbol={X}` | Index option chain (NIFTY etc.) | No (session cookies) |
| `api/option-chain-equities?symbol={X}` | Equity option chain | No (session cookies) |
| `api/equity-stockIndices?index=NIFTY%20200` | Batch quotes for NIFTY 200 stocks | No (session cookies) |
| `api/quote/equity?symbol={X}` | Single equity quote (full) | No (session cookies) |
| `api/quote-derivative?symbol={X}` | F&O quote + OI | No (session cookies) |
| `api/allIndices` | All NSE indices (NIFTY, BankNIFTY, etc.) | No (session cookies) |
| `api/allcontracts` | Full F&O contract list with tokens | No (session cookies) |
| `api/historicalOR?...&csvFlag=1` | Daily OHLCV historical download | No (session cookies) |
| `charting.nseindia.com/charts/getData` | Intraday OHLCV (5m, 15m, etc.) | No (session cookies) |
| `nsearchives.nseindia.com/content/fo/fo_mktlots.csv` | F&O lot sizes master | **No auth, no anti-bot** |
| `nsearchives.nseindia.com/content/historical/DERIVATIVES/...` | F&O Bhavcopy ZIP | **No auth, no anti-bot** |

### BSE JSON API

| Endpoint | Data | Auth Required |
|---|---|---|
| BSE Derivatives page XHR `GetOptionChain` | SENSEX option chain | No (session cookies) |
| `api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w` | Single equity quote | No |
| `api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w` | Intraday OHLCV | No |
| `bseindia.com/download/BhavCopy/Equity/EQ{date}_CSV.ZIP` | Daily OHLCV Bhavcopy | **No auth, no anti-bot** |
| `bseindia.com/download/BseIndiaAPI/Equity/EQUITY_{date}.zip` | BSE equity scrip master | **No auth, no anti-bot** |

### Session cookies required (obtained via `DynamicSession` or `FetcherSession` warm-up)

| Cookie | Set by | Purpose |
|---|---|---|
| `bm_sz` | Akamai Bot Manager | Bot score session |
| `_abck` | Akamai Bot Manager | Advanced bot check |
| `nsit` | NSE app | NSE session identity |
| `nseappid` | NSE app | NSE app session |
| `ak_bmsc` | Akamai Bot Manager | Bot management script context |

Scrapling's `DynamicSession` (Chromium) collects all of these automatically by loading the page like a real browser. `FetcherSession` with `stealthy_headers=True` collects them via the two-step HTTP warm-up (root page → target page).

---

## 13. Graceful Degradation Contract

Every endpoint in the data-service and every method in `ScraplingProvider` must follow this contract when the service is unavailable or scraping fails:

**Python (data-service):**
```python
# When scraping fails and no cache is available:
return JSONResponse(
    status_code=503,
    content={"available": False, "reason": "Scrapling error: <message>", "provider": "scrapling"},
)

# When service is healthy but data is empty (market closed, symbol not found):
return {"available": True, "candles": [], "count": 0}
```

**TypeScript (ScraplingProvider):**
```typescript
// getHistoricalCandles — return [] on any error (failover picks up)
// getLatestQuote — return null on any error
// getOptionChain — throw MarketDataError so failover moves to Angel One
// getInstrumentMaster — return [] on any error
// subscribe — return no-op unsubscribe on error
```

**UI components:**
```tsx
// DataSourceBadge — shows nothing (no badge) when provider health is unknown
// Option chain table — shows existing ErrorState + Retry when all providers fail
// Historical chart — shows EmptyState when no candles returned
```

**The failover chain guarantees:** when `ScraplingProvider` throws, `withFailover` automatically tries Angel One. When Angel One throws, it tries Upstox. And so on. The UI never shows a blank page because of a single provider failure.

---

## 14. Testing Policy

All new code follows AlphaForge's existing TDD policy:

1. Write the failing test first.
2. Confirm it fails for the right reason (assertion, not import error).
3. Write the smallest implementation that makes it green.
4. Refactor under the green safety net.

### Python tests (pytest)

```bash
# Run data-service tests
cd data-service
pytest tests/ -v

# Run with coverage
pytest tests/ --cov=src --cov-report=html
```

### TypeScript tests (Vitest)

```bash
# ScraplingProvider unit tests
npm run test:lib -- --reporter=verbose tests/lib/market-data/providers/scrapling.test.ts

# Worker tick listener tests
npm run test:worker -- --reporter=verbose

# Full suite (must stay green)
npm test
```

### Anti-patterns to avoid

- Do not mock `DynamicSession` by default in integration tests — use `pytest-mock` `mocker.patch` only in unit tests. Integration tests should use real `FetcherSession` against fixture HTML files.
- Do not snapshot the raw NSE JSON payload — it changes. Assert on specific normalised fields.
- Do not test that scraping succeeds against live NSE/BSE endpoints in CI — this will be flaky. All scraper tests use fixture files.
- Do not skip tests without a GitHub issue reference.

---

## 15. Operational Runbook

### Starting the data-service

```bash
# Development (local, no Docker)
cd data-service
pip install -r requirements.txt
scrapling install   # installs Chromium + browser deps
DATA_SERVICE_PORT=8200 REDIS_URL=redis://localhost:6379 uvicorn src.server:app --port 8200 --reload

# Docker (recommended)
docker compose up data-service

# With proxy
SCRAPLING_PROXY_URL=http://user:pass@proxy-host:3128 docker compose up data-service
```

### Checking health

```bash
# Service health
curl http://localhost:8200/health

# Scraping capability status
curl http://localhost:8200/scraping/status

# Tick publisher status
curl http://localhost:8200/publisher/status

# Full monitoring dashboard
curl http://localhost:8200/monitoring/health | jq .

# Watch Redis tick stream live
redis-cli psubscribe "af:ticks:*"
```

### Pre-market warm-up (recommended for production)

```bash
# Call at 09:00 IST to pre-warm the browser session before market open
curl -X POST http://localhost:8200/scraping/option-chain/warm
```

### Force instrument master refresh

```bash
curl -X POST http://localhost:8200/scraping/instruments/refresh
```

### Scaling for high-frequency production use

1. Set `SCRAPLING_PROXY_LIST` with a pool of 5–10 residential proxy URLs.
2. Reduce `NSE_RATE_LIMIT` to `2` if experiencing shadow-bans.
3. Set `SCRAPLING_HEADLESS=true` (default). Only set `false` for debugging on a machine with a display.
4. Mount a persistent volume at `/app/data` for Bhavcopy disk cache — avoids re-downloading on container restart.
5. Monitor `GET /monitoring/health` — if ban events exceed 3/hour, the proxy pool needs rotation.

### When NSE changes its XHR URL pattern

Scrapling's adaptive tracking handles minor CSS changes automatically (saved fingerprints). For major URL changes:

1. Check `GET /monitoring/scraping-stats` for which endpoint started failing.
2. Update the `capture_xhr` pattern string in `option_chain.py` or `live_quotes.py`.
3. Run `POST /scraping/option-chain/warm` to rebuild the element fingerprint.
4. No AlphaForge TypeScript changes needed — the provider contract is stable.

---

*This document is the single source of truth for the Scrapling data microservice implementation. All implementation tasks in this plan are additive — no existing routes, stores, worker jobs, or provider adapters are broken. The existing failover chain (Angel One → Upstox → NSE → Yahoo) becomes the graceful degradation path when the Scrapling service is unavailable.*

---

> **Scrapling library:** https://github.com/D4Vinci/Scrapling (BSD-3-Clause)
> **NSE data attribution:** All NSE data is sourced from nseindia.com and nsearchives.nseindia.com. Use in compliance with NSE's terms of service.
> **BSE data attribution:** All BSE data is sourced from bseindia.com. Use in compliance with BSE's terms of service.
