# Final Provider Zero Access Report

**Date:** 2026-09-15 | **Branch:** `refactor/alpha-forge`

## Methodology

Full repository scan for:
- SDK package imports (package.json)
- HTTP API calls to provider domains
- WebSocket connections to provider endpoints
- Provider-specific authentication code
- Environment variables for provider credentials

## Provider Status

| Provider | SDK in package.json | HTTP calls | WebSocket | Credentials | Status |
|----------|---------------------|------------|-----------|-------------|--------|
| Angel One (SmartAPI) | ❌ Not present | ❌ None for market data | ❌ None | `SMARTAPI_*` in env — **EXECUTION ONLY** (portfolio/orders) | ✅ COMPLIANT |
| Upstox | ❌ Not present | `api.upstox.com/v2/login` — **OAuth only, EXECUTION** | ❌ None | `UPSTOX_CLIENT_ID/SECRET` — OAuth for execution | ✅ COMPLIANT |
| NSE direct | ❌ Not present | ❌ None | ❌ None | None | ✅ COMPLIANT |
| BSE direct | ❌ Not present | ❌ None | ❌ None | None | ✅ COMPLIANT |
| Yahoo Finance | ❌ Not present | ❌ None | ❌ None | None | ✅ COMPLIANT |
| Jugaad | ❌ Not present | ❌ None | ❌ None | None | ✅ COMPLIANT |
| OpenChart | ❌ Not present | ❌ None | ❌ None | None | ✅ COMPLIANT |
| Scrapling | ❌ Not present | ❌ None | ❌ None | None | ✅ COMPLIANT |
| Binance | ❌ Not present | ❌ None for market data | ❌ None (removed from env.ts) | None | ✅ COMPLIANT |
| Deribit | ❌ Not present | ❌ None | ❌ None | `DERIBIT_CLIENT_ID/SECRET` — kept for potential future use, not active | ✅ COMPLIANT |
| Delta Exchange | ❌ Not present | ❌ None for market data | ❌ None (removed from env.ts) | `DELTA_REST_BASE_URL` — **EXECUTION ONLY** | ✅ COMPLIANT |

## Legitimate Remaining References

These are **NOT market data access** and are correctly retained:

### Angel One — Execution/Portfolio Only
- `src/services/india/angelone/index.ts` — SmartAPI client for **portfolio queries** (funds, positions, holdings), **order placement**
- `src/features/settings/angel-credentials.ts` — credential resolver for execution broker
- `src/features/settings/api-keys-shared.ts` — "angel" key type definitions for settings UI
- **No market data (OHLCV/quotes/candles) from Angel One**

### Upstox — OAuth Execution Only
- `src/app/api/in/providers/upstox/` — OAuth 2.0 flow for order execution
- Comment in `src/app/api/in/providers/upstox/callback/route.ts:7`: "Market data does NOT flow through Upstox — all market data comes from data-service2.0"
- **No market data from Upstox**

### Delta Exchange — Execution Broker
- `DELTA_REST_BASE_URL` env var — REST API for order execution
- Liquidation feed in worker via `data-service2.0` WebSocket, not direct Binance/Delta connection
- **No market data from Delta**

### Comment/Type References (NSE, BSE, Binance, Deribit in strings)
- Type annotations like `"NSE" | "BSE"` describe exchange identifiers passed TO data-service2.0
- Comments referencing providers describe the OLD architecture or routing inside data-service2.0
- `DataSourceBadge.tsx` — UI badge displaying which provider data-service2.0 used (read-only metadata)
- These are **not provider implementations**

## WebSocket Verification

| Component | Connects To | Data |
|-----------|-------------|------|
| `src/lib/data-service/client.ts` | `DATA_SERVICE_2_URL/v1/stream/ticks` | Live market ticks via data-service2.0 |
| `src/services/brokers/client.ts` | `DATA_SERVICE_2_URL/v1/stream/ticks` | Crypto tickers via data-service2.0 |
| `worker/src/jobs/liquidations.ts` | `DATA_SERVICE_2_URL/v1/stream/ticks` | Liquidations via data-service2.0 |

**All WebSocket connections go to data-service2.0. Zero direct provider WebSocket connections.**

## Conclusion

**PROVIDER ZERO ACCESS: CONFIRMED**

No AlphaForge code directly accesses any market-data provider. All market data flows through `data-service2.0` exclusively.
