# ALPHAFORGE — DATA PROVIDER RUNTIME REPORT

Real provider runtime observations captured during an OPEN NSE session
(2026-09-10, ~12:57 IST). Sourced from actual calls recorded in
`provider_observation`. Where a provider was not exercised, it is reported
**NOT_VERIFIED** — never shown as "0% failures" (§13).

---

## 1. Provider capability matrix (explicit, §3/§5)

| Provider | 1m | 3m | 5m | 15m | 30m | 1h | History | Live | Enabled here |
|---|---|---|---|---|---|---|---|---|---|
| scrapling | — | — | L | L | L | L | yes (daily) | yes | **yes** |
| angel_one | H+L | H+L | H+L | H+L | H+L | H+L | yes | yes | **no (no creds)** |
| upstox | H+L | H+L | H+L | H+L | H+L | H+L | yes | yes | **no (no creds)** |
| yahoo | — | — | H+L | H+L | H+L | H+L | yes | yes | yes |

`H+L` = history + live; `L` = current-day/live only; `—` = not supported.
scrapling serves daily (bhavcopy) + current-day intraday only — multi-day
intraday HISTORY is deferred to Angel One / Upstox upstream.

## 2. Live runtime validation (§31) — what the environment actually allowed

**LIVE-RUNTIME-VERIFIED (data-service / scrapling live quotes):**
- `GET /scraping/quotes?symbols=NIFTY` → HTTP **200**, latency **95 ms**, LTP
  **23448.55**, `volume: null` correctly preserved (not fabricated 0), source
  `nextapi`. Recorded as a real `ProviderObservation` (dataType QUOTE, outcome
  SUCCESS).

**LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE (broker history / failover):**
- Angel One: `SMARTAPI_*` unset → provider disabled; no historical/live call possible.
- Upstox: `UPSTOX_*` unset → data-service `/brokers/upstox/status` = `configured:false`.
- Consequently the **multi-day intraday history** path and a genuine A→B→C
  provider **failover drill** (§32) could not be exercised against live brokers.
  Per Rules 19/59 no latency/uptime/failover numbers were fabricated for them.

## 3. Provider health scorecard (from real observations only)

| provider | requests | success | failure | 4xx | 429 | 5xx | p50 latency | verdict |
|---|---|---|---|---|---|---|---|---|
| scrapling | ≥1 (quote) + backfill/gap obs | 1 quote SUCCESS | 0 on quote | 0 | 0 | 0 | ~95 ms (quote) | **PARTIAL_VERIFIED** (live quotes only) |
| angel_one | 0 real broker calls | — | — | — | — | — | — | **NOT_VERIFIED (no creds)** |
| upstox | 0 real broker calls | — | — | — | — | — | — | **NOT_VERIFIED (no creds)** |
| yahoo | 0 this pass | — | — | — | — | — | — | **NOT_VERIFIED** |

The backfill/gap observations recorded against `angel_one` in
`provider_observation` are from the **controlled demo fetcher** (namespaced
`__V3DEMO__`, since cleaned) exercising the observation write-path — they are
labelled `requestType: backfill-chunk` and are NOT live-broker evidence.

## 4. Failure classification (§33) — verified by code + tests

The failover layer maps real signals to distinct kinds (unit-tested in V2 + reused
by V3): 401/403→AUTH_FAILED, 429→RATE_LIMITED, 5xx/timeout/network→PROVIDER_FAILED,
malformed→INVALID, empty→UNAVAILABLE, `<minBars`→INSUFFICIENT_HISTORY. No
`catch { return [] }` on the status-aware path. The observation recorder captures
`outcome` in the same vocabulary for every call.

## 5. Honest verdict
Provider **reliability under live broker load is NOT_VERIFIED** in this
environment (no credentials). The data-service live-quote path is
LIVE-RUNTIME-VERIFIED (200 / 95 ms / null-volume-preserved). To complete the
scorecard, configure `SMARTAPI_*` / `UPSTOX_*` and re-run
`scripts/data-v3-runtime-pipeline.ts` during a session.
