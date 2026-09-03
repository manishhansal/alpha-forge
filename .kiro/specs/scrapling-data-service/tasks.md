# Implementation Plan: scrapling-data-service

## Overview

This plan implements the credential-free Scrapling data tier end-to-end. A Python FastAPI
microservice (`data-service`) scrapes NSE/BSE using headless Chromium and FetcherSession,
publishes live ticks to Redis pub/sub, and is consumed by a TypeScript `ScraplingProvider`
registered at Priority 0 in the existing `ProviderRegistry`. The failover chain, existing
provider interfaces, and all call sites remain unchanged.

Implementation proceeds in four parallel tracks after the initial scaffold and schema tasks:
- **Track A** — Anti-ban layer → BhavcopyScraper → InstrumentMaster (serial; each builds on the previous)
- **Track B** — LiveQuoteScraper → OptionChainScraper → TickPublisher (serial within track; depends on Track A's anti-ban layer)
- **Track C** — TypeScript ScraplingProvider + Worker TickListener (can start after Task 1 using mock responses)
- **Track D** — Monitoring endpoints → ML pipeline upgrade → DataSourceBadge (late-stage integration)

Property-based tests (Tasks 14) and unit tests (Task 15) are authored close to the implementation tasks they cover.

---

## Tasks

- [x] 1. Service scaffold, Dockerfile, and Docker integration
  - [x] 1.1 Create `data-service/` directory with `Dockerfile`, `requirements.txt`, and `pyproject.toml`
    - `Dockerfile`: Python 3.11-slim base, install system deps (`curl`, `ca-certificates`), install `requirements.txt`, run `scrapling install` during build (Chromium installed at build time, not runtime), expose port 8200, `CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8200"]`
    - `requirements.txt`: pin `fastapi`, `uvicorn[standard]`, `scrapling[fetchers]==0.4.*`, `aioredis`, `httpx`, `pydantic>=2`, `structlog`, `hypothesis`, `pytest`, `pytest-asyncio`
    - `pyproject.toml`: project metadata, `[tool.pytest.ini_options]` with `asyncio_mode = "auto"` and `markers = ["integration"]`
    - _Requirements: 1.6_
  - [x] 1.2 Create `data-service/src/__init__.py`, `data-service/src/config.py`
    - `config.py`: frozen `Settings` dataclass using `os.getenv` for all runtime parameters: `port` (default 8200), `redis_url` (default `redis://redis:6379/0`), `proxy_enabled` (default False), `scrapling_proxy_url` (default `""`), `nse_rate_limit` (default 3, min 1, max 20), `bse_rate_limit` (default 2, min 1, max 20), `ban_backoff_seconds` (default 60), `data_dir` (default `/app/data`), `symbols` (default `[]`, comma-split from env), `headless` (default True)
    - Log every resolved parameter value at startup using `structlog`
    - _Requirements: 1.4_
  - [x] 1.3 Create `data-service/src/server.py` with FastAPI app, lifespan, and CORS middleware
    - FastAPI `lifespan` context: load Settings → connect aioredis → warm DynamicSession → start AntibanLayer → start TickPublisher → register routers
    - CORS: allow `http://localhost:3000` and `http://127.0.0.1:3000` only; all other origins → 403
    - `GET /health`: return `{"status": "healthy"|"degraded", "service": "data-service", "version": "0.1.0", "timestamp": "<UTC ISO-8601>"}` — always HTTP 200; include `"components"` object on degraded
    - `GET /scraping/status`: return capability flags (chromium_available, redis_connected, proxy_available) and config summary (active_symbol_count, rate_limit, data_dir)
    - Failed component during startup → `degraded` status, not crash
    - _Requirements: 1.1, 1.2, 1.3, 1.7_
  - [x] 1.4 Add `data-service` service to `docker-compose.yml`
    - Memory limit 2 GB, named volume `data_service_cache:/app/data`, `depends_on: redis: condition: service_healthy`, healthcheck using `httpx.get('http://localhost:8200/health')`, `start_period: 90s`
    - Add `data_service_cache` to the top-level `volumes:` block
    - _Requirements: 1.5, 1.6_

- [x] 2. Pydantic schemas
  - [x] 2.1 Create `data-service/src/schemas.py` with all canonical Pydantic models
    - Define `OHLCVCandle`, `Greeks`, `OptionContract`, `OptionChainRow`, `OptionChainAnalytics`, `OptionChain`, `MDQuote`, `LiveTick`, `Instrument`, `HealthStatus` — field names and nesting MUST be identical to the TypeScript types in `src/lib/market-data/types.ts`
    - `OptionChain.provider` is `Literal["scrapling"]`; `MDQuote.provider` is `Literal["scrapling"]`; `LiveTick.provider` is `Literal["scrapling"]`
    - Add `HistoricalRequest` and `QuotesRequest` Pydantic models for query parameter validation (symbol, exchange, interval, from, to, symbols)
    - _Requirements: 2.1, 3.4, 4.1, 5.2_
  - [x] 2.2 Create `data-service/src/scrapers/__init__.py`, `data-service/src/anti_ban/__init__.py`, `data-service/src/publisher/__init__.py`, `data-service/src/monitoring/__init__.py`
    - Empty `__init__.py` files to make each directory a Python package
    - _Requirements: 1.1_

- [x] 3. Anti-ban layer
  - [x] 3.1 Implement `data-service/src/anti_ban/rate_limiter.py`
    - `TokenBucketRateLimiter(domain, rate, capacity)`: asyncio token bucket with `async def acquire()`; FIFO overflow `asyncio.Queue(maxsize=1000)`; raise `QueueFullError` when queue depth reaches 1000
    - One singleton instance per domain: `nse_limiter` (rate=`settings.nse_rate_limit`), `bse_limiter` (rate=`settings.bse_rate_limit`), `nsearchives_limiter` (unlimited/no-op)
    - _Requirements: 9.1, 9.2, 9.3_
  - [x] 3.2 Implement `data-service/src/anti_ban/ban_detector.py`
    - `BanDetector` class with `is_banned(body: str | dict) -> bool` and `ban_count: int` property
    - Three detection patterns: `ShadowBanPattern` (records.data == [] AND IST market hours 03:30–10:30 UTC), `AkamaiChallengePattern` (`"window._atsb"` in body), `RateLimitPattern` (`"Too Many Requests"` in body)
    - `_is_market_hours_ist()` helper using UTC offset
    - `increment_ban_count()` method called by each detected pattern; `ban_count` exposed for monitoring
    - _Requirements: 9.4, 9.5, 9.6_
  - [x] 3.3 Implement `data-service/src/anti_ban/proxy_manager.py`
    - `ProxyManager`: wraps Scrapling `ProxyRotator` when `SCRAPLING_PROXY_LIST` env var is set; no-op when unset
    - `rotate()` → advances to next proxy; `active_proxy_masked()` → returns `scheme://***@host:port` string
    - `pool_size: int`, `rotation_count: int` properties for monitoring
    - _Requirements: 9.10, 9.11, 10.3_
  - [x] 3.4 Implement `data-service/src/anti_ban/session_warmer.py`
    - `SessionWarmer`: asyncio background task; calls `_warm_session()` every 30 minutes **only** during IST market hours (03:30–10:30 UTC); stores `last_warm_at`, `next_warm_at`
    - `start()`, `stop()`, `last_warm_at`, `next_warm_at` as async-safe properties
    - Ban/challenge detection in warmer → call `ProxyManager.rotate()`, reset DynamicSession, back off `BAN_BACKOFF_SECONDS`, retry up to 5 times before propagating `BanError`
    - _Requirements: 9.7, 9.8, 9.9_

- [x] 4. BhavcopyScraper (historical OHLCV)
  - [x] 4.1 Implement `data-service/src/scrapers/historical.py` — request validation and routing
    - Validate `symbol`, `exchange` (NSE|BSE), `interval` (1d|5m|15m|30m|1h), `from`, `to` (ISO 8601 dates), `from <= to`; return HTTP 400 with `{"error": "..."}` on any violation
    - Enforce max date ranges: 1825 days for `1d`, 365 days for intraday; return HTTP 400 on violation
    - `GET /scraping/historical` FastAPI route: validate → check Redis cache (`scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}`, TTL 3600s for intraday) → check disk cache (mtime < 24h for daily) → fetch → cache → return
    - Return `{"candles": [...], "count": N}` with candles sorted ascending by `time`
    - Return `{"candles": [], "count": 0}` HTTP 200 when symbol not found or empty date range
    - Return HTTP 503 `{"available": false, "reason": "...", "provider": "scrapling"}` on upstream timeout (>30s) or error
    - _Requirements: 2.1, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13_
  - [x] 4.2 Implement NSE daily Bhavcopy fetch (`FetcherSession`, disk cache) and BSE daily ZIP fetch
    - NSE: `GET https://www.nseindia.com/api/historicalOR?series=EQ&symbol={SYMBOL}&from={DD-MM-YYYY}&to={DD-MM-YYYY}&csvFlag=1` via `FetcherSession(impersonate='chrome', stealthy_headers=True)`; parse CSV columns `Date, OPEN, HIGH, LOW, CLOSE, TOTTRDQTY`; `Date` format `DD-MMM-YYYY`
    - BSE: `GET https://www.bseindia.com/download/BhavCopy/Equity/EQ{DDMMYYYY}_CSV.ZIP`; unzip; parse `Code, Open, High, Low, Close, No of Shares`
    - Disk cache path: `/app/data/bhavcopy/{exchange}/{symbol}/{date}.csv.gz`; serve from cache when mtime < 24h
    - _Requirements: 2.2, 2.3, 2.8_
  - [x] 4.3 Implement NSE and BSE intraday fetch (charting APIs) with IST-to-UTC conversion
    - NSE intraday: `GET https://charting.nseindia.com/charts/getData?appid=chartiq&symbol={SYMBOL}&period={5|15|30|60}&type=EQ&startDate={DD-MM-YYYY}&endDate={DD-MM-YYYY}`; parse `grapthData: [[ts_ms_ist, o, h, l, c, v], ...]`
    - BSE intraday: `GET https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w?scripcode={BSE_CODE}&Resolution={5|15|30|60}&Category=EQ&FromDate={DD/MM/YYYY}&ToDate={DD/MM/YYYY}`; parse `Data`
    - IST→UTC conversion: `utc_epoch_s = (ts_ms_ist / 1000) - 19800`
    - All fields validated per `OHLCVCandle` invariants: high >= max(open,close), low <= min(open,close), all prices > 0, volume >= 0
    - Redis cache write: key `scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}`, TTL 3600s
    - _Requirements: 2.4, 2.5, 2.6, 2.7, 2.9_

- [x] 5. LiveQuoteScraper (capture_xhr, singleton DynamicSession)
  - [x] 5.1 Implement `data-service/src/scrapers/live_quotes.py` — singleton session management
    - One global `AsyncDynamicSession` instance (`_quote_session`) created at lifespan startup; `get_quote_session()` accessor returns the singleton; never creates a new session per request
    - `GET /scraping/quotes`: validate `symbols` query param (1–200 symbols); return HTTP 400 with `{"error": "..."}` when absent, empty, or > 200 symbols
    - Redis cache check per symbol: key `scraping:quote:{exchange}:{symbol}`, TTL 5s; return cached `MDQuote` if age < 5s
    - Timeout 10s on `DynamicSession`; return HTTP 503 `{"available": false, "reason": "..."}` on timeout without modifying cache
    - _Requirements: 3.1, 3.7, 3.8, 3.9_
  - [x] 5.2 Implement batch and single-symbol fetch paths + MDQuote normalization
    - NIFTY 200 batch path: intercept `equity-stockIndices?index=NIFTY%20200` XHR; filter to requested symbols
    - Single-symbol path: intercept `api/quote/equity?symbol={symbol}` per non-constituent symbol
    - Mixed batch: constituent symbols via batch endpoint; non-constituents individually; merge in original input order
    - Normalize to `MDQuote` shape: all 14 required fields present; `ltp: null` when absent in XHR; `provider: "scrapling"`; `fetchedAt` UTC ISO-8601
    - Write to Redis cache after every successful fetch
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.10_

- [x] 6. OptionChainScraper (capture_xhr + analytics pure functions)
  - [x] 6.1 Implement `data-service/src/scrapers/option_chain.py` — NSE and BSE fetch paths
    - `GET /scraping/option-chain`: validate `underlying` and `exchange` (NSE|BSE); default expiry to nearest available when `expiry` query param omitted
    - NSE path: `DynamicSession` fetch `nseindia.com/option-chain`, `capture_xhr="api/option-chain"`; save element fingerprints on first scrape (`auto_save=True`)
    - BSE SENSEX path: `DynamicSession` fetch `bseindia.com/markets/Derivatives/DerivativeHome.aspx?flag=03`, `capture_xhr="GetOptionChain"`
    - Fallback: on `BrowserError` or 15s timeout, exactly one retry via `FetcherSession(impersonate='chrome')`; if fallback also fails → HTTP 503 `{"available": false, "reason": "..."}`
    - Redis cache: key `scraping:chain:{underlying}:{expiry}:{exchange}`, TTL 20s
    - `POST /scraping/option-chain/warm`: warm DynamicSession, confirm XHR capture, return `{"warmed": true, "session_ready": true}` or HTTP 503
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.10, 4.11, 4.12, 4.13_
  - [x] 6.2 Implement analytics pure functions: PCR, max pain, ATM IV, OI walls
    - `compute_pcr_oi(rows)`: `round(total_pe_oi / total_ce_oi, 2)` when `total_ce_oi > 0`; else `None`
    - `compute_pcr_volume(rows)`: same logic for volume
    - `compute_max_pain(rows)`: for each strike S, sum `max(0, S - k) * CE_OI_k + max(0, k - S) * PE_OI_k`; return argmin; tie-break by highest CE OI
    - `compute_atm_iv(rows, spot)`: sort by `|strike - spot|`; collect CE and PE IVs from nearest 5 strikes with OI > 0; return mean rounded to 2 dp; return `None` when < 2 valid contracts
    - `compute_oi_walls(rows)`: `maxCeOiStrike` = argmax CE OI (tie → lowest strike); `maxPeOiStrike` = argmax PE OI (tie → lowest strike)
    - _Requirements: 4.5, 4.6, 4.7, 4.8, 4.9_
  - [x] 6.3 Wire analytics into OptionChain response and validate field compatibility
    - Populate all `OptionChainAnalytics` fields from the pure functions in 6.2
    - `OptionChain` response shape must be identical to TypeScript `OptionChain` type — same field names, same nesting (validated by contract test)
    - Create `data-service/tests/test_option_chain_schema_compat.py`: assert all TypeScript `OptionChain` fields are present in the Python schema
    - _Requirements: 4.14_

- [x] 7. InstrumentMaster (NSE lot sizes + BSE scrip master)
  - [x] 7.1 Implement `data-service/src/scrapers/instrument_master.py`
    - `GET /scraping/instruments`: serve from disk cache at `/app/data/instruments/{exchange}.json` when mtime < 24h; otherwise fetch and rebuild
    - `GET /scraping/instruments?type=FO`: filter to `instrumentType` in `["FUT", "CE", "PE"]`
    - `POST /scraping/instruments/refresh`: bypass cache, re-download, overwrite cache file, return updated JSON array
    - Disk cache write after every successful download
    - _Requirements: 8.1, 8.4, 8.6, 8.7_
  - [x] 7.2 Implement NSE F&O lot size CSV fetch and BSE scrip master ZIP fetch
    - NSE: `GET https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv` via `FetcherSession`; parse CSV; on failure fall back to hardcoded lot sizes: NIFTY=50, BANKNIFTY=15, FINNIFTY=40, MIDCPNIFTY=75, SENSEX=10, BANKEX=15
    - BSE: `GET https://bseindia.com/download/BseIndiaAPI/Equity/EQUITY_{DDMMYYYY}.zip`; unzip; parse contained CSV; on corrupt ZIP or non-200 → return error indicating BSE scrip master unavailability
    - Set `lotSize=0` for symbols absent from both CSV and hardcoded list
    - `Instrument` validation: `token` string, `tradingSymbol` max 50 chars, `name` max 100 chars, `exchange` in {NSE,BSE,NFO,BFO}, `lotSize` ≥ 0, `instrumentType` in {EQ,FUT,CE,PE}, `expiry` ISO date or `""`, `strike` ≥ 0, `optionType` CE|PE|`""`
    - _Requirements: 8.2, 8.3, 8.5_

- [x] 8. TickPublisher (asyncio 5s poll → Redis PUBLISH)
  - [x] 8.1 Implement `data-service/src/publisher/tick_publisher.py`
    - `TickPublisher` asyncio class: poll `LiveQuoteScraper.get_quotes(symbols)` every 5 seconds; for each quote with non-null `ltp`, `PUBLISH af:ticks:{SYMBOL}` JSON-encoded `LiveTick`; skip symbols with null `ltp` (no increment of `publish_count`)
    - `publish_count: int` (cumulative), `last_publish_ms: int | None`, `running: bool | "reconnecting"` state tracking
    - Graceful shutdown: on SIGTERM/SIGINT, complete or discard in-progress poll cycle within 10 seconds, release Redis connection
    - Redis reconnection: exponential backoff 1s → 2s → 4s → … capped at 30s; `running` returns `"reconnecting"` during outage; reset to 1s on reconnection
    - `LiveTick` fields: `token`, `symbol`, `exchange`, `ltp`, `change`, `changePct`, `volume`, `oi`, `exchangeTimestampMs`, `receivedAtMs`, `provider: "scrapling"` — skip tick if any required field missing
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 5.7_
  - [x] 8.2 Implement `data-service/src/publisher/router.py`
    - `GET /publisher/status`: return `{"running": bool|"reconnecting", "symbols": [...], "publish_count": N, "last_publish_ms": N|null}`; must respond within 2 seconds; `symbols` array capped at 500 entries
    - `POST /publisher/symbols`: accept `{"add": [...], "remove": [...]}` JSON body; validate: each symbol max 50 chars, each array max 100 entries; apply add/remove atomically; return updated symbol list + count; respond within 2 seconds
    - Return HTTP 400 with error body when any symbol exceeds 50 chars or array exceeds 100 entries; leave symbol list unchanged
    - _Requirements: 5.4, 5.5, 5.8_

- [x] 9. Monitoring endpoints (RollingWindowStats + /monitoring/* routes)
  - [x] 9.1 Implement `RollingWindowStats` in `data-service/src/monitoring/router.py`
    - `RequestRecord(endpoint, duration_ms, success, recorded_at)` dataclass
    - `RollingWindowStats`: sliding window 3600s; `record(endpoint, duration_ms, success)`; `_evict()` removes records older than window; `get_stats(endpoint)` returns P50, P99 (sorted durations), success_rate (rounded to 4 dp); returns `None` when no records in window
    - In-memory only — all counters reset to zero on service restart
    - _Requirements: 10.2_
  - [x] 9.2 Implement `/monitoring/health`, `/monitoring/scraping-stats`, `/monitoring/proxy-status`, `/monitoring/session-status` routes
    - `GET /monitoring/health`: `request_count`, `ban_count` (from `BanDetector.ban_count`), `cache_hit_rate` (ratio 0.0–1.0, rounded to 4 dp), `uptime_seconds` (non-negative int from service start)
    - `GET /monitoring/scraping-stats`: per-endpoint P50/P99 ms + success_rate for last 3600s; null for endpoints with no requests in window
    - `GET /monitoring/proxy-status`: `pool_size`, `rotation_count`, `active_proxy` (credentials masked as `***`)
    - `GET /monitoring/session-status`: `last_warm_at` (UTC ISO-8601 or null), `session_age_seconds` (non-negative int or null), `next_warm_at` (UTC ISO-8601 or null)
    - When service is initializing, return `{"available": false, "reason": "service not yet ready"}` for all `/monitoring/*` requests
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6, 10.7_

- [x] 10. TypeScript ScraplingProvider + types.ts + registry.ts changes

  - [x] 10.1 Extend `src/lib/market-data/types.ts` — add `"scrapling"` to `ProviderId` and `PROVIDER_PRIORITY`
    - Change `ProviderId` union to: `"scrapling" | "angel_one" | "upstox" | "nse" | "yahoo"`
    - Update `PROVIDER_PRIORITY` array to list `"scrapling"` first
    - `MarketDataError` constructor's `providerId` parameter already accepts `ProviderId | null` — no change needed
    - _Requirements: 7.2_

  - [x] 10.2 Update `src/lib/market-data/health.ts` — add `"scrapling"` to `getAllProviderHealth`
    - In `getAllProviderHealth()`, change `allIds` from `["angel_one", "upstox", "nse", "yahoo"]` to `["scrapling", "angel_one", "upstox", "nse", "yahoo"]`
    - _Requirements: 12.4_

  - [x] 10.3 Create `src/lib/market-data/providers/scrapling.ts` — implement `MarketDataProvider`
    - `BASE_URL = process.env.DATA_SERVICE_URL ?? ""`; `ENABLED = !!process.env.DATA_SERVICE_URL`
    - Shared `dsGet<T>(path, signal?)` helper: `fetch(BASE_URL + path, { signal })`; throws `MarketDataError("data-service ...: HTTP N", "scrapling", code)` on 4xx/5xx where code is `"RATE_LIMIT"` for 429, `"AUTH_FAILURE"` for 401, `"INVALID_RESPONSE"` otherwise
    - `id: "scrapling"`, implement all `MarketDataProvider` interface methods:
      - `getHistoricalCandles(req)`: when `ENABLED`, `GET /scraping/historical?symbol=...&exchange=...&interval=...&from=...&to=...`; return `candles` array; when not enabled, return `[]`
      - `getLatestQuote(symbol)`: when `ENABLED`, call `getQuotes([symbol])` and return first result; when not enabled, return `null`
      - `getQuotes(symbols)`: when `ENABLED`, `GET /scraping/quotes?symbols=...` (comma-joined); return `quotes` array positionally aligned; when not enabled, return `Array(symbols.length).fill(null)`
      - `getOptionChain(underlying, expiry?)`: when `ENABLED`, `GET /scraping/option-chain?underlying=...&expiry=...`; return response directly as `OptionChain`; when NOT enabled, throw `new MarketDataError("ScraplingProvider not configured", "scrapling", "NOT_CONFIGURED")`
      - `getInstrumentMaster(filter?)`: when `ENABLED`, `GET /scraping/instruments?exchange=...&type=...`; when not enabled, return `[]`
      - `subscribe(req, onTick, onError)`: poll `getQuotes` every 5s; call `onTick` per non-null result; call `onError` and continue on exception; return teardown function
      - `unsubscribe(tokens)`: no-op (Redis pub/sub is the primary delivery path)
      - `getProviderHealth()`: return `getProviderHealth("scrapling")` from `health.ts`
    - _Requirements: 7.1, 7.3, 7.4, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12_

  - [x] 10.4 Register `ScraplingProvider` in `bootstrapRegistry()` in `src/lib/market-data/registry.ts`
    - Import `ScraplingProvider` from `./providers/scrapling`
    - Register at `priority: 0`, `enabled: !!process.env.DATA_SERVICE_URL`
    - Capabilities: `{ historicalCandles: true, liveQuotes: true, webSocket: false, optionChain: true, instrumentMaster: true, intradayCandles: true, fno: true }`
    - Place the `registry.register({ provider: new ScraplingProvider(), ... })` call first in `bootstrapRegistry()`, before Angel One
    - _Requirements: 7.5_

- [x] 11. Worker TickListener + redis.ts subscriber + config.ts update

  - [x] 11.1 Add `createSubscriberClient()` to `worker/src/redis.ts`
    - Export `createSubscriberClient(): Redis` that creates a new `ioredis` `Redis` instance with `maxRetriesPerRequest: null` and `enableReadyCheck: false` (required for subscriber mode)
    - Throws if `REDIS_URL` is not set
    - _Requirements: 6.4_

  - [x] 11.2 Add `scrapingTicks` config to `worker/src/config.ts`
    - Add to `workerConfig`: `scrapingTicks: { enabled: Boolean(process.env.DATA_SERVICE_URL || process.env.SCRAPING_TICK_LISTEN === "true") }`
    - _Requirements: 6.7_

  - [x] 11.3 Create `worker/src/jobs/scraping-tick-listener.ts`
    - `startScrapingTickListener(onTick: (tick: LiveTick) => void): void`: check `workerConfig.scrapingTicks.enabled`; if false, return without starting; create dedicated subscriber via `createSubscriberClient()`; `psubscribe("af:ticks:*")` 
    - On `pmessage`: parse JSON; call `onTick(parsed)`; on JSON parse error: `log.warn` with channel + raw message, continue
    - On unrecoverable connection error: `log.error`, set internal state to stopped
    - `stopScrapingTickListener(): void`: `punsubscribe("af:ticks:*")`, disconnect subscriber, no-op if never started
    - Export both functions as named exports
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.8_

- [x] 12. ML training pipeline upgrade
  - [x] 12.1 Add `ScraplingDataClient` and Tier 0 to `ml-service/src/training/market_data_client.py`
    - Add `ScraplingDataClient` class with `fetch_ohlcv(symbol, start_date, end_date, interval="1d")` method: `GET {DATA_SERVICE_URL}/scraping/historical?...`; 10s `httpx` timeout; returns `pd.DataFrame | None`
    - In `MarketDataClient.__init__`, read `DATA_SERVICE_URL = os.getenv("DATA_SERVICE_URL")`; instantiate `ScraplingDataClient` when URL is set
    - In `MarketDataClient.get_ohlcv()`, prepend **Tier 0** block before existing Tier 1:
      - If `DATA_SERVICE_URL` is set: call `ScraplingDataClient.fetch_ohlcv()`
      - On HTTP 200 with non-empty candles: tag `_quality = DataQuality.GOOD`, `_source = "scrapling_bhavcopy"`, return
      - On HTTP 200 with empty candles: proceed to Tier 1 silently
      - On HTTP 503/500 or connection error within 10s: `logger.warning("scrapling_fetch_failed", ...)`, proceed to Tier 1
      - When `DATA_SERVICE_URL` unset: skip entirely, begin at Tier 1 (no behavior change)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - [x] 12.2 Update `docker-compose.yml` `ml-service` entry for data-service dependency
    - Add `DATA_SERVICE_URL: "http://data-service:8200"` to `ml-service.environment`
    - Add `data-service: condition: service_started` to `ml-service.depends_on`
    - _Requirements: 11.6_

- [x] 13. DataSourceBadge React component + /api/in/provider-health route
  - [x] 13.1 Create `src/app/api/in/provider-health/route.ts` — Next.js API route
    - `GET /api/in/provider-health`: call `registry.getHealth()` for all 5 providers; concurrently fetch `GET {DATA_SERVICE_URL}/monitoring/health` with a short timeout
    - Aggregate into a single JSON object keyed by provider id; each entry: `{ available: boolean, latency_ms: number }`
    - If `data-service` is unreachable: `scrapling: { available: false, latency_ms: 0 }` — always return HTTP 200, never 4xx/5xx
    - _Requirements: 12.4, 12.5_
  - [x] 13.2 Create `src/components/india/DataSourceBadge.tsx`
    - Pill-shaped component; polls `GET /api/in/provider-health` 30 seconds **after** previous response (not on a fixed interval timer); cancel in-flight request via `AbortController` on unmount
    - Render nothing until a valid provider name is received; render nothing when provider string is unknown
    - Display format: `"{TitleCase(provider)} ● {latency_ms}ms"` — title-case converts underscores to spaces and capitalises each word; `latency_ms` is a non-negative integer
    - Background color: `var(--color-data-positive)` for `scrapling`/`angel_one`; `var(--color-data-neutral)` for `upstox`/`nse`; `var(--color-data-negative)` for `yahoo`
    - Place in option chain page header, visible without scrolling at viewport ≥ 1280px
    - _Requirements: 12.1, 12.2, 12.3, 12.6, 12.7, 12.8_

- [x] 14. Property-based tests (hypothesis) — all 17 correctness properties
  - [x] 14.1 Create `data-service/tests/pbt/test_conversion_properties.py`
    - **Property 3: IST-to-UTC timestamp conversion round-trip** — `@given(ts_ms=st.integers(min_value=0, max_value=10**15))` — assert `abs(((ts_ms / 1000) - 19800 + 19800) * 1000 - ts_ms) < 1e-9`
    - **Property 4: OHLCVCandle price invariants** — `@given(open_, high_delta, low_delta, close_, volume)` — construct candle with `high = max(open, close) + high_delta`, `low = min(open, close) - low_delta`; assert all six invariants hold; `assume(low > 0)`
    - _Requirements: 2.6, 2.7_
  - [x] 14.2 Create `data-service/tests/pbt/test_analytics_properties.py`
    - **Property 7: PCR ratio computation** — `@given(ce_oi=st.integers(min_value=0, ...), pe_oi=st.integers(min_value=0, ...))` — assert `compute_pcr_oi_from_totals(ce_oi, pe_oi) == round(pe_oi/ce_oi, 2)` when `ce_oi > 0`; `None` when `ce_oi == 0`; same for PCR volume
    - **Property 8: Max pain minimises ITM option value** — `@given(strikes_and_oi=st.lists(st.tuples(...), min_size=1, max_size=50))` — assert `pain(max_pain_strike) <= pain(s)` for all other strikes
    - **Property 9: ATM IV is average of 5 nearest-to-spot IVs** — `@given(rows, spot)` — collect CE+PE IVs from 5 nearest strikes with OI > 0; assert `atmIv == round(mean(ivs), 2)` when ≥ 2 valid; `None` otherwise
    - **Property 10: OI wall strikes are correct argmax** — `@given(rows)` — assert `maxCeOiStrike` has the maximum CE OI; tie-break → lowest strike; same for PE
    - _Requirements: 4.5, 4.6, 4.7, 4.8, 4.9_
  - [x] 14.3 Create `data-service/tests/pbt/test_rate_limiter_properties.py`
    - **Property 14: Token bucket rate limit is never exceeded** — inject mock time; send N requests at rate R; assert count in any 1s window ≤ `ceil(R) + 1` (floating-point tolerance)
    - **Property 15: FIFO queue preserves request arrival order** — queue multiple requests simultaneously; assert completion timestamps are non-decreasing (arrival order preserved)
    - _Requirements: 9.1, 9.2_
  - [x] 14.4 Create property tests for server-level and integration properties
    - **Property 1: CORS origin rejection** — `@given(origin=st.text())` — filter to origins that are neither `http://localhost:3000` nor `http://127.0.0.1:3000`; assert response status is 403 and no `Access-Control-Allow-Origin` header; use FastAPI `TestClient`
    - **Property 2: Historical response structural invariants** — `@given(candles_data)` — assert `count == len(candles)` and `candles` sorted strictly ascending by `time`
    - **Property 5: Quotes array positional alignment** — `@given(symbols=st.lists(st.text(), min_size=1, max_size=200))` — assert `len(quotes) == len(symbols)` and each non-null entry's `symbol` matches corresponding input (case-insensitive)
    - **Property 6: MDQuote normalization completeness** — `@given(raw_nse_payload=st.fixed_dictionaries({...}))` — assert all 14 required fields present and typed correctly regardless of which fields raw payload omits
    - **Property 11: Tick publication channel, shape, null-LTP skip** — `@given(quotes)` — assert publish called exactly once per non-null ltp to `af:ticks:{SYMBOL}`; assert no publish for null ltp
    - **Property 12: Exponential backoff sequence** — `@given(n_failures=st.integers(min_value=1, max_value=10))` — assert wait intervals follow `min(2^(n-1), 30)` sequence
    - **Property 16: Ban detection pattern matching** — `@given(body)` — assert all three trigger conditions return `True`; any other body → `False`
    - _Requirements: 1.3, 2.1, 3.1, 3.4, 5.3, 5.7, 9.4, 9.5, 9.6_
  - [x] 14.5 Create `tests/components/india/DataSourceBadge.pbt.test.tsx` — Property 17
    - **Property 17: DataSourceBadge display format** — parameterised Vitest test covering all 5 known providers and a corpus of non-negative integer latencies; assert rendered text matches `"{TitleCase(provider)} ● {latency_ms}ms"` for known providers; assert null render for unknown strings
    - _Requirements: 12.1, 12.7_
  - [x] 14.6 Create `tests/worker/scraping-tick-listener.pbt.test.ts` — Property 13
    - **Property 13: Tick listener forwards every valid message** — use `fast-check` (or hand-rolled Vitest parameterisation); for any JSON-parseable message on `af:ticks:{symbol}`, assert `onTick` called exactly once with parsed object; assert `tick.symbol` equals channel suffix
    - _Requirements: 6.2_

- [x] 15. Unit tests (pytest + Vitest) — all components
  - [x] 15.1 Create `data-service/tests/conftest.py` and `data-service/tests/test_server.py`
    - `conftest.py`: shared fixtures — `settings_fixture`, `mock_redis`, `mock_dynamic_session`, `mock_fetcher_session`, `test_client` (FastAPI `TestClient`)
    - `test_server.py`: `GET /health` returns 200 + correct JSON shape; `GET /scraping/status` returns capability flags; CORS allows `localhost:3000`; CORS blocks other origins (HTTP 403); degraded mode sets `status: "degraded"` with `components`
    - _Requirements: 1.1, 1.2, 1.3, 1.7_
  - [x] 15.2 Create `data-service/tests/scrapers/test_historical.py`
    - Mock `FetcherSession.get()` with fixture NSE CSV and BSE ZIP; assert correct OHLCV field mapping for both exchanges
    - Assert disk cache prevents second HTTP call (mtime < 24h)
    - Assert IST→UTC conversion for intraday timestamps (spot-check: 1_630_000_000_000 ms IST → 1_629_980_200 UTC s)
    - Assert HTTP 400 on missing param, invalid exchange, invalid interval, invalid date, `from > to`, range exceeded
    - Assert HTTP 200 `{"candles": [], "count": 0}` when symbol not found
    - Assert HTTP 503 on upstream timeout
    - _Requirements: 2.1–2.13_
  - [x] 15.3 Create `data-service/tests/scrapers/test_live_quotes.py`
    - Mock `DynamicSession.fetch()` with fixture XHR JSON (NIFTY 200 batch + single symbol)
    - Assert correct `MDQuote` field mapping; assert `ltp: null` on missing XHR field (not error)
    - Assert Redis cache write with TTL 5s; assert cached value returned on second call within TTL
    - Assert HTTP 400 for missing / empty / >200 symbols
    - Assert HTTP 503 on 10s DynamicSession timeout; existing cache NOT overwritten
    - Assert merged results in original input order for mixed batch
    - _Requirements: 3.1–3.10_
  - [x] 15.4 Create `data-service/tests/scrapers/test_option_chain.py`
    - Mock `DynamicSession.fetch()` with NSE option chain XHR fixture; assert full `OptionChain` shape
    - Assert all analytics fields: `pcrOi`, `maxPain`, `atmIv`, `maxCeOiStrike`, `maxPeOiStrike`, `pcrVolume` computed correctly vs hand-calculated fixture values
    - Assert fallback to `FetcherSession` on `BrowserError`; assert HTTP 503 when fallback also fails
    - Assert Redis cache write TTL 20s; assert cached value returned on second call within TTL
    - Assert warm endpoint returns `{"warmed": true, "session_ready": true}`
    - _Requirements: 4.1–4.14_
  - [x] 15.5 Create `data-service/tests/scrapers/test_instrument_master.py`
    - Fixture CSV with 10 rows; assert NIFTY=50, BANKNIFTY=15 from hardcoded fallback
    - Assert hardcoded fallback used when CSV download returns non-200
    - Assert type=FO filter returns only FUT/CE/PE instruments
    - Assert disk cache prevents re-download within 24h; assert `POST /refresh` bypasses cache
    - _Requirements: 8.1–8.7_
  - [x] 15.6 Create `data-service/tests/publisher/test_tick_publisher.py`
    - Mock `aioredis`; assert `PUBLISH` called with channel `af:ticks:NIFTY` and valid JSON `LiveTick`
    - Assert null `ltp` skips publish; assert `publish_count` NOT incremented for skipped symbols
    - Assert exponential backoff intervals on Redis reconnection: 1s, 2s, 4s, 8s, 16s, 30s, 30s
    - Assert `POST /publisher/symbols` with valid add/remove applies changes atomically
    - Assert HTTP 400 when symbol >50 chars or array >100 entries; symbol list unchanged
    - _Requirements: 5.1–5.8_
  - [x] 15.7 Create `data-service/tests/anti_ban/test_ban_detector.py` and `data-service/tests/anti_ban/test_rate_limiter.py`
    - `test_ban_detector.py`: assert shadow-ban pattern triggers during mocked market hours; Akamai pattern on `window._atsb`; rate-limit on `"Too Many Requests"`; non-matching body → `False`; assert `ban_count` increments
    - `test_rate_limiter.py`: assert requests beyond rate limit are queued in FIFO order; assert `QueueFullError` raised at depth 1000; assert requests are served in arrival order
    - _Requirements: 9.1–9.6_
  - [x] 15.8 Create `data-service/tests/monitoring/test_health_route.py`
    - Assert `GET /monitoring/health` returns `ban_count` that increments after each `BanDetector` event
    - Assert `uptime_seconds` is non-negative integer; `cache_hit_rate` in [0.0, 1.0] rounded to 4 dp
    - Assert `GET /monitoring/scraping-stats` returns null fields for endpoints with no requests
    - Assert service-initializing state returns unavailable response on all `/monitoring/*` endpoints
    - _Requirements: 10.1–10.7_
  - [x] 15.9 Create `tests/lib/market-data/providers/scrapling.test.ts`
    - Mock `fetch` globally; assert `getHistoricalCandles` constructs correct URL with all query params
    - Assert `getOptionChain` throws `MarketDataError` on HTTP 503; `withFailover` moves to next provider
    - Assert `getQuotes` returns `Array(N).fill(null)` when `DATA_SERVICE_URL` is unset
    - Assert `getInstrumentMaster` returns `[]` when `DATA_SERVICE_URL` is unset
    - Assert `getOptionChain` throws `NOT_CONFIGURED` when `DATA_SERVICE_URL` is unset
    - Assert `subscribe` calls `onError` and continues polling when `getQuotes` throws
    - Assert ScraplingProvider registered at priority 0 when `DATA_SERVICE_URL` is set
    - Assert ScraplingProvider not in registry when `DATA_SERVICE_URL` is absent
    - _Requirements: 7.1–7.12_
  - [x] 15.10 Create `tests/worker/scraping-tick-listener.test.ts`
    - Mock `ioredis`; assert `onTick` called with parsed `LiveTick` on valid `pmessage`
    - Assert `log.warn` called with channel + raw content on JSON parse failure; listener continues
    - Assert `stopScrapingTickListener` is safe to call when listener never started
    - Assert listener does not start when `scrapingTicks.enabled` is false
    - _Requirements: 6.1–6.8_
  - [x] 15.11 Create `tests/components/india/DataSourceBadge.test.tsx`
    - Mock `fetch`; assert renders `"Scrapling ● 180ms"` with `var(--color-data-positive)` when provider is `scrapling`
    - Assert renders `"Angel One ● 45ms"` with positive color for `angel_one`
    - Assert renders nothing when provider is unknown string
    - Assert renders nothing while `/api/in/provider-health` fetch is in-flight
    - Assert `AbortController.abort()` called on unmount (no state update after unmount)
    - Assert polls exactly 30s after previous response resolves, not on a fixed interval
    - _Requirements: 12.1–12.8_

- [x] 16. Final checkpoint — ensure all tests pass
  - Run `pytest data-service/tests/ -m "not integration"` and verify all Python unit + PBT tests pass
  - Run Vitest for TypeScript tests and verify ScraplingProvider, TickListener, and DataSourceBadge tests pass
  - Run `docker compose build data-service` and verify `GET /health` returns 200 within 90s
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Sub-tasks marked with `*` are optional and can be skipped for a faster MVP
- Property-based tests (Tasks 14) and unit tests (Task 15) are authored as sub-tasks; they are not standalone top-level tasks
- All 17 correctness properties from the design document are covered: P1–P17
- `ScraplingProvider` is opt-in via `DATA_SERVICE_URL` env var; when unset the existing failover chain is completely unchanged
- The `withFailover` engine, existing provider adapters, and all API call sites require zero changes
- Integration tests (live NSE/BSE scraping) are excluded from CI; tag with `@pytest.mark.integration` and skip via `pytest -m "not integration"`
- All internal Python exceptions are caught and converted to HTTP 503; no endpoint ever returns HTTP 500
- The `OptionChain` response shape from Python is structurally identical to the TypeScript `OptionChain` type — enforced by `test_option_chain_schema_compat.py`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.1", "2.2"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3", "10.1", "10.2"] },
    { "id": 3, "tasks": ["3.4", "4.1", "7.1", "11.1", "11.2"] },
    { "id": 4, "tasks": ["4.2", "4.3", "5.1", "7.2", "11.3", "15.9", "15.10"] },
    { "id": 5, "tasks": ["5.2", "6.1", "8.1", "9.1", "10.3"] },
    { "id": 6, "tasks": ["6.2", "8.2", "9.2", "10.4", "12.1"] },
    { "id": 7, "tasks": ["6.3", "12.2", "13.1", "14.3"] },
    { "id": 8, "tasks": ["13.2", "14.1", "14.2", "14.4", "15.1", "15.2", "15.3", "15.4", "15.5", "15.6", "15.7", "15.8"] },
    { "id": 9, "tasks": ["14.5", "14.6", "15.11"] }
  ]
}
```
