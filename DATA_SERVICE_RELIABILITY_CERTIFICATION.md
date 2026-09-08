# AlphaForge Data-Service — Reliability & Failover Certification

**Date:** 2026-09-07
**Scope:** Production-grade reliability & failover upgrade of the market-data
acquisition chain `data-service → Angel One → Upstox → Yahoo`.
**Method:** Deterministic, mock-driven tests (no live provider credentials, no
real network I/O). Every result below is reproduced by the automated suites
listed in each row and can be re-run locally.

> **Honest scope note.** Per the task's explicit instruction, this report does
> **not** claim AlphaForge can never be blocked. It certifies that:
> **"Provider-level access failures (403/503/429) are isolated and do not cause
> a data-service-wide failure; the service degrades, fails over, recovers and
> reconciles while protecting downstream ML, signals, backtests and trading."**

---

## 0. Architecture clarification (documentation vs. actual implementation)

An audit found the repository does **not** implement the provider chain inside
the Python `data-service`. The real chain lives in two layers:

| Layer | Reality |
|---|---|
| **TypeScript `src/lib/market-data/`** | The actual provider chain / failover / circuit-breaker / registry: **Scrapling(data-service, prio 0) → Angel One (1) → Upstox (2) → Yahoo (3)**. Angel One (SmartAPI WS) and Upstox (WS + OAuth) clients live here. |
| **Python `data-service/` (port 8200)** | A credential-free NSE/BSE scraper surfaced to the TS layer as the `scrapling` tier-0 provider. Contains an authorized Upstox REST client. |

Discrepancies corrected/《noted》during this work:

- `DATA_SERVICE.md` claimed `brokers/upstox_client.py` was wired in — it was
  **dead code**. It is now wired via `brokers/router.py` and hardened.
- `RELIABILITY_ASSESSMENT.md` (V2) listed "circuit breaker not wired" as an open
  issue — breakers were **already wired** to `nse_nextapi`/`nse_charting`/
  `bse_charting`; that doc is stale.
- `historical.py` comments claimed a multi-day intraday "falls back to Angel One
  upstream" — **no such fallback existed** in the Python service (the fallback
  is in the TS layer).

The upgrade was applied to **both** layers (option B).

---

## 1. What changed

### TypeScript (`src/lib/market-data/`)
- **Typed error taxonomy + HTTP-status classification** (`types.ts`,
  `failover.ts`): `MarketDataError` now carries `httpStatus` + `retryAfterMs`;
  classification is status-code-driven (403/401/404/408/429/503/5xx) rather than
  fragile string matching.
- **Retry-After honouring + 503/429 backoff ladder** (1s→2s→4s→8s→16s→30s→60s
  with jitter; provider `Retry-After` wins, capped at 60s).
- **Capability-aware circuit breakers** (`health.ts`): circuits keyed by
  `providerId` *and* `providerId::capability`, so "Angel historical DEGRADED"
  does not down "Angel live".
- **Scrapling provider cache + request coalescing + rate limiter**
  (`providers/scrapling.ts`, `cache/market-cache.ts`): the data-service provider
  now uses the shared single-flight cache and a token-bucket rate budget.
- **Never-silent provider switches** (`PROVIDER_SWITCH` structured record) and a
  **signal-engine data gate** (`evaluateSignalGate`) that blocks STALE/INVALID
  data from SIGNAL/ML/EXECUTION while the UI may show a flagged "last known".
- **Tiered cross-provider reconciliation** (`reconcileQuotes` →
  MATCH / WITHIN_TOLERANCE / MINOR_MISMATCH / MAJOR_MISMATCH / INVALID).

### Python (`data-service/`)
- **`core/provider_http.py`**: typed `ProviderError` hierarchy, `parse_retry_after_ms`,
  `classify_status`, exponential-backoff ladder, pooled keep-alive clients, and
  `resilient_get` (never retries 403/401/404; retries 503/timeout/network with
  backoff + honoured Retry-After; injectable sleep for deterministic tests).
- **Upstox client hardened & wired** (`brokers/upstox_client.py`,
  `brokers/router.py`): pooled client, typed errors; exposed at
  `/brokers/upstox/{status,quotes,historical}` surfacing 403→403 / 429→429 /
  503→503 rather than crashing.
- **Duplicate-tick protection + gap detection wired into publish**
  (`publisher/tick_publisher.py`).
- **Capability-aware `/health/providers`** (`monitoring/health_router.py`).
- **Cache-first historical + validated gap repair**
  (`scrapers/historical_repair.py`): provider-independent cache key, data
  fingerprint (never re-download identical validated data), gap detection, and a
  gap-repair coordinator that validates every repaired candle before use.

---

## 2. Test-matrix results

Legend: **Data gap** = live continuity gap introduced (0 = none, N/A for
non-live). **Latency** = observed test wall-clock, not a production SLA.

### 2.1 HTTP failure matrix — TypeScript (`tests/lib/market-data/resilience-matrix.test.ts`, `providers/scrapling.test.ts`)

| Scenario | Expected | Actual | Latency | Data gap | Provider used | Validation | Result |
|---|---|---|---|---|---|---|---|
| 403 on primary | classify AUTHORIZATION, no retry, fail over | `hard_block`; **exactly 1 attempt** on Angel; served by Upstox | deterministic | 0 | Angel→Upstox | typed error asserted | **PASS** |
| 403 repeated | circuit opens, provider degraded | circuit OPEN after 3 hard_block failures | — | — | — | circuit state asserted | **PASS** |
| 401 auth | classify AUTH_FAILURE, no retry | `AUTH_FAILURE`, httpStatus 401, no retry | — | N/A | — | typed error asserted | **PASS** |
| 429 rate limit | honour Retry-After, classify, fail over | `RATE_LIMIT`, `retryAfterMs=5000` parsed & attached; served by Upstox | — | 0 | Angel→Upstox | Retry-After asserted | **PASS** |
| 503 unavailable | backoff + fail over, no storm | retried ≤3 (bounded), served by Upstox | — | 0 | Angel→Upstox | attempt count asserted | **PASS** |
| Timeout (transient) | retry, then succeed | 2 timeouts then success on same provider (3 attempts) | — | 0 | Angel | success asserted | **PASS** |
| Network (ECONNRESET) | classify `network` | classified distinctly from timeout/malformed | — | N/A | — | classifier asserted | **PASS** |

### 2.2 HTTP failure matrix — Python `resilient_get` (`data-service/tests/core/test_provider_http.py`)

Using `httpx.MockTransport` + injected sleep recorder (no real time).

| Scenario | Expected | Actual | Backoff sleeps | Result |
|---|---|---|---|---|
| 403 | raise immediately, **no retry** | `ProviderAuthorizationError`, **1 attempt**, `retryable=False` | `[]` (none) | **PASS** |
| 401 | raise immediately | `ProviderAuthenticationError`, 1 attempt | `[]` | **PASS** |
| 404 | raise immediately | `InstrumentNotFoundError`, 1 attempt | `[]` | **PASS** |
| 429 (Retry-After: 2) | honour Retry-After, retry, exhaust | `ProviderRateLimitError`, `retry_after_ms=2000`, 3 attempts | `[2.0, 2.0]` (honoured) | **PASS** |
| 503 | backoff ladder, retry, exhaust | `ProviderUnavailableError`, 3 attempts | `[~1.0, ~2.0]` (ladder+jitter) | **PASS** |
| 503 then 200 | retry then succeed | success on attempt 2 | 1 sleep | **PASS** |
| malformed body | raise, no retry | `ProviderMalformedResponseError` | — | **PASS** |
| timeout | retry then classify | `ProviderTimeoutError`, 2 attempts | 1 sleep | **PASS** |
| network | retry then classify | `ProviderNetworkError`, 2 attempts | 1 sleep | **PASS** |

### 2.3 Chaos — full provider failure & recovery (`resilience-matrix.test.ts`)

| Test | Expected | Actual | Data gap | Provider used | Result |
|---|---|---|---|---|---|
| TEST 1 — Angel down | Upstox serves | served by Upstox | 0 | Angel→Upstox | **PASS** |
| TEST 2 — Angel + Upstox down | Yahoo serves | served by Yahoo | 0 | Angel→Upstox→Yahoo | **PASS** |
| TEST 3 — Angel recovers | HALF_OPEN → probe → CLOSED → primary | circuit re-closed on probe success; Angel returned to primary | 0 | Angel | **PASS** |
| TEST 4 — Angel keeps failing | Upstox stays primary, Angel not hammered | Angel circuit OPEN → **0 calls to Angel** while open; Upstox serves | 0 | Upstox | **PASS** |

### 2.4 Capability-aware circuits (`resilience-matrix.test.ts`) & `/health/providers` (`data-service/tests/monitoring/test_health_providers.py`)

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| Angel historical fails, live healthy | historical circuit OPEN, live CLOSED, provider-wide CLOSED | confirmed via `isCapabilityCircuitOpen` | **PASS** |
| Route live vs historical during partial outage | live→Angel, historical→Upstox | Angel historical skipped (0 calls), Upstox served historical; Angel served live | **PASS** |
| `/health/providers` on NSE historical outage | `scrapling.historical=DEGRADED`, `scrapling.live` unaffected, overall `DEGRADED` (not DOWN) | confirmed | **PASS** |
| `/health/providers` all healthy | overall `HEALTHY` | confirmed | **PASS** |
| `/health/providers` on Upstox live outage | `upstox.live=DEGRADED`, scrapling unaffected | confirmed | **PASS** |

### 2.5 Historical gap repair & cache-first (`data-service/tests/scrapers/test_historical_repair.py`)

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| Provider-independent cache key | same key regardless of provider/case | confirmed; different range → different key | **PASS** |
| Data fingerprint | stable & content-sensitive | confirmed | **PASS** |
| Gap detection | flag missing interval, none for contiguous | confirmed (missing_count correct) | **PASS** |
| Gap repair (valid) | fill gap, validated, ordered | filled 1, series `[0,300,600]` | **PASS** |
| Gap repair (invalid then fallback) | reject invalid, fall over, repair | invalid rejected; `yahoo` fallback repaired | **PASS** |
| Repair fetcher raises | record error, try next | `error` recorded for angel_one; upstox repaired | **PASS** |
| No gaps | **no provider request** | 0 fetcher calls when data complete | **PASS** |

### 2.6 Duplicate-tick protection (`data-service/tests/publisher/test_publish_dedup.py`)

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| Identical repeated tick | published **once** | 1 publish; duplicate suppressed | **PASS** |
| Distinct ticks | both published | 2 publishes (23850.0, 23851.0) | **PASS** |

### 2.7 Cross-provider reconciliation & signal gating (`resilience-matrix.test.ts`)

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| Identical prices | MATCH (agreement 1.0) | MATCH | **PASS** |
| Far divergence | MAJOR_MISMATCH | MAJOR_MISMATCH | **PASS** |
| Negative price field | INVALID | INVALID | **PASS** |
| STALE data → SIGNAL_ENGINE | **blocked** | blocked | **PASS** |
| STALE data → ML_INFERENCE / EXECUTION | **blocked** | blocked | **PASS** |
| STALE data → UI | allowed (flagged) | allowed | **PASS** |
| Fresh VALID → SIGNAL_ENGINE | allowed | allowed | **PASS** |

### 2.8 Provider-switch traceability (`resilience-matrix.test.ts`)

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| Switch is recorded | `PROVIDER_SWITCH` event with from/to/reason/instrument/gapMs/timestamp | all fields present; never silent | **PASS** |

---

## 3. Aggregate verification

| Suite | Command | Result |
|---|---|---|
| TS typecheck | `npx tsc --noEmit` | **PASS** (clean) |
| TS market-data | `vitest run tests/lib/market-data` | **535 passed** (15 files) |
| TS resilience matrix | `vitest run tests/lib/market-data/resilience-matrix.test.ts` | **22 passed** |
| TS integration + gate-client | `vitest run tests/integration/market-data-pipeline.test.ts tests/api/market-data-wiring.test.ts src/lib/data-service` | **55 passed** |
| Python new reliability tests | `pytest tests/core/test_provider_http.py tests/scrapers/test_historical_repair.py tests/publisher/test_publish_dedup.py tests/monitoring/test_health_providers.py` | **23 passed** |
| Python full suite | `pytest -q` (data-service) | **660 passed, 25 skipped, 2 failed** |

---

## 4. Known / pre-existing failures (not introduced by this work)

Two property-based tests fail on the current tree, **unrelated to the reliability
upgrade**:

- `tests/pbt/test_analytics_properties.py::test_property_8_max_pain_minimises_itm_value`
- `tests/pbt/test_analytics_properties.py::test_property_8_max_pain_tiebreak_uses_highest_ce_oi`

They are floating-point tie-break artefacts in `compute_max_pain`
(`scrapers/option_chain.py`), e.g. `pain(100.0)=0.00 > pain(100.00000000000001)=0.00`
differing by ~9.5×10⁻⁹ rupee on a Hypothesis-generated edge case.
`git status` confirms `option_chain.py` has **no local changes** — these
failures predate and are outside the scope of this work. Recommended fix
(separate change): add an absolute epsilon to the max-pain comparison.

---

## 5. NOT EXECUTED — credentials / live access required

The following require live broker credentials and/or real market hours and were
**NOT EXECUTED** in this certification. Their *logic* is exercised deterministically
above via mocked transports and fault injection, but end-to-end confirmation
against the real providers is pending access.

| Scenario | Status | Reason |
|---|---|---|
| Live Angel One SmartAPI 403/429/503 over the wire | **NOT EXECUTED — CREDENTIALS/ACCESS REQUIRED** | Needs `SMARTAPI_*` + live session |
| Live Upstox 403/429/503 over the wire | **NOT EXECUTED — CREDENTIALS/ACCESS REQUIRED** | Needs `UPSTOX_ANALYTICS_TOKEN` |
| Angel One WebSocket disconnect / reconnect / subscription restore | **NOT EXECUTED — CREDENTIALS/ACCESS REQUIRED** | Needs live SmartStream session |
| Hot failover latency (Angel WS → Upstox WS) measured in ms | **NOT EXECUTED — CREDENTIALS/ACCESS REQUIRED** | Needs dual live WS subscriptions |
| Live cross-provider reconciliation (Angel vs Upstox NIFTY) | **NOT EXECUTED — CREDENTIALS/ACCESS REQUIRED** | Needs both live feeds simultaneously |
| Real end-to-end historical gap repair against providers | **NOT EXECUTED — CREDENTIALS/ACCESS REQUIRED** | Logic verified with fakes; live fetch needs credentials |
| Production cache-hit % / request-reduction under real load | **NOT EXECUTED — CREDENTIALS/ACCESS REQUIRED** | Needs a live soak run during market hours |

---

## 6. Certification statement

Based on the deterministic evidence above:

> Provider-level access failures (403 / 503 / 429 / timeout / network) from any
> single provider are **classified, isolated, and do not cause data-service-wide
> failure**. The chain automatically fails over Angel One → Upstox → Yahoo,
> honours `Retry-After`, backs off exponentially without creating retry storms,
> opens capability-aware circuit breakers, recovers gradually via HALF_OPEN
> probes, deduplicates ticks, repairs historical gaps with validation, records
> every provider switch, and blocks stale/invalid data from the signal, ML and
> execution paths while still allowing the UI a flagged last-known value.

The live, credential-gated scenarios in §5 remain to be confirmed against the
real providers and are explicitly reported as **NOT EXECUTED**, not as passing.
No results in this document are fabricated.
