# ALPHAFORGE — DATA FOUNDATION V2 FINAL REPORT

The consolidated record of the V2 program. Companion reports:
`ALPHAFORGE_DATA_V2_BASELINE.md`, `..._ROOT_CAUSE_REPORT_V2.md`,
`..._COVERAGE_REPORT_V2.md`, `..._READINESS_CERTIFICATION_V2.md`.

**Bottom line:** the data-integrity contract, fail-closed gates, durable
reliability models, and a real coverage engine are now in place and verified.
Daily history is DATA_READY-grade; intraday is DATA_INSUFFICIENT (not yet
persisted). Overall: **DATA_DEGRADED → improving**, with a concrete path to
DATA_READY. Nothing was fabricated; no ML/threshold code was touched.

---

## 1. Baseline (real, DB-derived)
- `candle_bar`: 89,810 rows, ALL `1d`/NSE, 175 instruments, 2024-09-04→2026-09-09.
- `OptionChainSnapshot`: ~2,939 rows, 4 indices, since 2026-06-16 (aggregate only).
- No intraday candles persisted. No `DataGap`/incident/observation/correction
  models. No candle provenance.

## 2. Root causes addressed
See ROOT_CAUSE_REPORT_V2. Ten issues (D-V2-01…10): 6 FIXED, 3 INFRA (built,
population pending), 1 NEEDS-VERIFY.

## 3. Fixes & files changed

**New modules (TS):**
- `src/lib/market-data/data-availability.ts` — `DataAvailability<T>` contract,
  10-state status enum, `worstStatus`, `isTradableStatus`, `buildAvailability`.
- `src/lib/market-data/data-gate.ts` — `evaluateSnapshotConsistency`,
  `evaluateGlobalDataState`, `strategyMayOperate` (fail-closed).
- `src/lib/market-data/services/read-with-status.service.ts` — `*WithStatus`
  reads + `failureKindToStatus`/`errorToStatus`.
- `src/lib/market-data/services/coverage.service.ts` — calendar-aware coverage
  matrix + `checkHistorySufficiency`.

**Modified (TS):** `types.ts` (LiveTick stale/synthetic/feedDelay,
OHLCVCandle.volumeUnavailable), `index.ts` (barrel exports),
`normalizer.ts` + `providers/yahoo.ts` + `providers/scrapling.ts` +
`services/live-feed.service.ts` + `services/candle-persist.service.ts`.

**Modified (Python):** `data-service/src/schemas.py` (volumeUnavailable),
`data-service/src/scrapers/historical.py` (synthesized intraday flag).

**Prisma:** `schema.prisma` (+`CandleBar` provenance, +4 models),
`migrations/20260910000000_data_foundation_v2/migration.sql` (additive,
idempotent).

**Tests:** `tests/lib/market-data/data-foundation-v2.test.ts` (18 tests).

## 4. Prisma changes
Additive migration: 5 nullable/defaulted `CandleBar` columns (`provider`,
`sourceTimestamp`, `receivedAt`, `datasetVersion`, `volumeUnavailable`) + 4 new
tables (`data_gap`, `data_quality_incident`, `provider_observation`,
`data_correction`) with indexes. Applied to local dev DB and recorded. No
existing data touched.

## 5. Runtime changes
No behavioural change to existing consumers (all additions are new APIs / new
optional fields / new tables). Legacy `getHistoricalCandles`/`getQuotes`/
`getOptionChain`/`getInstruments` unchanged.

## 6. Provider matrix
Unchanged from V1 certification (`ALPHAFORGE_DATA_PROVIDER_CERTIFICATION.md`);
the V2 work adds status/provenance around the same providers.

## 7. Real coverage numbers
See COVERAGE_REPORT_V2 (DB-derived, 2026-09-10). Daily ~100% complete; intraday
0; option-chain 4 indices aggregate-only.

## 8-10. Data gaps / unresolved / provider reliability
- Integrity gaps: closed (see ROOT_CAUSE_V2).
- Coverage gap: intraday persistence (INFRA).
- Unresolved candle gaps: none *recorded* yet (`data_gap` empty until the
  detector runs).
- Provider reliability (live latency/error): **NOT VERIFIED** — market-session
  validation pending (§59).

## 11-13. Latency / data quality
- Latency p50/p95/p99: **LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE**.
- Data quality: `QualityEnvelope` + `DataAvailability` in place; wired into new
  reads and the two data gates.

## 14. Readiness
DATA_DEGRADED → improving (see READINESS_CERTIFICATION_V2 §65 gate).

## 15. Test results
tsc app+worker PASS; vitest 2,683 passed; pytest 671 passed/18 skipped; eslint 0
errors; prisma validate PASS.

## 16. Remaining limitations (honest)
1. Consumers not yet migrated to `*WithStatus` (legacy paths still bare).
2. Intraday candles not persisted → intraday coverage cannot be certified.
3. `DataGap`/incident/observation tables empty until detector/recovery/capture
   write paths run.
4. `CandleBar.provider` unbackfilled (0/89,810).
5. Live provider latency/failover unverified (market session needed).
6. Rate limiting on Python NextApi/Upstox still partial.
7. Cache metadata wrapper (createdAt/expiresAt/provider) not yet added.
8. Daily-candle timestamp shape (D-V2-10) needs verification.
9. Pre-existing migration `20260909` drift (unrelated) to resolve.

## 17. What was explicitly NOT done (and why)
- No ML / signal / A+ / profitability / EV threshold changes (out of scope).
- No fabricated data, candles, coverage numbers, or latency figures.
- No consumer rewired in a way that could destabilise the working signal path.
- No destructive DB operation.
