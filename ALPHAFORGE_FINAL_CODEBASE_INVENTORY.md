# AlphaForge Final Codebase Inventory

**Date:** 2026-09-15 | **Branch:** `refactor/alpha-forge` | **Commit:** `d8d4fea` + QA fixes

## Directory Classification

| Directory | Classification | Description |
|-----------|---------------|-------------|
| `src/app/` | **KEEP** | Next.js App Router pages and API routes |
| `src/app/(auth)/` | **KEEP** | Login/signup pages |
| `src/app/(dashboard)/` | **KEEP** | All dashboard pages (70 routes) |
| `src/app/api/` | **KEEP** | All API routes |
| `src/app/api/in/` | **KEEP** | Indian market API routes |
| `src/app/api/v1/market/` | **KEEP** | Canonical v1 market data API (proxies to data-service2.0) |
| `src/components/` | **KEEP** | All UI components |
| `src/features/` | **KEEP** | Business logic features |
| `src/hooks/` | **KEEP** | React hooks |
| `src/lib/` | **KEEP** | Core library code |
| `src/lib/data-service/` | **KEEP** | Canonical data-service2.0 client |
| `src/lib/backtesting-v2/` | **KEEP** | Backtesting engine |
| `src/lib/signal-intelligence/` | **KEEP** | Signal intelligence engine |
| `src/lib/market-data/` | **KEEP** (types only) | Market data type definitions (no provider implementations) |
| `src/services/brokers/` | **KEEP** | Broker client (connected to data-service2.0) |
| `src/services/india/angelone/` | **KEEP** | Angel One EXECUTION client (portfolio/orders only) |
| `src/services/india/broker/` | **KEEP** | Broker execution factory/adapter |
| `src/services/india/scanner/` | **KEEP** | Scanner engine (consumes data-service2.0) |
| `src/services/india/signals/` | **KEEP** | Signal snapshotter |
| `src/services/india/websocket/` | **KEEP** | WebSocket gateway (connects to data-service2.0) |
| `src/store/` | **KEEP** | Zustand state stores |
| `src/types/` | **KEEP** | TypeScript type definitions |
| `worker/` | **KEEP** | Background worker (all jobs use data-service2.0) |
| `worker/src/jobs/liquidations.ts` | **KEEP** | Liquidations via data-service2.0 WebSocket |
| `worker/src/jobs/scraping-tick-listener.ts` | **KEEP** (no-op stub) | No-op — tick listening moved to data-service2.0 |
| `prisma/` | **KEEP** | Database schema (no market data tables) |
| `tests/` | **KEEP** | Test suite |
| `e2e/` | **KEEP** | E2E test specs |
| `docs/` | **KEEP** | Architecture docs, ML docs |
| `reports/` | **KEEP** (new) | Final QA reports from this cycle only |
| `scripts/` | **KEEP** | Utility scripts |
| `ml-service/` | **KEEP** | ML service integration |
| `public/` | **KEEP** | Static assets |

## Deleted Directories/Files

| Item | Reason |
|------|--------|
| `src/lib/market-data/providers/` | Deleted — all providers moved to data-service2.0 |
| `src/lib/market-data/registry.ts` | Deleted — ProviderRegistry removed |
| `src/lib/market-data/services/` | Deleted — provider service adapters removed |
| `src/services/india/yahoo/` | Deleted — Yahoo adapter removed |
| `src/services/india/nse/` | Deleted — NSE direct access removed |
| `src/services/binance/` | Deleted — Binance adapter removed |
| `src/services/deribit/` | Deleted — Deribit adapter removed |
| `src/services/coingecko/` | Deleted — CoinGecko direct access removed |
| Old `reports/*.md` (103 files) | Deleted — interim/obsolete migration reports |
| `ALPHAFORGE.md`, `CHANGES.md`, `CLAUDE.md`, etc. | Deleted — stale docs |

## Current File Counts

| Category | Files |
|----------|-------|
| Source (src/) | 699 |
| Tests (tests/) | 187 |
| Worker (worker/) | 23 |
| E2E (e2e/) | 3 |
| Prisma | 24 |
| Config files | 8 |
| Total (source + tests) | 909+ |

## Key Architecture Files

| File | Purpose |
|------|---------|
| `src/lib/data-service/client.ts` | **THE** market data entry point — all consumers import from here |
| `src/lib/data-service/types.ts` | DataServiceUnavailableError and all market data types |
| `src/lib/data-service/gate-client.ts` | Gated client with circuit breaker |
| `src/lib/env.ts` | Environment variable schema (no stale provider WS vars) |
| `eslint.config.mjs` | ESLint config with `no-restricted-imports` boundary rule |
| `prisma/schema.prisma` | Database schema — 17 tables, 0 market data tables |
| `prisma/migrations/20260914000000_drop_market_data_tables/migration.sql` | Drops 18 market data tables |
| `worker/src/jobs/liquidations.ts` | Liquidations via data-service2.0 (not direct Binance) |
| `worker/src/jobs/scraping-tick-listener.ts` | No-op stub (ticks moved to data-service2.0) |
