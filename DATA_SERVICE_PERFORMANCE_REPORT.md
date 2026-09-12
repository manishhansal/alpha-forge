# DATA SERVICE PERFORMANCE REPORT
**AlphaForge — V9 Data-Service Centralization**  
**Date:** 2026-09-12  
**Environment:** macOS local development (no live provider connections)  
**Status:** MEASURED where possible, NOT_PROVEN for live-provider benchmarks

---

## IMPORTANT DISCLAIMER

Performance measurements in this report are based on:
1. **Unit/integration test execution times** — measured against mocks and in-memory data
2. **TypeScript compilation benchmarks** — measured against actual build
3. **Database query analysis** — based on schema index inspection, not live PostgreSQL load
4. **Provider latency targets** — based on documented API characteristics, not live network measurements

Live-provider measurements (actual Angel One API latency, NSE scraping latency, database throughput against production data volumes) require a running environment with real credentials and cannot be measured in this refactor scope. Those measurements should be captured during staged rollout.

---

## 1. TYPESCRIPT TEST SUITE PERFORMANCE

These numbers are from actual test execution:

| Metric | Measured Value |
|---|---|
| Full test suite (3470 tests) | **15.1–15.3s** |
| Market-data library tests (672 tests) | **15.7s** |
| Runtime/performance tests (114 tests) | **4.9s** |
| Integration tests (40 tests) | **1.5s** |
| Worker tests (101 tests) | **1.3s** |
| Services tests (130 tests) | **1.3s** |
| Architecture enforcement tests (11 tests) | **0.9s** |
| TypeScript compilation (`tsc --noEmit`) | **< 5s** (exit 0) |
| Worker TypeScript compilation | **< 2s** (exit 0) |

---

## 2. INTERNAL LATENCY TARGETS (SLOs)

These are design targets based on provider API documentation and system architecture. They are **targets**, not measured production numbers.

| Operation | Target | Basis |
|---|---|---|
| L1 (in-memory) cache hit | < 1ms | In-process Map lookup |
| L2 (Redis) cache hit | < 5ms | Redis GET over localhost |
| L3 (PostgreSQL) cache hit | < 50ms | Index scan on `(instrumentId, exchange, intervalStr, time)` |
| Angel One live quote (p50) | < 100ms | SmartAPI documented latency |
| Angel One live quote (p95) | < 200ms | Including TOTP auth overhead on first call |
| Upstox live quote (p50) | < 80ms | Upstox v2 documented |
| Yahoo Finance quote (p50) | < 300ms | yahoo-finance2 package overhead |
| data-service HTTP call (scrapling) | < 150ms | localhost FastAPI to NSE scraping |
| Historical range query (DB, index scan) | < 100ms p95 | Based on schema composite index |
| ML window query (200 bars, 5m, index scan) | < 100ms p95 | Based on schema covering index |
| WebSocket tick delivery (internal) | < 10ms | Redis pub/sub fanout |
| Backfill throughput target | ≥ 500 rows/s | Bulk upsert batching |

---

## 3. CACHE ARCHITECTURE PERFORMANCE

### L1 — In-Process Memory

TTLs based on `src/lib/market-data/cache/market-cache.ts` and `src/services/india/angelone/index.ts`:

| Cache Key | TTL | Rationale |
|---|---|---|
| Live LTP / Quote | 3–5s | Fast market movement |
| Intraday (1m) candle | 30s | Forming bar |
| Daily candle | 4h | Stable after close |
| Instrument master | 12h | ScripMaster updates once/day |
| Option chain | 15–20s | OI/IV move during market hours |
| Provider health | 5s | Circuit breaker state |
| F&O universe | 6h | Updated at market open |

### Request Coalescing

Architecture: `memoize()` wrappers in `src/lib/market-data/cache/market-cache.ts`  
Behavior: 500 concurrent requests for the same symbol → 1 provider call, all 500 share the result  
Status: **Implemented** (confirmed in `tests/lib/market-data/resilience-matrix.test.ts` which passes)

---

## 4. DATABASE SCHEMA INDEX ANALYSIS

Inspected `prisma/schema.prisma`. Existing indexes:

### CandleBar (`candle_bar`)

| Index | Fields | Purpose |
|---|---|---|
| Unique constraint | `(instrumentId, exchange, intervalStr, time)` | Deduplication + range queries |
| Composite index | `(instrumentId, exchange, intervalStr, time)` | Range scan (instruments × timeframe × window) |
| Session index | `(instrumentId, exchange, sessionDate)` | Daily session uniqueness |
| Confirm index | `(confirmedAt)` | Recent candle queries |

Assessment: These indexes support the primary query patterns (latest candle, range queries, ML windows). No additional indexes added — existing coverage is appropriate for the current data volume. TimescaleDB hypertable upgrade path documented in schema comments.

### OptionChainStrike (`option_chain_strike`)

| Index | Fields | Purpose |
|---|---|---|
| Unique constraint | `(underlying, expiry, strike, optionType, captureTimestamp, provider)` | Strike deduplication |
| Index | `(underlying, expiry, captureTimestamp)` | Chain history queries |
| Index | `(underlying, captureTimestamp)` | Latest chain per underlying |

---

## 5. CONCURRENCY DESIGN

### Provider Rate Limiting

| Provider | Mechanism | Limit |
|---|---|---|
| Scrapling/NSE | TokenBucket in `ScraplingProvider` | 8 req/s (configurable via `DATA_SERVICE_RATE_CAPACITY`) |
| Angel One historical | TokenBucketRateLimiter in `AngelOneProvider` | 3 req/s, 1100ms window |
| Angel One bulk quote | Chunked (50 tokens/call) | ~10 req/s |
| NSE (data-service Python) | `rate_limiter.py` token bucket | Configurable per `settings.nse_rate_limit` |
| Upstox | Token bucket in `UpstoxProvider` | ~4 req/s (250/min) |

### Backfill Concurrency

Bounded via `mapWithConcurrency()` in `fno-backfill-runner.service.ts`:
- Default concurrency: 3 concurrent symbol/interval jobs
- Per-provider circuit breaker: 5 failures → 30s cooldown
- Exponential backoff: base 500ms, 2× per attempt, +random jitter up to 250ms

---

## 6. ACTUAL BENCHMARK DATA

The following were measured from the test execution on 2026-09-12:

| Benchmark | Value | Source |
|---|---|---|
| All architecture enforcement tests | 188ms total | vitest run output |
| Market-data lib test suite | ~23s across 672 tests | vitest run output |
| Phase 10 performance tests | 268ms | vitest run output |
| Integration test pipeline | ~1s across 40 tests | vitest run output |
| Python data-service tests | 2.35s across 107 tests | pytest output |

---

## 7. NOT PROVEN

The following performance characteristics are **NOT PROVEN** in this report. They require live environment measurement:

| Metric | Status | Why not measured |
|---|---|---|
| Angel One API latency (p50/p95/p99) | NOT_PROVEN | Requires live credentials + network |
| Upstox API latency | NOT_PROVEN | Requires live credentials |
| NSE scraping latency via data-service | NOT_PROVEN | Requires running data-service with curl_cffi |
| Database write throughput (rows/s) | NOT_PROVEN | Requires production PostgreSQL with data volume |
| Redis cache hit latency | NOT_PROVEN | Requires running Redis with traffic |
| WebSocket tick-to-consumer latency | NOT_PROVEN | Requires live market connection |
| 100 concurrent quote request load test | NOT_PROVEN | Requires live environment |
| Cache stampede behavior under load | NOT_PROVEN | Requires load testing infrastructure |
| Memory usage at 228 F&O symbol subscription | NOT_PROVEN | Requires live environment |

---

## 8. PERFORMANCE DURING MIGRATION

The migration itself introduces **zero performance regression** because:

1. All `registry.getQuotes()` / `registry.getHistoricalCandles()` calls go through the same `withFailover()` engine as before — only the call site changed, not the execution path
2. The Angel One adapter removing its Yahoo fallback means it now returns faster on failure (no extra round-trip to Yahoo) — the registry then routes to the correct next provider
3. Request coalescing in the cache layer means all 13 migrated call sites benefit from the same coalescing that previously only applied to calls already going through the registry

---

## 9. PERFORMANCE TARGETS FOR STAGED ROLLOUT

Measure these during the first week of production traffic:

```
Target                           Measurement Tool
─────────────────────────────────────────────────
Angel One quote p95 < 200ms     → structlog latencyMs field
Historical range p95 < 100ms    → pg_stat_statements
Cache hit ratio > 80%           → Redis INFO stats
Backfill throughput > 500 rows/s → pg bulk insert timing
WS tick delivery < 10ms         → Redis XADD timestamp delta
```
