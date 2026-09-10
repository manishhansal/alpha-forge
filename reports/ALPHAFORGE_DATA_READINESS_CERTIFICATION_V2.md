# ALPHAFORGE — DATA READINESS CERTIFICATION V2

Verdict (brief §88 vocabulary):

- **Daily equity/index history: DATA_READY** (real, ~2yr, 175 instruments, ~100%
  complete over each instrument's span — verified from the DB).
- **Intraday candles: DATA_INSUFFICIENT** (none persisted — infrastructure to
  fix is built at the schema/engine level; the backfill/write-through is the
  next build step).
- **Overall system: DATA_DEGRADED → improving.** The V2 contract, gates, durable
  models, and coverage engine are in place and verified; full DATA_READY awaits
  consumer migration + intraday persistence + a live market-session validation.

No ML / signal-threshold / A+ / profitability change was made. No data or
coverage figure was fabricated (Rules 19/20).

---

## 1. §62 certification checklist

Legend: ✅ present & verified · 🟡 partial / infra-ready-not-populated · ⛔ missing.

| Item | Status | Evidence |
|---|---|---|
| provider chain | ✅ | `registry.ts` (scrapling→angel→upstox→yahoo) |
| failover | ✅ | `failover.ts` capability-aware |
| rate limiting | 🟡 | TS token buckets; Python NextApi/Upstox still partial (Phase 30 open) |
| retries | ✅ | 3-attempt ladder (TS + Python) |
| circuit breakers | ✅ | per-provider + per-capability |
| caching | 🟡 | TTL memo works; no createdAt/expiresAt wrapper (Phase 33 open) |
| provenance | 🟡 | `DataAvailability` carries full provenance on new reads; `CandleBar` columns exist but unbackfilled |
| persistence | ✅ | `CandleBar`/`OptionChainSnapshot` + 4 new V2 tables live |
| historical coverage | 🟡 | daily READY; intraday INSUFFICIENT (not persisted) |
| gap detection | 🟡 | `DataGap` model + detection primitives; detector wiring pending |
| gap recovery | 🟡 | reconnect recovery exists; persisted-gap recovery pending |
| timestamp integrity | ✅ | IST↔UTC correct; stale-as-live fixed (V1) |
| OHLC integrity | ✅ | reject-on-invalid; scrapling now re-validates locally |
| option integrity | ✅ | missing OI/vol flagged, excluded from analytics (V1) |
| OI | ✅ | never fabricated as 0 (V1) |
| IV | ✅ | null-preserving |
| symbol master | 🟡 | `getInstrumentsWithStatus` distinguishes failure (G-12 fixed); universe reconciliation (Phase 36) open |
| market calendar | ✅ | `nseCalendar` used by coverage engine |
| snapshot consistency | ✅ | `evaluateSnapshotConsistency` (Phase 40) |
| data quality | ✅ | `QualityEnvelope` + `DataAvailability` |
| data availability | ✅ | `DataAvailability<T>` contract + `*WithStatus` reads |
| signal veto | ✅ | `evaluateGlobalDataState` / `strategyMayOperate` (fail-closed) |
| observability | 🟡 | structured `mdLog` incl. PROVIDER_FAILED + drop logs; metrics counters (Phase 80) open |
| alerts | 🟡 | OC-capture staleness alert; broader alerting open |
| security | ✅ | creds masked; no secret-in-log path found |

---

## 2. §65 global data gate

`evaluateGlobalDataState(deps)` → `DATA_READY | DATA_DEGRADED | DATA_BLOCKED`:
- Any **critical** dep with a non-tradable status ⇒ **DATA_BLOCKED** (NO SIGNAL).
- Any soft (STALE/PARTIAL) or optional-hard issue ⇒ **DATA_DEGRADED** (only
  strategies whose own critical fields are healthy may run — `strategyMayOperate`).
- Else ⇒ **DATA_READY**.

Verified by unit tests (`data-foundation-v2.test.ts`).

---

## 3. §59 live runtime validation

**LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE** at report time.

- The NSE regular session (09:15–15:30 IST) was not confirmed open during this
  run, and live broker credentials were not exercised. Per Rules 19/59 I did NOT
  fabricate latency/uptime numbers.
- What WAS validated against real infrastructure: the **live Postgres** (row
  counts, coverage, the new tables/columns) — see the coverage report V2. The
  data-service is configured at `http://localhost:8200` but live provider round
  trips were not executed here.
- To complete §59: during a market session, run the provider chain
  (data-service / Angel / Upstox / Yahoo), record latency p50/p95/p99, response
  statuses, and a failover drill, then update this section.

---

## 4. Verification performed this pass

- `tsc --noEmit` (app) — **PASS**
- `tsc --noEmit -p worker/tsconfig.json` — **PASS**
- `vitest run tests/lib tests/features tests/services tests/worker` —
  **2,683 passed** (incl. 18 new V2 tests)
- `data-service pytest tests/` — **671 passed, 18 skipped**
- `eslint` (changed files) — **0 errors**
- `prisma validate` — **PASS**; `prisma generate` — **PASS**
- Live DB probe — real coverage numbers captured (coverage report V2)

Migration note: `prisma migrate deploy` surfaced a **pre-existing** history drift
(migration `20260909…` re-creating an index, code 42P07) UNRELATED to this work.
The V2 migration is additive/idempotent; it was applied to the local dev DB and
recorded via `prisma migrate resolve`. The pre-existing drift should be resolved
separately (flagged to the team).

---

## 5. Remaining work to reach full DATA_READY

1. Migrate consumers to `*WithStatus` reads (signal engine → ML → paper → workers).
2. Build the intraday backfill orchestrator + write-through (D-V2-09).
3. Wire the gap detector / recovery to populate `DataGap` + `DataQualityIncident`.
4. Backfill `CandleBar.provider` provenance on new writes.
5. Live-session validation (§59) with real latency/failover evidence.
6. Verify daily-candle timestamp normalization (D-V2-10).
7. Resolve the pre-existing `20260909` migration drift.
