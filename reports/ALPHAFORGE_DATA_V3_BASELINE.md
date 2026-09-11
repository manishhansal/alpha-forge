# ALPHAFORGE — DATA FOUNDATION V3 BASELINE

Authoritative starting state for the V3 program. Every DB/provider figure below
was **queried live**, not estimated. Companion V2 reports were read first
(`ALPHAFORGE_DATA_V2_BASELINE.md`, `..._ROOT_CAUSE_REPORT_V2.md`,
`..._COVERAGE_REPORT_V2.md`, `..._READINESS_CERTIFICATION_V2.md`,
`..._V2_FINAL_REPORT.md`) and are treated as the previous-state record.

- **Probed at:** 2026-09-10 ~07:12Z (12:42 IST, Thursday — NSE regular session OPEN).
- **Database:** `postgresql://crypto:****@localhost:5433/crypto_dashboard` (docker `alpha-forge-postgres`, healthy).
- **Infra up:** Postgres 5433, Redis 6379, data-service 8200 (healthy), ml-service 8100 — all reachable.
- Probe script: `scripts/data-v3-db-probe.ts` (read-only; canonical Prisma path).

---

## 1. V2 verified fixes (carried forward — do NOT redo)

Per ROOT_CAUSE_V2, 6 FIXED, 3 INFRA, 1 NEEDS-VERIFY:

| ID | Item | V2 status |
|---|---|---|
| D-V2-01 | `DataAvailability<T>` + `*WithStatus` reads (no empty/null ambiguity) | FIXED |
| D-V2-02 | first-class `INSUFFICIENT_HISTORY` | FIXED |
| D-V2-04 | `evaluateSnapshotConsistency` skew gate | FIXED |
| D-V2-06 | stale/synthetic tick propagation | FIXED |
| D-V2-07 | `volumeUnavailable` (real-0 vs placeholder-0) | FIXED |
| D-V2-08 | Scrapling local re-validation | FIXED |
| D-V2-03 | durable models (`DataGap`/`DataQualityIncident`/`ProviderObservation`/`DataCorrection`) | INFRA (empty) |
| D-V2-05 | `CandleBar` provenance columns | INFRA (0/89,810 populated) |
| D-V2-09 | intraday candle persistence | INFRA / DATA_INSUFFICIENT |
| D-V2-10 | daily timestamp shape (`03:45Z`/`13:00Z`) | NEEDS-VERIFY |

## 2. V2 remaining INFRA items (the V3 work list)

Confirmed still true by direct inspection this pass:
- The 4 durable tables have **0 writers** in TS (grep-verified in V2, re-confirmed).
- `RealTimeCandleBuilder`/`MultiInstrumentCandleBuilder` are exported but **never instantiated** outside tests.
- `worker/src/jobs/scraping-tick-listener.ts` exists but is **not registered** in `worker/src/index.ts`.
- `CandleBar.provider`/`datasetVersion` are stamped only when a caller passes them; the two live callers (`india-scalper`, `india-builder`) don't → columns stay null.
- Rate limiting on Python NextApi/Upstox still partial; TS cache has no `createdAt/expiresAt/provider` wrapper.
- Pre-existing migration `20260909…` drift unresolved.

## 3. Current DB state (REAL, queried 2026-09-10T07:11:54Z)

**CandleBar** — total **89,810** rows, all `1d`/`NSE`, **175** instruments:

| interval | rows | first | last |
|---|---|---|---|
| `1d` | 89,810 | 2024-09-04T03:45:00Z | 2026-09-09T13:00:00Z |
| 1m/3m/5m/15m/30m/1h | **0** | — | — |

**Provenance:** `candlesWithProvider = 0 / 89,810`; datasetVersion 0; receivedAt 0;
volumeUnavailable rows 0. (Existing rows will remain null — never fabricated.)

**OptionChainSnapshot** — ~2,941 rows, 4 index underlyings, aggregate-only:

| underlying | snapshots | first | last |
|---|---|---|---|
| FINNIFTY | 738 | 2026-06-16T04:00Z | 2026-09-10T06:12Z |
| NIFTY | 736 | 2026-06-16T04:00Z | 2026-09-10T06:12Z |
| BANKNIFTY | 736 | 2026-06-16T04:00Z | 2026-09-10T05:46Z |
| MIDCPNIFTY | 731 | 2026-06-16T04:00Z | 2026-09-10T05:46Z |

(OC capture is actively running — last snapshot minutes before the probe.)

**Durable V2 tables:** `data_gap=0`, `data_quality_incident=0`,
`provider_observation=0`, `data_correction=0`.

## 4. Current provider configuration (REAL) — the decisive V3 constraint

Provider chain (registry, priority order): **scrapling (0) → angel_one (1) →
upstox (2) → yahoo (3)**. NSE is not registered (prohibited).

Credentials in `.env.local` (names only):
- `SMARTAPI_API_KEY / CLIENT_CODE / PIN / TOTP_SECRET` — **all empty** ⇒ Angel One unusable.
- `UPSTOX_ACCESS_TOKEN / UPSTOX_ANALYTICS_TOKEN` — **empty** ⇒ Upstox unusable (data-service `/brokers/upstox/status` → `configured:false`).
- `DATA_SERVICE_URL` — set (`http://localhost:8200`) ⇒ scrapling enabled.

**Live data-service behaviour (probed during the open session):**
- Quotes: **WORKS** — `NIFTY` LTP `23450.1` via `nextapi`, `volume:null` correctly preserved (not fabricated 0).
- Intraday candles (`5m`, current day): returns `count:0` (the NSE chart endpoint served nothing for the probed symbols this session).
- Daily via endpoint (`1d`, ranged): returned empty for the probed window (bhavcopy CDN path unavailable from this egress).

**Consequence (honest):** the only usable acquisition path right now is
data-service **live quotes**. Angel One — the one provider that supplies
**multi-day intraday history** — has no credentials. Therefore V3 **cannot**
acquire and persist a real multi-day intraday dataset in this environment, and
**must not** fabricate one. Intraday will be reported **DATA_INSUFFICIENT /
DATA_BLOCKED** with the missing-credential root cause, not DATA_READY. The V3
build makes the *pipeline* real, verifiable, and ready to populate the moment a
credentialed provider is available; it does not manufacture coverage.

## 5. Current write paths
- `CandleBar`: `persistCandles`/`persistCandlesBatch` (`candle-persist.service.ts`) — called by `india-scalper` job + `india-builder`; and `RealTimeCandleBuilder.persistConfirmed` (dormant). Composite unique key `[instrumentId,exchange,intervalStr,time]`.
- `OptionChainSnapshot`: `india-oc-capture` worker (live, running).
- Durable V2 tables: **none**.

## 6. Current read paths
- Legacy: `getHistoricalCandles`, `getQuotes`, `getOptionChain`, `getInstruments`.
- Status-aware (V2): `getHistoricalCandlesWithStatus`, `getQuotesWithStatus`, `getOptionChainWithStatus`, `getInstrumentsWithStatus` (return `DataAvailability<T>`).

## 7. Current workers
Registered in `worker/src/index.ts`: liquidations, signal-ingest, signal-outcome,
alerts, scalper, india-scalper, india-oc-capture, india-daily-picks,
india-fno-trend-track, india-eod-squareoff, india-auto-trader, strategy-lab,
india-scanner, heartbeat. **Not registered:** scraping-tick-listener.

## 8. Current schedulers
`worker/src/scheduler.ts` `scheduleJob` — non-overlapping `setTimeout` loop per job.

## 9. Current persistence paths
See §5. Prisma via `@prisma/adapter-pg` over Postgres 5433.

## 10. Current data gates
`evaluateGlobalDataState`, `strategyMayOperate`, `evaluateSnapshotConsistency`
(pure, fail-closed). Present and unit-tested; **not yet wired** into a live
production snapshot/consumer.

## 11. Current coverage
`coverage.service.ts` (`buildCoverageMatrix`, `expectedBars`, `checkHistorySufficiency`)
— calendar-aware, DB-derived. Daily ~100%; intraday 0.

## 12. Current test state (V2 baseline, to be re-verified)
V2 recorded: tsc app+worker PASS; vitest 2,683 passed; pytest 671 passed/18
skipped; eslint 0; prisma validate PASS. Re-run under V3 §14/§15.

## 13. Exact V3 objectives (scoped to what is verifiable here)

DB-scope only. No ML/signal/A+/EV/profitability/threshold changes. No fabricated data.

1. Make the four durable tables **real**: write `ProviderObservation` + `DataQualityIncident` on real provider calls (dedup/correlated).
2. **Provenance on every NEW write** (provider/sourceTimestamp/receivedAt/datasetVersion); deterministic dataset versioning.
3. **Intraday pipeline**: resumable/chunked/idempotent backfill orchestrator + write-through persistence — proven idempotent/resumable by tests and exercised against the real DB (subject to §4: no credentialed intraday provider ⇒ 0 real bars acquired, reported honestly).
4. **DataGap detection** (NSE-calendar + interval boundaries + instrument active period) with the full lifecycle state machine, wired to write real rows.
5. **Gap recovery** with capability-aware failover + verify-before-resolve + `DataCorrection` on change.
6. **Higher-timeframe aggregation** from real persisted 1m only (completeness-gated, lineage-recorded).
7. **D-V2-10** daily-timestamp investigation → canonical NSE-session-date mapping (no blind rewrite).
8. **Capability-specific readiness** + a single machine-readable market-session readiness contract.
9. **Live runtime + failover validation** using what the environment actually allows (data-service quotes work; broker history does not) — everything unprovable reported as `LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE` / `DATA_BLOCKED`, never fabricated.
10. Tests + full verification + honest final certification distinguishing IMPLEMENTED / TEST-VERIFIED / DB-VERIFIED / LIVE-RUNTIME-VERIFIED.
