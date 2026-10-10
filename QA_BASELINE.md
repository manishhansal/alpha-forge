# AlphaForge QA Baseline

**Last Updated:** 2026-10-09
**Performed By:** Independent QA Agent (Kiro)

---

## Repository State (Latest)

| Item | Value |
|------|-------|
| Branch | `fix/bugs` (merged → `master` via PR #39) |
| HEAD Commit | `3fe6281` — Merge PR #39 from `manishhansal/fix/bugs` |
| Working Tree | Clean |
| Remote | `origin` → `https://github.com/manishhansal/alpha-forge.git` |
| PRs Merged (this cycle) | #37 (refactor/alpha-forge), #38 (fix/bugs), #39 (fix/bugs) |

---

## Environment

| Item | Value |
|------|-------|
| Node.js | v22.17.1 |
| npm | 11.4.2 |
| Package Manager | npm |
| Package Name | `alphaforge` v0.1.0 |
| Next.js | 16.3.1 (Turbopack) |
| Database | PostgreSQL 17 via `DATABASE_URL` env var |
| Cache | Redis 7 via `REDIS_URL` env var |

---

## Data Service Configuration

| Item | Value |
|------|-------|
| data-service2.0 URL | `DATA_SERVICE_2_URL` or `DATA_SERVICE_URL` env var (default: `http://localhost:8200`) |
| data-service2.0 API Key | `DATA_SERVICE_API_KEY` env var |
| SentinelPulse URL | `SENTINEL_PULSE_URL` env var (default: `http://localhost:3001`) |
| SentinelPulse API Key | `SENTINEL_PULSE_API_KEY` env var |
| Architecture | AlphaForge → data-service2.0 → Market Data; AlphaForge → SentinelPulse → News |

---

## QA Cycle History

### Cycle 1 — 2026-09-15 (PR #36 baseline)

**Branch / Commit at start:** `refactor/alpha-forge` @ `d8d4fea`

| Metric | Before Fixes | After Fixes |
|--------|-------------|-------------|
| Test Files | 182 passed | 182 passed |
| Tests | 2434 passed, 14 skipped, 0 failed | 2434 passed, 14 skipped, 0 failed |
| TypeScript Errors | 0 | 0 |
| Lint Errors | 73 | **0** |
| Lint Warnings | 286+ | **0** |
| Build | SUCCESS | SUCCESS |

**Issues found and fixed:**
1. **Lint errors (73):** React compiler violations, `require()` imports in tests, `prefer-const`, `no-explicit-any`, unused variables
2. **Stale env vars:** `NEXT_PUBLIC_BINANCE_WS`, `NEXT_PUBLIC_BYBIT_WS`, `NEXT_PUBLIC_DELTA_WS` in `env.ts` — removed
3. **Dead code:** `RangeExpansionSection`, `TopPicksSection`, `ScannerHit` in `msb-dashboard.tsx` — removed
4. **Obsolete reports:** 103 files in `reports/`, 12 root-level migration docs — deleted
5. **Docker build:** Missing `.dockerignore`, non-standalone output, prebuild hook running inside image — all fixed
6. **WebSocket 403:** API key not sent on WS connections — fixed with `X-API-KEY` header / `?api_key=` param

---

### Cycle 2 — 2026-09-16 (PR #38 — SentinelPulse integration)

**Branch / Commit at start:** `fix/bugs` @ `76d5fe8`

**Changes introduced:**
- RSS feed stack (`feeds.ts`, `rss.ts`) replaced with SentinelPulse client + service
- News types rewritten for SentinelPulse wire shapes
- `INDIA_AI_SIGNALS` news factor updated to use `importanceScore`-weighted sentiment
- UI news hook and components updated for new `NewsItem` shape
- `api/in/news` routes expanded (latest, market-india, regime, context, high-impact)
- SentinelPulse env vars added to `.env.example` and `docker-compose.yml`
- Simulated market data module added (`src/lib/data-service/simulated-india.ts`)
- API routes fall back to simulated data when data-service2.0 has no live upstream
- MSB-OB Intraday Signals section removed (external CSV dependency)
- Auto-rebuild & redeploy system added (`scripts/deploy.sh`, `Makefile`, git hooks)

**SentinelPulse filter fix:** Internal test-pipeline articles (`source: "SentinelPulse Internal"`) are excluded — prevents bogus news items in the signal feed.

**Docker hostname fix:** App container was calling `localhost:3001` for SentinelPulse; fixed to use `SENTINEL_PULSE_URL` from env (which resolves correctly inside Docker).

---

### Cycle 3 — 2026-09-17/18 (PR #37 rebase fixes + PR #39)

**Branch / Commit at start:** `fix/bugs` @ `82499c7`

**Issues found and fixed:**

| # | Issue | Fix | File(s) |
|---|-------|-----|---------|
| 1 | Stale tick data — `ltp = 0` overwriting valid snapshot prices | `ltp > 0` guard in WS gateway and `toTick()` | `gateway.ts`, `india-ticker-bar.tsx` |
| 2 | Market snapshot `changePct` null for FIN NIFTY / MIDCAP / SENSEX / VIX | `.every` → `.some` guard — enriches each index individually | `market-snapshot/route.ts` |
| 3 | Ticker renders blank until HTTP poll completes | SSE tick-based pre-snapshot seed added | `india-ticker-bar.tsx` |
| 4 | Heatmap loads once and never refreshes | 30 s auto-refresh interval added | `india-heatmap.tsx` |
| 5 | India overview serving up to 30 s stale data | `Cache-Control: no-store` on all relevant API routes | Multiple `api/in/` routes |
| 6 | NSE display names sent to data-service2.0 instead of underlying symbols | Routes now send canonical NSE symbols | `api/in/market` routes |
| 7 | Historical close not shown when market is closed | Fallback to last historical close for all indices | `market-snapshot/route.ts` |
| 8 | WS streams not reconnecting after disconnect | Exponential-backoff reconnect logic added | `gateway.ts` |
| 9 | data-service request timeout too aggressive (10 s) | Reduced to 4 s | data-service client |
| 10 | ta-lib Python wheel failing in ML Dockerfile | Build ta-lib C library from source (0.7.1 tarball) | `ml-service/Dockerfile` |

---

## Current State (HEAD `ffcaaab` — PR #44)

| Metric | Value |
|--------|-------|
| TypeScript Errors | **0** |
| Lint Errors | **0** |
| Lint Warnings | **0** |
| Tests | **2434 passed, 14 skipped, 0 failed** (last verified PR #39; PRs #40–44 are non-test changes) |
| Build | **SUCCESS** |

---

## QA Cycle 4 — 2026-10-09 (PRs #40–44 — ML Integration)

**Branch / Commit at start:** `fix/bugs` @ `ae09ec7` (PR #40 base)
**HEAD at end:** `ffcaaab` (Merge PR #44)

**Changes introduced (PRs #40–44):**

| PR | Key Changes |
|----|-------------|
| #40 | Docs update for PRs #37–39 state |
| #41 | MetaDecisionEngine wired as Stage 12 of Opportunity Engine; ml-client.ts upgraded to v2 endpoints with X-API-KEY; `ml-service/` directory deleted; stale ml-service v1 docs and reports deleted (~180 files) |
| #42 | Docs update — README, ARCHITECTURE.md, ALPHAFORGE_FINAL_CODEBASE_INVENTORY.md updated for standalone ml-service2.0 |
| #43 | ML Signals page (`/in/ml-signals`) — live LightGBM scores, history tab with date picker, autorun log view |
| #44 | ML Signals enhancements: sector column + filter, NIFTY bias indicator, sector movers, F&O gainers/losers; deploy.sh fix |

**Issues found and fixed (PRs #41–44):**

| # | Issue | Fix | File(s) |
|---|-------|-----|---------|
| 1 | `/api/in/ml-predictions` calling `/models/status` without auth | Added `/v2/` prefix + `X-API-KEY` header | `api/in/ml-predictions/route.ts` |
| 2 | ml-service Docker hostname: `ml-service:8100` not resolving in containers | Remapped to `host.docker.internal:8100` | `deploy.sh`, `.env.docker` |
| 3 | ML Signals history tab: no fallback when market closed | Auto-fallback to last session + market-closed banner | `ml-signals/route.ts`, `ml-signals-board.tsx` |
| 4 | Context NIFTY quote sourced from scanner hits (stale) | Direct `getQuotes()` call for NIFTY + parallel fetch | `ml-signals/route.ts` |

**Architecture guards verified:**

| Guard | Status |
|-------|--------|
| No direct broker/exchange imports | ✅ Active (`eslint.config.mjs`) |
| ml-service2.0 calls all use X-API-KEY header | ✅ Verified in `ml-client.ts` |
| ML_MODE=fallback — graceful degradation | ✅ All ML endpoints handle unavailability |
| Redis cache keys for ML endpoints | ✅ `ml:signals:*` (30s–60s TTL) |

---

## Architecture Guards Active

| Guard | Mechanism | Status |
|-------|-----------|--------|
| No direct broker/exchange imports | `eslint.config.mjs` `no-restricted-imports` | ✅ Active |
| NSE provider elimination | `tests/lib/market-data/nse-elimination.test.ts` (12 tests) | ✅ Active |
| DB schema (no market data tables) | `tests/runtime/db-schema-guard.test.ts` | ✅ Active |
| Provider zero-access regression | `tests/runtime/provider-zero-access.test.ts` | ✅ Active |
| NEXT_PUBLIC credential leak prevention | `next.config.ts` build guard | ✅ Active |
| Live promotion requires human approval | `src/lib/research/promotion/` | ✅ Active |
