# ALPHAFORGE — DATA FOUNDATION V2 BASELINE

Phase 1 of the V2 program. Establishes the *actual* current state (code + live
DB) before any V2 change, so progress is measurable and no already-fixed V1
defect is reintroduced.

Method: direct code reading + a live query against the running Postgres
(`alpha-forge-postgres`, healthy, `localhost:5433`). DB numbers below are REAL
(queried via the project's Prisma client), not estimated.

---

## 1. Live database state (REAL — queried 2026-09-10)

| Table | Rows | Notes |
|---|---|---|
| `candle_bar` | **89,810** | 100% `intervalStr="1d"`, `exchange="NSE"`; **175 distinct instruments**; time range **2024-09-04 → 2026-09-09** |
| `OptionChainSnapshot` | **2,935** | NIFTY 734, BANKNIFTY 735, FINNIFTY 736, MIDCPNIFTY 730; range **2026-06-16 → 2026-09-09** |

**Immediate findings from the real data:**
- The DB has substantial **daily** history (≈2 years, 175 F&O names) — this is
  real, usable data. **NOT** `DATABASE_HAS_NO_DATA`.
- **No intraday candles are persisted** (0 rows for 1m/3m/5m/15m/30m/1h). Every
  intraday strategy therefore reads history live from providers each time, with
  nothing durable to compute coverage/gaps against. This is the single biggest
  real coverage gap and drives Phases 10/11/14/16.
- Daily `CandleBar.time` values are stored at odd intra-day epochs
  (`03:45Z`/`13:00Z`) rather than a normalized session date. **NEEDS-VERIFY** —
  could be a daily-candle timestamp normalization inconsistency; flagged for the
  coverage engine (Phase 10) so it does not miscount "expected" daily bars.
- Option-chain snapshots exist only for the 4 index underlyings, captured since
  2026-06-16 (matches the `india-oc-capture` cadence job). No per-strike OI/IV
  history is persisted (only aggregated analytics + a JSON blob).

---

## 2. Current schema (data-relevant models)

- `CandleBar` — `open/high/low/close` Float, `volume` Float @default(0),
  `oi Float?`, `oiChange Float?`, `confirmedAt`, unique
  `(instrumentId, exchange, intervalStr, time)`. **No provider column, no
  sourceTimestamp/receivedAt, no datasetVersion.**
- `OptionChainSnapshot` — aggregated analytics + `analytics Json`, `capturedAt`.
- `UniverseCoverageSnapshot` — per-session F&O universe coverage / 80% gate.
- No `DataGap`, `DataQualityIncident`, `ProviderObservation`, `DataCorrection`.

Migrations directory shows 16 applied migrations; latest
`20260909000000_add_india_prediction_resolution_records`. V2 migrations must be
**additive** and follow this timestamped convention.

---

## 3. Providers & capabilities (unchanged from V1 audit)

Chain: `scrapling (data-service) → angel_one → upstox → yahoo`.
`bootstrapRegistry` (`registry.ts`): scrapling enabled only if `DATA_SERVICE_URL`
set (it is: `http://localhost:8200`); angel/upstox/yahoo enabled. Capability
flags: upstox `instrumentMaster:false`; yahoo `optionChain:false`, `fno:false`,
`webSocket:false`.

## 4. Current read paths (the contract surface V2 must upgrade)

| Function | Returns | Ambiguity |
|---|---|---|
| `historical.service.getHistoricalCandles` | `OHLCVCandle[]` | outage vs empty (V1 now logs PROVIDER_FAILED, but return is still bare `[]`) |
| `option-chain.service.getOptionChain` | `OptionChain` (throws) | throws on total failure; batch returns `null` per underlying |
| `instrument-master.service.getInstruments` | `Instrument[]` | **still `catch → []`** (G-12 open) |
| `registry.getQuotes` | `Array<MDQuote|null>` | provider all-null vs unresolved symbol (G-13 open) |

No `*WithStatus` variants exist yet — this is Phase 2/3, the keystone.

## 5. Current write paths
- `candle-persist.service.persistCandles[Batch]` → `CandleBar` upsert (idempotent,
  invalid candles skipped — V1 logs drops via historical service).
- `india-oc-capture` worker → `OptionChainSnapshot` (cadence, market-hours only,
  15-min staleness alert).

## 6. Caches
- `market-cache.ts` TTL memo (Redis + memory), single-flight. **No
  createdAt/expiresAt/provider/dataTimestamp wrapper** (Phase 33 target).

## 7. Failover / resilience (present, good)
Capability-aware `withFailover`, per-provider+capability circuit breakers,
backoff ladder, Retry-After, no-retry-403. Python `provider_http` resilient GET
(Upstox only); NSE/BSE scrapers unthrottled beyond a basic limiter (Phase 30).

## 8. Current data gates
- Signal-side: `reconciliation.evaluateSignalGate` (blocks STALE/SUSPICIOUS),
  `fno-data-quality.evaluateOptionChainQuality`, `feature-quality-validator`.
- **No** global DATA_READY/DEGRADED/BLOCKED state (Phase 65).
- **No** snapshot cross-field skew gate (Phase 40).

## 9. V1 residual gaps still open (do NOT re-fix; these are V2 scope)
- G-06/G-07: candle `volume ?? 0` / synthesized intraday `volume=0` — needs
  `volumeUnavailable` semantics (Phase 21).
- G-10: `allowStaleTicks` forwards stale ticks without threading the flag
  (Phase 20).
- G-12: instrument-master `catch → []` (Phase 35).
- G-13: `getQuotes` all-null on provider error (Phase 4).
- Scrapling trust-through: no local re-validation (Phase 22).
- Quality envelope not on read paths (Phase 2/3).

## 10. Missing infrastructure (V2 build list, dependency-ordered)
1. `DataAvailability<T>` contract (Phase 2) — keystone.
2. `*WithStatus` read APIs (Phase 3/4).
3. Durable models: `DataGap`, `DataQualityIncident`, `ProviderObservation`,
   `DataCorrection`, `CandleBar` provenance (Phases 5–9).
4. Coverage matrix + history sufficiency (Phases 10–12).
5. Real numeric coverage report (Phase 11/60) — data EXISTS, so this is
   computable, not `DATABASE_HAS_NO_DATA`.
6. Residual-gap closure (Phases 20/21/22/35).
7. Snapshot-skew gate + global DATA state + fail-closed (Phases 40/65/66).

---

## Baseline verdict

**DATA_DEGRADED**, with **real daily data present** (89.8k candles, 2 yrs, 175
instruments) and **no intraday persistence**. The V2 work is to make every read
carry availability/provenance, persist gaps/incidents/lineage, compute real
coverage against the calendar, and add a fail-closed global data gate — without
fabricating data or touching ML/thresholds.
