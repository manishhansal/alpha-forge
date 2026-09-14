# DATA-SERVICE 2.0 Integration Guide

## Overview

data-service2.0 is the **sole market-data source** for AlphaForge.

- Base URL (Docker): `http://data-service:8200`
- Base URL (dev): `http://localhost:8200`  
- Configured via: `DATA_SERVICE_2_URL` env var
- Auth: `X-API-KEY: <DATA_SERVICE_API_KEY>` header

## TypeScript Client

All market data must be accessed through:

```typescript
import { getQuote, getQuotes, getHistorical, getOptionChain, ... } from "@/lib/data-service/client";
// or
import { DataServiceClient } from "@/lib/data-service/client";
```

**Never import from Angel One, Upstox, Yahoo, Binance, Deribit, or Delta Exchange.**

## Available Endpoints

### Indian Market

| Function | Endpoint | Description |
|---|---|---|
| `getQuote(symbol)` | `GET /v1/india/quotes/{symbol}` | Live quote |
| `getQuotes(symbols[])` | `GET /v1/india/quotes/{symbol}` × N | Batch quotes |
| `getHistorical(req)` | `GET /v1/india/historical` | OHLCV candles |
| `getOptionChain(underlying, expiry?)` | `GET /v1/india/option-chain` | Option chain |
| `getMarketStatus()` | `GET /v1/india/market/status` | NSE session state |
| `getInstruments(filter?)` | `GET /v1/india/instruments` | Instrument master |
| `getFNOUniverse()` | `GET /v1/india/instruments?exchange=NSE&type=EQ` | F&O universe |

### Crypto

| Function | Endpoint | Description |
|---|---|---|
| `getCryptoOHLCV(symbol, interval)` | `GET /v1/crypto/{symbol}/ohlcv` | Crypto candles |
| `getCryptoTicker(symbol)` | `GET /v1/crypto/{symbol}/ticker` | Crypto price |
| `getFuturesOverview()` | `GET /v1/crypto/futures/overview` | Futures data |
| `getDeribitOptionsOverview()` | `GET /v1/deribit/options/overview` | Options analytics |

### Streaming

| Function | Endpoint | Description |
|---|---|---|
| `subscribeToTicks(symbols, onTick)` | `WS /v1/stream/ticks` | Live tick stream |

### Health

| Function | Endpoint | Description |
|---|---|---|
| `getDataServiceHealth()` | `GET /v1/health/live` | Service health |
| `getProviderHealth()` | `GET /v1/analytics/providers` | Provider health |

## Supported Intervals (Indian Market)

`1m`, `5m`, `10m`, `15m`, `30m`, `1h`, `1d`, `1w`, `1M`

> ⛔ `3m` is permanently unsupported for Indian market data.

## Error Handling

```typescript
import { DataServiceUnavailableError } from "@/lib/data-service/client";

try {
  const quote = await getQuote("NIFTY");
} catch (err) {
  if (err instanceof DataServiceUnavailableError) {
    // data-service2.0 is down — report DATA_SERVICE_UNAVAILABLE
    // DO NOT fall back to any other provider
    return { error: "DATA_SERVICE_UNAVAILABLE" };
  }
  throw err;
}
```

## Response Envelope

data-service2.0 wraps all responses:

```json
{
  "data": { ... },
  "metadata": {
    "requestedAt": "2026-09-14T10:00:00.000Z",
    "dataAsOf": "2026-09-14T09:59:59.750Z",
    "dataSourceType": "LIVE",
    "provider": "angel_one"
  }
}
```

The `provider` field is informational — AlphaForge must not branch on it.

## Data Quality Gate

Before generating signals, check data quality:

```typescript
import { evaluateDataGate } from "@/lib/data-service/gate-client";

const gate = await evaluateDataGate({ symbol, quoteAgeMs, strategyId });
if (!gate.signalEngineAllowed) {
  return { blocked: true, reason: gate.blockReasons };
}
```
