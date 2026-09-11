# ALPHAFORGE — DATA FOUNDATION V4 ROOT-CAUSE REPORT

Each item: ID · severity · symptom · evidence · root cause · fix · tests · DB
evidence · runtime evidence · residual risk. Evidence tiers: IMPLEMENTED /
TEST-VERIFIED / DB-VERIFIED / LIVE-RUNTIME-VERIFIED.

The D-V4-01…21 register (§79) is retained in full at the end; items are only
marked resolved with independent evidence.

---

## D-V4-01/02/03/04 — Daily timestamp inconsistency, duplicates, weekend bars
- **Severity:** Critical (integrity).
- **Symptom/evidence (DB-VERIFIED, 2026-09-11):** 4 timestamp conventions
  (09:15 IST 85,058 · 18:30 IST 4,414 · 00:00 IST 175 · 09:00 IST 163);
  **3,442 logical duplicate trading-days**; **1,029 weekend daily bars**;
  4,921 non-canonical rows.
- **Root cause:** multiple ingestion paths stamped daily bars with different
  time-of-day conventions; the composite unique key keys on epoch `time`, so a
  second convention creates a second row per trading day, some on weekend dates.
- **Key new finding (V4):** all 3,442 duplicates are **VALUE_CONFLICT**
  (materially different OHLC+volume), neither row carries provenance, and there
  is no directional evidence favouring either convention (canonical higher
  volume 1,802 / lower 1,468; avg |close diff| 1.07%). They are NOT safely
  auto-resolvable.
- **Fix:** (1) canonical `sessionDate` column + partial unique index enforcing
  one daily row per trading session for NEW writes (migration
  `20260911000000`, **DB-VERIFIED applied**); (2) an evidence-based two-stage
  normalization tool (`scripts/data-v4-daily-migration.ts`, DRY-RUN) that keeps
  the canonical row, **preserves each conflicting value as a `DataCorrection`**,
  retimes weekday singletons, and **quarantines** weekend rows as incidents —
  never a silent delete.
- **Tests:** sessionDate computation TEST-VERIFIED.
- **DB evidence:** dry-run plan CANONICAL 81,478 · RETIME 278 ·
  CONFLICT_KEEP_CANONICAL 3,411 · CONFLICT_NO_CANONICAL_RETIME 31 ·
  WEEKEND_QUARANTINE 1,029.
- **Status:** normalization plan + tooling + forward-uniqueness model
  IMPLEMENTED/DB-VERIFIED; **historical rows NOT yet migrated** (D-V4-01..04
  remain OPEN until the operator approves the migration — high-risk on 89.8k
  rows; conflicts ideally resolved by a credentialed provider re-fetch).
- **Residual risk:** until applied, ~5.5% of daily rows non-canonical, 3.8%
  logical duplicates.

## D-V4-05 — Historical daily provenance unknown
- **Evidence:** `candlesWithProvider = 0/89,810` (DB-VERIFIED).
- **Fix:** provenance mandatory for NEW writes (sessionDate + provider +
  datasetVersion + receivedAt stamped by the persist path); existing rows kept
  NULL (never fabricated) and classified **PROVENANCE_UNKNOWN**.
- **Status:** forward-provenance IMPLEMENTED; historical remains UNKNOWN by
  design. **OPEN (Medium).**

## D-V4-06 — Zero real intraday persisted data
- **Evidence:** 1m/3m/5m/10m/15m/30m/1h = 0 (DB-VERIFIED).
- **Root cause:** no credentialed multi-day-intraday provider (Angel/Upstox
  creds absent); data-service serves current-day intraday only.
- **Status:** V3 pipeline IMPLEMENTED+TEST-VERIFIED+DB-VERIFIED (backfill demo);
  **real coverage remains DATA_INSUFFICIENT.** **OPEN (Critical).**

## D-V4-07/08/09/10 — Broker runtime + failover + Yahoo not verified
- **Evidence:** `SMARTAPI_*`/`UPSTOX_*` empty; data-service upstox
  `configured:false`; market CLOSED at run time.
- **Status:** **LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE** for Angel/Upstox
  history, the broker failover drill, and Yahoo runtime. Config-health service +
  runtime matrix are built and correctly report NOT_VERIFIED. **OPEN.**

## D-V4-11/12 — Index options aggregate-only; no stock options
- **Evidence (DB-VERIFIED):** NIFTY snapshot `analytics` blob has ONLY aggregate
  keys (`arrayCandidatesForStrikes: []`); stock options 0 underlyings/0 snapshots.
- **Status:** index options **DATA_DEGRADED** (no per-strike history to measure);
  stock options **DATA_INSUFFICIENT**. Strike-level model designed (option
  report). **OPEN (Critical for F&O).**

## D-V4-13 — Provider observation sample too small
- **Evidence:** after purging demo contamination, `provider_observation = 1`.
- **Fix:** `provider-reliability.service.ts` reports `INSUFFICIENT_SAMPLE` and
  `successRate=null` below `MIN_SAMPLE=20` — never a false 100%.
- **Status:** honesty mechanism IMPLEMENTED+TEST-VERIFIED+DB-VERIFIED; reliability
  itself **NOT_VERIFIED (insufficient sample).** **OPEN.**

## D-V4-14 — Persistence failure not fault-injected against real DB
- **Status:** persist path records `PERSISTENCE_FAILED` incident + write-through
  downgrades to PARTIAL (V3, TEST-VERIFIED). Real DB-outage injection **not
  performed** this pass. **OPEN (documented).**

## D-V4-15 — Gap detection scope
- **Fix/evidence (DB-VERIFIED):** full-universe daily detector run — 175
  instruments scanned, 171 with gaps, **245 `DataGap` rows** persisted;
  idempotent (2nd run wrote 0). No fabrication.
- **Caveat:** daily gaps are partly an artifact of the mixed-timestamp
  conventions (D-V4-01) at the canonical grid; intraday gaps not detectable (0
  rows). **PARTIAL — daily universe DB-VERIFIED; intraday DATA_INSUFFICIENT.**

## D-V4-16 — Global data gate not enforced on production consumers
- **Evidence (context map):** `evaluateGlobalDataState`/`strategyMayOperate`/
  `evaluateSnapshotConsistency` have ZERO production call sites; a separate HTTP
  `evaluateDataGate` guards only 2 paper-trade paths; IndiaDailyPick,
  FnoTrendScan, StrategyPaperTrade, SignalHistory, crypto scalper are ungated.
- **Fix:** `data-gate-enforcement.service.ts` (`enforceDataGate`) — fail-closed
  composition of the 3 gate functions, TEST-VERIFIED (blocks on
  UNAVAILABLE/PROVIDER_FAILED/snapshot-skew). **NOT wired into live trading**
  (would halt trades — requires operator approval; no strategy logic altered).
  **OPEN — enforcement surface delivered, adoption pending.**

## D-V4-17 — Legacy read-path migration
- **Evidence:** `*WithStatus` adoption near-zero (only intraday-write-through);
  `getInstruments*` family has ZERO consumers.
- **Status:** inventoried; production migration flagged. **OPEN (audited).**

## D-V4-18 — Dormant realtime candle-builder/listener
- **Status:** confirmed still not wired into `worker/src/index.ts` (V3 finding
  unchanged). Not activated (no live intraday feed usable without creds).
  **OPEN (verified dormant).**

## D-V4-19 — Python provider rate limiting
- **Status:** not re-audited beyond V2/V3 findings; no Python changes made.
  **OPEN (carried).**

## D-V4-20 — Cache metadata/integrity
- **Status:** not changed this pass. **OPEN (carried).**

## D-V4-21 — Prisma migration drift — **RESOLVED**
- **Evidence (DB-VERIFIED):** `20260909…` was `finished_at=NULL` but its tables
  exist; ran `prisma migrate resolve --applied` (non-destructive). `prisma
  migrate status` = "Database schema is up to date!".
- **Status:** **FIXED + DB-VERIFIED.**

---

## Register summary
FIXED/DB-VERIFIED: D-V4-21. PARTIAL (real evidence, work remains): D-V4-15,
D-V4-16 (surface built). OPEN: D-V4-01..14, 17..20 — retained per §79, none
marked fixed on code existence alone.
