# AlphaForge QA Baseline

**QA Cycle Started:** 2026-09-15  
**Performed By:** Independent QA Agent (Kiro)

## Repository State

| Item | Value |
|------|-------|
| Branch | `refactor/alpha-forge` |
| HEAD Commit | `d8d4fea` — Merge PR #36 from refactor/data-service-centralization |
| Working Tree | Clean at start; modified during QA fixes |
| Remote | `origin` → `https://github.com/manishhansal/alpha-forge.git` |

## Environment

| Item | Value |
|------|-------|
| Node.js | v22.17.1 |
| npm | 11.4.2 |
| Package Manager | npm |
| Package Name | `alphaforge` v0.1.0 |
| Next.js | 16.3.1 (Turbopack) |
| Database | PostgreSQL via `DATABASE_URL` env var |
| Cache | Redis via `REDIS_URL` env var |

## Data Service Configuration

| Item | Value |
|------|-------|
| data-service2.0 URL | `DATA_SERVICE_2_URL` or `DATA_SERVICE_URL` env var (defaults: `http://localhost:8200`) |
| API Key | `DATA_SERVICE_API_KEY` env var |
| Architecture | AlphaForge → data-service2.0 → Market Data |

## Baseline Test Results (Before Fixes)

| Metric | Value |
|--------|-------|
| Test Files | 182 passed |
| Tests | 2434 passed, 14 skipped, 0 failed |
| TypeScript Errors | 0 |
| Lint Errors | 73 (before fixes) |
| Lint Warnings | 286+ (before fixes) |
| Build | SUCCESS |

## Issues Found At Baseline

1. **Lint errors (73)**: React compiler violations, `require()` imports in tests, `prefer-const`, `no-explicit-any`, unused variables
2. **Stale env vars**: `NEXT_PUBLIC_BINANCE_WS`, `NEXT_PUBLIC_BYBIT_WS`, `NEXT_PUBLIC_DELTA_WS` in env.ts — never consumed, leftover from pre-centralization
3. **Dead code**: `RangeExpansionSection`, `TopPicksSection`, `ScannerHit` in msb-dashboard.tsx (unused components)
4. **Obsolete reports**: 103 files in `reports/`, 12 root-level migration docs — all superseded
5. **Obsolete env vars**: `SMARTAPI_*` in `.env.local` — legitimate (Angel One execution broker)

## Post-Fix State (This QA Cycle)

| Metric | Value |
|--------|-------|
| TypeScript Errors | 0 |
| Lint Errors | 0 |
| Lint Warnings | 0 |
| Tests | 2434 passed, 14 skipped, 0 failed |
| Build | SUCCESS |
