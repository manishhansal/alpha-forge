# AlphaForge Final Codebase Inventory

**Date:** 2026-09-22 | **Branch:** `fix/bugs` | **HEAD Commit:** `3fe6281` (Merge PR #39)

## Directory Classification

| Directory | Classification | Description |
|-----------|---------------|-------------|
| `src/app/` | **KEEP** | Next.js App Router pages and API routes |
| `src/app/(auth)/` | **KEEP** | Login/signup pages |
| `src/app/(dashboard)/` | **KEEP** | All dashboard pages (70 routes) |
| `src/app/api/` | **KEEP** | All API routes |
| `src/app/api/in/` | **KEEP** | Indian market API routes |
| `src/app/api/in/news/` | **KEEP** | SentinelPulse news routes (latest, market-india, regime, context, high-impact) |
| `src/app/api/v1/market/` | **KEEP** | Canonical v1 market data API (proxies to data-service2.0) |
| `src/components/` | **KEEP** | All UI components |
| `src/features/` | **KEEP** | Business logic features |
| `src/features/india/news/` | **KEEP** | SentinelPulse client + service (replaces RSS stack) |
| `src/hooks/` | **KEEP** | React hooks |
| `src/lib/` | **KEEP** | Core library code |
| `src/lib/data-service/` | **KEEP** | Canonical data-service2.0 client + simulated fallback |
| `src/lib/data-service/client.ts` | **KEEP** | Single market data entry point (server-only) |
| `src/lib/data-service/simulated-india.ts` | **KEEP** | Realistic synthetic fallback for dev/staging |
| `src/lib/backtesting-v2/` | **KEEP** | Backtesting engine |
| `src/lib/signal-intelligence/` | **KEEP** | Signal intelligence engine |
| `src/lib/market-data/` | **KEEP** (types only) | Market data type definitions (no provider implementations) |
| `src/services/brokers/` | **KEEP** | Broker client (browser WS factory, appends ?api_key= for data-service2.0) |
| `src/services/india/angelone/` | **KEEP** | Angel One EXECUTION client (portfolio/orders only — no market data) |
| `src/services/india/broker/` | **KEEP** | Broker execution factory/adapter |
| `src/services/india/scanner/` | **KEEP** | Scanner engine (consumes data-service2.0 + simulated fallback) |
| `src/services/india/signals/` | **KEEP** | Signal snapshotter |
| `src/services/india/websocket/` | **KEEP** | WebSocket gateway (connects to data-service2.0, ltp > 0 guard) |
| `src/store/` | **KEEP** | Zustand state stores |
| `src/types/` | **KEEP** | TypeScript type definitions |
| `worker/` | **KEEP** | Background worker (all jobs use data-service2.0) |
| `worker/src/jobs/liquidations.ts` | **KEEP** | Liquidations via data-service2.0 WebSocket |
| `worker/src/jobs/scraping-tick-listener.ts` | **KEEP** (no-op stub) | No-op — tick listening moved to data-service2.0 |
| `prisma/` | **KEEP** | Database schema (no market data tables) |
| `tests/` | **KEEP** | Test suite |
| `e2e/` | **KEEP** | E2E test specs |
| `docs/` | **KEEP** | Architecture docs, ML docs |
| `scripts/` | **KEEP** | Utility scripts (deploy.sh, install-hooks.sh, git-hooks/post-commit) |
| `ml-service/` | **KEEP** | ML service (ta-lib built from source in Dockerfile) |
| `public/` | **KEEP** | Static assets |
| `.kiro/hooks/` | **KEEP** | Kiro IDE hooks (docker-redeploy-on-commit.json) |
| `Makefile` | **KEEP** | Local Docker workflow + auto-deploy targets |

## Deleted Directories/Files

| Item | Reason |
|------|--------|
| `src/features/india/news/feeds.ts` | Deleted — RSS feed catalogue replaced by SentinelPulse |
| `src/features/india/news/rss.ts` | Deleted — hand-rolled XML parser replaced by SentinelPulse |
| `src/components/india/msb-dashboard/MsbSignalsSection` | Deleted — depended on external Python scanner CSV not in deployment |
| `src/components/india/msb-dashboard/SideBadge` | Deleted — only used by removed MsbSignalsSection |
| `src/lib/market-data/providers/` | Deleted — all providers moved to data-service2.0 |
| `src/lib/market-data/registry.ts` | Deleted — ProviderRegistry removed |
| `src/lib/market-data/services/` | Deleted — provider service adapters removed |
| `src/services/india/yahoo/` | Deleted — Yahoo adapter removed |
| `src/services/india/nse/` | Deleted — NSE direct access removed |
| `src/services/binance/` | Deleted — Binance adapter removed |
| `src/services/deribit/` | Deleted — Deribit adapter removed |
| `src/services/coingecko/` | Deleted — CoinGecko direct access removed |
| Old `reports/*.md` (103 files) | Deleted — interim/obsolete migration reports |
| `ALPHAFORGE.md`, `CHANGES.md`, `CLAUDE.md` | Deleted — stale docs replaced by this inventory + README |
| `data-service/` (old scrapling service) | Deleted — replaced by data-service2.0 (separate stack) |
| Stale root-level migration docs (12 files) | Deleted — superseded |
| `STALE_ENV_VARS`: `NEXT_PUBLIC_BINANCE_WS`, `NEXT_PUBLIC_BYBIT_WS`, `NEXT_PUBLIC_DELTA_WS` | Removed from `env.ts` — never consumed post-centralization |

## Key New Files (PR #37–#39)

| File | PR | Purpose |
|------|----|---------|
| `src/lib/data-service/simulated-india.ts` | #37 | Realistic synthetic market data for dev/staging |
| `src/features/india/news/sentinel-client.ts` | #38 | Typed SentinelPulse HTTP client |
| `src/components/india/DataSourceBadge.tsx` | #38/#39 | LIVE / SIMULATED badge in UI |
| `scripts/deploy.sh` | #38 | Core auto-rebuild + redeploy logic |
| `scripts/install-hooks.sh` | #38 | One-command git hook installer |
| `scripts/git-hooks/post-commit` | #38 | Smart diff-based post-commit trigger |
| `.kiro/hooks/docker-redeploy-on-commit.json` | #38 | Kiro IDE hook — surfaces deploy.log after commits |
| `Makefile` | #38 | `deploy`, `deploy-app`, `deploy-worker`, `deploy-ml`, `deploy-log`, `watch-deploy`, `install-hooks` |
| `docs/AUTO_DEPLOY.md` | #38 | Auto-deploy system reference documentation |

## Live Data Fixes (PR #37 + #39)

| Fix | File(s) |
|-----|---------|
| Exponential-backoff reconnect on data-service2.0 WS disconnect | `src/services/india/websocket/gateway.ts` |
| Historical close fallback for all indices when market is closed | `src/app/api/in/market-snapshot/route.ts` |
| Numeric field normalisation for Indian quotes (string→number coercion) | data-service client layer |
| NSE underlying symbols sent to data-service2.0 (not display names) | `src/app/api/in/*` routes |
| Stale tick data resolved — `ltp > 0` guard in WS gateway and ticker bar | `src/services/india/websocket/gateway.ts`, `src/components/india/ticker/india-ticker-bar.tsx` |
| Market snapshot partial `changePct` bug — `.every` → `.some` for individual enrichment | `src/app/api/in/market-snapshot/route.ts` |
| Heatmap 30 s auto-refresh (was: load-once on mount) | `src/components/india/heatmap/india-heatmap.tsx` |
| Cache-Control: `no-store` on all India API routes that were serving stale data | Multiple `src/app/api/in/` routes |
| Docker `--chown` on COPY + AUTH_SECRET sync from `.env.local` | `Dockerfile.app` |
| ta-lib compiled from source in ML service Dockerfile | `ml-service/Dockerfile` |

## Current File Counts

| Category | Files |
|----------|-------|
| Source (`src/`) | ~710 |
| Tests (`tests/`) | 187 |
| Worker (`worker/`) | 23 |
| E2E (`e2e/`) | 3 |
| Prisma | 24 |
| Scripts (`scripts/`) | 4 |
| Config files | 9 |
| **Total (source + tests)** | **~920+** |

## Key Architecture Files

| File | Purpose |
|------|---------|
| `src/lib/data-service/client.ts` | **THE** market data entry point — all consumers import from here |
| `src/lib/data-service/simulated-india.ts` | Synthetic fallback — auto-used when data-service2.0 has no live upstream |
| `src/lib/data-service/types.ts` | `DataServiceUnavailableError` and all market data types |
| `src/lib/data-service/gate-client.ts` | Gated client with circuit breaker |
| `src/features/india/news/sentinel-client.ts` | SentinelPulse typed HTTP client |
| `src/features/india/news/index.ts` | News service — `getIndiaNews()`, Redis cache (`sp:news:*` 90s, `sp:market:india` 60s) |
| `src/lib/env.ts` | Environment variable schema (no stale provider WS vars) |
| `eslint.config.mjs` | ESLint config with `no-restricted-imports` boundary rule |
| `prisma/schema.prisma` | Database schema — 18 models, 0 market data tables |
| `Makefile` | Local Docker workflow + auto-deploy system |
| `scripts/deploy.sh` | Core rebuild + redeploy logic |
| `worker/src/jobs/liquidations.ts` | Liquidations via data-service2.0 (not direct Binance) |
| `worker/src/jobs/scraping-tick-listener.ts` | No-op stub (ticks moved to data-service2.0) |

## Architecture Invariants (Must Not Regress)

1. **No TypeScript file imports directly from Angel One, Upstox, Yahoo Finance, NSE, Binance, Deribit, CoinGecko** — enforced by `eslint.config.mjs` `no-restricted-imports` rule and 12 guard tests in `tests/lib/market-data/nse-elimination.test.ts`
2. **All market data flows through `src/lib/data-service/client.ts`** — server-only, never imported by browser code
3. **All news intelligence flows through `src/features/india/news/`** — SentinelPulse only, no RSS/scraping
4. **`NEXT_PUBLIC_*` credentials must not be exposed in the build** — enforced by `next.config.ts` credential guard
5. **LIVE promotion always requires a human `approvalToken`** — never automatic, enforced in `src/lib/research/promotion/`
