# Requirements Document

## Introduction

AlphaForge's Indian market data pipeline currently depends on credentialed broker APIs (Angel One SmartAPI at Priority 1, Upstox at Priority 2) and a fragile hand-rolled NSE scraper at Priority 3. A single TOTP expiry or Akamai shadow-ban silently degrades the most critical data paths.

This feature introduces a dedicated Python microservice (`data-service`) powered by [Scrapling](https://github.com/D4Vinci/Scrapling) — an adaptive web-scraping framework with full TLS fingerprint spoofing, headless Chromium automation, and a `capture_xhr` capability that intercepts the same JSON payloads NSE and BSE deliver to their own websites. The microservice requires no broker credentials and becomes **Priority 0** in the `ProviderRegistry`, demoting Angel One to Priority 1 (first fallback). A companion TypeScript `ScraplingProvider`, a worker Redis pub/sub tick listener, ML training pipeline upgrade, and a provider health UI badge complete the integration.

## Glossary

- **Data_Service**: The Python FastAPI microservice running on port 8200 that scrapes NSE/BSE data using Scrapling.
- **ScraplingProvider**: The TypeScript `MarketDataProvider` implementation that wraps Data_Service REST calls and is registered at priority 0 in the `ProviderRegistry`.
- **ProviderRegistry**: The existing TypeScript singleton (`src/lib/market-data/registry.ts`) that maintains the ordered list of providers and routes market data calls through `withFailover`.
- **Tick_Publisher**: The background asyncio loop within Data_Service that polls live quotes every 5 seconds and publishes `LiveTick` JSON to Redis channels (`af:ticks:{symbol}`).
- **Tick_Listener**: The TypeScript worker job (`worker/src/jobs/scraping-tick-listener.ts`) that subscribes to `af:ticks:*` Redis pub/sub channels and forwards ticks to `LiveFeedService.onTick()`.
- **BhavcopyScraper**: The Data_Service component that downloads and parses NSE/BSE official end-of-day archive (Bhavcopy) CSV/ZIP files for historical daily OHLCV.
- **LiveQuoteScraper**: The Data_Service component that uses `capture_xhr` with a headless Chromium `DynamicSession` to intercept the NSE live-quotes XHR and return normalised `MDQuote` objects.
- **OptionChainScraper**: The Data_Service component that uses `capture_xhr` to intercept the NSE and BSE option chain XHR responses.
- **InstrumentMaster**: The Data_Service component that downloads NSE F&O lot size CSVs and BSE scrip master ZIPs to provide `symbol → lot_size` and `symbol → exchange_code` mappings.
- **AntibanLayer**: The collection of Data_Service modules (proxy manager, rate limiter, ban detector, session warmer) that protect the scraping session from Akamai Bot Manager detection and shadow-bans.
- **DataSourceBadge**: The React UI component that displays the currently-active market data provider and its latency in the AlphaForge dashboard.
- **DynamicSession**: A Scrapling headless Chromium browser session that executes full JavaScript, solves Akamai challenges, and intercepts XHR responses via `capture_xhr`.
- **FetcherSession**: A Scrapling HTTP-only session that impersonates Chrome TLS fingerprints without launching a full browser, used for unauthenticated archive endpoints.
- **Bhavcopy**: NSE/BSE official end-of-day settlement CSV files — the authoritative daily OHLCV record used by SEBI, clearing corporations, and all brokers.
- **capture_xhr**: Scrapling's mechanism for intercepting XHR network requests made by a page loaded inside a `DynamicSession`, returning the raw JSON API response.
- **MDQuote**: The canonical TypeScript quote type (`src/lib/market-data/types.ts`) that all providers must produce.
- **OHLCVCandle**: The canonical TypeScript OHLCV candle type with UTC epoch seconds timestamp.
- **OptionChain**: The canonical TypeScript option chain type including `rows`, `analytics`, `expiries`, and `spot`.
- **LiveTick**: The canonical TypeScript live tick type consumed by `LiveFeedService.onTick()`.
- **DataQuality**: The ML training pipeline enum (`GOOD`, `STALE`, `INVALID`, `SUSPICIOUS`) used to tag records by provenance quality.
- **IST**: Indian Standard Time, UTC+5:30, the timezone used by NSE/BSE for all timestamps.
- **ProviderId**: The TypeScript union type identifying each market data provider; must be extended to include `"scrapling"`.
- **MarketDataClient**: The ML service's unified Python data-fetching client (`ml-service/src/training/market_data_client.py`) with a tiered priority chain.

---

## Requirements

### Requirement 1: Data Service Scaffold and Docker Integration

**User Story:** As an AlphaForge operator, I want a self-contained Python microservice that starts alongside the existing stack, so that I can add Scrapling-based data collection without modifying or risking the existing services.

#### Acceptance Criteria

1. THE Data_Service SHALL expose a `GET /health` endpoint that returns HTTP 200 with a JSON body containing a `status` field with value `"healthy"` or `"degraded"`, a `service` field with the service name string, a `version` field with a semantic version string, and a `timestamp` field with an ISO 8601 UTC datetime string.
2. THE Data_Service SHALL expose a `GET /scraping/status` endpoint that returns HTTP 200 with a JSON body containing a boolean flag for each scraping capability (Chromium availability, Redis connectivity, proxy availability) and a configuration summary listing the active symbol count, rate limit value, and data directory path.
3. WHEN Data_Service starts, THE Data_Service SHALL apply CORS middleware allowing origins `http://localhost:3000` and `http://127.0.0.1:3000`, permitting HTTP methods GET and POST, and rejecting requests from all other origins with HTTP 403.
4. THE Data_Service SHALL read all runtime parameters exclusively from environment variables, defaulting to: port `8200`, Redis URL `redis://redis:6379/0`, proxy disabled, rate limit `10` requests per second, symbol list empty, and data directory `/app/data`; and THE Data_Service SHALL log the resolved value of each parameter at startup.
5. THE Data_Service SHALL be added to `docker-compose.yml` with a 2 GB memory limit, a `/app/data` named volume mount for Bhavcopy disk cache, and a `depends_on` condition of `service_healthy` on the `redis` service.
6. WHEN the Data_Service container starts for the first time, THE Data_Service SHALL complete startup and return HTTP 200 on `GET /health` within 90 seconds, with Chromium installed during the Docker image build step and not at container runtime.
7. IF Data_Service fails to start any scraping component, THEN THE Data_Service SHALL return HTTP 200 on `GET /health` with `status` set to `"degraded"` and a `components` object identifying each failed component by name with a non-empty failure reason string, so that Docker healthchecks pass and other services are not blocked from starting.

---

### Requirement 2: Historical OHLCV Scraper (NSE + BSE)

**User Story:** As a strategy developer, I want to retrieve 5 years of daily OHLCV and up to 1 year of 5-minute intraday candles for any NSE or BSE equity or index, so that I can backtest strategies and train ML models on exchange-official data without broker credentials.

#### Acceptance Criteria

1. WHEN a request is made to `GET /scraping/historical` with valid `symbol`, `exchange`, `interval`, `from`, and `to` parameters, THE BhavcopyScraper SHALL return a JSON response containing a `candles` array of `OHLCVCandle` objects sorted ascending by timestamp and a `count` integer equal to the length of the `candles` array.
2. WHEN `interval` is `1d` and `exchange` is `NSE`, THE BhavcopyScraper SHALL fetch data from the NSE historical download endpoint (`nseindia.com/api/historicalOR?...&csvFlag=1`) using `FetcherSession`.
3. WHEN `interval` is `1d` and `exchange` is `BSE`, THE BhavcopyScraper SHALL fetch data from BSE Bhavcopy ZIP archives (`bseindia.com/download/BhavCopy/Equity/EQ{DDMMYYYY}_CSV.ZIP`).
4. WHEN `interval` is `5m`, `15m`, `30m`, or `1h` and `exchange` is `NSE`, THE BhavcopyScraper SHALL fetch data from the NSE charting API (`charting.nseindia.com/charts/getData`).
5. WHEN `interval` is `5m`, `15m`, `30m`, or `1h` and `exchange` is `BSE`, THE BhavcopyScraper SHALL fetch data from the BSE intraday API (`api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w`).
6. THE BhavcopyScraper SHALL convert all intraday timestamps from IST milliseconds to UTC epoch seconds by dividing by 1000 (ms → s) then subtracting 19800 (the IST offset of 5.5 hours in seconds).
7. THE BhavcopyScraper SHALL return `OHLCVCandle` objects where `open`, `high`, `low`, and `close` are positive floating-point values in INR satisfying: `high >= max(open, close)`, `low <= min(open, close)`, and all values in the range (0.00, 999,999,999.99]; `volume` is a non-negative integer.
8. WHEN a Bhavcopy file for a given date exists on disk and its last-modified timestamp is less than 24 hours before the current request time, THE BhavcopyScraper SHALL serve it from disk cache without making an HTTP request.
9. WHEN an intraday response has been fetched and stored in Redis with the key `scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}`, THE BhavcopyScraper SHALL serve it from Redis cache if the entry age is less than 3600 seconds at the time of the request.
10. WHEN the requested date range contains no trading days or the symbol is not found, THE BhavcopyScraper SHALL return HTTP 200 with `candles: []` and `count: 0`.
11. IF the upstream NSE or BSE endpoint returns an error, malformed response, or does not respond within 30 seconds, THEN THE BhavcopyScraper SHALL return HTTP 503 with `{"available": false, "reason": "<message>", "provider": "scrapling"}` without retrying.
12. IF any of `symbol`, `exchange`, `interval`, `from`, or `to` parameters are missing, if `exchange` is not one of `NSE` or `BSE`, if `interval` is not one of `1d`, `5m`, `15m`, `30m`, or `1h`, if `from` or `to` are not valid ISO 8601 dates, or if `from` is later than `to`, THEN THE BhavcopyScraper SHALL return HTTP 400 with a JSON body containing an `error` field describing the validation failure.
13. IF `interval` is `1d` and the date range spans more than 5 years (1825 days), or `interval` is `5m`, `15m`, `30m`, or `1h` and the date range spans more than 1 year (365 days), THEN THE BhavcopyScraper SHALL return HTTP 400 with an `error` field stating the maximum allowed range.

---

### Requirement 3: Live Quote Scraper

**User Story:** As a trader, I want to retrieve real-time quotes for up to 200 NSE F&O stocks in a single request, so that the AlphaForge dashboard reflects live prices without any broker API credentials.

#### Acceptance Criteria

1. WHEN a request is made to `GET /scraping/quotes` with a `symbols` query parameter containing a comma-separated list of between 1 and 200 NSE symbols, THE LiveQuoteScraper SHALL return an HTTP 200 response with a JSON body containing a `quotes` array where each entry corresponds to its input symbol in the same positional order.
2. WHEN the `symbols` query parameter contains more than 1 symbol and every symbol in the list is a NIFTY 200 constituent, THE LiveQuoteScraper SHALL fetch all quotes in a single `capture_xhr` call intercepting `api/equity-stockIndices?index=NIFTY%20200` and return only the entries matching the requested symbols.
3. WHEN the `symbols` query parameter contains exactly 1 symbol, THE LiveQuoteScraper SHALL fetch the quote via a single `capture_xhr` call intercepting `api/quote/equity?symbol={symbol}`.
4. THE LiveQuoteScraper SHALL normalise each quote entry to the `MDQuote` shape containing exactly the fields: `symbol` (string), `ltp` (number or null), `change` (number or null), `changePct` (number or null), `open` (number or null), `high` (number or null), `low` (number or null), `prevClose` (number or null), `volume` (integer or null), `oi` (integer or null), `upperCircuit` (number or null), `lowerCircuit` (number or null), `provider` (string, value `"scrapling"`), and `fetchedAt` (UTC ISO-8601 timestamp string).
5. WHEN a Redis cache entry exists with key `scraping:quote:{exchange}:{symbol}` and the entry's age is less than 5 seconds at the time of the request, THE LiveQuoteScraper SHALL return the cached `MDQuote` value for that symbol without issuing a new `capture_xhr` call.
6. WHEN a quote response from the upstream endpoint contains a null or absent `ltp` field, THE LiveQuoteScraper SHALL include that symbol's entry in the `quotes` array with `ltp` set to `null` and all other available fields populated.
7. IF the `DynamicSession` does not capture the expected XHR response within 10 seconds of initiating the request, THEN THE LiveQuoteScraper SHALL return HTTP 503 with a JSON body `{"available": false, "reason": "<message>"}` where `<message>` describes the timeout condition, and SHALL not modify any existing cache entries for the requested symbols.
8. THE LiveQuoteScraper SHALL reuse the single singleton `DynamicSession` instance across all concurrent and sequential quote requests, and SHALL NOT create a new browser session per call.
9. IF the `symbols` query parameter is absent, empty, or contains more than 200 symbols, THEN THE LiveQuoteScraper SHALL return HTTP 400 with a JSON body containing an `error` field indicating the validation failure, without issuing any `capture_xhr` call.
10. IF the `symbols` list contains one or more symbols that are not NIFTY 200 constituents alongside symbols that are, THEN THE LiveQuoteScraper SHALL fetch the non-constituent symbols individually via `capture_xhr` on `api/quote/equity?symbol={symbol}` and the constituent symbols via the batch endpoint, then merge all results into a single `quotes` array in the original input order.

---

### Requirement 4: Option Chain Scraper (NSE + BSE)

**User Story:** As an options trader, I want to retrieve full option chain data for any NSE index or equity underlying and the BSE SENSEX, so that the AlphaForge options analytics tools (max pain, PCR, GEX) work without broker credentials.

#### Acceptance Criteria

1. WHEN a request is made to `GET /scraping/option-chain` with `underlying` and `exchange=NSE`, THE OptionChainScraper SHALL return a complete `OptionChain` object including `rows`, `analytics`, `expiries`, `spot`, `provider` (`"scrapling"`), and `fetchedAt`.
2. THE OptionChainScraper SHALL intercept NSE option chain data using `capture_xhr` with a `DynamicSession` loading `nseindia.com/option-chain`, capturing the XHR matching `api/option-chain`.
3. WHEN `exchange=BSE` is specified, THE OptionChainScraper SHALL intercept SENSEX option chain data using `capture_xhr` on `bseindia.com/markets/Derivatives/DerivativeHome.aspx`, capturing the XHR matching `GetOptionChain`.
4. WHEN an `expiry` query parameter is omitted, THE OptionChainScraper SHALL default to the nearest available expiry from the `expiries` array (the entry with the earliest date that is >= the current date).
5. THE OptionChainScraper SHALL compute `analytics.pcrOi` as `totalPeOi / totalCeOi` rounded to 2 decimal places; IF `totalCeOi` is 0, THEN `analytics.pcrOi` SHALL be `null`.
6. THE OptionChainScraper SHALL compute `analytics.maxPain` as the strike price that minimises the total value of all in-the-money options at expiry, calculated as: for each candidate strike S, sum (max(0, S - strike) * CE_OI + max(0, strike - S) * PE_OI) across all strikes; the strike minimising this sum is `maxPain`; ties SHALL be resolved by selecting the strike with the highest total CE OI.
7. THE OptionChainScraper SHALL compute `analytics.atmIv` as the simple average of the implied volatility values of the CE and PE contracts for the 5 strikes nearest to `spot` (by absolute distance), excluding any contracts with zero OI; IF fewer than 2 valid contracts exist, `atmIv` SHALL be `null`.
8. THE OptionChainScraper SHALL compute `analytics.pcrVolume` as `totalPeVolume / totalCeVolume` rounded to 2 decimal places; IF `totalCeVolume` is 0, THEN `analytics.pcrVolume` SHALL be `null`.
9. THE OptionChainScraper SHALL populate `analytics.maxCeOiStrike` as the strike with the highest CE open interest and `analytics.maxPeOiStrike` as the strike with the highest PE open interest.
10. THE OptionChainScraper SHALL save element fingerprints on first successful scrape using Scrapling's adaptive tracking (`auto_save=True`) so that minor NSE page redesigns are handled automatically.
11. IF the `DynamicSession` raises a `BrowserError` or fails to capture the XHR within 15 seconds, THEN THE OptionChainScraper SHALL make exactly one retry using `FetcherSession` with `impersonate='chrome'` as a fallback; IF the fallback also fails, THE OptionChainScraper SHALL return HTTP 503 with `{"available": false, "reason": "<message>"}`.
12. WHEN a Redis cache entry exists with key `scraping:chain:{underlying}:{expiry}:{exchange}` and the entry is less than 20 seconds old, THE OptionChainScraper SHALL return the cached value without making a new scraping request.
13. THE OptionChainScraper SHALL expose `POST /scraping/option-chain/warm`; WHEN called, it SHALL load the NSE option chain page using `DynamicSession` and return HTTP 200 with `{"warmed": true, "session_ready": true}` only after a successful XHR capture has been confirmed; IF the warm-up fails, it SHALL return HTTP 503.
14. THE OptionChainScraper SHALL return an `OptionChain` response shape identical to the existing canonical TypeScript `OptionChain` type (same field names, same nesting) so that the ScraplingProvider requires no transformation.

---

### Requirement 5: Live Tick Publisher (Redis Pub/Sub)

**User Story:** As an AlphaForge operator, I want the data-service to publish live price ticks to Redis so that the worker can stream real-time quotes to the UI without any broker WebSocket connection or credentials.

#### Acceptance Criteria

1. THE Tick_Publisher SHALL poll `LiveQuoteScraper` for all configured symbols every 5 seconds and publish each resulting quote as a serialized JSON `LiveTick` message to the Redis channel `af:ticks:{symbol}`, where `{symbol}` is the uppercase symbol string.
2. THE Tick_Publisher SHALL publish `LiveTick` objects containing exactly the fields: `token`, `symbol`, `exchange`, `ltp`, `change`, `changePct`, `volume`, `oi`, `exchangeTimestampMs`, `receivedAtMs`, and `provider` (fixed string value `"scrapling"`), and SHALL skip any tick missing one or more required fields without raising an error.
3. WHEN a quote's `ltp` is null or absent, THE Tick_Publisher SHALL skip publishing for that symbol in that polling cycle, SHALL not raise an error, and SHALL not increment `publish_count` for that symbol.
4. THE Tick_Publisher SHALL expose `GET /publisher/status` returning a JSON object with fields: `running` (boolean), `symbols` (array of strings, maximum 500 entries), `publish_count` (integer, cumulative since service start), and `last_publish_ms` (Unix timestamp in milliseconds of the most recent successful publish, or null if no publish has occurred), and SHALL respond within 2 seconds.
5. THE Tick_Publisher SHALL expose `POST /publisher/symbols` accepting a JSON body with an `add` array and a `remove` array (each containing between 0 and 100 symbol strings per request, each symbol string between 1 and 50 characters), SHALL apply both operations atomically so that the resulting symbol list reflects all additions and removals without a service restart, and SHALL respond with the updated symbol list and a count of current symbols within 2 seconds.
6. THE Tick_Publisher SHALL start automatically when `Data_Service` starts and, upon receiving a shutdown signal, SHALL complete or discard the in-progress polling cycle within 10 seconds and release the Redis connection before the process exits.
7. IF the Redis connection is lost, THEN THE Tick_Publisher SHALL attempt reconnection using exponential backoff starting at 1 second, doubling on each attempt up to a maximum interval of 30 seconds, SHALL resume publishing on the next polling cycle after the connection is restored, and SHALL expose the connection state as `"reconnecting"` in the `GET /publisher/status` `running` field during the outage.
8. IF `POST /publisher/symbols` receives a request where any symbol string exceeds 50 characters or the `add` or `remove` array exceeds 100 entries, THEN THE Tick_Publisher SHALL reject the request with HTTP 400 and an error body indicating which constraint was violated, and SHALL leave the existing symbol list unchanged.

---

### Requirement 6: Worker Redis Tick Listener

**User Story:** As an AlphaForge developer, I want the worker to subscribe to Scrapling tick events and forward them to the existing `LiveFeedService`, so that real-time UI updates work identically whether the tick source is Angel One SmartStream or Scrapling.

#### Acceptance Criteria

1. WHEN the worker process starts AND `DATA_SERVICE_URL` is set in the environment, THE Tick_Listener SHALL establish a dedicated ioredis subscriber connection and issue a `psubscribe` to the Redis pattern `af:ticks:*`.
2. WHEN a message is received on any `af:ticks:*` channel, THE Tick_Listener SHALL parse the JSON payload and call `LiveFeedService.onTick()` with the parsed `LiveTick` object.
3. IF a received message fails JSON parsing, THEN THE Tick_Listener SHALL log a warning that includes the channel name and the raw message content, and SHALL continue processing subsequent messages without crashing.
4. THE Tick_Listener SHALL use a dedicated ioredis connection in subscriber mode (separate from the worker's command connection) so that the worker's normal Redis operations are not blocked.
5. WHEN `DATA_SERVICE_URL` is not set in the environment, THE Tick_Listener SHALL not start and the worker SHALL continue operating normally using existing tick sources.
6. THE Tick_Listener SHALL expose `startScrapingTickListener(onTick: (tick: LiveTick) => void)` and `stopScrapingTickListener()` as named exports from `worker/src/jobs/scraping-tick-listener.ts`, where `stopScrapingTickListener()` SHALL unsubscribe from `af:ticks:*`, disconnect the dedicated subscriber connection, and return without error if the listener was not started.
7. THE worker `config.ts` SHALL expose a `scrapingTicks.enabled` boolean that is `true` if `DATA_SERVICE_URL` is set to a non-empty string OR `SCRAPING_TICK_LISTEN` is set to `"true"`, and `false` otherwise; when both variables are present, either being sufficient makes `enabled` true.
8. IF the dedicated subscriber Redis connection emits an unrecoverable error or is permanently disconnected, THEN THE Tick_Listener SHALL log an error indicating the connection failure and SHALL set its internal state to stopped so that `stopScrapingTickListener()` is safe to call without side effects.

---

### Requirement 7: TypeScript ScraplingProvider

**User Story:** As an AlphaForge developer, I want a TypeScript `MarketDataProvider` that wraps the data-service REST API and registers at Priority 0 in the `ProviderRegistry`, so that all existing market data call sites automatically use Scrapling first with zero code changes.

#### Acceptance Criteria

1. THE ScraplingProvider SHALL implement the `MarketDataProvider` interface from `src/lib/market-data/provider.ts` with `id: "scrapling"`.
2. THE `ProviderId` union type in `src/lib/market-data/types.ts` SHALL be extended to include `"scrapling"` as the first entry, and `PROVIDER_PRIORITY` SHALL list `"scrapling"` first.
3. WHEN `DATA_SERVICE_URL` is not set, THE ScraplingProvider SHALL return `[]` from `getHistoricalCandles`, return an array of `null` values (one per input symbol) from `getQuotes`, return `null` from `getLatestQuote`, and return `[]` from `getInstrumentMaster` — all without throwing.
4. WHEN `DATA_SERVICE_URL` is not set, THE ScraplingProvider SHALL throw a `MarketDataError` with code `NOT_CONFIGURED` from `getOptionChain` so that `withFailover` moves to Angel One.
5. THE ScraplingProvider SHALL be registered in `bootstrapRegistry()` at `priority: 0` and SHALL be enabled only when `DATA_SERVICE_URL` is a non-empty string.
6. WHEN `getHistoricalCandles` is called, THE ScraplingProvider SHALL issue `GET {DATA_SERVICE_URL}/scraping/historical` with query parameters `symbol`, `exchange`, `interval`, `from` (ISO date), and `to` (ISO date), and SHALL return the `candles` array from the response.
7. WHEN `getOptionChain` is called, THE ScraplingProvider SHALL issue `GET {DATA_SERVICE_URL}/scraping/option-chain` with `underlying` and optional `expiry` parameters and return the response directly as an `OptionChain`.
8. WHEN `getQuotes` is called, THE ScraplingProvider SHALL issue `GET {DATA_SERVICE_URL}/scraping/quotes` with a comma-separated `symbols` parameter and SHALL return the `quotes` array where each entry is positionally aligned (index-for-index) with the input symbols array.
9. WHEN `getInstrumentMaster` is called, THE ScraplingProvider SHALL issue `GET {DATA_SERVICE_URL}/scraping/instruments` with optional `exchange` and `type` filter parameters.
10. WHEN `subscribe` is called, THE ScraplingProvider SHALL start polling `getQuotes` at 5-second intervals and call `onTick` with a normalised `LiveTick` for each non-null quote result; primary tick delivery SHALL remain Redis pub/sub via the Tick_Listener.
11. WHILE `subscribe` polling is active, THE ScraplingProvider SHALL call `onError` with the caught exception and continue polling when `getQuotes` throws, rather than terminating the polling loop.
12. WHEN the data-service returns HTTP 4xx or 5xx, THE ScraplingProvider SHALL throw a `MarketDataError` so that `withFailover` progresses to the next provider.

---

### Requirement 8: Instrument Master

**User Story:** As an options trader and backtester, I want accurate lot sizes for all NSE F&O contracts and BSE scrip codes, so that position sizing, GEX calculations, and BSE option chain lookups are correct.

#### Acceptance Criteria

1. WHEN a request is made to `GET /scraping/instruments`, THE InstrumentMaster SHALL return a JSON array of `Instrument` objects where each object contains `token` (string), `tradingSymbol` (string, max 50 characters), `name` (string, max 100 characters), `exchange` (one of: `NSE`, `BSE`, `NFO`, `BFO`), `lotSize` (positive integer), `instrumentType` (one of: `EQ`, `FUT`, `CE`, `PE`), `expiry` (ISO 8601 date string `YYYY-MM-DD` or empty string for equity instruments), `strike` (non-negative number or `0` for non-option instruments), and `optionType` (one of: `CE`, `PE`, or empty string for non-option instruments).
2. THE InstrumentMaster SHALL fetch NSE F&O lot sizes from `nsearchives.nseindia.com/content/fo/fo_mktlots.csv` using `FetcherSession` and parse the resulting CSV; IF the HTTP response status is not 200 or the response body is not valid CSV, THEN THE InstrumentMaster SHALL fall back to hardcoded lot sizes as specified in criterion 5.
3. THE InstrumentMaster SHALL fetch the BSE equity scrip master from `bseindia.com/download/BseIndiaAPI/Equity/EQUITY_{DDMMYYYY}.zip` using `FetcherSession` where `{DDMMYYYY}` is the current date at request time, unzip the archive, and parse the contained CSV; IF the HTTP response status is not 200, the ZIP archive is corrupt, or the contained CSV is malformed, THEN THE InstrumentMaster SHALL return an error response indicating BSE scrip master unavailability.
4. WHEN a disk-cached instrument master file exists at `/app/data/` and its file modification timestamp is less than 24 hours before the request time, THE InstrumentMaster SHALL serve the cached file contents without making any HTTP request.
5. THE InstrumentMaster SHALL maintain hardcoded fallback lot sizes for `NIFTY` (50), `BANKNIFTY` (15), `FINNIFTY` (40), `MIDCPNIFTY` (75), `SENSEX` (10), and `BANKEX` (15); symbols not present in both the CSV and the hardcoded list SHALL have their `lotSize` set to `0`.
6. WHEN a request is made to `POST /scraping/instruments/refresh`, THE InstrumentMaster SHALL bypass the disk cache, re-download instrument data from NSE and BSE sources, overwrite the existing cache file at `/app/data/`, and return the updated JSON array.
7. WHEN a request is made to `GET /scraping/instruments` with query parameter `type=FO`, THE InstrumentMaster SHALL return only instruments where `instrumentType` is `FUT`, `CE`, or `PE`.

---

### Requirement 9: Anti-Ban Hardening

**User Story:** As an AlphaForge operator running in production, I want the data-service to detect and survive Akamai bot challenges and NSE shadow-bans, so that the Scrapling data feed remains reliable for months without manual intervention.

#### Acceptance Criteria

1. THE AntibanLayer SHALL enforce a per-domain token-bucket rate limit: maximum 3 requests per second for `nseindia.com` (configurable via `NSE_RATE_LIMIT` env var, minimum 1, maximum 20) and maximum 2 requests per second for `bseindia.com` (configurable via `BSE_RATE_LIMIT`, minimum 1, maximum 20).
2. WHEN requests arrive faster than the configured rate limit, THE AntibanLayer SHALL queue the excess requests in a FIFO queue with a maximum depth of 1000 requests and serve them in FIFO order once token budget allows.
3. IF the FIFO queue depth reaches 1000 requests, THEN THE AntibanLayer SHALL reject newly arriving requests with an error indicating queue capacity exceeded.
4. THE AntibanLayer SHALL detect an NSE shadow-ban when the response HTTP status is 200, the response body contains `records.data == []`, and the current time is within IST market hours (09:00–16:00 IST), and the symbol is present in the configured known-active symbols list.
5. THE AntibanLayer SHALL detect an Akamai challenge when the response body is a string containing `window._atsb`.
6. THE AntibanLayer SHALL detect a rate-limit block when the response body contains `"Too Many Requests"`.
7. WHEN a ban or Akamai challenge or rate-limit block is detected, THE AntibanLayer SHALL rotate to the next proxy in the pool (if configured), reset the `DynamicSession`, and back off for `BAN_BACKOFF_SECONDS` (minimum 1, maximum 3600, default 60) before retrying the original request.
8. IF the retry after back-off also results in a ban or Akamai challenge or rate-limit block detection, THEN THE AntibanLayer SHALL repeat the back-off and retry cycle up to a maximum of 5 consecutive attempts before propagating an error to the caller.
9. THE AntibanLayer SHALL pre-warm a `DynamicSession` every 30 minutes via a background asyncio task exclusively while the current UTC time falls within 03:30–10:30 UTC (equivalent to IST market hours 09:00–16:00 IST).
10. WHERE `SCRAPLING_PROXY_LIST` is configured, THE AntibanLayer SHALL use Scrapling's `ProxyRotator` for cyclic proxy rotation across all scraping requests.
11. WHERE `SCRAPLING_PROXY_LIST` is not configured, THE AntibanLayer SHALL operate without a proxy and apply all other anti-ban measures unchanged.

---

### Requirement 10: Health Monitoring

**User Story:** As an AlphaForge operator, I want scraping health metrics exposed via REST endpoints so that I can monitor ban events, cache hit rates, and per-endpoint latency without accessing container logs.

#### Acceptance Criteria

1. THE Data_Service SHALL expose `GET /monitoring/health` returning overall service health including `request_count`, `ban_count`, `cache_hit_rate` (as a ratio between 0.0 and 1.0, rounded to 4 decimal places), and `uptime_seconds` (as a non-negative integer measured from service process start time).
2. THE Data_Service SHALL expose `GET /monitoring/scraping-stats` returning per-endpoint P50 and P99 latency in milliseconds (as non-negative integers) and success rate (as a ratio between 0.0 and 1.0, rounded to 4 decimal places) computed over a rolling window of the most recent 3600 seconds of requests, with endpoints that received no requests in that window returning null for all three fields.
3. THE Data_Service SHALL expose `GET /monitoring/proxy-status` returning `pool_size` (as a non-negative integer), `rotation_count` (as a non-negative integer), and `active_proxy` (as a string with credentials replaced by `***`, in the format `scheme://***@host:port`).
4. THE Data_Service SHALL expose `GET /monitoring/session-status` returning `last_warm_at` (as a UTC ISO 8601 timestamp or null if no warm has occurred), `session_age_seconds` (as a non-negative integer measured from `last_warm_at`, or null if no warm has occurred), and `next_warm_at` (as a UTC ISO 8601 timestamp or null if no warm is scheduled).
5. WHEN a ban event is detected, THE AntibanLayer SHALL increment the in-memory ban counter by 1, such that the updated value is reflected in the next response from `GET /monitoring/health`.
6. IF a `GET` request is made to any `/monitoring/*` endpoint while the Data_Service is initializing, THEN THE Data_Service SHALL return a response indicating service unavailability with an error message indicating the service is not yet ready.
7. IF the in-memory stats are reset or the service restarts, THEN THE Data_Service SHALL return zeroed counters for all `/monitoring/*` endpoints, with `uptime_seconds` reset to 0 and `last_warm_at` returned as null.

---

### Requirement 11: ML Training Pipeline Upgrade

**User Story:** As an ML engineer, I want the ML training pipeline to use exchange-official Bhavcopy data from the data-service as its primary source, so that models are trained on the same data that drives live signals, eliminating training/serving skew.

#### Acceptance Criteria

1. THE MarketDataClient SHALL attempt tiers in the sequence Tier 0 (Data_Service `GET /scraping/historical`), Tier 1 (AlphaForge API), Tier 2 (PostgreSQL CandleBar table), Tier 3 (yfinance), proceeding to the next tier only when the current tier returns no data or fails.
2. WHEN the Data_Service `GET /scraping/historical` endpoint returns an HTTP 200 response with a non-empty candles array, THE MarketDataClient SHALL tag all resulting records with `DataQuality.GOOD` and `source="scrapling_bhavcopy"` before returning them to the caller.
3. IF the Data_Service `GET /scraping/historical` endpoint returns HTTP 503, HTTP 500, or raises a connection error within 10 seconds, THEN THE MarketDataClient SHALL log a warning message indicating the Tier 0 failure and the reason, and SHALL proceed to Tier 1 without raising an exception to the caller.
4. IF the Data_Service `GET /scraping/historical` endpoint returns an HTTP 200 response with an empty candles array, THEN THE MarketDataClient SHALL proceed to Tier 1 without logging a warning and without raising an exception to the caller.
5. IF the `DATA_SERVICE_URL` environment variable is not set or is empty, THEN THE MarketDataClient SHALL skip Tier 0 entirely and begin the fetch sequence at Tier 1, preserving all existing tier behavior unchanged.
6. THE `docker-compose.yml` `ml-service` service definition SHALL include `DATA_SERVICE_URL: "http://data-service:8200"` in its `environment` block and SHALL include `data-service` with `condition: service_started` in its `depends_on` block.

---

### Requirement 12: Provider Health Dashboard (DataSourceBadge)

**User Story:** As an AlphaForge user, I want to see which market data provider is currently serving my option chain and quotes, so that I know whether my data is live and exchange-official.

#### Acceptance Criteria

1. THE DataSourceBadge SHALL render a pill-shaped UI element displaying the active provider name and its most recent call latency in milliseconds, where the provider name is displayed in title case and the latency value is formatted as a non-negative integer followed by "ms" (e.g., "Scrapling ● 180ms").
2. THE DataSourceBadge SHALL apply CSS variable `var(--color-data-positive)` as the background colour when the active provider is `scrapling` or `angel_one`, `var(--color-data-neutral)` when the active provider is `upstox` or `nse`, and `var(--color-data-negative)` when the active provider is `yahoo`.
3. WHEN the provider health status is unknown or the `/api/in/provider-health` fetch is in-flight, THE DataSourceBadge SHALL render no DOM element until a response with a known provider name is received.
4. THE Data_Service SHALL expose a `/api/in/provider-health` Next.js route that aggregates `registry.getHealth()` results for all five providers and the Data_Service `/monitoring/health` response into a single JSON object keyed by provider name, each entry containing at minimum `available` (boolean) and `latency_ms` (non-negative integer).
5. IF the Data_Service `/monitoring/health` endpoint is unreachable, THEN THE `/api/in/provider-health` route SHALL return HTTP 200 with a JSON object where the `scrapling` entry contains `available: false` and `latency_ms: 0`, and SHALL NOT return a 4xx or 5xx status code.
6. THE DataSourceBadge SHALL poll `/api/in/provider-health` at an interval of exactly 30 seconds after the previous response is received, and SHALL cancel any in-flight request when the component unmounts to prevent state updates on unmounted components.
7. WHEN the active provider value returned by `/api/in/provider-health` does not match any of the five known provider identifiers, THE DataSourceBadge SHALL render nothing (same behaviour as criterion 3).
8. THE DataSourceBadge SHALL be rendered inside the option chain page header such that it is visible without scrolling when the NSE option chain table is displayed at viewport widths of 1280px and above.
