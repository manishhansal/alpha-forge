# Implementation Plan: Data-Service Centralization

## Overview

Eliminate all 13 violation sites where TypeScript code directly imports Angel One, Upstox, or Yahoo Finance adapters outside the approved provider boundary. Every market data access is routed through `registry` (the `ProviderRegistry` singleton) or the `DataGateway` client. A canonical import guard enforces the boundary at CI time. New PostgreSQL tables, `DataProvenance` types, and certification reports complete the architectural transformation.

Migration is executed in four phases, each independently testable and deployable before the next begins.

---

## Tasks

- [x] 1. Phase 1 — P1 Critical Violations (Angel One, Scanner, Snapshotter)

  - [x] 1.1 Remove internal Yahoo fallback from Angel One adapter (V-01)
    - In `src/services/india/angelone/index.ts`, delete the `allowFallback` / `yahoo.getQuotes()` branch from `getQuotes()` and the `yahoo.getHistorical()` branch from `getHistorical()`
    - Any failure from `smartApiGetQuotes` / `smartApiGetHistorical` must throw a `MarketDataError` with a non-null `code` — one of `AUTH_FAILURE`, `RATE_LIMIT`, `UNAVAILABLE`, `TIMEOUT`, `NETWORK`, or `API_ERROR`
    - Remove the `import { yahoo } from "@/services/india/yahoo"` statement from `angelone/index.ts`
    - Update any existing tests that mock the internal Yahoo fallback: they should now assert a `MarketDataError` is thrown by the adapter and verify that `ProviderRegistry.withFailover()` — not the adapter — invokes Yahoo as the next provider
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 10.1_

  - [ ]* 1.2 Write property test for Angel One adapter error propagation (P1)
    - **Property 1: Angel One Adapter Error Propagation**
    - For any failure mode from SmartAPI (arbitrary HTTP status codes, network error, `status === false`, timeout), the adapter SHALL throw `MarketDataError` with a non-null `code` and SHALL NOT call any Yahoo provider method internally
    - Tag: `// Feature: data-service-centralization, Property 1: Angel One Adapter Error Propagation`
    - File: `tests/services/india/angelone/adapter-errors.test.ts`
    - Use `fast-check` arbitrary HTTP status codes and error shapes (min 100 iterations)
    - **Validates: Requirements 2.1, 2.2, 2.3, 10.1**

  - [x] 1.3 Migrate Scanner Engine Yahoo calls to registry (V-02)
    - In `src/services/india/scanner/engine.ts`, replace `yahoo.getQuotes(FNO_STOCKS)` with `registry.getQuotes()` and `yahoo.getHistorical()` with `registry.getHistoricalCandles()`
    - Remove the `import { yahoo } from "@/services/india/yahoo"` statement (static and dynamic)
    - Retain `angel.getPutCallRatio()`, `angel.getOiBuildup()`, `angel.getTopGainersLosers()` as Documented_Exceptions; annotate each call with the comment: `// DATA_SERVICE_PRE_REFACTOR_AUDIT.md V-02: Documented_Exception — no MarketDataProvider equivalent`
    - Update scanner tests in `tests/services/india/scanner/` to mock `registry` instead of `yahoo`; no mocked Yahoo calls may remain in scanner-specific test files
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 1.4 Migrate Signal Snapshotter Yahoo calls to registry (V-03)
    - In `src/services/india/signals/snapshotter.ts`, replace `yahoo.getQuotes(nseSymbols)` with `registry.getQuotes()` and remove the `import { yahoo }` statement (static and dynamic)
    - When `registry.getQuotes()` returns `null` for a symbol slot, write a snapshot entry with `quality: "PROVIDER_UNAVAILABLE"` — never omit the symbol
    - When `registry.getQuotes()` throws a `MarketDataError`, catch it, log at `WARN` level, and continue processing remaining symbols
    - Include the `provider` field from `DataProvenance` in each snapshot cache entry; fall back to `"UNKNOWN"` when provenance is absent
    - Update snapshotter tests: assert that a null registry result produces a `quality: "PROVIDER_UNAVAILABLE"` entry
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 10.4_

  - [ ]* 1.5 Write property test for Signal Snapshotter fault tolerance (P3)
    - **Property 3: Signal Snapshotter Fault Tolerance**
    - For any list of symbols where a random subset returns `null` or throws `MarketDataError`, the snapshotter SHALL: (a) produce `PROVIDER_UNAVAILABLE` entries for every null symbol, (b) produce valid entries for every success, (c) never abort early
    - Tag: `// Feature: data-service-centralization, Property 3: Signal Snapshotter Fault Tolerance`
    - File: `tests/services/india/signals/snapshotter.test.ts`
    - Use `fast-check` arbitrary symbol lists with random null/throw ratios (min 100 iterations)
    - **Validates: Requirements 4.2, 4.3, 4.4**

- [x] 2. Checkpoint — Phase 1 complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Phase 2 — P2 Service Layer Violations (Option Chain, Backfill, Expiry Trades)

  - [x] 3.1 Migrate Option Strike Capture Service to registry (V-04)
    - In `src/lib/market-data/services/option-strike-capture.service.ts`, replace the dynamic `import("@/services/india/angelone")` and `angel.getOptionChain()` call with `registry.getOptionChain(underlying, expiry)`
    - Record `provider` (from `DataProvenance.provider`, type `ProviderId`) and `fetchedAt` (from the option chain response, UTC ISO-8601) in the capture record
    - If `registry.getOptionChain()` throws a `MarketDataError`, re-throw it preserving the original `code` — do NOT wrap in a new generic `Error`
    - Update option strike capture tests to verify that a `MarketDataError({ code: "UNAVAILABLE" })` from the mock registry is re-thrown with `code === "UNAVAILABLE"`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 10.2, 10.6_

  - [x] 3.2 Migrate F&O Backfill Runner to registry (V-05)
    - In `src/lib/market-data/services/fno-backfill-runner.service.ts`, replace the dynamic `import("@/services/india/angelone")` and `angel.getHistorical()` call with `registry.getHistoricalCandles()`
    - Persist returned candles to `CandleBar` using idempotent upsert on `(instrumentId, exchange, intervalStr, time)`
    - When `registry.getHistoricalCandles()` returns an empty array for a symbol-interval pair that has a checkpoint, classify as `EMPTY_DATA`, advance the checkpoint cursor past the current fetch window, and continue to the next symbol — do NOT classify as `PROVIDER_FAILURE`
    - When persisting a batch to `CandleBar` fails due to a DB error, classify as `PROVIDER_FAILURE`, log the error, skip to the next symbol, and preserve already-written candles from prior batches without rollback
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 10.3, 10.6_

  - [ ]* 3.3 Write property test for CandleBar upsert idempotence (P5)
    - **Property 5: CandleBar Upsert Idempotence**
    - For any set of `OHLCVCandle` records, calling the bulk upsert once or N times with the same data SHALL result in exactly one DB row per unique `(instrumentId, exchange, intervalStr, time)` tuple
    - Tag: `// Feature: data-service-centralization, Property 5: CandleBar Upsert Idempotence`
    - File: `tests/lib/market-data/candle-upsert.test.ts`
    - Use `fast-check` arbitrary `OHLCVCandle` arrays with random duplicates (min 100 iterations)
    - **Validates: Requirements 6.2, 18.8**

  - [x] 3.4 Migrate Expiry Trades Builder to registry (V-06)
    - In `src/features/india/expiry-trades/builder.ts`, replace `angel.getOptionChain("SENSEX")`, `isAngelConfigured`, and all related direct Angel One calls with `registry.getOptionChain("SENSEX")`
    - Remove the `import { angel } from "@/services/india/angelone"` import
    - Read `spot` for underlying price, `analytics.atmIv` for IV calculations, and `rows[]` for strike-level data from the registry response — same fields as before
    - If `registry.getOptionChain()` throws a `MarketDataError` or returns null, propagate the error or return an empty result set; do NOT substitute fabricated data
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 3.5 Write property test for MarketDataError preservation (P4)
    - **Property 4: MarketDataError Preservation Through Service Layers**
    - For any `MarketDataError` with any valid `code` thrown by `registry.getOptionChain()` or `registry.getHistoricalCandles()`, every service layer (option-strike-capture, backfill-runner, expiry-trades-builder) SHALL re-throw a `MarketDataError` whose `code` equals the original — neither wrapped in a plain `Error` nor re-classified
    - Tag: `// Feature: data-service-centralization, Property 4: MarketDataError Preservation Through Service Layers`
    - File: `tests/lib/market-data/error-preservation.test.ts`
    - Use `fast-check` arbitrary `MarketDataErrorCode` values (min 100 iterations)
    - **Validates: Requirements 5.3, 6.4, 7.3, 10.6**

- [x] 4. Checkpoint — Phase 2 complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Phase 3 — P3 Feature / API Route / Worker Violations (V-07 through V-13)

  - [x] 5.1 Migrate F&O Trend History service (V-07)
    - In `src/features/india/fno-trend-history/service.ts`, call `registry.getQuotes()` (with `await bootstrapRegistry()` called first) in place of `yahoo.getQuotes(symbols)`
    - Remove any static or dynamic `import { yahoo } from "@/services/india/yahoo"` statement
    - _Requirements: 8.1_

  - [x] 5.2 Migrate Scalping Backtest (V-08)
    - In `src/features/india/scalping/backtest.ts`, call `registry.getHistoricalCandles(request)` where `request` is a typed `HistoricalCandleRequest` in place of `yahoo.getHistorical(...)`
    - Remove any static or dynamic `import { yahoo } from "@/services/india/yahoo"` statement
    - _Requirements: 8.2_

  - [x] 5.3 Migrate Scalping Positioning Strategy (V-09)
    - In `src/features/india/scalping/strategies/positioning.ts`, call `registry.getQuotes()` (with `await bootstrapRegistry()` called first) in place of `yahoo.getQuotes(FNO_INDICES)`
    - Remove any static or dynamic `import { yahoo } from "@/services/india/yahoo"` statement
    - _Requirements: 8.3_

  - [x] 5.4 Migrate Scalping Opening-Breakout Strategy (V-10)
    - In `src/features/india/scalping/strategies/opening-breakout.ts`, call `registry.getHistoricalCandles(request)` where `request` is a typed `HistoricalCandleRequest` in place of `yahoo.getHistorical(...)`
    - Remove any static or dynamic `import { yahoo } from "@/services/india/yahoo"` statement
    - _Requirements: 8.4_

  - [x] 5.5 Migrate Paper Trading Auto-Trader (V-11)
    - In `src/features/india/paper-trading/auto-trader.ts`, replace the dynamic `const { yahoo } = await import("@/services/india/yahoo")` and `yahoo.getQuotes()` call with `registry.getQuotes()`
    - Remove any static or dynamic `import { yahoo }` statement
    - _Requirements: 8.5_

  - [x] 5.6 Migrate Scalper Close-All API Route (V-12)
    - In `src/app/api/in/scalper/close-all/route.ts`, call `registry.getQuotes()` (with `await bootstrapRegistry()` called first) in place of `yahoo.getQuotes()`
    - Remove any static or dynamic `import { yahoo } from "@/services/india/yahoo"` statement
    - _Requirements: 8.6_

  - [x] 5.7 Migrate Worker Realtime-Candles Instrument Token Resolution (V-13)
    - In `worker/src/jobs/india-realtime-candles.ts`, replace imports of `getScripSubsets`, `buildEqTokenMap`, `INDEX_TOKENS`, and `SYMBOL_TO_INDEX` from `@/services/india/angelone` with a call to `registry.getInstrumentMaster({ exchange: "NSE", instrumentType: "EQ" })`
    - Remove the `import ... from "@/services/india/angelone"` statement
    - Build the token map from `Instrument[]`: filter out entries where `token` is blank or absent; produce entries of shape `{ token: string; exchange: "NSE" }`
    - If `getInstrumentMaster()` returns an empty array, log at `ERROR` level and skip starting the tick listener for that cycle
    - If `getInstrumentMaster()` throws, log the error at `ERROR` level and skip starting the tick listener for that cycle without crashing the worker process
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ]* 5.8 Write property test for Registry Failover Health Tracking (P2)
    - **Property 2: Registry Failover Health Tracking**
    - For any `MarketDataError` thrown by any provider during `withFailover()`, the failing provider's `consecutiveFailures` count SHALL increment by exactly 1, and a `PROVIDER_SWITCH` log record SHALL be emitted before the next provider is attempted
    - Tag: `// Feature: data-service-centralization, Property 2: Registry Failover Health Tracking`
    - File: `tests/lib/market-data/failover-health.test.ts`
    - Use `fast-check` arbitrary error sequences (min 100 iterations)
    - **Validates: Requirements 2.5, 12.7, 15.6**

- [x] 6. Checkpoint — Phase 3 complete
  - Ensure all tests pass and grep `src/ worker/src/ data-service/src/ ml-service/src/` for `@/services/india/yahoo` to confirm zero imports remain outside the allowlist. Ask the user if questions arise.

- [x] 7. Phase 4a — Canonical Types and `DataProvenance` (types.ts)

  - [x] 7.1 Add `DataProvenance` and related types to `src/lib/market-data/types.ts`
    - Add `DataFreshness`, `DataTrustStatus`, `QualityGrade`, `ReconciliationStatus` union types
    - Add the full `DataProvenance` type with fields: `provider`, `providerType`, `authenticated`, `requestedAt`, `dataAsOf`, `isLive`, `isHistorical`, `freshness`, `quality` (score, grade, completeness, freshness, accuracy, validationStatus, reconciliationStatus, gapCount, invalidCount, suspiciousCount), and `sourceChain`
    - Ensure `ProviderId` is `"scrapling" | "angel_one" | "upstox" | "jugaad" | "openchart" | "yahoo"` — `"nse"` and `"3m"` must be absent
    - Ensure `Interval` type and `SUPPORTED_TIMEFRAMES` constant do NOT include `"3m"`; the constant must equal exactly `["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"]`
    - _Requirements: 11.1, 11.2, 12.2, 12.3, 12.4, 16.1_

  - [ ]* 7.2 Write property test for Provenance Completeness (P11)
    - **Property 11: Provenance Completeness**
    - For any successful response from `registry.getQuotes()`, `registry.getHistoricalCandles()`, or `registry.getOptionChain()`, the response SHALL carry a `DataProvenance` with non-null `provider`, `dataAsOf`, `isLive`, `quality.score`, and `quality.grade`; when served from cache, `providerType` SHALL equal `"CACHE"`
    - Tag: `// Feature: data-service-centralization, Property 11: Provenance Completeness`
    - File: `tests/lib/market-data/provenance.test.ts`
    - Use `fast-check` arbitrary provider + response combinations (min 100 iterations)
    - **Validates: Requirements 12.2, 12.3, 16.1, 16.4**

- [x] 8. Phase 4b — ESLint Import Guard Extension

  - [x] 8.1 Extend ESLint `no-restricted-imports` rule in `eslint.config.mjs`
    - Add a `no-restricted-imports` rule pattern covering `**/services/india/angelone*` outside the allowlist with message: `"Use registry.getQuotes() etc. See canonical-import-guard.ts for documented exceptions."`
    - Ensure the existing patterns for `**/services/india/yahoo*` and `yahoo-finance2` remain in place
    - The five Documented_Exception files (`scanner/engine.ts`, `expiry-trades/builder.ts`, `app/api/in/scanner/**`, `app/api/in/expiry-trades/**`, `features/india/scalping/strategies/positioning.ts`) must disable the rule with `// eslint-disable-next-line no-restricted-imports` plus a comment referencing `DATA_SERVICE_PRE_REFACTOR_AUDIT.md`
    - Verify `npm run lint` exits non-zero when a test file introduces a forbidden import; exit zero on a clean tree
    - _Requirements: 1.1, 1.3, 1.6, 1.7_

  - [x] 8.2 Complete `canonical-import-guard.test.ts` violation-site assertions
    - In `tests/lib/market-data/canonical-import-guard.test.ts`, add one individual assertion per violation site (V-01 through V-13) confirming the file no longer contains a forbidden import pattern
    - Add assertion: `ProviderId` union does not include `"nse"` or `"3m"` (Req 1.4)
    - Add assertion: `SUPPORTED_TIMEFRAMES` equals exactly `["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1M"]` (Req 1.5)
    - Add assertion: test report output includes the line `Documented exceptions: 5 files` (Req 1.6)
    - Add assertion: `isSupportedInterval("3m")` returns `false`
    - _Requirements: 1.2, 1.4, 1.5, 1.6, 11.2_

  - [ ]* 8.3 Write property test for 3m Universal Rejection (P12)
    - **Property 12: 3m Interval Universal Rejection**
    - For any API endpoint that accepts an `interval` or `timeframe` parameter, supplying `interval=3m` SHALL result in a rejection (HTTP 400 or thrown `MarketDataError`) WITHOUT calling any provider, and SHALL NOT affect any provider's circuit-breaker state
    - Tag: `// Feature: data-service-centralization, Property 12: 3m Interval Universal Rejection`
    - File: `tests/lib/market-data/interval-rejection.test.ts`
    - Parameterized over all API entry points that accept `interval` (min 100 iterations)
    - **Validates: Requirements 11.5, 13.3**

- [x] 9. Phase 4c — Cache, Request Coalescing, and Provenance Stamping

  - [x] 9.1 Implement `DataProvenance` stamping in `withFailover()` success path
    - In `src/lib/market-data/registry.ts` (or `failover.ts`), add provenance stamping after every successful provider call: populate `provider`, `providerType`, `authenticated`, `requestedAt`, `dataAsOf`, `isLive`, `isHistorical`, `freshness` (LIVE/RECENT/STALE/HISTORICAL), `quality`, and `sourceChain`
    - When response is served from L1/L2 cache, set `providerType: "CACHE"` and record original provider in `sourceChain[0]`
    - Emit structured `PROVIDER_SWITCH` log at `WARN` level on every provider transition containing `event: "PROVIDER_SWITCH"`, `from`, `to`, `reason`, `instrument`, `gapMs`, and `timestamp`
    - _Requirements: 12.7, 15.6, 16.1, 16.4_

  - [x] 9.2 Implement request coalescing in the DataGateway
    - Add a `pendingCalls: Map<string, Promise<...>>` to the registry; when a cache-miss request arrives for a key already in-flight, return the existing Promise instead of starting a new upstream call
    - If the in-flight call does not complete within 10 seconds, cancel it and reject all waiters with `MarketDataError({ code: "PROVIDER_TIMEOUT", retryAfterMs: null })`
    - Verify L1 TTLs: LTP quotes 3s, full quotes 5s, 1m candles 30s, 5m–1h candles 60s, 1d candles 4h
    - Verify L2 Redis key patterns match: `md:quote:{provider}:{SYMBOL}` (3s), `md:candles:{provider}:{exchange}:{symbol}:{interval}:{from}:{to}` (30s intraday / 4h daily)
    - Write-back to L2 then L1 after any L3 PostgreSQL read succeeds
    - _Requirements: 14.1, 14.2, 14.4, 14.6, 14.7_

  - [ ]* 9.3 Write property test for Request Coalescing (P6)
    - **Property 6: Request Coalescing**
    - For any N ≥ 2 concurrent calls to `registry.getQuotes()` with the same symbol list before the upstream call completes, the upstream provider SHALL be called exactly once, and all N callers SHALL receive the same result
    - Tag: `// Feature: data-service-centralization, Property 6: Request Coalescing`
    - File: `tests/lib/market-data/coalescing.test.ts`
    - Issue 50 concurrent `registry.getQuotes(["NIFTY"])` calls; assert mock provider called exactly once (N = 2–100 via fast-check)
    - **Validates: Requirements 14.4**

- [x] 10. Phase 4d — Per-Capability Circuit Breaker

  - [x] 10.1 Verify and complete circuit breaker health-score invariants in `health.ts`
    - Confirm score starts at 100; decreases by 40 per consecutive failure (floor 0); decreases by additional 25 for auth failures; increases by 10 per success (cap 100)
    - Circuit opens when score < 20; after 30s enters half-open; one probe: success → score = 20, circuit closes; failure → re-open and restart 30s window
    - Per-capability circuit (`angel_one::historical`) must be independent of provider-wide circuit (`angel_one::liveQuotes`)
    - Expose `GET /api/data/providers/health` returning `id`, `status`, `lastSuccessAt`, `latencyMs` (p50/p95/p99), `successRate`, `requestCount`, `errorCount` — excluding all credential fields
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [ ]* 10.2 Write property test for Circuit Breaker Score Invariants (P7)
    - **Property 7: Circuit Breaker Score Invariants**
    - For any sequence of provider failures and successes, the health score SHALL always be in [0, 100]; after N consecutive failures from 100 the score ≤ max(0, 100 − 40N); after any success score increases by 10 (capped); score < 20 implies `circuitOpen === true`; `circuitOpen && 30s elapsed` → one probe allowed
    - Tag: `// Feature: data-service-centralization, Property 7: Circuit Breaker Score Invariants`
    - File: `tests/lib/market-data/circuit-breaker.test.ts`
    - Use `fast-check` arbitrary failure/success sequences (min 100 iterations)
    - **Validates: Requirements 15.1, 15.2, 15.3**

- [x] 11. Phase 4e — Data Validation Pipeline

  - [x] 11.1 Verify and complete the 9-step validation pipeline in the TypeScript normalizer
    - Confirm the pipeline in `src/lib/market-data/` (normalizer / validation layer) applies in order: (1) schema validation, (2) UTC timestamp normalization, (3) OHLC validation — drop invalid candles, never coerce, increment `invalidCount`, (4) future timestamp guard (> now + 5s → DROP), (5) duplicate detection by `(instrumentId, exchange, intervalStr, time)`, (6) gap detection — if gap% > 20% set quality grade to `DEGRADED`, (7) cross-provider reconciliation — deviation > 0.5% → `RECONCILIATION_CONFLICT`, (8) spike detection — > 20% move → `suspicious: true`, keep candle, skip if first candle, (9) quality scoring + provenance stamping
    - Quality formula: `0.25×completeness + 0.25×freshness + 0.25×accuracy + 0.15×consistency + 0.10×provider_reliability`; grade thresholds: A+(95–100), A(85–94), B(70–84), C(50–69), D(30–49), BLOCKED(<30)
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7_

  - [ ]* 11.2 Write property test for OHLC Validation Pipeline (P8)
    - **Property 8: OHLC Validation — Invalid Candles Are Dropped, Never Coerced**
    - For any batch of candles, the pipeline SHALL pass only those where `high >= max(open, close)` AND `low <= min(open, close)` AND `high >= low` AND all prices > 0 AND timestamp ≤ now + 5s; candles failing any condition are in `invalidCount` and absent from output; no invalid field is silently corrected
    - Tag: `// Feature: data-service-centralization, Property 8: OHLC Validation — Invalid Candles Are Dropped, Never Coerced`
    - File: `tests/lib/market-data/validation-pipeline.test.ts`
    - Use `fast-check` arbitrary OHLCV arrays with random invalid fields (min 100 iterations)
    - **Validates: Requirements 17.2, 17.3**

- [x] 12. Phase 4f — Database Schema (Prisma)

  - [x] 12.1 Add new Prisma models: `DataProvenance`, `DataReconciliation`, `HistoricalBackfillJob`
    - Add `DataProvenance` model to `prisma/schema.prisma` matching the `data_provenance` SQL table defined in the design (fields: id, provider, sourceType, authenticated, credentialIdentityHash, fetchedAt, dataAsOf, responseHash, responseTruncated, dataTrustStatus, instrumentId, intervalStr, fromTs, toTs, createdAt)
    - Add `DataReconciliation` model matching the `data_reconciliation` SQL table (fields: id, instrumentId, intervalStr, candleTime, providerA, providerB, fieldName, valueA, valueB, deviationPct, status, resolved, createdAt)
    - Add `HistoricalBackfillJob` model matching the `historical_backfill_job` SQL table (fields: id, instrumentId, exchange, intervalStr, fromTs, toTs, status, chunksTotal, chunksDone, chunksFailed, lastCheckpointTs, errorMessage, startedAt, completedAt, createdAt)
    - Remove any `"3m"` example or reference from all comments in `prisma/schema.prisma`
    - Run `npx prisma generate` to confirm schema compiles without errors
    - _Requirements: 11.7, 18.1, 16.2_

  - [x] 12.2 Add optimised CandleBar and OptionChainSnapshot indexes
    - In `prisma/schema.prisma` (or a migration file), add the covering index for ML window queries: `@@index([instrumentId, exchange, intervalStr, time(sort: Desc)])` on `CandleBar`, named `idx_candle_bar_window`
    - Add `@@index([underlying, expiry, captureTimestamp(sort: Desc)])` on `OptionChainSnapshot`, named `idx_option_chain_latest`
    - Both indexes use `CONCURRENTLY IF NOT EXISTS` in raw SQL if adding via migration
    - _Requirements: (design section 3.1 — DB Observations)_

- [x] 13. Phase 4g — DataProvenanceRecord Persistence and Forensics Endpoint

  - [x] 13.1 Implement `persistProvenance()` for historical candle fetches
    - In the registry or a new `provenance.ts` service, implement `persistProvenance(provider, req, rawResponseBody, authenticated)` that writes to the `data_provenance` table
    - Compute `responseHash = sha256(rawResponseBody.slice(0, 50 * 1024))`; set `responseTruncated: true` when body exceeds 50 KB
    - Compute `credentialIdentityHash = sha256(resolveCredentialIdentifier(provider))` — `SMARTAPI_CLIENT_CODE` for Angel One, `UPSTOX_CLIENT_SECRET` for Upstox — never the credential value itself
    - Call `persistProvenance` for every historical candle fetch; do NOT call for live quote fetches
    - _Requirements: 16.2, 21.5_

  - [x] 13.2 Implement `GET /api/in/data/forensics/:tradeId` endpoint
    - Create `src/app/api/in/data/forensics/[tradeId]/route.ts`
    - Join `PaperTrade → SignalRecord → DataProvenanceRecord` by `tradeId`
    - Return: `paperTrade`, `signalRecord`, `dataProvenanceRecord`, `lineageEntry`, `qualityAtSignalTime` (score + grade)
    - If no `DataProvenanceRecord` exists for the `tradeId`, return HTTP 404 with an error body identifying the missing provenance link and the `tradeId`
    - _Requirements: 16.3, 16.6_

- [x] 14. Checkpoint — Phase 4 infrastructure complete
  - Ensure all tests pass, `npm run lint` exits zero, and `npx prisma generate` succeeds. Ask the user if questions arise.

- [x] 15. Phase 4h — Python data-service Validation, Tick Publisher, Universe (verification tasks)

  - [x] 15.1 Verify Python 9-step validation pipeline in `data-service`
    - Confirm `data-service/src/` applies identical OHLC validation, timestamp normalization, spike detection, gap detection, and quality scoring steps as documented in design section 10.1
    - Confirm `validate_interval("3m")` raises `ValueError` and `SUPPORTED_INTERVALS` frozenset does NOT include `"3m"`
    - Confirm `acquisition_planner.py` raises `ValueError` for `interval == "3m"`
    - _Requirements: 11.3, 17.1_

  - [ ]* 15.2 Write Hypothesis property test for Tick Stream Filtering (P9)
    - **Property 9: Tick Stream Filtering — Only Valid Ticks Published**
    - For any stream of raw ticks containing a mix of valid, negative-LTP, future-timestamp, and duplicate-within-1s ticks, only valid non-duplicate ticks are published to Redis pub/sub; invalid/duplicate ticks are counted per-reason in `validationFailures`
    - Tag: `# Feature: data-service-centralization, Property 9: Tick Stream Filtering — Only Valid Ticks Published`
    - File: `data-service/tests/test_tick_validation.py`
    - Use `hypothesis.given` with arbitrary tick streams (min 100 examples)
    - **Validates: Requirements 19.2, 19.3**

  - [ ]* 15.3 Write Hypothesis property test for F&O Universe Checksum Determinism (P10)
    - **Property 10: F&O Universe Checksum Determinism**
    - For any set of active F&O symbols regardless of supply order, the SHA-256 checksum computed by `F&O_Universe_Service` SHALL be identical — same symbols always produce the same checksum
    - Tag: `# Feature: data-service-centralization, Property 10: F&O Universe Checksum Determinism`
    - File: `data-service/tests/test_universe.py`
    - Use `hypothesis.given` with arbitrary symbol sets in arbitrary orders (min 100 examples)
    - **Validates: Requirements 20.2**

  - [x] 15.4 Verify data-service WebSocket and publisher status endpoint
    - Confirm `data-service` is the sole owner of Angel One SmartStream WS and Upstox v3 Protobuf WS connections; no TypeScript service establishes a direct broker WS connection
    - Confirm reconnection policy: exponential backoff 1s → 60s, max 10 attempts; `{"type":"reconnect"}` published on each attempt; `{"type":"connection_failed"}` published after 10 exhausted attempts
    - Confirm `GET /publisher/status` returns `running`, `subscribedSymbols`, `ticksPublished`, `validationFailures` (per-reason), `lastPublishedAt`
    - _Requirements: 19.1, 19.6, 19.7_

- [x] 16. Phase 4i — Security and Credential Enforcement

  - [x] 16.1 Add `NEXT_PUBLIC_*` credential build guard
    - In `next.config.ts` or a CI check script, add a build-time assertion that no environment variable prefixed with `NEXT_PUBLIC_` has a name matching `NEXT_PUBLIC_SMARTAPI_*`, `NEXT_PUBLIC_UPSTOX_*`, or `NEXT_PUBLIC_ENCRYPTION_*`
    - Build terminates with non-zero exit if any such variable is set
    - _Requirements: 21.6_

  - [x] 16.2 Audit `GET /api/data/providers/health` and `GET /monitoring/health` for credential leakage
    - Read both route handlers and confirm responses include only `id`, `status`, `lastSuccessAt`, `latencyMs`, `successRate`, `requestCount`, `errorCount` (TypeScript) and `status`, `lastSuccess`, `lastFailure`, `requestCount`, `successCount`, `failureCount`, `latencyP50`/`P95`/`P99` (Python)
    - Confirm no field whose name or value matches a credential, token, API key, or secret is serialized in either response
    - _Requirements: 12.5, 15.5, 21.2_

- [x] 17. Phase 4j — Certification Reports

  - [x] 17.1 Update `DATA_SERVICE_MIGRATION_REPORT.md`
    - Record before/after state for each of the 13 violation sites
    - Each entry: file path, original import/call, replacement call, test name that verifies the migration passes
    - No violation site may be marked MIGRATED without a passing test reference
    - _Requirements: 23.5_

  - [x] 17.2 Update `DATA_SERVICE_TEST_PLAN.md`
    - List every test (unit, property, integration) with: ID, description, expected outcome, PASS/FAIL/SKIP status
    - Zero tests may remain in a pending or unexecuted state
    - _Requirements: 23.2_

  - [x] 17.3 Verify `DATA_SERVICE_ARCHITECTURE.md` reflects post-refactor state
    - Confirm all sections describe components that exist in the v9.0 codebase
    - Confirm no section describes the old direct-import flows or the removed `"3m"` timeframe as supported
    - _Requirements: 23.3_

  - [x] 17.4 Verify `DATA_SERVICE_API.md` completeness
    - Confirm every endpoint, request parameter, and response schema in the document matches code inspection
    - Confirm no endpoint in code is absent from the document; no `"3m"` appears in any example
    - _Requirements: 23.4_

- [x] 18. Final Checkpoint — Run full test suite and static analysis
  - Run `npm run lint` and `npm test` — both must exit zero
  - Run `npx prisma generate` — must succeed
  - Run the canonical-import-guard test and confirm output includes `Documented exceptions: 5 files` and zero violation findings
  - Grep `src/ worker/src/ data-service/src/ ml-service/src/` for `"3m"` — confirm zero matches outside permitted past-tense V8 comments
  - Ask the user if questions arise before issuing the final certification document.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they validate correctness properties but are not required for the boundary enforcement to hold.
- All property-based tests use [fast-check](https://github.com/dubzzz/fast-check) (TypeScript) or [Hypothesis](https://hypothesis.readthedocs.io/) (Python), each running a minimum of 100 iterations.
- The five Documented_Exception files (`src/services/india/scanner/engine.ts`, `src/features/india/expiry-trades/builder.ts`, `src/app/api/in/scanner/**`, `src/app/api/in/expiry-trades/**`, `src/features/india/scalping/strategies/positioning.ts`) retain direct Angel One calls for broker microstructure analytics (`getPutCallRatio`, `getOiBuildup`, `getTopGainersLosers`) with `// eslint-disable-next-line no-restricted-imports` plus a `DATA_SERVICE_PRE_REFACTOR_AUDIT.md` reference comment.
- The `DataProvenance` type is added to `src/lib/market-data/types.ts` — no new file is required.
- Database migrations must use idempotent DDL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`).
- The `DATA_SERVICE_FINAL_CERTIFICATION.md` document (LEVEL 3) should only be issued after Task 18 passes in its entirety.
- Checkpoints (Tasks 2, 4, 6, 14, 18) are not implementation tasks; they are human review gates.

---

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["1.1", "1.3", "1.4", "7.1"]
    },
    {
      "id": 1,
      "tasks": ["1.2", "1.5", "3.1", "3.2", "3.4", "8.1"]
    },
    {
      "id": 2,
      "tasks": ["3.3", "3.5", "5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "8.2", "7.2"]
    },
    {
      "id": 3,
      "tasks": ["5.8", "8.3", "9.1", "10.1", "11.1", "12.1"]
    },
    {
      "id": 4,
      "tasks": ["9.2", "9.3", "10.2", "11.2", "12.2", "13.1", "15.1", "16.1", "16.2"]
    },
    {
      "id": 5,
      "tasks": ["13.2", "15.2", "15.3", "15.4"]
    },
    {
      "id": 6,
      "tasks": ["17.1", "17.2", "17.3", "17.4"]
    }
  ]
}
```
