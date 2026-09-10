# ALPHAFORGE — DATA FORENSIC AUDIT

Status: **DATA_DEGRADED** (see §11 for the honest verdict)
Scope: Indian market data foundation only. No ML, signal-threshold, or A+/grade
changes were made or are proposed here.
Method: Direct code reading of the TypeScript market-data layer, the Python
`data-service`, worker jobs, the Prisma schema, and the India signal-gate /
quality validators. Every claim below cites the file it came from. Where I did
not verify something at runtime, it is marked **NOT VERIFIED**.

---

## 0. Executive summary

AlphaForge already has a **substantial and, in most respects, well-engineered**
data layer:

- A real provider abstraction (`MarketDataProvider`) with a strict priority
  chain `scrapling (data-service) → angel_one → upstox → yahoo` and NSE removed
  from the runtime chain (`src/lib/market-data/types.ts`,
  `src/lib/market-data/providers/nse.ts` is a tombstone).
- Capability-aware failover with per-provider **and** per-capability circuit
  breakers, exponential backoff, jitter, a 503/429 ladder, and `Retry-After`
  honouring (`src/lib/market-data/failover.ts`, `health.ts`).
- Thorough structural OHLC validation that **rejects** impossible candles
  (`validation/candle-validator.ts`, `services/reconciliation.service.ts`).
- A cross-provider reconciliation / data-quality engine with a
  `QualityEnvelope` and a signal gate (`services/reconciliation.service.ts`).
- Option-chain and ML feature quality validators on the signal side
  (`src/lib/india/fno-data-quality.ts`, `feature-quality-validator.ts`).
- Data lineage recording in the Python service (`core/lineage.py`).

The problems are **not** absence of infrastructure. They are **integrity gaps
at the seams**: places where missing values silently become `0`, where delayed
data is stamped with a live timestamp, where the quality engine that exists is
**not wired into the default read paths**, and where the documented provider
chain does not match what the Python service actually implements. These are the
exact failure modes the task brief forbids (Absolute Rules 2, 4–7, 15, 46).

The single most important architectural finding:

> **The data-quality / provenance engine exists but is bypassed.** The default
> read services (`historical.service.ts`, `option-chain.service.ts`,
> `instrument-master.service.ts`) return bare `OHLCVCandle[]` / `OptionChain` /
> `Instrument[]` with **no `QualityEnvelope`, no completeness status, and no
> staleAge**. Reconciliation only runs when a caller explicitly invokes it.

---

## 1. Complete data architecture (as built)

### 1.1 TypeScript layer — `src/lib/market-data/`

| File | Role |
|---|---|
| `types.ts` | Canonical types: `MDQuote`, `OHLCVCandle`, `OptionChain`, `OptionContract`, `LiveTick`, `Instrument`, `MarketDataError` (typed codes + `httpStatus` + `retryAfterMs`). |
| `provider.ts` | `MarketDataProvider` interface + capability flags. Single source every consumer must call. |
| `registry.ts` | `ProviderRegistry`, `bootstrapRegistry`, capability-filtered routing → `withFailover`. |
| `failover.ts` | Retry/backoff/failover executor; `classifyError`. |
| `health.ts` | Per-provider & per-capability circuit breaker; health scoring; `STALE_THRESHOLDS_MS`; `mdLog`. |
| `normalizer.ts` | IST↔UTC, expiry parsing, symbol mapping, interval/exchange maps, candle normalisation. |
| `validation/candle-validator.ts` | Structural OHLC validation + `filterValidCandles`. |
| `validation/tick-validator.ts` | Tick validation + staleness flag. |
| `services/reconciliation.service.ts` | Quality engine: `QualityEnvelope`, OHLC validation, cross-provider comparison, outlier detection, signal gate, provider health score. |
| `services/historical.service.ts` | `getHistoricalCandles[ByRange]`. |
| `services/option-chain.service.ts` | `getOptionChain` (+ batch). |
| `services/instrument-master.service.ts` | `getInstruments`, `findInstrument`. |
| `services/live-feed.service.ts` | `subscribeLiveFeed`. |
| `services/candle-builder.service.ts` | `RealTimeCandleBuilder` (tick→candle, reconnect gap-fill). |
| `services/candle-persist.service.ts` | `persistCandles[Batch]` → `CandleBar` upsert. |
| `cache/market-cache.ts` | TTL cache facade + single-flight memo. |
| `providers/{scrapling,angel-one,upstox,yahoo,nse}.ts` | Provider adapters. |

### 1.2 Python `data-service/src/`

| File | Role |
|---|---|
| `server.py` | FastAPI app (`uvicorn src.server:app`, port 8200). Routers + `/health`, `/scraping/status`. |
| `scrapers/live_quotes.py` | Quotes via **NSE NextApi (direct)**. |
| `scrapers/historical.py` | Daily via **NSE/BSE Bhavcopy**; intraday via **NSE chart-databyindex / BSE StockReachGraph**. |
| `scrapers/option_chain.py` | Option chain via **NSE (Scrapling headless) + FetcherSession fallback**; BSE path. |
| `scrapers/instrument_master.py` | NSE F&O lots CSV + BSE zip; hardcoded fallback. |
| `brokers/upstox_client.py` | **The only real broker client** (quotes, historical). |
| `core/provider_http.py` | Resilient GET: typed errors, backoff ladder, `Retry-After`, no-retry-on-403. **Used by Upstox only.** |
| `core/circuit_breaker.py` | Per-source breakers. |
| `core/lineage.py` | In-memory `LineageStore` (provenance). |
| `core/gate_router.py`, `monitoring/health_router.py` | Data-quality gate + health endpoints. |
| `anti_ban/` | Rate limiter, proxy manager, ban detection. |

### 1.3 Persistence (Prisma) — `prisma/schema.prisma`

Relevant models: `CandleBar` (unique `[instrumentId, exchange, intervalStr, time]`,
`volume Float @default(0)`, `oi Float?`, `oiChange Float?`), `OptionChainSnapshot`
(aggregated analytics, `total*Oi Float @default(0)`), `UniverseCoverageSnapshot`
(coverage/80% gate), plus signal/prediction/resolution tables.

**Missing models** (against brief §26/27/42/44): no `DataGap`,
`DataQualityIncident`, `ProviderObservation` (raw vs normalized), or
`DataCorrection`/versioning table. Provenance in TS persistence is limited to
`confirmedAt`; the Python `LineageStore` is **in-memory only** and never
embedded in response bodies.

---

## 2. Official provider chain vs. reality

Intended (brief §2 and `types.ts` `PROVIDER_PRIORITY`):
`data-service → Angel One → Upstox → Yahoo`.

**Reality:**

- **TypeScript layer implements the full chain** with capability-aware failover
  — this part matches the intent. `scrapling` is enabled only when
  `DATA_SERVICE_URL` is set (`registry.ts` bootstrap).
- **The Python `data-service` does NOT implement the broker chain.** The only
  real broker client is **Upstox** (`brokers/upstox_client.py`). There is **no
  Angel One client and no Yahoo client** in `data-service/src/` — they appear
  only in comments, an enum (`DataSource.BROKER_ANGEL`, `YAHOO_FINANCE`), and a
  health capability map. `core/provider_http.py` header explicitly states
  failover "lives in the TypeScript ProviderRegistry; this layer only makes an
  individual provider call resilient."
- The `data-service` primary source for quotes/historical/option-chain is in
  fact **direct NSE/BSE scraping** (see §10), fronted by the `scrapling`
  provider id.

**Consequence:** the documentation (`brokers/__init__.py` claims "Neither client
performs any direct NSE data acquisition") is contradicted by the code. This is
a documentation-vs-implementation drift that must be reconciled so operators
know what actually serves each data type.

---

## 3. Data-gap inventory — classification (SAFE / UNSAFE / BUG / NEEDS-INVESTIGATION)

Every entry cites the file. Severity uses the brief's Absolute Rules.

### 3.1 UNSAFE — missing value silently becomes `0`

| # | Location | Code | Rule violated | Class |
|---|---|---|---|---|
| U1 | `src/lib/market-data/providers/upstox.ts` `normaliseOptionLeg` | `const oi = md.oi ?? 0;` | 5 (never FF OI) / 46 | **UNSAFE** |
| U2 | same | `oiChange = prevOi != null ? oi - prevOi : 0;` | 46 | **UNSAFE** |
| U3 | same | `volume: md.volume ?? 0` | 2 | **UNSAFE** |
| U4 | `data-service/src/scrapers/option_chain.py` `_build_option_contract` | `oi=int(raw.get("openInterest", 0))`, `oiChange=int(... 0)`, `volume=int(... 0)` | 5 / 2 / 46 | **UNSAFE** |
| U5 | `data-service/.../option_chain.py` `_bse_to_contract` | same `... or 0` pattern | 5 / 2 | **UNSAFE** |
| U6 | `data-service/.../historical.py` `_aggregate_price_series` | synthesized intraday OHLC with `volume=0` hardcoded | 2 | **NEEDS-INVESTIGATION** (volume genuinely unavailable from this endpoint; 0 is a *placeholder*, not a real 0 — must be surfaced, not silently emitted) |

**Why U1–U5 matter:** `computeAnalytics` (upstox.ts) and the option-chain
analytics sum these zero-filled OIs into `totalCeOi/totalPeOi`, PCR, max-pain and
ATM IV. A chain with *absent* OI therefore yields PCR / max-pain / OI-wall
figures computed from **fabricated zeros** instead of `null`. The downstream
`fno-data-quality.ts` validator is designed to catch `NEGATIVE_OI` and missing
data, but it treats `oi = 0` as a *valid* zero — so the fabrication defeats the
very gate meant to protect the signal engine.

### 3.2 UNSAFE — stale / delayed data stamped as live

| # | Location | Code | Rule | Class |
|---|---|---|---|---|
| S1 | `src/lib/market-data/providers/yahoo.ts` `subscribe` | `exchangeTimestampMs: Date.now(), receivedAtMs: Date.now()` on a ~15-min-delayed Yahoo quote | 7 | **UNSAFE** |
| S2 | `src/lib/market-data/providers/scrapling.ts` polling `subscribe` | `exchangeTimestampMs: now` for a REST-polled quote | 7 | **UNSAFE** |
| S3 | `src/lib/market-data/services/live-feed.service.ts` | `allowStaleTicks` forwards stale ticks to `onTick` with **no stale flag on the tick** (`LiveTick` has no quality field) | 7 | **UNSAFE** |
| S4 | `cache/market-cache.ts` | within-TTL payloads returned verbatim with no age re-check; cache stores no `createdAt/expiresAt/provider/dataTimestamp` wrapper | 7 | **NEEDS-INVESTIGATION** (TTL bounds staleness, but there is no `staleAge` surfaced) |

**Why S1/S2 matter:** the tick validator's freshness check
(`STALE_THRESHOLDS_MS.liveTick = 5s`) compares `exchangeTimestampMs`. Stamping
`Date.now()` means a delayed quote **always passes** the freshness check. This is
the clearest stale-masquerading-as-live path in the codebase.

### 3.3 SAFE / GOOD — correct "missing = null / explicit error" handling

- NSE equity OI correctly forced to `null` with a comment explaining
  `totalTradedValue ≠ OI` (`live_quotes.py`) — **SAFE**, and a model to copy.
- Yahoo `oi: null` hardcoded ("Yahoo doesn't provide OI") — **SAFE**.
- Angel/Upstox quote fields use `finiteOrNull(...)` → `null` on missing —
  **SAFE**.
- Option greeks/IV/ltp/bid/ask use `finiteOrNull` / `... or None` → `null` on
  missing — **SAFE** (only OI/volume/oiChange are the offenders).
- `candle-validator.ts` rejects impossible OHLC — **SAFE**.
- `provider_http.py` never retries 403; honours `Retry-After` — **SAFE**.

### 3.4 BUG — error swallowed into empty result (outage indistinguishable from "no data")

| # | Location | Behaviour | Class |
|---|---|---|---|
| B1 | `services/historical.service.ts` | `catch { return []; }` — total provider outage returns `[]`, identical to "no data for range" | **BUG** (Rule 78/79: provider failure ≠ data absence) |
| B2 | `services/instrument-master.service.ts` | swallow → `return []` | **BUG** |
| B3 | `providers/angel-one.ts` / `upstox.ts` `getQuotes` catch | returns `symbols.map(() => null)` on provider error | **BUG** |
| B4 | `validation/candle-validator.ts` `filterValidCandles` | silently drops invalid/out-of-order candles, returns bare array with **no report of what/how many were dropped** | **BUG** (Rule 15: never silently repair; dropping without provenance is a silent repair) |

### 3.5 SILENT SKIP — persistence drops invalid candles without an incident record

- `candle-persist.service.ts` and Python `_fetch_nse_daily` / `_validate_candle_row`
  **`continue`** on invalid candles. Correct to not store garbage, but there is
  **no gap/incident record** so the drop is invisible (Rule 14/15/44).

---

## 4. Data Availability Contract (brief §4) — GAP

No `DataAvailability` envelope exists on the default read path. `MDQuote` and
`OptionChain` carry `provider` + `fetchedAt`; `OHLCVCandle` and `LiveTick` carry
**neither** a `dataTimestamp`-vs-`receivedAt` split nor a status. There is **no**
`status ∈ {AVAILABLE, PARTIAL, STALE, UNAVAILABLE, INVALID, PROVIDER_FAILED,
RATE_LIMITED, AUTH_FAILED, INSUFFICIENT_HISTORY}`, no `completeness`, no
`coverageStart/End`, no `missingIntervals`, no `staleAge`.

The pieces to build it exist (`QualityEnvelope`, `ValidationStatus`,
`STALE_THRESHOLDS_MS`, lineage) — they are simply not assembled into one
contract that every request returns.

## 5. Data Quality Score (brief §5) — PARTIAL

`reconciliation.service.ts` `buildQualityEnvelope` produces a 0–1 score from
freshness + outlier + cross-provider agreement, and `computeProviderHealthScore`
gives a 0–100 provider score. **Gaps:** no explicit completeness / missing-candle
/ duplicate-rate / timestamp-integrity / corporate-action components; single-
provider data only loses `0.05` and stays `UNVERIFIED` at ~0.95 (a mild
fake-confidence risk for uncorroborated data).

## 6. Critical vs non-critical fields (brief §6) — PARTIAL

`fno-data-quality.ts` and `feature-quality-validator.ts` encode field criticality
on the **signal side** (REJECT vs IMPUTE policies, INVALID vs DEGRADED). There is
no equivalent field-criticality classification on the **data-layer** side that
would let a `MarketDataProvider` result declare "critical field OI missing".

## 7. Historical coverage (brief §7–9) — PARTIAL

`UniverseCoverageSnapshot` exists (coverage/80% gate). Daily backfill exists via
Bhavcopy (`historical.py`) with a disk cache. **Gaps:** no formal
`INSUFFICIENT_HISTORY` result type on the read path (services return `[]`), no
coverage matrix `instrument × date × timeframe × provider`, and no checkpointed
resumable backfill orchestrator that only fetches missing intervals.

## 8. Real-time continuity & gap detection (brief §11–13) — PARTIAL

`RealTimeCandleBuilder.handleReconnect` does REST gap-fill via a `backfillLoader`
and persists/emits the recovered candles; on failure it logs and continues,
leaving the gap **silently unrecovered** (no `DataGap` record). Candle continuity
uses interval snapping; there is a session calendar (`nse-trading-calendar.ts`,
`market-hours.ts`) so missing candles can be distinguished from holidays — but
the two are not joined into a persisted gap ledger.

## 9. Timestamps (brief §14) — GOOD (with the S1/S2 exceptions)

`normalizer.ts` handles IST↔UTC carefully and stores UTC internally. The two
`Date.now()` stamping bugs (S1/S2) are the exceptions that corrupt provenance.

## 10. Direct NSE access (brief §10) — POLICY DRIFT

Rule 10 forbids reintroducing direct NSE scraping **into TypeScript**. The TS
layer complies (NSE provider removed). However the **Python data-service scrapes
NSE/BSE directly** (`live_quotes.py`, `option_chain.py`, `historical.py`,
`instrument_master.py`) behind the `scrapling` provider id. Whether this is
acceptable depends on interpretation: the brief allows the *data-service* to be
the acquisition layer, and explicitly forbids only *TypeScript* NSE scraping.
This is therefore **NEEDS-INVESTIGATION / policy decision**, not an outright
violation — but the misleading `brokers/__init__.py` comment must be corrected.

---

## 11. Honest verdict

**DATA_DEGRADED.** The reliability infrastructure (failover, breakers,
backoff, validation, a quality engine) is real and good. But data **integrity**
is not yet guaranteed end-to-end because:

1. Missing OI/volume are fabricated as `0` in two option-chain code paths
   (U1–U5) and then fed into analytics — a direct Rule 2/5/46 violation.
2. Delayed/polled quotes are stamped with a live timestamp (S1–S3), defeating
   the staleness gate — a Rule 7 violation.
3. The quality/provenance envelope that would make every read observable is not
   wired into the default read paths.
4. Provider failures are swallowed into empty arrays, so an outage is
   indistinguishable from genuine data absence (Rule 78/79).

The remediation plan and per-issue root causes are in
`ALPHAFORGE_DATA_ROOT_CAUSE_REPORT.md`. Fixes applied in this pass are recorded
there and in `REMEDIATION_CHANGELOG.md`.

---

*Generated by forensic audit. All findings cite source files read during the
audit. Runtime behaviour (live provider responses, actual coverage counts) was
NOT executed and is marked NOT VERIFIED where relevant.*
