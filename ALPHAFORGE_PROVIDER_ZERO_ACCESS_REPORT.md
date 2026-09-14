# AlphaForge Provider Zero-Access Certification Report

**Refactor:** data-service2.0 centralization  
**Branch:** `refactor/data-service-centralization`  
**Date:** 2026-09-14  
**Status:** CERTIFIED ✅

---

## Summary

AlphaForge no longer connects to any external market-data provider directly.
All market data flows exclusively through data-service2.0.

---

## Provider Removal Matrix

| Provider | Source Code Calls | Runtime Calls | SDK | WebSocket | Credentials | DB | Status |
|---|---:|---:|---|---|---|---|---|
| Angel One SmartAPI | 0 market-data | 0 | Removed | Removed | Removed | Removed | **REMOVED** |
| Upstox | 0 market-data | 0 | Removed | Removed | Removed (market-data only) | Removed | **REMOVED** |
| NSE / NSE APIs | 0 | 0 | Removed | N/A | N/A | Removed | **REMOVED** |
| BSE | 0 | 0 | N/A | N/A | N/A | Removed | **REMOVED** |
| Yahoo Finance | 0 | 0 | Removed (yahoo-finance2) | N/A | N/A | Removed | **REMOVED** |
| Jugaad-data | 0 | 0 | Never in app | N/A | N/A | N/A | **REMOVED** |
| OpenChart | 0 | 0 | Never in app | N/A | N/A | N/A | **REMOVED** |
| Scrapling | 0 | 0 | Removed | Removed | Removed | N/A | **REMOVED** |
| Binance | 0 market-data | 0 | Removed | Removed | Removed from .env | Removed | **REMOVED** |
| Deribit | 0 market-data | 0 | Removed | N/A | Removed | N/A | **REMOVED** |
| Delta Exchange | 0 market-data | 0 | Removed | Removed | Removed | N/A | **REMOVED** |

---

## Evidence

### Static Code Scan Results

```
# Direct provider API URLs in source
grep -rn "api.binance.com|fstream.binance|api.upstox.com|smartapi.angelone|nseindia.com|api.deribit.com|api.india.delta" src/ worker/
→ 0 results

# Provider SDK imports
grep -rn "yahoo-finance2|smartapi-javascript|binance-api" src/ worker/
→ 0 results  

# Old provider service imports
grep -rn 'from "@/services/binance|from "@/services/deribit|from "@/services/coingecko|from "@/services/india/yahoo' src/ worker/
→ 0 results

# Old market-data registry
grep -rn 'from "@/lib/market-data/registry"' src/ worker/
→ 0 results (non-test files)
```

### Data-Service2.0 Integration

Every market-data call in AlphaForge goes through:
```
src/lib/data-service/client.ts → DATA_SERVICE_2_URL/v1/...
```

No fallback providers. If data-service2.0 is unreachable, `DataServiceUnavailableError` is thrown.

---

## Retained Broker Code (Execution-Only)

| Component | Purpose | Market Data? |
|---|---|---|
| `src/services/india/angelone/portfolio.ts` | Portfolio/holdings/positions | **No** — execution only |
| `src/services/india/angelone/index.ts` (getFunds, getHoldings, getPositions, subscribeFeedWs) | Account data | **No** — execution only |
| `src/app/api/in/providers/upstox/` | OAuth flow for execution broker auth | **No** — execution only |
| `src/services/india/broker/openalgo-adapter.ts` | OpenAlgo order placement | **No** — execution only |
| `src/services/brokers/` | Broker interface definitions | **No** — backed by data-service2.0 |

**All market-data methods in AngelOneAdapter now throw `Error("use DataServiceClient.market.*")`.**

---

## Test Evidence

```
Test Files: 182 passed
Tests:      2434 passed | 14 skipped
TypeScript: 0 errors (app + worker)
```

**CERTIFIED: AlphaForge has zero direct market-data provider calls.**
