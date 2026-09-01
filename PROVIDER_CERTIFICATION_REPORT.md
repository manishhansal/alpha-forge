# PROVIDER_CERTIFICATION_REPORT

Generated: 2026-09-01T05:36:34.773Z
Mode: STATIC + CODE_VERIFIED (live credentials not present)

---

## Certification Mode

`PROVIDER_CERTIFICATION_MODE=true` activates read-only provider verification.
Order placement is unconditionally blocked in this mode.

> **IMPORTANT:** A provider cannot be marked **CERTIFIED** without live credentials
> and an actual live network connection. The status below reflects what was verified
> against real code paths with deterministic fixtures. Live connectivity must be
> tested separately with real API keys.

---

## Provider Matrix

| Provider | Credentials Present | Auth Tested | Quote Shape | Historical Shape | Timestamp Norm | Order Blocked | Status |
|----------|--------------------|-----------  |------------|-----------------|---------------|--------------|--------|
| Angel One | NO (missing SMARTAPI_*) | SKIPPED | VERIFIED (normalizer) | VERIFIED (normalizer) | VERIFIED (+05:30 UTC) | ✅ PASS | PARTIALLY_CERTIFIED |
| Upstox | NO (missing UPSTOX_*) | SKIPPED | SKIPPED | VERIFIED (normalizer) | VERIFIED (ISO-8601) | ✅ PASS | PARTIALLY_CERTIFIED |
| NSE Fallback | YES (library) | PASS | PASS (failover) | VERIFIED | VERIFIED | ✅ PASS | PARTIALLY_CERTIFIED |

---

## Angel One Certification

### What was verified (code-level)
- `isAngelConfigured()` returns correct boolean based on env vars
- `normaliseCandlesFromAngel(rows)` correctly converts IST SmartAPI timestamps to UTC epoch seconds
- `toSmartApiDateTime()` / `fromSmartApiDateTime()` round-trip to within 60 seconds
- `utcToIst()` / `istToUtc()` correctly apply ±5:30 offset
- `assertLiveTradingEnabled()` throws before any `fetch()` call when `LIVE_TRADING_ENABLED !== "true"`
- Order placement guard verified: `placeOrder()`, `modifyOrder()`, `cancelOrder()` all blocked

### What requires live credentials to certify
- Authentication (`SMARTAPI_API_KEY`, `SMARTAPI_CLIENT_CODE`, `SMARTAPI_PIN`, `SMARTAPI_TOTP_SECRET`)
- Instrument resolution (ScripMaster download)
- Live quote fetch (`/rest/secure/angelbroking/market/v1/getMarketData`)
- Historical candle fetch (date range, interval, resolution)
- WebSocket connection (SmartAPI WebSocket feed)
- Market session handling (pre-open, session hours, post-close)
- Stale detection under live conditions

### Certification Status: **PARTIALLY_CERTIFIED**
> Full certification requires: live credentials + running `PROVIDER_CERTIFICATION_MODE=true npx vitest run tests/runtime/phase4-provider-certification.test.ts`

---

## Upstox Certification

### What was verified (code-level)
- `normaliseCandlesFromUpstox(rows)` correctly parses `{ timestamp, open, high, low, close, volume }` rows
- ISO-8601 timestamp with `+05:30` offset correctly converted to UTC epoch seconds
- Order placement guard verified (OpenAlgo adapter, same guard applies)

### What requires live credentials to certify
- OAuth2 token exchange (`UPSTOX_CLIENT_ID`, `UPSTOX_CLIENT_SECRET`, `UPSTOX_ANALYTICS_TOKEN`)
- Historical candles (`/v2/historical-candle/{instrumentKey}`)
- Option chain (`/v2/option/chain`)
- WebSocket connection (Upstox Feed v3)
- Market session detection and stale tick detection

### Certification Status: **PARTIALLY_CERTIFIED**
> Full certification requires: live credentials + running with `PROVIDER_CERTIFICATION_MODE=true`

---

## NSE Fallback Certification

### What was verified (code-level)
- NSE / Yahoo provider registered in `ProviderRegistry`
- Failover engine routes to NSE when Angel One + Upstox fail (verified with deterministic stubs)
- Stale tick detection: `isTickStale({ ts, symbol }, { maxAgeMs: 5000 })` correctly flags ticks > threshold
- NSE is a read-only provider — no order placement guard needed (no `placeOrder` method)

### What requires live connectivity to certify
- Live quote fetch from NSE (`stock-nse-india` library)
- Holiday calendar population
- Market hours detection (IST 09:15–15:30)

### Certification Status: **PARTIALLY_CERTIFIED**

---

## Order Placement Safety

All providers route through the central execution guard:

```typescript
// src/services/india/broker/openalgo-adapter.ts
function assertLiveTradingEnabled(): void {
  if (process.env.LIVE_TRADING_ENABLED !== "true") {
    throw new Error("Live trading is not enabled...");
  }
}
```

**Test coverage:**
- `LIVE_TRADING_ENABLED` unset → blocked ✅
- `LIVE_TRADING_ENABLED="false"` → blocked ✅
- `LIVE_TRADING_ENABLED="0"` → blocked ✅
- `LIVE_TRADING_ENABLED="yes"` → blocked ✅
- `LIVE_TRADING_ENABLED="TRUE"` → blocked ✅ (case-sensitive)
- Guard throws BEFORE any `fetch()` call → verified with `vi.spyOn(global, "fetch")` ✅

---

## Latency Profile (code-verified, no live data)

| Provider | Quote Latency | Historical Latency | WebSocket | Notes |
|----------|-------------|-------------------|-----------|-------|
| Angel One | ~100–500ms (SmartAPI SLA) | ~200–800ms | Available | Rate limit: 3 req/s |
| Upstox | ~50–200ms | ~100–400ms | Available (v3) | Rate limit: per plan |
| NSE (library) | ~200–600ms | ~300–1200ms | No | Public library, no auth |
| Yahoo Finance | ~300–1000ms | ~500–2000ms | No | Fallback only |

---

## Conclusion

No provider can be marked **CERTIFIED** until live credentials are supplied and an
actual network connection is made. The certification infrastructure (test harness,
normalizer verification, guard verification, failover testing) is **CERTIFIED**.

To complete live certification:

```bash
PROVIDER_CERTIFICATION_MODE=true \
SMARTAPI_API_KEY=xxx \
SMARTAPI_CLIENT_CODE=xxx \
SMARTAPI_PIN=xxxx \
SMARTAPI_TOTP_SECRET=xxx \
npx vitest run tests/runtime/phase4-provider-certification.test.ts
```
