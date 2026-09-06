# AlphaForge — India Data Architecture
**Date:** 2026-09-03  
**Status:** POST-TRANSFORMATION  
**Classification:** INTERNAL ARCHITECTURE DOCUMENT

---

## 1. Canonical Data Architecture

```
                    ┌─────────────────────────────────┐
                    │      AlphaForge Frontend         │
                    │  (Next.js App Router / React)    │
                    └─────────────┬───────────────────┘
                                  │  HTTPS only
                                  │  No broker secrets
                                  │  No tokens in browser
                                  ▼
                    ┌─────────────────────────────────┐
                    │  Indian Market Data API / BFF    │
                    │  src/app/api/in/*                │
                    │  - /api/in/quote                 │
                    │  - /api/in/option-chain          │
                    │  - /api/in/historical            │
                    │  - /api/in/signal-center         │
                    │  - /api/in/providers/upstox/*    │
                    │  - /api/in/provider-health       │
                    └─────────────┬───────────────────┘
                                  │  Server-side only
                                  ▼
                    ┌─────────────────────────────────┐
                    │      ProviderRegistry            │
                    │  src/lib/market-data/registry.ts │
                    │  withFailover() engine           │
                    │  Circuit breakers                │
                    │  Health scoring                  │
                    └──────────┬──────────────────────┘
                               │
          ┌────────────────────┼───────────────────┬──────────────────┐
          │                    │                   │                  │
          ▼  priority=0        ▼  priority=1       ▼  priority=2     ▼  priority=3
   ┌─────────────┐    ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐
   │ DATA SERVICE │    │  Angel One        │  │   Upstox     │  │    Yahoo     │
   │ (Scrapling) │    │  SmartAPI         │  │   REST API   │  │  Finance     │
   │ port 8200   │    │  - Quotes         │  │  - Quotes    │  │  (delayed,   │
   │ Python ASGI │    │  - Option chain   │  │  - OC        │  │  equity only)│
   │ broker APIs │    │  - Historical     │  │  - Hist      │  │              │
   └─────────────┘    │  - WS SmartStream │  │  - WS        │  └──────────────┘
                      │  (primary)        │  │  (secondary) │
                      └──────────────────┘  └──────────────┘

FORBIDDEN: Direct NSE acquisition (nseindia.com, nsearchives, charting.nseindia.com,
           stock-nse-india npm, Scrapling/Playwright for NSE pages)
```

---

## 2. Provider Priority Chain

| Priority | Provider ID | Description | Credentials |
|----------|-------------|-------------|-------------|
| 0 | `scrapling` | Data Service canonical gateway | `DATA_SERVICE_URL` |
| 1 | `angel_one` | Angel One SmartAPI — primary | `SMARTAPI_*` |
| 2 | `upstox` | Upstox v2/v3 REST + WS | `UPSTOX_*` |
| 3 | `yahoo` | Yahoo Finance (fallback only) | None |
| ~~3~~ | ~~`nse`~~ | ~~REMOVED 2026-09-03~~ | ~~N/A~~ |

**Failover rules:**
- A provider fails over when: timeout, HTTP error, auth failure, rate limit, schema failure, stale response, invalid OHLC, circuit breaker open
- Retries: 3 per provider with exponential backoff (300ms base, 5s max, 20% jitter)
- Cooldown: 10s between provider switches to prevent oscillation
- Auth failures: no retry within same provider

---

## 3. Provider Capabilities Matrix

| Capability | Data Service | Angel One | Upstox | Yahoo |
|-----------|:---:|:---:|:---:|:---:|
| Historical candles | ✓ | ✓ | ✓ | ✓ |
| Live quotes (real-time) | ✓ | ✓ | ✓ | ✗ (delayed) |
| WebSocket stream | ✗ | ✓ | ✓ | ✗ |
| Option chain | ✓ | ✓ | ✓ | ✗ |
| Option chain Greeks | ✗ | ✓ | ✓ | ✗ |
| Instrument master | ✓ | ✓ | ✗ | ✗ |
| OI data | ✓ | ✓ | ✓ | ✗ |
| OI change | ✓ | ✓ | ✓ | ✗ |
| F&O coverage | ✓ | ✓ | ✓ | ✗ |
| Index data | ✓ | ✓ | ✓ | ✓ |
| Intraday (1m) | ✓ | ✓ | ✓ | ✓ |

---

## 4. Data Quality Pipeline

Every market data observation passes through this pipeline before reaching signal engines:

```
RAW RESPONSE
    ↓
SCHEMA VALIDATION        — Pydantic v2 models (data-service) / TS types
    ↓
SYMBOL NORMALIZATION     — symbol_normalizer.py / normalizer.ts
    ↓
TIMESTAMP NORMALIZATION  — UTC throughout, IST only at UI boundary
    ↓
OHLC VALIDATION          — filterValidCandles() / validateOHLC()
    ↓
VOLUME VALIDATION        — negative volume rejected
    ↓
OI SEMANTIC VALIDATION   — oi field is OI (contracts), NOT traded value
    ↓
FRESHNESS                — FreshnessClass: FRESH/AGING/STALE/EXPIRED/UNKNOWN
    ↓
SESSION VALIDATION       — market hours (IST 09:15–15:30)
    ↓
DUPLICATE DETECTION      — deduplication.py, unique timestamps
    ↓
OUT-OF-ORDER DETECTION   — sequence integrity check
    ↓
CROSS-PROVIDER AGREEMENT — comparePrices() with per-category thresholds
    ↓
DATA QUALITY SCORE       — DataConfidenceScore (0–95, never 100)
    ↓
DATA QUALITY GATE        — DataQualityGate: signalEngineAllowed boolean
    ↓
CANONICAL DATA           — UnifiedIndiaSignal / MDQuote / OHLCVCandle
```

**DataQualityGate confidence scoring weights:**
- Freshness: 35%
- Completeness: 25%
- Provider health: 20%
- Timestamp validity: 10%
- Cross-source agreement: 10%
- Maximum score: 95 (inherent uncertainty in market data)

---

## 5. Cross-Provider Disagreement Thresholds

| Instrument Type | Max Divergence | Classification |
|----------------|----------------|----------------|
| INDEX (NIFTY, BANK) | 0.10% | Tight — institutional data |
| STOCK (equity) | 0.50% | Normal spread |
| FUTURE | 0.30% | Futures spread |
| OPTION | 2.00% | Wide bid-ask spreads |

Disagreement states: `AGREEMENT` / `MINOR_VARIANCE` / `SIGNIFICANT_VARIANCE` / `CONFLICT` / `UNAVAILABLE` / `STALE`

---

## 6. Data Lineage

Every market observation records:
```
observationId    — UUID (stable, immutable)
instrumentId     — exchange:symbol
symbol           — canonical trading symbol
dataType         — QUOTE | TICK | CANDLE | OPTION_CHAIN | INSTRUMENT
source           — DataSource enum (BROKER_ANGEL / BROKER_UPSTOX / YAHOO_FINANCE / CACHE / REPLAY)
eventTimeMs      — Exchange timestamp (when event occurred)
receivedAtMs     — When data-service received the data
availableAtMs    — When data became available to signal engine
normalizationVersion — Version of normalizer applied
validationApplied — Whether DataQualityGate was evaluated
isFallback        — Whether a higher-priority provider was bypassed
fallbackReason    — Why fallback occurred
rawPayloadHash    — SHA-256 of raw provider response (for replay)
```

LineageStore: in-memory LRU (50k max entries). Critical observations should be persisted to Postgres via `data_observation_id` in `PaperTrade` model.

---

## 7. Upstox OAuth Security Architecture

```
Browser
    │  GET /api/in/providers/upstox/connect
    │  ← { authorizationUrl, state }
    │
    │  Redirect user to authorizationUrl (Upstox OAuth page)
    │
    │  Upstox redirects to: /api/in/providers/upstox/callback?code=XXX
    │
    │         ┌─────────────────────────────────────────────┐
    │         │  Server-side only (NEVER reaches browser):  │
    │         │  - exchangeUpstoxCode(code, redirectUri)    │
    │         │  - UPSTOX_CLIENT_SECRET used here only      │
    │         │  - access_token stored in server memory     │
    │         └─────────────────────────────────────────────┘
    │
    │  Redirect to /in/settings?upstox=connected (no token in URL)
    │
    │  GET /api/in/providers/upstox/status
    │  ← { state, expiresAt, connectedAt, message, dataOperational }
    │    (NO token, NO secret, NO credentials)
```

**Security invariants:**
- `UPSTOX_CLIENT_SECRET` used only in `/api/in/providers/upstox/callback` (server-side)
- `UPSTOX_ANALYTICS_TOKEN` / `UPSTOX_ACCESS_TOKEN` — server env only
- `_oauthState` — Node.js process memory only, not serialized
- No `NEXT_PUBLIC_UPSTOX_*` variables
- Token not in URL, query params, localStorage, logs, or analytics
- Frontend only sees: lifecycle state + timestamps (not token values)

---

## 8. Worker Data Flows

```
Worker Process
├── india-auto-trader (60s) ──→ registry.getQuotes() → signal scoring → Opportunity Pipeline → PaperTrade
├── india-daily-picks (60s) ──→ registry.getOptionChain() + registry.getQuotes() → DailyPick table
├── india-scanner (5min) ───→ registry.getOptionChain() (via indexChains()) → scanner hits
├── india-oc-capture (5min) → registry.getOptionChain() → OptionChainSnapshot table
├── india-scalper (tick) ───→ scraping-tick-listener → Redis pub/sub af:ticks:{SYMBOL}
├── india-fno-trend-track ──→ FnoTrendScan table
└── india-eod-squareoff ────→ close all open trades at 15:30 IST
```

---

## 9. NSE Removal Summary

The following were removed as of 2026-09-03:

| Component | Was | Now |
|-----------|-----|-----|
| `src/services/india/nse/index.ts` | Direct NSE scraper (stock-nse-india + hand-rolled) | Tombstone with throwing stubs |
| `src/lib/market-data/providers/nse.ts` | `NseProvider` (priority 3) | Tombstone (`NSE_PROVIDER_REMOVED_REASON`) |
| `registry.ts` bootstrapRegistry | Registered NseProvider | No NSE registration |
| `ProviderId` type | `"scrapling" \| "angel_one" \| "upstox" \| "nse" \| "yahoo"` | `"scrapling" \| "angel_one" \| "upstox" \| "yahoo"` |
| `PROVIDER_PRIORITY` | `[..., "nse", "yahoo"]` | `[..., "yahoo"]` |
| `package.json` | `"stock-nse-india": "1.4.0"` | Removed |
| `scanner/engine.ts indexChains()` | `nse.getOptionChain()` | `registry.getOptionChain()` |
| `broker/factory.ts` | `getBrokerById("nse")` returned NSE adapter | Returns `null` |
| `DataSourceBadge.tsx` | NSE in provider priority list | Removed |

---

## 10. Known Remaining Gaps (Post-Transformation)

| Gap | Priority | Owner |
|-----|----------|-------|
| data-service Python scrapers still use NSE for live quotes/historical | HIGH | data-service refactor |
| DataQualityGate HTTP API not yet called by TypeScript signal engine | HIGH | Gate client wiring |
| LineageStore is in-memory only — lost on restart | MEDIUM | DB persistence |
| AngelOneWsManager.sendSubscribe() stub | MEDIUM | SmartStream dynamic sub |
| data-service anti_ban/ layer still present (now unused for production) | LOW | Cleanup |
| DUP-001: Cross-timeframe signal inflation (partially addressed by cluster) | HIGH | Signal dedup |

---

*Architecture document generated 2026-09-03. Valid for current master branch post-transformation.*
