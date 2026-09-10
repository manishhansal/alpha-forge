# ALPHAFORGE DATA VALIDATION

**Angel One → Upstox → Yahoo provider chain + data integrity.** Read-only.
2026-09-09, git `1c2941b`.

---

## 1. PROVIDER CHAIN & FAILOVER (Phase 13)

The data layer is the **strongest, most production-credible** part of the system.

| # | Requirement | Implementation | Verdict |
|---|---|---|---|
| 1 | Provider priority DATA_SERVICE→ANGEL_ONE→UPSTOX→YAHOO | `registry.bootstrapRegistry` (priorities 0/1/2/3) | ✅ |
| 2 | Failover only after preceding provider fails | `failover.withFailover` (switch after retries exhausted / circuit open) | ✅ |
| 3 | Timeout / retry | 3 retries per provider | ✅ |
| 4 | Backoff | exponential + jitter; longer ladder for 429/503; Retry-After honored (cap 60s) | ✅ |
| 5 | Rate-limit handling | `classifyError` → `rate_limit`/`unavailable` kinds | ✅ |
| 6 | Stale-data detection | `health.STALE_THRESHOLDS_MS` (liveTick 5s, intraday 60s, daily 4h, optionChain 30s, instrument 12h) + `isStale`/`isTickStale` | ✅ |
| 7 | Provider provenance | `provider_switch` structured logs + `PaperTrade` provenance columns (`dataProviderAtEntry`, `quoteAgeAtEntryMs`, `dataIsFallback`, …) | ✅ |
| 8 | Timestamp consistency | tick validator rejects future-dated beyond 5s skew | ✅ |
| 9 | Candle completeness / OHLC validity | `validateOHLC` / `validateOHLCSequence` | ✅ |
| 10 | Duplicate removal | DB unique constraint on `CandleBar`; ⚠️ runtime cross-timeframe dedup is a known gap (DUP-001) | ⚠️ |
| 11 | Symbol mapping | instrument master per provider | ✅ |
| 12 | Market-session handling | session-aware staleness/thresholds | ✅ |
| 13 | Caching | TTL cache (30s intraday / 4h daily) | ✅ |
| 14 | Fallback correctness / no dataset mixing | circuit breaker + cooldown; per-capability | ✅ (code-level) |
| — | Failover cooldown (anti-oscillation) | 10s `FAILOVER_COOLDOWN_MS` | ✅ |

**Failover sequence check:** if Angel One fails → Upstox; if Upstox fails → Yahoo.
Implemented via ordered `registry` priorities consumed by `withFailover`. Providers
are `enabled` only when credentials are present (`DATA_SERVICE_URL`, Angel One
SmartAPI creds, Upstox token). ✅

---

## 2. NO DIRECT NSE (Phase 13, hard requirement)

✅ **SATISFIED.** `src/lib/market-data/providers/nse.ts` was **removed 2026-09-03**;
the module now exports only `NSE_PROVIDER_REMOVED_REASON`. `registry.ts` explicitly
does **not** register NSE ("Direct NSE data acquisition is prohibited in production").
`src/services/india/nse/index.ts` is a documented stub. No `nseindia.com` fetch path
is wired into the runtime.

---

## 3. DATA-TYPE VALIDATION (Phase 11 data items)

| Data type | Validation present | Verdict |
|---|---|---|
| quotes / candles / volume | OHLC + sequence validators, staleness | ✅ (code) |
| OI / option chain / PCR / IV / Greeks | option-chain staleness + reconciliation checks | 🟡 code present; not validated against live feed in CI |
| instrument master | 12h staleness threshold | ✅ (code) |
| timestamps / sessions | future-skew guard, session-aware thresholds | ✅ |

These are validated at the **code + unit-test** level. Runtime validation against a
live Angel One/Upstox feed requires credentials + network and was **not exercised** in
this audit → the derivatives/greeks items are 🟡 IMPLEMENTED BUT NOT (live-)VALIDATED.

---

## 4. CREDENTIALS

Credentials are env-gated and providers self-disable when unset. No obvious credential
logging was found in the data-layer scan, but a **full log-line audit was not
performed** → "credentials never logged" is 🟡 (not exhaustively verified). "Frontend-
configured credentials are actually used by the runtime" is 🟡 — the wiring is
env-driven and was not traced end-to-end in a credentialed run.

---

## 5. DATA-LAYER VERDICT

✅ **Largely FULLY IMPLEMENTED.** Correct priority chain, real failover with backoff/
circuit-breakers/cooldown, staleness detection, provenance, OHLC validation, and the
no-NSE requirement is genuinely enforced. Residual items: runtime cross-timeframe
dedup (DUP-001, ⚠️), live-feed validation of OI/IV/Greeks (🟡), and exhaustive
credential-logging + frontend-cred-to-runtime tracing (🟡). None are P0.
