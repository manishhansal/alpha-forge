# ALPHAFORGE DATA INTEGRITY

**Date:** 2026-09-09. Provider chain + data-layer audit (strongest area of the system).

## Provider chain & failover

| Requirement | Status | Evidence |
|---|---|---|
| Priority DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO | ✅ | `registry.bootstrapRegistry` (priorities 0/1/2/3) |
| Failover only after retries exhausted / circuit open | ✅ | `failover.withFailover` |
| Retry (3) + exponential backoff + jitter; Retry-After honored | ✅ | `failover.ts` |
| Rate-limit / unavailable handling | ✅ | `classifyError` + backoff ladder |
| Circuit breaker + 10s failover cooldown (anti-oscillation) | ✅ | `health.ts`, `FAILOVER_COOLDOWN_MS` |
| Stale-data detection (liveTick 5s / intraday 60s / daily 4h / OC 30s / master 12h) | ✅ | `health.STALE_THRESHOLDS_MS` + tick validator |
| Provider provenance | ✅ | `provider_switch` logs + `PaperTrade` provenance columns |
| OHLC validation / candle completeness | ✅ | `validateOHLC` / `validateOHLCSequence` |
| Symbol / instrument / session mapping | ✅ | per-provider masters; session-aware thresholds |
| **No direct NSE fetching** | ✅ | provider removed 2026-09-03; registry does not register it; only `NSE_PROVIDER_REMOVED_REASON` exported |
| Runtime cross-timeframe duplicate guard (DUP-001) | ⚠️ | `openIndiaPaperTrade` now rejects any open `in:` trade for the same symbol; historical inflation 1.31×–3× |
| Credentials never logged | 🟡 | env-gated; not exhaustively audited on every log line |
| Frontend creds reach runtime | 🟡 | env-driven; not traced end-to-end in a credentialed run |

A **regression guard** (`remediation-regression-guards.test.ts`) now fails CI if the
NSE provider class reappears or the registry registers NSE.

## Data-type validation (quotes/candles/volume/OI/option-chain/PCR/IV/Greeks/instruments/timestamps/sessions)

Implemented at the code + unit-test level. Live-feed validation of OI/IV/Greeks
requires broker credentials + network and was not exercised here → 🟡 IMPLEMENTED BUT
NOT LIVE-VALIDATED.

## Verdict

✅ **Data layer is production-credible.** Correct chain, real failover, staleness
protection, provenance, and the no-NSE requirement genuinely enforced (and now
guarded). Residual 🟡 items (live OI/IV validation, exhaustive credential-log audit)
are not P0.
