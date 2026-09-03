# AlphaForge Data Service

Standalone reference for the `data-service` Python microservice — the credential-free Indian market data layer that scrapes NSE and publishes live ticks to Redis.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Configuration](#3-configuration)
4. [Docker & Networking](#4-docker--networking)
5. [API Endpoints](#5-api-endpoints)
6. [Session Management (Scrapling)](#6-session-management-scrapling)
7. [Live Quotes — NSE NextApi](#7-live-quotes--nse-nextapi)
8. [Historical OHLCV](#8-historical-ohlcv)
9. [Option Chain Scraper](#9-option-chain-scraper)
10. [Tick Publisher](#10-tick-publisher)
11. [Anti-Ban Layer](#11-anti-ban-layer)
12. [Redis Schema](#12-redis-schema)
13. [Bug-Fix Log](#13-bug-fix-log)
14. [Known Limitations](#14-known-limitations)
15. [Development Guide](#15-development-guide)

---

## 1. Overview

The data service provides NSE market data without requiring any broker credentials. It runs as a sidecar alongside the main Next.js application and the ML microservice.

| Property | Value |
|---|---|
| Language | Python 3.11 |
| Framework | FastAPI + Uvicorn |
| Port | **8200** |
| Base image | `python:3.11-slim` |
| Browser engine | Playwright / Chromium via **Scrapling 0.4.x** |
| Redis client | `redis[hiredis]==5.0.8` |

### What it does

- **Live quotes** — Fetches real-time NSE equity and index prices via the NSE `NextApi` (plain `httpx`, no browser required for quotes).
- **Historical OHLCV** — Downloads daily Bhavcopy archives from NSE/BSE CDN and intraday candles from the NSE charting API.
- **Option chain** — Scrapes the NSE option-chain page using a headless Chromium browser (Scrapling `AsyncDynamicSession`), captures the `api/option-chain` XHR.
- **Tick publisher** — Polls live quotes every 5 seconds and publishes ticks to Redis pub/sub channels for downstream consumers.
- **Instrument master** — Exposes the full NSE/BSE instrument list for token-to-symbol resolution.

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
│  Anti-ban                                                │
│  ├── proxy_manager.py  (optional proxy pool)             │
│  ├── ban_detector.py   (response body heuristics)        │
│  └── session_warmer.py (30-min homepage warm loop)       │
└──────────────────────────────────────────────────────────┘
         │                            │
    Redis pub/sub              Chromium (headless)
    af:ticks:{SYMBOL}          via Playwright
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
| `src/publisher/tick_publisher.py` | 5 s poll loop + Redis `PUBLISH` |
| `src/publisher/router.py` | `GET /publisher/*` monitoring endpoints |
| `src/anti_ban/proxy_manager.py` | Optional proxy pool with rotation |
| `src/anti_ban/ban_detector.py` | Body-content ban heuristics |
| `src/anti_ban/session_warmer.py` | Background 30-min warm loop (market hours only) |
| `src/anti_ban/rate_limiter.py` | Per-domain token-bucket rate limiters |
| `src/monitoring/router.py` | `/monitoring/*` health and status endpoints |

---

## 3. Configuration

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

In `docker-compose.yml` these are passed via the `environment:` block on the `data-service` service.

---

## 4. Docker & Networking

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

## 5. API Endpoints

### Health

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Always HTTP 200. `status: "healthy"` or `"degraded"` with component map. |
| `GET` | `/scraping/status` | Capability flags (chromium, redis, proxy, each scraper path). |

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

### Publisher / Monitoring

| Method | Path | Notes |
|---|---|---|
| `GET` | `/publisher/status` | Tick publisher stats (publish count, last tick time, symbols) |
| `GET` | `/publisher/symbols` | List of tracked symbols |
| `POST` | `/publisher/symbols` | Add symbols to the tick publisher |
| `DELETE` | `/publisher/symbols/{symbol}` | Remove a symbol |
| `GET` | `/monitoring/status` | Full component health map |
| `GET` | `/monitoring/session-warmer` | Session warmer schedule (last warm, next warm) |

---

## 6. Session Management (Scrapling)

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

## 7. Live Quotes — NSE NextApi

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

## 8. Historical OHLCV

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

## 9. Option Chain Scraper

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

## 10. Tick Publisher

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

## 11. Anti-Ban Layer

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

## 12. Redis Schema

| Key pattern | Type | TTL | Written by | Read by |
|---|---|---|---|---|
| `af:ticks:{SYMBOL}` | Pub/Sub channel | — | `tick_publisher` | Next.js `useLiveQuotes` hook |
| `scraping:quote:{exchange}:{symbol}` | String (JSON) | 5 s | `live_quotes` route | `live_quotes` route (cache check) |
| `scraping:chain:{underlying}:{expiry}:{exchange}` | String (JSON) | 20 s | `option_chain` route | `option_chain` route (cache check) |
| `scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}` | String (JSON) | 3600 s | `historical` route | `historical` route (cache check) |

---

## 13. Bug-Fix Log

This section documents every defect found and fixed during the initial deployment hardening sprint (2026-09-03).

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

## 14. Known Limitations

| Limitation | Detail |
|---|---|
| `nse_daily_http_error 403` | NSE archives returns HTTP 403 for some recent and holiday-adjacent dates. The scraper logs a warning, skips the day, and continues. This is an NSE server-side restriction, not a code bug. |
| Option chain — NIFTY 500 coverage | `_fetch_single_quote()` falls back to the NIFTY 500 constituent list. Symbols outside NIFTY 500 (e.g. small-cap equities) return `null`. |
| Index volume | The `getIndexData&&type=All` endpoint does not expose traded volume for index symbols. `volume` and `oi` are `null` for NIFTY, BANKNIFTY, etc. |
| Session warmer isolated | The session warmer creates its own ephemeral browser session. Cookies it establishes do not carry over to the scraper singletons. The 30-min warm is a health/anti-ban check, not a cookie seed. |
| BSE daily Bhavcopy | BSE's ZIP archive format occasionally changes the inner CSV filename casing. The scraper does a case-insensitive name match but may miss edge cases. |
| Intraday `grapthData` typo | The NSE charting API's `grapthData` key is a known NSE-side typo. If NSE fixes the typo, the intraday scraper will silently return 0 candles until `src/scrapers/historical.py` is updated. |

---

## 15. Development Guide

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
