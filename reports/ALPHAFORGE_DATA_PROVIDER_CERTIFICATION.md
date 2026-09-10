# ALPHAFORGE — DATA PROVIDER CERTIFICATION

Companion to the forensic audit. This certifies **what each provider actually
supplies, as implemented in code** (not as advertised). Runtime latency /
reliability figures are **NOT VERIFIED** here — they require a live session and
are called out explicitly.

Provider chain (TypeScript `ProviderRegistry`, priority order):
`scrapling (data-service) → angel_one → upstox → yahoo`.
NSE removed from the TypeScript runtime chain (Absolute Rule 10 upheld in TS).

---

## 1. Data-source matrix (DATA TYPE × PROVIDER)

Legend: ✓ SUPPORTED · ~ PARTIAL · ✗ UNSUPPORTED · (ds) served via data-service
direct NSE/BSE acquisition behind the `scrapling` id.

| Data type | scrapling (data-service) | angel_one (TS) | upstox (TS+PY) | yahoo (TS) |
|---|---|---|---|---|
| LTP | ✓ (ds: NSE NextApi) | ✓ | ✓ | ~ (delayed ~15m) |
| OHLC (quote) | ✓ (ds) | ✓ | ✓ | ✓ |
| Historical daily | ✓ (ds: Bhavcopy) | ✓ | ✓ | ✓ (equity) |
| Historical intraday | ~ (ds: current-day only, synthesized OHLC, volume=0) | ✓ (5m/15m/1h) | ~ (1m/30m/day/wk/mo only) | ~ (1m/5m/15m/30m/1h) |
| Option chain | ✓ (ds: NSE/BSE) | ✓ | ✓ | ✗ (throws) |
| OI | ✓ (ds; now flagged when missing) | ✓ | ✓ (now flagged when missing) | ✗ (null) |
| IV / greeks | ~ (ds: NSE when present) | ✓ | ✓ | ✗ |
| bid / ask | ~ (ds: NSE opt only; BSE null) | ✓ | ✓ | ✗ |
| volume | ✓ (ds; intraday=0 placeholder) | ✓ | ✓ | ✓ |
| expiry / strike | ✓ | ✓ | ✓ | ✗ |
| instrument master | ✓ (ds: F&O lots CSV + fallback) | ✓ | ✗ (`instrumentMaster:false`) | ✗ (`[]`) |
| WebSocket / live feed | ~ (polling, now `synthetic`) | ✓ (true WS) | ✓ (true WS) | ~ (polling, `synthetic`) |

Notes:
- `scrapling` proxies the Python data-service, whose real acquisition is
  **direct NSE/BSE scraping** (see forensic audit §10). The only real *broker*
  client in the Python service is Upstox.
- Angel One and Yahoo clients exist **only in the TypeScript layer**; there is
  no Angel/Yahoo client in `data-service/src/`.

---

## 2. Per-provider contract compliance

Every provider must satisfy the `MarketDataProvider` normalized contract
(`provider.ts`). Findings from the code audit:

### scrapling (data-service gateway) — priority 0
- **Provenance:** `MDQuote`/`OptionChain` carry `provider`+`fetchedAt`;
  candles do not. Rich lineage exists server-side but is in-memory only.
- **Trust-through risk (open):** `getHistoricalCandles`/`getQuotes` return the
  data-service JSON without local `filterValidCandles` / OHLC re-validation.
- **Live feed:** polling; **now marked `synthetic: true`** (RCA-D03 fix).
- **Rate limiting:** client-side token bucket in `dsGet`.
- **Enablement:** only when `DATA_SERVICE_URL` is set; otherwise silently
  absent (returns `[]`/`null`) — an enablement gap to surface, not an error.

### angel_one — priority 1 (primary, full-capability)
- **Provenance:** quotes/option legs carry provider + real `exchangeTimestamp`
  on ticks. **GOOD.**
- **Silent zero (residual):** candle `volume: finiteOrNull(r[5]) ?? 0` — missing
  volume becomes 0. Lower severity than OI (documented in gap report G-06).
- **`getQuotes` catch → all-null** (BUG B3, open): a provider error yields an
  all-null array indistinguishable from unresolved symbols.

### upstox — priority 2
- **Silent zero (FIXED):** option OI/oiChange/volume were `?? 0`; now flagged
  `oiMissing`/`oiChangeMissing`/`volumeMissing` and excluded from analytics.
- **Candle validation (Python side, FIXED):** now full OHLC invariant check.
- **`getQuotes` catch → all-null** (BUG B3, open), same as angel.

### yahoo — priority 3 (fallback, delayed)
- **Stale-as-live (FIXED):** live ticks now `synthetic:true` with
  `feedDelayMs = 15min`; no longer stamp a fresh exchange timestamp.
- Correctly reports `oi: null`, throws on option chain, `[]` on instrument
  master — honest unsupported-capability behaviour. **GOOD.**

---

## 3. Resilience primitives (verified by reading code, not runtime)

| Primitive | TS layer | Python data-service |
|---|---|---|
| Typed error taxonomy | ✓ `MarketDataError` + `httpStatus` + `retryAfterMs` | ✓ `ProviderError` subclasses |
| Retry + backoff + jitter | ✓ (`failover.ts`) | ✓ (`provider_http.py`, Upstox only) |
| 503/429 backoff ladder | ✓ 1–60s | ✓ 1–60s |
| Retry-After honoured | ✓ (cap 60s) | ✓ (cap 60s) |
| Never retry 403 | ✓ | ✓ ("NEVER hammer a 403") |
| Circuit breaker | ✓ per-provider + per-capability | ✓ per-source |
| Failover cooldown | ✓ 10s | ✗ (no cross-provider failover in Python) |
| Rate limiter | ✓ (scrapling/angel token buckets) | ~ (NSE/BSE scraper only; not NextApi/Upstox) |

---

## 4. Certification verdict

| Provider | Contract | Resilience | Provenance | Integrity | Verdict |
|---|---|---|---|---|---|
| scrapling | ✓ | ✓ | ~ | ~ (trust-through) | **CONDITIONAL** |
| angel_one | ✓ | ✓ | ✓ | ~ (volume `??0`) | **CONDITIONAL** |
| upstox | ✓ | ✓ | ✓ | ✓ (post-fix) | **CERTIFIED (code-level)** |
| yahoo | ✓ | ✓ | ✓ (post-fix) | ✓ | **CERTIFIED (fallback role)** |

"CERTIFIED (code-level)" means the code paths satisfy the integrity/provenance
rules; live latency, error-rate, and coverage remain **NOT VERIFIED** and must
be measured in a market session before production certification.
