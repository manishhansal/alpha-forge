# ALPHAFORGE — DATA FOUNDATION V3 ROOT-CAUSE REPORT

Each item: ID · severity · symptom · evidence · root cause · fix · tests · status · residual risk.

Evidence-tier vocabulary: **IMPLEMENTED** (code exists) · **TEST-VERIFIED** (unit/
integration) · **DB-VERIFIED** (executed against the real Postgres) ·
**LIVE-RUNTIME-VERIFIED** (exercised a real provider during an open session).

---

## D-V3-01 — Durable reliability tables had zero writers
- **Severity:** High (architecture).
- **Symptom:** `DataGap`/`DataQualityIncident`/`ProviderObservation`/`DataCorrection` existed since V2 but were empty; provider reliability could not be measured from real calls.
- **Evidence:** V3 baseline probe — all four tables = 0 rows; grep confirmed no create/update callers.
- **Root cause:** V2 built the schema but never wired the write paths.
- **Fix:** `provider-observation.service.ts` (`recordProviderObservation`), `data-incident.service.ts` (`recordDataIncident` with dedup/correlation), gap writers in `gap-detection.service.ts`, correction writer in `gap-recovery.service.ts`. All fail-open; none store secrets.
- **Tests:** V3 unit tests for incident dedup; DB run populated `provider_observation=12`, `data_quality_incident=2`.
- **Status:** IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED.
- **Residual risk:** observations accrue only where the new services are called (backfill, write-through, gap-recovery, runtime pipeline); legacy read paths are not yet instrumented.

## D-V3-02 — No intraday candle persistence (carried from D-V2-09)
- **Severity:** High (coverage).
- **Symptom:** 0 intraday bars in `candle_bar`; every intraday read hit providers live.
- **Evidence:** baseline probe — `1m/3m/5m/15m/30m/1h = 0`.
- **Root cause (two layers):** (1) no backfill/write-through path wired; (2) **environmental**: the only enabled provider (data-service/scrapling) serves current-day intraday only, and the multi-day intraday-history providers (Angel One / Upstox) have **no credentials** here.
- **Fix (layer 1):** `backfill-orchestrator.service.ts` (resumable/chunked/idempotent/checkpointed) + `intraday-write-through.service.ts` (persist-on-read with provenance). Both stamp `provider`/`datasetVersion`/`sourceTimestamp` and are idempotent via the composite unique key.
- **Fix (layer 2):** not fixable without credentials — reported honestly, never fabricated.
- **Tests:** `data-v3-backfill-demo.ts` proved (DB-VERIFIED) resume-from-checkpoint, 0-duplicate idempotency, full provenance stamping, and 1m→5m aggregation math against the real DB using a namespaced, self-cleaning demo instrument.
- **Status:** pipeline IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED; **real intraday acquisition = DATA_INSUFFICIENT / LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE** (no credentialed history provider).
- **Residual risk:** intraday coverage stays 0 until a credentialed provider is configured; then the same code populates it with real bars.

## D-V3-03 — Candle provenance unpopulated (carried from D-V2-05)
- **Severity:** Medium.
- **Symptom:** `candlesWithProvider = 0/89,810`.
- **Root cause:** persist callers never passed `provider`/`datasetVersion`.
- **Fix:** persist path now stamps provenance whenever passed; the backfill/write-through/recovery paths always pass it (`datasetVersion` deterministic via `dataset-version.ts`). Existing daily rows are LEFT NULL — never fabricated (Rule 17); they are reported `PROVENANCE_UNKNOWN`.
- **Tests:** demo run — all 1,875 new rows carried `provider=angel_one` + `datasetVersion=2026-09-01.angel_one.norm-v3` (DB-VERIFIED).
- **Status:** IMPLEMENTED + DB-VERIFIED for new writes; existing rows intentionally unbackfilled.
- **Residual risk:** historical daily provenance remains unknown by design.

## D-V3-04 — Daily-candle timestamp shape (resolves D-V2-10 NEEDS-VERIFY)
- **Severity:** Medium (integrity) — upgraded from "Low" after real analysis.
- **Symptom:** daily `time` at `03:45Z`/`13:00Z`.
- **Evidence (DB-VERIFIED, `data-v3-daily-timestamp-probe.ts`):** four coexisting conventions — 09:15 IST (03:45Z) **84,889 rows** (canonical), 18:30 IST (13:00Z) 4,414, 00:00 IST 175, 09:00 IST 163. **3,442 logical duplicate trading-days** (same instrument+IST date, two epoch keys → the composite unique key does not dedupe them) and **1,029 weekend daily bars**.
- **Root cause:** multiple provider/ingestion paths stamped daily bars with different time-of-day conventions; the unique key keys on `time`, so a second convention creates a second row for one trading day and can land on a weekend IST date.
- **Fix:** canonical semantic established — **daily bar = NSE session date at 09:15 IST (03:45Z)**. Deterministic, dry-run-by-default migration `scripts/data-v3-daily-timestamp-migration.ts` classifies every row (plan: CANONICAL 84,889 · MERGE_DUP 3,552 · RETIME 340 · WEEKEND_ORPHAN 1,029) and preserves each original epoch in `sourceTimestamp`. Recorded as two real `DataQualityIncident` rows.
- **Tests:** probe + migration dry-run (DB-VERIFIED). Incident recording DB-VERIFIED.
- **Status:** INVESTIGATED + canonical established + migration tooling IMPLEMENTED. **Migration NOT APPLIED** — a mutation of ~89.8k production rows is high-risk and requires explicit operator approval (safety guardrails); left dry-run.
- **Residual risk:** until the migration is applied, ~5.5% of daily rows are non-canonical and ~3.8% are logical duplicates; coverage counting is per-trading-day-robust but a strict per-row consumer could double-count.

## D-V3-05 — Gap detection could manufacture false gaps
- **Severity:** High if wrong (would violate Rule 20).
- **Fix:** `detectGaps` computes expected bars from the NSE calendar + session window and bounds them to the instrument's OBSERVED active period (≥ first persisted bar); a not-yet-listed instrument yields `noData=true`, never a gap.
- **Tests:** TEST-VERIFIED (no-gap-when-complete, 3-bar-run detection, no-gap-before-listing, no-fabrication-on-empty) + DB-VERIFIED (RELIANCE Q1-2025 → 0 gaps, 0 rows written).
- **Status:** IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED.

## D-V3-06 — Higher-timeframe aggregation could hide incomplete source
- **Severity:** Medium (would violate Rule 47).
- **Fix:** `aggregateFrom1m` emits a target bar ONLY when all constituent 1m bars are present and no unresolved gap overlaps; otherwise it DROPS the bar and returns PARTIAL/DATA_INSUFFICIENT. Records lineage (datasetVersion/sourceInterval/method/sourceProviders/sourceTimeRange). Marked derived via `agg-1m` datasetVersion.
- **Tests:** TEST-VERIFIED (complete→AVAILABLE 75 bars, one missing 1m→PARTIAL/74, no source→DATA_INSUFFICIENT) + DB-VERIFIED (demo).
- **Status:** IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED.

## D-V3-07 — Persistence failure could look like clean data (§37)
- **Severity:** High.
- **Fix:** persist path counts failures; with `recordIncidentOnFailure` it writes a `PERSISTENCE_FAILED` incident, and write-through downgrades the returned status to PARTIAL with a `persistence_failed` warning.
- **Status:** IMPLEMENTED + TEST-VERIFIED (incident path).
- **Residual risk:** not yet triggered against a real DB outage (would need a fault-injected Postgres).

## D-V3-08 — Backfill non-resumable (initial implementation bug, fixed)
- **Symptom:** first implementation advanced the checkpoint past a hard-failed chunk, so resume would skip it and lose data.
- **Fix:** a hard-failed chunk (exception or retryable outcome) no longer advances `lastCompletedChunk`; the job breaks so resume retries exactly that chunk.
- **Tests:** DB-VERIFIED (crash at chunk 2 → resume fetched only the remaining 3 chunks → COMPLETED; idempotent re-run added 0 rows) + TEST-VERIFIED (checkpoint does not advance past a hard-failed chunk).
- **Status:** IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED.

## Carried, out-of-scope
- **Migration drift `20260909…`** (india_prediction/resolution records): pre-existing, ML/signal-learning tables, OUT of data scope. V3 added no migration and did not touch it. `prisma validate` PASS; the objects exist (the running app uses them). Flagged for a separate migration-history reconciliation.
