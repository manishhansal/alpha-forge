# AlphaForge — India Architecture Audit
**Date:** 2026-09-03  
**Auditor:** Principal Quantitative Systems Architect  
**Branch:** master  
**Purpose:** Pre-transformation baseline — honest assessment of current state before any code changes.

---

## Executive Summary

The AlphaForge India market data fabric is a **multi-layer system** with sophisticated infrastructure (ProviderRegistry, DataQualityGate, LineageStore, Signal Intelligence Engine, Opportunity Engine, Paper Trading) that was incrementally built but has several **hard blockers** that prevent production certification:

| Blocker | Severity | Status |
|---------|----------|--------|
| NSE direct data acquisition in production | CRITICAL | NOT_FIXED |
| NSE provider (priority 3) in provider chain | CRITICAL | NOT_FIXED |
| stock-nse-india npm package in production | CRITICAL | NOT_FIXED |
| data-service is still primarily an NSE scraper | CRITICAL | NOT_FIXED |
| No Upstox OAuth BFF endpoints | HIGH | NOT_FIXED |
| DataQualityGate not called by TS signal engine | HIGH | NOT_FIXED |
| DUP-001: Cross-timeframe signal duplication | HIGH | NOT_FIXED |
| No unified Indian Signal Center page | MEDIUM | NOT_FIXED |
| Upstox using deprecated /v2/ candle API path | MEDIUM | TO_VERIFY |

---

## 1. Current Data Flow

```
Browser
  ↓
Next.js Route Handlers (src/app/api/in/*)
  ↓
ProviderRegistry.getXxx()
  ↓
withFailover([scrapling, angel_one, upstox, nse, yahoo])
  ↓
┌─────────────────────────────────────────────────────────────────┐
│  Priority 0: ScraplingProvider (DATA_SERVICE_URL)              │
│    → Python data-service (port 8200)                           │
│      → NSE NextApi httpx (live quotes)                         │
│      → NSE Scrapling/Playwright (option chain)                 │
│      → NSE nsearchives Bhavcopy (historical)                   │
│      → NSE charting.nseindia.com (intraday)                    │
│  Priority 1: AngelOneProvider                                  │
│    → Angel One SmartAPI REST + SmartStream WebSocket           │
│  Priority 2: UpstoxProvider                                    │
│    → Upstox v2 REST + WebSocket                                │
│  Priority 3: NseProvider ← MUST BE REMOVED                     │
│    → stock-nse-india npm package                               │
│    → Direct NSE HTTP scraping                                  │
│  Priority 4: YahooProvider                                     │
│    → yahoo-finance2 npm package                                │
└─────────────────────────────────────────────────────────────────┘

Background workers:
  Worker Process
    ↓ india-auto-trader (60s)   → score → OpportunityPipeline → PaperTrade
    ↓ india-daily-picks (60s)   → DailyPick engine → IndiaDailyPick table
    ↓ india-scanner (5min)      → 6 scanner types → WhatsApp alerts
    ↓ india-oc-capture (5min)   → OptionChainSnapshot table
    ↓ india-scalper (per-tick)  → 9 F&O strategies → CandleBar + PaperTrade
    ↓ india-fno-trend-track     → FnoTrendScan table
    ↓ india-eod-squareoff       → close all positions at 15:30
    ↓ scraping-tick-listener    → Redis pub/sub af:ticks:{SYMBOL} → candle builder
```

---

## 2. Current Provider Flow

### Priority Chain (CURRENT — BROKEN)
```
Scrapling/DataService (0) → Angel One (1) → Upstox (2) → NSE (3) → Yahoo (4)
```

### Priority Chain (TARGET — REQUIRED)
```
DataService/ScraplingProvider (0) → Angel One (1) → Upstox (2) → Yahoo (3)
```

**NSE must be completely removed as a production data provider.**

### Provider Capabilities Matrix

| Capability | Scrapling | Angel One | Upstox | NSE (REMOVE) | Yahoo |
|-----------|-----------|-----------|--------|--------------|-------|
| Historical candles | ✓ | ✓ | ✓ | ✗ | ✓ |
| Live quotes | ✓ | ✓ | ✓ | ✓ | ✓ (delayed) |
| WebSocket | ✗ | ✓ | ✓ | ✗ | ✗ |
| Option chain | ✓ | ✓ | ✓ | ✓ | ✗ |
| Instrument master | ✓ | ✓ | ✗ | ✗ | ✗ |
| OI data | ✓ | ✓ | ✓ | ✓ | ✗ |

---

## 3. All Direct NSE References in Production Code

### TypeScript / JavaScript Production Files

| File | Reference | Classification | Action Required |
|------|-----------|----------------|-----------------|
| `src/services/india/nse/index.ts` | `NSE_BASE = "https://www.nseindia.com"` | PRODUCTION DATA ACQUISITION | **DELETE FILE** |
| `src/services/india/nse/index.ts` | `new NseIndia()` (stock-nse-india) | PRODUCTION DATA ACQUISITION | **DELETE FILE** |
| `src/services/india/nse/index.ts` | Cookie warming (getNseCookies) | PRODUCTION DATA ACQUISITION | **DELETE FILE** |
| `src/services/india/nse/index.ts` | `/api/option-chain-indices` | PRODUCTION DATA ACQUISITION | **DELETE FILE** |
| `src/services/india/nse/index.ts` | `/api/option-chain-equities` | PRODUCTION DATA ACQUISITION | **DELETE FILE** |
| `src/lib/market-data/providers/nse.ts` | `NseProvider` wrapping above | PRODUCTION PROVIDER | **DELETE FILE** |
| `src/lib/market-data/registry.ts` | `NseProvider` registered at priority 3 | PROVIDER CHAIN | **REMOVE REGISTRATION** |
| `src/lib/market-data/failover.ts` | Comment: `ANGEL_ONE → UPSTOX → NSE → YAHOO` | DOCUMENTATION | **UPDATE COMMENT** |
| `src/lib/market-data/types.ts` | `"nse"` in `ProviderId` union | TYPE DEFINITION | **REMOVE** |
| `src/lib/market-data/types.ts` | `PROVIDER_PRIORITY` includes `"nse"` | CONSTANT | **REMOVE** |
| `package.json` | `"stock-nse-india": "1.4.0"` | DEPENDENCY | **REMOVE** |

### Python Data-Service Production Files

| File | Reference | Classification | Action Required |
|------|-----------|----------------|-----------------|
| `data-service/src/scrapers/live_quotes.py` | `_NSE_NEXTAPI_BASE` (httpx to nseindia.com) | PRODUCTION ACQUISITION | **REFACTOR — replace with broker APIs** |
| `data-service/src/scrapers/option_chain.py` | `_NSE_OPTION_CHAIN_URL` + Scrapling session | PRODUCTION ACQUISITION | **REFACTOR — broker APIs only** |
| `data-service/src/scrapers/historical.py` | `nsearchives.nseindia.com` Bhavcopy | PRODUCTION ACQUISITION | **REFACTOR — broker APIs only** |
| `data-service/src/scrapers/historical.py` | `charting.nseindia.com` intraday | PRODUCTION ACQUISITION | **REFACTOR — broker APIs only** |
| `data-service/src/scrapers/instrument_master.py` | `nsearchives.nseindia.com/fo_mktlots.csv` | PRODUCTION ACQUISITION | **REFACTOR — Angel ScripMaster only** |
| `data-service/src/anti_ban/session_warmer.py` | NSE session warm-up | ANTI-BAN INFRA | **REMOVE** (not needed once NSE removed) |
| `data-service/src/anti_ban/ban_detector.py` | NSE ban detection | ANTI-BAN INFRA | **REMOVE** |
| `data-service/src/anti_ban/proxy_manager.py` | Proxy rotation for NSE | ANTI-BAN INFRA | **REMOVE** |
| `data-service/src/anti_ban/rate_limiter.py` | NSE/BSE rate limiters | ANTI-BAN INFRA | **REMOVE** (NSE-specific) |
| `data-service/src/server.py` | `AsyncDynamicSession` + session warmer setup | BROWSER INFRA | **REMOVE** (Scrapling for NSE) |

### Legitimate NSE Exchange Identifiers (DO NOT REMOVE)

These are exchange/segment identifiers — not data acquisition:
- `NSE_EQ`, `NSE_FO`, `NSE_INDEX` in Upstox instrument keys
- `Exchange = "NSE" | "NFO" | "BSE"` — canonical exchange types
- `SMART_EXCHANGE_TYPE.NSE_CM / NSE_FO` — Angel One exchange type constants
- `nse_trading_calendar.ts` — NSE calendar/holiday data
- `NSE_INDEX|Nifty 50` — Upstox instrument key format
- Any Indian exchange-specific reference in configuration (not URL-based)

---

## 4. All Upstox References

| Location | Type | Status |
|----------|------|--------|
| `src/lib/market-data/providers/upstox.ts` | Full provider adapter | GOOD — server-side only |
| `UPSTOX_ANALYTICS_TOKEN` | Env var (server-only) | GOOD |
| `UPSTOX_CLIENT_ID` | Env var (server-only) | GOOD |
| `UPSTOX_CLIENT_SECRET` | Env var (server-only) | GOOD — never browser-exposed |
| `UPSTOX_ACCESS_TOKEN` | Env var (server-only, legacy) | ACCEPTABLE — no NEXT_PUBLIC_ prefix |
| OAuth flow: `exchangeUpstoxCode()` | Server-only function | GOOD |
| `_oauthState` | In-memory (Node process) | GOOD — not browser-accessible |
| **MISSING**: `/api/in/providers/upstox/*` BFF routes | Upstox connect/disconnect flow | **MUST ADD** |
| **MISSING**: Token lifecycle states | DISCONNECTED/AUTHORIZING/CONNECTED/etc. | **MUST ADD** |

---

## 5. All Angel One References

| Location | Type | Status |
|----------|------|--------|
| `src/lib/market-data/providers/angel-one.ts` | Primary provider adapter | GOOD |
| `src/services/india/angelone/index.ts` | Legacy adapter (angel.getQuotes, etc.) | GOOD — internal only |
| `src/services/india/angelone/smartstream.ts` | SmartStream WebSocket client | GOOD |
| `src/services/india/angelone/derivatives.ts` | First-party F&O scanner | GOOD |
| `SMARTAPI_API_KEY/CLIENT_CODE/PIN/TOTP_SECRET` | Server-only env vars | GOOD |
| `AngelOneWsManager` — `sendSubscribe()` stub | Known issue | **MEDIUM — dynamic sub incomplete** |

---

## 6. All Yahoo References

| Location | Type | Status |
|----------|------|--------|
| `src/lib/market-data/providers/yahoo.ts` | Fallback provider (priority 4) | GOOD |
| `src/services/india/yahoo/` | Yahoo adapter | GOOD |
| `src/lib/market-data/canonical-import-guard.ts` | Guards yahoo-finance2 imports | GOOD — CI-enforced |

---

## 7. Signal Flow and Signal Surfaces

### Signal-Producing Functions

| Signal Family | Source File | API Route | Worker | Timeframe | Entry Logic |
|--------------|-------------|-----------|--------|-----------|-------------|
| F&O Scanner — momentum | `src/services/india/scanner/engine.ts` | `/api/in/signals` | `india-scanner` | 5m | % change + OI direction |
| F&O Scanner — oi-buildup | same | same | same | 5m | 4-quadrant OI/price analysis |
| F&O Scanner — pcr | same | same | same | 5m | PCR extremes (contrarian) |
| F&O Scanner — iv-spike | same | same | same | 5m | IV relative to 20d avg |
| F&O Scanner — volume-breakout | same | same | same | 5m | Vol ≥ 1.5× avg + price quartile |
| F&O Scanner — range-expansion | same | same | same | 5m | WR8 + bullish trend |
| AI Signals | `src/features/ai-signals/india-builder.ts` | `/api/in/ai-signals` | `india-auto-trader` | multi | 10+ factors: SMA, RSI, PCR, ATM IV, OI delta, max-pain |
| Daily Picks — INDICES_SCALP | `src/features/india/daily-picks/engine.ts` | `/api/in/daily-picks` | `india-daily-picks` | 1d | ATM option scalp setup |
| Daily Picks — OPENING_BREAKOUT | same | same | same | 1d | ORB pattern |
| Daily Picks — HIGHLY_MOMENTUM | same | same | same | 1d | Strong trend continuation |
| Daily Picks — HIGHLY_SCALPING | same | same | same | 1d | Intraday scalp setups |
| Daily Picks — HIGHLY_POTENTIAL | same | same | same | 1d | Swing/positional setups |
| FnO Trend — BULLISH (14-cond) | `src/app/api/in/fno-bullish-trend/route.ts` | `/api/in/fno-bullish-trend` | `india-fno-trend-track` | 1d | 14 technical conditions |
| FnO Trend — BEARISH (14-cond) | `src/app/api/in/fno-bearish-trend/route.ts` | `/api/in/fno-bearish-trend` | `india-fno-trend-track` | 1d | 14 conditions inverted |
| MSB Signals | `src/app/api/in/msb-signals/route.ts` | `/api/in/msb-signals` | N/A | multi | Market Structure Break |
| Scalper — 9 F&O strategies | `src/features/india/scalping/` | `/api/in/scalper/signals` | `india-scalper` | 1m/3m/5m | UT Bot + HMA + SMC + EMA stack |
| Opportunity Engine | `src/lib/opportunity-engine/` | `/api/in/opportunity-engine` | `india-auto-trader` | N/A | 12-stage validation + paper trade |
| Expiry Trades — Gamma Blast | `src/features/india/expiry-trades/` | `/api/in/expiry-trades` | N/A | expiry-day | High-gamma ATM options |
| Expiry Trades — Hero Zero | same | same | N/A | expiry-day | Deep OTM lottery plays |
| Top Picks | `src/app/api/in/top-picks/route.ts` | `/api/in/top-picks` | N/A | N/A | Aggregation of scanner + AI |

### Signal Consumers

| Consumer | Signal Source | How Used |
|----------|--------------|----------|
| `india-auto-trader` worker | All signal families | Score + 12-stage pipeline → PaperTrade |
| Dashboard UI | All API routes | Display, filtering, sorting |
| WhatsApp notifier | AI Signals, Scanner, Daily Picks | Push alerts |
| SignalHistory table | signal-ingest worker | 30-min dedup + persistence |
| SignalLifecycleEvent | signal-intelligence engine | State machine tracking |
| OpportunityCluster | opportunity-engine | Anti-double-count grouping |
| PaperTrade model | paper-trading execution | Execution + P&L tracking |

---

## 8. All Provider Capability Mappings (Current)

```typescript
scrapling  = { historicalCandles, liveQuotes, optionChain, instrumentMaster, intradayCandles, fno }
angel_one  = { historicalCandles, liveQuotes, webSocket, optionChain, instrumentMaster, intradayCandles, fno }
upstox     = { historicalCandles, liveQuotes, webSocket, optionChain, intradayCandles, fno }
nse        = { liveQuotes, optionChain, fno }          ← MUST BE REMOVED
yahoo      = { historicalCandles, liveQuotes, intradayCandles }
```

---

## 9. All Environment Variables

### Required
| Variable | Purpose | Server-only |
|----------|---------|-------------|
| `DATABASE_URL` | PostgreSQL | ✓ |
| `AUTH_SECRET` | Auth.js | ✓ |
| `ENCRYPTION_KEY` | AES-256 | ✓ |

### Indian Market Providers
| Variable | Provider | Server-only |
|----------|----------|-------------|
| `SMARTAPI_API_KEY` | Angel One | ✓ |
| `SMARTAPI_CLIENT_CODE` | Angel One | ✓ |
| `SMARTAPI_PIN` | Angel One | ✓ |
| `SMARTAPI_TOTP_SECRET` | Angel One | ✓ |
| `UPSTOX_CLIENT_ID` | Upstox OAuth | ✓ |
| `UPSTOX_CLIENT_SECRET` | Upstox OAuth | ✓ |
| `UPSTOX_ANALYTICS_TOKEN` | Upstox read-only | ✓ |
| `UPSTOX_ACCESS_TOKEN` | Upstox legacy | ✓ |
| `DATA_SERVICE_URL` | Python data-service | ✓ |
| `ML_SERVICE_URL` | Python ML service | ✓ |

### Browser-Exposed (NEXT_PUBLIC_)
| Variable | Purpose | Risk |
|----------|---------|------|
| `NEXT_PUBLIC_APP_URL` | App URL | None |
| `NEXT_PUBLIC_BINANCE_WS` | Binance WS | None |
| `NEXT_PUBLIC_BINANCE_FUTURES_WS` | Futures WS | None |
| `NEXT_PUBLIC_BYBIT_WS` | Bybit WS | None |
| `NEXT_PUBLIC_DELTA_WS` | Delta Exchange WS | None |
| `NEXT_PUBLIC_ACTIVE_BROKER` | Broker selection | None |
| **NO UPSTOX/ANGEL SECRETS** | — | **CLEAN** |

---

## 10. All Known Technical Debt

### Critical (Blocking Production)
1. **NSE-001**: `src/services/india/nse/index.ts` — Direct NSE scraping in production TypeScript code
2. **NSE-002**: `data-service` is an NSE scraper, not a provider-agnostic gateway
3. **NSE-003**: `stock-nse-india` npm package is a hard dependency on direct NSE acquisition
4. **NSE-004**: `NseProvider` registered at priority 3 in provider chain
5. **GATE-001**: DataQualityGate HTTP API exists in Python but TypeScript signal engine never calls it
6. **AUTH-001**: No Upstox OAuth BFF routes — users cannot connect/disconnect Upstox from frontend

### High
7. **DUP-001**: Cross-timeframe duplicate signals inflate trade count ~3× (from CHANGES.md)
8. **AUDIT-001**: SignalLifecycleEvent not persisted to DB — flushLifecycleEvents() is a shutdown hook only
9. **RISK-001**: PortfolioRiskEngine defined but not wired into live execution path
10. **WS-001**: AngelOneWsManager.sendSubscribe() / sendUnsubscribe() are stubs — dynamic subscription changes deferred to next reconnect

### Medium
11. **SIGNAL-001**: No unified Indian Signal Center page — signals scattered across multiple routes/pages
12. **CLUSTER-001**: OpportunityCluster exists in DB model but UI doesn't show clustered view
13. **PROV-001**: Upstox uses `/v2/historical-candle/` — needs verification against current V3 APIs
14. **DATA-001**: LineageStore is in-memory LRU only — lineage records lost on restart (no DB persistence)

### Low
15. **CACHE-001**: Provider health cache key collision risk with `market:provider-health:{id}` — multiple processes
16. **TEST-001**: Real-network tests (data-service/tests/real_network/) test NSE directly — need refactoring
17. **ENV-001**: `UPSTOX_ACCESS_TOKEN` legacy env var still accepted — retirement path not documented

---

## 11. All Duplicated Signal Logic

| Logic | Duplicate Locations |
|-------|---------------------|
| Option chain analytics (PCR, max pain, ATM IV) | `src/services/india/nse/index.ts` (computeAnalytics) AND `src/lib/market-data/providers/upstox.ts` (inline) |
| Signal confidence scoring | `india-auto-trader.ts` (0.35×conf + ...) AND `india-builder.ts` (composite magnitude) |
| OHLC validation | `src/lib/market-data/validation/candle-validator.ts` AND `reconciliation.service.ts` (validateOHLC) |
| Expiry normalization | `src/lib/market-data/normalizer.ts` AND `src/services/india/nse/index.ts` (parseNseExpiryMs) |

---

## 12. All Duplicated API Endpoints

| Capability | Duplicate Routes |
|-----------|-----------------|
| F&O signals/scanner results | `/api/in/signals` + `/api/in/scanner` + `/api/in/top-picks` |
| Option chain | `/api/in/option-chain` + (internal via ScraplingProvider → DataService) |
| Provider health | `/api/in/provider-health` + `/api/in/health` (different shapes) |
| Daily picks | `/api/in/daily-picks` + `/api/in/daily-picks/history` + `/api/in/top-picks` (overlap) |

---

## 13. All Duplicated Frontend Signal Components

| Component | Duplicated By |
|-----------|--------------|
| Signal card rendering | `src/components/india/signals/` + `src/components/india/ai-signals/` |
| Confidence badge | Multiple components each implementing own color mapping |
| Grade display | Daily picks + AI signals each have own grade renderers |
| Provider badge | `DataSourceBadge.tsx` (good — one component, but not always used) |

---

## 14. Existing Infrastructure to Preserve

| Component | File | Status |
|-----------|------|--------|
| ProviderRegistry | `src/lib/market-data/registry.ts` | GOOD — extend only |
| withFailover | `src/lib/market-data/failover.ts` | GOOD — update provider order comment |
| DataQualityGate | `data-service/src/core/data_quality.py` | GOOD — need TS bridge |
| LineageStore | `data-service/src/core/lineage.py` | GOOD — needs DB persistence |
| Circuit Breakers | `data-service/src/core/circuit_breaker.py` | GOOD |
| ReconciliationService | `src/lib/market-data/services/reconciliation.service.ts` | GOOD |
| Signal Intelligence | `src/lib/signal-intelligence/` | GOOD |
| Opportunity Engine | `src/lib/opportunity-engine/` | GOOD |
| Paper Trading | `PaperTrade` model + provenance fields | GOOD |
| Angel One provider | `src/lib/market-data/providers/angel-one.ts` | GOOD |
| Upstox provider | `src/lib/market-data/providers/upstox.ts` | GOOD — needs BFF routes |
| Yahoo provider | `src/lib/market-data/providers/yahoo.ts` | GOOD |
| Gate client | `src/lib/data-service/gate-client.ts` | GOOD — needs wiring |

---

## 15. Hard Blockers Before Production Certification

Per the requirements, the following MUST be resolved:

1. ❌ **Direct NSE production data acquisition exists** (NSE-001, NSE-002, NSE-003, NSE-004)
2. ❌ **NSE provider in chain** (NSE-004)  
3. ✅ **Upstox secret not browser-exposed** (confirmed clean)
4. ❌ **DataQualityGate not called by TS signal engine** (GATE-001)
5. ❌ **No Upstox OAuth BFF** (AUTH-001)
6. ❌ **DUP-001: Signal duplication** (DUP-001)
7. ❌ **No unified signal center** (SIGNAL-001)

---

*This audit was generated on 2026-09-03 from direct inspection of repository source code. No documentation was trusted without code verification.*
