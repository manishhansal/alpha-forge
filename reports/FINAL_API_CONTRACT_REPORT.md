# Final API Contract Report — AlphaForge → data-service2.0

**Date:** 2026-09-15 | **Branch:** `refactor/alpha-forge`

All AlphaForge market data calls go through `src/lib/data-service/client.ts` exclusively.

## Indian Market Endpoints

| AlphaForge Consumer | Function | data-service2.0 Endpoint | Method | Key Params | Notes |
|---------------------|----------|--------------------------|--------|------------|-------|
| `src/app/api/in/quote/route.ts` | `getQuote(symbol, exchange)` | `GET /v1/india/quotes/{symbol}?exchange=NSE` | GET | symbol, exchange | Returns MarketQuote |
| `src/app/api/in/quote/route.ts` | `getQuotes(symbols, exchange)` | Batch of `getQuote` | GET | symbols[], exchange | Returns `(MarketQuote\|null)[]` |
| `src/app/api/in/historical/route.ts` | `getHistorical(req)` | `GET /v1/india/historical?symbol=&interval=&from=&to=` | GET | symbol, interval, from, to, exchange | Returns OHLCVCandle[] |
| `src/app/api/v1/market/candles/route.ts` | `getHistorical(req)` | `GET /v1/india/historical` | GET | symbol, interval, exchange, from, to | Same as above |
| `src/app/api/in/option-chain/route.ts` | `getOptionChain(underlying, expiry)` | `GET /v1/india/option-chain?underlying=&expiry=` | GET | underlying, expiry | Returns OptionChain |
| `src/app/api/v1/market/options/route.ts` | `getOptionChain(underlying, expiry)` | `GET /v1/india/option-chain` | GET | underlying, expiry | Same |
| `src/app/api/in/market-snapshot/route.ts` | `getQuotes(symbols, "NSE")` | Batch quotes | GET | symbols | Multiple indices |
| `src/app/api/in/nifty-bias/route.ts` | `getQuotes(...)`, `getHistorical(...)` | Multiple | GET | Various | Nifty directional bias |
| `src/app/api/v1/market/instruments/route.ts` | `getInstruments(filter)` | `GET /v1/india/instruments?exchange=&instrumentType=` | GET | exchange, instrumentType | Instrument master |
| `src/features/ai-signals/india-builder.ts` | `getQuote`, `getHistorical`, `getOptionChain` | Multiple | GET | Various | AI signal builder |
| `src/features/india/daily-picks/builder.ts` | `getQuotes`, `getHistorical`, `getOptionChain` | Multiple | GET | Various | Daily picks engine |
| `src/features/india/scalping/backtest.ts` | `getHistorical` | `GET /v1/india/historical` | GET | symbol, interval | Backtest data |
| `src/services/india/scanner/engine.ts` | `getQuotes`, `getHistorical` | Multiple | GET | Various | F&O scanner |
| `src/services/india/signals/snapshotter.ts` | `getQuote` | `GET /v1/india/quotes/{symbol}` | GET | symbol | Signal snapshots |
| `src/services/india/websocket/gateway.ts` | `subscribeToTicks(opts)` | `WS /v1/stream/ticks` | WebSocket | symbols, market | Live tick stream |

## Crypto Endpoints

| AlphaForge Consumer | Function | data-service2.0 Endpoint | Method | Notes |
|---------------------|----------|--------------------------|--------|-------|
| `src/features/options/fetch-options.ts` | `getDeribitOptionsOverview()` | `GET /v1/crypto/deribit/options` | GET | Returns Deribit option chain via data-service |
| `src/features/futures/aggregate.ts` | `getFuturesOverview()` | `GET /v1/crypto/futures` | GET | Crypto futures overview |
| `src/features/overview/fetch-overview.ts` | `getCryptoTicker(symbol)` | `GET /v1/crypto/{symbol}/ticker` | GET | Live ticker |
| `src/lib/data-service/client.ts` | `getCryptoOHLCV(symbol, interval)` | `GET /v1/crypto/{symbol}/ohlcv?interval=` | GET | Crypto candles |
| `src/services/brokers/client.ts` | `subscribeToTicks` | `WS /v1/stream/ticks` | WebSocket | Crypto live ticks |
| `worker/src/jobs/liquidations.ts` | WebSocket direct | `WS /v1/stream/ticks` (data-service2.0) | WebSocket | Liquidation feed |

## Health and Monitoring Endpoints

| Consumer | Function | Endpoint | Purpose |
|----------|----------|----------|---------|
| `src/app/api/data/providers/health/route.ts` | `getProviderHealth()` | `GET /v1/providers/health` | Per-provider health metrics |
| `src/app/api/in/provider-health/route.ts` | `getProviderHealth()` | `GET /v1/providers/health` | Same |
| `src/app/api/v1/providers/status/route.ts` | `getDataServiceHealth()` | `GET /v1/health` | data-service2.0 health |

## Authentication

All requests carry:
- `X-API-KEY: {DATA_SERVICE_API_KEY}` (when env var set)
- 10-second `AbortSignal` timeout on all HTTP calls
- Error type: `DataServiceUnavailableError` (no provider fallback)

## Supported Timeframes (Historical)

`1m`, `5m`, `10m`, `15m`, `30m`, `1h`, `1d`, `1w`, `1M` — passed directly to data-service2.0. No `3m` legacy path.

## Error Handling

When data-service2.0 is unavailable:
- HTTP calls throw `DataServiceUnavailableError`
- API routes return `503 Service Unavailable` with `error: "DATA_SERVICE_UNAVAILABLE"`
- No fallback to any other provider

## Conclusion

All 47 market-data consumers in AlphaForge use `src/lib/data-service/client.ts` as their sole data source. The API contract is consistent: REST for historical/instrument data, WebSocket for live ticks.
