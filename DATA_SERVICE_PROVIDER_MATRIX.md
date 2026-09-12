# DATA SERVICE PROVIDER MATRIX
**AlphaForge — Provider Capability Registry**  
**Date:** 2026-09-12  
**Branch:** refactor/signals  
**Status:** PRODUCTION — based on live probes and adapter code inspection

---

## 1. PROVIDER PRIORITY ORDER

```
Priority 0 → ScraplingProvider   (data-service HTTP gateway)
Priority 1 → AngelOneProvider    (SmartAPI v2)
Priority 2 → UpstoxProvider      (Upstox v2/v3)
Priority 3 → YahooProvider       (yahoo-finance2, last resort)

PROHIBITED:
  NSEProvider  → TOMBSTONED (2026-09-03), all methods throw
  3m interval  → PERMANENTLY BLOCKED (V8, 2026-09-12)
```

---

## 2. CAPABILITY MATRIX

### ScraplingProvider (data-service HTTP, port 8200)

| Capability | Supported | Notes |
|---|---|---|
| Live equity quotes | YES | NSE XHR via Scrapling |
| Live index quotes | YES | NSE XHR |
| Live option chain | YES | NSE page scraping |
| 1m historical | PARTIAL | Current day only via openchart |
| 5m historical | YES | openchart |
| 10m historical | YES | openchart |
| 15m historical | YES | openchart |
| 30m historical | YES | openchart |
| 1h historical | YES | openchart |
| 1d historical | YES | jugaad-data bhavcopy |
| 1w historical | YES | derived from 1d |
| 1M historical | YES | derived from 1d |
| 3m | BLOCKED | Hard-blocked V8 — acquisition_planner.py raises ValueError |
| Historical F&O OI | YES | jugaad-data |
| Historical option IV | NO | Not available from any open source |
| Instrument master | YES | NSE scrip master via scraping |
| F&O universe | YES | NSE F&O eligible list |
| WebSocket streaming | NO | Uses Redis pub/sub instead |
| Authenticated | NO | Credential-free public endpoints |
| Rate limit | 8 req/s | NSE-sensitive, token bucket enforced |

---

### AngelOneProvider (SmartAPI v2)

| Capability | Supported | Notes |
|---|---|---|
| Live equity quotes (batch) | YES | Up to 50 tokens per call |
| Live index quotes | NO | Indices return false empty — route to Upstox |
| Live option chain | YES | Synthesized: ScripMaster + Quote API + optionGreek |
| Live option IV | YES | optionGreek API per strike |
| 1m historical (equity) | YES | SmartAPI `ONE_MINUTE` |
| 5m historical (equity) | YES | SmartAPI `FIVE_MINUTE` |
| 10m historical (equity) | YES | SmartAPI `TEN_MINUTE` |
| 15m historical (equity) | YES | SmartAPI `FIFTEEN_MINUTE` |
| 30m historical (equity) | YES | SmartAPI `THIRTY_MINUTE` |
| 1h historical (equity) | YES | SmartAPI `ONE_HOUR` |
| 1d historical (equity) | YES | SmartAPI `ONE_DAY` |
| 1w historical | NO | SmartAPI has no weekly candle |
| 1M historical | NO | SmartAPI has no monthly candle |
| 3m | BLOCKED | `intervalToSmartApi()` returns null, capability matrix excludes |
| Historical F&O OI | PARTIAL | Via getOiBuildup (near-month only) |
| Historical option IV | NO | optionGreek is live-only |
| Instrument master | YES | ScripMaster dump (cached 24h) |
| WebSocket | YES | SmartStream 2.0 binary, auto-reconnect |
| Broker analytics | YES | PCR, OI buildup, gainers/losers (SmartAPI-specific) |
| Authenticated | YES | TOTP + clientCode + password → JWT until midnight IST |
| Rate limit | 3 req/s | Historical API hard limit |
| Concurrency | Bounded | Token bucket + RequestQueue serialisation |

---

### UpstoxProvider (v2/v3)

| Capability | Supported | Notes |
|---|---|---|
| Live equity quotes | YES | v2 Quote API |
| Live index quotes | YES | Upstox supports NIFTY, BANKNIFTY, FINNIFTY |
| Live option chain | YES | v2 option chain API |
| Live option IV | PARTIAL | Where provided inline by Upstox |
| 1m historical (v2) | YES | Upstox v2 `1minute` |
| 5m historical (v2) | NO | Not natively supported in v2 — use v3 |
| 10m historical (v2) | NO | Not natively supported in v2 |
| 15m historical (v2) | NO | Not natively supported in v2 |
| 30m historical (v2) | YES | Upstox v2 `30minute` |
| 1h historical (v2) | NO | Not natively supported in v2 |
| 1d historical (v2) | YES | Upstox v2 `day` |
| 1w historical (v2) | YES | Upstox v2 `week` |
| 1M historical (v2) | YES | Upstox v2 `month` |
| 1m historical (v3) | YES | v3 `1minute` |
| 5m historical (v3) | YES | v3 `5minute` |
| 15m historical (v3) | YES | v3 `15minute` |
| 30m historical (v3) | YES | v3 `30minute` |
| 1h historical (v3) | YES | v3 `60minute` |
| 1d historical (v3) | YES | v3 `1D` |
| 1w historical (v3) | YES | v3 `1W` |
| 1M historical (v3) | YES | v3 `1M` |
| 3m | BLOCKED | Not in v2 or v3 interval map |
| Index historical (v3) | YES | NIFTY, BANKNIFTY — use v3 for indices |
| Instrument master | NO | ISIN-based key map only (not full master) |
| WebSocket | YES | v3 Protobuf feed, auto-reconnect |
| Authenticated | YES | UPSTOX_ANALYTICS_TOKEN or per-user DB token |
| Rate limit | 250 req/min | ~4 req/s sustained |

---

### jugaad-data (inside data-service Python)

| Capability | Supported | Notes |
|---|---|---|
| Equity historical EOD (1d) | YES | NSE bhavcopy |
| Futures historical EOD | YES | F&O bhavcopy — OI + volume |
| Options historical EOD | YES | Strike-level OI, volume |
| Expiry dates | YES | From NSE F&O bhavcopy |
| Strike-level data | YES | CE/PE per strike per expiry |
| Option IV (historical) | NO | Not in bhavcopy |
| Intraday candles | NO | EOD only |
| Live quotes | NO | Historical only |
| 3m | BLOCKED | acquisition_planner.py rejects |

---

### openchart (inside data-service Python)

| Capability | Supported | Notes |
|---|---|---|
| 1m historical | YES | NSE charting API |
| 5m historical | YES | NSE charting API |
| 10m historical | YES | NSE charting API |
| 15m historical | YES | NSE charting API |
| 30m historical | YES | NSE charting API |
| 1h historical | YES | NSE charting API |
| 1d historical | YES | NSE charting API |
| 1w historical | YES | NSE charting API |
| 1M historical | YES | NSE charting API |
| 3m | BLOCKED | adapter.py raises — hard blocked |
| OI | NO | OHLCV only |
| IV | NO | OHLCV only |
| Live quotes | NO | Historical only |
| Authentication | NO | Requires curl_cffi Chrome TLS session + NSE cookie |
| Rate limit | ~2 req/s | NSE charting endpoint — sensitive |

---

### YahooProvider (yahoo-finance2, last resort)

| Capability | Supported | Notes |
|---|---|---|
| Equity historical EOD (1d) | YES | NSE via `.NS` suffix |
| Equity historical intraday (1m–1h) | YES | Limited depth, delayed |
| Live equity quotes | YES | 15-min delayed during market hours |
| Live index quotes | PARTIAL | `^NSEI`, `^BSESN` — delayed |
| 1w/1M historical | YES | Derived from daily data |
| 3m | N/A | Not applicable (not Indian market interval) |
| Option chain | NO | Yahoo does not provide NSE option chains |
| OI | NO | Not available |
| IV | NO | Not available |
| Bid/Ask | NO | Not available |
| F&O-specific data | NO | Cash equities only |
| Authenticated | NO | Public endpoints |
| Quality cap | B | Yahoo-derived data capped at grade B |
| Provenance | `SECONDARY_FALLBACK` | Always marked as secondary |

---

## 3. ROUTING DECISIONS BY DATASET

| Request | Primary | Fallback | Yahoo allowed? |
|---|---|---|---|
| Live equity quote (LTP) | scrapling → | angel_one → upstox | YES (delayed) |
| Live index quote (NIFTY) | scrapling → | upstox | NO for production trading |
| Live option chain (NIFTY) | scrapling → | angel_one → upstox | NEVER |
| Historical 1m equity | angel_one → | upstox_v3 → openchart | NEVER |
| Historical 5m equity | angel_one → | upstox_v3 → openchart | NEVER |
| Historical 10m equity | angel_one → | openchart | NEVER |
| Historical 15m equity | angel_one → | upstox_v3 → openchart | NEVER |
| Historical 30m equity | angel_one → | upstox → openchart | NEVER |
| Historical 1h equity | angel_one → | upstox_v3 → openchart | NEVER |
| Historical 1d equity | scrapling/jugaad → | angel_one → upstox | YES (fallback) |
| Historical 1w equity | scrapling → | upstox → | YES |
| Historical 1M equity | scrapling → | upstox → | YES |
| Historical 5m index | upstox_v3 → | openchart | NEVER |
| Historical F&O OI (EOD) | jugaad (via scrapling) | | NEVER |
| Instrument master | scrapling → | angel_one | NO |
| F&O universe | scrapling | | NO |
| 3m (any) | BLOCKED | | BLOCKED |

---

## 4. BROKER ANALYTICS (SmartAPI-specific, no registry equivalent)

These endpoints are Angel One SmartAPI-specific. No generic `MarketDataProvider` interface for them. Callers access them directly from approved exception files.

| Endpoint | SmartAPI URL | Callers |
|---|---|---|
| `getPutCallRatio()` | `/marketData/v1/putCallRatio` | scanner/engine.ts, ai-signals/india-builder.ts |
| `getOiBuildup()` | `/marketData/v1/OIBuildup` | scanner/engine.ts, daily-picks/builder.ts, ai-signals/india-builder.ts |
| `getTopGainersLosers()` | `/marketData/v1/gainersLosers` | scanner/engine.ts |

**Future:** Add `getBrokerAnalytics()` to `MarketDataProvider` interface and expose via data-service `/v1/brokers/analytics` endpoint.

---

## 5. 3m CONFIRMATION

3m is blocked at **every layer**:

| Layer | Mechanism |
|---|---|
| TypeScript registry | `provider-capability-matrix.ts` — absent from all interval maps |
| TypeScript signal gate | `v8-signal-data-gate.service.ts` — hard blocks `interval === "3m"` |
| TypeScript candle builder | `candle-builder.service.ts` — "3m permanently removed" comment + no case |
| Python acquisition planner | `acquisition_planner.py:160` — `if interval_str == "3m": raise ValueError` |
| Python normalizer | `normalizer.py:137` — rejects at normalization entry |
| Python openchart adapter | `adapter.py:193` — `if interval_str == "3m": raise` |
| Python provenance | `provenance.py:220` — `if interval_str == "3m": raise` |
| Python registry | `registry.py:383` — `if timeframe == "3m": raise` |
| Data-service API routes | `gaps/route.ts:47` — `NOT: { intervalStr: "3m" }` in DB queries |
| Angel One live probe | 2026-09-12 — returns 0 bars for 3m (confirmed) |
