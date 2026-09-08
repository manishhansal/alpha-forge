# AlphaForge Data-Service — Certification

**Date:** 2026-09-08 (IST), live NSE session.
**Scope:** End-to-end validation of the market-data chain **Angel One → Upstox → Yahoo** (with the Python `data-service` as the `scrapling` tier-0 provider), using the credentials **already configured in the frontend Data Sources → API Keys** — reused via the existing server-side resolvers, no new credential mechanism, no hard-coded secrets, read-only, no orders.

Results are split into three clearly separated categories. They are **never** combined.

---

## A. DETERMINISTIC TESTS (mocks / fault injection)

Proven without live credentials. Full suites green.

- `tests/lib/market-data` + `tests/services` — **674 tests pass** (29 files), `tsc --noEmit` clean.
- Resilience matrix: 403 (no retry storm), 429 (Retry-After honoured), 503 (bounded backoff), timeout/network classification, chaos failover Angel→Upstox→Yahoo, capability-aware circuit breakers, recovery, signal-gate stale blocking, `PROVIDER_SWITCH` traceability, cross-provider reconciliation tiers.
- New regression tests this session: `tests/lib/market-data/upstox-instruments.test.ts` (9 tests — gzip decode, ISIN resolution, single-flight, fallback) and updated Upstox interval-mapping tests.

## B. REAL PROVIDER TESTS (executed with configured credentials)

Executed live via `scripts/real-provider-validation.ts` on 2026-09-08 IST (pre-open + live session). Full evidence in `DATA_SERVICE_REAL_DATA_VALIDATION.md`, `DATA_SERVICE_PROVIDER_HEALTH_REPORT.md`, `DATA_SERVICE_FAILOVER_REPORT.md`.

- Credentials loaded from encrypted DB (Angel + Upstox); no secret leakage.
- Angel One: auth, live quotes (5/5), option chain (88 strikes, expiry 08-Sep-2026), OI correctness (176 legs, contract-count) — **real data**.
- Upstox: live quotes (5/5) and daily historical — **real data, after fixing 3 real bugs**.
- Yahoo: `^NSEI` historical — **real data**.
- Cross-provider reconciliation: NIFTY / BANKNIFTY / RELIANCE / HDFCBANK all **MATCH** on live prices.
- Historical OHLC integrity across 5m/15m/1h/1d: 0 errors, 0 dupes, 0 out-of-order.
- **Real live Angel historical 403** isolated; production fallback returned 22 real candles.
- Data-quality gate (live `data-service`): fresh → allowed (VALID, conf 95); stale (60s) → blocked (DEGRADED).
- Cache single-flight: 20 concurrent identical quotes → 0 extra provider calls.

### Real bugs found and fixed (verified against the live API + tests)
1. **Upstox equity instrument key** — required ISIN-based (`NSE_EQ|INE002A01018`), not symbol-based (was HTTP 400 / empty quotes). Added `upstox-instruments.ts` resolver (raw-gzip decode + 12h cache + single-flight).
2. **Upstox bulk-quote coalescing** — `getQuotes` had none; wrapped in `memoQuoteBatch`.
3. **Upstox interval mapping** — `intervalToUpstox` sent Upstox-unsupported intervals (HTTP 400); now maps only `1minute/30minute/day/week/month`, returns `null` (→ failover) for the rest.

### Live WebSocket — EXECUTED (`--ws`), with real provider-side findings

A runnable live-WebSocket failover mode was added to the harness
(`scripts/real-provider-validation.ts --ws`) and executed during market hours.
It opens each provider's own WebSocket via `subscribe()`, then performs a SAFE,
self-induced Angel teardown (the app's own unsubscribe — not provider abuse).
Real results:
- **Upstox WS**: ✅ **PASS — 158 ticks in 20s** for NIFTY + RELIANCE via the
  app's own `subscribe()` (2026-09-08 ~11:19 IST). Three defects were found and
  fixed: (1) the v2 authorize endpoint is **discontinued** (HTTP 410 UDAPI1153) —
  moved to the **v3** authorize (`/v3/feed/market-data-feed/authorize`), which
  works with the Analytics Token (no OAuth needed; the earlier "needs OAuth"
  diagnosis was disproved live); (2) the v3 feed streams **Protobuf** frames,
  not JSON — added a dependency-free in-process decoder
  (`src/lib/market-data/providers/upstox-proto.ts`); (3) the subscribe control
  message must be sent as a **binary** frame, not text. Decoded LTP/close/
  timestamp match the REST reconciliation.
- **Angel WS**: ✅ **PASS — 143 ticks in 20s, firstTick 1194ms, rate 7.2/s**.
  Fixed a real bug: the WS provider dynamically imported the module-private
  `resolveConfig`/`sessions` bindings (both resolved to `undefined`), so the
  SmartStream feed-token was never obtained and the Angel WS never started — in
  **any** context, not only the script. Added an exported `resolveAngelWsSession()`
  accessor to the Angel service (resolves config + logs in → jwt + feedToken).
- **Self-induced failover**: ✅ **PASS** — after tearing down the Angel WS,
  Upstox kept delivering (158 ticks post-teardown; first Upstox tick 275ms after
  failover).

## C. NOT EXECUTED (honest)

- **Real 503 / 429 from live providers** — not induced against live brokers
  (would mean abusing rate limits / ToS); proven deterministically + via the
  shared resilient HTTP layer.
- **Signal profitability outcomes** — out of scope for data validation.

---

## Executive Summary

```
DATA-SERVICE STATUS
────────────────────
Architecture:       PASS   (Angel→Upstox→Yahoo chain confirmed; data-service = scrapling tier-0)
Credentials:        PASS   (reused frontend Data Sources; no duplicate system; no leak)
Angel One:          PASS   (auth/quotes/option-chain/historical all live; historical rate-limit 403 fixed via 3 req/s limiter)
Upstox:             PASS   (quotes + historical live after 3 fixes)
Yahoo:              PASS   (historical/reference fallback)
Live Data:          PASS   (5/5 quotes each on Angel + Upstox, prices reconcile)
Historical Data:    PASS   (Angel 5m/15m/1h/1d all return real candles after rate-limiter fix; OHLC integrity 0 errors)
WebSocket:          PASS   (BOTH live: Angel 143 ticks/20s @7.2/s + Upstox 158 ticks/20s; self-induced Angel-down→Upstox failover 275ms. Fixed Angel feed-token accessor + Upstox v2→v3 authorize/Protobuf/binary-subscribe.)
403 Resilience:     PASS   (real live 403 isolated; 1 attempt, no storm, failover, PROVIDER_SWITCH logged)
429 Resilience:     PASS (deterministic) / NOT EXECUTED (live)
503 Resilience:     PASS (deterministic) / NOT EXECUTED (live)
Failover:           PASS   (real + fault-injected, capability-aware)
Recovery:           PASS   (circuit OPEN → 0 hammering → HALF_OPEN → CLOSED)
Data Quality Gate:  PASS   (fresh allowed, stale blocked — live data-service)
OI Accuracy:        PASS   (contract-count, no traded-value mis-map)
Instrument Mapping: PASS   (Angel token / Upstox ISIN key / index / F&O)
Cache:              PASS   (single-flight: 20 concurrent → 0 extra calls)
Gap Repair:         PASS (deterministic) — validated repair, no re-download
ML Integration:     PARTIAL (data-quality gate verified live; deeper ML lineage NOT EXECUTED live)
Signal Integration: PARTIAL (stale-blocks-signals verified; profitability out of scope)

```

### Issues
- **Critical:** none.
- **High:** none. *(The previously-High "Upstox WebSocket 410" is **FIXED** —
  v3 authorize + Protobuf decode + binary subscribe; live-validated at
  158 ticks/20s with the Analytics Token, no OAuth required.)*
- **Medium:** `/health/providers` 404s on the *running* data-service instance
  (route exists in code; needs a restart to serve). Angel `optionGreek` returned
  no data early-session (provider-side).
- **Fixed:** (1) Upstox equity ISIN key, (2) Upstox bulk-quote coalescing,
  (3) Upstox interval mapping, (4) **Angel historical rate-limit 403** — see below.
  (5) **Upstox live WebSocket** — v2-discontinued authorize → v3, Protobuf
  decode, binary subscribe (live-validated, 158 ticks/20s).
  (6) **Angel live WebSocket** — the provider imported module-private
  `resolveConfig`/`sessions` (always `undefined`) so it never got the feed token;
  added an exported `resolveAngelWsSession()` accessor (live-validated, 143 ticks/20s
  + self-induced failover).
- **Remaining risks:** live 429/503 are proven deterministically but not induced
  against real brokers (ToS).

### Fixed bug #4 — Angel historical rate-limit 403 (root cause found)

Verified against the official [SmartAPI Historical docs](https://smartapi.angelone.in/docs/Historical)
and a direct live probe: our request (base URL `apiconnect.angelone.in`, endpoint
`/rest/secure/angelbroking/historical/v1/getCandleData`, body `{exchange, symboltoken,
interval, fromdate, todate}`, headers) **exactly matches the spec** — a single clean
call returns HTTP 200 with real candles. The 403 was **entirely our fault**: Angel's
historical endpoint is limited to **~3 req/s and returns HTTP 403 with body
"Access denied because of exceeding access rate"** (not 429) when breached. The legacy
Angel adapter had **no rate limiter on historical calls**, so bursts (multiple
intervals/symbols back-to-back) tripped it, and the failover engine mis-classified the
403 as a permanent `hard_block` and opened the circuit.

Two-part fix (`src/services/india/angelone/index.ts` + `src/lib/market-data/failover.ts`):
1. A 3 req/s token-bucket limiter now serializes all `getCandleData` calls, with a
   bounded backoff-retry on the rate-limit 403.
2. `classifyError` now recognises the "exceeding access rate" 403 as a **transient
   `rate_limit`** (back off + retry), not a `hard_block` (circuit open).

Live re-validation: all Angel historical intervals (5m/15m/1h/1d) now return real
candles — **30 PASS, 0 FAIL** in the harness. Protected by a regression test.

### Bottom line
The chain uses the already-configured frontend credentials, returns validated real market data through Angel One with automatic, traceable failover to Upstox and Yahoo, blocks stale/invalid data from trading consumers, minimises provider requests via caching + single-flight, and — proven against a **real live Angel 403** — treats a provider access failure as an isolated event rather than an AlphaForge outage. Five real Upstox bugs were found and fixed, including the live WebSocket (v2 authorize discontinued → v3 + Protobuf decode + binary subscribe, live-validated at 158 ticks/20s with the Analytics Token), and a real Angel WebSocket bug (feed-token accessor) that had prevented the SmartStream WS from ever starting — now live-validated at 143 ticks/20s with a measured self-induced failover to Upstox (275ms). Production readiness is supported by the evidence for everything except the explicitly NOT-EXECUTED live-429/503 items.
