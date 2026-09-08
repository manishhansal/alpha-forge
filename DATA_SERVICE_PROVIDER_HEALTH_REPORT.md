# AlphaForge Data-Service — Real Provider Health Report

**Date:** 2026-09-08 (IST), live NSE session. Real credentials from frontend Data Sources.

## Angel One (SmartAPI) — PRIMARY

| Capability | Result | Latency | Notes |
|---|---|---|---|
| Authentication (TOTP → JWT) | **HEALTHY** | — | Login succeeded; JWT cached to midnight IST |
| Live quotes | **HEALTHY** | 218–270 ms | 5/5 symbols priced (NIFTY, BANKNIFTY, RELIANCE, HDFCBANK, ICICIBANK) |
| Option chain | **HEALTHY** | ~5.0–5.5 s | 88 strikes, real expiry 08-Sep-2026, PCR/maxPain computed |
| Historical candles | **HEALTHY** | — | 5m/15m/1h/1d all return real candles. Earlier HTTP 403s were Angel's rate-limit ("exceeding access rate", ~3 req/s) — **fixed** by a 3 req/s token-bucket limiter + rate-limit-aware classification. Verified against the official SmartAPI Historical docs. |
| Option Greeks | **DEGRADED** | — | `optionGreek` → `AB9019 No Data Available` early in the session; Greeks null |
| WebSocket | **HEALTHY** ✅ | firstTick 1194ms | `--ws` run (2026-09-08 ~11:42 IST): **143 ticks in 20s, rate 7.2/s** via `subscribe()`. Fixed a real bug — the WS provider imported the module-private `resolveConfig`/`sessions` (always `undefined`), so it never obtained the feed token; added an exported `resolveAngelWsSession()` accessor. Self-induced Angel-down→Upstox-continues failover verified (Upstox first tick 275ms after teardown). |
| OI accuracy | **HEALTHY** | — | 176 legs, OI = contract count, no traded-value mis-map |
| Provider switches observed | 403 → Upstox (traceable `PROVIDER_SWITCH` events) | — | — |

**Root cause of the historical 403 (fixed):** Angel's historical endpoint is limited to ~3 req/s and returns **HTTP 403 "Access denied because of exceeding access rate"** (not 429) when breached. The legacy Angel adapter lacked a rate limiter on `getCandleData`, so bursts tripped it. Fixed with a 3 req/s token-bucket limiter + a rate-limit-aware `classifyError` (transient `rate_limit`, not `hard_block`). Confirmed by a direct live probe: a single clean spec-compliant call returns 200; a 6-call burst returned 5×403 pre-fix. Request shape verified against the official SmartAPI Historical docs (base `apiconnect.angelone.in`, `{exchange,symboltoken,interval,fromdate,todate}`).

## Upstox (Analytics v2) — SECONDARY

| Capability | Result | Latency | Notes |
|---|---|---|---|
| Authentication (Analytics Token) | **HEALTHY** | — | DB token resolved and accepted |
| Live quotes | **HEALTHY** | 248–320 ms | 5/5 priced **after the ISIN instrument-key fix** |
| Historical candles | **HEALTHY** | 69–113 ms | Daily candles returned; interval set corrected to Upstox-v2-supported values |
| Instrument key resolution | **HEALTHY** | 714 ms (cached) | Equity symbol → ISIN key via instrument master |
| WebSocket | **HEALTHY** ✅ | first tick sub-second | `--ws` run (2026-09-08 ~11:19 IST): **158 ticks in 20s** for NIFTY + RELIANCE via the app's own `subscribe()`, decoded LTP/close/timestamp. Fixed: v2 authorize discontinued (HTTP 410 UDAPI1153) → **v3** authorize (works with the Analytics Token — no OAuth needed); v3 feed is **Protobuf** → in-process decoder added; subscribe control frame must be **binary**. |
| Option chain | Available (not the configured primary this run) | — | — |

**Three real bugs found and fixed on the Upstox path** (all verified against the live API and protected by tests):
1. Equity instrument key must be ISIN-based (`NSE_EQ|INE002A01018`), not symbol-based — was causing HTTP 400 / empty quotes.
2. Bulk `getQuotes` had no caching/coalescing — 20 concurrent identical requests now produce 0 extra provider calls.
3. `intervalToUpstox` mapped `3m/5m/10m/15m/1h` to intervals Upstox v2 rejects (HTTP 400); now maps only supported units and returns `null` for the rest so the chain fails over.

## Yahoo Finance — FINAL FALLBACK

| Capability | Result | Notes |
|---|---|---|
| Historical / reference | **HEALTHY** | `^NSEI` daily returned 3 candles; used as last-resort historical/reference |
| Live quotes | Reference only | Delayed; not broker-grade — correct as tier-3 |

## Data-service (`scrapling` tier-0, port 8200)

| Capability | Result | Notes |
|---|---|---|
| `/health`, `/data/gate` | **HEALTHY** | Gate correctly allows fresh, blocks stale (see Failover report) |
| `/health/providers` | **404 on the running instance** | Route exists in code (`health_router.py`) but the running process predates it — requires a data-service restart to serve. Deploy artifact, not a code bug. |
