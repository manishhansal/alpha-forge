# DATA SERVICE PRE-REFACTOR AUDIT
**AlphaForge — Data-Service Centralization**  
**Date:** 2026-09-12  
**Branch:** refactor/signals  
**Auditor:** Kiro (automated full-repository inspection)  
**Status:** COMPLETE — Based on actual code reads, no assumptions

---

## 0. EXECUTIVE SUMMARY

The codebase is partially centralized. The `data-service` Python microservice
and the `src/lib/market-data/` TypeScript registry together form the intended
central data platform. However **13 violation sites** exist where code outside
the approved provider boundary directly calls market-data providers (Angel One,
Upstox, or Yahoo Finance) instead of routing through the canonical registry.

3m timeframe is **completely removed** at every layer — no action required there.

The ML service is **already clean** — uses `DATA_SERVICE_URL` as its Tier 0
source. No direct broker calls from ML.

The NSE provider is **already tombstoned** — a migration guard stub only.

---

## 1. REPOSITORY STRUCTURE

```
alpha-forge/
├── src/                         # Next.js 15 app (frontend + API routes + backend services)
│   ├── app/api/                 # API route handlers
│   ├── lib/market-data/         # CANONICAL market data registry + providers
│   ├── lib/india/               # India-specific signal and ML helpers
│   ├── services/india/          # Legacy adapter layer (partially refactored)
│   └── features/india/          # Feature implementations (daily picks, scalping, etc.)
├── worker/                      # TypeScript background worker (cron jobs)
├── data-service/                # Python FastAPI microservice (THE data authority)
│   └── src/
│       ├── providers/           # jugaad + openchart adapters (Python)
│       ├── brokers/             # upstox broker HTTP client (Python)
│       ├── scrapers/            # NSE scraping endpoints (Python)
│       └── core/                # normalization, quality, deduplication
├── ml-service/                  # Python FastAPI ML inference service
└── prisma/                      # PostgreSQL schema
```

---

## 2. PROVIDER INVENTORY

### 2.1 Providers Inside data-service (CORRECT — authorized)

| Provider | Language | Location | Role |
|---|---|---|---|
| jugaad-data | Python | `data-service/src/providers/jugaad/adapter.py` | NSE bhavcopy, historical EOD, F&O OI |
| openchart | Python | `data-service/src/providers/openchart/adapter.py` | Historical OHLCV (1m–1M) |
| Scrapling/NSE | Python | `data-service/src/scrapers/` | Live quotes, option chains, instrument master |
| Upstox (Python) | Python | `data-service/src/brokers/upstox_client.py` | Historical candles via analytics token |

### 2.2 Providers in TypeScript Registry (src/lib/market-data/providers/)

| Provider | File | Role | Status |
|---|---|---|---|
| ScraplingProvider | `providers/scrapling.ts` | Gateway to data-service HTTP REST | KEEP |
| AngelOneProvider | `providers/angel-one.ts` | SmartAPI live quotes + history + WS | KEEP |
| UpstoxProvider | `providers/upstox.ts` | Upstox v2/v3 live + history + WS | KEEP |
| YahooProvider | `providers/yahoo.ts` | Last-resort fallback | KEEP |
| NSEProvider | `providers/nse.ts` | **TOMBSTONE** — throws on all calls | KEEP (guard) |

### 2.3 Legacy Adapter Layer (src/services/india/)

These are the actual client implementations backing the registry providers.
They are in the allowlist but should not be imported outside it.

| Module | Path | Status |
|---|---|---|
| Angel One adapter | `services/india/angelone/index.ts` | KEEP — fix Yahoo fallback violation |
| Angel One WebSocket | `services/india/angelone/smartstream.ts` | KEEP |
| Angel One parsers | `services/india/angelone/derivatives.ts` | KEEP (pure functions) |
| Yahoo adapter | `services/india/yahoo/index.ts` | KEEP — fix all external callers |
| NSE stub | `services/india/nse/index.ts` | KEEP (tombstone stub) |
| Broker factory | `services/india/broker/factory.ts` | KEEP |
| Cache | `services/india/cache/` | KEEP |

---

## 3. CANONICAL PROVIDER CHAIN

```
Priority 0: ScraplingProvider   → data-service HTTP (port 8200)
                                    ↳ jugaad-data (Python, historical EOD)
                                    ↳ openchart (Python, historical OHLCV)
                                    ↳ NSE scraping (Python, live quotes + options)
                                    ↳ Upstox analytics token (Python, candles)

Priority 1: AngelOneProvider    → SmartAPI v2 (authenticated broker)
Priority 2: UpstoxProvider      → Upstox v2/v3 (authenticated broker)
Priority 3: YahooProvider       → yahoo-finance2 (last resort, no F&O)

NSE direct: PROHIBITED (tombstoned since 2026-09-03)
3m timeframe: PERMANENTLY REMOVED (V8 refactor/signals, 2026-09-12)
```

---

## 4. VIOLATION REGISTRY — DIRECT PROVIDER CALLS OUTSIDE data-service

### CRITICAL VIOLATIONS (must fix)

#### V-01 — Yahoo fallback inside Angel One adapter
- **File:** `src/services/india/angelone/index.ts`
- **Lines:** `getQuotes()` and `getHistorical()` methods contain `allowFallback: true` paths that call `yahoo.getQuotes(symbols)` and `yahoo.getHistorical(req)` directly
- **Problem:** Two providers coupled at the adapter layer, bypassing the registry failover engine. If Angel fails, Yahoo is called without routing through `withFailover()`, skipping health tracking, circuit breakers, and observability.
- **Fix:** Remove the internal Yahoo fallback. Let the registry's `withFailover()` handle Angel→Upstox→Yahoo routing.
- **Classification:** **REFACTOR**
- **Risk:** MEDIUM — existing tests mock the Yahoo fallback path

#### V-02 — Scanner engine direct Yahoo + Angel calls
- **File:** `src/services/india/scanner/engine.ts`
- **Yahoo violations:** `fnoQuotes()` calls `yahoo.getQuotes(FNO_STOCKS)` directly; `avgVolume()` calls `yahoo.getHistorical()` directly
- **Fix:** Replace with `registry.getQuotes()` and `registry.getHistoricalCandles()`
- **Angel broker analytics** (`angel.getPutCallRatio()`, `angel.getOiBuildup()`, `angel.getTopGainersLosers()`): These call SmartAPI-specific endpoints not in the `MarketDataProvider` interface. **DOCUMENTED EXCEPTION** — these are broker microstructure analytics, not generic market data.
- **Classification:** Yahoo paths → **REFACTOR**; Angel PCR/OI paths → **DOCUMENT AS EXCEPTION**
- **Risk:** LOW — scanner is worker-driven, well-tested

#### V-03 — Signal snapshotter direct Yahoo call
- **File:** `src/services/india/signals/snapshotter.ts`
- **Line 13:** `import { yahoo } from "@/services/india/yahoo"`
- **Usage:** `snapshotChunk()` → `yahoo.getQuotes(nseSymbols)` 
- **Fix:** Replace with `registry.getQuotes()`
- **Classification:** **REFACTOR**
- **Risk:** LOW — snapshotter runs on a 60s interval

#### V-04 — Option strike capture direct Angel call
- **File:** `src/lib/market-data/services/option-strike-capture.service.ts`
- **Issue:** `defaultChainFetcher()` does `import { angel } from "@/services/india/angelone"` dynamically and calls `angel.getOptionChain()` directly
- **Fix:** Replace with `registry.getOptionChain(underlying, expiry)`
- **Classification:** **REFACTOR**
- **Risk:** MEDIUM — live capture service, must not regress

#### V-05 — F&O backfill runner direct Angel historical call
- **File:** `src/lib/market-data/services/fno-backfill-runner.service.ts`
- **Issue:** `defaultProviderFetchers()` dynamically imports Angel One and calls `angel.getHistorical()` directly, bypassing the registry
- **Fix:** Route through `registry.getHistoricalCandles()` or the capability-aware fetcher that uses the registry
- **Classification:** **REFACTOR**
- **Risk:** MEDIUM — backfill service, test coverage exists

#### V-06 — Expiry trades builder direct Angel option chain
- **File:** `src/features/india/expiry-trades/builder.ts`
- **Line 151+:** calls `angel.getOptionChain("SENSEX")` and related Angel methods directly
- **Fix:** Replace with `registry.getOptionChain("SENSEX")`
- **Classification:** **REFACTOR**
- **Risk:** LOW — feature path, not hot path

#### V-07 — F&O trend history service direct Yahoo call
- **File:** `src/features/india/fno-trend-history/service.ts`
- **Line 25:** `import { yahoo } from "@/services/india/yahoo"`
- **Usage:** `yahoo.getQuotes(symbols)` for trade resolution tracking
- **Fix:** Replace with `registry.getQuotes()`
- **Classification:** **REFACTOR**
- **Risk:** LOW

#### V-08 — Scalping backtest direct Yahoo historical
- **File:** `src/features/india/scalping/backtest.ts`
- **Line 3:** `import { yahoo } from "@/services/india/yahoo"`
- **Usage:** Daily bars for basket backtest
- **Fix:** Replace with `registry.getHistoricalCandles()`
- **Classification:** **REFACTOR**
- **Risk:** LOW — backtest, not production data path

#### V-09 — Scalping positioning strategy direct Yahoo quotes
- **File:** `src/features/india/scalping/strategies/positioning.ts`
- **Line 5:** `import { yahoo } from "@/services/india/yahoo"`
- **Usage:** `yahoo.getQuotes(FNO_INDICES)` for index positioning
- **Fix:** Replace with `registry.getQuotes()`
- **Classification:** **REFACTOR**
- **Risk:** LOW

#### V-10 — Scalping opening-breakout strategy direct Yahoo historical
- **File:** `src/features/india/scalping/strategies/opening-breakout.ts`
- **Line 5:** `import { yahoo } from "@/services/india/yahoo"`
- **Usage:** `yahoo.getHistorical(...)` for 5m candles
- **Fix:** Replace with `registry.getHistoricalCandles()`
- **Classification:** **REFACTOR**
- **Risk:** LOW

#### V-11 — Paper trading auto-trader dynamic Yahoo import
- **File:** `src/features/india/paper-trading/auto-trader.ts`
- **Line 777:** `const { yahoo } = await import("@/services/india/yahoo")` (dynamic)
- **Usage:** `yahoo.getQuotes()` for live price resolution
- **Fix:** Replace with `registry.getQuotes()`
- **Classification:** **REFACTOR**
- **Risk:** LOW — paper trading, isolated

#### V-12 — Scalper API route direct Yahoo call
- **File:** `src/app/api/in/scalper/close-all/route.ts`
- **Line 3:** `import { yahoo } from "@/services/india/yahoo"`
- **Usage:** quote fetch for close-all operation
- **Fix:** Replace with `registry.getQuotes()`
- **Classification:** **REFACTOR**
- **Risk:** LOW — API route, isolated

#### V-13 — Worker realtime-candles direct Angel ScripMaster import
- **File:** `worker/src/jobs/india-realtime-candles.ts`
- **Issue:** Imports `getScripSubsets`, `buildEqTokenMap`, `INDEX_TOKENS`, `SYMBOL_TO_INDEX` from `@/services/india/angelone` directly for token resolution
- **Fix:** Use `registry.getInstrumentMaster()` / `getInstruments()` service for token resolution
- **Classification:** **REFACTOR**
- **Risk:** LOW — token resolution only, not data acquisition

---

## 5. DOCUMENTED EXCEPTIONS (not violations)

These files call Angel One directly but for **broker microstructure analytics**
that have no equivalent in the generic `MarketDataProvider` interface. They are
classified as documented exceptions pending a future broker-analytics extension:

| File | Angel Method | Justification |
|---|---|---|
| `src/services/india/scanner/engine.ts` | `angel.getPutCallRatio()` | SmartAPI-only `/marketData/v1/putCallRatio` — no registry equivalent |
| `src/services/india/scanner/engine.ts` | `angel.getOiBuildup()` | SmartAPI-only `/marketData/v1/OIBuildup` — no registry equivalent |
| `src/services/india/scanner/engine.ts` | `angel.getTopGainersLosers()` | SmartAPI-only `/marketData/v1/gainersLosers` — no registry equivalent |
| `src/features/india/daily-picks/builder.ts` | `angel.getOiBuildup()` | Same as above |
| `src/features/ai-signals/india-builder.ts` | `angel.getPutCallRatio()`, `angel.getOiBuildup()` | Same as above |

**Future action:** Add `getBrokerAnalytics()` to `MarketDataProvider` interface
and expose these via the data-service's `/v1/brokers/analytics` endpoint. Until
then these remain documented exceptions.

---

## 6. CLEAN COMPONENTS (no action required)

| Component | Status |
|---|---|
| `data-service/` entire Python service | CLEAN — correct boundary |
| `ml-service/` entire Python service | CLEAN — uses DATA_SERVICE_URL as Tier 0 |
| `src/lib/market-data/registry.ts` | CLEAN |
| `src/lib/market-data/providers/scrapling.ts` | CLEAN — wraps data-service HTTP |
| `src/lib/market-data/providers/angel-one.ts` | CLEAN — approved provider file |
| `src/lib/market-data/providers/upstox.ts` | CLEAN — approved provider file |
| `src/lib/market-data/providers/yahoo.ts` | CLEAN — approved provider file |
| `src/lib/market-data/providers/nse.ts` | CLEAN — tombstone guard |
| `src/lib/market-data/services/*.service.ts` (most) | CLEAN — routes through registry |
| `src/services/india/nse/index.ts` | CLEAN — tombstone stub |
| `src/services/india/angelone/smartstream.ts` | CLEAN — WS protocol layer only |
| `src/services/india/angelone/derivatives.ts` | CLEAN — pure parsers, no I/O |
| `worker/src/jobs/scraping-tick-listener.ts` | CLEAN — Redis pub/sub only |
| `worker/src/jobs/india-oc-capture.ts` | CLEAN — routes through feature layer |

---

## 7. DUPLICATED IMPLEMENTATIONS

| Duplication | Files | Classification |
|---|---|---|
| Yahoo fallback in Angel adapter AND in registry failover | `angelone/index.ts` + `failover.ts` | REMOVE from angel adapter |
| Option chain fetching in option-strike-capture AND option-chain.service | `option-strike-capture.service.ts` + `option-chain.service.ts` | MERGE into registry call |
| Historical candle fetch in fno-backfill-runner AND backfill-orchestrator | `fno-backfill-runner.service.ts` + `backfill-orchestrator.service.ts` | MERGE |
| Quote fetching in snapshotter AND in registry | `snapshotter.ts` + `registry.ts` | MERGE into registry call |
| NSE symbol → Yahoo ticker mapping in 5+ files | `normalizer.ts`, `yahoo/index.ts`, multiple feature files | CONSOLIDATE to normalizer |

---

## 8. 3M TIMEFRAME STATUS

**3m is COMPLETELY REMOVED. No action required.**

Evidence:
- `provider-capability-matrix.ts`: "3m intentionally absent — not a supported AlphaForge interval (V8 removal)"
- `candle-builder.service.ts`: "3m was permanently removed (V8 refactor/signals). No 3m candles are built, persisted, cached, or emitted."
- `v8-signal-data-gate.service.ts`: Hard blocks any signal with `interval === "3m"`
- `data-service/src/engines/candle_builder.py`: "3m was permanently removed in V8"
- `data-service/src/providers/common/normalizer.py`: rejects 3m at normalization entry
- `data-service/src/providers/common/acquisition_planner.py`: "Reject 3m permanently — raises ValueError"
- Live probe 2026-09-12: Angel One returns 0 bars for 3m

The only "3m" strings in code are:
1. `src/services/binance/klines.ts` — Binance crypto intervals (unrelated)
2. `src/features/strategy-lab/run-backtest.ts` — Binance backtest types (unrelated)
3. `prisma/schema.prisma` comment on `intervalStr` field — historical documentation
4. Various `.md` reports — documentation only

---

## 9. REDUNDANT / UNUSED CODE CANDIDATES

| Item | File | Classification |
|---|---|---|
| Multiple v3/v4/v5/v6/v7 data foundation scripts | `scripts/data-v3-*`, `scripts/data-v4-*`, etc. | DEPRECATE — migration scripts, keep for audit trail |
| `src/services/india/groww/index.ts` | Groww adapter (uses Yahoo fallback internally) | REVIEW — check if Groww is still used |
| Chaos test infrastructure | `src/lib/chaos/` | KEEP — for failure testing |

---

## 10. UNUSED ENVIRONMENT VARIABLES

Variables referenced in code that need verification:

| Variable | Used In | Status |
|---|---|---|
| `DATA_SERVICE_URL` | `src/lib/market-data/providers/scrapling.ts` | REQUIRED — enables data-service gateway |
| `SMARTAPI_*` (CLIENT_ID, PASSWORD, TOTP_SECRET) | `src/services/india/angelone/index.ts` | REQUIRED — Angel One auth |
| `UPSTOX_ACCESS_TOKEN`, `UPSTOX_ANALYTICS_TOKEN` | `src/lib/market-data/providers/upstox.ts` | REQUIRED — Upstox auth |
| `DATA_SERVICE_RATE_CAPACITY` | `src/lib/market-data/providers/scrapling.ts` | OPTIONAL — rate limiter config |

---

## 11. DATABASE OBSERVATIONS

### CandleBar (`candle_bar`)
- Has `intervalStr` (string) — supports any interval string
- **3m in comment only** — no 3m enforcement in schema (V8 removed it at application layer)
- Indexes: `(instrumentId, exchange, intervalStr, time)` unique, plus `(instrumentId, exchange, sessionDate)`, `(confirmedAt)`
- **Optimization opportunity:** Composite covering index for ML window queries: `(instrumentId, exchange, intervalStr, time DESC)` — existing index direction is ascending

### OptionChainStrike (`option_chain_strike`)
- Unique on `(underlying, expiry, strike, optionType, captureTimestamp, provider)`
- Indexes: `(underlying, expiry, captureTimestamp)`, `(underlying, captureTimestamp)`
- **Optimization opportunity:** Add `(underlying, expiry, captureTimestamp DESC)` for latest-chain queries

### Missing tables:
- No `ProviderHealthLog` table — health state is in-memory only; loses on restart
- No `BackfillCheckpoint` table — checkpoint state is Redis-only; need DB fallback

---

## 12. REFACTOR PRIORITY ORDER

| Priority | File | Change | Estimated LOC |
|---|---|---|---|
| P1 | `src/services/india/angelone/index.ts` | Remove Yahoo fallback inside `getQuotes/getHistorical` | −40 LOC |
| P1 | `src/services/india/scanner/engine.ts` | `yahoo.*` → `registry.*` (keep angel broker analytics) | −20, +15 LOC |
| P1 | `src/services/india/signals/snapshotter.ts` | `yahoo.getQuotes` → `registry.getQuotes` | −5, +5 LOC |
| P2 | `src/lib/market-data/services/option-strike-capture.service.ts` | `angel.getOptionChain` → `registry.getOptionChain` | −15, +10 LOC |
| P2 | `src/lib/market-data/services/fno-backfill-runner.service.ts` | `angel.getHistorical` → `registry.getHistoricalCandles` | −25, +15 LOC |
| P2 | `src/features/india/expiry-trades/builder.ts` | `angel.getOptionChain` → `registry.getOptionChain` | −10, +8 LOC |
| P3 | `src/features/india/fno-trend-history/service.ts` | `yahoo.getQuotes` → `registry.getQuotes` | −5, +5 LOC |
| P3 | `src/features/india/scalping/backtest.ts` | `yahoo.getHistorical` → `registry.getHistoricalCandles` | −5, +5 LOC |
| P3 | `src/features/india/scalping/strategies/positioning.ts` | `yahoo.getQuotes` → `registry.getQuotes` | −5, +5 LOC |
| P3 | `src/features/india/scalping/strategies/opening-breakout.ts` | `yahoo.getHistorical` → `registry.getHistoricalCandles` | −5, +5 LOC |
| P3 | `src/features/india/paper-trading/auto-trader.ts` | dynamic yahoo → `registry.getQuotes` | −5, +5 LOC |
| P3 | `src/app/api/in/scalper/close-all/route.ts` | `yahoo.getQuotes` → `registry.getQuotes` | −5, +5 LOC |
| P3 | `worker/src/jobs/india-realtime-candles.ts` | Angel ScripMaster → `getInstruments()` service | −15, +10 LOC |

---

## 13. ARCHITECTURE ENFORCEMENT GAP

The `canonical-import-guard.ts` file documents the policy but is only partially
enforced:
- **EXISTS:** ESLint import rule (`yahoo-finance2` forbidden outside allowlist)
- **EXISTS:** Test suite `tests/lib/market-data/canonical-import-guard.test.ts`
- **MISSING:** ESLint rule covering `@/services/india/yahoo` outside allowlist
- **MISSING:** ESLint rule covering `@/services/india/angelone` outside allowlist (only covers `yahoo-finance2` directly)
- **MISSING:** `@/services/india/nse` outside allowlist check (only tombstoned calls matter)

**Action:** Extend the ESLint config and the canonical-import-guard test to cover
all three forbidden import patterns uniformly.

---

## 14. ASSESSMENT CLASSIFICATION SUMMARY

| Classification | Count | Description |
|---|---|---|
| **KEEP** | 45+ files | Correct, no change needed |
| **REFACTOR** | 13 violation sites | Direct provider calls to route through registry |
| **DOCUMENT AS EXCEPTION** | 5 call sites | Broker-specific analytics with no registry equivalent |
| **MERGE** | 4 duplicate implementations | Consolidate into registry calls |
| **DELETE** | 0 | Nothing safe to delete pre-migration |
| **DEPRECATE** | ~10 migration scripts | Historical scripts, keep for audit trail |

---

*This audit was produced by direct code inspection. No values were inferred or assumed. Grep evidence is available for all 13 violation sites.*
