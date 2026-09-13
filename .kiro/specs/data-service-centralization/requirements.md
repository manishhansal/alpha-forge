# Requirements Document

## Introduction

AlphaForge's market data acquisition is currently fragmented: 13 violation sites across the TypeScript codebase directly call Angel One SmartAPI, Upstox, and Yahoo Finance adapters instead of routing through the canonical `ProviderRegistry`. The `data-service` Python microservice exists as the intended Tier-0 provider but is not yet enforced as the sole external data boundary. Signal generation, ML inference, backtesting, workers, and frontend API routes each maintain their own independent provider coupling — creating duplicate code paths, inconsistent failover behavior, untracked data provenance, and no single point for quality control or observability.

This feature completes the architectural transformation: `data-service` becomes the **single central data platform**. After this refactor, every market data access from every service — ML, signal engine, backtesting, risk engine, workers, dashboard — flows exclusively through `data-service`. No other module may directly import or call any external market-data provider SDK or API. The TypeScript `ProviderRegistry` (wrapping `data-service` via `ScraplingProvider`) and a new Python `DataGateway` client are the only permitted entry points for consumers. All 13 violation sites are eliminated. A canonical import guard enforces the boundary at CI time.

This builds on existing completed work: the `data-service` scaffold, scrapers, tick publisher, instrument master, normalization pipeline, quality scoring, provenance recording, historical backfill, V8 3m removal, and F&O universe system are already in place. This refactor completes the consumer migration layer.

---

## Glossary

- **Data_Service**: The Python FastAPI microservice at port 8200 — the single authoritative source of all market data in AlphaForge.
- **DataGateway**: The canonical TypeScript client SDK (`src/lib/market-data/registry.ts`) that all TypeScript consumers MUST use. The sole permitted interface to `data-service` from TypeScript.
- **ProviderRegistry**: The internal TypeScript singleton that manages the `ScraplingProvider → AngelOneProvider → UpstoxProvider → YahooProvider` failover chain; exposed to consumers only through `DataGateway`.
- **ScraplingProvider**: The TypeScript `MarketDataProvider` at priority 0 that proxies all calls to `data-service` over HTTP REST.
- **Violation_Site**: Any file outside the approved provider boundary that directly imports or calls `@/services/india/angelone`, `@/services/india/upstox`, `@/services/india/yahoo`, `@/services/india/nse`, `yahoo-finance2`, `smartapi-javascript`, or any external broker SDK. Thirteen are documented in `DATA_SERVICE_PRE_REFACTOR_AUDIT.md`.
- **Canonical_Import_Guard**: The ESLint rule set and test suite (`tests/lib/market-data/canonical-import-guard.test.ts`) that fails the CI build if any code outside the approved allowlist imports a forbidden provider module.
- **Approved_Provider_Allowlist**: The explicit set of files permitted to import broker/provider SDKs directly: `src/lib/market-data/providers/angel-one.ts`, `src/lib/market-data/providers/upstox.ts`, `src/lib/market-data/providers/yahoo.ts`, `src/lib/market-data/providers/scrapling.ts`, and their direct dependency files in `src/services/india/angelone/`, `src/services/india/upstox/`, `src/services/india/yahoo/`.
- **Documented_Exception**: A direct broker call that has no generic `MarketDataProvider` equivalent (e.g., `angel.getPutCallRatio()`, `angel.getOiBuildup()`, `angel.getTopGainersLosers()`). These are permitted only in the five documented exception files and must be re-evaluated for migration when a `getBrokerAnalytics()` interface is added.
- **Canonical_Timeframes**: The nine supported timeframes: `1m`, `5m`, `10m`, `15m`, `30m`, `1h`, `1d`, `1w`, `1M`. The value `3m` is permanently removed and must not appear in any code, config, schema, cache key, or API parameter.
- **ProviderId**: The TypeScript union type `"scrapling" | "angel_one" | "upstox" | "yahoo"`. The value `"nse"` is already removed (V3.0). No new provider IDs may be added without extending this spec.
- **DataProvenance**: The metadata object attached to every data response recording `provider`, `authenticated`, `requestedAt`, `dataAsOf`, `isLive`, `freshness`, and `quality`.
- **MARKET_CLOSED**: A named state, not an error. Returned when NSE/BSE is outside trading hours. Must never trigger provider failover.
- **UNSUPPORTED_CAPABILITY**: A named error code, not a provider failure. Must never increment failure counts or trigger circuit breaker penalties.
- **V8_Historical_Fabric**: The existing system of `FnoUniverseSnapshot`, `DataProvenanceRecord`, gap detection, quality scoring, reconciliation, and the `v8-signal-data-gate.service.ts`. This spec builds on top of it.
- **Angel_Broker_Analytics**: SmartAPI-specific endpoints (`/marketData/v1/putCallRatio`, `/marketData/v1/OIBuildup`, `/marketData/v1/gainersLosers`) with no generic `MarketDataProvider` equivalent. These are **Documented_Exceptions** and remain permitted in five files until a `getBrokerAnalytics()` interface is designed.
- **SLO**: Service Level Objective. Measurable performance target: cached quote response < 20ms p95, historical cache hit < 50ms p95, DB range query < 100ms p95.
- **IST**: Indian Standard Time, UTC+5:30. All NSE/BSE market hours use this timezone.

---

## Requirements

### Requirement 1: Canonical Import Boundary Enforcement

**User Story:** As an AlphaForge engineer, I want the build system to block any direct broker SDK import outside the approved provider files, so that no new violation sites can be introduced after the refactor is complete.

#### Acceptance Criteria

1. THE Canonical_Import_Guard SHALL include ESLint rules that exit with a non-zero status from `npm run lint` when any file outside the Approved_Provider_Allowlist (`src/lib/market-data/providers/angel-one.ts`, `src/lib/market-data/providers/upstox.ts`, `src/lib/market-data/providers/yahoo.ts`, `src/lib/market-data/providers/scrapling.ts`, and their direct dependency files in `src/services/india/angelone/`, `src/services/india/upstox/`, `src/services/india/yahoo/`) imports from `@/services/india/yahoo`, `@/services/india/angelone`, `@/services/india/upstox`, `@/services/india/nse`, `yahoo-finance2`, or `smartapi-javascript`.
2. THE Canonical_Import_Guard SHALL include a Vitest test suite in `tests/lib/market-data/canonical-import-guard.test.ts` that fails if any of these 13 known Violation_Sites still contains a forbidden import, each verified individually by file path: `src/services/india/angelone/index.ts` (V-01), `src/services/india/scanner/engine.ts` (V-02), `src/services/india/signals/snapshotter.ts` (V-03), `src/lib/market-data/services/option-strike-capture.service.ts` (V-04), `src/lib/market-data/services/fno-backfill-runner.service.ts` (V-05), `src/features/india/expiry-trades/builder.ts` (V-06), `src/features/india/fno-trend-history/service.ts` (V-07), `src/features/india/scalping/backtest.ts` (V-08), `src/features/india/scalping/strategies/positioning.ts` (V-09), `src/features/india/scalping/strategies/opening-breakout.ts` (V-10), `src/features/india/paper-trading/auto-trader.ts` (V-11), `src/app/api/in/scalper/close-all/route.ts` (V-12), `worker/src/jobs/india-realtime-candles.ts` (V-13).
3. WHEN a developer adds a new file that imports a forbidden module outside the allowlist, THE CI pipeline SHALL fail with an error message that includes both the offending file path and the exact forbidden import path.
4. THE Canonical_Import_Guard test suite SHALL verify that `ProviderId` includes only the values `"yahoo"`, `"angelone"`, and `"upstox"` — and does not include `"nse"`, `"3m"`, or any other value.
5. THE Canonical_Import_Guard test suite SHALL verify that `SUPPORTED_TIMEFRAMES` does not include `"3m"` and does include exactly `["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"]`.
6. WHERE Angel_Broker_Analytics calls exist in these five Documented_Exception files — `src/services/india/scanner/engine.ts`, `src/features/india/expiry-trades/builder.ts`, `src/app/api/in/scanner/`, `src/app/api/in/expiry-trades/`, `src/features/india/scalping/strategies/positioning.ts` — THE Canonical_Import_Guard SHALL allow those specific files and output the line `Documented exceptions: 5 files` to the test report.
7. THE Canonical_Import_Guard SHALL be run as part of `npm run lint` and `npm test` so no PR can be merged with a new violation.

---

### Requirement 2: Violation Site V-01 — Angel One Adapter Internal Yahoo Fallback Removal

**User Story:** As an AlphaForge engineer, I want the Angel One adapter to remove its internal Yahoo Finance fallback, so that provider failover is handled exclusively by the registry's `withFailover()` engine with full health tracking and circuit breaker protection.

#### Acceptance Criteria

1. WHEN `getQuotes()` in `src/services/india/angelone/index.ts` is called and the SmartAPI response is an error (network failure, HTTP non-2xx, or `env.status === false`), THE Angel_One_Adapter SHALL throw a `MarketDataError` with a non-null `code` — one of `AUTH_FAILURE`, `RATE_LIMIT`, `UNAVAILABLE`, `TIMEOUT`, `NETWORK`, or `API_ERROR` — without calling `yahoo.getQuotes()` internally.
2. WHEN `getHistorical()` in `src/services/india/angelone/index.ts` is called and the SmartAPI response is an error (network failure, HTTP non-2xx, or `env.status === false`), THE Angel_One_Adapter SHALL throw a `MarketDataError` with a non-null `code` — one of `AUTH_FAILURE`, `RATE_LIMIT`, `UNAVAILABLE`, `TIMEOUT`, `NETWORK`, or `API_ERROR` — without calling `yahoo.getHistorical()` internally.
3. THE `src/services/india/angelone/index.ts` file SHALL NOT contain any import of `@/services/india/yahoo` after this change.
4. IF an existing test mocks the internal Yahoo fallback path of the Angel One adapter, THEN THE test SHALL be updated so that it verifies a `MarketDataError` is thrown by the adapter and that `ProviderRegistry.withFailover()` — not the adapter — invokes the Yahoo provider as the next provider in the chain.
5. WHEN `ProviderRegistry.withFailover()` executes the Angel One → Upstox → Yahoo failover chain and Angel One throws a `MarketDataError`, THE ProviderRegistry SHALL call `recordFailure()` for the Angel One provider before attempting the next provider, such that the Angel One provider's `consecutiveFailures` count increments by 1 per failed attempt in the chain.

---

### Requirement 3: Violation Site V-02 — Scanner Engine Provider Migration

**User Story:** As an AlphaForge engineer, I want the scanner engine to fetch quotes and candles through the registry, so that scanner data uses the same provider chain, quality scoring, and observability as every other data consumer.

#### Acceptance Criteria

1. THE `src/services/india/scanner/engine.ts` file SHALL replace all `yahoo.getQuotes(FNO_STOCKS)` calls with `registry.getQuotes()` calls.
2. THE `src/services/india/scanner/engine.ts` file SHALL replace all `yahoo.getHistorical()` calls with `registry.getHistoricalCandles()` calls.
3. THE `src/services/india/scanner/engine.ts` file SHALL NOT import `@/services/india/yahoo` (neither static nor dynamic import) after this change.
4. IF `src/services/india/scanner/engine.ts` calls `angel.getPutCallRatio()`, `angel.getOiBuildup()`, or `angel.getTopGainersLosers()`, THEN THE scanner engine SHALL retain those calls as Documented_Exceptions with a comment in the form `// DATA_SERVICE_PRE_REFACTOR_AUDIT.md V-02: Documented_Exception — no MarketDataProvider equivalent`.
5. THE scanner engine tests SHALL pass after the migration with no mocked Yahoo calls remaining in the scanner-specific test files (e.g., `tests/services/india/scanner/`).

---

### Requirement 4: Violation Site V-03 — Signal Snapshotter Provider Migration

**User Story:** As an AlphaForge engineer, I want the signal snapshotter to fetch quotes via the registry, so that snapshot quality metadata and provenance are consistently tracked.

#### Acceptance Criteria

1. THE `src/services/india/signals/snapshotter.ts` file SHALL NOT import `@/services/india/yahoo` (neither static nor dynamic) and SHALL NOT call any method on a Yahoo provider instance directly.
2. WHEN `registry.getQuotes()` is called for a symbol and the result is `null` (no data returned for that slot), THE Signal_Snapshotter SHALL write a snapshot entry for that symbol with a `quality` field of `"PROVIDER_UNAVAILABLE"` rather than omitting the symbol from the output.
3. WHEN `registry.getQuotes()` throws a `MarketDataError` for any reason, THE Signal_Snapshotter SHALL catch the error, log it at `WARN` level, and continue processing remaining symbols rather than aborting the entire snapshot run.
4. THE snapshot cache entry written by Signal_Snapshotter SHALL include the `provider` field from the registry response's `DataProvenance` when available, and `"UNKNOWN"` when provenance is absent.
5. THE signal snapshotter tests SHALL assert that, when the mock registry returns a null result for a symbol, the snapshot entry for that symbol contains `quality: "PROVIDER_UNAVAILABLE"`.

---

### Requirement 5: Violation Site V-04 — Option Strike Capture Service Migration

**User Story:** As an AlphaForge engineer, I want the option strike capture service to fetch option chains via the registry, so that option chain data has full provenance tracking and uses the Tier-0 data-service path.

#### Acceptance Criteria

1. THE `src/lib/market-data/services/option-strike-capture.service.ts` file SHALL call `registry.getOptionChain(underlying, expiry)` as its sole mechanism to fetch option chain data, and SHALL NOT contain a dynamic import of `@/services/india/angelone`.
2. WHEN the registry returns an option chain successfully, THE Option_Strike_Capture_Service SHALL record the `provider` field from `DataProvenance` (of type `ProviderId`) and the `fetchedAt` field (UTC ISO-8601 string from the option chain response) in the capture record.
3. IF `registry.getOptionChain()` throws a `MarketDataError`, THEN THE Option_Strike_Capture_Service SHALL re-throw the error preserving the original `MarketDataError.code` value — it SHALL NOT wrap it in a new generic `Error`.
4. THE option strike capture tests SHALL verify that when the mock registry throws `MarketDataError({ code: "UNAVAILABLE" })`, the service re-throws a `MarketDataError` with `code === "UNAVAILABLE"`.

---

### Requirement 6: Violation Site V-05 — F&O Backfill Runner Provider Migration

**User Story:** As an AlphaForge engineer, I want the F&O backfill runner to fetch historical candles via the registry, so that backfill jobs use the full provider chain with checkpointing and gap recovery.

#### Acceptance Criteria

1. THE `src/lib/market-data/services/fno-backfill-runner.service.ts` file SHALL call `registry.getHistoricalCandles()` as its sole mechanism to fetch historical candles, and SHALL NOT contain a dynamic import of `@/services/india/angelone`.
2. WHEN `registry.getHistoricalCandles()` returns candles, THE FnO_Backfill_Runner SHALL persist them to `CandleBar` using the idempotent upsert on `(instrumentId, exchange, intervalStr, time)`.
3. IF `registry.getHistoricalCandles()` returns an empty array for a symbol-interval pair that has a checkpoint, THEN THE FnO_Backfill_Runner SHALL classify the result as `EMPTY_DATA` (not `PROVIDER_FAILURE`), advance the checkpoint cursor past the current fetch window, and continue to the next symbol.
4. IF persisting a batch of candles to `CandleBar` fails due to a database error, THEN THE FnO_Backfill_Runner SHALL classify the failure as `PROVIDER_FAILURE`, log the error, skip to the next symbol, and preserve the already-written candles from prior batches in the same run without rolling them back.

---

### Requirement 7: Violation Site V-06 — Expiry Trades Builder Provider Migration

**User Story:** As an AlphaForge engineer, I want the expiry trades builder to fetch option chains via the registry, so that Gamma Blast and Hero Zero picks are sourced through the standard data platform.

#### Acceptance Criteria

1. THE `src/features/india/expiry-trades/builder.ts` file SHALL replace `angel.getOptionChain("SENSEX")`, `isAngelConfigured`, and related direct Angel One method calls with `registry.getOptionChain("SENSEX")`, and SHALL NOT import `@/services/india/angelone` directly after this change.
2. WHEN `registry.getOptionChain("SENSEX")` returns data successfully, THE Expiry_Trades_Builder SHALL read the `spot` field for the underlying price, the `analytics.atmIv` field for IV calculations, and the `rows` array for strike-level data — in the same way as the previous direct Angel call.
3. IF `registry.getOptionChain("SENSEX")` throws a `MarketDataError` or returns null, THEN THE Expiry_Trades_Builder SHALL propagate the error or return an empty result set to the caller, without substituting fabricated data.

---

### Requirement 8: Violation Sites V-07 through V-12 — Feature and API Route Provider Migration

**User Story:** As an AlphaForge engineer, I want all remaining Yahoo Finance direct calls in feature files and API routes migrated to the registry, so that the full codebase is violation-free.

#### Acceptance Criteria

1. THE `src/features/india/fno-trend-history/service.ts` file SHALL call `registry.getQuotes()` (with `await bootstrapRegistry()` called first) and SHALL NOT contain any static or dynamic import of `@/services/india/yahoo` after this change.
2. THE `src/features/india/scalping/backtest.ts` file SHALL call `registry.getHistoricalCandles(request)` where `request` is a `HistoricalCandleRequest` object and SHALL NOT contain any static or dynamic import of `@/services/india/yahoo` after this change.
3. THE `src/features/india/scalping/strategies/positioning.ts` file SHALL call `registry.getQuotes()` (with `await bootstrapRegistry()` called first) and SHALL NOT contain any static or dynamic import of `@/services/india/yahoo` after this change.
4. THE `src/features/india/scalping/strategies/opening-breakout.ts` file SHALL call `registry.getHistoricalCandles(request)` where `request` is a `HistoricalCandleRequest` object and SHALL NOT contain any static or dynamic import of `@/services/india/yahoo` after this change.
5. THE `src/features/india/paper-trading/auto-trader.ts` file SHALL call `registry.getQuotes()` for live quote fetching and SHALL NOT contain any static or dynamic import of `@/services/india/yahoo` after this change.
6. THE `src/app/api/in/scalper/close-all/route.ts` file SHALL call `registry.getQuotes()` (with `await bootstrapRegistry()` called first) and SHALL NOT contain any static or dynamic import of `@/services/india/yahoo` after this change.
7. AFTER all six migrations are complete, THE Canonical_Import_Guard test suite assertions AE-002 through AE-008 SHALL all pass, confirming zero remaining `@/services/india/yahoo` imports outside the `YAHOO_IMPORT_ALLOWLIST` and `ALLOWLISTED_BYPASS_FILES` lists defined in `canonical-import-guard.ts`.

---

### Requirement 9: Violation Site V-13 — Worker Realtime-Candles Instrument Token Migration

**User Story:** As an AlphaForge engineer, I want the realtime-candles worker to resolve instrument tokens via the registry's instrument master rather than importing Angel One's ScripMaster directly, so that token resolution uses the same abstraction layer as all other instrument lookups.

#### Acceptance Criteria

1. THE `worker/src/jobs/india-realtime-candles.ts` file SHALL replace imports of `getScripSubsets`, `buildEqTokenMap`, `INDEX_TOKENS`, and `SYMBOL_TO_INDEX` from `@/services/india/angelone` with calls to `registry.getInstrumentMaster()`, and SHALL NOT import `@/services/india/angelone` directly after this change.
2. WHEN `registry.getInstrumentMaster()` returns instruments, THE Realtime_Candles_Worker SHALL build the token map from the returned `Instrument[]` array using the `token` and `tradingSymbol` fields, excluding any instrument where `token` is blank or absent, producing entries of the shape `{ token: string; exchange: "NSE" }`.
3. IF `registry.getInstrumentMaster()` returns an empty array, THEN THE Realtime_Candles_Worker SHALL log an error at `ERROR` level and skip starting the tick listener for that cycle, allowing the next scheduled tick to proceed normally.
4. IF `registry.getInstrumentMaster()` throws an error, THEN THE Realtime_Candles_Worker SHALL log the error at `ERROR` level and skip starting the tick listener for that cycle, without crashing the worker process.

---

### Requirement 10: Duplicate Implementation Consolidation

**User Story:** As an AlphaForge engineer, I want duplicate data-fetching implementations merged into single registry-routed calls, so that code paths are not duplicated across services and quality tracking is applied consistently.

#### Acceptance Criteria

1. THE internal Yahoo fallback path inside `src/services/india/angelone/index.ts` SHALL be removed, so that the `withFailover()` engine in `failover.ts` is the single location that handles Angel One → Yahoo routing with no direct provider API call to Yahoo remaining in the Angel One adapter.
2. THE option chain fetching in `src/lib/market-data/services/option-strike-capture.service.ts` SHALL make no direct provider API call, delegating exclusively to `registry.getOptionChain()` rather than duplicating the fetch path alongside `option-chain.service.ts`.
3. THE historical candle fetch in `src/lib/market-data/services/fno-backfill-runner.service.ts` SHALL make no direct provider API call, delegating exclusively to `registry.getHistoricalCandles()` rather than duplicating the fetch path alongside `backfill-orchestrator.service.ts`.
4. THE quote fetching in `src/services/india/signals/snapshotter.ts` SHALL make no direct provider API call, delegating exclusively to `registry.getQuotes()` rather than maintaining a parallel fetch path alongside the registry itself.
5. THE NSE symbol → Yahoo ticker mapping SHALL be consolidated to `src/lib/market-data/normalizer.ts` as the single source, and any file outside `normalizer.ts` that defines or imports its own symbol-to-ticker mapping table SHALL be updated to import that mapping from `normalizer.ts`.
6. WHEN any of the four delegated registry calls (getOptionChain, getHistoricalCandles, getQuotes in the services above) encounters an error, THE respective service SHALL propagate the `MarketDataError` to its caller without suppressing or re-wrapping the error code.

---

### Requirement 11: 3m Timeframe Complete Eradication

**User Story:** As an AlphaForge engineer, I want the value "3m" to be unrepresentable in any part of the system — code, config, database schema comments, API parameters, cache keys, ML features, test fixtures, and documentation — so that the permanent removal introduced in V8 is completely enforced with no residual references that could cause confusion or regressions.

#### Acceptance Criteria

1. THE `Interval` TypeScript union type SHALL NOT include `"3m"`.
2. THE `isSupportedInterval("3m")` function SHALL return `false`, and `SUPPORTED_TIMEFRAMES` SHALL equal exactly `["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"]` with no `"3m"` entry.
3. THE Python data-service `validate_interval("3m")` function SHALL raise `ValueError` and `SUPPORTED_INTERVALS` frozenset SHALL NOT include `"3m"`.
4. THE ML service `CanonicalDecision` SHALL raise an error if `timeframe="3m"` is supplied and `validate_canonical_data_v8` SHALL return `BLOCKED` for any 3m data.
5. ALL API endpoints accepting an `interval` or `timeframe` parameter (`/api/in/historical-data/*`, `/scraping/historical`, and any other route) SHALL return HTTP 400 with a response body indicating that the supplied interval value is not supported, when called with `interval=3m` or `timeframe=3m`.
6. THE `v8-signal-data-gate.service.ts` SHALL return `BLOCKED` for any signal with `interval === "3m"`.
7. THE `prisma/schema.prisma` file SHALL NOT contain any comment or example referencing `"3m"` as a supported value.
8. THE codebase SHALL contain no string literal `"3m"` in any file under `src/`, `worker/src/`, `data-service/src/`, or `ml-service/src/` except in comments that (a) use past tense (e.g., "was removed") AND (b) explicitly reference "V8" — both conditions must be met simultaneously.
9. WHEN a test is written for any timeframe-aware function, THE test SHALL NOT include `"3m"` as an expected-valid input test case; `"3m"` MAY appear in negative/rejection test cases where the expected outcome is an error or rejected response.

---

### Requirement 12: Canonical DataServiceClient SDK for TypeScript Consumers

**User Story:** As an AlphaForge TypeScript developer, I want a stable, typed client SDK that abstracts all `data-service` REST interactions, so that consumers never write raw HTTP calls to `data-service` and always get typed responses with provenance metadata.

#### Acceptance Criteria

1. THE `DataGateway` (accessible via `src/lib/market-data/registry.ts` exports `registry` and `bootstrapRegistry`) SHALL be the single TypeScript entry point for all market data access — `registry.getQuotes()`, `registry.getHistoricalCandles()`, `registry.getOptionChain()`, `registry.getInstrumentMaster()`, `registry.subscribe()`, and `registry.getHealth()`.
2. WHEN `registry.getQuotes(symbols)` is called, THE DataGateway SHALL return `MDQuote[]` with a `DataProvenance` field on each quote identifying `provider`, `dataAsOf`, `isLive`, and `quality` (a numeric 0.0–1.0 scale where 1.0 = fully trusted, 0.5 = degraded, 0.0 = blocked).
3. WHEN `registry.getHistoricalCandles(req)` is called, THE DataGateway SHALL return `OHLCVCandle[]` with a companion `DataProvenance` object identifying the provider chain and `quality` using the same 0.0–1.0 numeric scale.
4. THE DataGateway SHALL throw a typed `MarketDataError` — never a plain `Error` or untyped exception — for all failure conditions (thrown exception, non-2xx response, or response timeout), with `code`, `httpStatus`, and `retryAfterMs` fields populated, where `retryAfterMs` is `null` when retry is not applicable.
5. THE DataGateway SHALL expose `registry.getHealth()` returning `ProviderHealth[]` with `id`, `status`, `latencyMs` (p50/p95/p99), `successRate`, and `requestCount` per provider, and SHALL exclude all fields whose names or values constitute authentication credentials (API keys, tokens, secrets, or passwords) from the response.
6. WHEN a consumer calls any `registry.*` method and `ScraplingProvider` (priority 0) fails, is not configured, or throws a `MarketDataError`, THE ProviderRegistry SHALL attempt `AngelOneProvider` (priority 1), then `UpstoxProvider` (priority 2), then `YahooProvider` (priority 3) in order.
7. WHEN a provider failover occurs, THE `ProviderRegistry` `withFailover()` engine SHALL emit a structured `PROVIDER_SWITCH` log record containing `from`, `to`, `reason`, `instrument`, `gapMs` (elapsed milliseconds between the last successful response from the outgoing provider and the first invocation of the incoming provider), and `timestamp`.
8. WHEN `UNSUPPORTED_CAPABILITY` is returned by a provider, THE ProviderRegistry SHALL skip that provider without decrementing its `successRate` and without incrementing its circuit-breaker failure counter.
9. WHEN `MARKET_CLOSED` is returned by a provider, THE ProviderRegistry SHALL propagate the status to the caller without decrementing the provider's `successRate` and without incrementing its circuit-breaker failure counter.

---

### Requirement 13: Capability-Aware Provider Routing

**User Story:** As an AlphaForge engineer, I want the routing engine to consult the capability matrix before calling any provider, so that providers are never called for datasets they don't support, and routing decisions are deterministic and auditable.

#### Acceptance Criteria

1. THE `provider-capability-matrix.ts` SHALL be the single source of truth for what each provider supports, with entries keyed by `(providerId, dataset, instrumentClass, timeframe)`, where each entry holds one of three statuses: `SUPPORTED`, `UNSUPPORTED_CAPABILITY`, or `BLOCKED`.
2. WHEN `registry.getHistoricalCandles()` is called with `interval="5m"` for an index symbol (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY), THE routing engine SHALL skip `AngelOneProvider` without calling it, attempt `UpstoxProvider` v3 as the first candidate, and fall back to `ScraplingProvider` if `UpstoxProvider` returns an error or unavailable response.
3. WHEN `registry.getHistoricalCandles()` is called with `interval="3m"` for any symbol, THE routing engine SHALL return an error to the caller indicating the interval is permanently blocked, without invoking any provider, and SHALL NOT retry or fall back to another interval.
4. WHEN `registry.getOptionChain()` is called and all non-`YahooProvider` candidates have been exhausted without a successful response, THE routing engine SHALL return an error to the caller indicating no capable provider is available, and SHALL NOT invoke `YahooProvider` at any point in the resolution sequence.
5. THE capability matrix entry for historical F&O OI SHALL list only `jugaad` (via `ScraplingProvider`) as a capable provider and SHALL list `angel_one`, `upstox`, and `yahoo` as `UNSUPPORTED_CAPABILITY` for that dataset.
6. WHEN the routing engine evaluates a provider for `interval="3m"`, THE routing engine SHALL read the capability matrix entry for that interval as `BLOCKED` and SHALL resolve to the blocked-interval error response defined in criterion 3 without consulting provider availability.

---

### Requirement 14: Multi-Level Cache with Request Coalescing

**User Story:** As an AlphaForge operator, I want the data layer to serve repeated requests from cache and collapse concurrent requests for the same key into a single upstream call, so that provider rate limits are not breached under concurrent load.

#### Acceptance Criteria

1. THE DataGateway SHALL maintain an L1 in-process memory cache with TTLs: LTP quotes 3 seconds, full quotes 5 seconds, 1m candles 30 seconds, 5m–1h candles 60 seconds, 1d candles 4 hours.
2. THE DataGateway SHALL use L2 Redis cache with the same TTLs and keys namespaced as `market:quote:{exchange}:{token}` and `market:candle:{exchange}:{symbol}:{interval}`.
3. THE DataGateway SHALL use L3 PostgreSQL (`CandleBar` table) as the historical fallback when both L1 and L2 cache miss.
4. WHEN 2 or more concurrent requests arrive for the same cache key before the upstream provider call for that key completes, THE DataGateway SHALL make exactly ONE upstream provider call and fan out the single response to all waiting requests; a Vitest test SHALL verify this by issuing 50 concurrent `registry.getQuotes(["NIFTY"])` calls and asserting the mock provider was called exactly once.
5. IF all three cache levels (L1, L2, and L3) miss for a requested key, THEN THE DataGateway SHALL reject the request with an error indicating that no data is available for that key, and SHALL NOT return a partial or undefined value.
6. WHEN an L3 PostgreSQL read succeeds after an L1 and L2 cache miss, THE DataGateway SHALL write the retrieved data back to L2 Redis and L1 in-process cache using the TTLs defined in criterion 1 before returning the response.
7. IF the upstream provider call initiated by request coalescing does not complete within 10 seconds, THEN THE DataGateway SHALL cancel the upstream call and return an error indicating a timeout to all waiting requests for that key.

---

### Requirement 15: Provider Health, Observability, and Circuit Breaker

**User Story:** As an AlphaForge operator, I want per-provider health metrics, latency percentiles, circuit breaker state, and structured logs for every provider switch, so that I can diagnose data quality issues without restarting any service.

#### Acceptance Criteria

1. THE ProviderRegistry SHALL track, per provider AND per `providerId::capability` pair: `requestCount`, `successCount`, `failureCount`, `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms`, and `currentHealthScore` (0–100), where latency percentiles are computed over a rolling window of the last 100 requests.
2. THE circuit breaker health score SHALL start at 100, decrease by exactly 40 points per consecutive failure (flooring at 0), increase by 10 points per success (capping at 100), and decrease by an additional 25 points for auth failures (flooring at 0).
3. WHEN a provider's health score falls below 20, THE circuit breaker SHALL open and reject all requests for that provider for 30 seconds, then enter half-open state and allow exactly one probe request; IF the probe request succeeds, THEN THE circuit breaker SHALL close and restore the health score to 20; IF the probe request fails, THEN THE circuit breaker SHALL re-open and restart the 30-second rejection window.
4. WHEN a `providerId::capability` circuit opens (e.g., `angel_one::historical`), THE DataGateway SHALL continue routing other capabilities (e.g., `angel_one::live`) to that provider without treating it as fully unavailable.
5. THE `GET /api/data/providers/health` endpoint SHALL return the current health state for all registered providers including `id`, `status`, `lastSuccessAt`, `latencyMs` (p50/p95/p99), `successRate`, `requestCount`, and `errorCount`, and SHALL exclude all fields whose names or values constitute authentication credentials (such as API keys, tokens, secrets, or passwords) from the response.
6. WHEN a provider switch (failover event) occurs, THE system SHALL emit a structured log entry at `WARN` level containing `event: "PROVIDER_SWITCH"`, `from`, `to`, `reason`, `instrument`, `gapMs` (the elapsed time in milliseconds between the last successful response from the outgoing provider and the first successful response from the incoming provider), and `timestamp`.
7. THE Python data-service `GET /monitoring/health` endpoint SHALL return per-provider health matching the schema: `status` (`healthy` when `currentHealthScore` ≥ 60, `degraded` when `currentHealthScore` is 20–59, `unavailable` when `currentHealthScore` < 20 or circuit is open), `lastSuccess`, `lastFailure`, `requestCount`, `successCount`, `failureCount`, `latencyP50`, `latencyP95`, `latencyP99`.

---

### Requirement 16: Immutable Data Provenance

**User Story:** As an AlphaForge quant, I want every data response to carry an immutable provenance record identifying the source, authentication status, data timestamps, and quality score, so that any trade can be forensically traced back to its data origin.

#### Acceptance Criteria

1. THE DataGateway SHALL attach a `DataProvenance` object to every response containing: `provider` (ProviderId), `providerType` (`BROKER | OPEN_SOURCE | SECONDARY_FALLBACK | CACHE | DERIVED`), `authenticated` (boolean), `requestedAt` (ISO-8601 UTC), `dataAsOf` (ISO-8601 UTC), `isLive` (boolean), `isHistorical` (boolean), `freshness` (`LIVE` when data age ≤ 5 seconds, `RECENT` when 6–60 seconds, `STALE` when 61 seconds–24 hours, `HISTORICAL` when > 24 hours), and `quality` (score 0–100 where A+ = 90–100, A = 80–89, B = 70–79, C = 50–69, D = 30–49, BLOCKED = 0–29; `completeness` as a 0–100 percentage; `validationStatus` as one of `PASSED | FAILED | PARTIAL | PENDING`; `reconciliationStatus` as one of `CONFIRMED | MINOR_DISCREPANCY | MAJOR_DISCREPANCY | UNRECONCILED`).
2. THE `DataProvenanceRecord` stored in the `data_provenance` PostgreSQL table SHALL be written for every historical candle fetch, with fields: `provider`, `sourceType`, `authenticated`, `credentialIdentityHash` (SHA-256 of credential identifier, never raw credential), `fetchedAt`, `responseHash` (SHA-256 of the first 50 KB of the raw response body, with `responseTruncated: true` when the body exceeds 50 KB), and `dataTrustStatus` (one of `TRUSTED | UNVERIFIED | DEGRADED | BLOCKED`).
3. WHEN a request to `GET /api/in/data/forensics/:tradeId` is received, THE forensics endpoint SHALL return a response containing: the paper trade record, the signal record that triggered the trade, the `DataProvenanceRecord` linked to that signal's data fetch, the lineage store entry, and the quality score at signal generation time — identified by the `tradeId` join path through `PaperTrade → SignalRecord → DataProvenanceRecord`.
4. WHEN a data response is served from cache (L1, L2, or L3), THE `DataProvenance.providerType` SHALL be `"CACHE"` and the original provider SHALL be recorded in `sourceChain`.
5. WHEN cross-provider reconciliation produces a `MAJOR_DISCREPANCY`, THE DataGateway SHALL persist the discrepancy to the `data_reconciliation` table and set `DataProvenance.quality.reconciliationStatus` to `MAJOR_DISCREPANCY` — and SHALL NEVER silently resolve the discrepancy.
6. IF no `DataProvenanceRecord` exists for a given `tradeId` when `GET /api/in/data/forensics/:tradeId` is called, THEN THE endpoint SHALL return HTTP 404 with an error body identifying the missing provenance link and the `tradeId` that was requested.

---

### Requirement 17: Data Validation Pipeline

**User Story:** As an AlphaForge quant, I want every data response to pass through a deterministic validation pipeline before reaching consumers, so that invalid or impossible data (negative prices, future timestamps, OHLC violations) is rejected at the boundary and never enters signal generation or ML training.

#### Acceptance Criteria

1. THE Data_Validation_Pipeline SHALL apply these steps in order to every provider response: (1) schema validation (Pydantic/Zod), (2) timestamp normalization to UTC epoch ms, (3) OHLC validation (`high >= max(open, close)`, `low <= min(open, close)`, `high >= low`, all prices > 0), (4) duplicate detection (same `instrumentId + interval + time` → drop duplicate), (5) gap detection (expected candles vs received — gaps are recorded in the quality score's `gapCount` field; if `gapCount` exceeds 20% of expected candles the batch quality grade SHALL be set to `DEGRADED` and downstreams notified), (6) freshness validation, (7) cross-provider reconciliation when 2+ providers return the same data (if the mid-price of any candle field deviates by more than 0.5% across providers, the candle SHALL be flagged `RECONCILIATION_CONFLICT` and excluded from the output until conflict is resolved; if fewer than 2 providers are available reconciliation is skipped), (8) quality scoring, (9) provenance stamping.
2. WHEN OHLC validation fails for any candle, THE Data_Validation_Pipeline SHALL drop that candle and record it in the quality score's `invalidCount` field — never silently coerce an invalid value.
3. WHEN a candle's timestamp is more than 5 seconds in the future relative to `Date.now()`, THE Data_Validation_Pipeline SHALL classify it as `INVALID_DATA` and drop it.
4. WHEN a tick's `ltp` is negative or zero, THE Data_Validation_Pipeline SHALL classify it as `INVALID_DATA` and not publish it to Redis pub/sub.
5. WHEN a single-bar price move exceeds 20% relative to the previous bar's close, THE Data_Validation_Pipeline SHALL flag it as `SUSPICIOUS` and include it in results with a `suspicious: true` field — without dropping it, as circuit limit moves are legitimate.
6. IF no previous bar exists for the instrument and interval (first candle in series), THEN THE Data_Validation_Pipeline SHALL include the candle in results without applying the 20% spike check and SHALL NOT set `suspicious: true`.
7. THE quality score SHALL be computed deterministically from: completeness (25%), freshness (25% — a candle is considered fresh if its timestamp is no older than 2 × the candle interval duration relative to `Date.now()`; e.g., a 1-minute candle is stale if older than 2 minutes), accuracy (25%), consistency (15%), provider reliability (10%) — and a quality score below 30 SHALL result in grade `BLOCKED`, which the signal engine must honor as a hard stop.

---

### Requirement 18: Historical Engine — Resumable Backfill with Gap Recovery

**User Story:** As an AlphaForge operator, I want the historical data engine to support resumable, checkpointed backfill jobs with automatic gap detection and recovery, so that full-universe historical data can be built incrementally without losing progress across restarts.

#### Acceptance Criteria

1. THE Historical_Engine SHALL support resumable backfill via a `BackfillCheckpoint` keyed by `(symbol, exchange, interval)` stored in Redis with a PostgreSQL fallback, recording the last successfully written candle timestamp; IF no checkpoint exists for a key, THE Historical_Engine SHALL begin the backfill from the configured historical start date for that instrument class.
2. WHEN a backfill job is restarted after interruption, THE Historical_Engine SHALL resume from the stored checkpoint rather than re-downloading already-completed ranges.
3. THE Historical_Engine SHALL process backfill in chunks, with maximum chunk size per provider enforced: Angel One 1m → 30 days per request, Angel One 5m–1h → 60 days, Upstox v3 → 100 days.
4. THE Historical_Engine SHALL limit concurrent provider calls to a maximum of 3 simultaneous requests; IF more than 3 requests would otherwise run concurrently, THE excess requests SHALL be queued rather than rejected.
5. THE Historical_Engine SHALL apply exponential backoff on provider errors: base 500ms, multiplier 2×, maximum 30s, with ±20% random jitter; IF a single chunk fails 5 consecutive times, THE chunk SHALL be marked `FAILED`, recorded in the backfill job log, and processing SHALL continue with the next chunk.
6. THE Historical_Engine SHALL perform gap detection after all chunks for a symbol are either successfully written or marked `FAILED`, and classify detected gaps as one of: `EXPECTED_NO_DATA` (holiday/weekend), `MARKET_HOLIDAY`, `MARKET_CLOSED`, `PROVIDER_UNAVAILABLE`, `ACTUAL_DATA_GAP`, or `PENDING_RECOVERY`.
7. WHEN `ACTUAL_DATA_GAP` gaps are detected and a capable alternative provider is available, THE Historical_Engine SHALL schedule a gap-recovery attempt using that provider and record the recovery outcome in the `historical_backfill_job` table; IF no capable provider is available, THE gap SHALL be reclassified as `PROVIDER_UNAVAILABLE` and recorded without retrying.
8. ALL bulk inserts to `CandleBar` SHALL use idempotent upsert on `(instrumentId, exchange, intervalStr, time)` so that re-running a backfill job never creates duplicates.

---

### Requirement 19: WebSocket Aggregation — data-service Owns All Market Streams

**User Story:** As an AlphaForge developer, I want data-service to own all upstream broker WebSocket connections and fan out ticks to downstream consumers via Redis pub/sub, so that consumers never connect directly to broker WebSockets and the broker connection count is minimized.

#### Acceptance Criteria

1. THE data-service SHALL be the sole owner of the Angel One SmartStream WebSocket connection and the Upstox v3 Protobuf WebSocket connection — no other service or worker may establish a direct connection to these broker WebSocket endpoints.
2. WHEN data-service receives a tick from any broker WebSocket, THE data-service SHALL normalize it to `LiveTick` format, validate it (non-null LTP, finite LTP and price fields, timestamp not more than 5 seconds ahead of the data-service system clock), and publish it to Redis pub/sub channel `af:ticks:{symbol}` and Redis Stream `af:stream:ticks`; IF a tick fails validation, THEN THE data-service SHALL discard it without publishing and increment a per-reason validation-failure counter exposed on the status endpoint.
3. WHEN data-service detects a duplicate tick (same `symbol + exchange + ltp + timestamp` within a 1-second window), THE data-service SHALL deduplicate it and NOT publish the duplicate to Redis.
4. THE TypeScript `worker/src/jobs/scraping-tick-listener.ts` SHALL be the sole entry point for tick consumption by TypeScript workers, subscribing via Redis pub/sub `af:ticks:*`.
5. THE Python ML service SHALL consume ticks via Redis pub/sub or REST polling from data-service, never via a direct broker WebSocket connection.
6. WHEN the broker WebSocket connection is lost, THE data-service SHALL attempt reconnection using exponential backoff (base 1s, max 60s, up to 10 attempts); IF all 10 reconnection attempts are exhausted without success, THEN THE data-service SHALL stop retrying and publish a `{"type": "connection_failed"}` control message to affected pub/sub channels; WHEN a reconnection attempt is initiated, THE data-service SHALL publish a `{"type": "reconnect"}` control message to affected pub/sub channels to notify consumers.
7. THE `GET /publisher/status` endpoint SHALL report `running` state, `subscribedSymbols`, `ticksPublished` (cumulative count), `validationFailures` (cumulative count broken down by failure reason), and `lastPublishedAt` as a Unix millisecond timestamp.

---

### Requirement 20: F&O Universe — Dynamic, Point-in-Time Aware

**User Story:** As an AlphaForge quant, I want the F&O universe to be dynamically maintained, versioned with SHA-256 checksums, and point-in-time aware for backtesting, so that signals and ML training always use the correct universe for the relevant date.

#### Acceptance Criteria

1. WHEN the instrument master is refreshed (at most every 24 hours), THE F&O_Universe_Service SHALL discover NSE F&O-eligible equity symbols from Angel One and Upstox instrument masters, tracking lifecycle state (`ACTIVE | ADDED | REMOVED | SUSPENDED | UNRESOLVED`) for each symbol.
2. THE F&O_Universe_Service SHALL generate a deterministic SHA-256 checksum of the universe snapshot computed from the sorted list of active symbols — same symbols always produce the same checksum.
3. WHEN the universe is queried for a historical date (backtesting mode), THE F&O_Universe_Service SHALL return the snapshot whose `effectiveFrom` is on or before the queried date and whose `effectiveTo` is after the queried date or is null (null indicates the current active snapshot).
4. IF no snapshot covers the queried historical date, THE F&O_Universe_Service SHALL return an error indicating no universe data is available for that date.
5. THE `GET /api/in/historical-data/universe` endpoint SHALL return the versioned universe snapshot including `universe`, `effectiveFrom`, `effectiveTo` (null for the current snapshot), `source`, `version`, and `checksum` fields.
6. THE F&O_Universe_Service SHALL NEVER hardcode the list of F&O-eligible symbols; the list MUST be derived from instrument master data cached for at most 24 hours.
7. WHEN a symbol is removed from the NSE F&O segment, THE F&O_Universe_Service SHALL record it with status `REMOVED` and `removedAt` timestamp (rounded to the nearest minute), and historical queries for dates before removal SHALL still return it.

---

### Requirement 21: Secure Credential Management

**User Story:** As an AlphaForge security engineer, I want broker credentials to be encrypted at rest and never appear in API responses, logs, cache keys, or error messages, so that a compromised log stream or API response cannot leak trading credentials.

#### Acceptance Criteria

1. ALL broker credentials (SMARTAPI_CLIENT_CODE, SMARTAPI_PIN, SMARTAPI_TOTP_SECRET, UPSTOX_CLIENT_SECRET, UPSTOX_ACCESS_TOKEN) SHALL be stored only in environment variables and in `UserSetting.apiKeysEncrypted` (AES-256-GCM via `src/lib/crypto.ts`) — never in plain text in the database, Redis, or log files.
2. THE `GET /api/data/providers/health` endpoint response SHALL NOT contain any credential value, JWT token, API key, or secret — only lifecycle states and timestamps.
3. THE data-service Python process SHALL retrieve credentials from environment variables only; it SHALL NOT accept credentials via HTTP request bodies or query parameters.
4. WHEN a provider authentication fails, THE error log entry SHALL contain the provider ID and error code but SHALL NOT include the credential value or any representation derived from it, including any prefix, suffix, substring, Base64 encoding, or hash of the credential value.
5. THE `DataProvenanceRecord.credentialIdentityHash` field SHALL contain the SHA-256 hash of the credential identifier — defined as SMARTAPI_CLIENT_CODE for SmartAPI credentials and UPSTOX_CLIENT_SECRET for Upstox credentials — not the credential value itself, to allow audit trail without credential exposure.
6. IF a build-time scan detects any environment variable prefixed with `NEXT_PUBLIC_` whose name or value matches a broker credential, token, or secret pattern, THEN THE build process SHALL terminate with a non-zero exit code before producing any build artifact.

---

### Requirement 22: Performance SLOs — Measured and Reported

**User Story:** As an AlphaForge operator, I want the data layer's latency to be measured against defined SLOs and reported, so that performance regressions are caught before they affect signal generation latency.

#### Acceptance Criteria

1. THE DataGateway SHALL measure and expose p50/p95/p99 latency for each operation type: quote retrieval, historical candle retrieval, and option chain retrieval.
2. THE SLO targets SHALL be: cached quote (L1/L2 hit) p95 < 20ms; cached historical candle (L1/L2 hit) p95 < 50ms; PostgreSQL range query (L3 fallback) p95 < 100ms; live quote (cache miss, provider call) p95 < 2000ms; option chain retrieval p95 < 3000ms.
3. THE `DATA_SERVICE_PERFORMANCE_REPORT.md` SHALL record actual measured p50/p95/p99 values for each operation type against the defined SLO targets, sourced from a load test that specifies the request rate (requests per second), test duration (minimum 60 seconds), and environment in which measurements were taken — not estimated values.
4. WHEN a single DataGateway operation's measured latency exceeds 2× its SLO target, THE DataGateway SHALL emit a structured warning log entry with `event: "SLO_BREACH"`, `operation`, `latencyMs`, `sloMs`, and `provider`.
5. WHEN a load test is run against a warm cache, THE performance test suite SHALL issue 1000 concurrent `registry.getQuotes(["NIFTY"])` requests after a 10-request warm-up phase and assert that the measured p95 latency is below 20ms.

---

### Requirement 23: Migration Report and Certification Documentation

**User Story:** As an AlphaForge team lead, I want all required architectural reports to reflect actual verified evidence of the completed refactor, so that the certification documents are truthful and auditable rather than aspirational.

#### Acceptance Criteria

1. THE `DATA_SERVICE_PRE_REFACTOR_AUDIT.md` SHALL document all 13 violation sites with file paths, line references, and classification, where each entry is confirmed accurate against the post-migration codebase such that no entry references a line number or path that no longer exists and no violation site present in code is absent from the document.
2. THE `DATA_SERVICE_TEST_PLAN.md` SHALL document every test with its ID, description, expected outcome, and PASS/FAIL/SKIP status, where every test listed has a recorded status and zero tests remain in a pending or unexecuted state.
3. THE `DATA_SERVICE_ARCHITECTURE.md` SHALL describe the post-refactor architecture including provider responsibilities, data flows, capability routing matrix, normalization pipeline, and caching architecture, where every section reflects the state of the codebase at the time of final certification with no section describing components or flows that no longer exist in the implementation.
4. THE `DATA_SERVICE_API.md` SHALL document the complete REST API contract for both the Python data-service and the TypeScript API routes, where every endpoint, request parameter, and response schema in the document matches the corresponding schema derived from code inspection, and no endpoint present in code is absent from the document.
5. THE `DATA_SERVICE_MIGRATION_REPORT.md` SHALL record the before/after state for each of the 13 violation sites, confirming each migration with a test that passes — no violation site may be marked migrated without a passing test.
6. THE `DATA_SERVICE_PERFORMANCE_REPORT.md` SHALL record actual measured p50/p95/p99 latency values from load tests — not estimated values.
7. THE `DATA_SERVICE_FINAL_CERTIFICATION.md` SHALL only be issued at `LEVEL 3 — PRODUCTION READY` after all of the following conditions are verified: zero violation sites remain in the codebase as confirmed by static analysis producing zero findings; all 13 migration tests pass; the Canonical_Import_Guard reports zero violations; `3m` is confirmed absent by a grep or equivalent search of the entire codebase returning zero matches; all SLOs are measured under load and meet a minimum of p99 latency ≤ 2000 ms and p50 latency ≤ 500 ms; and the DataQualityGate (`POST /data/gate`) returns a gated response (HTTP 4xx with a quality-failure indicator) when invoked with a known-invalid payload from the TypeScript signal engine integration path.
8. WHEN `DATA_SERVICE_FINAL_CERTIFICATION.md` is issued, THE document SHALL explicitly state the git commit hash, test run date, pass/fail counts, and SLO measurement methodology including the load profile (request rate and duration), the tool used to capture measurements, and the environment in which measurements were taken.

